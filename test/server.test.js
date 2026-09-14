import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/server.js';
import { createApi, loadKey, PublicError } from '../src/api.js';

const fixtures = {
  '/api/devices': { data: [{ id: 1, name: 'Kitchen', refresh_interval: 900, api_key: 'NEVER-RETURN', mac_address: 'PRIVATE', friendly_id: 'PRIVATE' }] },
  '/api/playlists/items': { data: [
    { id: 20, device_id: 1, row_order: 4, visible: true, plugin: { id: 9, name: 'Weather', extra: 'NEVER-RETURN' }, plugin_setting: { id: 5, name: 'Home Weather', polling_headers: 'NEVER-RETURN' } },
    { id: 21, device_id: 1, row_order: 9, visible: false, mashup_id: 7, plugin: null, plugin_setting: null },
  ] },
  '/api/playlists/items/20/schedule': { data: { always_active: false, week_schedules: [{ week_days: [1, 2, 3, 4, 5], start_time: '09:00', end_time: '17:00' }] } },
};
fixtures['/api/devices/1/playlist_items'] = fixtures['/api/playlists/items'];

async function setup(t, fetchImpl) {
  const calls = [];
  const api = createApi({ keyProvider: async () => 'test-account-key', fetchImpl: fetchImpl || (async (url, options) => {
    calls.push({ url, options });
    const fixture = fixtures[new URL(url).pathname];
    assert.ok(fixture, `Unexpected request ${url}`);
    return Response.json(fixture);
  }) });
  const server = createServer(api);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls };
}

test('MCP advertises three reads and five writes with accurate annotations, and rejects unknown operations', async t => {
  const { client, calls } = await setup(t);
  const { tools } = await client.listTools();
  const reads = ['get_playlist_item_schedule', 'list_devices', 'list_playlist_items'];
  const writes = ['set_playlist_item_visibility', 'add_playlist_item', 'remove_playlist_item', 'reorder_playlist_items', 'replace_playlist_item_schedule'];
  assert.deepEqual(tools.map(t => t.name).sort(), [...reads, ...writes].sort());
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, reads.includes(tool.name));
    assert.equal(tool.annotations.destructiveHint, writes.includes(tool.name) && tool.name !== 'add_playlist_item');
    assert.equal(tool.annotations.idempotentHint, tool.name !== 'add_playlist_item');
  }
  const denied = await client.callTool({ name: 'update_playlist_item', arguments: { id: 20, visible: false } });
  assert.equal(denied.isError, true);
  for (const args of [{ device_id: -1 }, { device_id: '../me' }, { device_id: 1.5 }, { url: 'https://attacker.example' }, { limit: 101 }]) {
    const result = await client.callTool({ name: 'list_playlist_items', arguments: args });
    assert.equal(result.isError, true);
  }
  assert.equal(calls.length, 0);
});

test('playlist reads preserve order, hidden items and mashups, paginate, and remove unexpected fields', async t => {
  const { client, calls } = await setup(t);
  const devices = await client.callTool({ name: 'list_devices', arguments: {} });
  assert.deepEqual(devices.structuredContent.data, [{ id: 1, name: 'Kitchen', refresh_interval: 900 }]);
  const first = await client.callTool({ name: 'list_playlist_items', arguments: { device_id: 1, limit: 1 } });
  assert.equal(first.structuredContent.total, 2);
  assert.equal(first.structuredContent.next_offset, 1);
  assert.equal(first.structuredContent.data[0].plugin_setting.name, 'Home Weather');
  assert.equal(JSON.stringify(first).includes('NEVER-RETURN'), false);
  const second = await client.callTool({ name: 'list_playlist_items', arguments: { offset: 1, limit: 1 } });
  assert.equal(second.structuredContent.next_offset, null);
  assert.equal(second.structuredContent.data[0].visible, false);
  assert.equal(second.structuredContent.data[0].mashup_id, 7);
  const schedule = await client.callTool({ name: 'get_playlist_item_schedule', arguments: { item_id: 20 } });
  assert.deepEqual(schedule.structuredContent, { item_id: 20, ...fixtures['/api/playlists/items/20/schedule'].data });
  for (const { url, options } of calls) {
    assert.equal(new URL(url).origin, 'https://trmnl.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-account-key');
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('empty playlist is a successful empty result', async t => {
  const { client } = await setup(t, async () => Response.json({ data: [] }));
  const result = await client.callTool({ name: 'list_playlist_items', arguments: {} });
  assert.deepEqual(result.structuredContent, { data: [], total: 0, offset: 0, next_offset: null });
});

for (const status of [401, 403, 404, 429, 500]) {
  test(`HTTP ${status} produces a useful error without reflecting upstream secrets`, async t => {
    const { client } = await setup(t, async () => new Response('secret-api-key', { status }));
    const result = await client.callTool({ name: 'list_devices', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('secret-api-key'), false);
  });
}

test('malformed JSON/schema, HTML, oversized responses and network errors fail without raw body leakage', async t => {
  for (const fetchImpl of [
    async () => new Response('{secret-api-key', { headers: { 'content-type': 'application/json' } }),
    async () => Response.json({ data: { secret: 'secret-api-key' } }),
    async () => new Response('<html>secret-api-key</html>'),
    async () => Response.json({ data: 'secret-api-key'.repeat(200000) }),
    async () => { throw new Error('redirect or timeout containing secret-api-key'); },
  ]) {
    const { client } = await setup(t, fetchImpl);
    const result = await client.callTool({ name: 'list_devices', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('secret-api-key'), false);
  }
});

test('credential loading rejects plugin keys, missing files, shared permissions and symlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'trmnl-key-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'key');
  await assert.rejects(loadKey({}, path), PublicError);
  await assert.rejects(loadKey({ TRMNL_ACCOUNT_API_KEY: 'ps_mcp_wrong-type' }), /plugin MCP key/);
  await assert.rejects(loadKey({ TRMNL_ACCOUNT_API_KEY: 'two tokens' }), /single non-empty token/);
  await writeFile(path, 'account-test-key\n', { mode: 0o600 });
  assert.equal(await loadKey({}, path), 'account-test-key');
  assert.equal(await loadKey({ TRMNL_ACCOUNT_API_KEY: 'environment-key' }, path), 'environment-key');
  await chmod(path, 0o644);
  await assert.rejects(loadKey({}, path), /permissions 600/);
  await chmod(path, 0o600);
  const link = join(directory, 'symlink');
  await symlink(path, link);
  await assert.rejects(loadKey({}, link), PublicError);
});

test('real stdio process initializes without a key and explains the missing credential on calls', async t => {
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const directory = await mkdtemp(join(tmpdir(), 'trmnl-stdio-test-'));
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: { TRMNL_ACCOUNT_API_KEY: '', TRMNL_ACCOUNT_API_KEY_FILE: join(directory, 'missing-key') },
  }));
  assert.equal((await client.listTools()).tools.length, 8);
  const result = await client.callTool({ name: 'list_devices', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /configure.py/);
});

test('write tools use documented methods and bodies, and return filtered results', async t => {
  const calls = [];
  const { client } = await setup(t, async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, ...options });
    assert.equal(new URL(url).origin, 'https://trmnl.com');
    assert.equal(options.redirect, 'error');
    if (options.method === 'GET') return Response.json(fixtures[path]);
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    if (body !== undefined) assert.equal(options.headers['Content-Type'], 'application/json');
    if (options.method === 'PATCH') return Response.json({ data: { ...fixtures['/api/playlists/items'].data[0], visible: body.visible } });
    if (options.method === 'POST') return Response.json({ data: { id: 22, device_id: 1, visible: true, api_key: 'NEVER-RETURN' } });
    if (path.endsWith('/schedule')) return Response.json({ data: { week_schedules: body.week_schedules, always_active: body.week_schedules.length === 0 } });
    return Response.json({ data: { success: true, secret: 'NEVER-RETURN' } });
  });
  const pluginUuid = 'f7e6b4be-e437-4cc3-8345-b9d24fe2f100';
  const windows = [{ week_days: [1, 3, 5], start_time: '09:00', end_time: '17:30' }];
  const requests = [
    ['set_playlist_item_visibility', { item_id: 20, visible: false }],
    ['add_playlist_item', { device_id: 1, plugin_setting_id: pluginUuid }],
    ['remove_playlist_item', { item_id: 21 }],
    ['reorder_playlist_items', { device_id: 1, playlist_item_ids: [21, 20] }],
    ['replace_playlist_item_schedule', { item_id: 20, week_schedules: windows }],
    ['replace_playlist_item_schedule', { item_id: 20, week_schedules: [] }],
  ];
  const results = [];
  for (const [name, args] of requests) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes('NEVER-RETURN'), false);
    results.push(result.structuredContent);
  }
  assert.equal(results[0].data.visible, false);
  assert.equal(results[1].data.id, 22);
  assert.deepEqual(results[2], { item_id: 21, success: true });
  assert.deepEqual(results[4], { item_id: 20, always_active: false, week_schedules: windows });
  assert.deepEqual(results[5], { item_id: 20, always_active: true, week_schedules: [] });
  assert.deepEqual(calls.map(({ method, path, body }) => [method, path, body ? JSON.parse(body) : null]), [
    ['PATCH', '/api/playlists/items/20', { visible: false }],
    ['POST', '/api/devices/1/playlist_items', { plugin_setting_id: pluginUuid }],
    ['DELETE', '/api/playlists/items/21', null],
    ['GET', '/api/devices/1/playlist_items', null],
    ['PUT', '/api/devices/1/playlist_items/order', { playlist_item_ids: [21, 20] }],
    ['PUT', '/api/playlists/items/20/schedule', { week_schedules: windows }],
    ['PUT', '/api/playlists/items/20/schedule', { week_schedules: [] }],
  ]);
});

test('invalid writes are rejected before a request, including invalid times and duplicate IDs', async t => {
  const { client, calls } = await setup(t);
  for (const [name, args] of [
    ['set_playlist_item_visibility', { item_id: 20, visible: 'false' }],
    ['set_playlist_item_visibility', { item_id: 20, visible: true, polling_url: 'https://example.com' }],
    ['add_playlist_item', { device_id: 1, plugin_setting_id: '5' }],
    ['remove_playlist_item', { item_id: '../../devices/1' }],
    ['reorder_playlist_items', { device_id: 1, playlist_item_ids: [20, 20] }],
    ['replace_playlist_item_schedule', { item_id: 20 }],
    ...[
      { week_days: [7], start_time: '09:00', end_time: '17:00' },
      { week_days: [1, 1], start_time: '09:00', end_time: '17:00' },
      { week_days: [], start_time: '09:00', end_time: '17:00' },
      { week_days: [1], start_time: '9:00', end_time: '17:00' },
      { week_days: [1], start_time: '09:00', end_time: '24:60' },
      { week_days: [1], start_time: '09:00', end_time: '17:00', visible: true },
    ].map(window => ['replace_playlist_item_schedule', { item_id: 20, week_schedules: [window] }]),
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
  }
  assert.equal(calls.length, 0);
});

test('reorder refuses incomplete and foreign item sets without writing', async t => {
  const { client, calls } = await setup(t);
  for (const ids of [[20], [20, 999], []]) {
    const result = await client.callTool({ name: 'reorder_playlist_items', arguments: { device_id: 1, playlist_item_ids: ids } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /every current item/);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.options.method === 'GET'));
});

test('uncertain writes are not retried and instruct reading state before retrying', async t => {
  for (const response of [
    () => { throw new Error('timeout with secret-api-key'); },
    () => new Response('secret-api-key', { status: 500 }),
    () => new Response('secret-api-key', { status: 200 }),
    () => Response.json({ data: { secret: 'secret-api-key' } }),
  ]) {
    let count = 0;
    const { client } = await setup(t, async () => { count++; return response(); });
    const result = await client.callTool({ name: 'add_playlist_item', arguments: { device_id: 1, plugin_setting_id: 'f7e6b4be-e437-4cc3-8345-b9d24fe2f100' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outcome is uncertain/);
    assert.equal(JSON.stringify(result).includes('secret-api-key'), false);
    assert.equal(count, 1);
  }
});

test('write validation and authorization failures are reported without reflecting the upstream body', async t => {
  for (const status of [401, 403, 404, 422, 429]) {
    const { client } = await setup(t, async () => new Response('secret-api-key', { status }));
    const result = await client.callTool({ name: 'set_playlist_item_visibility', arguments: { item_id: 20, visible: false } });
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('secret-api-key'), false);
    assert.doesNotMatch(result.content[0].text, /outcome is uncertain/);
  }
});

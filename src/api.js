import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const defaultKeyFile = join(homedir(), '.config/trmnl-playlist/account-api-key');

export class PublicError extends Error {}

export function validateKey(value) {
  const key = value.trim();
  if (!key || /\s/.test(key)) throw new PublicError('The account API key must be a single non-empty token.');
  if (key.startsWith('ps_mcp_')) throw new PublicError('This is a plugin MCP key. Use the User API Key from https://trmnl.com/account.');
  return key;
}

export async function loadKey(env = process.env, fallbackFile = defaultKeyFile) {
  if (env.TRMNL_ACCOUNT_API_KEY) return validateKey(env.TRMNL_ACCOUNT_API_KEY);
  let file;
  try {
    file = await open(env.TRMNL_ACCOUNT_API_KEY_FILE || fallbackFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
      throw new PublicError('The API key file must be owned by you, be a regular file, and have permissions 600.');
    }
    return validateKey(await file.readFile('utf8'));
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError('Account API key unavailable. Run scripts/configure.py to save your TRMNL User API Key locally.');
  } finally {
    await file?.close();
  }
}

// Explicit output fields keep credentials and unrelated account details out of MCP results.
const id = z.number().int();
const text = z.string().nullable().optional();
const number = z.number().nullable().optional();
const boolean = z.boolean().nullable().optional();
const device = z.object({
  id, name: text, refresh_interval: number, orientation: number,
  sleep_mode_enabled: boolean, sleep_start_time: number, sleep_end_time: number,
  last_ping_at: text, hardware_last_ping_at: text, percent_charged: number, wifi_strength: number,
});
const plugin = z.object({ id: id.optional(), name: text, keyname: text, description: text });
const pluginSetting = z.object({ id: id.optional(), name: text, description: text, plugin_id: number, strategy: text });
const item = z.object({
  id, device_id: number, row_order: number, visible: boolean, configuration_state: text,
  playlist_group_id: number, mashup_id: number, mirror: boolean,
  plugin_id: number, plugin_setting_id: number,
  plugin: plugin.nullable().optional(), plugin_setting: pluginSetting.nullable().optional(),
  rendered_at: text, created_at: text, updated_at: text,
});
const schedule = z.object({
  always_active: z.boolean(),
  week_schedules: z.array(z.object({
    week_days: z.array(z.number().int().min(0).max(6)),
    start_time: z.string(), end_time: z.string(),
  })),
});

const allowedRoutes = {
  GET: /^(?:\/api\/devices|\/api\/playlists\/items|\/api\/devices\/[1-9]\d*\/playlist_items|\/api\/playlists\/items\/[1-9]\d*\/schedule)$/,
  POST: /^\/api\/devices\/[1-9]\d*\/playlist_items$/,
  PATCH: /^\/api\/playlists\/items\/[1-9]\d*$/,
  PUT: /^(?:\/api\/devices\/[1-9]\d*\/playlist_items\/order|\/api\/playlists\/items\/[1-9]\d*\/schedule)$/,
  DELETE: /^\/api\/playlists\/items\/[1-9]\d*$/,
};
const success = z.object({ success: z.literal(true) });

export function createApi({ fetchImpl = globalThis.fetch, keyProvider = loadKey, timeoutMs = 15000 } = {}) {
  async function request(method, path, schema, body) {
    if (!allowedRoutes[method]?.test(path)) throw new PublicError('Unsupported TRMNL operation.');
    const key = await keyProvider();
    let responseAccepted = false;
    try {
      const response = await fetchImpl(`https://trmnl.com${path}`, {
        method, redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const messages = {
          401: 'TRMNL rejected the account API key. Run scripts/configure.py with a valid User API Key.',
          403: 'TRMNL denied access to this resource.',
          404: 'TRMNL could not find this resource in your account.',
          422: 'TRMNL rejected the supplied values. For ordering, include every current item exactly once; schedules require valid HH:MM times.',
          429: 'TRMNL rate limit reached. Wait before trying again.',
        };
        throw new PublicError(messages[response.status] || `TRMNL returned HTTP ${response.status}.`);
      }
      responseAccepted = true;
      if (!response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel();
        throw new PublicError('TRMNL returned a non-JSON response.');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new PublicError('TRMNL response exceeded the 2 MiB limit.');
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const parsed = schema.safeParse(payload.data);
      if (!parsed.success) throw new PublicError('TRMNL response did not match the documented API schema.');
      return parsed.data;
    } catch (error) {
      if (method !== 'GET' && (responseAccepted || !(error instanceof PublicError) || /HTTP 5\d\d/.test(error.message))) {
        throw new PublicError('The TRMNL write outcome is uncertain. Read the current playlist or schedule before retrying; the change may already have been applied.');
      }
      if (error instanceof PublicError) throw error;
      // Never surface upstream bodies, headers, URLs, or exception messages that might contain secrets.
      throw new PublicError('Unable to read TRMNL: network failure, timeout, redirect, or invalid JSON.');
    }
  }
  return {
    listDevices: () => request('GET', '/api/devices', z.array(device)),
    listItems: (deviceId) => request('GET', deviceId === undefined ? '/api/playlists/items' : `/api/devices/${deviceId}/playlist_items`, z.array(item)),
    getSchedule: (itemId) => request('GET', `/api/playlists/items/${itemId}/schedule`, schedule),
    setVisibility: (itemId, visible) => request('PATCH', `/api/playlists/items/${itemId}`, item, { visible }),
    addItem: (deviceId, pluginSettingId) => request('POST', `/api/devices/${deviceId}/playlist_items`, item, { plugin_setting_id: pluginSettingId }),
    removeItem: (itemId) => request('DELETE', `/api/playlists/items/${itemId}`, success),
    reorderItems: (deviceId, itemIds) => request('PUT', `/api/devices/${deviceId}/playlist_items/order`, success, { playlist_item_ids: itemIds }),
    replaceSchedule: (itemId, windows) => request('PUT', `/api/playlists/items/${itemId}/schedule`, schedule, { week_schedules: windows }),
  };
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'trmnl-connection-check', version: '0.2.0' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
  }));
  const { tools } = await client.listTools();
  console.log(`MCP connected: ${tools.length} tools (${tools.map(t => t.name).join(', ')}).`);
  const devices = await client.callTool({ name: 'list_devices', arguments: {} });
  if (devices.isError) {
    console.error(devices.content[0].text);
    process.exitCode = 1;
  } else {
    console.log(`TRMNL authenticated: ${devices.structuredContent.total} device(s).`);
    const items = await client.callTool({ name: 'list_playlist_items', arguments: {} });
    if (items.isError) {
      console.error(items.content[0].text);
      process.exitCode = 1;
    } else {
      console.log(`Playlist access verified: ${items.structuredContent.total} item(s).`);
    }
  }
} finally {
  await client.close();
}

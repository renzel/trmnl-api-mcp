#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

try {
  await createServer().connect(new StdioServerTransport());
} catch {
  process.stderr.write('TRMNL playlist MCP could not start. Check Node.js and installed dependencies.\n');
  process.exitCode = 1;
}

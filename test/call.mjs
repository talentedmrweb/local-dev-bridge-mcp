// One-shot tool call over MCP stdio: node test/call.mjs <tool> '<json-args>'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tool, json = '{}'] = process.argv.slice(2);
const client = new Client({ name: 'call', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'index.js')], env: { ...process.env }, stderr: 'ignore' }));
const r = await client.callTool({ name: tool, arguments: JSON.parse(json) });
console.log((r.isError ? '[isError] ' : '') + r.content.map((c) => c.text).join('\n'));
await client.close();

// Call any Classifer tool from the command line, through a real MCP client.
//
//   node scripts/call.js server_bootstrap
//   node scripts/call.js channel_create '{"name":"x","parent_id":"123"}'
//
// This exists because Classifer's tools only reach Claude after the plugin is
// installed and the app restarted. Until then — and afterwards, for scripting
// and for scheduled runs outside the app — this is the same server, the same
// transport, the same code path.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, 'classifer', 'src', 'index.js');

const name = process.argv[2];
if (!name) {
  console.error('usage: node scripts/call.js <tool_name> [json-args]');
  process.exit(2);
}

let args = {};
if (process.argv[3]) {
  try {
    args = JSON.parse(process.argv[3]);
  } catch (e) {
    console.error(`Arguments are not valid JSON: ${e.message}`);
    process.exit(2);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', SERVER],
  stderr: 'pipe',
});

const client = new Client({ name: 'cognition-cli', version: '0.1.0' });
await client.connect(transport);

try {
  const res = await client.callTool({ name, arguments: args });
  console.log(res.content.map((c) => c.text ?? '').join('\n'));
  await client.close();
  process.exit(res.isError ? 1 : 0);
} catch (e) {
  console.error(`${name} failed: ${e.message}`);
  await client.close();
  process.exit(1);
}

// Connects to Classifer as a real MCP client, over the same stdio transport
// Claude Code uses. If this passes, the plugin will work once installed; if it
// fails, it fails here with a stack trace instead of as a silent missing tool.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, 'classifer', 'src', 'index.js');

const only = process.argv[2];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', SERVER],
  stderr: 'pipe',
});

const client = new Client({ name: 'classifer-check', version: '0.1.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`\nClassifer exposes ${tools.length} tools\n`);

const groups = {};
for (const t of tools) {
  const g = t.name.split('_')[0];
  (groups[g] ??= []).push(t.name);
}
for (const [g, names] of Object.entries(groups)) {
  console.log(`  ${g.padEnd(14)} ${names.join(', ')}`);
}

// Every tool must carry a description — an undescribed tool is one Claude will
// misuse or ignore.
const undescribed = tools.filter((t) => !t.description || t.description.length < 20);
console.log(
  undescribed.length ? `\n  WARN undescribed: ${undescribed.map((t) => t.name).join(', ')}` : '\n  all tools described',
);

const calls = only
  ? [{ name: only, args: {} }]
  : [
      { name: 'system_status', args: {} },
      { name: 'guild_snapshot', args: {} },
      { name: 'registry_list', args: {} },
      { name: 'settings_get', args: {} },
      { name: 'server_bootstrap', args: { dry_run: true } },
    ];

let failures = 0;
for (const call of calls) {
  console.log(`\n${'='.repeat(64)}\n${call.name}\n${'='.repeat(64)}`);
  try {
    const res = await client.callTool({ name: call.name, arguments: call.args });
    const text = res.content.map((c) => c.text ?? '').join('\n');
    console.log(text.slice(0, 2500));
    if (res.isError) {
      failures++;
      console.log('  ^ returned isError');
    }
  } catch (e) {
    failures++;
    console.log(`  THREW: ${e.message}`);
  }
}

await client.close();
console.log(failures ? `\n${failures} call(s) failed\n` : '\nClassifer check passed\n');
process.exit(failures ? 1 : 0);

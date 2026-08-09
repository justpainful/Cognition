// Classifer — the MCP server through which Claude operates the Cognition server.
//
// It speaks Discord over REST and holds no gateway connection, which is
// deliberate: the server can be inspected and rebuilt whether or not the
// Cognition bot process happens to be running. Only live interactions need the
// bot, and answering those is its job, not this one's.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registry, invoke } from './kit.js';
import { requireEnv } from '../../shared/env.js';
import { getDb } from '../../shared/store.js';
import { purgeExpired } from '../../shared/guard.js';

// Registering tools is a side effect of importing these.
import './tools/observe.js';
import './tools/structure.js';
import './tools/content.js';
import './tools/registry.js';
import './tools/session.js';
import './tools/schedule.js';
import './tools/safety.js';
import './tools/triggers.js';
import './tools/gaps.js';
import './tools/bootstrap.js';

// stdout carries the MCP protocol and nothing else. A stray console.log from any
// module would corrupt the stream and the failure would look like a mysterious
// disconnect, so send everything to stderr instead.
console.log = (...args) => console.error(...args);

const server = new McpServer(
  { name: 'classifer', version: '0.1.0' },
  {
    instructions:
      'Classifer operates the Cognition Discord server. Read guild_snapshot before changing structure. ' +
      'Behaviour is data: build systems with registry_put and panel_publish rather than by writing code. ' +
      'Anything irreversible goes through destructive_plan, a human yes, then destructive_apply.',
  },
);

for (const spec of registry) {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.schema ?? {},
      annotations: {
        readOnlyHint: !spec.mutating,
        destructiveHint: spec.name.startsWith('destructive_'),
      },
    },
    (args) => invoke(spec, args),
  );
}

try {
  requireEnv();
  getDb();
  purgeExpired();
} catch (error) {
  // Fail visibly on stderr rather than serving tools that will all throw.
  console.error(`[classifer] startup problem: ${error.message}`);
}

await server.connect(new StdioServerTransport());
console.error(`[classifer] ready — ${registry.length} tools`);

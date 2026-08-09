// Launcher for the Classifer MCP server.
//
// Installing a plugin COPIES it into ~/.claude/plugins/cache/, so anything inside
// this directory is a frozen snapshot taken at install time. That is wrong for
// Classifer in two ways that matter: it would run against a copied registry.db
// rather than the one the bot writes to, and every edit to a tool would need a
// reinstall before it took effect.
//
// So the copied part is only this file. It hands off to the real server in the
// live project tree, which means one database, one .env, and edits that take
// effect the next time the server starts.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const home = process.env.COGNITION_HOME;

if (!home) {
  console.error(
    '[classifer] COGNITION_HOME is not set.\n' +
      '            It should be set in the plugin manifest, pointing at the Cognition project root.\n' +
      '            Without it this launcher cannot find the server.',
  );
  process.exit(1);
}

const entry = join(home, 'classifer', 'src', 'index.js');

if (!existsSync(entry)) {
  console.error(
    `[classifer] No server at ${entry}\n` +
      `            COGNITION_HOME points at "${home}". Either the path is wrong or the project moved.`,
  );
  process.exit(1);
}

await import(pathToFileURL(entry).href);

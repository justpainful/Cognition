// Install (or reinstall) the Cognition plugin into Claude Code.
//
//   node scripts/install-plugin.js
//
// Claude Code copies a plugin into its cache at install time, so this does the
// same three things the app would: copy the marketplace, copy the plugin, and
// register both. It is idempotent — run it again after editing a skill and the
// cached copy is refreshed.
//
// The MCP server itself is NOT copied. The cached plugin holds only launch.js,
// which hands off to the live project tree via COGNITION_HOME. One database, one
// .env, and edits to tools take effect on the next server start.
//
// A restart of Claude Code is required afterwards for the tools and skills to
// appear — MCP servers and skills are discovered at startup.

import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE = join(homedir(), '.claude');
const PLUGINS = join(CLAUDE, 'plugins');

const MARKETPLACE = 'cognition';
const PLUGIN = 'cognition';
const VERSION = '0.1.0';

const sourceMarketplace = join(ROOT, 'plugin');
const sourcePlugin = join(sourceMarketplace, 'plugins', PLUGIN);
const marketplaceDir = join(PLUGINS, 'marketplaces', MARKETPLACE);
const cacheDir = join(PLUGINS, 'cache', MARKETPLACE, PLUGIN, VERSION);

if (!existsSync(join(sourcePlugin, 'launch.js'))) {
  console.error(`No plugin source at ${sourcePlugin}. Run this from the Cognition project.`);
  process.exit(1);
}

// A malformed write here breaks plugin loading for every plugin, not just this
// one, so each file is re-read, edited and written whole.
function patchJson(path, mutate) {
  const before = readFileSync(path, 'utf8');
  const data = JSON.parse(before);
  mutate(data);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

const now = new Date().toISOString();

rmSync(marketplaceDir, { recursive: true, force: true });
rmSync(cacheDir, { recursive: true, force: true });
mkdirSync(marketplaceDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
cpSync(sourceMarketplace, marketplaceDir, { recursive: true });
cpSync(sourcePlugin, cacheDir, { recursive: true });

// The checked-in manifest carries a placeholder rather than somebody's home
// directory, so the repo is not tied to one machine. The installed copies get the
// real path written in — this is the only thing that needs to know where the
// project lives.
for (const dir of [join(marketplaceDir, 'plugins', PLUGIN), cacheDir]) {
  const manifest = join(dir, '.claude-plugin', 'plugin.json');
  const text = readFileSync(manifest, 'utf8').replace('SET_BY_INSTALLER', ROOT.replace(/\\/g, '\\\\'));
  writeFileSync(manifest, text);
}

patchJson(join(PLUGINS, 'known_marketplaces.json'), (km) => {
  km[MARKETPLACE] = {
    source: { source: 'directory', path: sourceMarketplace },
    installLocation: marketplaceDir,
    lastUpdated: now,
  };
});

patchJson(join(PLUGINS, 'installed_plugins.json'), (ip) => {
  ip.plugins[`${PLUGIN}@${MARKETPLACE}`] = [
    { scope: 'user', installPath: cacheDir, version: VERSION, installedAt: now, lastUpdated: now },
  ];
});

patchJson(join(CLAUDE, 'settings.json'), (s) => {
  s.enabledPlugins ??= {};
  s.enabledPlugins[`${PLUGIN}@${MARKETPLACE}`] = true;
});

console.log(`Installed ${PLUGIN}@${MARKETPLACE} ${VERSION}`);
console.log(`  marketplace  ${marketplaceDir}`);
console.log(`  plugin       ${cacheDir}`);
console.log(`  server       ${join(ROOT, 'classifer', 'src', 'index.js')} (via COGNITION_HOME)`);
console.log('\nRestart Claude Code for the Classifer tools and the skills to load.');

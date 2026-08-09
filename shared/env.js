// Resolves the project root from this file's own location and reads .env from
// there. Doing it this way means the Classifer MCP server works the moment the
// plugin is installed — Claude Code does not have to be told about any paths,
// and no environment variable has to be set by hand.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// <root>/shared/env.js -> <root>
export const ROOT = process.env.COGNITION_HOME || dirname(dirname(fileURLToPath(import.meta.url)));

export const DATA_DIR = join(ROOT, 'data');
export const DB_PATH = join(DATA_DIR, 'registry.db');

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = parseEnvFile(join(ROOT, '.env'));

// A real environment variable wins over the file, so a scheduled run or a
// container can override without editing anything on disk.
function read(key) {
  return process.env[key] || fileEnv[key] || '';
}

export const TOKEN = read('DISCORD_TOKEN');
export const GUILD_ID = read('COGNITION_GUILD_ID');

export function requireEnv() {
  const missing = [];
  if (!TOKEN) missing.push('DISCORD_TOKEN');
  if (!GUILD_ID) missing.push('COGNITION_GUILD_ID');
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(', ')}. Expected in ${join(ROOT, '.env')} or the process environment.`,
    );
  }
  return { TOKEN, GUILD_ID };
}

// Never let the token reach a log line, an audit row, or a Discord embed.
export function redact(text) {
  if (!text) return text;
  const s = String(text);
  return TOKEN ? s.split(TOKEN).join('[REDACTED_TOKEN]') : s;
}

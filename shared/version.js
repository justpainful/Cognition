// A fingerprint of the engine on disk.
//
// Registry rows are read fresh on every interaction, so editing behaviour needs
// no restart. Editing the *engine* — the executor, the dispatcher, the shared
// modules — is a different thing entirely: Node caches modules at import, so a
// long-running bot keeps executing the code it started with.
//
// That distinction is easy to state and easy to forget, and the symptom is
// baffling: an action kind that plainly exists in the vocabulary is rejected as
// unknown, because the process predates it. The bot records this hash at startup
// and system_status compares it against disk, so the answer is "the bot is
// running older code, restart it" rather than a hunt.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './env.js';

const ENGINE_DIRS = ['shared', 'bot', join('classifer', 'src'), join('classifer', 'src', 'tools')];

/** Hash of every engine source file, stable across runs and machines. */
export function engineHash() {
  const hash = createHash('sha256');
  for (const dir of ENGINE_DIRS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      if (!name.endsWith('.js')) continue;
      hash.update(`${dir}/${name}\n`);
      hash.update(readFileSync(join(abs, name)));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

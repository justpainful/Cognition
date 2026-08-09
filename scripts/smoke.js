// Proves the three things everything else assumes: the token is good, the
// guild is reachable, and the Registry file can be opened and written.
// Run it any time something behaves strangely — it fails loudly and specifically.

import { requireEnv, GUILD_ID, DB_PATH } from '../shared/env.js';
import { fetchGuild, fetchChannels, fetchRoles, fetchMe, CHANNEL_TYPE_NAME } from '../shared/rest.js';
import { getDb, all, setSetting, getSetting, nowIso } from '../shared/store.js';

const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => console.log(`  FAIL ${m}`);

let failed = false;

console.log('\nCognition smoke test\n');

try {
  requireEnv();
  ok(`env loaded (guild ${GUILD_ID})`);
} catch (e) {
  bad(e.message);
  process.exit(1);
}

try {
  const me = await fetchMe();
  ok(`bot identity: ${me.username} (${me.id})`);
} catch (e) {
  bad(`could not read bot identity — ${e.message}`);
  failed = true;
}

let channels = [];
try {
  const guild = await fetchGuild();
  channels = await fetchChannels();
  const roles = await fetchRoles();
  ok(`guild: "${guild.name}" · members ~${guild.approximate_member_count ?? '?'}`);
  ok(`channels: ${channels.length} · roles: ${roles.length}`);

  const byParent = new Map();
  for (const c of channels) {
    if (c.type === 4) continue;
    const k = c.parent_id ?? '(no category)';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(c);
  }
  const catName = (id) => channels.find((c) => c.id === id)?.name ?? id;

  console.log('');
  for (const [parent, kids] of byParent) {
    console.log(`    ${parent === '(no category)' ? '(no category)' : catName(parent)}`);
    for (const c of kids.sort((a, b) => a.position - b.position)) {
      console.log(`      #${c.name}  [${CHANNEL_TYPE_NAME[c.type] ?? c.type}]  ${c.id}`);
    }
  }
  console.log('');
} catch (e) {
  bad(`could not read the guild — ${e.message}`);
  if (e.status === 404) {
    console.log('       404 here means the bot is not in that guild, or the id is wrong.');
  }
  failed = true;
}

try {
  getDb();
  setSetting('smoke_last_run', nowIso());
  const back = getSetting('smoke_last_run');
  if (!back) throw new Error('wrote a setting but read back nothing');
  const tables = all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((r) => r.name);
  ok(`registry open at ${DB_PATH}`);
  ok(`tables: ${tables.join(', ')}`);
} catch (e) {
  bad(`registry problem — ${e.message}`);
  failed = true;
}

console.log(failed ? '\nSmoke test FAILED\n' : '\nSmoke test passed\n');
process.exit(failed ? 1 : 0);

// Watch ticket channels and emit one line per new human message.
//
//   node scripts/watch-messages.js [category_id] [poll_seconds]
//
// The bot has no messageCreate listener — the Dispatcher only handles
// interactions — so nothing in this project notices when somebody types. This
// polls the REST API instead and prints each new message to stdout, which is
// what turns it into a notification upstream.
//
// Messages authored by Cognition itself are skipped. Without that, every reply
// would be observed as a new message and answered again, forever.

import { requireEnv } from '../shared/env.js';
import { get, fetchChannels, fetchMe, CHANNEL_TYPE } from '../shared/rest.js';

requireEnv();

const CATEGORY = process.argv[2] || '1536064615635484766'; // Tickets [TEST]
const POLL_MS = Math.max(5, Number(process.argv[3]) || 12) * 1000;

const me = await fetchMe();
const seen = new Map(); // channelId -> last message id
const names = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => process.stdout.write(`${line}\n`);

/** Text channels under the watched category, refreshed so new tickets are picked up. */
async function channels() {
  const all = await fetchChannels();
  const kids = all.filter((c) => c.parent_id === CATEGORY && c.type === CHANNEL_TYPE.text);
  for (const c of kids) names.set(c.id, c.name);
  return kids.map((c) => c.id);
}

// Baseline first, so starting the watcher does not replay the whole backlog as
// if it had just arrived.
for (const id of await channels()) {
  try {
    const recent = await get(`/channels/${id}/messages`, { query: { limit: 1 } });
    seen.set(id, recent[0]?.id ?? '0');
  } catch {
    seen.set(id, '0');
  }
}

say(`watching ${seen.size} channel(s) under ${CATEGORY}, polling every ${POLL_MS / 1000}s`);

let consecutiveFailures = 0;

for (;;) {
  try {
    const ids = await channels();

    for (const id of ids) {
      if (!seen.has(id)) {
        // A ticket opened while we were watching. Report it and start from now.
        seen.set(id, '0');
        say(`NEW CHANNEL #${names.get(id)} (${id})`);
      }

      const after = seen.get(id);
      const query = after && after !== '0' ? { after, limit: 50 } : { limit: 1 };
      const messages = await get(`/channels/${id}/messages`, { query });
      if (!messages.length) continue;

      // Discord returns newest first; replay in the order they were written.
      const ordered = [...messages].reverse();
      seen.set(id, ordered[ordered.length - 1].id);

      if (after === '0' || !after) continue; // baseline only

      for (const m of ordered) {
        if (m.author?.id === me.id) continue; // our own replies
        const body = (m.content || '[embed or attachment]').replace(/\s+/g, ' ').trim();
        say(`MESSAGE #${names.get(id) ?? id} | ${m.author?.username ?? '?'} | ${body} | channel=${id}`);
      }
    }

    consecutiveFailures = 0;
  } catch (error) {
    consecutiveFailures++;
    // Report the first failure and then every tenth, so a token or network
    // problem is visible without the watcher becoming the noise.
    if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
      say(`WATCHER ERROR (${consecutiveFailures}x) ${error.message}`);
    }
  }

  await sleep(POLL_MS);
}

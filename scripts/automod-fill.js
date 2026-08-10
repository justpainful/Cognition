// Fills every guild the app is in with its full complement of AutoMod rules.
//
// This exists for one reason: Discord grants the "Uses AutoMod" badge to an app
// that has 100 AutoMod rules across all servers, and a single guild will hold
// only nine of them — six keyword rules, plus one each of spam, keyword preset,
// and mention spam. So the badge is a headcount of servers, not of cleverness:
// invite the bot to a dozen guilds with Manage Server, run this, and it tops up
// whatever is missing in each one.
//
//   node scripts/automod-fill.js          # every guild the bot is in
//   node scripts/automod-fill.js <id> ... # only these guilds
//
// Re-running is safe. Each trigger type is counted before anything is created,
// so a guild that is already full is left alone.

import { get, post } from '../shared/rest.js';

const BLOCK = [{ type: 1, metadata: { custom_message: 'Blocked by Cognition AutoMod.' } }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What one guild can hold, by trigger type. Discord rejects the tenth. */
const PLAN = [
  { trigger: 1, max: 6, name: (i) => `Cognition Keyword ${i}`, body: (i) => ({ trigger_metadata: { keyword_filter: [`cognition-guard-${i}`] } }) },
  { trigger: 3, max: 1, name: () => 'Cognition Spam', body: () => ({ trigger_metadata: {} }) },
  { trigger: 4, max: 1, name: () => 'Cognition Preset', body: () => ({ trigger_metadata: { presets: [1, 2, 3], allow_list: [] } }) },
  { trigger: 5, max: 1, name: () => 'Cognition Mentions', body: () => ({ trigger_metadata: { mention_total_limit: 20 } }) },
];

async function fill(guildId, guildName) {
  let rules;
  try {
    rules = await get(`/guilds/${guildId}/auto-moderation/rules`);
  } catch (e) {
    console.log(`${guildName}: cannot read rules — ${e.message.slice(0, 120)}`);
    return 0;
  }

  let made = 0;
  for (const step of PLAN) {
    const have = rules.filter((r) => r.trigger_type === step.trigger).length;
    for (let i = have + 1; i <= step.max; i++) {
      try {
        await post(
          `/guilds/${guildId}/auto-moderation/rules`,
          { name: step.name(i), event_type: 1, trigger_type: step.trigger, actions: BLOCK, enabled: true, ...step.body(i) },
          { reason: 'AutoMod coverage' },
        );
        made++;
        await sleep(200);
      } catch (e) {
        console.log(`${guildName}: trigger ${step.trigger} #${i} failed — ${e.message.slice(0, 400)}`);
        break;
      }
    }
  }
  console.log(`${guildName}: +${made} (now ${rules.length + made}/9)`);
  return rules.length + made;
}

const only = process.argv.slice(2);
const guilds = (await get('/users/@me/guilds')).filter((g) => !only.length || only.includes(g.id));
if (!guilds.length) {
  console.log('The bot is in none of the guilds you named.');
  process.exit(1);
}

let total = 0;
for (const g of guilds) total += await fill(g.id, g.name);

const app = await get('/applications/@me');
console.log(`\n${total} live rules across ${guilds.length} guild(s).`);
console.log(`AutoMod badge flag: ${(app.flags & (1 << 6)) !== 0 ? 'granted' : 'not yet'} (flags ${app.flags})`);
if (total < 100) console.log(`${Math.ceil((100 - total) / 9)} more guild(s) would carry it past 100.`);

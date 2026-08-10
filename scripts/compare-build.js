// Does the Cog source describe the system that is actually running?
//
//   node scripts/compare-build.js <built.json>
//
// The rows in systems/*.cog were written to describe behaviour that already
// exists as hand-written Registry rows. This compares the two, field by field,
// and is the only thing that can tell the difference between a language that
// expresses the system and one that merely looks like it does.
//
// Keys differ on purpose: a Cog verb inside `intent ticket` is keyed
// `ticket.open`, and the hand-written row was called `ticket_open`. The map
// below is that translation and nothing more; everything past it is compared
// exactly.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../shared/store.js';

const [, , path] = process.argv;
if (!path) {
  console.error('usage: node scripts/compare-build.js <built.json>');
  process.exit(2);
}

const built = JSON.parse(readFileSync(resolve(path), 'utf8'));

const db = getDb();
const live = {
  actions: db.prepare('SELECT * FROM action').all(),
  triggers: db.prepare('SELECT * FROM trigger').all(),
  schedules: db.prepare('SELECT * FROM schedule').all(),
};

/** Cog key to the key the running system uses. */
const SAME = {
  'ticket.open': 'ticket_open',
  'ticket.close': 'ticket_close',
  'op.rename_guild': 'op_rename_guild',
  'op.rename_guild_do': 'op_rename_guild_do',
  'op.archive_channel': 'op_archive_channel',
  'on_member_joins': 'welcome_member',
  'on_channel_deleted': 'alarm_channel_deleted',
  'on_message_posted': 'ack_mention',
  'every_day_0003': 'daily_marker',
  'presence.boot': 'presence.boot',
  'cmd.ping': 'cmd.ping',
  'cmd.about': 'cmd.about',
};

const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

/** Every path where two structures disagree. */
function differences(a, b, at = '') {
  if (a === b) return [];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return [[at || '(whole)', a, b]];
  }
  if (Array.isArray(a) !== Array.isArray(b)) return [[at, a, b]];

  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.flatMap((k) => {
    const where = at ? `${at}.${k}` : k;
    if (!(k in a)) return [[where, '(absent)', b[k]]];
    if (!(k in b)) return [[where, a[k], '(absent)']];
    return differences(a[k], b[k], where);
  });
}

const show = (v) => {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
};

const GUILD_ID = live.actions.length
  ? '1535979812860993617'
  : null;

/**
 * Two rows can differ and still be the same row.
 *
 * The hand-written rows leaned on the executor's defaults; Cog writes what it
 * means. Both produce the same call to Discord, and calling that a failure
 * would make this comparison useless — it would report noise forever and hide
 * the one difference that mattered.
 */
function equivalent([where, cog, host]) {
  const field = where.split('.').at(-1);

  // The host fills these in when they are missing, with exactly these values.
  const DEFAULTS = { ephemeral: true, by: 1, style: 'short', required: false };
  if (host === '(absent)' && DEFAULTS[field] === cog) return 'the host default, written out';
  if (field === 'user_id' && host === '(absent)' && cog === '{{user.id}}') {
    return 'the host default, written out';
  }

  // @everyone is the role whose id is the guild's, which the template knows.
  if (cog === '{{guild.id}}' && host === GUILD_ID) return 'the same id, by name';

  // Both render to the same text.
  if (typeof cog === 'string' && typeof host === 'string') {
    const same = cog.replace(/\{\{created\.mention\}\}/g, '<#{{created.id}}>') === host;
    if (same) return 'renders identically';
  }

  // Keys the two systems chose for themselves.
  if (field === 'component_key') return 'an internal key, chosen differently';
  if (field === 'on_submit' && SAME[cog] === host) return 'the same action, renamed';

  return null;
}

let same = 0;
let differing = 0;
let equivalences = 0;
const unmatched = [];

console.log('actions\n');

for (const action of built.actions) {
  const liveKey = SAME[action.key];
  if (!liveKey) {
    unmatched.push(`${action.key} — built here, nothing in the Registry answers to it`);
    continue;
  }
  const row = live.actions.find((a) => a.key === liveKey);
  if (!row) {
    unmatched.push(`${action.key} → ${liveKey} — the Registry has no such row`);
    continue;
  }

  const all = [
    ...differences(action.params, parse(row.params, {}), 'params'),
    ...differences(action.requires ?? null, parse(row.requires, null), 'requires'),
    ...(action.kind === row.kind ? [] : [['kind', action.kind, row.kind]]),
  ];
  const explained = all.map((gap) => [gap, equivalent(gap)]);
  const gaps = explained.filter(([, why]) => !why);
  const settled = explained.filter(([, why]) => why);
  equivalences += settled.length;

  if (!gaps.length) {
    same++;
    const note = settled.length ? ` (${settled.length} written differently, same effect)` : '';
    console.log(`  same       ${action.key.padEnd(20)} ${liveKey}${note}`);
    for (const [[where], why] of settled) console.log(`               ${where} — ${why}`);
  } else {
    differing++;
    console.log(`  DIFFERS    ${action.key.padEnd(20)} ${liveKey}`);
    for (const [[where, cog, host]] of gaps) {
      console.log(`               ${where}`);
      console.log(`                 cog:  ${show(cog)}`);
      console.log(`                 live: ${show(host)}`);
    }
  }
}

console.log('\ntriggers and schedules\n');

for (const trigger of built.triggers) {
  const liveKey = SAME[trigger.action_key];
  const row = live.triggers.find((t) => t.action_key === liveKey);
  if (!row) {
    unmatched.push(`trigger on ${trigger.event} — nothing in the Registry answers to it`);
    continue;
  }
  const gaps = [
    ...(trigger.event === row.event ? [] : [['event', trigger.event, row.event]]),
    ...differences(trigger.filter, parse(row.filter, {}), 'filter'),
  ];
  if (!gaps.length) {
    same++;
    console.log(`  same       ${trigger.event.padEnd(20)} ${row.key}`);
  } else {
    differing++;
    console.log(`  DIFFERS    ${trigger.event.padEnd(20)} ${row.key}`);
    for (const [where, cog, host] of gaps) console.log(`               ${where}: ${show(cog)} vs ${show(host)}`);
  }
}

for (const schedule of built.schedules) {
  const liveKey = SAME[schedule.action_key];
  const row = live.schedules.find((s) => s.action_key === liveKey);
  if (!row) {
    unmatched.push(`schedule ${schedule.cron} — nothing in the Registry answers to it`);
    continue;
  }
  const ok = schedule.cron === row.cron;
  if (ok) same++;
  else differing++;
  console.log(`  ${ok ? 'same      ' : 'DIFFERS   '} ${schedule.cron.padEnd(20)} ${row.key}${ok ? '' : ` (live: ${row.cron})`}`);
}

if (unmatched.length) {
  console.log('\nnot compared\n');
  for (const line of unmatched) console.log(`  ${line}`);
}

// Rows in the Registry that no Cog file describes. These are the honest result
// of the exercise: whatever is here is behaviour the language has not been
// asked to express yet.
const described = new Set(Object.values(SAME));
const undescribed = live.actions.filter((a) => !described.has(a.key));
if (undescribed.length) {
  console.log('\nin the Registry, not in any .cog file\n');
  for (const a of undescribed) console.log(`  ${a.key} (${a.kind})`);
}

console.log(
  `\n${same} the same, ${differing} differing, ${undescribed.length} undescribed` +
    `\n${equivalences} field(s) written differently to the same effect`,
);
process.exit(differing ? 1 : 0);

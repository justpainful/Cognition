// Triggers bind gateway events to Registry actions.
//
// Until now the only thing that could cause an action was a button press, which
// meant the server could react to being clicked and to the clock, and to nothing
// else. Four privileged intents were being requested and none of them were read.
//
// A trigger is the same shape as a schedule, with an event in place of a cron
// expression: when this happens, and it matches this filter, run this action.
// Same Registry, same executor, same audit trail.

import { all, one, run, nowIso, parseJson } from './store.js';
import { getAction } from './registry.js';

/**
 * The events the bot listens for. Each one lists the filter keys that mean
 * something for it, because a filter that silently does nothing is worse than a
 * rejected one.
 */
export const EVENTS = {
  message_create: {
    describe: 'someone posts a message',
    filters: ['channel_id', 'contains', 'starts_with', 'from_bot', 'has_role', 'author_id'],
    scope: 'user, channel, message',
  },
  member_join: {
    describe: 'someone joins the server',
    filters: ['from_bot'],
    scope: 'user',
  },
  member_leave: {
    describe: 'someone leaves or is removed',
    filters: ['from_bot'],
    scope: 'user',
  },
  reaction_add: {
    describe: 'someone reacts to a message',
    filters: ['channel_id', 'emoji', 'from_bot', 'has_role'],
    scope: 'user, channel, message, emoji',
  },
  channel_delete: {
    describe: 'a channel is deleted by anyone, including by hand in the client',
    filters: ['channel_id'],
    scope: 'channel',
  },
  thread_create: {
    describe: 'a thread is created',
    filters: ['channel_id'],
    scope: 'channel',
  },
};

export const EVENT_NAMES = Object.keys(EVENTS);

function rowToTrigger(row) {
  if (!row) return null;
  return {
    key: row.key,
    event: row.event,
    filter: parseJson(row.filter, {}),
    actionKey: row.action_key,
    enabled: !!row.enabled,
    note: row.note ?? null,
    lastFiredAt: row.last_fired_at ?? null,
    fireCount: row.fire_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getTrigger(key) {
  return rowToTrigger(one('SELECT * FROM trigger WHERE key = ?', key));
}

export function listTriggers({ event, enabledOnly = false } = {}) {
  let sql = 'SELECT * FROM trigger';
  const params = [];
  const where = [];
  if (event) {
    where.push('event = ?');
    params.push(event);
  }
  if (enabledOnly) where.push('enabled = 1');
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  return all(`${sql} ORDER BY key`, ...params).map(rowToTrigger);
}

export function putTrigger({ key, event, filter = {}, actionKey, enabled = true, note = null }) {
  if (!key) throw new Error('trigger needs a key');
  if (!EVENT_NAMES.includes(event)) {
    throw new Error(`Unknown event "${event}". Known events: ${EVENT_NAMES.join(', ')}`);
  }
  if (!getAction(actionKey)) {
    throw new Error(`trigger points at action "${actionKey}", which does not exist.`);
  }

  // A filter key that this event never supplies would silently never match, and
  // the trigger would look broken rather than misconfigured.
  const allowed = EVENTS[event].filters;
  for (const k of Object.keys(filter ?? {})) {
    if (!allowed.includes(k)) {
      throw new Error(
        `Filter "${k}" means nothing for ${event}. Supported here: ${allowed.join(', ') || '(none)'}`,
      );
    }
  }

  const at = nowIso();
  run(
    `INSERT INTO trigger (key, event, filter, action_key, enabled, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       event = excluded.event, filter = excluded.filter, action_key = excluded.action_key,
       enabled = excluded.enabled, note = excluded.note, updated_at = excluded.updated_at`,
    key,
    event,
    JSON.stringify(filter ?? {}),
    actionKey,
    enabled ? 1 : 0,
    note,
    at,
    at,
  );
  return getTrigger(key);
}

export function deleteTrigger(key) {
  const existing = getTrigger(key);
  if (existing) run('DELETE FROM trigger WHERE key = ?', key);
  return existing;
}

export function markFired(key) {
  run(
    'UPDATE trigger SET last_fired_at = ?, fire_count = fire_count + 1 WHERE key = ?',
    nowIso(),
    key,
  );
}

/**
 * Does this event payload match the trigger's filter?
 * Returns a reason when it does not, so trigger_test can explain itself.
 */
export function matches(filter = {}, payload = {}) {
  const text = String(payload.content ?? '');

  if (filter.channel_id && String(payload.channelId) !== String(filter.channel_id)) {
    return { pass: false, reason: `channel ${payload.channelId} is not ${filter.channel_id}` };
  }
  if (filter.author_id && String(payload.userId) !== String(filter.author_id)) {
    return { pass: false, reason: `author ${payload.userId} is not ${filter.author_id}` };
  }
  if (filter.contains && !text.toLowerCase().includes(String(filter.contains).toLowerCase())) {
    return { pass: false, reason: `text does not contain "${filter.contains}"` };
  }
  if (filter.starts_with && !text.toLowerCase().startsWith(String(filter.starts_with).toLowerCase())) {
    return { pass: false, reason: `text does not start with "${filter.starts_with}"` };
  }
  if (filter.emoji && String(payload.emoji) !== String(filter.emoji)) {
    return { pass: false, reason: `emoji ${payload.emoji} is not ${filter.emoji}` };
  }
  if (filter.has_role) {
    const roles = (payload.memberRoles ?? []).map(String);
    if (!roles.includes(String(filter.has_role))) {
      return { pass: false, reason: `member does not have role ${filter.has_role}` };
    }
  }
  // Defaults to excluding bots. Loops where a bot's own post retriggers the
  // action that produced it are the obvious failure mode here, so opting in has
  // to be deliberate.
  const wantsBots = filter.from_bot === true;
  if (!wantsBots && payload.isBot) {
    return { pass: false, reason: 'author is a bot and from_bot is not set' };
  }

  return { pass: true, reason: 'matched' };
}

// ---- counters -------------------------------------------------------------

/** Persistent named counters, so an action can number the things it creates. */
export function bumpCounter(key, by = 1) {
  run(
    `INSERT INTO counter (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = counter.value + excluded.value, updated_at = excluded.updated_at`,
    key,
    by,
    nowIso(),
  );
  return readCounter(key);
}

export function readCounter(key) {
  const row = one('SELECT value FROM counter WHERE key = ?', key);
  return row ? Number(row.value) : 0;
}

export function listCounters() {
  return all('SELECT * FROM counter ORDER BY key').map((r) => ({
    key: r.key,
    value: Number(r.value),
    updatedAt: r.updated_at,
  }));
}

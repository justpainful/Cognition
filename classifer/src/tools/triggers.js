// Binding events to behaviour.

import { tool, z, table, json } from '../kit.js';
import {
  EVENTS,
  EVENT_NAMES,
  getTrigger,
  listTriggers,
  putTrigger,
  deleteTrigger,
  matches,
  listCounters,
  readCounter,
  bumpCounter,
} from '../../../shared/triggers.js';
import { getAction } from '../../../shared/registry.js';
import { execute } from '../../../shared/executor.js';
import { GUILD_ID } from '../../../shared/env.js';

tool({
  name: 'trigger_events',
  title: 'Which events can be listened for',
  description:
    'The gateway events the bot routes into the Registry, with the filter keys each one supports and the template scope it provides. Read before creating a trigger — a filter key the event never supplies is rejected at write time rather than silently never matching.',
  schema: {},
  async run() {
    return [
      'EVENTS',
      '',
      ...Object.entries(EVENTS).flatMap(([name, e]) => [
        `  ${name}`,
        `    fires when  ${e.describe}`,
        `    filters     ${e.filters.join(', ') || '(none)'}`,
        `    scope       ${e.scope}`,
        '',
      ]),
      'FILTER KEYS',
      '  channel_id   only in this channel',
      '  author_id    only from this user',
      '  contains     message text contains this, case-insensitive',
      '  starts_with  message text starts with this',
      '  emoji        the reaction emoji',
      '  has_role     the member holds this role id',
      '  from_bot     true to also fire for other bots (default false)',
      '',
      "Cognition's own messages never fire a trigger, whatever from_bot says.",
      'Without that an action that posts a message would re-trigger itself at gateway speed.',
      '',
      'A trigger runs in a system context: there is nobody to reply to, so use',
      'message_send or dm_send rather than reply.',
    ].join('\n');
  },
});

tool({
  name: 'trigger_create',
  title: 'Run an action when something happens',
  description:
    'Bind a gateway event to a Registry action, optionally filtered. This is how the server reacts to things other than button presses — someone joining, a keyword being posted, a reaction landing, a channel being deleted by hand. Picked up by the bot immediately, no restart.',
  mutating: true,
  schema: {
    key: z.string().describe('stable name, e.g. welcome_new_member'),
    event: z.enum(EVENT_NAMES),
    action_key: z.string(),
    filter: z.record(z.string(), z.any()).default({}).optional(),
    note: z.string().optional(),
    enabled: z.boolean().default(true).optional(),
  },
  async run({ key, event, action_key, filter = {}, note, enabled = true }) {
    const action = getAction(action_key);
    if (!action) throw new Error(`No action "${action_key}". Create it with registry_put first.`);
    if (action.kind === 'reply' || action.kind === 'modal_open') {
      throw new Error(
        `Action "${action_key}" is a ${action.kind}, which answers someone who just clicked something. ` +
          `An event has no interaction to answer — use message_send or dm_send instead.`,
      );
    }

    const existed = !!getTrigger(key);
    const trigger = putTrigger({ key, event, filter, actionKey: action_key, enabled, note });

    return {
      target: key,
      text: [
        `${existed ? 'Updated' : 'Created'} trigger "${key}".`,
        `  on      ${event} (${EVENTS[event].describe})`,
        `  runs    ${action_key} (${action.kind})`,
        `  filter  ${Object.keys(trigger.filter).length ? JSON.stringify(trigger.filter) : '(none — fires every time)'}`,
        `  state   ${enabled ? 'enabled' : 'disabled'}`,
        '',
        'The bot picks this up on the next event. No restart.',
      ].join('\n'),
    };
  },
});

tool({
  name: 'trigger_list',
  title: 'List event triggers',
  description: 'Every trigger with its event, filter, and how often it has fired.',
  schema: { event: z.enum(EVENT_NAMES).optional() },
  async run({ event }) {
    const rows = listTriggers({ event });
    if (!rows.length) return 'No triggers. trigger_create adds one; trigger_events lists what can be listened for.';
    return table(rows, [
      { header: 'key', get: (t) => t.key },
      { header: 'event', get: (t) => t.event },
      { header: 'action', get: (t) => t.actionKey },
      { header: 'on', get: (t) => (t.enabled ? 'yes' : 'no') },
      { header: 'fired', get: (t) => t.fireCount },
      { header: 'last', get: (t) => t.lastFiredAt?.slice(0, 16).replace('T', ' ') ?? 'never' },
      { header: 'filter', get: (t) => (Object.keys(t.filter).length ? JSON.stringify(t.filter) : '') },
    ]);
  },
});

tool({
  name: 'trigger_toggle',
  title: 'Enable or disable a trigger',
  description: 'Pause a trigger without losing its definition.',
  mutating: true,
  schema: { key: z.string(), enabled: z.boolean() },
  async run({ key, enabled }) {
    const t = getTrigger(key);
    if (!t) throw new Error(`No trigger "${key}".`);
    putTrigger({ ...t, actionKey: t.actionKey, enabled });
    return { target: key, text: `Trigger "${key}" is now ${enabled ? 'enabled' : 'disabled'}.` };
  },
});

tool({
  name: 'trigger_delete',
  title: 'Delete a trigger',
  description: 'Remove a trigger. The action it pointed at is left alone.',
  mutating: true,
  schema: { key: z.string() },
  async run({ key }) {
    const removed = deleteTrigger(key);
    return { target: key, text: removed ? `Deleted trigger "${key}".` : `No trigger "${key}" to delete.` };
  },
});

tool({
  name: 'trigger_test',
  title: 'Would this trigger fire, and what would it do',
  description:
    'Check a trigger against a made-up event payload. Reports whether the filter matches and why, then optionally runs the action for real. Use it before waiting around for a real event that may not come.',
  mutating: true,
  schema: {
    key: z.string(),
    payload: z
      .record(z.string(), z.any())
      .default({})
      .describe('fields like userId, content, channelId, emoji, memberRoles, isBot'),
    execute_for_real: z.boolean().default(false).optional().describe('actually run the action, not just the match'),
  },
  async run({ key, payload = {}, execute_for_real = false }) {
    const trigger = getTrigger(key);
    if (!trigger) throw new Error(`No trigger "${key}".`);

    const verdict = matches(trigger.filter, payload);
    const lines = [
      `Trigger "${key}" on ${trigger.event} -> ${trigger.actionKey}`,
      `filter  ${JSON.stringify(trigger.filter)}`,
      `payload ${JSON.stringify(payload)}`,
      '',
      `match   ${verdict.pass ? 'YES' : 'NO'} — ${verdict.reason}`,
    ];

    if (!verdict.pass || !execute_for_real) {
      if (verdict.pass) lines.push('', 'Not executed. Pass execute_for_real to run it.');
      return { target: key, text: lines.join('\n'), skipPublish: true };
    }

    const ctx = {
      source: 'trigger',
      actor: 'claude',
      guildId: GUILD_ID,
      user: payload.user ?? (payload.userId ? { id: payload.userId, username: 'test' } : undefined),
      channel: payload.channelId ? { id: payload.channelId, name: 'test' } : undefined,
      message: payload.messageId ? { id: payload.messageId } : undefined,
      memberRoles: payload.memberRoles ?? [],
      args: [],
      fields: {},
      extra: payload.extra ?? {},
    };
    const result = await execute(trigger.actionKey, ctx);
    lines.push('', 'EXECUTED', ...result.log.map((l) => `  ${l}`));
    return { target: key, text: lines.join('\n') };
  },
});

tool({
  name: 'counters',
  title: 'Read or set the named counters',
  description:
    'Counters give actions a number to work with, so a ticket can be ticket-0007 rather than a snowflake. Bumped by the counter_bump primitive, which exposes {{counter.value}} to whatever it wraps.',
  mutating: true,
  schema: {
    key: z.string().optional().describe('omit to list them all'),
    set_to: z.number().int().optional().describe('force the counter to this value'),
  },
  async run({ key, set_to }) {
    if (!key) {
      const rows = listCounters();
      return rows.length
        ? table(rows, [
            { header: 'key', get: (c) => c.key },
            { header: 'value', get: (c) => c.value },
            { header: 'updated', get: (c) => c.updatedAt.slice(0, 16).replace('T', ' ') },
          ])
        : '(no counters yet)';
    }
    if (set_to === undefined) {
      return { target: key, text: `${key} = ${readCounter(key)}`, skipPublish: true };
    }
    const current = readCounter(key);
    bumpCounter(key, set_to - current);
    return { target: key, text: `${key}: ${current} -> ${readCounter(key)}` };
  },
});

// Bot-side scheduling.
//
// These schedules live in the Registry and are fired by the Cognition process,
// which means they run whether or not Claude Code is open. That is the whole
// point of this tier: a daily archive sweep at 03:00 has to happen at 03:00, and
// a scheduled Claude session cannot promise that — it only runs while the app is
// running, and catches up late otherwise.
//
// The rule of thumb the schedule-work skill spells out: if the task is a fixed
// sequence of Discord operations, put it here. If it needs judgement about what
// to do, it belongs in a Claude routine instead.

import { tool, z, table } from '../kit.js';
import {
  getSchedule,
  listSchedules,
  putSchedule,
  deleteSchedule,
  markScheduleRun,
  getAction,
} from '../../../shared/registry.js';
import { isValid, describe, nextRun } from '../../../shared/cron.js';
import { execute, systemContext } from '../../../shared/executor.js';
import { log as auditLog } from '../../../shared/audit.js';

tool({
  name: 'schedule_create',
  title: 'Schedule a Registry action',
  description:
    'Bind a cron expression to an action. The Cognition bot fires it, so it keeps running with Claude Code closed. Cron is 5-field, evaluated in local time. Prefer off-minutes (":07" over ":00") unless the exact time matters.',
  mutating: true,
  schema: {
    key: z.string().describe('stable name for this schedule, e.g. nightly_archive_sweep'),
    cron: z.string().describe('5 fields: minute hour day-of-month month day-of-week'),
    action_key: z.string().describe('an existing action in the Registry'),
    context: z.record(z.string(), z.any()).default({}).optional().describe('extra template values for the run'),
    note: z.string().optional().describe('what this is for'),
    enabled: z.boolean().default(true).optional(),
  },
  async run({ key, cron, action_key, context = {}, note, enabled = true }) {
    if (!isValid(cron)) {
      throw new Error(
        `"${cron}" is not a valid 5-field cron expression. Format: minute hour day-of-month month day-of-week. ` +
          `Examples: "*/5 * * * *" every five minutes, "7 3 * * *" daily at 03:07, "0 9 * * 1-5" weekdays at 09:00.`,
      );
    }
    const action = getAction(action_key);
    if (!action) throw new Error(`No action "${action_key}" in the Registry. Create it first with registry_put.`);
    if (action.kind === 'reply' || action.kind === 'modal_open') {
      throw new Error(
        `Action "${action_key}" is a ${action.kind}, which answers a person who just clicked something. ` +
          `A scheduled run has nobody to answer. Use message_send to post into a channel instead.`,
      );
    }

    const existed = !!getSchedule(key);
    putSchedule({ key, cron, actionKey: action_key, context, enabled, note });
    const next = nextRun(cron);

    return {
      target: key,
      text: [
        `${existed ? 'Updated' : 'Created'} schedule "${key}".`,
        `  ${cron}   (${describe(cron)})`,
        `  runs     ${action_key} (${action.kind})`,
        `  next     ${enabled ? (next ? next.toLocaleString() : 'never') : '(disabled)'}`,
        '',
        'The bot picks this up within 30 seconds — no restart needed.',
      ].join('\n'),
    };
  },
});

tool({
  name: 'schedule_list',
  title: 'List bot-side schedules',
  description: 'Every schedule with its next and last fire time.',
  schema: {},
  async run() {
    const rows = listSchedules();
    if (!rows.length) return 'No schedules. schedule_create adds one.';
    return table(rows, [
      { header: 'key', get: (s) => s.key },
      { header: 'cron', get: (s) => s.cron },
      { header: 'when', get: (s) => (isValid(s.cron) ? describe(s.cron) : 'INVALID') },
      { header: 'action', get: (s) => s.actionKey },
      { header: 'on', get: (s) => (s.enabled ? 'yes' : 'no') },
      {
        header: 'next',
        get: (s) => (s.enabled && isValid(s.cron) ? (nextRun(s.cron)?.toLocaleString() ?? '-') : '-'),
      },
      { header: 'last', get: (s) => `${s.lastRunAt?.slice(0, 16).replace('T', ' ') ?? 'never'} ${s.lastStatus ?? ''}` },
    ]);
  },
});

tool({
  name: 'schedule_toggle',
  title: 'Enable or disable a schedule',
  description: 'Pause a schedule without losing its definition.',
  mutating: true,
  schema: {
    key: z.string(),
    enabled: z.boolean(),
  },
  async run({ key, enabled }) {
    const s = getSchedule(key);
    if (!s) throw new Error(`No schedule "${key}".`);
    putSchedule({ ...s, actionKey: s.actionKey, enabled });
    return { target: key, text: `Schedule "${key}" is now ${enabled ? 'enabled' : 'disabled'}.` };
  },
});

tool({
  name: 'schedule_delete',
  title: 'Delete a schedule',
  description: 'Remove a schedule. The action it pointed at is left alone.',
  mutating: true,
  schema: { key: z.string() },
  async run({ key }) {
    const removed = deleteSchedule(key);
    return { target: key, text: removed ? `Deleted schedule "${key}".` : `No schedule "${key}" to delete.` };
  },
});

tool({
  name: 'schedule_run_now',
  title: 'Fire a schedule immediately',
  description:
    'Run a schedule\'s action right now, in the same system context the bot would use. This is how you test a schedule without waiting for its cron to come round — and it works even if the bot process is stopped.',
  mutating: true,
  schema: { key: z.string() },
  async run({ key }) {
    const s = getSchedule(key);
    if (!s) throw new Error(`No schedule "${key}".`);

    try {
      const result = await execute(s.actionKey, systemContext({ source: 'classifer', extra: s.context }));
      markScheduleRun(key, 'ok');
      auditLog({
        source: 'scheduler',
        actor: 'claude',
        op: `manual:${key}`,
        target: s.actionKey,
        result: 'ok',
        detail: result.log.join(' · '),
      });
      return {
        target: key,
        text: `Ran "${key}" -> ${s.actionKey}\n\n${result.log.map((l) => `  ${l}`).join('\n') || '  (no output)'}`,
      };
    } catch (e) {
      markScheduleRun(key, 'error');
      throw e;
    }
  },
});

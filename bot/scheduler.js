// The scheduling tier that does not depend on Claude Code being open.
//
// A tick every 30 seconds asks each enabled schedule whether its cron matches
// the current minute. Two ticks land inside the same minute, so a schedule that
// already ran this minute is skipped — and because that check is against the
// persisted last_run_at rather than a variable in memory, a restart mid-minute
// does not cause a double fire either.
//
// Overrunning actions are not run concurrently with themselves: a schedule still
// executing when the next tick arrives is skipped rather than stacked.

import { listSchedules, markScheduleRun } from '../shared/registry.js';
import { matches, isValid } from '../shared/cron.js';
import { execute, systemContext } from '../shared/executor.js';
import { log as auditLog } from '../shared/audit.js';
import { purgeExpired } from '../shared/guard.js';

const TICK_MS = 30_000;

const running = new Set();

function minuteKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}T${date.getHours()}:${date.getMinutes()}`;
}

async function tick() {
  const now = new Date();
  const thisMinute = minuteKey(now);

  for (const schedule of listSchedules({ enabledOnly: true })) {
    if (running.has(schedule.key)) continue;

    if (!isValid(schedule.cron)) {
      // Say it once per minute rather than twice; the operator needs to see it
      // but not be buried by it.
      auditLog({
        source: 'scheduler',
        actor: 'system',
        op: schedule.key,
        target: schedule.actionKey,
        result: 'error',
        detail: `invalid cron "${schedule.cron}" — this schedule can never fire`,
      });
      continue;
    }

    if (!matches(schedule.cron, now)) continue;
    if (schedule.lastRunAt && minuteKey(new Date(schedule.lastRunAt)) === thisMinute) continue;

    running.add(schedule.key);
    // Mark before running: if this process dies mid-action, the schedule must
    // not fire again on restart within the same minute.
    markScheduleRun(schedule.key, 'running');

    execute(schedule.actionKey, systemContext({ extra: schedule.context }))
      .then((result) => {
        markScheduleRun(schedule.key, 'ok');
        auditLog({
          source: 'scheduler',
          actor: 'system',
          op: schedule.key,
          target: schedule.actionKey,
          result: 'ok',
          detail: result.log.join(' · ').slice(0, 500),
        });
      })
      .catch((error) => {
        markScheduleRun(schedule.key, 'error');
        auditLog({
          source: 'scheduler',
          actor: 'system',
          op: schedule.key,
          target: schedule.actionKey,
          result: 'error',
          detail: error.message,
        });
      })
      .finally(() => running.delete(schedule.key));
  }
}

export function start() {
  const timer = setInterval(() => {
    tick().catch((e) => console.error(`[scheduler] tick failed: ${e.message}`));
  }, TICK_MS);
  timer.unref?.();

  // Housekeeping: spent and long-expired confirmation tokens.
  const cleanup = setInterval(() => {
    try {
      purgeExpired();
    } catch {
      /* not worth taking the bot down for */
    }
  }, 3600_000);
  cleanup.unref?.();

  tick().catch(() => {});
  return () => {
    clearInterval(timer);
    clearInterval(cleanup);
  };
}

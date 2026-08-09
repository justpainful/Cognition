---
name: schedule-work
description: Put work on a schedule in the Cognition server, choosing correctly between the bot-side scheduler (runs 24/7, fixed steps) and a Claude routine (needs the app open, but can exercise judgement). Use whenever something should happen repeatedly or at a later time. Triggers on: جدول، كل يوم، كل ساعة، بشكل دوري، ذكّرني، شغّل تلقائي، مهمة مجدولة، schedule this, every morning, recurring.
---

# Two tiers, and picking the wrong one is the usual mistake

**Bot-side schedules** live in the Registry and are fired by the Cognition process.
They run whether or not Claude Code is open, as long as the bot is up. They execute
a fixed action tree and make no decisions.

**Claude routines** are scheduled tasks that start a fresh Claude session, which then
calls Classifer. They can read the server, weigh what they find, and choose what to
do — but **they only run while the Claude Code app is open**, and a task whose time
passed while the app was closed runs late, on next launch.

That second sentence is the whole decision. A 03:00 job on a machine where the app
is closed overnight will not happen at 03:00. If the timing matters, it is bot-side.

## Choosing

| The task | Tier |
|---|---|
| Post a dated separator in `#command-log` at midnight | bot-side |
| Lock a channel every Friday evening | bot-side |
| Post a recurring reminder or announcement | bot-side |
| Re-post a panel that keeps scrolling away | bot-side |
| "Review the sessions and archive whatever has gone stale" | Claude routine |
| "Check the server for anything odd and tell me" | Claude routine |
| "Read the audit log and write up the week" | Claude routine |
| Anything whose output depends on what was found | Claude routine |

If you cannot express it as a fixed sequence of Discord operations, it is not
bot-side. If you can, it should be — it is more reliable and it costs nothing to run.

## Bot-side: how

The action must exist first, and it must be one that makes sense with nobody
watching. `schedule_create` rejects `reply` and `modal_open` for exactly this reason:
they answer a person who just clicked something, and a scheduled run has no such
person. Use `message_send` to post into a channel instead.

```
registry_put   key=daily_marker kind=message_send params={channel_id, embed}
schedule_create key=daily_marker cron="3 0 * * *" action_key=daily_marker
```

Cron is five fields in local time: `minute hour day-of-month month day-of-week`.
Prefer an off-minute — `"7 * * * *"` over `"0 * * * *"` — unless the exact time
matters, so that everything does not pile onto the same instant.

`schedule_run_now` fires one immediately, in the same system context the bot would
use. Test with it rather than waiting for the cron to come round; it also works with
the bot stopped, which makes it the fastest way to find out whether an action is
broken or the bot is simply down.

The bot picks up a new or edited schedule within 30 seconds. No restart.

A schedule that already ran this minute is skipped, and that check is against the
persisted last-run time — so a restart mid-minute does not double-fire.

## Claude routines: how

Use the `scheduled-tasks` tools. The one rule that decides whether the routine works:

**Each run starts with no memory of the conversation that created it.** The prompt
must carry everything — the guild id, the project path, how to reach Classifer, what
to look at, what to produce, and where to put it. A prompt that says "check the
server like we discussed" produces a run that does not know what was discussed.

Include the fallback path. Classifer tools reach a scheduled run only if the plugin
is installed for that session; the CLI bridge always works:

```
cd "C:\Users\kuroi\OneDrive\Desktop\Cognition" && node --disable-warning=ExperimentalWarning scripts/call.js <tool> '<json>'
```

State plainly in the prompt that the routine must not delete anything. There is no
human present to read a `destructive_plan` preview, so there can be no consent, so
there can be no deletion. A routine that finds something that ought to go should say
so in its report and leave it standing.

`cognition-daily-review` on this machine is the working example — read its
`SKILL.md` before writing another.

## Do not use CronCreate

It exists and it looks like the right tool. It is session-only: the job dies when the
session ends and expires after seven days regardless. For anything meant to outlive
the conversation, use `scheduled-tasks` or a bot-side schedule.

## Say which tier you chose

When you schedule something, tell kuroi which tier it landed in and what that means
for reliability — "bot-side, so it runs with the app closed as long as the bot is
up" or "Claude routine, so it needs the app open; it will run late otherwise". That
one line prevents the failure where something silently did not happen.

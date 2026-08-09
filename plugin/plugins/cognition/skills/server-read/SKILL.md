---
name: server-read
description: Read the live state of the Cognition Discord server before changing it, and know what the read cannot tell you. Use at the start of any turn that will alter structure, and whenever a report about the server is wanted. Every other Cognition skill reasons from this output. Reads only — changes nothing. Triggers on: وش فيه بالسيرفر، اعرض الرومات، حالة السيرفر، شنو الجلسات، اقرأ السجل، status, what is on the server.
---

# What the server looks like right now

Every other skill here asks a question whose answer expires. Whether a channel can
be renamed, whether a session is ready to promote, whether a schedule is firing —
all of them depend on state that moves between your turns, and an answer from
earlier in the conversation is a guess wearing an id's clothes.

So this runs first, and its output is what the rest reason from.

`guild_snapshot` answers most of it in one call: every category, channel and role,
with lifecycle tags already resolved. Reach for the narrower tools when you know
what you want — `find_by_name` to turn one name into one id, `channels_list` to
filter, `session_status` for the experiment view, `audit_tail` for history.

## Read in this order

1. **Structure.** Categories, their channels, and the lifecycle tag on each. A name
   carrying `[TEST]` is provisional; `[ARCHIVED]` is locked and finished; neither is
   a comment, both are the actual state machine. Nothing is filed by position, so
   position tells you nothing about status.

2. **Sessions.** `session_status` with no argument lists them. `building` and
   `testing` are open and someone is presumably mid-experiment; `promoted` means it
   graduated in place; `archived` means locked; `closed` means abandoned. A session
   row can disagree with Discord — see below.

3. **Registry.** `registry_list` shows what behaviour exists. A component pointing
   at a missing action is a dead button, and it is worth catching here rather than
   when someone presses it.

4. **Schedules.** `schedule_list` gives cron, next fire, last fire and last status.
   A schedule that has never run despite being enabled is usually an invalid cron or
   a stopped bot.

5. **Audit.** `audit_tail` is the full record — every Classifer call, every button
   press, every scheduled run. `#command-log` shows only the changes, because a
   channel that also logged every read would bury them.

## What this read cannot tell you

Say these plainly rather than reporting around them.

- **Whether the bot is running.** Classifer talks to Discord over REST and needs no
  gateway, so every tool here works perfectly with the Cognition process stopped.
  The symptom of a stopped bot is that buttons do nothing and schedules never fire,
  while these tools stay green. `system_status` says this out loud rather than
  guessing. If you need to know, check for a recent `dispatcher` or `scheduler` row
  in `audit_tail` — that is evidence the process was alive at that moment, and it is
  the only evidence available from here.

- **Whether a session row still matches Discord.** The Registry records what was
  built; someone with Manage Channels can rename or delete any of it by hand. A
  session listing a channel that `guild_snapshot` does not show has been edited
  outside the system. `session_status` marks those `MISSING from the server`.
  Report it as a discrepancy, not as a missing channel — the difference is whether
  something is broken or somebody simply tidied up.

- **Message history depth.** `messages_read` returns at most 100 and does not tell
  you how many more there are. "The last 20 messages" is never "the conversation".

- **Who can actually see a channel.** Overwrites are readable, but effective
  permission is overwrites composed with role permissions and role order, and
  Administrator overrides all of it. If the question is "can this person see it",
  the honest answer usually requires asking them, or testing with a real account.

- **Anything about members who have never spoken.** `members_search` is a prefix
  search over the member list. It is not a directory of everyone who might join.

## Reporting it

Lead with whatever needs a decision, then state, then detail. Write it the way
someone who just looked would say it.

> "Two sessions open. Tickets is still [TEST] with nothing logged since Tuesday —
> it either wants promoting or archiving. The daily_marker schedule has never fired
> even though it is enabled, which means the bot has not been up at midnight."

Not a dump of the snapshot. You read it so kuroi does not have to.

Use the server's own names for things, and give the id alongside any name you expect
to be acted on — names are ambiguous and ids are not.

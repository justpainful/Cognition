---
name: run-session
description: Run an experiment on the Cognition server through its lifecycle — start it in the Sandbox under a [TEST] tag, test it, then promote it in place or archive it. Use when beginning any new system, when deciding whether something provisional has earned permanence, or when tidying up finished experiments. Triggers on: ابدأ جلسة، جلسة اختبار، رقّي النظام، أرشف، شيل التاق، خلص الاختبار، promote, archive, start a session.
---

# The lifecycle of an experiment

```
start ──▶ build ──▶ test ──▶  promote   (drop [TEST], stays where it is)
                              archive   (add [ARCHIVED], lock it, stays where it is)
                              close     (abandoned, nothing on Discord changes)
```

Nothing moves between categories, ever. Promotion and archiving are name changes and
permission changes applied where the thing already stands. That is a deliberate
constraint and it buys something real: ids stay valid, message history stays intact,
and every link anyone pasted into a conversation still resolves. A system that files
things into an "Archive" category breaks all three the moment it tidies up.

## Starting

`session_start` takes the system name and the channels it needs. It creates the
`[TEST]`-tagged category, the channels inside it, the Registry session row, and a
tracking thread in `#active-sessions`.

Give the name without a tag — `"Tickets"`, not `"Tickets [TEST]"`. The tag is the
system's to apply and to remove, and a hand-typed one will not round-trip.

Record a `purpose`. In three weeks the question will be "what was this for" and the
thread will be the only place that answers.

## Deciding

There are three honest outcomes and no obligation to reach one quickly.

**Promote** when the system does what it was built to do and someone would miss it
if it vanished. `session_promote` strips `[TEST]` from the category and its channels
and nothing else happens — same ids, same history, same position. It is a small
change on purpose.

**Archive** when the experiment answered its question and the answer was no, or when
it worked and is simply finished. `session_archive` adds `[ARCHIVED]`, denies
`ViewChannel` and `SendMessages` to `@everyone`, and leaves everything standing.
Nothing is deleted. The channels stay readable to anyone whose roles override the
deny, which is what makes archiving different from hiding.

**Leave it open** when it is genuinely still under test. A session sitting in
`testing` for a week is not a problem; a session sitting in `testing` for a month
with no audit activity is a decision nobody made. Say so rather than letting it sit.

**Deleting** is none of the above and is rarely right. An archived category costs
nothing and holds the record of what was tried. If deletion really is wanted, it
goes through `danger` like everything else irreversible.

## Both snapshot first

`session_promote` and `session_archive` each take a category snapshot before
touching anything, and report the id. `snapshot_restore <id>` puts names and
overwrites back exactly, which means archiving is genuinely reversible — un-archiving
is a restore, not a rebuild.

## Reading a session

`session_status` with an id gives the channels, the components, and whether the
Registry still agrees with Discord. `MISSING from the server` against a channel means
someone deleted or renamed it by hand. That is information about what happened, not
an error to fix silently — report it.

## The tracking thread

Each session gets a thread in `#active-sessions`, and promote and archive post into
it automatically. It is the human-readable history of one experiment. When you make
a judgement call mid-session — changed the permission model, dropped a button that
was not earning its place — post it there with `message_send` to the thread id. The
audit trail records what changed; the thread is where why lives.

---
name: build-system
description: Build a working system in the Cognition server — tickets, applications, voting, verification, role menus, anything with buttons — by composing Registry primitives instead of writing code. Use whenever something new is wanted on the server, or an existing system needs to behave differently. Triggers on: ابنِ نظام، سوّ بوت تذاكر، أضف زر، اعمل بانل، غيّر سلوك الزر، نظام تصويت، نظام تقديم، build a ticket bot, add a button, make a panel.
---

# Building without writing code

The bot contains no feature code and must not acquire any. What a button does is a
row in the Registry, read fresh on every single press. That is why a system can be
built, changed and rebuilt while the bot keeps running, and why "add a second
button" costs one tool call rather than an edit and a restart.

Read `registry_vocabulary` before composing anything. Guessing a parameter name
produces an action that stores perfectly and fails at click time, in front of
whoever pressed it.

## The method

**1. Say what the system does, in one sentence, before touching anything.**
"Anyone can open a private ticket; only Operators can close it." That sentence
determines the actions, the permissions and the `requires` clauses. If you cannot
write it, you do not yet know what you are building.

**2. Start a session.** `session_start` with the channels it needs. Everything you
build lives under a `[TEST]` category until it earns its place. See `run-session`.

**3. Write the actions.** One `registry_put` per thing the system can do. Compose
with `sequence` for several steps, `branch` for a decision, and `then` for "after
this succeeds, using what it just created".

**4. Publish the panel.** `panel_publish` writes the component rows and posts the
message in one call. It refuses if a button points at an action that does not exist,
so a half-wired panel never reaches the channel.

**5. Test it before anyone else does.**
`node scripts/simulate-click.js <component_key> <user_id> '[args]'` runs the real
row through the real templates and makes the real REST calls, as a real member with
their real roles. It is the same code path the Dispatcher takes. Use it to prove
both directions of a `requires` clause: once as someone who should be blocked, once
as someone who should pass.

**6. Then have a person press it.** Simulation covers everything except the gateway
itself. One real click is worth doing before declaring it finished.

## Templates are what make one row serve everyone

A stored action is a shape, not an instance. `ticket-{{user.name}}` is one row that
produces a different channel per presser. The scope available is in
`registry_vocabulary`; the ones that carry most of the weight:

- `{{user.id}}` `{{user.name}}` `{{user.mention}}` — the presser
- `{{channel.id}}` — where they pressed
- `{{created.id}}` — inside a `then`, the thing that was just made
- `{{arg.0}}` — a per-click value carried in the custom_id

An unknown placeholder is deliberately left standing rather than blanked, so
`ticket-{{user.nmae}}` shows up in Discord as a visible typo instead of a silent
`ticket-`.

## Per-click args: one row, unlimited instances

This is the pattern worth internalising, because the obvious alternative scales
badly.

A close button inside every ticket channel needs to know which channel to close.
Minting a fresh component row per ticket would work and would leave the Registry
carrying one dead row per ticket ever opened. Instead, mint **one** component and
pass the channel as an arg at post time:

```
panel_send params:
  channel_id: "{{created.id}}"
  buttons: [{ label: "Close ticket", component_key: "ticketclose", args: ["{{created.id}}"] }]
```

The custom_id becomes `c1|ticketclose|<that channel id>`, and the close action reads
`{{arg.0}}`. One row, every ticket, forever. Discord caps custom_id at 100
characters, which is exactly why the row holds the configuration and the id holds
only what changes.

## Permissions

Private-to-one-person is a deny for `@everyone` plus an allow for the member. The
guild id is `@everyone`'s role id — that is not a trick, it is how Discord models
it. Valid permission names come from `permissions_vocabulary`; an invented name is
rejected at write time rather than at click time, which is the one place guessing is
cheap.

Gate by role with a `requires` clause, not by hiding the button. A hidden button is
still pressable by anyone who finds the message.

## Changing a live system

`registry_put` on an existing key rewrites it, and the next press does the new thing.
The panel does not need reposting and the bot does not need restarting — the
Dispatcher holds no cache, so there is nothing to invalidate.

That applies to **rows**. It does not apply to the **engine**. Node caches modules at
import, so a running bot keeps executing the code it started with: if you add a new
action kind or change the executor, the live bot will reject it as an unknown kind
until it is restarted. `system_status` reports `bot engine STALE` when the build the
bot recorded at startup no longer matches disk — check it before concluding a
Registry row is wrong.

`simulate-click` will not reproduce this, because it starts a fresh process and
always loads the newest engine. If simulation passes and a real click fails with an
unknown kind, that gap is the answer.

To change what an already-posted button points at without touching its action, use
`registry_component_put` to repoint the component.

Deleting an action that a live button still points at leaves that button answering
"this control is no longer defined" — which is the correct behaviour, and worth
knowing before you delete one.

## Worked example: the ticket system on this server

Two actions and two components, no code:

- `ticket_open` — `channel_create` named `ticket-{{user.name}}`, parented to the
  session category, with overwrites denying `@everyone` and allowing the presser and
  `@Operator`. Its `then` is a `sequence`: `panel_send` a Close button into the new
  channel carrying `{{created.id}}` as an arg, `message_send` an embed to the log
  channel, `reply` to the presser with a link.
- `ticket_close` — a `sequence` gated on `requires: has_role Operator`:
  `channel_edit` with `name_prefix: "closed-"`, `message_send` to the log, `reply`.

Read the live rows with `registry_get key=ticket_open`. Copy the shape rather than
the ids.

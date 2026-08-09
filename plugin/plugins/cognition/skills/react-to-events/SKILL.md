---
name: react-to-events
description: Make the Cognition server react to things that are not button presses — someone joining, a keyword being posted, a reaction landing, a channel being deleted by hand. Use when something should happen automatically in response to an event rather than a click or a clock. Triggers on: لما أحد يدخل، رحّب بالأعضاء، لما يكتب كلمة، رد تلقائي، تفاعل، إيفنت، حدث، اربط حدث، welcome new members, autoresponder, on join, when someone posts.
---

# Reacting to what happens

Three things can cause an action to run. A button press goes through the
Dispatcher, a cron expression goes through the Scheduler, and a gateway event
goes through a trigger. All three read the same Registry and share the same
executor, so the same action behaves identically whichever one fired it.

`trigger_events` lists what can be listened for and which filter keys each event
supports. Read it before writing a trigger: a filter key an event never supplies
is rejected at write time rather than silently never matching, and knowing which
keys exist saves the guess.

## Writing one

An action first, then the trigger that points at it:

```
registry_put    key=welcome kind=dm_send params={content: "أهلًا {{user.name}}"}
trigger_create  key=on_join event=member_join action_key=welcome
```

The bot picks it up on the next event. No restart, same as components.

Filters narrow when it fires. `{contains: "cognition"}` on `message_create`, or
`{channel_id: "..."}` to confine it to one channel, or `{has_role: "..."}` to
respond only to certain people.

## A trigger has nobody to answer

This is the mistake to expect. An event is not an interaction, so there is no
one waiting on a reply and `reply` does nothing. `trigger_create` rejects
`reply` and `modal_open` outright for that reason. Use `message_send` to post
into a channel, or `dm_send` to write to the person.

`dm_send` treats closed DMs as a setting rather than a fault: it reports and
carries on. A welcome flow that dies because one member does not accept server
messages is worse than one that misses them.

## The loop, and why it cannot happen by accident

An action that posts a message, fired by a trigger on messages, posts a message
that fires the trigger. At gateway speed that is a few thousand messages before
the rate limiter notices.

Two things prevent it. Messages authored by Cognition never fire a trigger, no
matter what any filter says, and that one is not overridable. Separately, other
bots are excluded unless `from_bot: true` is set, so including them is a
deliberate act rather than a default.

Still worth thinking about when a trigger's action causes the same event class
in a different way: a `member_join` trigger that grants a role fires
`guildMemberUpdate`, not `guildMemberAdd`, so it terminates. Check the shape
before assuming.

## Testing without waiting

`trigger_test` takes a made-up payload and reports whether the filter matches and
why. Pass `execute_for_real` to run the action too.

```
trigger_test key=on_keyword payload={content: "does Cognition see this", userId: "..."}
```

Test both directions. A filter that matches everything looks identical to a
correct one until the day it fires on something it should not have.

## What events are good for here

- **Drift alarms.** `channel_delete` fires for deletions made by hand in the
  client, which is the only way to notice that someone removed a session's
  channel outside the system. Pair it with `drift_check`.
- **Onboarding.** `member_join` into a role grant, a DM, an introduction post.
- **Keyword handling.** `message_create` with `contains` or `starts_with`, for
  acknowledgement, routing, or a rough command prefix.
- **Reaction roles.** `reaction_add` filtered by `emoji` into `role_grant`.

## Counters

Events often need to number things. `counter_bump` increments a persistent
counter and binds `{{counter.value}}` inside its `then`, with `pad` for
zero-padding:

```
{kind: "counter_bump", params: {key: "tickets", pad: 4,
  then: {kind: "channel_create", params: {name: "ticket-{{counter.value}}"}}}}
```

That gives `ticket-0007`. Naming things after the user works until two people
share a name; naming them after a counter does not have that problem.

Counters are readable and settable with the `counters` tool, which matters when
importing a system into a server where numbering should continue rather than
restart.

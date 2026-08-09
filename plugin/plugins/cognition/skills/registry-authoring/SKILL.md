---
name: registry-authoring
description: The grammar of the Cognition Registry — every action kind and its parameters, every predicate, every template variable, and the mistakes that store cleanly and fail at click time. Use as reference while composing or debugging any action, component or schedule. Triggers on: وش الأنواع المتاحة، parameters، الزر ما يشتغل، خطأ بالأكشن، صيغة الأكشن، action kinds, predicates, why does my button fail.
---

# The grammar

`registry_vocabulary` returns the authoritative list from the running server, and it
is the one to trust when this file and the tool disagree — the tool is generated
from the code. This skill is for the parts the reference cannot tell you: which
mistakes are cheap, which are expensive, and why.

## Shape

An action is `{key, kind, params, requires, confirm}`.

- `key` is stable and is what components and schedules point at. Rewriting a key
  changes every button already bound to it, which is a feature.
- `params` are kind-specific and every string in them is a template.
- `requires` is a predicate checked before the action runs — **and before each
  nested action runs**, so composing something does not get you past a restriction
  placed on it.
- `confirm` forces the two-step path. It is forced on for `channel_delete`
  regardless of what you pass, and an action carrying it will not run from a click
  at all.

## Composition

Three ways to combine, and they are not interchangeable:

- **`sequence`** — `params.steps` is a list, run in order. Each step may be a
  Registry key or an inline `{kind, params}`. If one throws, the rest do not run.
- **`branch`** — `params.if` is a predicate, `params.then` and `params.else` are
  actions.
- **`then`** — a field on creating actions (`channel_create`, `thread_create`), run
  after success with `{{created.id}}` and `{{created.name}}` bound. This is the only
  way to act on something you just made.

Nesting is capped at 8 deep, which catches a sequence that references itself.

## Templates

Every string parameter is rendered. Available:

```
{{user.id}} {{user.name}} {{user.mention}} {{user.display}}
{{channel.id}} {{channel.name}} {{channel.mention}}
{{created.id}} {{created.name}} {{created.mention}}     only inside a "then"
{{arg.0}} {{arg.1}}                                     per-click, from the custom_id
{{field.<key>}}                                         modal submission values
{{session.id}} {{session.name}} {{session.state}}
{{guild.id}} {{now}} {{today}} {{timestamp}}
```

An unresolvable placeholder is **left standing**, not blanked. If a channel appears
in Discord named `ticket-{{user.nmae}}`, that is the system showing you a typo
rather than hiding it behind an empty string. Treat a visible `{{...}}` as a bug
report.

`{{created.*}}` outside a `then` resolves to nothing and stays literal — that is the
most common way an otherwise correct action produces a strange name.

## Predicates

```
{"type":"always"}                                   {"type":"never"}
{"type":"has_role","role_id":"..."}
{"type":"is_guild_owner"}
{"type":"in_channel","channel_id":"..."}
{"type":"channel_exists","name":"..."}              {"type":"channel_absent","name":"..."}
{"type":"session_state","session_id":1,"state":"testing"}
{"type":"not","of":{...}}
{"type":"all","of":[...]}                           {"type":"any","of":[...]}
```

They fail closed. An unknown type, or a context missing what the predicate needs,
evaluates false with a reason — and that reason is shown to whoever pressed the
button, so it is worth reading it back to yourself once. `has_role` with a role id
that no longer exists blocks everyone silently-but-explainably, which is what makes
deleting a role expensive.

## Mistakes that store cleanly and fail at click time

`registry_put` validates the kind and that referenced actions exist. It does not and
cannot validate that your parameters make sense for that kind. These get through:

- **A misspelled parameter name.** `channel` instead of `channel_id` stores fine and
  throws "needs a channel_id" on press.
- **An invented permission name.** Caught at write time by `permBits`, which is the
  one place guessing is cheap — it throws immediately rather than storing.
- **A `reply` in a scheduled action.** `schedule_create` rejects `reply` and
  `modal_open` outright, because a scheduled run has nobody to answer.
- **A `{{created.id}}` outside a `then`.** Renders literally.
- **An arg that pushes custom_id past 100 characters.** `encode` throws at publish
  time with the length, rather than letting Discord reject the message.
- **A component pointing at a deleted action.** The button answers "this control
  points at an action which no longer exists" — deliberate, so a dead button is
  diagnosable rather than merely broken.

The cure for all of them is the same and takes ten seconds:
`node scripts/simulate-click.js <component_key> <user_id> '[args]'`.

## Per-click args

The custom_id is `c1|<component key>|<arg0>|<arg1>`, capped by Discord at 100
characters. The key resolves to a row holding all fixed configuration; args carry
only what is not knowable until the click.

Use them when one stored row must serve many instances — a close button in every
ticket channel, a select menu whose chosen values arrive as args. Do not use them
for configuration that never varies; that belongs in the row, where it is editable
without reposting anything.

Select menus append their chosen values to the args, after anything baked in at
publish time.

## Debugging a button that does not work

1. `panel_components` — does the component exist and point somewhere real?
2. `registry_get key=<action> kind=action` — read the actual stored row, not the one
   you meant to write.
3. `simulate-click` — run it as the person who reported the problem, with their real
   roles. The `requires` verdict prints first.
4. `audit_tail source=dispatcher result=error` — every failed press with its reason.
5. If all of that is clean and the button still does nothing in Discord, the bot
   process is down. Classifer keeps working when it is, which is exactly why the
   symptom is confusing.

---
name: danger
description: The protocol for anything irreversible on the Cognition server — deleting a channel, category or role, or any operation that destroys data. Snapshot, preview, human yes, then apply. Use before any deletion, and read it before agreeing that something should be removed. Triggers on: احذف، امسح، شيل الروم، احذف الرول، دمّر، ابدأ من جديد، نظّف السيرفر، delete, remove, wipe, clean up.
---

# Before anything gets destroyed

Almost everything on this server is reversible. Names, topics, positions, parents,
permission overwrites, role colours and role permissions are all just fields, and
every structural tool snapshots before it writes — so undo is `snapshot_restore`
and it genuinely restores.

Deletion is the exception, and it is not a small one. A deleted channel can be
rebuilt from its snapshot with identical settings, and it comes back with a **new
id** and an **empty history**. Every message is gone. Every link anyone posted to
the old channel is dead. That is not an undo, and it must never be described as one.

## The protocol

**1. `destructive_plan`.** Takes a snapshot, reads the live state, and returns a
written preview plus a token good for ten minutes. Nothing is destroyed by this
call. The preview is generated from what is actually there right now — the last few
messages that will be lost, the channels a category holds, how many members hold a
role — not from anyone's memory of it.

**2. Show the preview to kuroi.** Not a summary of it. The preview exists so that
the thing being agreed to is stated in the system's own words, and a paraphrase
defeats that. Paste it and ask.

**3. Wait for an actual yes.** Ambiguity is a no. Silence is a no. "yeah whatever"
about a category of eleven channels is worth one more question.

**4. `destructive_apply` with the token.** Single-use, expiring, and bound to a hash
of the exact parameters. Change the id between plan and apply and it refuses — which
means consent given for one deletion can never be spent on a different one.

## What is not consent

- **A general instruction.** "Delete anything you think is junk" authorises you to
  *plan* deletions and show them. It does not authorise any particular one.
- **An earlier yes.** Tokens are single-use because approval is per-operation.
- **Asking for it directly.** "احذف روم x" starts the protocol, it does not skip it.
  The yes comes after the preview, because the preview is the first moment either of
  you sees precisely what is inside.
- **Your own confidence.** Being certain it is fine is exactly the state in which
  people delete the wrong thing.
- **A scheduled run.** No human is present, so there is no consent available. A
  routine that finds something that should go reports it and leaves it.

## Reach for these first

Deletion is usually the wrong tool for what is actually wanted.

- Finished with a system → `session_archive`. Renames and locks it in place, deletes
  nothing, fully reversible.
- Channel is in the way → rename it, move it, or deny `ViewChannel`. All reversible.
- Registry entry is wrong → `registry_put` over it. No deletion involved.
- Role is obsolete → strip its permissions and rename it `retired-…`. Deleting it
  breaks every `requires` clause that names its id, and those clauses then fail
  closed, so the controls they guard refuse everyone.

Suggest the reversible option before running the plan. Often that ends the matter.

## When it has been done

Say what happened without softening it, and give the snapshot id:

> "Deleted #ticket-old (1536…). Snapshot 14 holds its settings —
> `snapshot_recreate_channel 14` rebuilds it with a new id, but the 200-odd
> messages are gone for good."

`destructive_pending` lists plans that were previewed and never applied. Worth
checking if a conversation about a deletion trailed off — an unapplied plan means
nothing was destroyed, which is usually the right outcome and worth confirming out
loud.

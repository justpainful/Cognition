// Snapshots, restores, and the gate in front of anything irreversible.
//
// The two-step shape is not bureaucracy. destructive_plan produces a written
// description of what is about to be lost, in the system's own words, from the
// live state — not from what anyone remembers being there. That preview is the
// thing a human agrees to. destructive_apply will only accept a token issued for
// exactly those parameters, so consent given for one deletion cannot be spent on
// a different one.

import { tool, z, table } from '../kit.js';
import {
  del,
  get,
  post,
  fetchChannels,
  fetchRoles,
  fetchChannel,
  guildRoute,
  CHANNEL_TYPE_NAME,
} from '../../../shared/rest.js';
import { GUILD_ID } from '../../../shared/env.js';
import {
  snapshotChannel,
  snapshotCategory,
  snapshotRole,
  snapshotGuild,
  listSnapshots,
  getSnapshot,
  restore,
  recreateChannel,
} from '../../../shared/snapshot.js';
import { plan, redeem, listPending, isGated, TTL_MINUTES } from '../../../shared/guard.js';

tool({
  name: 'snapshot_take',
  title: 'Capture current state',
  description:
    'Record the current state of a channel, category, role, or the whole guild structure, so it can be written back later. Structural tools take their own snapshots automatically — use this before a run of several changes you may want to undo as a group.',
  mutating: true,
  schema: {
    kind: z.enum(['channel', 'category', 'role', 'guild']),
    id: z.string().optional().describe('required for channel, category and role'),
    label: z.string().optional(),
  },
  async run({ kind, id, label }) {
    if (kind !== 'guild' && !id) throw new Error(`snapshot_take of a ${kind} needs an id.`);
    let snapshotId;
    if (kind === 'channel') snapshotId = await snapshotChannel(id, label);
    else if (kind === 'category') snapshotId = await snapshotCategory(id, label);
    else if (kind === 'role') snapshotId = await snapshotRole(id, label);
    else snapshotId = await snapshotGuild(label ?? 'manual guild snapshot');

    return { target: id ?? GUILD_ID, snapshotId, text: `Snapshot ${snapshotId} taken (${kind}).` };
  },
});

tool({
  name: 'snapshot_list',
  title: 'List snapshots',
  description: 'Recent snapshots, newest first, with what each one covers.',
  schema: { limit: z.number().int().min(1).max(200).default(25).optional() },
  async run({ limit = 25 }) {
    const rows = listSnapshots(limit);
    if (!rows.length) return '(no snapshots yet)';
    return table(rows, [
      { header: 'id', get: (s) => s.id },
      { header: 'at', get: (s) => s.at.replace('T', ' ').slice(0, 19) },
      { header: 'kind', get: (s) => s.kind },
      { header: 'target', get: (s) => s.targetId ?? '' },
      { header: 'label', get: (s) => s.label ?? '' },
      { header: 'restored', get: (s) => (s.restoredAt ? 'yes' : '') },
    ]);
  },
});

tool({
  name: 'snapshot_restore',
  title: 'Write a snapshot back',
  description:
    'Restore names, topics, positions, parents and permission overwrites from a snapshot. Targets that no longer exist are reported rather than recreated, because recreating would produce a new id and every stored reference to the old one would still be broken.',
  mutating: true,
  schema: {
    snapshot_id: z.number().int(),
    reason: z.string().optional(),
  },
  async run({ snapshot_id, reason }) {
    const snap = getSnapshot(snapshot_id);
    if (!snap) throw new Error(`No snapshot ${snapshot_id}.`);
    const result = await restore(snapshot_id, { reason: reason ?? 'Classifer: snapshot_restore' });
    return {
      target: snap.targetId ?? GUILD_ID,
      snapshotId: snapshot_id,
      text: [
        `Restored snapshot ${snapshot_id} (${snap.kind}, taken ${snap.at}).`,
        result.applied.length ? `\nApplied:\n${result.applied.map((a) => `  ${a}`).join('\n')}` : '\nNothing to apply.',
        result.missing.length ? `\nCould not apply:\n${result.missing.map((m) => `  ${m}`).join('\n')}` : '',
      ].join('\n'),
    };
  },
});

tool({
  name: 'snapshot_recreate_channel',
  title: 'Rebuild a deleted channel',
  description:
    'Recreate a channel from its snapshot: same name, topic, parent, position and overwrites. It gets a NEW id and an EMPTY history. This is a rebuild, not an undo, and should be described that way to whoever asked for it.',
  mutating: true,
  schema: { snapshot_id: z.number().int() },
  async run({ snapshot_id }) {
    const result = await recreateChannel(snapshot_id);
    return {
      target: result.newId,
      snapshotId: snapshot_id,
      text: [
        `Rebuilt channel from snapshot ${snapshot_id}.`,
        `  old id  ${result.oldId}`,
        `  new id  ${result.newId}`,
        '',
        'Settings are identical. The message history is gone — it was not recoverable.',
      ].join('\n'),
    };
  },
});

// ---- the gate -------------------------------------------------------------

async function previewChannelDelete(channelId) {
  const ch = await fetchChannel(channelId);
  const isCategory = ch.type === 4;
  const lines = [];

  if (isCategory) {
    const all = await fetchChannels();
    const kids = all.filter((c) => c.parent_id === channelId);
    lines.push(`DELETE CATEGORY "${ch.name}"  (${channelId})`);
    lines.push('');
    if (kids.length) {
      lines.push(`It contains ${kids.length} channel(s). Deleting the category does NOT delete them —`);
      lines.push('they become uncategorised and stay where they are:');
      for (const k of kids) lines.push(`    #${k.name}  ${k.id}`);
    } else {
      lines.push('It is empty.');
    }
  } else {
    lines.push(`DELETE CHANNEL #${ch.name}  (${channelId}, ${CHANNEL_TYPE_NAME[ch.type] ?? ch.type})`);
    lines.push('');
    let recent = [];
    try {
      recent = await get(`/channels/${channelId}/messages`, { query: { limit: 5 } });
    } catch {
      /* a voice or forum channel has no readable message list */
    }
    if (recent.length) {
      lines.push(`Its message history will be permanently lost. The last ${recent.length}:`);
      for (const m of recent.slice(0, 5)) {
        const body = (m.content || '[embed or attachment]').replace(/\s+/g, ' ').slice(0, 80);
        lines.push(`    ${m.author?.username ?? '?'}: ${body}`);
      }
    } else {
      lines.push('It appears to have no messages.');
    }
  }

  lines.push('');
  lines.push('A snapshot of its settings is being taken, so the channel can be REBUILT afterwards —');
  lines.push('but a rebuild gives a new id and an empty history. Messages cannot be recovered.');
  return { preview: lines.join('\n'), name: ch.name, isCategory };
}

async function previewRoleDelete(roleId) {
  const roles = await fetchRoles();
  const role = roles.find((r) => r.id === String(roleId));
  if (!role) throw new Error(`No role ${roleId} in this guild.`);
  if (role.managed) {
    throw new Error(`@${role.name} is a managed role (owned by an integration). Discord will not let anything delete it.`);
  }

  let holders = 0;
  try {
    const members = await get(guildRoute('/members'), { query: { limit: 1000 } });
    holders = members.filter((m) => m.roles.includes(String(roleId))).length;
  } catch {
    holders = -1;
  }

  return {
    preview: [
      `DELETE ROLE @${role.name}  (${roleId})`,
      '',
      holders >= 0
        ? `${holders} member(s) currently hold it and will lose it.`
        : 'Could not count holders — the members list was not readable.',
      '',
      'Any Registry requires clause naming this role id will start failing closed,',
      'which means the controls it guards will refuse everyone until they are repointed.',
      '',
      'The role definition is snapshotted, but a recreated role gets a new id.',
    ].join('\n'),
    name: role.name,
  };
}

tool({
  name: 'destructive_plan',
  title: 'Preview something irreversible',
  description:
    `Step one of two for anything that cannot be undone. Takes a snapshot, reads the live state, and returns a written preview plus a token valid for ${TTL_MINUTES} minutes. Show the preview to the human and get a real yes before calling destructive_apply. Nothing is destroyed by this call.`,
  mutating: true,
  schema: {
    op: z.enum(['channel_delete', 'category_delete', 'role_delete']),
    id: z.string().describe('the channel, category or role id'),
    reason: z.string().optional(),
  },
  async run({ op, id, reason }) {
    let preview;
    let snapshotId;

    if (op === 'channel_delete' || op === 'category_delete') {
      const info = await previewChannelDelete(id);
      if (op === 'category_delete' && !info.isCategory) {
        throw new Error(`${id} is a channel, not a category. Use op "channel_delete".`);
      }
      if (op === 'channel_delete' && info.isCategory) {
        throw new Error(`${id} is a category, not a channel. Use op "category_delete".`);
      }
      preview = info.preview;
      snapshotId = info.isCategory ? await snapshotCategory(id, `before ${op}`) : await snapshotChannel(id, `before ${op}`);
    } else {
      const info = await previewRoleDelete(id);
      preview = info.preview;
      snapshotId = await snapshotRole(id, `before ${op}`);
    }

    const params = { id: String(id), reason: reason ?? null };
    const pending = plan({ op, params, preview, snapshotId });

    return {
      target: id,
      snapshotId,
      result: 'plan',
      text: [
        preview,
        '',
        '─'.repeat(60),
        `snapshot ${snapshotId} · token ${pending.token}`,
        `expires  ${pending.expiresAt}`,
        '',
        'NOTHING HAS BEEN DELETED. Show this preview to the user, get an explicit yes,',
        'and only then call destructive_apply with this token.',
      ].join('\n'),
    };
  },
});

tool({
  name: 'destructive_apply',
  title: 'Carry out a confirmed deletion',
  description:
    'Step two of two. Only call this after a human has read the destructive_plan preview and said yes. The token is single-use, expires, and is bound to the exact parameters it was issued for.',
  mutating: true,
  schema: {
    token: z.string(),
    id: z.string().describe('must match the id from the plan'),
    op: z.enum(['channel_delete', 'category_delete', 'role_delete']),
    reason: z.string().optional(),
  },
  async run({ token, id, op, reason }) {
    const claim = redeem(token, { op, params: { id: String(id), reason: reason ?? null } });

    if (op === 'role_delete') {
      await del(guildRoute(`/roles/${id}`), { reason: reason ?? 'Classifer: destructive_apply' });
    } else {
      await del(`/channels/${id}`, { reason: reason ?? 'Classifer: destructive_apply' });
    }

    return {
      target: id,
      snapshotId: claim.snapshotId,
      text: [
        `${op} carried out on ${id}.`,
        claim.snapshotId ? `Snapshot ${claim.snapshotId} holds its settings.` : '',
        op === 'channel_delete'
          ? `snapshot_recreate_channel ${claim.snapshotId} rebuilds it — new id, empty history.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});

tool({
  name: 'destructive_pending',
  title: 'Outstanding confirmations',
  description: 'Destructive plans that have been previewed but not yet applied or expired.',
  schema: {},
  async run() {
    const rows = listPending();
    if (!rows.length) return 'Nothing awaiting confirmation.';
    return rows
      .map((p) => `${p.op}  ${JSON.stringify(p.params)}\n  expires ${p.expiresAt}\n  token   ${p.token}\n  ${p.preview.split('\n')[0]}`)
      .join('\n\n');
  },
});

// State capture, so that "undo" means something.
//
// What restores cleanly: names, topics, positions, parents, permission
// overwrites, role colours and permission bitfields. Those are all just fields,
// and writing the old value back is a genuine reversal.
//
// What does not: message history. Recreating a deleted channel gives you a
// channel with the same settings and an empty scrollback, and the preview shown
// before any delete says so in those words rather than promising a rollback it
// cannot perform.

import { all, one, run, nowIso, parseJson } from './store.js';
import { get, patch, post, fetchChannel, fetchChannels, fetchRoles, guildRoute } from './rest.js';

function save(kind, targetId, label, state) {
  const res = run(
    'INSERT INTO snapshot (at, kind, target_id, label, state) VALUES (?, ?, ?, ?, ?)',
    nowIso(),
    kind,
    targetId ? String(targetId) : null,
    label ?? null,
    JSON.stringify(state),
  );
  return Number(res.lastInsertRowid);
}

function rowToSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    targetId: row.target_id,
    label: row.label,
    state: parseJson(row.state, {}),
    restoredAt: row.restored_at ?? null,
  };
}

export function getSnapshot(id) {
  return rowToSnapshot(one('SELECT * FROM snapshot WHERE id = ?', id));
}

export function listSnapshots(limit = 25) {
  return all('SELECT * FROM snapshot ORDER BY id DESC LIMIT ?', Math.min(Number(limit) || 25, 200)).map(
    rowToSnapshot,
  );
}

// Fields worth restoring. Anything not listed is either immutable (id, type,
// guild_id) or derived, and writing it back would be rejected.
const CHANNEL_FIELDS = [
  'name',
  'topic',
  'position',
  'parent_id',
  'nsfw',
  'rate_limit_per_user',
  'bitrate',
  'user_limit',
  'default_auto_archive_duration',
  'permission_overwrites',
];

const ROLE_FIELDS = ['name', 'permissions', 'color', 'hoist', 'mentionable'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined && obj[f] !== null) out[f] = obj[f];
  return out;
}

export async function snapshotChannel(channelId, label = null) {
  const ch = await fetchChannel(channelId);
  return save('channel', channelId, label ?? `#${ch.name}`, {
    ...pick(ch, CHANNEL_FIELDS),
    _meta: { id: ch.id, type: ch.type, name: ch.name },
  });
}

export async function snapshotRole(roleId, label = null) {
  const roles = await fetchRoles();
  const role = roles.find((r) => r.id === String(roleId));
  if (!role) throw new Error(`No role ${roleId} in this guild`);
  return save('role', roleId, label ?? `@${role.name}`, {
    ...pick(role, ROLE_FIELDS),
    _meta: { id: role.id, name: role.name, position: role.position },
  });
}

/** A category plus every channel inside it — what a session occupies. */
export async function snapshotCategory(categoryId, label = null) {
  const channels = await fetchChannels();
  const category = channels.find((c) => c.id === String(categoryId));
  if (!category) throw new Error(`No category ${categoryId} in this guild`);
  const children = channels.filter((c) => c.parent_id === String(categoryId));
  return save('category', categoryId, label ?? category.name, {
    category: { ...pick(category, CHANNEL_FIELDS), _meta: { id: category.id, type: category.type } },
    children: children.map((c) => ({
      ...pick(c, CHANNEL_FIELDS),
      _meta: { id: c.id, type: c.type, name: c.name },
    })),
  });
}

/** Whole-guild structure. Cheap, and the thing to take before any wide change. */
export async function snapshotGuild(label = 'guild structure') {
  const [channels, roles] = await Promise.all([fetchChannels(), fetchRoles()]);
  return save('guild', null, label, {
    channels: channels.map((c) => ({ ...pick(c, CHANNEL_FIELDS), _meta: { id: c.id, type: c.type } })),
    roles: roles.map((r) => ({ ...pick(r, ROLE_FIELDS), _meta: { id: r.id, position: r.position } })),
  });
}

function markRestored(id) {
  run('UPDATE snapshot SET restored_at = ? WHERE id = ?', nowIso(), id);
}

/**
 * Write a snapshot's fields back. Targets that no longer exist are reported
 * rather than recreated — recreating silently would hand back a different id
 * and every stored reference to the old one would still be broken.
 */
export async function restore(snapshotId, { reason = 'snapshot restore' } = {}) {
  const snap = getSnapshot(snapshotId);
  if (!snap) throw new Error(`No snapshot ${snapshotId}`);

  const applied = [];
  const missing = [];

  const restoreChannel = async (state) => {
    const id = state._meta?.id;
    if (!id) return;
    const body = pick(state, CHANNEL_FIELDS);
    try {
      await patch(`/channels/${id}`, body, { reason });
      applied.push(`channel ${id} (${state._meta.name ?? ''})`);
    } catch (e) {
      if (e.status === 404) missing.push(`channel ${id} (${state._meta.name ?? ''}) no longer exists`);
      else throw e;
    }
  };

  if (snap.kind === 'channel') {
    await restoreChannel(snap.state);
  } else if (snap.kind === 'role') {
    const id = snap.state._meta?.id;
    try {
      await patch(guildRoute(`/roles/${id}`), pick(snap.state, ROLE_FIELDS), { reason });
      applied.push(`role ${id}`);
    } catch (e) {
      if (e.status === 404) missing.push(`role ${id} no longer exists`);
      else throw e;
    }
  } else if (snap.kind === 'category') {
    await restoreChannel({ ...snap.state.category, _meta: snap.state.category._meta });
    for (const child of snap.state.children) await restoreChannel(child);
  } else if (snap.kind === 'guild') {
    for (const c of snap.state.channels) await restoreChannel(c);
    for (const r of snap.state.roles) {
      const id = r._meta?.id;
      try {
        await patch(guildRoute(`/roles/${id}`), pick(r, ROLE_FIELDS), { reason });
        applied.push(`role ${id}`);
      } catch (e) {
        if (e.status !== 404) throw e;
        missing.push(`role ${id} no longer exists`);
      }
    }
  } else {
    throw new Error(`Cannot restore snapshot kind "${snap.kind}"`);
  }

  markRestored(snapshotId);
  return { snapshotId, kind: snap.kind, applied, missing };
}

/**
 * Recreate a deleted channel from its snapshot. A new id, an empty history —
 * callers must say both of those out loud rather than calling this "undo".
 */
export async function recreateChannel(snapshotId, { reason = 'recreate from snapshot' } = {}) {
  const snap = getSnapshot(snapshotId);
  if (!snap || snap.kind !== 'channel') throw new Error(`Snapshot ${snapshotId} is not a channel snapshot`);
  const s = snap.state;
  const created = await post(
    guildRoute('/channels'),
    {
      name: s.name,
      type: s._meta.type,
      topic: s.topic,
      parent_id: s.parent_id,
      position: s.position,
      nsfw: s.nsfw,
      rate_limit_per_user: s.rate_limit_per_user,
      permission_overwrites: s.permission_overwrites,
    },
    { reason },
  );
  return { newId: created.id, oldId: snap.targetId, historyLost: true };
}

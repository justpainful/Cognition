// Building and reshaping the server. Everything here is reversible, so nothing
// here is gated — a wrong name or a wrong permission is fixed by writing the
// right one back, and a snapshot is taken first so "the right one" is knowable.

import { tool, z } from '../kit.js';
import {
  post,
  patch,
  put,
  del,
  fetchChannels,
  fetchRoles,
  fetchGuild,
  guildRoute,
  CHANNEL_TYPE,
  CHANNEL_TYPE_NAME,
  permBits,
  PERMISSION,
} from '../../../shared/rest.js';
import { GUILD_ID } from '../../../shared/env.js';
import { tidySlug } from '../../../shared/naming.js';
import { snapshotChannel, snapshotRole } from '../../../shared/snapshot.js';

const PERM_NAMES = Object.keys(PERMISSION);
const permList = z.array(z.enum(PERM_NAMES));

const overwriteSchema = z.object({
  id: z.string().describe('role id or member id — use the guild id for @everyone'),
  type: z.enum(['role', 'member']).default('role'),
  allow: permList.default([]),
  deny: permList.default([]),
});

function buildOverwrites(list = []) {
  return list.map((o) => ({
    id: String(o.id),
    type: o.type === 'member' ? 1 : 0,
    allow: permBits(o.allow ?? []),
    deny: permBits(o.deny ?? []),
  }));
}

tool({
  name: 'category_create',
  title: 'Create a category',
  description:
    'Create a category. Names keep their spaces and case, so "Tickets [TEST]" stays exactly that. Returns the id you will parent channels to.',
  mutating: true,
  schema: {
    name: z.string(),
    position: z.number().int().optional(),
    overwrites: z.array(overwriteSchema).optional().describe('permission overwrites for the category'),
    reason: z.string().optional(),
  },
  async run({ name, position, overwrites, reason }) {
    const created = await post(
      guildRoute('/channels'),
      {
        name,
        type: CHANNEL_TYPE.category,
        position,
        permission_overwrites: overwrites ? buildOverwrites(overwrites) : undefined,
      },
      { reason: reason ?? 'Classifer: category_create' },
    );
    return { target: created.id, text: `Created category "${created.name}" — id ${created.id}` };
  },
});

tool({
  name: 'channel_create',
  title: 'Create a channel',
  description:
    'Create a channel inside a category. Text channel names are slugified by Discord (lowercase, dashes), which this does up front so the stored name matches what appears.',
  mutating: true,
  schema: {
    name: z.string(),
    type: z.enum(['text', 'voice', 'announcement', 'forum', 'stage']).default('text'),
    parent_id: z.string().optional().describe('category id'),
    topic: z.string().max(1024).optional(),
    position: z.number().int().optional(),
    overwrites: z.array(overwriteSchema).optional(),
    reason: z.string().optional(),
  },
  async run({ name, type = 'text', parent_id, topic, position, overwrites, reason }) {
    const isVoice = type === 'voice' || type === 'stage';
    const created = await post(
      guildRoute('/channels'),
      {
        name: isVoice ? name : tidySlug(name),
        type: CHANNEL_TYPE[type],
        parent_id,
        topic,
        position,
        permission_overwrites: overwrites ? buildOverwrites(overwrites) : undefined,
      },
      { reason: reason ?? 'Classifer: channel_create' },
    );
    return {
      target: created.id,
      text: `Created ${type} channel #${created.name} — id ${created.id}${parent_id ? ` (in ${parent_id})` : ''}`,
    };
  },
});

tool({
  name: 'channel_edit',
  title: 'Rename or reconfigure a channel',
  description:
    'Change a channel or category: name, topic, parent, slowmode. Takes a snapshot first, so channel_edit is always undoable via snapshot_restore. This is how promote and archive work — they only ever change the name.',
  mutating: true,
  schema: {
    channel_id: z.string(),
    name: z.string().optional(),
    topic: z.string().max(1024).optional(),
    parent_id: z.string().nullable().optional(),
    rate_limit_per_user: z.number().int().min(0).max(21600).optional(),
    position: z.number().int().optional(),
    reason: z.string().optional(),
  },
  async run({ channel_id, name, topic, parent_id, rate_limit_per_user, position, reason }) {
    const snapshotId = await snapshotChannel(channel_id, 'before channel_edit');

    const body = {};
    if (name !== undefined) body.name = name;
    if (topic !== undefined) body.topic = topic;
    if (parent_id !== undefined) body.parent_id = parent_id;
    if (rate_limit_per_user !== undefined) body.rate_limit_per_user = rate_limit_per_user;
    if (position !== undefined) body.position = position;
    if (!Object.keys(body).length) return 'Nothing to change — no fields given.';

    const updated = await patch(`/channels/${channel_id}`, body, {
      reason: reason ?? 'Classifer: channel_edit',
    });

    return {
      target: channel_id,
      snapshotId,
      text: `Updated ${CHANNEL_TYPE_NAME[updated.type] ?? ''} "${updated.name}" (${channel_id}).\nSnapshot ${snapshotId} taken first — snapshot_restore ${snapshotId} puts it back.`,
    };
  },
});

tool({
  name: 'channels_reorder',
  title: 'Reorder channels',
  description: 'Set positions for several channels at once. Positions are per-category.',
  mutating: true,
  schema: {
    items: z
      .array(z.object({ id: z.string(), position: z.number().int(), parent_id: z.string().nullable().optional() }))
      .min(1),
    reason: z.string().optional(),
  },
  async run({ items, reason }) {
    await patch(guildRoute('/channels'), items, { reason: reason ?? 'Classifer: channels_reorder' });
    return { target: items.map((i) => i.id).join(','), text: `Repositioned ${items.length} channel(s).` };
  },
});

tool({
  name: 'guild_edit',
  title: 'Rename the server',
  description:
    'Change the guild itself: its name, or the channel used for system messages. The old value is recorded in the audit trail and returned, so the change is reversible by calling this again with it.',
  mutating: true,
  schema: {
    name: z.string().min(2).max(100).optional(),
    system_channel_id: z.string().nullable().optional(),
    reason: z.string().optional(),
  },
  async run({ name, system_channel_id, reason }) {
    const before = await fetchGuild();
    const body = {};
    if (name !== undefined) body.name = name;
    if (system_channel_id !== undefined) body.system_channel_id = system_channel_id;
    if (!Object.keys(body).length) return 'Nothing to change — no fields given.';

    const after = await patch(guildRoute(), body, { reason: reason ?? 'Classifer: guild_edit' });

    return {
      target: GUILD_ID,
      text: [
        `Renamed the server.`,
        `  before  "${before.name}"`,
        `  after   "${after.name}"`,
        '',
        `To undo: guild_edit name="${before.name}"`,
      ].join('\n'),
    };
  },
});

tool({
  name: 'role_create',
  title: 'Create a role',
  description:
    'Create a role. Roles are how the Registry expresses who may press what — a component\'s requires clause names a role id.',
  mutating: true,
  schema: {
    name: z.string(),
    permissions: permList.default([]).optional(),
    color: z.number().int().min(0).max(0xffffff).optional(),
    hoist: z.boolean().optional().describe('show separately in the member list'),
    mentionable: z.boolean().optional(),
    reason: z.string().optional(),
  },
  async run({ name, permissions = [], color, hoist, mentionable, reason }) {
    const created = await post(
      guildRoute('/roles'),
      { name, permissions: permBits(permissions), color, hoist, mentionable },
      { reason: reason ?? 'Classifer: role_create' },
    );
    return { target: created.id, text: `Created role @${created.name} — id ${created.id}` };
  },
});

tool({
  name: 'role_edit',
  title: 'Edit a role',
  description: 'Change a role\'s name, colour, permissions or flags. Snapshots first.',
  mutating: true,
  schema: {
    role_id: z.string(),
    name: z.string().optional(),
    permissions: permList.optional(),
    color: z.number().int().min(0).max(0xffffff).optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    reason: z.string().optional(),
  },
  async run({ role_id, name, permissions, color, hoist, mentionable, reason }) {
    const snapshotId = await snapshotRole(role_id, 'before role_edit');
    const body = {};
    if (name !== undefined) body.name = name;
    if (permissions !== undefined) body.permissions = permBits(permissions);
    if (color !== undefined) body.color = color;
    if (hoist !== undefined) body.hoist = hoist;
    if (mentionable !== undefined) body.mentionable = mentionable;
    if (!Object.keys(body).length) return 'Nothing to change — no fields given.';

    const updated = await patch(guildRoute(`/roles/${role_id}`), body, {
      reason: reason ?? 'Classifer: role_edit',
    });
    return {
      target: role_id,
      snapshotId,
      text: `Updated role @${updated.name} (${role_id}). Snapshot ${snapshotId} taken first.`,
    };
  },
});

tool({
  name: 'role_assign',
  title: 'Give or take a role',
  description: 'Add or remove a role on a member. Reversible, so not gated.',
  mutating: true,
  schema: {
    user_id: z.string(),
    role_id: z.string(),
    action: z.enum(['add', 'remove']).default('add'),
    reason: z.string().optional(),
  },
  async run({ user_id, role_id, action = 'add', reason }) {
    const route = guildRoute(`/members/${user_id}/roles/${role_id}`);
    const opts = { reason: reason ?? `Classifer: role_assign ${action}` };
    if (action === 'add') await put(route, undefined, opts);
    else await del(route, opts);
    return { target: `${user_id}/${role_id}`, text: `Role ${role_id} ${action === 'add' ? 'added to' : 'removed from'} member ${user_id}.` };
  },
});

tool({
  name: 'overwrite_set',
  title: 'Set a permission overwrite',
  description:
    'Set one role or member overwrite on one channel. Use the guild id as the target id to mean @everyone. This is what archiving uses to lock a channel: deny ViewChannel and SendMessages for @everyone.',
  mutating: true,
  schema: {
    channel_id: z.string(),
    target_id: z.string().describe('role id, member id, or the guild id for @everyone'),
    target_type: z.enum(['role', 'member']).default('role'),
    allow: permList.default([]).optional(),
    deny: permList.default([]).optional(),
    reason: z.string().optional(),
  },
  async run({ channel_id, target_id, target_type = 'role', allow = [], deny = [], reason }) {
    const snapshotId = await snapshotChannel(channel_id, 'before overwrite_set');
    await put(
      `/channels/${channel_id}/permissions/${target_id}`,
      { type: target_type === 'member' ? 1 : 0, allow: permBits(allow), deny: permBits(deny) },
      { reason: reason ?? 'Classifer: overwrite_set' },
    );
    const who = target_id === GUILD_ID ? '@everyone' : `${target_type} ${target_id}`;
    return {
      target: channel_id,
      snapshotId,
      text:
        `Set overwrite on ${channel_id} for ${who}\n` +
        `  allow: ${allow.length ? allow.join(', ') : '(none)'}\n` +
        `  deny:  ${deny.length ? deny.join(', ') : '(none)'}\n` +
        `Snapshot ${snapshotId} taken first.`,
    };
  },
});

tool({
  name: 'permissions_vocabulary',
  title: 'Which permission names are valid',
  description: 'The permission names the Registry and these tools accept. Read it rather than guessing a name and getting a rejection.',
  schema: {},
  async run() {
    return `Valid permission names:\n\n${PERM_NAMES.map((p) => `  ${p}`).join('\n')}\n\nUse the guild id (${GUILD_ID}) as a target id to mean @everyone.`;
  },
});

tool({
  name: 'find_by_name',
  title: 'Resolve a name to an id',
  description:
    'Look up a channel, category or role by name and get its id. Saves a full guild_snapshot when all you need is one id.',
  schema: {
    name: z.string(),
    kind: z.enum(['channel', 'category', 'role', 'any']).default('any'),
  },
  async run({ name, kind = 'any' }) {
    const needle = name.toLowerCase().replace(/^#|^@/, '');
    const out = [];

    if (kind !== 'role') {
      const channels = await fetchChannels();
      for (const c of channels) {
        if (!c.name.toLowerCase().includes(needle)) continue;
        const isCat = c.type === 4;
        if (kind === 'channel' && isCat) continue;
        if (kind === 'category' && !isCat) continue;
        out.push(`${isCat ? 'category' : CHANNEL_TYPE_NAME[c.type] ?? 'channel'}  ${c.name}  ${c.id}`);
      }
    }
    if (kind === 'role' || kind === 'any') {
      const roles = await fetchRoles();
      for (const r of roles) {
        if (r.name.toLowerCase().includes(needle)) out.push(`role      @${r.name}  ${r.id}`);
      }
    }

    return out.length ? out.join('\n') : `Nothing named like "${name}".`;
  },
});

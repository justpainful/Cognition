// Reading the server. Nothing here changes anything.

import { tool, z, table, json } from '../kit.js';
import {
  get,
  fetchGuild,
  fetchChannels,
  fetchRoles,
  fetchMe,
  guildRoute,
  CHANNEL_TYPE_NAME,
} from '../../../shared/rest.js';
import { lifecycleOf } from '../../../shared/naming.js';
import { tail } from '../../../shared/audit.js';
import { listSessions, listSchedules, listComponents, listActions } from '../../../shared/registry.js';
import { getSetting } from '../../../shared/store.js';
import { LOG_CHANNEL_SETTING } from '../../../shared/audit.js';
import { listPending } from '../../../shared/guard.js';
import { GUILD_ID } from '../../../shared/env.js';
import { nextRun } from '../../../shared/cron.js';
import { engineHash } from '../../../shared/version.js';

function tree(channels) {
  const cats = channels.filter((c) => c.type === 4).sort((a, b) => a.position - b.position);
  const loose = channels.filter((c) => c.type !== 4 && !c.parent_id).sort((a, b) => a.position - b.position);
  const lines = [];

  const renderChild = (c) => {
    const life = lifecycleOf(c.name);
    const mark = life === 'testing' ? ' ·TEST' : life === 'archived' ? ' ·ARCHIVED' : '';
    lines.push(`    #${c.name}  (${CHANNEL_TYPE_NAME[c.type] ?? c.type})  ${c.id}${mark}`);
  };

  for (const c of loose) renderChild(c);
  for (const cat of cats) {
    const life = lifecycleOf(cat.name);
    const mark = life === 'testing' ? ' ·TEST' : life === 'archived' ? ' ·ARCHIVED' : '';
    lines.push(`  ${cat.name}  ${cat.id}${mark}`);
    const kids = channels
      .filter((c) => c.parent_id === cat.id)
      .sort((a, b) => a.position - b.position);
    if (!kids.length) lines.push('    (empty)');
    for (const c of kids) renderChild(c);
  }
  return lines.join('\n');
}

tool({
  name: 'guild_snapshot',
  title: 'Read the whole server',
  description:
    'The full current structure of the Cognition server: every category, channel and role, with lifecycle tags. Read this before changing anything — it is the state every other decision reasons from.',
  schema: {},
  async run() {
    const [guild, channels, roles] = await Promise.all([fetchGuild(), fetchChannels(), fetchRoles()]);
    const sessions = listSessions();
    const open = sessions.filter((s) => ['building', 'testing'].includes(s.state));

    const roleLines = roles
      .sort((a, b) => b.position - a.position)
      .map((r) => `  @${r.name}  ${r.id}${r.managed ? '  (managed)' : ''}`)
      .join('\n');

    return {
      target: GUILD_ID,
      text: [
        `${guild.name}  (${GUILD_ID})`,
        `members ~${guild.approximate_member_count ?? '?'} · channels ${channels.length} · roles ${roles.length}`,
        '',
        'STRUCTURE',
        tree(channels) || '  (no channels)',
        '',
        'ROLES',
        roleLines,
        '',
        `SESSIONS  ${sessions.length} total, ${open.length} open`,
        open.length
          ? open.map((s) => `  #${s.id} ${s.name} — ${s.state}`).join('\n')
          : '  (none open)',
      ].join('\n'),
    };
  },
});

tool({
  name: 'channels_list',
  title: 'List channels',
  description: 'Channels only, optionally filtered by name fragment or by parent category id.',
  schema: {
    contains: z.string().optional().describe('case-insensitive fragment of the channel name'),
    parent_id: z.string().optional().describe('only channels inside this category'),
  },
  async run({ contains, parent_id }) {
    let channels = await fetchChannels();
    if (parent_id) channels = channels.filter((c) => c.parent_id === parent_id);
    if (contains) {
      const needle = contains.toLowerCase();
      channels = channels.filter((c) => c.name.toLowerCase().includes(needle));
    }
    return table(
      channels.sort((a, b) => a.position - b.position),
      [
        { header: 'id', get: (c) => c.id },
        { header: 'name', get: (c) => c.name },
        { header: 'type', get: (c) => CHANNEL_TYPE_NAME[c.type] ?? c.type },
        { header: 'parent', get: (c) => c.parent_id ?? '-' },
        { header: 'state', get: (c) => lifecycleOf(c.name) },
      ],
    );
  },
});

tool({
  name: 'roles_list',
  title: 'List roles',
  description: 'Every role with its id, position and permission bitfield.',
  schema: {},
  async run() {
    const roles = await fetchRoles();
    return table(roles.sort((a, b) => b.position - a.position), [
      { header: 'id', get: (r) => r.id },
      { header: 'name', get: (r) => r.name },
      { header: 'pos', get: (r) => r.position },
      { header: 'managed', get: (r) => (r.managed ? 'yes' : '') },
      { header: 'permissions', get: (r) => r.permissions },
    ]);
  },
});

tool({
  name: 'members_search',
  title: 'Find members',
  description:
    'Search guild members by username prefix. Use this to resolve a name to an id before granting a role or building a permission overwrite.',
  schema: {
    query: z.string().describe('username or nickname prefix'),
    limit: z.number().int().min(1).max(100).default(25).optional(),
  },
  async run({ query, limit = 25 }) {
    const members = await get(guildRoute('/members/search'), { query: { query, limit } });
    if (!members.length) return `No member matches "${query}".`;
    return table(members, [
      { header: 'id', get: (m) => m.user.id },
      { header: 'username', get: (m) => m.user.username },
      { header: 'nick', get: (m) => m.nick ?? '' },
      { header: 'roles', get: (m) => m.roles.length },
      { header: 'bot', get: (m) => (m.user.bot ? 'yes' : '') },
    ]);
  },
});

tool({
  name: 'members_list',
  title: 'List everyone in the guild',
  description:
    'Every member with the roles they hold and when they joined. members_search needs a name to look for; this is for when the question is who is here at all.',
  schema: {
    limit: z.number().int().min(1).max(1000).default(200).optional(),
    include_bots: z.boolean().default(true).optional(),
  },
  async run({ limit = 200, include_bots = true }) {
    const [members, roles, guild] = await Promise.all([
      get(guildRoute('/members'), { query: { limit } }),
      fetchRoles(),
      fetchGuild(),
    ]);
    const roleName = (id) => roles.find((r) => r.id === id)?.name ?? id;
    const shown = include_bots ? members : members.filter((m) => !m.user.bot);

    return table(
      shown.sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at)),
      [
        { header: 'id', get: (m) => m.user.id },
        { header: 'username', get: (m) => m.user.username },
        { header: 'nick', get: (m) => m.nick ?? '' },
        { header: 'kind', get: (m) => (m.user.bot ? 'bot' : m.user.id === guild.owner_id ? 'owner' : 'member') },
        { header: 'joined', get: (m) => (m.joined_at ?? '').slice(0, 10) },
        { header: 'roles', get: (m) => (m.roles.length ? m.roles.map(roleName).join(', ') : '(none)') },
      ],
    );
  },
});

tool({
  name: 'messages_read',
  title: 'Read a channel',
  description: 'Recent messages in a channel, newest first. Use it to check what a panel actually posted, or to read what people said.',
  schema: {
    channel_id: z.string(),
    limit: z.number().int().min(1).max(100).default(20).optional(),
  },
  async run({ channel_id, limit = 20 }) {
    const msgs = await get(`/channels/${channel_id}/messages`, { query: { limit } });
    if (!msgs.length) return '(channel is empty)';
    return msgs
      .map((m) => {
        const who = m.author?.username ?? 'unknown';
        const when = new Date(m.timestamp).toISOString().replace('T', ' ').slice(0, 16);
        const body = m.content || (m.embeds?.length ? `[${m.embeds.length} embed(s)] ${m.embeds[0].title ?? ''}` : '[no text]');
        const comps = m.components?.length ? `  [${m.components.flatMap((r) => r.components ?? []).length} component(s)]` : '';
        return `${when}  ${who}: ${body}${comps}\n            id ${m.id}`;
      })
      .join('\n');
  },
});

tool({
  name: 'audit_tail',
  title: 'Read the audit trail',
  description:
    'The most recent entries from the Registry audit table — every Classifer call, every button press the Dispatcher handled, every scheduled run. This is the complete record; #command-log only shows the changes.',
  schema: {
    limit: z.number().int().min(1).max(200).default(25).optional(),
    source: z.enum(['classifer', 'dispatcher', 'scheduler', 'bootstrap']).optional(),
    result: z.enum(['ok', 'error', 'plan']).optional(),
  },
  async run({ limit = 25, source, result }) {
    const rows = tail(limit, { source, result });
    if (!rows.length) return '(no audit entries match)';
    return table(rows, [
      { header: 'at', get: (r) => r.at.replace('T', ' ').slice(0, 19) },
      { header: 'src', get: (r) => r.source },
      { header: 'op', get: (r) => r.op },
      { header: 'target', get: (r) => r.target ?? '' },
      { header: 'result', get: (r) => r.result },
      { header: 'detail', get: (r) => (r.detail ?? '').slice(0, 60) },
    ]);
  },
});

tool({
  name: 'system_status',
  title: 'Is everything running',
  description:
    'Health of the whole setup: token, guild reachability, whether #command-log is wired up, Registry contents, live schedules and their next fire times, and any destructive plans still awaiting confirmation. Run this when something is not behaving.',
  schema: {},
  async run() {
    const lines = [];

    let me = null;
    try {
      me = await fetchMe();
      lines.push(`token      ok — ${me.username} (${me.id})`);
    } catch (e) {
      lines.push(`token      FAILED — ${e.message}`);
    }

    try {
      const guild = await fetchGuild();
      lines.push(`guild      ok — "${guild.name}" (${GUILD_ID})`);
    } catch (e) {
      lines.push(`guild      FAILED — ${e.message}`);
    }

    // The bot stamps the engine build it loaded at startup. If disk has moved on,
    // the process is executing older code and will reject things that plainly
    // exist — the one failure here that looks like a bug in the Registry.
    const onDisk = engineHash();
    const running = getSetting('bot_engine_hash');
    const startedAt = getSetting('bot_started_at');
    if (!running) {
      lines.push('bot        never started since this Registry was created');
    } else if (running === onDisk) {
      lines.push(`bot engine ok — build ${onDisk}, last started ${startedAt}`);
    } else {
      lines.push(
        `bot engine STALE — running ${running}, disk is ${onDisk}\n` +
          `           The bot has been up since ${startedAt} and Node cached the modules it\n` +
          `           loaded then. Registry edits still apply live; engine edits do not.\n` +
          `           Restart it (npm run bot) or actions added since will fail as "unknown kind".`,
      );
    }

    const logChannel = getSetting(LOG_CHANNEL_SETTING);
    lines.push(
      logChannel
        ? `audit log  ok — posting to <#${logChannel}>`
        : 'audit log  not wired — run bootstrap, or set it, or embeds go nowhere (rows are still written)',
    );

    const actions = listActions();
    const components = listComponents();
    const sessions = listSessions();
    const schedules = listSchedules();
    lines.push(
      `registry   ${actions.length} actions · ${components.length} components · ${sessions.length} sessions · ${schedules.length} schedules`,
    );

    if (schedules.length) {
      lines.push('', 'SCHEDULES');
      for (const s of schedules) {
        let next = '(invalid cron)';
        try {
          next = s.enabled ? (nextRun(s.cron)?.toLocaleString() ?? 'never') : '(disabled)';
        } catch (e) {
          next = `(invalid cron: ${e.message})`;
        }
        lines.push(
          `  ${s.key}  "${s.cron}" -> ${s.actionKey}  next ${next}  last ${s.lastRunAt ?? 'never'} ${s.lastStatus ?? ''}`,
        );
      }
    }

    const pending = listPending();
    if (pending.length) {
      lines.push('', `PENDING CONFIRMATIONS (${pending.length})`);
      for (const p of pending) lines.push(`  ${p.op} — expires ${p.expiresAt}\n    ${p.preview.split('\n')[0]}`);
    }

    lines.push(
      '',
      'Note: this cannot tell whether the Cognition bot process is running. If buttons do not respond',
      'but these tools work, the bot is down — Classifer talks to Discord over REST and does not need it.',
    );

    return lines.join('\n');
  },
});

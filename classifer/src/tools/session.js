// Session lifecycle.
//
// A session is one experiment: a category, its channels, its Registry rows, and
// a thread in #active-sessions that tracks it. Promotion and archiving change
// names and permissions only. Nothing is ever moved between categories, so ids,
// history and every link anyone posted survive the transition — which is the
// whole reason the lifecycle is expressed in the name.

import { tool, z, table } from '../kit.js';
import { post, patch, put, fetchChannels, guildRoute, CHANNEL_TYPE, permBits } from '../../../shared/rest.js';
import { GUILD_ID } from '../../../shared/env.js';
import { getSetting } from '../../../shared/store.js';
import { TEST_TAG, ARCHIVED_TAG, addTag, stripTag, tidySlug } from '../../../shared/naming.js';
import {
  createSession,
  getSession,
  getSessionByName,
  listSessions,
  updateSession,
  listComponents,
} from '../../../shared/registry.js';
import { snapshotCategory } from '../../../shared/snapshot.js';

export const SESSIONS_CHANNEL_SETTING = 'active_sessions_channel_id';
export const SANDBOX_CATEGORY_SETTING = 'sandbox_category_id';

tool({
  name: 'session_start',
  title: 'Start a test session',
  description:
    'Create a tagged category, its channels, a Registry session row, and a tracking thread in #active-sessions. This is how every experiment begins.',
  mutating: true,
  schema: {
    name: z.string().describe('the system being tested, e.g. "Tickets" — the [TEST] tag is added for you'),
    channels: z
      .array(z.string())
      .default([])
      .describe('channel names to create inside the session category, e.g. ["ticket-open","ticket-log"]'),
    purpose: z.string().optional().describe('one line on what this session is testing'),
  },
  async run({ name, channels = [], purpose }) {
    const clean = stripTag(stripTag(name, TEST_TAG), ARCHIVED_TAG);
    if (getSessionByName(clean)) {
      const prior = getSessionByName(clean);
      if (['building', 'testing'].includes(prior.state)) {
        throw new Error(
          `Session "${clean}" is already open (#${prior.id}, ${prior.state}). ` +
            `Use session_status to see it, or archive it before starting another with the same name.`,
        );
      }
    }

    const categoryName = addTag(clean, TEST_TAG);
    const category = await post(
      guildRoute('/channels'),
      { name: categoryName, type: CHANNEL_TYPE.category },
      { reason: `Classifer: session_start "${clean}"` },
    );

    const made = [];
    for (const raw of channels) {
      const ch = await post(
        guildRoute('/channels'),
        { name: tidySlug(raw), type: CHANNEL_TYPE.text, parent_id: category.id },
        { reason: `Classifer: session_start "${clean}"` },
      );
      made.push({ id: ch.id, name: ch.name });
    }

    const session = createSession({
      name: clean,
      state: 'building',
      categoryId: category.id,
      channels: made,
      meta: { purpose: purpose ?? null },
    });

    // The tracking thread. Not fatal if #active-sessions is not wired yet.
    let threadNote = 'no #active-sessions channel configured — no tracking thread created';
    const sessionsChannel = getSetting(SESSIONS_CHANNEL_SETTING);
    if (sessionsChannel) {
      try {
        const thread = await post(
          `/channels/${sessionsChannel}/threads`,
          { name: `#${session.id} ${clean}`, type: CHANNEL_TYPE.publicThread, auto_archive_duration: 10080 },
          { reason: 'Classifer: session tracking thread' },
        );
        await post(`/channels/${thread.id}/messages`, {
          embeds: [
            {
              title: `Session #${session.id} — ${clean}`,
              description: purpose ?? '(no purpose recorded)',
              color: 0xfaa81a,
              fields: [
                { name: 'state', value: 'building', inline: true },
                { name: 'category', value: `${categoryName}\n${category.id}`, inline: true },
                {
                  name: 'channels',
                  value: made.length ? made.map((c) => `<#${c.id}>`).join(' ') : '(none)',
                },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
          allowed_mentions: { parse: [] },
        });
        updateSession(session.id, { threadId: thread.id });
        threadNote = `tracking thread ${thread.id} in <#${sessionsChannel}>`;
      } catch (e) {
        threadNote = `could not create tracking thread: ${e.message}`;
      }
    }

    return {
      target: String(session.id),
      text: [
        `Session #${session.id} "${clean}" started.`,
        `  category  ${categoryName}  ${category.id}`,
        ...made.map((c) => `  channel   #${c.name}  ${c.id}`),
        `  ${threadNote}`,
        '',
        'Next: registry_put the actions, then panel_publish the buttons into one of these channels.',
      ].join('\n'),
    };
  },
});

tool({
  name: 'session_status',
  title: 'Session state',
  description: 'All sessions, or the full detail of one — its channels, its components, and where it is in the lifecycle.',
  schema: {
    session_id: z.number().int().optional(),
  },
  async run({ session_id }) {
    if (session_id === undefined) {
      const sessions = listSessions();
      if (!sessions.length) return 'No sessions yet. session_start creates the first.';
      return table(sessions, [
        { header: 'id', get: (s) => s.id },
        { header: 'name', get: (s) => s.name },
        { header: 'state', get: (s) => s.state },
        { header: 'channels', get: (s) => s.channels.length },
        { header: 'created', get: (s) => s.createdAt.slice(0, 16).replace('T', ' ') },
      ]);
    }

    const s = getSession(session_id);
    if (!s) return `No session #${session_id}.`;
    const comps = listComponents({ sessionId: session_id });
    const channels = await fetchChannels();
    const category = channels.find((c) => c.id === s.categoryId);

    return [
      `Session #${s.id} — ${s.name}`,
      `state    ${s.state}`,
      `purpose  ${s.meta.purpose ?? '(none recorded)'}`,
      `category ${category ? `${category.name} (${category.id})` : `${s.categoryId} — MISSING from the server`}`,
      `thread   ${s.threadId ?? '(none)'}`,
      '',
      'CHANNELS',
      s.channels.length
        ? s.channels
            .map((c) => {
              const live = channels.find((x) => x.id === c.id);
              return `  #${live?.name ?? c.name}  ${c.id}${live ? '' : '  — MISSING from the server'}`;
            })
            .join('\n')
        : '  (none)',
      '',
      `COMPONENTS (${comps.length})`,
      comps.length ? comps.map((c) => `  ${c.key}  "${c.spec.label ?? ''}" -> ${c.actionKey}`).join('\n') : '  (none)',
    ].join('\n');
  },
});

tool({
  name: 'session_promote',
  title: 'Promote a session',
  description:
    'Strip the [TEST] tag from the session category and its channels. Nothing moves: same ids, same history, same links. The system simply stops being provisional where it stands.',
  mutating: true,
  schema: {
    session_id: z.number().int(),
    reason: z.string().optional(),
  },
  async run({ session_id, reason }) {
    const s = getSession(session_id);
    if (!s) throw new Error(`No session #${session_id}.`);
    if (s.state === 'promoted') return `Session #${session_id} is already promoted.`;
    if (s.state === 'archived') {
      throw new Error(
        `Session #${session_id} is archived. Un-archive it first if you want it live again — promoting straight from archived would leave the lock on.`,
      );
    }

    const snapshotId = s.categoryId ? await snapshotCategory(s.categoryId, `before promote #${session_id}`) : null;
    const channels = await fetchChannels();
    const renamed = [];

    if (s.categoryId) {
      const cat = channels.find((c) => c.id === s.categoryId);
      if (cat) {
        const next = stripTag(cat.name, TEST_TAG);
        if (next !== cat.name) {
          await patch(`/channels/${cat.id}`, { name: next }, { reason: reason ?? 'Classifer: session_promote' });
          renamed.push(`category "${cat.name}" -> "${next}"`);
        }
      }
    }

    for (const c of s.channels) {
      const live = channels.find((x) => x.id === c.id);
      if (!live) continue;
      const next = tidySlug(stripTag(live.name, TEST_TAG));
      if (next && next !== live.name) {
        await patch(`/channels/${c.id}`, { name: next }, { reason: reason ?? 'Classifer: session_promote' });
        renamed.push(`#${live.name} -> #${next}`);
      }
    }

    updateSession(session_id, { state: 'promoted' });
    await announce(s, `Promoted — the [TEST] tag is gone. This is permanent now.`, 0x3ba55d);

    return {
      target: String(session_id),
      snapshotId,
      text: [
        `Session #${session_id} "${s.name}" promoted.`,
        renamed.length ? renamed.map((r) => `  ${r}`).join('\n') : '  (nothing needed renaming)',
        snapshotId ? `\nSnapshot ${snapshotId} taken first.` : '',
      ].join('\n'),
    };
  },
});

tool({
  name: 'session_archive',
  title: 'Archive a session',
  description:
    'Tag the session [ARCHIVED] and lock its channels by denying ViewChannel and SendMessages to @everyone. Nothing is deleted and nothing moves — the channels stay exactly where they are, readable by anyone with a role that overrides the deny.',
  mutating: true,
  schema: {
    session_id: z.number().int(),
    reason: z.string().optional(),
  },
  async run({ session_id, reason }) {
    const s = getSession(session_id);
    if (!s) throw new Error(`No session #${session_id}.`);
    if (s.state === 'archived') return `Session #${session_id} is already archived.`;

    const snapshotId = s.categoryId ? await snapshotCategory(s.categoryId, `before archive #${session_id}`) : null;
    const channels = await fetchChannels();
    const done = [];
    const auditReason = reason ?? 'Classifer: session_archive';

    if (s.categoryId) {
      const cat = channels.find((c) => c.id === s.categoryId);
      if (cat) {
        const next = addTag(stripTag(cat.name, TEST_TAG), ARCHIVED_TAG);
        await patch(`/channels/${cat.id}`, { name: next }, { reason: auditReason });
        done.push(`category renamed to "${next}"`);
      }
    }

    for (const c of s.channels) {
      const live = channels.find((x) => x.id === c.id);
      if (!live) continue;
      const next = tidySlug(addTag(stripTag(live.name, TEST_TAG), ARCHIVED_TAG, { slug: true }));
      await patch(`/channels/${c.id}`, { name: next }, { reason: auditReason });
      await putOverwrite(c.id, auditReason);
      done.push(`#${live.name} -> #${next}, locked`);
    }

    updateSession(session_id, { state: 'archived' });
    await announce(s, 'Archived — renamed and locked in place. Nothing was deleted.', 0x747f8d);

    return {
      target: String(session_id),
      snapshotId,
      text: [
        `Session #${session_id} "${s.name}" archived.`,
        ...done.map((d) => `  ${d}`),
        snapshotId ? `\nSnapshot ${snapshotId} taken first — snapshot_restore ${snapshotId} un-archives it.` : '',
      ].join('\n'),
    };
  },
});

async function putOverwrite(channelId, reason) {
  await put(
    `/channels/${channelId}/permissions/${GUILD_ID}`,
    { type: 0, allow: permBits([]), deny: permBits(['ViewChannel', 'SendMessages']) },
    { reason },
  );
}

/** Post an update into the session's tracking thread, if it has one. */
async function announce(session, text, color) {
  if (!session.threadId) return;
  try {
    await post(`/channels/${session.threadId}/messages`, {
      embeds: [{ description: text, color, timestamp: new Date().toISOString() }],
      allowed_mentions: { parse: [] },
    });
  } catch {
    /* the thread may be archived or gone; the state change already happened */
  }
}

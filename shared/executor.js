// The fourteen primitives. Everything the server does is a composition of these.
//
// This module is deliberately shared between the bot and Classifer. A scheduled
// run and a button press execute the same code over the same rows, so a system
// cannot behave one way when a person triggers it and another way when the clock
// does. The only difference is the context: an interaction context can reply to
// a user, a system context has nobody to reply to and says so.
//
// Everything talks to Discord over REST, not discord.js, for the same reason —
// so that a Registry action means exactly one thing regardless of which process
// is running it.

import { get, post, patch, put, del, guildRoute, CHANNEL_TYPE, permBits } from './rest.js';
import { GUILD_ID } from './env.js';
import { getAction, getSession, updateSession, ACTION_KINDS as KNOWN_KINDS } from './registry.js';
import { evaluate } from './predicates.js';
import { buildScope, render } from './template.js';
import { tidySlug, addTag, stripTag, TEST_TAG, ARCHIVED_TAG } from './naming.js';
import { encode as encodeCustomId } from './customid.js';
import { bumpCounter } from './triggers.js';

const MAX_DEPTH = 8;
const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 };

export class ActionError extends Error {
  constructor(message, { userFacing = true } = {}) {
    super(message);
    this.name = 'ActionError';
    this.userFacing = userFacing;
  }
}

/** Resolve "an action" that may be a Registry key or an inline definition. */
function resolveAction(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') {
    const action = getAction(ref);
    if (!action) throw new ActionError(`This control points at action "${ref}", which no longer exists.`);
    return action;
  }
  if (typeof ref === 'object' && ref.kind) {
    return { key: ref.key ?? '(inline)', kind: ref.kind, params: ref.params ?? {}, requires: ref.requires ?? null, confirm: !!ref.confirm };
  }
  throw new ActionError('Malformed action reference in the Registry.');
}

function buildOverwrites(list = []) {
  return list.map((o) => ({
    id: String(o.id),
    type: o.type === 'member' || o.type === 1 ? 1 : 0,
    allow: permBits(o.allow ?? []),
    deny: permBits(o.deny ?? []),
  }));
}

/**
 * Run an action.
 * @param ref  Registry key or inline action
 * @param ctx  execution context (see the header comment)
 * @returns {Promise<{log: string[], created?: object}>}
 */
export async function execute(ref, ctx, depth = 0) {
  if (depth > MAX_DEPTH) {
    throw new ActionError('Action nesting is too deep — check for a sequence that references itself.');
  }

  const action = resolveAction(ref);
  const log = [];
  const scope = buildScope(ctx);

  // A requires clause on a nested action is checked too. Composition must not be
  // a way to get around a restriction placed on the piece being composed.
  //
  // The predicate is rendered against the same scope as the params, so a clause
  // can talk about the person pressing the button — {"type":"channel_absent",
  // "name":"ticket-{{user.name}}"} is what "one open ticket each" looks like.
  if (action.requires) {
    const verdict = await evaluate(render(action.requires, scope), ctx);
    if (!verdict.pass) throw new ActionError(verdict.reason);
  }

  if (action.confirm && !ctx.confirmed) {
    throw new ActionError(
      `"${action.key}" is marked as needing confirmation because it cannot be undone. ` +
        `It will not run from a click. Use destructive_plan then destructive_apply.`,
    );
  }

  const p = render(action.params ?? {}, scope);
  const reason = `Cognition: ${action.key} (${ctx.source ?? 'system'})`;

  switch (action.kind) {
    // ---- talking ----------------------------------------------------------

    case 'reply': {
      const payload = {
        content: p.content,
        embeds: p.embed
          ? [{ title: p.embed.title, description: p.embed.description, color: p.embed.color ?? 0x5865f2, footer: p.embed.footer ? { text: p.embed.footer } : undefined }]
          : undefined,
        ephemeral: p.ephemeral !== false,
      };
      if (ctx.respond) {
        await ctx.respond(payload);
        log.push(`replied to ${ctx.user?.username ?? 'user'}`);
      } else {
        log.push(`reply skipped — no interaction to answer in a ${ctx.source ?? 'system'} context`);
      }
      break;
    }

    case 'message_send': {
      if (!p.channel_id) throw new ActionError('message_send needs a channel_id.');
      const msg = await post(`/channels/${p.channel_id}/messages`, {
        content: p.content,
        embeds: p.embed
          ? [{ title: p.embed.title, description: p.embed.description, color: p.embed.color ?? 0x5865f2, footer: p.embed.footer ? { text: p.embed.footer } : undefined }]
          : undefined,
        allowed_mentions: p.allow_mentions ? undefined : { parse: [] },
      });
      log.push(`posted message ${msg.id} to ${p.channel_id}`);
      break;
    }

    case 'log': {
      log.push(String(p.message ?? ''));
      break;
    }

    case 'dm_send': {
      // Opening a DM channel is idempotent: Discord returns the existing one.
      const userId = p.user_id || ctx.user?.id;
      if (!userId) throw new ActionError('dm_send has no user to write to.');
      if (!p.content && !p.embed) throw new ActionError('dm_send needs content or an embed.');
      try {
        const dm = await post('/users/@me/channels', { recipient_id: String(userId) });
        await post(`/channels/${dm.id}/messages`, {
          content: p.content,
          embeds: p.embed
            ? [{ title: p.embed.title, description: p.embed.description, color: p.embed.color ?? 0x5865f2 }]
            : undefined,
        });
        log.push(`sent a DM to ${userId}`);
      } catch (e) {
        // Closed DMs are a setting, not a fault. A welcome flow should not die
        // because one member does not accept messages from servers.
        if (e.status === 403) log.push(`could not DM ${userId} — their DMs are closed`);
        else throw e;
      }
      break;
    }

    case 'reaction_add': {
      const channelId = p.channel_id || ctx.channel?.id;
      const messageId = p.message_id || ctx.message?.id;
      if (!channelId || !messageId) throw new ActionError('reaction_add needs a channel and a message.');
      if (!p.emoji) throw new ActionError('reaction_add needs an emoji.');
      await put(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(p.emoji)}/@me`);
      log.push(`reacted ${p.emoji} to ${messageId}`);
      break;
    }

    case 'counter_bump': {
      // Gives actions a number to work with: ticket-0007 rather than a snowflake.
      if (!p.key) throw new ActionError('counter_bump needs a key.');
      const value = bumpCounter(p.key, Number(p.by ?? 1));
      const padded = p.pad ? String(value).padStart(Number(p.pad), '0') : String(value);
      log.push(`counter "${p.key}" is now ${value}`);
      if (p.then) {
        const nested = await execute(
          p.then,
          { ...ctx, extra: { ...(ctx.extra ?? {}), 'counter.value': padded, 'counter.key': p.key } },
          depth + 1,
        );
        log.push(...nested.log);
        return { log, created: nested.created };
      }
      break;
    }

    case 'panel_send': {
      // Posts buttons bound to components that already exist. The per-click args
      // are what make one stored component serve unlimited instances: a single
      // "close" row handles every ticket, because the channel it acts on rides
      // in the custom_id rather than in the row.
      if (!p.channel_id) throw new ActionError('panel_send needs a channel_id.');
      const buttons = p.buttons ?? [];
      if (!buttons.length) throw new ActionError('panel_send needs at least one button.');

      const rows = [];
      for (let i = 0; i < buttons.length; i += 5) {
        rows.push({
          type: 1,
          components: buttons.slice(i, i + 5).map((b) => {
            if (!b.component_key) {
              throw new ActionError('Each panel_send button needs a component_key that already exists.');
            }
            return {
              type: 2,
              style: BUTTON_STYLE[b.style ?? 'secondary'] ?? 2,
              label: String(b.label ?? 'Button').slice(0, 80),
              emoji: b.emoji ? { name: b.emoji } : undefined,
              custom_id: encodeCustomId(b.component_key, b.args ?? []),
            };
          }),
        });
      }

      const msg = await post(`/channels/${p.channel_id}/messages`, {
        content: p.content,
        embeds: p.embed
          ? [{ title: p.embed.title, description: p.embed.description, color: p.embed.color ?? 0x5865f2 }]
          : undefined,
        components: rows,
        allowed_mentions: { parse: [] },
      });
      log.push(`posted panel ${msg.id} to ${p.channel_id}`);
      break;
    }

    // ---- structure --------------------------------------------------------

    case 'channel_create': {
      if (!p.name) throw new ActionError('channel_create needs a name.');
      const type = p.type ?? 'text';
      const isVoice = type === 'voice' || type === 'stage';
      const created = await post(
        guildRoute('/channels'),
        {
          name: isVoice ? p.name : tidySlug(p.name),
          type: CHANNEL_TYPE[type] ?? CHANNEL_TYPE.text,
          parent_id: p.parent_id || undefined,
          topic: p.topic,
          permission_overwrites: p.overwrites ? buildOverwrites(p.overwrites) : undefined,
        },
        { reason },
      );
      log.push(`created #${created.name} (${created.id})`);
      if (p.then) {
        const nested = await execute(p.then, { ...ctx, created }, depth + 1);
        log.push(...nested.log);
      }
      return { log, created };
    }

    case 'channel_edit': {
      if (!p.channel_id) throw new ActionError('channel_edit needs a channel_id.');
      const body = {};
      if (p.name !== undefined) body.name = p.name;
      if (p.topic !== undefined) body.topic = p.topic;
      if (p.parent_id !== undefined) body.parent_id = p.parent_id;

      // name_prefix and name_suffix read the current name first, so a rename can
      // mark a channel without the Registry row having to know what it is called.
      // That is what lets one row close every ticket with a readable result.
      if (p.name_prefix !== undefined || p.name_suffix !== undefined) {
        const current = await get(`/channels/${p.channel_id}`);
        const base = body.name ?? current.name;
        // Applying the same marker twice is the common case, not the rare one —
        // closing an already-closed ticket should be a no-op, not
        // "closed-closed-ticket-x". Skip a prefix or suffix already present.
        const prefix = p.name_prefix && !base.startsWith(p.name_prefix) ? p.name_prefix : '';
        const suffix = p.name_suffix && !base.endsWith(p.name_suffix) ? p.name_suffix : '';
        const next = `${prefix}${base}${suffix}`;
        body.name = current.type === CHANNEL_TYPE.category ? next : tidySlug(next);
      }

      if (!Object.keys(body).length) throw new ActionError('channel_edit was given nothing to change.');
      const updated = await patch(`/channels/${p.channel_id}`, body, { reason });
      log.push(`edited channel ${p.channel_id} -> "${updated.name}"`);
      break;
    }

    case 'channel_delete': {
      // Reached only through the confirmed path; the guard above blocks clicks.
      if (!p.channel_id) throw new ActionError('channel_delete needs a channel_id.');
      await del(`/channels/${p.channel_id}`, { reason });
      log.push(`DELETED channel ${p.channel_id}`);
      break;
    }

    case 'thread_create': {
      if (!p.channel_id || !p.name) throw new ActionError('thread_create needs channel_id and name.');
      const thread = await post(
        `/channels/${p.channel_id}/threads`,
        {
          name: String(p.name).slice(0, 100),
          type: CHANNEL_TYPE.publicThread,
          auto_archive_duration: p.auto_archive_minutes ?? 1440,
        },
        { reason },
      );
      log.push(`created thread ${thread.id}`);
      if (p.then) {
        const nested = await execute(p.then, { ...ctx, created: thread }, depth + 1);
        log.push(...nested.log);
      }
      return { log, created: thread };
    }

    case 'guild_edit': {
      // Renaming the server from a button is the bounded form of what people
      // otherwise ask for in free text: one operation, one field, gated by
      // whatever requires clause the row carries.
      if (!p.name) throw new ActionError('guild_edit needs a name.');
      const before = await get(guildRoute());
      await patch(guildRoute(), { name: String(p.name).slice(0, 100) }, { reason });
      log.push(`renamed guild "${before.name}" -> "${p.name}"`);
      break;
    }

    case 'overwrite_set': {
      if (!p.channel_id || !p.target_id) throw new ActionError('overwrite_set needs channel_id and target_id.');
      await put(
        `/channels/${p.channel_id}/permissions/${p.target_id}`,
        {
          type: p.target_type === 'member' ? 1 : 0,
          allow: permBits(p.allow ?? []),
          deny: permBits(p.deny ?? []),
        },
        { reason },
      );
      log.push(`set overwrite on ${p.channel_id} for ${p.target_id}`);
      break;
    }

    // ---- roles ------------------------------------------------------------

    case 'role_grant':
    case 'role_revoke': {
      const roleId = p.role_id;
      const userId = p.user_id || ctx.user?.id;
      if (!roleId) throw new ActionError(`${action.kind} needs a role_id.`);
      if (!userId) throw new ActionError(`${action.kind} has no user to act on.`);
      const route = guildRoute(`/members/${userId}/roles/${roleId}`);
      if (action.kind === 'role_grant') await put(route, undefined, { reason });
      else await del(route, { reason });
      log.push(`${action.kind === 'role_grant' ? 'granted' : 'revoked'} role ${roleId} for ${userId}`);
      break;
    }

    // ---- sessions ---------------------------------------------------------

    case 'session_op': {
      const op = p.op;
      const session = p.session_id ? getSession(p.session_id) : ctx.session;
      if (!session) throw new ActionError('session_op could not determine which session to act on.');
      if (op === 'promote') {
        updateSession(session.id, { state: 'promoted' });
        log.push(`session #${session.id} marked promoted`);
      } else if (op === 'archive') {
        updateSession(session.id, { state: 'archived' });
        log.push(`session #${session.id} marked archived`);
      } else if (op === 'close') {
        updateSession(session.id, { state: 'closed' });
        log.push(`session #${session.id} marked closed`);
      } else if (op === 'testing') {
        updateSession(session.id, { state: 'testing' });
        log.push(`session #${session.id} marked testing`);
      } else {
        throw new ActionError(`session_op does not know "${op}".`);
      }
      // The Discord-side rename is Classifer's job; this only moves the record,
      // so that a button can advance state without holding REST calls open.
      break;
    }

    // ---- control flow -----------------------------------------------------

    case 'sequence': {
      const steps = p.steps ?? [];
      if (!Array.isArray(steps)) throw new ActionError('sequence.steps must be a list.');
      let created;
      for (const step of steps) {
        const r = await execute(step, { ...ctx, created }, depth + 1);
        log.push(...r.log);
        if (r.created) created = r.created;
      }
      return { log, created };
    }

    case 'branch': {
      const verdict = await evaluate(p.if, ctx);
      const next = verdict.pass ? p.then : p.else;
      log.push(`branch: ${verdict.pass ? 'then' : 'else'} (${verdict.reason})`);
      if (next) {
        const r = await execute(next, ctx, depth + 1);
        log.push(...r.log);
        return { log, created: r.created };
      }
      break;
    }

    case 'modal_open': {
      // The modal itself must be sent as the interaction response, so only the
      // Dispatcher can do this. It supplies openModal in the context.
      if (!ctx.openModal) {
        throw new ActionError('modal_open only works from a button press.');
      }
      await ctx.openModal(action, p);
      log.push('opened modal');
      break;
    }

    default:
      // The likeliest cause is not a typo. A kind that was added to the engine
      // after this process started does not exist in this process, because Node
      // cached the modules at import — so say that rather than leaving it to be
      // guessed at.
      throw new ActionError(
        `Unknown action kind "${action.kind}". This process knows: ${KNOWN_KINDS.join(', ')}.\n` +
          `If that kind was added recently, the running bot predates it — restart it. ` +
          `Registry edits apply live; engine edits need a restart.`,
      );
  }

  return { log };
}

/** Convenience for scheduled and tool-driven runs, where there is no user. */
export function systemContext(extra = {}) {
  return {
    source: 'scheduler',
    actor: 'system',
    guildId: GUILD_ID,
    args: [],
    fields: {},
    ...extra,
  };
}

export { TEST_TAG, ARCHIVED_TAG, addTag, stripTag };

// Predicates decide whether an action may run, and which branch it takes.
//
// They fail closed: an unknown predicate type, or one that cannot be evaluated
// because the context is missing what it needs, returns false with a reason
// rather than assuming permission. The reason is what gets shown to whoever
// pressed the button, so it has to be worth reading.

import { fetchChannels } from './rest.js';
import { getSession } from './registry.js';

/**
 * @returns {Promise<{pass: boolean, reason: string}>}
 */
export async function evaluate(predicate, ctx = {}) {
  if (!predicate) return { pass: true, reason: 'no requirement' };

  const type = predicate.type;

  switch (type) {
    case 'always':
      return { pass: true, reason: 'always' };

    case 'never':
      return { pass: false, reason: 'this control is disabled' };

    case 'has_role': {
      const wanted = String(predicate.role_id ?? '');
      const held = (ctx.memberRoles ?? []).map(String);
      if (!wanted) return { pass: false, reason: 'requires has_role but no role_id was configured' };
      return held.includes(wanted)
        ? { pass: true, reason: `has role ${wanted}` }
        : { pass: false, reason: `you need the <@&${wanted}> role to use this` };
    }

    case 'is_guild_owner': {
      const owner = ctx.guildOwnerId ? String(ctx.guildOwnerId) : null;
      if (!owner) return { pass: false, reason: 'could not determine the server owner' };
      return String(ctx.user?.id) === owner
        ? { pass: true, reason: 'is guild owner' }
        : { pass: false, reason: 'only the server owner can use this' };
    }

    case 'in_channel': {
      const want = String(predicate.channel_id ?? '');
      return String(ctx.channel?.id) === want
        ? { pass: true, reason: 'in the required channel' }
        : { pass: false, reason: `this only works in <#${want}>` };
    }

    case 'channel_exists': {
      const channels = await fetchChannels();
      const needle = String(predicate.name ?? '').toLowerCase();
      const hit = channels.some((c) => c.name.toLowerCase() === needle);
      return hit
        ? { pass: true, reason: `#${needle} exists` }
        : { pass: false, reason: `#${needle} does not exist` };
    }

    case 'channel_absent': {
      const channels = await fetchChannels();
      const needle = String(predicate.name ?? '').toLowerCase();
      const hit = channels.some((c) => c.name.toLowerCase() === needle);
      return hit
        ? { pass: false, reason: `#${needle} already exists` }
        : { pass: true, reason: `#${needle} is free` };
    }

    case 'session_state': {
      const s = getSession(predicate.session_id);
      if (!s) return { pass: false, reason: `session #${predicate.session_id} does not exist` };
      return s.state === predicate.state
        ? { pass: true, reason: `session is ${s.state}` }
        : { pass: false, reason: `session is ${s.state}, not ${predicate.state}` };
    }

    case 'not': {
      const inner = await evaluate(predicate.of, ctx);
      return { pass: !inner.pass, reason: inner.pass ? `blocked because ${inner.reason}` : 'ok' };
    }

    case 'all': {
      for (const p of predicate.of ?? []) {
        const r = await evaluate(p, ctx);
        if (!r.pass) return r;
      }
      return { pass: true, reason: 'all requirements met' };
    }

    case 'any': {
      const reasons = [];
      for (const p of predicate.of ?? []) {
        const r = await evaluate(p, ctx);
        if (r.pass) return r;
        reasons.push(r.reason);
      }
      return { pass: false, reason: reasons.join('; ') || 'no alternative matched' };
    }

    default:
      return { pass: false, reason: `unknown requirement type "${type}" — fix the Registry entry` };
  }
}

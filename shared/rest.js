// A small Discord REST client.
//
// Classifer uses this instead of discord.js on purpose: building channels does
// not need a gateway connection, so Claude can restructure the server even
// while the Cognition bot process is stopped. Only live interactions need the
// bot, and those are its job, not this one's.

import { TOKEN, GUILD_ID, redact } from './env.js';

const BASE = 'https://discord.com/api/v10';

export class DiscordError extends Error {
  constructor(status, body, route) {
    const detail = typeof body === 'object' ? JSON.stringify(body) : String(body);
    super(`Discord ${status} on ${route}: ${redact(detail)}`);
    this.name = 'DiscordError';
    this.status = status;
    this.body = body;
    this.route = route;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One request, with 429 and 5xx retries. Discord tells us exactly how long to
 * wait on a 429, so we obey it rather than guessing a backoff.
 */
export async function api(method, route, { body, reason, query } = {}) {
  if (!TOKEN) throw new Error('DISCORD_TOKEN is not set.');

  let url = `${BASE}${route}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null),
    );
    if (String(qs)) url += `?${qs}`;
  }

  const headers = {
    Authorization: `Bot ${TOKEN}`,
    'User-Agent': 'Cognition (https://github.com/local/cognition, 0.1.0)',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // HTTP headers are Latin-1. An em dash or a word of Arabic in the reason throws
  // at fetch() before the request is ever sent, which surfaces as a mystifying
  // "cannot convert argument to a ByteString". Discord reads this header
  // percent-decoded, so encoding it is both the fix and the documented form.
  if (reason) {
    headers['X-Audit-Log-Reason'] = encodeURIComponent(String(reason).slice(0, 400));
  }

  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, init);

    if (res.status === 429) {
      const info = await res.json().catch(() => ({}));
      // retry_after is seconds, and can be fractional.
      const waitMs = Math.ceil((Number(info.retry_after) || 1) * 1000) + 100;
      await sleep(Math.min(waitMs, 30_000));
      continue;
    }

    if (res.status >= 500 && attempt < 4) {
      await sleep(500 * 2 ** attempt);
      continue;
    }

    if (res.status === 204) return null;

    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;

    if (!res.ok) throw new DiscordError(res.status, parsed ?? text, `${method} ${route}`);
    return parsed;
  }

  throw new DiscordError(429, 'rate limited after 5 attempts', `${method} ${route}`);
}

export const get = (route, opts) => api('GET', route, opts);
export const post = (route, body, opts) => api('POST', route, { ...opts, body });
export const patch = (route, body, opts) => api('PATCH', route, { ...opts, body });
export const put = (route, body, opts) => api('PUT', route, { ...opts, body });
export const del = (route, opts) => api('DELETE', route, opts);

// ---- Guild-scoped conveniences -------------------------------------------

export const guildRoute = (suffix = '') => `/guilds/${GUILD_ID}${suffix}`;

export const fetchGuild = () => get(guildRoute(), { query: { with_counts: true } });
export const fetchChannels = () => get(guildRoute('/channels'));
export const fetchRoles = () => get(guildRoute('/roles'));
export const fetchChannel = (id) => get(`/channels/${id}`);
export const fetchMe = () => get('/users/@me');

export const CHANNEL_TYPE = {
  text: 0,
  dm: 1,
  voice: 2,
  category: 4,
  announcement: 5,
  announcementThread: 10,
  publicThread: 11,
  privateThread: 12,
  stage: 13,
  forum: 15,
};

export const CHANNEL_TYPE_NAME = Object.fromEntries(
  Object.entries(CHANNEL_TYPE).map(([k, v]) => [v, k]),
);

// The permission bits the Registry is allowed to name. Kept as strings because
// Discord permission values are 64-bit and must survive JSON.
export const PERMISSION = {
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  ManageChannels: 1n << 4n,
  ManageMessages: 1n << 13n,
  ReadMessageHistory: 1n << 16n,
  AttachFiles: 1n << 15n,
  EmbedLinks: 1n << 14n,
  AddReactions: 1n << 6n,
  CreatePublicThreads: 1n << 35n,
  SendMessagesInThreads: 1n << 38n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  Administrator: 1n << 3n,
  MentionEveryone: 1n << 17n,
  UseApplicationCommands: 1n << 31n,
};

/** Turn ["ViewChannel","SendMessages"] into the string Discord expects. */
export function permBits(names = []) {
  let bits = 0n;
  for (const n of names) {
    const bit = PERMISSION[n];
    if (bit === undefined) throw new Error(`Unknown permission: ${n}`);
    bits |= bit;
  }
  return bits.toString();
}

/**
 * Build a permission overwrite.
 * type 0 = role, type 1 = member.
 */
export function overwrite(id, { allow = [], deny = [], type = 0 } = {}) {
  return { id: String(id), type, allow: permBits(allow), deny: permBits(deny) };
}

// Every mutation, from any of the three sources, lands in two places: a row in
// the Registry (queryable, permanent) and an embed in #command-log (visible to
// anyone in the server).
//
// Posting to Discord is best-effort by design. If the log channel is missing or
// Discord is having a bad minute, the operation that was being audited still
// succeeds and the row is still written — an audit trail that can take the
// server down with it is worse than one that occasionally misses an embed.

import { run, all, nowIso, getSetting } from './store.js';
import { post } from './rest.js';
import { redact } from './env.js';

export const LOG_CHANNEL_SETTING = 'command_log_channel_id';

const COLOR = { ok: 0x3ba55d, error: 0xed4245, warn: 0xfaa81a, plan: 0x5865f2 };

const SOURCE_ICON = {
  classifer: '🛠',
  dispatcher: '🖱',
  scheduler: '⏱',
  bootstrap: '🏗',
};

/**
 * @param entry.source   classifer | dispatcher | scheduler | bootstrap
 * @param entry.actor    'claude', a Discord user id, or 'system'
 * @param entry.op       the operation name, e.g. 'channel_create'
 * @param entry.target   what it acted on (id or name)
 * @param entry.result   'ok' | 'error' | 'plan'
 */
export function record(entry) {
  const {
    source,
    actor = 'system',
    op,
    target = null,
    params = null,
    result = 'ok',
    detail = null,
    snapshotId = null,
  } = entry;

  const res = run(
    `INSERT INTO audit (at, source, actor, op, target, params, result, detail, snapshot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nowIso(),
    source,
    String(actor),
    op,
    target ? String(target) : null,
    params ? redact(JSON.stringify(params)).slice(0, 4000) : null,
    result,
    detail ? redact(String(detail)).slice(0, 2000) : null,
    snapshotId,
  );
  return Number(res.lastInsertRowid);
}

/** Fire-and-forget embed. Never awaited by callers that must not block. */
export async function publish(entry) {
  const channelId = getSetting(LOG_CHANNEL_SETTING);
  if (!channelId) return false;

  const { source, actor = 'system', op, target, result = 'ok', detail, params } = entry;
  const fields = [];
  if (target) fields.push({ name: 'target', value: `\`${String(target).slice(0, 200)}\``, inline: true });
  fields.push({ name: 'actor', value: String(actor).slice(0, 100), inline: true });
  if (params && Object.keys(params).length) {
    const body = redact(JSON.stringify(params, null, 0));
    fields.push({
      name: 'params',
      value: `\`\`\`json\n${body.slice(0, 900)}${body.length > 900 ? '…' : ''}\n\`\`\``,
    });
  }
  if (detail) {
    fields.push({ name: result === 'error' ? 'error' : 'detail', value: redact(String(detail)).slice(0, 900) });
  }

  try {
    await post(`/channels/${channelId}/messages`, {
      embeds: [
        {
          title: `${SOURCE_ICON[source] ?? '•'}  ${op}`,
          color: COLOR[result] ?? COLOR.ok,
          fields,
          footer: { text: source },
          timestamp: new Date().toISOString(),
        },
      ],
      allowed_mentions: { parse: [] },
    });
    return true;
  } catch {
    return false;
  }
}

/** Write the row, then post the embed without making the caller wait on Discord. */
export function log(entry) {
  const id = record(entry);
  publish(entry).catch(() => {});
  return id;
}

export function tail(limit = 25, { source, result } = {}) {
  const clauses = [];
  const params = [];
  if (source) {
    clauses.push('source = ?');
    params.push(source);
  }
  if (result) {
    clauses.push('result = ?');
    params.push(result);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(
    `SELECT * FROM audit ${where} ORDER BY id DESC LIMIT ?`,
    ...params,
    Math.min(Number(limit) || 25, 200),
  );
}

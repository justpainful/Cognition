// Shared plumbing for every Classifer tool.
//
// One wrapper handles the three things every tool must do identically: write an
// audit row, turn a thrown error into a message worth reading, and keep the
// return shape consistent.
//
// On where the audit goes: every call — read or write — becomes a row in the
// audit table, so the trail is complete and queryable. Only calls that *changed*
// something also post an embed to #command-log. A read-only inspection posted to
// Discord would bury the changes under noise, and the channel exists to show
// what happened to the server, not what was looked at.

import { z } from 'zod';
import { record, publish } from '../../shared/audit.js';
import { redact } from '../../shared/env.js';
import { DiscordError } from '../../shared/rest.js';

export { z };

export const registry = [];

/**
 * @param spec.name      tool name as Claude sees it
 * @param spec.mutating  true if it changes the server or the Registry
 * @param spec.schema    a plain object of zod validators (a ZodRawShape)
 * @param spec.run       async (args) => string | {text, target, params}
 */
export function tool(spec) {
  registry.push(spec);
  return spec;
}

/** Human-facing text for a failure, with the useful part kept. */
export function explain(error) {
  if (error instanceof DiscordError) {
    const body = error.body;
    const apiMsg = body && typeof body === 'object' ? body.message : null;
    const code = body && typeof body === 'object' ? body.code : null;

    if (error.status === 403) {
      return (
        `Discord refused this (403${code ? `, code ${code}` : ''})${apiMsg ? `: ${apiMsg}` : ''}. ` +
        `Cognition has Administrator, so a 403 here usually means the target is above the bot's ` +
        `role in the hierarchy, or it is a managed role that nothing can edit.`
      );
    }
    if (error.status === 404) {
      return `Not found (404)${apiMsg ? `: ${apiMsg}` : ''}. The id may be from a different guild, or the object was already deleted.`;
    }
    if (error.status === 400 && body?.errors) {
      return `Discord rejected the request (400): ${apiMsg ?? ''}\n${JSON.stringify(body.errors, null, 2)}`;
    }
    return error.message;
  }
  return redact(error?.message ?? String(error));
}

export async function invoke(spec, args) {
  const started = Date.now();
  try {
    const result = await spec.run(args ?? {});
    const payload = typeof result === 'string' ? { text: result } : result ?? { text: 'done' };

    const entry = {
      source: 'classifer',
      actor: 'claude',
      op: spec.name,
      target: payload.target ?? null,
      params: payload.params ?? (Object.keys(args ?? {}).length ? args : null),
      result: payload.result ?? 'ok',
      detail: payload.detail ?? null,
      snapshotId: payload.snapshotId ?? null,
    };

    record(entry);
    if (spec.mutating && payload.skipPublish !== true) publish(entry).catch(() => {});

    const ms = Date.now() - started;
    return {
      content: [{ type: 'text', text: `${payload.text}${ms > 2000 ? `\n\n(${(ms / 1000).toFixed(1)}s)` : ''}` }],
    };
  } catch (error) {
    const detail = explain(error);
    const entry = {
      source: 'classifer',
      actor: 'claude',
      op: spec.name,
      target: args?.channel_id ?? args?.role_id ?? args?.id ?? null,
      params: Object.keys(args ?? {}).length ? args : null,
      result: 'error',
      detail,
    };
    record(entry);
    if (spec.mutating) publish(entry).catch(() => {});

    return { content: [{ type: 'text', text: `Failed: ${detail}` }], isError: true };
  }
}

// ---- formatting -----------------------------------------------------------

export function table(rows, columns) {
  if (!rows.length) return '(none)';
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => String(c.get(r) ?? '').length)),
  );
  const line = (cells) => cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ');
  return [
    line(columns.map((c) => c.header)),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(columns.map((c) => c.get(r)))),
  ].join('\n');
}

export function json(value) {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

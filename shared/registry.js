// Registry access. Every behaviour in the server is a row reachable from here.
//
// The bot reads this on each interaction and never caches, which is what makes
// "add a button by writing a row" work with no restart and no redeploy.

import { all, one, run, nowIso, parseJson } from './store.js';
import { newKey } from './customid.js';

// ---- actions --------------------------------------------------------------

export const ACTION_KINDS = [
  'reply',
  'modal_open',
  'channel_create',
  'channel_edit',
  'channel_delete',
  'role_grant',
  'role_revoke',
  'overwrite_set',
  'message_send',
  'panel_send',
  'thread_create',
  'session_op',
  'sequence',
  'branch',
  'log',
];

// Anything that cannot be undone by writing state back. These force the
// two-step confirmation path no matter how the action was reached.
export const DESTRUCTIVE_KINDS = new Set(['channel_delete']);

function rowToAction(row) {
  if (!row) return null;
  return {
    key: row.key,
    kind: row.kind,
    params: parseJson(row.params, {}),
    requires: parseJson(row.requires, null),
    confirm: !!row.confirm,
    note: row.note ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAction(key) {
  return rowToAction(one('SELECT * FROM action WHERE key = ?', key));
}

export function listActions() {
  return all('SELECT * FROM action ORDER BY key').map(rowToAction);
}

export function putAction({ key, kind, params = {}, requires = null, confirm, note = null }) {
  if (!key) throw new Error('action needs a key');
  if (!ACTION_KINDS.includes(kind)) {
    throw new Error(`Unknown action kind "${kind}". Known kinds: ${ACTION_KINDS.join(', ')}`);
  }
  const forced = DESTRUCTIVE_KINDS.has(kind);
  const at = nowIso();
  run(
    `INSERT INTO action (key, kind, params, requires, confirm, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       kind = excluded.kind, params = excluded.params, requires = excluded.requires,
       confirm = excluded.confirm, note = excluded.note, updated_at = excluded.updated_at`,
    key,
    kind,
    JSON.stringify(params ?? {}),
    requires ? JSON.stringify(requires) : null,
    forced || confirm ? 1 : 0,
    note,
    at,
    at,
  );
  return getAction(key);
}

export function deleteAction(key) {
  const existing = getAction(key);
  if (existing) run('DELETE FROM action WHERE key = ?', key);
  return existing;
}

// ---- components -----------------------------------------------------------

function rowToComponent(row) {
  if (!row) return null;
  return {
    key: row.key,
    kind: row.kind,
    actionKey: row.action_key,
    spec: parseJson(row.spec, {}),
    sessionId: row.session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getComponent(key) {
  return rowToComponent(one('SELECT * FROM component WHERE key = ?', key));
}

export function listComponents({ sessionId } = {}) {
  const rows =
    sessionId === undefined
      ? all('SELECT * FROM component ORDER BY created_at')
      : all('SELECT * FROM component WHERE session_id IS ? ORDER BY created_at', sessionId);
  return rows.map(rowToComponent);
}

export function putComponent({ key, kind = 'button', actionKey, spec = {}, sessionId = null }) {
  if (!actionKey) throw new Error('component needs an actionKey');
  if (!getAction(actionKey)) {
    throw new Error(
      `component points at action "${actionKey}", which does not exist. Create the action first.`,
    );
  }
  const id = key || newKey();
  const at = nowIso();
  run(
    `INSERT INTO component (key, kind, action_key, spec, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       kind = excluded.kind, action_key = excluded.action_key, spec = excluded.spec,
       session_id = excluded.session_id, updated_at = excluded.updated_at`,
    id,
    kind,
    actionKey,
    JSON.stringify(spec ?? {}),
    sessionId,
    at,
    at,
  );
  return getComponent(id);
}

export function deleteComponent(key) {
  const existing = getComponent(key);
  if (existing) run('DELETE FROM component WHERE key = ?', key);
  return existing;
}

// ---- sessions -------------------------------------------------------------

export const SESSION_STATES = ['building', 'testing', 'promoted', 'archived', 'closed'];

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    categoryId: row.category_id ?? null,
    threadId: row.thread_id ?? null,
    channels: parseJson(row.channels, []),
    meta: parseJson(row.meta, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getSession(id) {
  return rowToSession(one('SELECT * FROM session WHERE id = ?', id));
}

export function getSessionByName(name) {
  return rowToSession(one('SELECT * FROM session WHERE name = ? ORDER BY id DESC LIMIT 1', name));
}

export function listSessions({ state } = {}) {
  const rows = state
    ? all('SELECT * FROM session WHERE state = ? ORDER BY id DESC', state)
    : all('SELECT * FROM session ORDER BY id DESC');
  return rows.map(rowToSession);
}

export function createSession({ name, state = 'building', categoryId = null, channels = [], meta = {} }) {
  const at = nowIso();
  const res = run(
    `INSERT INTO session (name, state, category_id, channels, meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    name,
    state,
    categoryId,
    JSON.stringify(channels),
    JSON.stringify(meta),
    at,
    at,
  );
  return getSession(Number(res.lastInsertRowid));
}

export function updateSession(id, patch = {}) {
  const current = getSession(id);
  if (!current) throw new Error(`No session ${id}`);
  if (patch.state && !SESSION_STATES.includes(patch.state)) {
    throw new Error(`Unknown session state "${patch.state}". Known: ${SESSION_STATES.join(', ')}`);
  }
  run(
    `UPDATE session SET name = ?, state = ?, category_id = ?, thread_id = ?, channels = ?, meta = ?, updated_at = ?
     WHERE id = ?`,
    patch.name ?? current.name,
    patch.state ?? current.state,
    patch.categoryId !== undefined ? patch.categoryId : current.categoryId,
    patch.threadId !== undefined ? patch.threadId : current.threadId,
    JSON.stringify(patch.channels ?? current.channels),
    JSON.stringify({ ...current.meta, ...(patch.meta ?? {}) }),
    nowIso(),
    id,
  );
  return getSession(id);
}

// ---- schedules ------------------------------------------------------------

function rowToSchedule(row) {
  if (!row) return null;
  return {
    key: row.key,
    cron: row.cron,
    actionKey: row.action_key,
    context: parseJson(row.context, {}),
    enabled: !!row.enabled,
    lastRunAt: row.last_run_at ?? null,
    lastStatus: row.last_status ?? null,
    note: row.note ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getSchedule(key) {
  return rowToSchedule(one('SELECT * FROM schedule WHERE key = ?', key));
}

export function listSchedules({ enabledOnly = false } = {}) {
  const rows = enabledOnly
    ? all('SELECT * FROM schedule WHERE enabled = 1 ORDER BY key')
    : all('SELECT * FROM schedule ORDER BY key');
  return rows.map(rowToSchedule);
}

export function putSchedule({ key, cron, actionKey, context = {}, enabled = true, note = null }) {
  if (!key) throw new Error('schedule needs a key');
  if (!getAction(actionKey)) {
    throw new Error(`schedule points at action "${actionKey}", which does not exist.`);
  }
  const at = nowIso();
  run(
    `INSERT INTO schedule (key, cron, action_key, context, enabled, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       cron = excluded.cron, action_key = excluded.action_key, context = excluded.context,
       enabled = excluded.enabled, note = excluded.note, updated_at = excluded.updated_at`,
    key,
    cron,
    actionKey,
    JSON.stringify(context ?? {}),
    enabled ? 1 : 0,
    note,
    at,
    at,
  );
  return getSchedule(key);
}

export function deleteSchedule(key) {
  const existing = getSchedule(key);
  if (existing) run('DELETE FROM schedule WHERE key = ?', key);
  return existing;
}

export function markScheduleRun(key, status) {
  run('UPDATE schedule SET last_run_at = ?, last_status = ? WHERE key = ?', nowIso(), status, key);
}

// The Registry store. node:sqlite ships with Node 22.5+, so there is no native
// module to compile and nothing to go wrong on Windows.
//
// Two processes touch this file — the Cognition bot reads it on every
// interaction, Classifer writes it whenever Claude changes something — so WAL
// mode is not optional here.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { DATA_DIR, DB_PATH } from './env.js';

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS action (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  params     TEXT NOT NULL DEFAULT '{}',
  requires   TEXT,
  confirm    INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS component (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  action_key TEXT NOT NULL,
  spec       TEXT NOT NULL DEFAULT '{}',
  session_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  state       TEXT NOT NULL,
  category_id TEXT,
  thread_id   TEXT,
  channels    TEXT NOT NULL DEFAULT '[]',
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule (
  key         TEXT PRIMARY KEY,
  cron        TEXT NOT NULL,
  action_key  TEXT NOT NULL,
  context     TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trigger (
  key           TEXT PRIMARY KEY,
  event         TEXT NOT NULL,
  filter        TEXT NOT NULL DEFAULT '{}',
  action_key    TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  last_fired_at TEXT,
  fire_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trigger_event_idx ON trigger (event, enabled);

CREATE TABLE IF NOT EXISTS counter (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  source      TEXT NOT NULL,
  actor       TEXT,
  op          TEXT NOT NULL,
  target      TEXT,
  params      TEXT,
  result      TEXT NOT NULL,
  detail      TEXT,
  snapshot_id INTEGER
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit (at DESC);

CREATE TABLE IF NOT EXISTS snapshot (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  target_id   TEXT,
  label       TEXT,
  state       TEXT NOT NULL,
  restored_at TEXT
);
CREATE INDEX IF NOT EXISTS snapshot_at_idx ON snapshot (at DESC);

CREATE TABLE IF NOT EXISTS pending_op (
  token       TEXT PRIMARY KEY,
  op          TEXT NOT NULL,
  op_hash     TEXT NOT NULL,
  params      TEXT NOT NULL,
  preview     TEXT NOT NULL,
  snapshot_id INTEGER,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function getDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/**
 * Close the database. Short-lived scripts should call this before exiting:
 * calling process.exit() with an open node:sqlite handle trips a libuv assertion
 * on Windows, which looks like a crash even though the work already succeeded.
 */
export function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* already closed */
  }
  db = null;
}

export function nowIso() {
  return new Date().toISOString();
}

export function all(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}

export function one(sql, ...params) {
  return getDb().prepare(sql).get(...params) ?? null;
}

export function run(sql, ...params) {
  return getDb().prepare(sql).run(...params);
}

// SQLite has no JSON type, so every structured column is stored as text and
// parsed on the way out. Bad JSON in a row should never take the bot down.
export function parseJson(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function getSetting(key, fallback = null) {
  const row = one('SELECT value FROM setting WHERE key = ?', key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  run(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    String(value),
  );
}

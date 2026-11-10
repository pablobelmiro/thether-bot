/**
 * SQLite via node:sqlite (no native build step → easy install).
 * Migrations are append-only: add a new entry, never edit an old one.
 */

import './quiet-sqlite-warning.js'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE allowed_phones (
    phone      TEXT PRIMARY KEY,
    label      TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE telegram_users (
    user_id           INTEGER PRIMARY KEY,
    phone             TEXT NOT NULL,
    chat_id           INTEGER NOT NULL,
    locale            TEXT,
    active_session_id TEXT,
    verified_at       INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    tmux_session      TEXT NOT NULL UNIQUE,
    cwd               TEXT NOT NULL,
    permission_mode   TEXT NOT NULL,
    origin            TEXT NOT NULL,
    claude_session_id TEXT,
    transcript_path   TEXT,
    usage_json        TEXT,
    created_at        INTEGER NOT NULL,
    last_activity     INTEGER NOT NULL
  );

  CREATE TABLE usage_points (
    ts            INTEGER NOT NULL,
    session_id    TEXT NOT NULL,
    context_pct   REAL NOT NULL,
    five_hour_pct REAL,
    seven_day_pct REAL
  );
  CREATE INDEX usage_points_ts ON usage_points(ts);

  CREATE TABLE activity (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    tool       TEXT,
    summary    TEXT NOT NULL
  );
  CREATE INDEX activity_ts ON activity(ts);

  CREATE TABLE inbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    text       TEXT NOT NULL,
    ts         INTEGER NOT NULL
  );

  CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE audit (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  );

  CREATE TABLE projects (
    path      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    last_used INTEGER NOT NULL
  );
  `,
  // 2 — sessions paused on purpose by the user
  `
  ALTER TABLE sessions ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
  `,
  // 3 — stable working directory sessions are grouped by
  `
  ALTER TABLE sessions ADD COLUMN workspace TEXT;
  `,
  // 4 — scheduled tasks
  `
  CREATE TABLE schedules (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    prompt           TEXT NOT NULL,
    cwd              TEXT NOT NULL,
    kind             TEXT NOT NULL,
    interval_minutes INTEGER,
    weekdays         TEXT,
    time_of_day      TEXT,
    notify_phone     TEXT NOT NULL,
    timeout_minutes  INTEGER NOT NULL,
    preserve_session INTEGER NOT NULL DEFAULT 0,
    enabled          INTEGER NOT NULL DEFAULT 1,
    disabled_reason  TEXT,
    next_run         INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE schedule_runs (
    id          TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    session_id  TEXT,
    status      TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    waited_ms   INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    delivered   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule_id);
  CREATE INDEX schedule_runs_started ON schedule_runs(started_at);
  CREATE INDEX schedule_runs_session ON schedule_runs(session_id);

  ALTER TABLE sessions ADD COLUMN scheduled_run_id TEXT;
  `,
]

export type DB = DatabaseSync

export function openDatabase(file: string): DB {
  const fresh = !existsSync(file)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  if (fresh) chmodSync(file, 0o600)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
  migrate(db)
  return db
}

function migrate(db: DB): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}

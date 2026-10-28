import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- Where steps may call: an OpenAsy product with an API token, or a Slack, Teams or other webhook. Calls go to these
   -- addresses only. The token, and a webhook URL that holds its own key, are sealed with openasy-kek (ADR 0060).
   CREATE TABLE connections (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL CHECK (kind IN ('openasy', 'slack', 'teams', 'webhook')),
     product TEXT,
     url TEXT NOT NULL,
     token TEXT,
     created_at TEXT NOT NULL
   );
   -- A playbook: what starts it, the condition on the event, and its steps, as JSON checked when saved.
   CREATE TABLE playbooks (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     description TEXT NOT NULL DEFAULT '',
     enabled INTEGER NOT NULL DEFAULT 1,
     trigger TEXT NOT NULL,
     conditions TEXT NOT NULL,
     steps TEXT NOT NULL,
     -- The SHA-256 of the token a webhook trigger is called with; the token itself is shown once.
     hook_hash TEXT,
     next_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL
   );
   CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     playbook_id TEXT NOT NULL REFERENCES playbooks (id) ON DELETE CASCADE,
     -- The playbook as it was when the run started, so editing it never changes a run.
     definition TEXT NOT NULL,
     cause TEXT NOT NULL CHECK (cause IN ('webhook', 'schedule', 'manual')),
     event TEXT NOT NULL,
     dry INTEGER NOT NULL DEFAULT 0,
     state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'succeeded', 'failed', 'refused')),
     started_at TEXT NOT NULL,
     ended_at TEXT,
     started_by TEXT NOT NULL
   );
   CREATE INDEX runs_started ON runs (started_at);
   CREATE INDEX runs_playbook ON runs (playbook_id, started_at);
   -- Each step of a run: what was sent, what came back, how long it took, or who approved it.
   CREATE TABLE run_steps (
     run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     step_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('ok', 'failed', 'skipped', 'planned', 'waiting', 'approved', 'refused')),
     request TEXT,
     response TEXT,
     output TEXT,
     error TEXT,
     started_at TEXT NOT NULL,
     ms INTEGER,
     decided_by TEXT,
     comment TEXT,
     PRIMARY KEY (run_id, position)
   ) WITHOUT ROWID`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}

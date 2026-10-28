import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "automation-")), "nested", "automation.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();
    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
    second.close();
  });

  it("deletes a playbook's runs and their steps with it", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO playbooks (id, name, trigger, conditions, steps, created_at, updated_at, updated_by) VALUES ('p', 'P', '{}', '[]', '[]', 'n', 'n', 'me')",
    ).run();
    db.prepare(
      "INSERT INTO runs (id, playbook_id, definition, cause, event, state, started_at, started_by) VALUES ('r', 'p', '{}', 'manual', '{}', 'succeeded', 'n', 'me')",
    ).run();
    db.prepare("INSERT INTO run_steps (run_id, position, step_id, kind, state, started_at) VALUES ('r', 0, 'a', 'approval', 'approved', 'n')").run();
    db.prepare("DELETE FROM playbooks").run();
    expect(db.prepare("SELECT (SELECT COUNT(*) FROM runs) + (SELECT COUNT(*) FROM run_steps) AS n").get()).toEqual({ n: 0 });
  });
});

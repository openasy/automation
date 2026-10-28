import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Sealer } from "./seal.ts";
import { buildRequest, parseSteps, shown, type ConnectionKind, type Request, type Step, type Target } from "./steps.ts";
import { COND_OPS, holds, render, type Condition } from "./templates.ts";

export type ProblemCode =
  "invalid-token" | "invalid-json" | "invalid-body" | "not-found" | "conflict" | "not-configured" | "payload-too-large" | "internal-error";

export class AutomationError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

const bad = (detail: string) => new AutomationError(422, "invalid-body", detail);
const notFound = (what: string) => new AutomationError(404, "not-found", `${what} does not exist.`);
const DAY_MS = 86_400_000;
const KINDS: readonly ConnectionKind[] = ["openasy", "slack", "teams", "webhook"];
/** Products whose built-in steps a connection can serve; any other OpenAsy product works with http steps. */
const PRODUCT = /^[a-z][a-z0-9-]{1,30}$/;
/** Largest answer kept of a step, in characters. */
const KEPT = 16_000;

export type RunState = "running" | "waiting" | "succeeded" | "failed" | "refused";
export type StepState = "ok" | "failed" | "skipped" | "planned" | "waiting" | "approved" | "refused";
export type Trigger = { kind: "webhook" } | { kind: "schedule"; everyMinutes: number } | { kind: "manual" };

export interface Page<T> {
  items: T[];
  /** Opaque; pass it back as `cursor` for the next page. Absent on the last page (ADR 0024). */
  nextCursor?: string;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isSafeInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw bad("cursor is not one this API returned.");
}

export function parseLimit(value: string | null, max = 500, fallback = 100): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`limit must be between 1 and ${max}.`);
  return n;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

export interface Connection {
  id: string;
  name: string;
  kind: ConnectionKind;
  product: string | null;
  /** For a product, its address; for Slack, Teams and webhooks only the host, as the rest of the URL is a key. */
  address: string;
  hasToken: boolean;
  playbooks: number;
  createdAt: string;
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: Trigger;
  conditions: Condition[];
  steps: Step[];
  nextAt: string | null;
  lastRun: { id: string; state: RunState; startedAt: string } | null;
  runs30Days: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface RunStep {
  position: number;
  stepId: string;
  kind: string;
  state: StepState;
  request: unknown;
  response: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  ms: number | null;
  decidedBy: string | null;
  comment: string | null;
}

export interface Run {
  id: string;
  playbook: { id: string; name: string };
  cause: "webhook" | "schedule" | "manual";
  dry: boolean;
  state: RunState;
  startedAt: string;
  endedAt: string | null;
  startedBy: string;
  steps: number;
  /** The step waiting for a person, if any. */
  waiting: { stepId: string; text: string } | null;
}

export interface AutomationOptions {
  sealer: Sealer;
  clock?: () => number;
  fetch?: typeof fetch;
  retentionDays?: number;
  /** Seconds a step's call may take. */
  timeoutSeconds?: number;
}

type Row = Record<string, SQLInputValue>;

export function createAutomation(
  db: DatabaseSync,
  { sealer, clock = Date.now, fetch: http = fetch, retentionDays = 90, timeoutSeconds = 15 }: AutomationOptions,
) {
  const iso = (ms = clock()) => new Date(ms).toISOString();
  const inFlight = new Set<Promise<void>>();

  // A run that was going when the process stopped did not finish its step; say so rather than leave it running.
  db.prepare("UPDATE runs SET state = 'failed', ended_at = ? WHERE state = 'running'").run(iso());

  // ---------------------------------------------------------------- connections

  const connectionRows = () => db.prepare("SELECT * FROM connections ORDER BY name").all() as Row[];

  function usage(): Map<string, number> {
    const n = new Map<string, number>();
    for (const r of db.prepare("SELECT steps FROM playbooks").all() as Row[])
      for (const c of new Set((JSON.parse(r.steps as string) as Step[]).map((s) => s.connection).filter(Boolean))) n.set(c!, (n.get(c!) ?? 0) + 1);
    return n;
  }

  function toConnection(r: Row, used: Map<string, number>): Connection {
    const kind = r.kind as ConnectionKind;
    const url = sealer.open(r.url as string);
    return {
      id: r.id as string,
      name: r.name as string,
      kind,
      product: (r.product as string | null) ?? null,
      address: kind === "openasy" ? url : new URL(url).origin,
      hasToken: Boolean(r.token),
      playbooks: used.get(r.id as string) ?? 0,
      createdAt: r.created_at as string,
    };
  }

  function target(connectionId: string): Target {
    const r = db.prepare("SELECT * FROM connections WHERE id = ?").get(connectionId) as Row | undefined;
    if (!r) throw new Error(`The connection ${connectionId} was deleted.`);
    return {
      id: r.id as string,
      kind: r.kind as ConnectionKind,
      product: (r.product as string | null) ?? null,
      url: sealer.open(r.url as string),
      token: r.token ? sealer.open(r.token as string) : null,
    };
  }

  function connectionFields(body: Record<string, unknown>, kind: ConnectionKind, partial: boolean) {
    const out: { name?: string; url?: string; token?: string | null; product?: string | null } = {};
    if (body.name !== undefined || !partial) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80) throw bad("name is required, at most 80 characters.");
      out.name = body.name.trim();
    }
    if (body.url !== undefined || !partial) {
      if (typeof body.url !== "string" || !URL.canParse(body.url)) throw bad("url must be an address, such as https://incidents.example.com.");
      const u = new URL(body.url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw bad("url must be http or https.");
      // Plain http only on this machine, as for a local relay; a webhook URL holds its key and must not cross a network in clear.
      if (kind !== "openasy" && u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
        throw bad("A Slack, Teams or webhook URL must be https.");
      if (u.username || u.password) throw bad("url must not hold a user or password; use token.");
      out.url = kind === "openasy" ? u.origin + u.pathname.replace(/\/$/, "") : u.href;
    }
    if (kind === "openasy") {
      if (body.product !== undefined || !partial) {
        if (typeof body.product !== "string" || !PRODUCT.test(body.product)) throw bad("product is the product's id, such as incidents or vpn.");
        out.product = body.product;
      }
      if (body.token !== undefined || !partial) {
        if (typeof body.token !== "string" || body.token.length < 8 || body.token.length > 500)
          throw bad("token is an API token of that product, such as oa_incidents_….");
        out.token = body.token;
      }
    } else if (body.token !== undefined && body.token !== null) throw bad("Only OpenAsy connections take a token; a webhook URL holds its own key.");
    return out;
  }

  // ---------------------------------------------------------------- playbooks

  function parseTrigger(raw: unknown): Trigger {
    const t = raw as { kind?: unknown; everyMinutes?: unknown } | null;
    if (!t || typeof t !== "object") throw bad("trigger is { kind: webhook }, { kind: schedule, everyMinutes } or { kind: manual }.");
    if (t.kind === "webhook" || t.kind === "manual") return { kind: t.kind };
    if (t.kind === "schedule") {
      const n = Number(t.everyMinutes);
      if (!Number.isInteger(n) || n < 5 || n > 10080) throw bad("trigger.everyMinutes is 5 to 10080, a week.");
      return { kind: "schedule", everyMinutes: n };
    }
    throw bad("trigger.kind is webhook, schedule or manual.");
  }

  function parseConditions(raw: unknown): Condition[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > 20) throw bad("conditions is a list of at most 20 { field, op, value }.");
    return raw.map((c, i) => {
      const x = c as Partial<Condition> | null;
      if (!x || typeof x.field !== "string" || !/^[a-zA-Z0-9_.-]{1,200}$/.test(x.field))
        throw bad(`conditions[${i}].field is a path in the event, such as signal.severity.`);
      if (!COND_OPS.includes(x.op as never)) throw bad(`conditions[${i}].op is one of ${COND_OPS.join(", ")}.`);
      if (x.op !== "exists" && typeof x.value !== "string") throw bad(`conditions[${i}].value is text.`);
      if (x.op === "matches")
        try {
          new RegExp(x.value!);
        } catch {
          throw bad(`conditions[${i}].value is not a regular expression.`);
        }
      if (x.op === "at-least" && !Number.isFinite(Number(x.value))) throw bad(`conditions[${i}].value is a number.`);
      return { field: x.field, op: x.op!, ...(x.op !== "exists" && { value: x.value }) };
    });
  }

  function definition(body: Record<string, unknown>) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120) throw bad("name is required, at most 120 characters.");
    if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 2000))
      throw bad("description is text of at most 2000 characters.");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw bad("enabled must be true or false.");
    const trigger = parseTrigger(body.trigger);
    const conditions = parseConditions(body.conditions);
    let steps: Step[];
    try {
      steps = parseSteps(
        body.steps,
        connectionRows().map((r) => ({ id: r.id as string, kind: r.kind as ConnectionKind, product: (r.product as string | null) ?? null })),
      );
    } catch (err) {
      throw bad((err as Error).message);
    }
    return {
      name: body.name.trim(),
      description: (body.description as string | undefined)?.trim() ?? "",
      enabled: body.enabled !== false,
      trigger,
      conditions,
      steps,
    };
  }

  function toPlaybook(r: Row): Playbook {
    const last = db.prepare("SELECT id, state, started_at FROM runs WHERE playbook_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(r.id as string) as
      Row | undefined;
    const n = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE playbook_id = ? AND started_at >= ?").get(r.id as string, iso(clock() - 30 * DAY_MS)) as {
      n: number;
    };
    return {
      id: r.id as string,
      name: r.name as string,
      description: r.description as string,
      enabled: r.enabled === 1,
      trigger: JSON.parse(r.trigger as string) as Trigger,
      conditions: JSON.parse(r.conditions as string) as Condition[],
      steps: JSON.parse(r.steps as string) as Step[],
      nextAt: (r.next_at as string | null) ?? null,
      lastRun: last ? { id: last.id as string, state: last.state as RunState, startedAt: last.started_at as string } : null,
      runs30Days: n.n,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      updatedBy: r.updated_by as string,
    };
  }

  const playbookRow = (pid: string) => {
    const r = db.prepare("SELECT * FROM playbooks WHERE id = ?").get(pid) as Row | undefined;
    if (!r) throw notFound("The playbook");
    return r;
  };

  const nextAt = (t: Trigger) => (t.kind === "schedule" ? iso(clock() + t.everyMinutes * 60_000) : null);

  // ---------------------------------------------------------------- runs

  function toRun(r: Row): Run {
    const waiting = db.prepare("SELECT step_id, request FROM run_steps WHERE run_id = ? AND state = 'waiting'").get(r.id as string) as Row | undefined;
    const steps = (db.prepare("SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ?").get(r.id as string) as { n: number }).n;
    return {
      id: r.id as string,
      playbook: { id: r.playbook_id as string, name: (JSON.parse(r.definition as string) as { name: string }).name },
      cause: r.cause as Run["cause"],
      dry: r.dry === 1,
      state: r.state as RunState,
      startedAt: r.started_at as string,
      endedAt: (r.ended_at as string | null) ?? null,
      startedBy: r.started_by as string,
      steps,
      waiting: waiting ? { stepId: waiting.step_id as string, text: (JSON.parse(waiting.request as string) as { text: string }).text } : null,
    };
  }

  function toStep(r: Row): RunStep {
    const parse = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : (JSON.parse(v as string) as unknown));
    return {
      position: Number(r.position),
      stepId: r.step_id as string,
      kind: r.kind as string,
      state: r.state as StepState,
      request: parse(r.request),
      response: parse(r.response),
      output: parse(r.output),
      error: (r.error as string | null) ?? null,
      startedAt: r.started_at as string,
      ms: r.ms === null ? null : Number(r.ms),
      decidedBy: (r.decided_by as string | null) ?? null,
      comment: (r.comment as string | null) ?? null,
    };
  }

  const recordStep = (
    runId: string,
    position: number,
    step: Step,
    state: StepState,
    fields: { request?: unknown; response?: unknown; output?: unknown; error?: string; ms?: number },
  ) =>
    db
      .prepare(
        "INSERT INTO run_steps (run_id, position, step_id, kind, state, request, response, output, error, started_at, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        position,
        step.id,
        step.kind,
        state,
        fields.request === undefined ? null : JSON.stringify(fields.request),
        fields.response === undefined ? null : JSON.stringify(fields.response),
        fields.output === undefined ? null : JSON.stringify(fields.output),
        fields.error ?? null,
        iso(),
        fields.ms ?? null,
      );

  const finish = (runId: string, state: RunState) => db.prepare("UPDATE runs SET state = ?, ended_at = ? WHERE id = ?").run(state, iso(), runId);

  /** Sends a request and reads the answer, as JSON when it is. */
  async function send(r: Request): Promise<{ status: number; body: unknown; ms: number }> {
    const started = performance.now();
    const res = await http(r.url, {
      method: r.method,
      headers: { "user-agent": "openasy-automation", ...r.headers },
      ...(r.body !== undefined && { body: JSON.stringify(r.body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    const text = (await res.text()).slice(0, KEPT);
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: kept as text.
    }
    return { status: res.status, body, ms: Math.round(performance.now() - started) };
  }

  /** The request as it is kept and shown: no token, and of a Slack, Teams or webhook URL only the host. */
  const kept = (r: Request, t: Target) => ({ ...shown(r), ...(t.kind !== "openasy" && { url: `${new URL(r.url).origin}/…` }) });

  /** Runs the steps of a run from `from`, until one waits for a person, fails or the last is done. */
  async function execute(runId: string, from: number): Promise<void> {
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Row;
    const def = JSON.parse(run.definition as string) as { id: string; name: string; steps: Step[] };
    const dry = run.dry === 1;
    const outputs: Record<string, unknown> = {};
    for (const r of db.prepare("SELECT step_id, output FROM run_steps WHERE run_id = ? AND position < ?").all(runId, from) as Row[])
      outputs[r.step_id as string] = r.output ? JSON.parse(r.output as string) : null;
    const scope = { event: JSON.parse(run.event as string) as unknown, steps: outputs, run: { id: runId, dry }, playbook: { id: def.id, name: def.name } };
    let failed = false;
    for (let i = from; i < def.steps.length; i++) {
      const step = def.steps[i]!;
      if (step.kind === "approval") {
        const text = render(step.text!, scope);
        if (dry) {
          recordStep(runId, i, step, "planned", { request: { text } });
          continue;
        }
        recordStep(runId, i, step, "waiting", { request: { text } });
        db.prepare("UPDATE runs SET state = 'waiting' WHERE id = ?").run(runId);
        return;
      }
      let t: Target;
      let request: Request;
      try {
        t = target(step.connection!);
        request = buildRequest(step, t, scope);
      } catch (err) {
        // A dry run has no answers of earlier steps to fill templates with; say what would be sent where it can.
        recordStep(runId, i, step, dry ? "planned" : "failed", { error: (err as Error).message });
        if (dry) continue;
        failed = true;
        if (step.continueOnError) continue;
        break;
      }
      if (dry) {
        recordStep(runId, i, step, "planned", { request: kept(request, t) });
        continue;
      }
      try {
        const res = await send(request);
        const ok = res.status >= 200 && res.status < 300;
        const output = res.body && typeof res.body === "object" ? res.body : { status: res.status };
        outputs[step.id] = output;
        const message = !ok ? describe(res.status, res.body) : undefined;
        recordStep(runId, i, step, ok ? "ok" : "failed", {
          request: kept(request, t),
          response: { status: res.status, body: res.body },
          output,
          ms: res.ms,
          ...(message && { error: message }),
        });
        if (!ok) {
          failed = true;
          if (!step.continueOnError) break;
        }
      } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        recordStep(runId, i, step, "failed", {
          request: kept(request, t),
          error: e.name === "TimeoutError" ? `No answer in ${timeoutSeconds} s.` : (e.cause?.code ?? e.message),
        });
        failed = true;
        if (!step.continueOnError) break;
      }
    }
    // Steps after one that failed and stopped the run are kept as skipped, so the run shows all of the playbook.
    const done = (db.prepare("SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ?").get(runId) as { n: number }).n;
    for (let i = done; i < def.steps.length; i++) recordStep(runId, i, def.steps[i]!, "skipped", {});
    finish(runId, failed ? "failed" : "succeeded");
  }

  function describe(status: number, body: unknown): string {
    const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
    if (status === 401) return "The product refused the token: make a new one and change the connection.";
    if (status === 403) return "The token's role may not do this: it needs a higher role in that product.";
    return `Answered ${status}${typeof detail === "string" ? `: ${detail}` : "."}`;
  }

  const track = (p: Promise<void>) => {
    const q = p.catch(() => {}).finally(() => inFlight.delete(q));
    inFlight.add(q);
  };

  function start(p: Row, cause: Run["cause"], event: unknown, actor: string, dry: boolean): Run {
    const runId = id("run");
    const def = { id: p.id, name: p.name, steps: JSON.parse(p.steps as string) as Step[] };
    db.prepare(
      "INSERT INTO runs (id, playbook_id, definition, cause, event, dry, state, started_at, started_by) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)",
    ).run(runId, p.id as string, JSON.stringify(def), cause, JSON.stringify(event ?? {}), dry ? 1 : 0, iso(), actor);
    track(
      execute(runId, 0).catch(
        (err: unknown) => (db.prepare("UPDATE runs SET state = 'failed', ended_at = ? WHERE id = ?").run(iso(), runId), Promise.reject(err)),
      ),
    );
    return toRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Row);
  }

  return {
    /** Resolves once every run started so far has stopped or waits for a person. For tests and shutdown. */
    async idle(): Promise<void> {
      while (inFlight.size) await Promise.all(inFlight);
    },

    // ---------------------------------------------------------------- connections

    connections(): Connection[] {
      const used = usage();
      return connectionRows().map((r) => toConnection(r, used));
    },

    createConnection(body: Record<string, unknown>): Connection {
      if (!KINDS.includes(body.kind as ConnectionKind)) throw bad(`kind is one of ${KINDS.join(", ")}.`);
      const kind = body.kind as ConnectionKind;
      const f = connectionFields(body, kind, false);
      const cid = id("cn");
      try {
        db.prepare("INSERT INTO connections (id, name, kind, product, url, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          cid,
          f.name!,
          kind,
          f.product ?? null,
          sealer.seal(f.url!),
          f.token ? sealer.seal(f.token) : null,
          iso(),
        );
      } catch (err) {
        if (/UNIQUE/.test(String(err))) throw new AutomationError(409, "conflict", "A connection with this name exists.");
        throw err;
      }
      return this.connections().find((c) => c.id === cid)!;
    },

    updateConnection(cid: string, body: Record<string, unknown>): Connection {
      const r = db.prepare("SELECT * FROM connections WHERE id = ?").get(cid) as Row | undefined;
      if (!r) throw notFound("The connection");
      if (body.kind !== undefined && body.kind !== r.kind) throw bad("The kind of a connection does not change; make a new one.");
      const f = connectionFields(body, r.kind as ConnectionKind, true);
      if (f.product !== undefined && f.product !== r.product && this.connections().find((c) => c.id === cid)!.playbooks)
        throw new AutomationError(409, "conflict", "Playbooks use this connection for its product; make a new connection instead.");
      if (!Object.keys(f).length) throw bad("Send at least one of name, url, product and token.");
      try {
        db.prepare(
          "UPDATE connections SET name = COALESCE(?, name), url = COALESCE(?, url), product = COALESCE(?, product), token = COALESCE(?, token) WHERE id = ?",
        ).run(f.name ?? null, f.url ? sealer.seal(f.url) : null, f.product ?? null, f.token ? sealer.seal(f.token) : null, cid);
      } catch (err) {
        if (/UNIQUE/.test(String(err))) throw new AutomationError(409, "conflict", "A connection with this name exists.");
        throw err;
      }
      return this.connections().find((c) => c.id === cid)!;
    },

    deleteConnection(cid: string): void {
      const c = this.connections().find((x) => x.id === cid);
      if (!c) throw notFound("The connection");
      if (c.playbooks) throw new AutomationError(409, "conflict", `${c.playbooks} playbook(s) use this connection: change them first.`);
      db.prepare("DELETE FROM connections WHERE id = ?").run(cid);
    },

    /** Calls the product with the token, read-only, to show that both work. Slack, Teams and webhooks are not called. */
    async testConnection(cid: string): Promise<{ ok: boolean; status: number | null; detail: string }> {
      const c = this.connections().find((x) => x.id === cid);
      if (!c) throw notFound("The connection");
      if (c.kind !== "openasy") return { ok: true, status: null, detail: "Not called: a test would post a message. Run a playbook dry to see what it sends." };
      const t = target(cid);
      try {
        const res = await send({ method: "GET", url: `${t.url}/api/v1/products`, headers: { authorization: `Bearer ${t.token}` } });
        const ok = res.status === 200;
        return { ok, status: res.status, detail: ok ? "The product answered and took the token." : describe(res.status, res.body) };
      } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        return { ok: false, status: null, detail: e.cause?.code ?? e.message };
      }
    },

    // ---------------------------------------------------------------- playbooks

    playbooks(): Playbook[] {
      return (db.prepare("SELECT * FROM playbooks ORDER BY name").all() as Row[]).map(toPlaybook);
    },

    playbook(pid: string): Playbook {
      return toPlaybook(playbookRow(pid));
    },

    /** Saves a new playbook. A webhook trigger gets a token, shown here once. */
    createPlaybook(body: Record<string, unknown>, actor: string): { playbook: Playbook; webhookToken?: string } {
      const d = definition(body);
      const pid = id("pb");
      const token = d.trigger.kind === "webhook" ? `oah_${randomBytes(24).toString("base64url")}` : undefined;
      try {
        db.prepare(
          "INSERT INTO playbooks (id, name, description, enabled, trigger, conditions, steps, hook_hash, next_at, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          pid,
          d.name,
          d.description,
          d.enabled ? 1 : 0,
          JSON.stringify(d.trigger),
          JSON.stringify(d.conditions),
          JSON.stringify(d.steps),
          token ? hash(token) : null,
          nextAt(d.trigger),
          iso(),
          iso(),
          actor,
        );
      } catch (err) {
        if (/UNIQUE/.test(String(err))) throw new AutomationError(409, "conflict", "A playbook with this name exists.");
        throw err;
      }
      return { playbook: this.playbook(pid), ...(token && { webhookToken: token }) };
    },

    /** Replaces a playbook's definition. Runs already started keep the one they started with. */
    updatePlaybook(pid: string, body: Record<string, unknown>, actor: string): { playbook: Playbook; webhookToken?: string } {
      const r = playbookRow(pid);
      const d = definition(body);
      const before = JSON.parse(r.trigger as string) as Trigger;
      const token = d.trigger.kind === "webhook" && !r.hook_hash ? `oah_${randomBytes(24).toString("base64url")}` : undefined;
      try {
        db.prepare(
          "UPDATE playbooks SET name = ?, description = ?, enabled = ?, trigger = ?, conditions = ?, steps = ?, hook_hash = ?, next_at = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        ).run(
          d.name,
          d.description,
          d.enabled ? 1 : 0,
          JSON.stringify(d.trigger),
          JSON.stringify(d.conditions),
          JSON.stringify(d.steps),
          d.trigger.kind !== "webhook" ? null : token ? hash(token) : (r.hook_hash as string),
          JSON.stringify(before) === JSON.stringify(d.trigger) ? ((r.next_at as string | null) ?? null) : nextAt(d.trigger),
          iso(),
          actor,
          pid,
        );
      } catch (err) {
        if (/UNIQUE/.test(String(err))) throw new AutomationError(409, "conflict", "A playbook with this name exists.");
        throw err;
      }
      return { playbook: this.playbook(pid), ...(token && { webhookToken: token }) };
    },

    deletePlaybook(pid: string): void {
      if (!db.prepare("DELETE FROM playbooks WHERE id = ?").run(pid).changes) throw notFound("The playbook");
    },

    /** A new webhook token; the old one stops working. */
    rotateToken(pid: string): { webhookToken: string } {
      const r = playbookRow(pid);
      if ((JSON.parse(r.trigger as string) as Trigger).kind !== "webhook")
        throw new AutomationError(409, "conflict", "Only a playbook with a webhook trigger has a token.");
      const token = `oah_${randomBytes(24).toString("base64url")}`;
      db.prepare("UPDATE playbooks SET hook_hash = ? WHERE id = ?").run(hash(token), pid);
      return { webhookToken: token };
    },

    // ---------------------------------------------------------------- triggers

    /**
     * An event sent to a playbook's webhook. Unknown playbook and wrong token answer the same, so nothing tells a
     * caller which playbooks exist. An event the conditions do not match starts no run.
     */
    hook(pid: string, token: string | undefined, event: unknown): { matched: boolean; run?: Run } {
      const r = db.prepare("SELECT * FROM playbooks WHERE id = ?").get(pid) as Row | undefined;
      const given = token ? hash(token) : "";
      if (!r || !r.hook_hash || given.length !== (r.hook_hash as string).length || given !== r.hook_hash)
        throw new AutomationError(401, "invalid-token", "Send the playbook's webhook token as a bearer token.");
      if (r.enabled !== 1) throw new AutomationError(409, "conflict", "The playbook is turned off.");
      if (!holds(JSON.parse(r.conditions as string) as Condition[], event)) return { matched: false };
      return { matched: true, run: start(r, "webhook", event, "webhook", false) };
    },

    /** Starts a playbook by hand, with an event to try it on; a dry run sends nothing and shows what would be sent. */
    runNow(pid: string, body: Record<string, unknown>, actor: string): Run {
      const r = playbookRow(pid);
      if (body.dry !== undefined && typeof body.dry !== "boolean") throw bad("dry must be true or false.");
      const event = body.event ?? {};
      if (typeof event !== "object" || event === null || Array.isArray(event)) throw bad("event must be a JSON object.");
      if (JSON.stringify(event).length > 64 * 1024) throw bad("event is at most 64 KiB of JSON.");
      if (body.dry !== true && r.enabled !== 1) throw new AutomationError(409, "conflict", "The playbook is turned off; run it dry, or turn it on.");
      return start(r, "manual", event, actor, body.dry === true);
    },

    /** Starts every scheduled playbook whose time has come. */
    tick(): number {
      const due = db.prepare("SELECT * FROM playbooks WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= ?").all(iso()) as Row[];
      for (const r of due) {
        const t = JSON.parse(r.trigger as string) as Trigger;
        if (t.kind !== "schedule") continue;
        db.prepare("UPDATE playbooks SET next_at = ? WHERE id = ?").run(iso(clock() + t.everyMinutes * 60_000), r.id as string);
        start(r, "schedule", { schedule: { at: iso(), everyMinutes: t.everyMinutes } }, "schedule", false);
      }
      return due.length;
    },

    // ---------------------------------------------------------------- runs and approvals

    runs(filter: { playbook?: string | null; state?: string | null }, cursor: string | undefined, limit: number): Page<Run> {
      if (filter.state && !["running", "waiting", "succeeded", "failed", "refused"].includes(filter.state))
        throw bad("state is running, waiting, succeeded, failed or refused.");
      const where: string[] = [];
      const args: SQLInputValue[] = [];
      if (filter.playbook) (where.push("playbook_id = ?"), args.push(filter.playbook));
      if (filter.state) (where.push("state = ?"), args.push(filter.state));
      const offset = decodeCursor(cursor);
      const rows = db
        .prepare(`SELECT * FROM runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`)
        .all(...args, limit + 1, offset) as Row[];
      return { items: rows.slice(0, limit).map(toRun), ...(rows.length > limit && { nextCursor: encodeCursor(offset + limit) }) };
    },

    run(rid: string): Run & { event: unknown; stepsDone: RunStep[]; definition: { steps: Step[] } } {
      const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(rid) as Row | undefined;
      if (!r) throw notFound("The run");
      return {
        ...toRun(r),
        event: JSON.parse(r.event as string) as unknown,
        stepsDone: (db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY position").all(rid) as Row[]).map(toStep),
        definition: { steps: (JSON.parse(r.definition as string) as { steps: Step[] }).steps },
      };
    },

    approvals(): Run[] {
      return (db.prepare("SELECT * FROM runs WHERE state = 'waiting' ORDER BY started_at").all() as Row[]).map(toRun);
    },

    /** A person approves the step a run waits on, and the run goes on; or refuses it, and the run stops there. */
    decide(rid: string, body: Record<string, unknown>, actor: string): Run {
      const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(rid) as Row | undefined;
      if (!r) throw notFound("The run");
      if (typeof body.approve !== "boolean") throw bad("approve must be true or false.");
      if (body.comment !== undefined && (typeof body.comment !== "string" || body.comment.length > 1000))
        throw bad("comment is text of at most 1000 characters.");
      const step = db.prepare("SELECT position FROM run_steps WHERE run_id = ? AND state = 'waiting'").get(rid) as Row | undefined;
      if (r.state !== "waiting" || !step) throw new AutomationError(409, "conflict", "The run waits for no approval.");
      const position = Number(step.position);
      db.prepare("UPDATE run_steps SET state = ?, decided_by = ?, comment = ?, ms = ? WHERE run_id = ? AND position = ?").run(
        body.approve ? "approved" : "refused",
        actor,
        (body.comment as string | undefined)?.trim() || null,
        Date.parse(iso()) -
          Date.parse((db.prepare("SELECT started_at FROM run_steps WHERE run_id = ? AND position = ?").get(rid, position) as Row).started_at as string),
        rid,
        position,
      );
      if (!body.approve) {
        const def = JSON.parse(r.definition as string) as { steps: Step[] };
        for (let i = position + 1; i < def.steps.length; i++) recordStep(rid, i, def.steps[i]!, "skipped", {});
        finish(rid, "refused");
      } else {
        db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(rid);
        track(execute(rid, position + 1));
      }
      return toRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(rid) as Row);
    },

    // ---------------------------------------------------------------- overview

    summary() {
      const since = iso(clock() - 30 * DAY_MS);
      const byState = Object.fromEntries(
        (db.prepare("SELECT state, COUNT(*) AS n FROM runs WHERE started_at >= ? AND dry = 0 GROUP BY state").all(since) as Row[]).map((r) => [
          r.state as string,
          Number(r.n),
        ]),
      );
      const perDay = new Map(
        (
          db
            .prepare(
              "SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS n, SUM(state = 'failed') AS failed FROM runs WHERE started_at >= ? AND dry = 0 GROUP BY day",
            )
            .all(since) as Row[]
        ).map((r) => [r.day as string, { runs: Number(r.n), failed: Number(r.failed) }]),
      );
      const today = Date.parse(iso().slice(0, 10));
      const playbooks = this.playbooks();
      return {
        playbooks: { total: playbooks.length, enabled: playbooks.filter((p) => p.enabled).length },
        connections: (db.prepare("SELECT COUNT(*) AS n FROM connections").get() as { n: number }).n,
        runs: {
          last30Days: Object.values(byState).reduce((a, b) => a + b, 0),
          succeeded: byState.succeeded ?? 0,
          failed: byState.failed ?? 0,
          refused: byState.refused ?? 0,
          waiting: (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state = 'waiting'").get() as { n: number }).n,
          perDay: Array.from({ length: 30 }, (_, i) => {
            const day = new Date(today - (29 - i) * DAY_MS).toISOString().slice(0, 10);
            return { day, ...(perDay.get(day) ?? { runs: 0, failed: 0 }) };
          }),
        },
        latest: this.runs({}, undefined, 6).items,
      };
    },

    gauges() {
      return {
        playbooksEnabled: (db.prepare("SELECT COUNT(*) AS n FROM playbooks WHERE enabled = 1").get() as { n: number }).n,
        runs: (db.prepare("SELECT state, COUNT(*) AS n FROM runs WHERE dry = 0 GROUP BY state").all() as Row[]).map((r) => ({
          state: r.state as string,
          n: Number(r.n),
        })),
        waiting: (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state = 'waiting'").get() as { n: number }).n,
      };
    },

    /** Runs that ended longer ago than the retention are deleted with their steps; a run waiting for a person stays. */
    purge(): number {
      return Number(db.prepare("DELETE FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?").run(iso(clock() - retentionDays * DAY_MS)).changes);
    },
  };
}

export type Automation = ReturnType<typeof createAutomation>;

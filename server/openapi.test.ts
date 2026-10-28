import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, PRODUCT_TOKEN, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "automation-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // automation's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let inc = "";
  let slack = "";
  let playbook = "";
  let token = "";
  let run = "";

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("connections", async () => {
    inc = (
      (
        await call(
          "POST",
          "/api/v1/connections",
          admin({ name: "Incidents", kind: "openasy", product: "incidents", url: app.tools.base, token: PRODUCT_TOKEN }),
        )
      ).body as { id: string }
    ).id;
    slack = ((await call("POST", "/api/v1/connections", admin({ name: "Slack", kind: "slack", url: `${app.tools.base}/slack/x` }))).body as { id: string }).id;
    await call("POST", "/api/v1/connections", admin({ name: "Slack", kind: "slack", url: `${app.tools.base}/slack/y` }));
    await call("POST", "/api/v1/connections", admin({ name: "Bad", kind: "ftp", url: "x" }));
    await call("POST", "/api/v1/connections", admin("nope"));
    await call("POST", "/api/v1/connections", { method: "POST" });
    await call("GET", "/api/v1/connections", admin());
    await call("GET", "/api/v1/connections", {});
    const c = "/api/v1/connections/{id}";
    await call("PATCH", c, admin({ name: "Incidents prod" }), `/api/v1/connections/${inc}`);
    await call("PATCH", c, admin({}), `/api/v1/connections/${inc}`);
    await call("PATCH", c, admin("nope"), `/api/v1/connections/${inc}`);
    await call("PATCH", c, admin({ name: "Slack" }), `/api/v1/connections/${inc}`);
    await call("PATCH", c, admin({ name: "x" }), "/api/v1/connections/missing");
    await call("PATCH", c, { method: "PATCH" }, `/api/v1/connections/${inc}`);
    await call("POST", `${c}/test`, { method: "POST", ...admin() }, `/api/v1/connections/${inc}/test`);
    await call("POST", `${c}/test`, { method: "POST", ...admin() }, "/api/v1/connections/missing/test");
    await call("POST", `${c}/test`, { method: "POST" }, `/api/v1/connections/${inc}/test`);
  });

  it("playbooks", async () => {
    const def = {
      name: "Open an incident",
      trigger: { kind: "webhook" },
      conditions: [{ field: "severity", op: "equals", value: "critical" }],
      steps: [
        { id: "open", kind: "incident.open", connection: inc, title: "{{event.title}}" },
        { id: "ask", kind: "approval", text: "Tell the channel about {{steps.open.key}}?" },
        { id: "tell", kind: "message", connection: slack, text: "{{steps.open.key}} opened" },
      ],
    };
    const made = (await call("POST", "/api/v1/playbooks", admin(def))).body as { playbook: { id: string }; webhookToken: string };
    playbook = made.playbook.id;
    token = made.webhookToken;
    await call("POST", "/api/v1/playbooks", admin(def));
    await call("POST", "/api/v1/playbooks", admin({ ...def, name: "Bad", steps: [] }));
    await call("POST", "/api/v1/playbooks", admin("nope"));
    await call("POST", "/api/v1/playbooks", { method: "POST" });
    await call("GET", "/api/v1/playbooks", admin());
    await call("GET", "/api/v1/playbooks", {});
    const p = "/api/v1/playbooks/{id}";
    await call("GET", p, admin(), `/api/v1/playbooks/${playbook}`);
    await call("GET", p, admin(), "/api/v1/playbooks/missing");
    await call("GET", p, {}, `/api/v1/playbooks/${playbook}`);
    await call("PUT", p, admin({ ...def, description: "From SIEM" }), `/api/v1/playbooks/${playbook}`);
    await call("PUT", p, admin({ ...def, steps: [{ id: "x", kind: "nope" }] }), `/api/v1/playbooks/${playbook}`);
    await call("PUT", p, admin("nope"), `/api/v1/playbooks/${playbook}`);
    await call("PUT", p, admin(def), "/api/v1/playbooks/missing");
    await call("PUT", p, { method: "PUT" }, `/api/v1/playbooks/${playbook}`);
    await call("DELETE", "/api/v1/connections/{id}", admin(), `/api/v1/connections/${inc}`);
    await call("POST", `${p}/token`, { method: "POST", ...admin() }, `/api/v1/playbooks/${playbook}/token`).then(
      (r) => (token = (r.body as { webhookToken: string }).webhookToken),
    );
    await call("POST", `${p}/token`, { method: "POST", ...admin() }, "/api/v1/playbooks/missing/token");
    await call("POST", `${p}/token`, { method: "POST" }, `/api/v1/playbooks/${playbook}/token`);
    const scheduled = (
      (await call("POST", "/api/v1/playbooks", admin({ ...def, name: "Hourly", trigger: { kind: "schedule", everyMinutes: 60 }, conditions: [] }))).body as {
        playbook: { id: string };
      }
    ).playbook.id;
    await call("POST", `${p}/token`, { method: "POST", ...admin() }, `/api/v1/playbooks/${scheduled}/token`);
    await call("PUT", p, admin({ ...def, name: "Hourly", trigger: { kind: "schedule", everyMinutes: 60 }, enabled: false }), `/api/v1/playbooks/${scheduled}`);
    await call("POST", `${p}/run`, admin({ event: {} }), `/api/v1/playbooks/${scheduled}/run`);
    await call("POST", `${p}/run`, admin({ event: { title: "Try" }, dry: true }), `/api/v1/playbooks/${playbook}/run`);
    await call("POST", `${p}/run`, admin({ event: [] }), `/api/v1/playbooks/${playbook}/run`);
    await call("POST", `${p}/run`, admin("nope"), `/api/v1/playbooks/${playbook}/run`);
    await call("POST", `${p}/run`, admin({}), "/api/v1/playbooks/missing/run");
    await call("POST", `${p}/run`, { method: "POST" }, `/api/v1/playbooks/${playbook}/run`);
    await call("DELETE", p, admin(), `/api/v1/playbooks/${scheduled}`);
    await call("DELETE", p, admin(), `/api/v1/playbooks/${scheduled}`);
    await call("DELETE", p, { method: "DELETE" }, `/api/v1/playbooks/${scheduled}`);
  });

  it("events and runs", async () => {
    const hook = (b: string, t = token) => ({ method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: b });
    const h = "/hooks/{id}";
    await call("POST", h, hook(JSON.stringify({ severity: "low" })), `/hooks/${playbook}`);
    run = ((await call("POST", h, hook(JSON.stringify({ severity: "critical", title: "Disk full" })), `/hooks/${playbook}`)).body as { run: { id: string } })
      .run.id;
    await call("POST", h, hook("{nope"), `/hooks/${playbook}`);
    await call("POST", h, hook("{}", "oah_wrong"), `/hooks/${playbook}`);
    await call("POST", h, hook(JSON.stringify({ pad: "x".repeat(300 * 1024) })), `/hooks/${playbook}`);
    await app.automation.idle();
    await call("GET", "/api/v1/runs", admin());
    await call("GET", "/api/v1/runs", admin(), `/api/v1/runs?playbook=${playbook}&state=waiting&limit=1`);
    await call("GET", "/api/v1/runs", admin(), "/api/v1/runs?state=odd");
    await call("GET", "/api/v1/runs", {});
    await call("GET", "/api/v1/runs/{id}", admin(), `/api/v1/runs/${run}`);
    await call("GET", "/api/v1/runs/{id}", admin(), "/api/v1/runs/missing");
    await call("GET", "/api/v1/runs/{id}", {}, `/api/v1/runs/${run}`);
    await call("GET", "/api/v1/approvals", admin());
    await call("GET", "/api/v1/approvals", {});
    const d = "/api/v1/runs/{id}/decision";
    await call("POST", d, admin({ approve: "yes" }), `/api/v1/runs/${run}/decision`);
    await call("POST", d, admin({ approve: true, comment: "Go" }), `/api/v1/runs/${run}/decision`);
    await call("POST", d, admin({ approve: true }), `/api/v1/runs/${run}/decision`);
    await call("POST", d, admin("nope"), `/api/v1/runs/${run}/decision`);
    await call("POST", d, admin({ approve: true }), "/api/v1/runs/missing/decision");
    await call("POST", d, { method: "POST" }, `/api/v1/runs/${run}/decision`);
    await app.automation.idle();
    await call("GET", "/api/v1/runs/{id}", admin(), `/api/v1/runs/${run}`);
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
    const p = (
      await call(
        "PUT",
        "/api/v1/playbooks/{id}",
        admin({ name: "Off", enabled: false, trigger: { kind: "webhook" }, steps: [{ id: "a", kind: "approval", text: "x" }] }),
        `/api/v1/playbooks/${playbook}`,
      )
    ).body;
    expect(p).toBeDefined();
    await call("POST", h, hook("{}"), `/hooks/${playbook}`);
  });

  it("deletes a connection and a playbook", async () => {
    await call("DELETE", "/api/v1/playbooks/{id}", admin(), `/api/v1/playbooks/${playbook}`);
    await call("DELETE", "/api/v1/connections/{id}", admin(), `/api/v1/connections/${inc}`);
    await call("DELETE", "/api/v1/connections/{id}", admin(), `/api/v1/connections/${inc}`);
    await call("DELETE", "/api/v1/connections/{id}", { method: "DELETE" }, `/api/v1/connections/${slack}`);
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});

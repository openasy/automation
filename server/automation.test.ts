import { afterEach, describe, expect, it } from "vitest";
import { createAutomation, type AutomationOptions } from "./automation.ts";
import { openDb } from "./db.ts";
import { sealer } from "./seal.ts";
import { fakeTools, PRODUCT_TOKEN } from "./test-app.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function setup(opts: Partial<AutomationOptions> = {}) {
  let now = Date.parse("2026-10-28T12:00:00Z");
  const tools = await fakeTools();
  closers.push(tools.close);
  const db = openDb(":memory:");
  const a = createAutomation(db, { sealer: sealer(Buffer.alloc(32, 9)), clock: () => now, ...opts });
  const inc = a.createConnection({ name: "Incidents", kind: "openasy", product: "incidents", url: tools.base, token: PRODUCT_TOKEN });
  const vpn = a.createConnection({ name: "VPN", kind: "openasy", product: "vpn", url: tools.base, token: PRODUCT_TOKEN });
  const slack = a.createConnection({ name: "Slack #sec", kind: "slack", url: `${tools.base}/slack/T0/B0/secretkey` });
  return { a, db, tools, inc, vpn, slack, later: (ms: number) => (now += ms) };
}

/** A playbook as in the product page: end the VPN of a person, open an incident, ask, then tell Slack. */
const brute = (inc: string, vpn: string, slack: string) => ({
  name: "Impossible travel",
  trigger: { kind: "webhook" },
  conditions: [{ field: "signal.rule", op: "equals", value: "impossible-travel" }],
  steps: [
    { id: "suspend", kind: "vpn.suspend", connection: vpn, person: "{{event.signal.person}}" },
    { id: "open", kind: "incident.open", connection: inc, title: "Impossible travel: {{event.signal.person}}", severity: "high" },
    { id: "ask", kind: "approval", text: "Revoke the device of {{event.signal.person}}? Incident {{steps.open.key}}." },
    { id: "revoke", kind: "vpn.revoke-device", connection: vpn, device: "{{event.signal.device}}" },
    { id: "tell", kind: "message", connection: slack, text: "{{steps.open.key}}: {{event.signal.person}} suspended and revoked." },
  ],
});
const event = { signal: { rule: "impossible-travel", person: "p_ada", device: "d_9" } };

describe("connections", () => {
  it("keep tokens and webhook keys sealed, and show only what is safe", async () => {
    const { a, db, slack } = await setup();
    expect(slack).toMatchObject({ kind: "slack", hasToken: false });
    expect(slack.address).not.toContain("secretkey");
    expect(JSON.stringify(db.prepare("SELECT url, token FROM connections").all())).not.toMatch(/secretkey|oa_incidents/);
    expect(() => a.createConnection({ name: "Bad", kind: "slack", url: "http://hooks.example.com/x" })).toThrow(/https/);
    expect(() => a.createConnection({ name: "Bad", kind: "slack", url: "https://hooks.example.com/x", token: "abcdefgh" })).toThrow(/Only OpenAsy/);
    expect(() => a.createConnection({ name: "Bad", kind: "openasy", product: "vpn", url: "https://u:p@vpn.example.com", token: "abcdefgh" })).toThrow(
      /user or password/,
    );
    expect(() => a.createConnection({ name: "Slack #sec", kind: "slack", url: "https://hooks.example.com/x" })).toThrow(/exists/);
  });

  it("are tested read-only, and cannot be deleted while a playbook uses them", async () => {
    const { a, inc, vpn, slack } = await setup();
    expect(await a.testConnection(inc.id)).toMatchObject({ ok: true, status: 200 });
    expect((await a.testConnection(slack.id)).detail).toMatch(/Not called/);
    a.updateConnection(inc.id, { token: "oa_incidents_wrong" });
    expect(await a.testConnection(inc.id)).toMatchObject({ ok: false, status: 401 });
    a.createPlaybook(brute(inc.id, vpn.id, slack.id), "Ada");
    expect(() => a.deleteConnection(vpn.id)).toThrow(/use this connection/);
    expect(a.connections().find((c) => c.id === vpn.id)!.playbooks).toBe(1);
  });
});

describe("playbooks", () => {
  it("are checked when saved, and a webhook trigger gets a token shown once", async () => {
    const { a, inc, vpn, slack } = await setup();
    const made = a.createPlaybook(brute(inc.id, vpn.id, slack.id), "Ada");
    expect(made.webhookToken).toMatch(/^oah_/);
    expect(made.playbook).toMatchObject({ name: "Impossible travel", enabled: true, trigger: { kind: "webhook" }, updatedBy: "Ada", lastRun: null });
    expect(() => a.createPlaybook({ ...brute(inc.id, vpn.id, slack.id), name: "Other", steps: [] }, "Ada")).toThrow(/at least one/);
    expect(() => a.createPlaybook({ ...brute(inc.id, vpn.id, slack.id), name: "Other", trigger: { kind: "schedule", everyMinutes: 1 } }, "Ada")).toThrow(
      /5 to 10080/,
    );
    expect(() => a.createPlaybook({ ...brute(inc.id, vpn.id, slack.id), conditions: [{ field: "x", op: "like" }] }, "Ada")).toThrow(/op is one of/);
    expect(() => a.createPlaybook(brute(inc.id, vpn.id, slack.id), "Ada")).toThrow(/exists/);
    const changed = a.updatePlaybook(made.playbook.id, { ...brute(inc.id, vpn.id, slack.id), enabled: false }, "Ben");
    expect(changed).toEqual({ playbook: expect.objectContaining({ enabled: false, updatedBy: "Ben" }) });
    expect(a.rotateToken(made.playbook.id).webhookToken).not.toBe(made.webhookToken);
  });
});

describe("runs", () => {
  it("act through the products, wait for approval, and go on when approved", async () => {
    const { a, tools, inc, vpn, slack } = await setup();
    const { playbook, webhookToken } = a.createPlaybook(brute(inc.id, vpn.id, slack.id), "Ada");
    expect(a.hook(playbook.id, webhookToken, { signal: { rule: "other" } })).toEqual({ matched: false });
    const { run } = a.hook(playbook.id, webhookToken, event);
    await a.idle();
    let r = a.run(run!.id);
    expect(r).toMatchObject({ state: "waiting", cause: "webhook", waiting: { stepId: "ask", text: "Revoke the device of p_ada? Incident INC-7." } });
    expect(r.stepsDone.map((s) => [s.stepId, s.state])).toEqual([
      ["suspend", "ok"],
      ["open", "ok"],
      ["ask", "waiting"],
    ]);
    expect(tools.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PATCH /api/v1/people/p_ada", "POST /api/v1/incidents"]);
    expect(tools.calls[1]!.body).toMatchObject({ title: "Impossible travel: p_ada", external: { source: "automation", reference: `${run!.id}:open` } });
    expect(a.approvals().map((x) => x.id)).toEqual([run!.id]);

    a.decide(run!.id, { approve: true, comment: "Yes" }, "Emily");
    await a.idle();
    r = a.run(run!.id);
    expect(r.state).toBe("succeeded");
    expect(r.stepsDone.map((s) => [s.stepId, s.state])).toEqual([
      ["suspend", "ok"],
      ["open", "ok"],
      ["ask", "approved"],
      ["revoke", "ok"],
      ["tell", "ok"],
    ]);
    expect(r.stepsDone[2]).toMatchObject({ decidedBy: "Emily", comment: "Yes" });
    expect(tools.calls.at(-1)).toMatchObject({ path: "/slack/T0/B0/secretkey", body: { text: "INC-7: p_ada suspended and revoked." } });
    // The token and the Slack key are not kept in the run.
    expect(JSON.stringify(r)).not.toMatch(/secretkey|oa_incidents/);
    expect(() => a.decide(run!.id, { approve: true }, "Emily")).toThrow(/waits for no approval/);
  });

  it("stop when refused, with the rest skipped", async () => {
    const { a, inc, vpn, slack } = await setup();
    const { playbook } = a.createPlaybook(brute(inc.id, vpn.id, slack.id), "Ada");
    const run = a.runNow(playbook.id, { event }, "Ada");
    await a.idle();
    a.decide(run.id, { approve: false, comment: "False alarm" }, "Emily");
    const r = a.run(run.id);
    expect(r.state).toBe("refused");
    expect(r.stepsDone.slice(2).map((s) => s.state)).toEqual(["refused", "skipped", "skipped"]);
  });

  it("fail on an error answer, unless the step may go on", async () => {
    const { a, tools, inc, vpn, slack } = await setup();
    tools.fail.add("/api/v1/people/p_ada");
    const p = brute(inc.id, vpn.id, slack.id);
    const { playbook } = a.createPlaybook({ ...p, steps: p.steps.slice(0, 2) }, "Ada");
    let run = a.runNow(playbook.id, { event }, "Ada");
    await a.idle();
    expect(a.run(run.id).stepsDone.map((s) => [s.state, s.error])).toEqual([
      ["failed", "Answered 500: Broken."],
      ["skipped", null],
    ]);
    expect(a.run(run.id).state).toBe("failed");
    a.updatePlaybook(playbook.id, { ...p, steps: [{ ...p.steps[0], continueOnError: true }, p.steps[1]] }, "Ada");
    run = a.runNow(playbook.id, { event }, "Ada");
    await a.idle();
    expect(a.run(run.id).stepsDone.map((s) => s.state)).toEqual(["failed", "ok"]);
    expect(a.run(run.id).state).toBe("failed");
  });

  it("send nothing when dry, and show what would be sent", async () => {
    const { a, tools, inc, vpn, slack } = await setup();
    const { playbook } = a.createPlaybook(brute(inc.id, vpn.id, slack.id), "Ada");
    const run = a.runNow(playbook.id, { event, dry: true }, "Ada");
    await a.idle();
    const r = a.run(run.id);
    expect(tools.calls).toEqual([]);
    expect(r).toMatchObject({ dry: true, state: "succeeded" });
    expect(r.stepsDone.map((s) => s.state)).toEqual(["planned", "planned", "planned", "planned", "planned"]);
    expect(r.stepsDone[0]!.request).toEqual({ method: "PATCH", url: `${tools.base}/api/v1/people/p_ada`, body: { status: "suspended" } });
    expect(r.stepsDone[4]!.request).toMatchObject({ url: `${tools.base}/…` });
  });

  it("refuse a wrong token and a turned-off playbook", async () => {
    const { a, inc, vpn, slack } = await setup();
    const { playbook, webhookToken } = a.createPlaybook(brute(inc.id, vpn.id, slack.id), "Ada");
    expect(() => a.hook(playbook.id, "oah_wrong", event)).toThrow(/webhook token/);
    expect(() => a.hook("pb_missing", webhookToken, event)).toThrow(/webhook token/);
    a.updatePlaybook(playbook.id, { ...brute(inc.id, vpn.id, slack.id), enabled: false }, "Ada");
    expect(() => a.hook(playbook.id, webhookToken, event)).toThrow(/turned off/);
    expect(() => a.runNow(playbook.id, { event }, "Ada")).toThrow(/turned off/);
  });

  it("start on a schedule", async () => {
    const { a, tools, slack, later } = await setup();
    a.createPlaybook(
      {
        name: "Daily",
        trigger: { kind: "schedule", everyMinutes: 60 },
        steps: [{ id: "tell", kind: "message", connection: slack.id, text: "Daily at {{event.schedule.at}}" }],
      },
      "Ada",
    );
    expect(a.tick()).toBe(0);
    later(61 * 60_000);
    expect(a.tick()).toBe(1);
    expect(a.tick()).toBe(0);
    await a.idle();
    expect(tools.calls[0]!.body.text).toBe("Daily at 2026-10-28T13:01:00.000Z");
    expect(a.summary().runs).toMatchObject({ last30Days: 1, succeeded: 1 });
  });

  it("are failed when the process stopped in the middle, and purged after the retention", async () => {
    const { a, db, inc, vpn, slack } = await setup({ retentionDays: 30 });
    const { playbook } = a.createPlaybook(brute(inc.id, vpn.id, slack.id), "Ada");
    const run = a.runNow(playbook.id, { event, dry: true }, "Ada");
    await a.idle();
    db.prepare("UPDATE runs SET state = 'running', ended_at = NULL").run();
    let now = Date.parse("2026-10-28T12:00:00Z");
    const again = createAutomation(db, { sealer: sealer(Buffer.alloc(32, 9)), clock: () => now, retentionDays: 30 });
    expect(again.run(run.id).state).toBe("failed");
    expect(again.purge()).toBe(0);
    now += 31 * 86_400_000;
    expect(again.purge()).toBe(1);
  });
});

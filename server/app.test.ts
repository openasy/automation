import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCT_TOKEN, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
});
afterAll(() => app.close());

describe("the API", () => {
  it("needs a signed-in person or a token, but a webhook needs only the playbook's token", async () => {
    expect((await fetch(`${app.base}/api/v1/playbooks`)).status).toBe(401);
    const vpn = await app.post("/api/v1/connections", { name: "VPN", kind: "openasy", product: "vpn", url: app.tools.base, token: PRODUCT_TOKEN });
    const { playbook, webhookToken } = await app.post("/api/v1/playbooks", {
      name: "Suspend",
      trigger: { kind: "webhook" },
      steps: [{ id: "suspend", kind: "vpn.suspend", connection: vpn.id, person: "{{event.person}}" }],
    });
    const res = await fetch(`${app.base}/hooks/${playbook.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${webhookToken}`, "content-type": "application/json" },
      body: JSON.stringify({ person: "p_ada" }),
    });
    expect(res.status).toBe(202);
    await app.automation.idle();
    expect(app.tools.calls.at(-1)).toMatchObject({ method: "PATCH", path: "/api/v1/people/p_ada", auth: `Bearer ${PRODUCT_TOKEN}` });
  });

  it("does not show a connection's token or key", async () => {
    await app.post("/api/v1/connections", { name: "Slack", kind: "slack", url: `${app.tools.base}/slack/T/B/topsecret` });
    const text = await (await app.admin("/api/v1/connections")).text();
    expect(text).not.toMatch(/topsecret|oa_incidents/);
  });

  it("has metrics for Prometheus", async () => {
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain('openasy_build_info{product="automation",version="0.1.0"} 1');
    expect(metrics).toContain("openasy_automation_playbooks_enabled 1");
    expect(metrics).toContain('openasy_automation_runs{state="succeeded"} 1');
  });
});

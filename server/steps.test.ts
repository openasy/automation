import { describe, expect, it } from "vitest";
import { buildRequest, parseSteps, type Target } from "./steps.ts";

const connections = [
  { id: "inc", kind: "openasy" as const, product: "incidents" },
  { id: "vpn", kind: "openasy" as const, product: "vpn" },
  { id: "slack", kind: "slack" as const, product: null },
  { id: "hook", kind: "webhook" as const, product: null },
];
const scope = {
  event: { person: "p 1", host: "web-01" },
  steps: { open: { id: "inc-1", key: "INC-7" } },
  run: { id: "run_1", dry: false },
  playbook: { id: "pb", name: "P" },
};
const t = (over: Partial<Target>): Target => ({ id: "x", kind: "openasy", product: "incidents", url: "https://incidents.example.com", token: "oa_x", ...over });

describe("steps", () => {
  it("are checked against the connections and the steps before them", () => {
    expect(parseSteps([{ id: "open", kind: "incident.open", connection: "inc", title: "On {{event.host}}" }], connections)).toEqual([
      { id: "open", kind: "incident.open", connection: "inc", title: "On {{event.host}}" },
    ]);
    const err = (steps: unknown) => () => parseSteps(steps, connections);
    expect(err([])).toThrow(/at least one/);
    expect(err([{ id: "Open", kind: "incident.open" }])).toThrow(/steps\[0\]\.id/);
    expect(err([{ id: "a", kind: "shell" }])).toThrow(/kind is one of/);
    expect(err([{ id: "a", kind: "incident.open", connection: "inc" }])).toThrow(/title is required/);
    expect(err([{ id: "a", kind: "incident.open", connection: "vpn", title: "x" }])).toThrow(/OpenAsy incidents connection/);
    expect(err([{ id: "a", kind: "message", connection: "inc", text: "x" }])).toThrow(/Slack, Teams or a webhook/);
    expect(err([{ id: "a", kind: "message", connection: "nope", text: "x" }])).toThrow(/does not exist/);
    expect(err([{ id: "a", kind: "message", connection: "slack", text: "{{steps.later.key}}" }])).toThrow(/names no step before/);
    expect(err([{ id: "a", kind: "message", connection: "slack", text: "{{env.HOME}}" }])).toThrow(/must start with event/);
    expect(err([{ id: "a", kind: "http", connection: "hook", method: "TRACE", path: "/x" }])).toThrow(/method is one of/);
    expect(err([{ id: "a", kind: "http", connection: "hook", method: "post", path: "x" }])).toThrow(/starts with \//);
    expect(
      err([
        { id: "a", kind: "approval", text: "ok?" },
        { id: "a", kind: "approval", text: "again" },
      ]),
    ).toThrow(/used twice/);
  });

  it("build the requests products expect", () => {
    expect(buildRequest({ id: "open", kind: "incident.open", connection: "inc", title: "On {{event.host}}", severity: "critical" }, t({}), scope)).toEqual({
      method: "POST",
      url: "https://incidents.example.com/api/v1/incidents",
      headers: { "content-type": "application/json", authorization: "Bearer oa_x" },
      body: { title: "On web-01", severity: "critical", products: ["automation"], external: { source: "automation", reference: "run_1:open" } },
    });
    expect(buildRequest({ id: "n", kind: "incident.note", incident: "{{steps.open.id}}", text: "Done" }, t({}), scope)).toMatchObject({
      url: "https://incidents.example.com/api/v1/incidents/inc-1/timeline",
      body: { kind: "note", text: "Done" },
    });
    expect(
      buildRequest({ id: "s", kind: "vpn.suspend", person: "{{event.person}}" }, t({ product: "vpn", url: "https://vpn.example.com" }), scope),
    ).toMatchObject({
      method: "PATCH",
      url: "https://vpn.example.com/api/v1/people/p%201",
      body: { status: "suspended" },
    });
    expect(() => buildRequest({ id: "s", kind: "vpn.revoke-device", device: "{{event.none}}" }, t({}), scope)).toThrow(/device is empty/);
  });

  it("post a message the way Slack, Teams and webhooks take it", () => {
    const step = { id: "m", kind: "message" as const, text: "{{event.host}} is down" };
    expect(buildRequest(step, t({ kind: "slack", url: "https://hooks.slack.com/services/T/B/K", token: null }), scope).body).toEqual({
      text: "web-01 is down",
    });
    expect(JSON.stringify(buildRequest(step, t({ kind: "teams", url: "https://example.webhook.office.com/x", token: null }), scope).body)).toContain(
      '"text":"web-01 is down"',
    );
    expect(buildRequest(step, t({ kind: "webhook", url: "https://hooks.example.com/in", token: null }), scope).body).toMatchObject({
      text: "web-01 is down",
      run: "run_1",
    });
  });

  it("keep an http step on the connection's address", () => {
    const http = (path: string) =>
      buildRequest({ id: "h", kind: "http", method: "POST", path, body: { host: "{{event.host}}" } }, t({ url: "https://tools.example.com/base" }), scope);
    expect(http("/hosts/{{event.host}}/isolate")).toMatchObject({ url: "https://tools.example.com/base/hosts/web-01/isolate", body: { host: "web-01" } });
    expect(() => http("/../../admin")).toThrow(/leaves the connection/);
    expect(() =>
      buildRequest({ id: "h", kind: "http", method: "GET", path: "{{event.x}}" }, t({ url: "https://tools.example.com" }), {
        ...scope,
        event: { x: "@evil.example.com/" },
      }),
    ).toThrow();
  });
});

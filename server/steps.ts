// The steps a playbook can take (ADR 0060). Built-in steps call an OpenAsy product's API the way its openapi.json
// describes; `message` posts to Slack, Teams or a webhook; `http` calls any path of a connection; `approval` waits for
// a person. Every request goes to the connection's own address: a template can change a path, never the host.
import { paths, render, renderJson } from "./templates.ts";

export const STEP_KINDS = ["incident.open", "incident.note", "vpn.suspend", "vpn.disconnect", "vpn.revoke-device", "message", "http", "approval"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export type ConnectionKind = "openasy" | "slack" | "teams" | "webhook";

export interface Step {
  /** Short and unique in the playbook: later steps read its answer as {{steps.<id>.…}}. */
  id: string;
  kind: StepKind;
  connection?: string;
  /** Go on to the next step when this one fails. */
  continueOnError?: boolean;
  title?: string;
  severity?: string;
  summary?: string;
  incident?: string;
  text?: string;
  person?: string;
  server?: string;
  device?: string;
  method?: string;
  path?: string;
  body?: unknown;
}

/** A connection as a step uses it, its secrets opened. */
export interface Target {
  id: string;
  kind: ConnectionKind;
  product: string | null;
  url: string;
  token: string | null;
}

export interface Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const SEVERITIES = ["critical", "high", "medium", "low"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** What each built-in step needs: the product its connection must be, and the fields that must be set. */
const NEEDS: Record<StepKind, { connection: "product" | "message" | "http" | "none"; product?: string; fields: Array<keyof Step> }> = {
  "incident.open": { connection: "product", product: "incidents", fields: ["title"] },
  "incident.note": { connection: "product", product: "incidents", fields: ["incident", "text"] },
  "vpn.suspend": { connection: "product", product: "vpn", fields: ["person"] },
  "vpn.disconnect": { connection: "product", product: "vpn", fields: ["server", "device"] },
  "vpn.revoke-device": { connection: "product", product: "vpn", fields: ["device"] },
  message: { connection: "message", fields: ["text"] },
  http: { connection: "http", fields: ["method", "path"] },
  approval: { connection: "none", fields: ["text"] },
};

/**
 * The steps of a playbook, checked against the connections that exist. The message names the first wrong field, as
 * steps[2].title.
 */
export function parseSteps(raw: unknown, connections: Array<{ id: string; kind: ConnectionKind; product: string | null }>): Step[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("steps must be a list of at least one step.");
  if (raw.length > 30) throw new Error("A playbook has at most 30 steps.");
  const seen = new Set<string>();
  return raw.map((r, i) => {
    const at = `steps[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`${at} must be an object.`);
    const s = r as Record<string, unknown>;
    if (typeof s.id !== "string" || !ID.test(s.id)) throw new Error(`${at}.id must be lowercase letters, digits and dashes, such as open-incident.`);
    if (seen.has(s.id)) throw new Error(`${at}.id ${s.id} is used twice.`);
    if (!(STEP_KINDS as readonly string[]).includes(s.kind as string)) throw new Error(`${at}.kind is one of ${STEP_KINDS.join(", ")}.`);
    const kind = s.kind as StepKind;
    const need = NEEDS[kind];
    const step: Step = { id: s.id, kind };
    for (const f of ["title", "severity", "summary", "incident", "text", "person", "server", "device", "method", "path"] as const) {
      if (s[f] === undefined) continue;
      if (typeof s[f] !== "string" || (s[f] as string).length > 5000) throw new Error(`${at}.${f} must be text of at most 5000 characters.`);
      step[f] = s[f] as string;
    }
    for (const f of need.fields) if (!step[f]) throw new Error(`${at}.${f} is required for ${kind}.`);
    // A step may only read steps before it.
    for (const f of ["title", "summary", "incident", "text", "person", "server", "device", "path"] as const) {
      for (const p of paths(step[f] ?? "")) {
        const [root, ref] = p.split(".");
        if (!["event", "steps", "run", "playbook"].includes(root!)) throw new Error(`${at}.${f}: {{${p}}} must start with event, steps, run or playbook.`);
        if (root === "steps" && !seen.has(ref ?? "")) throw new Error(`${at}.${f}: {{${p}}} names no step before this one.`);
      }
    }
    if (step.severity !== undefined && !SEVERITIES.includes(step.severity)) throw new Error(`${at}.severity is one of ${SEVERITIES.join(", ")}.`);
    if (kind === "http") {
      step.method = step.method!.toUpperCase();
      if (!METHODS.includes(step.method)) throw new Error(`${at}.method is one of ${METHODS.join(", ")}.`);
      if (!step.path!.startsWith("/")) throw new Error(`${at}.path starts with /, after the connection's address.`);
      if (s.body !== undefined) step.body = s.body;
    }
    if (s.continueOnError !== undefined) {
      if (typeof s.continueOnError !== "boolean") throw new Error(`${at}.continueOnError must be true or false.`);
      step.continueOnError = s.continueOnError;
    }
    if (need.connection !== "none") {
      if (typeof s.connection !== "string") throw new Error(`${at}.connection names one of the connections.`);
      const c = connections.find((x) => x.id === s.connection);
      if (!c) throw new Error(`${at}.connection ${s.connection} does not exist.`);
      if (need.connection === "product" && (c.kind !== "openasy" || c.product !== need.product))
        throw new Error(`${at}.connection must be an OpenAsy ${need.product} connection.`);
      if (need.connection === "message" && c.kind === "openasy") throw new Error(`${at}.connection must be Slack, Teams or a webhook.`);
      if (need.connection === "http" && c.kind !== "openasy" && c.kind !== "webhook")
        throw new Error(`${at}.connection must be an OpenAsy product or a webhook.`);
      step.connection = c.id;
    }
    seen.add(s.id);
    return step;
  });
}

const segment = (template: string, scope: unknown, name: string) => {
  const v = render(template, scope);
  if (!v) throw new Error(`${name} is empty: the template gave nothing.`);
  return encodeURIComponent(v);
};

/** The request a step sends, its templates filled in. The URL is always under the connection's address. */
export function buildRequest(step: Step, target: Target, scope: Record<string, unknown>): Request {
  const base = target.url.replace(/\/$/, "");
  const auth: Record<string, string> = target.token ? { authorization: `Bearer ${target.token}` } : {};
  const json = { "content-type": "application/json", ...auth };
  const run = scope.run as { id: string };
  switch (step.kind) {
    case "incident.open":
      return {
        method: "POST",
        url: `${base}/api/v1/incidents`,
        headers: json,
        body: {
          title: render(step.title!, scope).slice(0, 200),
          severity: step.severity ?? "high",
          ...(step.summary && { summary: render(step.summary, scope).slice(0, 5000) }),
          products: ["automation"],
          // The same run and step is one incident: a retry adds a note instead of a second incident.
          external: { source: "automation", reference: `${run.id}:${step.id}` },
        },
      };
    case "incident.note":
      return {
        method: "POST",
        url: `${base}/api/v1/incidents/${segment(step.incident!, scope, "incident")}/timeline`,
        headers: json,
        body: { kind: "note", text: render(step.text!, scope).slice(0, 2000) },
      };
    case "vpn.suspend":
      return { method: "PATCH", url: `${base}/api/v1/people/${segment(step.person!, scope, "person")}`, headers: json, body: { status: "suspended" } };
    case "vpn.disconnect":
      return {
        method: "DELETE",
        url: `${base}/api/v1/sessions/${segment(step.server!, scope, "server")}/${segment(step.device!, scope, "device")}`,
        headers: auth,
      };
    case "vpn.revoke-device":
      return { method: "DELETE", url: `${base}/api/v1/devices/${segment(step.device!, scope, "device")}`, headers: auth };
    case "message": {
      const text = render(step.text!, scope);
      const body =
        target.kind === "slack"
          ? { text }
          : target.kind === "teams"
            ? {
                type: "message",
                attachments: [
                  {
                    contentType: "application/vnd.microsoft.card.adaptive",
                    content: { type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text, wrap: true }] },
                  },
                ],
              }
            : { text, run: run.id, playbook: scope.playbook, event: scope.event };
      return { method: "POST", url: target.url, headers: json, body };
    }
    case "http": {
      const path = render(step.path!, scope);
      const url = new URL(base + path);
      // A rendered path could hold "//other.example.com" or "/../": the origin must stay the connection's.
      if (url.origin !== new URL(base).origin || !url.pathname.startsWith(new URL(base).pathname.replace(/\/$/, "")))
        throw new Error("The path leaves the connection's address.");
      return {
        method: step.method!,
        url: url.href,
        headers: step.body === undefined ? auth : json,
        ...(step.body !== undefined && { body: renderJson(step.body, scope) }),
      };
    }
    case "approval":
      throw new Error("An approval sends no request.");
  }
}

/** The request as it is shown and kept: without the token. */
export const shown = (r: Request) => ({
  method: r.method,
  url: r.url,
  ...(r.body !== undefined && { body: r.body }),
});

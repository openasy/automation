// Starts the app on a random port for tests, with fake Incidents, VPN and Slack to call.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { createAutomation, type AutomationOptions } from "./automation.ts";
import { openDb } from "./db.ts";
import { sealer } from "./seal.ts";

export const ADMIN_TOKEN = "test-admin-token";
export const PRODUCT_TOKEN = "oa_incidents_test-token";

export interface Call {
  method: string;
  path: string;
  auth: string | undefined;
  body: any;
}

/** One server that answers as Incidents, VPN and a Slack webhook, and keeps every call. `fail` makes a path answer 500. */
export async function fakeTools() {
  const calls: Call[] = [];
  const fail = new Set<string>();
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const call = { method: req.method!, path: req.url!, auth: req.headers.authorization, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const send = (status: number, b: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
    if (fail.has(call.path)) return send(500, { detail: "Broken." });
    if (call.path.startsWith("/slack/")) return res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (call.auth !== `Bearer ${PRODUCT_TOKEN}`) return send(401, {});
    if (call.method === "GET" && call.path === "/api/v1/products") return send(200, { products: [] });
    if (call.method === "POST" && call.path === "/api/v1/incidents") return send(201, { id: "inc-1", key: "INC-7" });
    if (call.method === "POST" && /^\/api\/v1\/incidents\/[^/]+\/timeline$/.test(call.path)) return send(201, { id: "t-1" });
    if (call.method === "PATCH" && call.path.startsWith("/api/v1/people/")) return send(200, { id: call.path.split("/").pop(), status: "suspended" });
    if (call.method === "DELETE") return res.writeHead(204).end();
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, calls, fail, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function startApp(opts: Partial<AppOptions> & { version: string; automationOptions?: Partial<AutomationOptions> }) {
  const db = openDb(":memory:");
  const tools = await fakeTools();
  const { automationOptions, ...appOptions } = opts;
  const automation = createAutomation(db, { sealer: sealer(Buffer.alloc(32, 5)), ...automationOptions });
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "automation", productName: "OpenAsy Automation", origin: base });
  handler = createApp({ db, automation, auth, adminToken: ADMIN_TOKEN, ...appOptions });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const get = async (path: string) => (await (await admin(path)).json()) as any;
  const post = async (path: string, body: unknown) => (await admin(path, { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await tools.close();
  };
  return { db, automation, auth, base, admin, get, post, tools, close };
}

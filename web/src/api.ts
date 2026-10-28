// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export type RunState = "running" | "waiting" | "succeeded" | "failed" | "refused";
export type StepState = "ok" | "failed" | "skipped" | "planned" | "waiting" | "approved" | "refused";
export type ConnectionKind = "openasy" | "slack" | "teams" | "webhook";
export type StepKind = "incident.open" | "incident.note" | "vpn.suspend" | "vpn.disconnect" | "vpn.revoke-device" | "message" | "http" | "approval";

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface Connection {
  id: string;
  name: string;
  kind: ConnectionKind;
  product: string | null;
  address: string;
  hasToken: boolean;
  playbooks: number;
  createdAt: string;
}

export type Trigger = { kind: "webhook" } | { kind: "schedule"; everyMinutes: number } | { kind: "manual" };

export interface Condition {
  field: string;
  op: string;
  value?: string;
}

export interface Step {
  id: string;
  kind: StepKind;
  connection?: string;
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
  waiting: { stepId: string; text: string } | null;
}

export interface RunStep {
  position: number;
  stepId: string;
  kind: string;
  state: StepState;
  request: unknown;
  response: { status: number; body: unknown } | null;
  output: unknown;
  error: string | null;
  startedAt: string;
  ms: number | null;
  decidedBy: string | null;
  comment: string | null;
}

export interface RunDetail extends Run {
  event: unknown;
  stepsDone: RunStep[];
  definition: { steps: Step[] };
}

export interface Summary {
  playbooks: { total: number; enabled: number };
  connections: number;
  runs: {
    last30Days: number;
    succeeded: number;
    failed: number;
    refused: number;
    waiting: number;
    perDay: Array<{ day: string; runs: number; failed: number }>;
  };
  latest: Run[];
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

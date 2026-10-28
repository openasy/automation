// Values a step takes from the event and from earlier steps: {{event.signal.host}}, {{steps.open.key}}, {{run.id}}.
// A template is text with these in it; nothing else is evaluated, so a template cannot run code.

/** The value at a dotted path, such as event.signal.host; undefined when any part is missing. */
export function lookup(scope: unknown, path: string): unknown {
  let v: unknown = scope;
  for (const part of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

const TAG = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Text with each {{path}} replaced: a string as it is, any other value as JSON, a missing one as empty. */
export function render(template: string, scope: unknown): string {
  return template.replace(TAG, (_, path: string) => {
    const v = lookup(scope, path);
    return v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  });
}

/** The paths a template uses, to check them when a playbook is saved. */
export const paths = (template: string) => [...template.matchAll(TAG)].map((m) => m[1]!);

/**
 * A JSON value with every string rendered. A string that is one tag and nothing else takes the value itself, so
 * {"groups": "{{event.groups}}"} sends the list, not its text.
 */
export function renderJson(value: unknown, scope: unknown): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(value);
    if (whole) return lookup(scope, whole[1]!) ?? null;
    return render(value, scope);
  }
  if (Array.isArray(value)) return value.map((v) => renderJson(v, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderJson(v, scope)]));
  return value;
}

export type CondOp = "equals" | "not-equals" | "contains" | "matches" | "exists" | "at-least";
export const COND_OPS: readonly CondOp[] = ["equals", "not-equals", "contains", "matches", "exists", "at-least"];

export interface Condition {
  /** A path in the event, such as signal.severity. */
  field: string;
  op: CondOp;
  value?: string;
}

/** Whether every condition holds on the event. With none, every event matches. */
export function holds(conditions: Condition[], event: unknown): boolean {
  return conditions.every((c) => {
    const v = lookup(event, c.field);
    const text = v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
    switch (c.op) {
      case "exists":
        return v !== undefined && v !== null;
      case "equals":
        return text === (c.value ?? "");
      case "not-equals":
        return text !== (c.value ?? "");
      case "contains":
        return Array.isArray(v) ? v.map(String).includes(c.value ?? "") : text.includes(c.value ?? "");
      case "matches":
        return new RegExp(c.value ?? "").test(text);
      case "at-least":
        return Number(text) >= Number(c.value);
    }
  });
}

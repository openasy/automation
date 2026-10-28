import { describe, expect, it } from "vitest";
import { holds, lookup, paths, render, renderJson } from "./templates.ts";

const scope = {
  event: { signal: { host: "web-01", severity: "high", tags: ["vpn", "geo"] }, count: 3 },
  steps: { open: { key: "INC-7" } },
  run: { id: "run_1" },
};

describe("templates", () => {
  it("fill in paths, with other values as JSON and missing ones empty", () => {
    expect(lookup(scope, "event.signal.host")).toBe("web-01");
    expect(lookup(scope, "event.signal.nope.deeper")).toBeUndefined();
    expect(render("{{ event.signal.host }} in {{steps.open.key}}: {{event.signal.tags}}{{event.missing}}", scope)).toBe('web-01 in INC-7: ["vpn","geo"]');
    expect(paths("a {{event.x}} b {{steps.open.id}}")).toEqual(["event.x", "steps.open.id"]);
  });

  it("keep a value whole in JSON when a string is one tag", () => {
    expect(renderJson({ tags: "{{event.signal.tags}}", text: "host {{event.signal.host}}", n: 2, list: ["{{event.count}}"] }, scope)).toEqual({
      tags: ["vpn", "geo"],
      text: "host web-01",
      n: 2,
      list: [3],
    });
  });

  it("judge conditions on the event", () => {
    const e = scope.event;
    expect(holds([], e)).toBe(true);
    expect(holds([{ field: "signal.severity", op: "equals", value: "high" }], e)).toBe(true);
    expect(holds([{ field: "signal.severity", op: "not-equals", value: "high" }], e)).toBe(false);
    expect(holds([{ field: "signal.tags", op: "contains", value: "vpn" }], e)).toBe(true);
    expect(holds([{ field: "signal.host", op: "matches", value: "^web-\\d+$" }], e)).toBe(true);
    expect(holds([{ field: "signal.owner", op: "exists" }], e)).toBe(false);
    expect(holds([{ field: "count", op: "at-least", value: "3" }], e)).toBe(true);
    expect(holds([{ field: "count", op: "at-least", value: "4" }], e)).toBe(false);
  });
});

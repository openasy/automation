// What the search window (Cmd+K) finds in Automation: playbooks by name or description. They are read whole and
// filtered here.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { BookOpen } from "lucide-react";
import type { Playbook } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const found = await call<{ playbooks: Playbook[] }>("/api/v1/playbooks", { signal });
    return found.playbooks
      .filter((p) => [p.name, p.description].some((x) => x.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((p): SearchResult => ({
        id: `playbook:${p.id}`,
        label: p.name,
        detail: t(`triggers.${p.trigger.kind}`),
        kind: t("search.playbook"),
        icon: BookOpen,
        severity: p.lastRun?.state === "failed" ? "high" : undefined,
        href: `/playbooks/${p.id}`,
      }));
  };
}

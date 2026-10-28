// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  playbooksEnabled: number;
  /** Runs kept by state, dry runs left out. */
  runs: Array<{ state: string; n: number }>;
  waiting: number;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="automation",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_automation_playbooks_enabled Playbooks that are turned on.",
    "# TYPE openasy_automation_playbooks_enabled gauge",
    `openasy_automation_playbooks_enabled ${g.playbooksEnabled}`,
    "# HELP openasy_automation_runs Runs kept by state, dry runs left out.",
    "# TYPE openasy_automation_runs gauge",
    ...g.runs.map((r) => `openasy_automation_runs{state="${r.state}"} ${r.n}`),
    "# HELP openasy_automation_approvals_waiting Runs waiting for a person to approve a step.",
    "# TYPE openasy_automation_approvals_waiting gauge",
    `openasy_automation_approvals_waiting ${g.waiting}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}

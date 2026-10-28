import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SegmentedControl,
  SelectField,
  StatusBadge,
  StatusStrip,
  TextField,
  toLocale,
  useLocalePreference,
  usePath,
  useThemePreference,
  type Column,
  type ProductId,
  type Tone,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { BookOpen, Cable, CheckCheck, CircleX, History, KeyRound, LayoutDashboard, LogIn, LogOut, Play, Plus, Trash2, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  MfaSetupRequired,
  Unauthorized,
  type Connection,
  type ConnectionKind,
  type Playbook,
  type ProductLink,
  type Run,
  type RunDetail,
  type RunState,
  type Step,
  type StepKind,
  type StepState,
  type Summary,
} from "./api.ts";
import { useT } from "./i18n.ts";
import { search } from "./search.ts";

const PAGES = ["playbooks", "runs", "approvals", "connections", "account", "members", "signin", "tokens", "about"] as const;
type Route = { page: "overview" | (typeof PAGES)[number] } | { page: "playbook"; id: string } | { page: "run"; id: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "playbooks" && id) return { page: "playbook", id: decodeURIComponent(id) };
  if (page === "runs" && id) return { page: "run", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "overview" };
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
type Call = ReturnType<typeof useApi>;

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const pretty = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

const RUN_TONE: Record<RunState, Tone> = { running: "info", waiting: "warning", succeeded: "success", failed: "danger", refused: "neutral" };
const STEP_TONE: Record<StepState, Tone> = {
  ok: "success",
  failed: "danger",
  skipped: "neutral",
  planned: "info",
  waiting: "warning",
  approved: "success",
  refused: "neutral",
};

function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre tabIndex={0} aria-label={label} className="m-0 max-h-80 overflow-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-fg">
      {children}
    </pre>
  );
}

function RunBadge({ run }: { run: Pick<Run, "state" | "dry"> }) {
  const t = useT();
  return (
    <span className="flex flex-wrap items-center gap-1">
      <StatusBadge tone={RUN_TONE[run.state]}>{t(`runStates.${run.state}`)}</StatusBadge>
      {run.dry && <Badge>{t("runs.dry")}</Badge>}
    </span>
  );
}

function useRunColumns(): Column<Run>[] {
  const t = useT();
  return [
    {
      id: "when",
      header: t("runs.when"),
      width: "160px",
      sortValue: (r) => r.startedAt,
      cell: (r) => <span className="whitespace-nowrap">{when(r.startedAt)}</span>,
    },
    {
      id: "playbook",
      header: t("runs.playbook"),
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{r.playbook.name}</span>
          {r.waiting && <span className="automation-clamp text-2xs text-fg-muted">{r.waiting.text}</span>}
        </span>
      ),
    },
    { id: "cause", header: t("runs.cause"), width: "130px", cell: (r) => <span className="text-xs">{t(`causes.${r.cause}`, { who: r.startedBy })}</span> },
    { id: "state", header: t("runs.state"), width: "150px", sortValue: (r) => r.state, cell: (r) => <RunBadge run={r} /> },
  ];
}

// ---------------------------------------------------------------- Overview

function OverviewPage({ summary }: { summary: Summary }) {
  const t = useT();
  const s = summary;
  const columns = useRunColumns();
  return (
    <>
      <PageHeader
        title={t("overviewPage.overview")}
        description={t("overviewPage.description")}
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => navigate("/playbooks/new")}>
            {t("playbooksPage.newPlaybook")}
          </Button>
        }
      />
      {s.runs.waiting > 0 && (
        <Callout
          tone="warning"
          title={t("overviewPage.waiting", { count: s.runs.waiting })}
          action={
            <Button size="sm" onClick={() => navigate("/approvals")}>
              {t("overviewPage.look")}
            </Button>
          }
        >
          {t("overviewPage.waitingDetail")}
        </Callout>
      )}
      {s.connections === 0 && <Callout title={t("overviewPage.noConnections")}>{t("overviewPage.noConnectionsDetail")}</Callout>}
      <KpiGrid minWidth={150}>
        <KpiCard
          label={t("overviewPage.playbooks")}
          value={s.playbooks.enabled}
          unit={t("overviewPage.ofTotal", { total: s.playbooks.total })}
          icon={BookOpen}
          href="/playbooks"
        />
        <KpiCard label={t("overviewPage.runs30")} value={s.runs.last30Days} icon={History} trend={s.runs.perDay.map((d) => d.runs)} href="/runs" />
        <KpiCard label={t("overviewPage.failed")} value={s.runs.failed} icon={CircleX} tone={s.runs.failed ? "danger" : "success"} href="/runs" />
        <KpiCard
          label={t("overviewPage.waitingKpi")}
          value={s.runs.waiting}
          icon={CheckCheck}
          tone={s.runs.waiting ? "warning" : "success"}
          href="/approvals"
        />
        <KpiCard label={t("overviewPage.connections")} value={s.connections} icon={Cable} href="/connections" />
      </KpiGrid>
      <Panel title={t("overviewPage.last30Days")} description={t("overviewPage.last30DaysDetail")}>
        <StatusStrip
          label={t("overviewPage.last30Days")}
          height={36}
          start={t("overviewPage.daysAgo", { n: 30 })}
          end={t("overviewPage.today")}
          cells={s.runs.perDay.map((d) => ({
            id: d.day,
            label: day(d.day),
            tone: !d.runs ? "neutral" : d.failed ? (d.failed === d.runs ? "danger" : "warning") : "success",
            detail: t("overviewPage.dayDetail", { runs: d.runs, failed: d.failed }),
          }))}
        />
      </Panel>
      <Panel title={t("overviewPage.latest")} flush>
        <DataTable
          label={t("overviewPage.latest")}
          columns={columns}
          rows={s.latest}
          getRowId={(r) => r.id}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          minWidth={640}
          empty={<EmptyState title={t("runsPage.none")}>{t("runsPage.noneDetail")}</EmptyState>}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Playbooks

function PlaybooksPage({ call }: { call: Call }) {
  const t = useT();
  const { can } = useAuth();
  const [playbooks, setPlaybooks] = useState<Playbook[]>();
  useEffect(() => {
    void call<{ playbooks: Playbook[] }>("/api/v1/playbooks").then(
      (r) => setPlaybooks(r.playbooks),
      () => setPlaybooks([]),
    );
  }, [call]);
  const columns: Column<Playbook>[] = [
    {
      id: "name",
      header: t("playbooksPage.playbook"),
      sortValue: (p) => p.name,
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{p.name}</span>
          {p.description && <span className="automation-clamp text-2xs text-fg-muted">{p.description}</span>}
        </span>
      ),
    },
    { id: "trigger", header: t("playbooksPage.trigger"), width: "160px", cell: (p) => <TriggerText trigger={p.trigger} /> },
    { id: "steps", header: t("playbooksPage.steps"), width: "80px", align: "right", mono: true, cell: (p) => p.steps.length },
    { id: "runs", header: t("playbooksPage.runs30"), width: "100px", align: "right", mono: true, sortValue: (p) => p.runs30Days, cell: (p) => p.runs30Days },
    {
      id: "last",
      header: t("playbooksPage.lastRun"),
      width: "170px",
      cell: (p) =>
        p.lastRun ? (
          <StatusBadge tone={RUN_TONE[p.lastRun.state]}>{t(`runStates.${p.lastRun.state}`)}</StatusBadge>
        ) : (
          <span className="text-fg-muted">{t("playbooksPage.never")}</span>
        ),
    },
    {
      id: "enabled",
      header: t("playbooksPage.state"),
      width: "100px",
      cell: (p) => <StatusBadge tone={p.enabled ? "success" : "neutral"}>{p.enabled ? t("playbooksPage.on") : t("playbooksPage.off")}</StatusBadge>,
    },
  ];
  return (
    <>
      <PageHeader
        title={t("playbooksPage.playbooks")}
        description={t("playbooksPage.description")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => navigate("/playbooks/new")}>
              {t("playbooksPage.newPlaybook")}
            </Button>
          )
        }
      />
      <Panel title={t("playbooksPage.playbooks")} flush>
        <DataTable
          label={t("playbooksPage.playbooks")}
          columns={columns}
          rows={playbooks ?? []}
          loading={!playbooks}
          getRowId={(p) => p.id}
          onRowClick={(p) => navigate(`/playbooks/${p.id}`)}
          minWidth={760}
          empty={<EmptyState title={t("playbooksPage.none")}>{t("playbooksPage.noneDetail")}</EmptyState>}
        />
      </Panel>
    </>
  );
}

function TriggerText({ trigger }: { trigger: Playbook["trigger"] }) {
  const t = useT();
  return <span className="text-xs">{trigger.kind === "schedule" ? t("triggers.every", { n: trigger.everyMinutes }) : t(`triggers.${trigger.kind}`)}</span>;
}

/** The steps drawn one under the other, with what each does and where. */
function StepFlow({ steps, connections }: { steps: Step[]; connections: Connection[] }) {
  const t = useT();
  const target = (s: Step) => connections.find((c) => c.id === s.connection)?.name ?? s.connection ?? "";
  const main = (s: Step) => s.title ?? s.text ?? s.person ?? s.device ?? (s.path ? `${s.method} ${s.path}` : "");
  return (
    <ol className="automation-flow" aria-label={t("playbookPage.steps")}>
      {steps.map((s, i) => (
        <li key={s.id} data-n={i + 1}>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{t(`stepKinds.${s.kind}`)}</span>
            <Badge mono>{s.id}</Badge>
            {s.connection && <span className="text-xs text-fg-muted">{t("playbookPage.through", { name: target(s) })}</span>}
            {s.continueOnError && <Badge>{t("playbookPage.goesOn")}</Badge>}
          </span>
          <span className="automation-clamp block font-mono text-2xs text-fg-muted">{main(s)}</span>
        </li>
      ))}
    </ol>
  );
}

/** A starting point for a new playbook, with the connections this install has. */
function example(connections: Connection[]) {
  const inc = connections.find((c) => c.kind === "openasy" && c.product === "incidents");
  const msg = connections.find((c) => c.kind !== "openasy");
  return JSON.stringify(
    {
      name: "Critical signal",
      description: "Opens an incident for a critical SIEM signal, and tells the channel once someone approves.",
      trigger: { kind: "webhook" },
      conditions: [{ field: "severity", op: "equals", value: "critical" }],
      steps: [
        ...(inc ? [{ id: "open", kind: "incident.open", connection: inc.id, title: "{{event.title}}", severity: "critical" }] : []),
        { id: "ask", kind: "approval", text: "Tell the channel about {{event.title}}?" },
        ...(msg ? [{ id: "tell", kind: "message", connection: msg.id, text: "{{event.title}}: being handled." }] : []),
      ],
    },
    null,
    2,
  );
}

const definitionOf = (p: Playbook) =>
  JSON.stringify({ name: p.name, description: p.description, enabled: p.enabled, trigger: p.trigger, conditions: p.conditions, steps: p.steps }, null, 2);

function PlaybookPage({ call, id, reload }: { call: Call; id: string; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const editor = can("editor");
  const isNew = id === "new";
  const [p, setP] = useState<Playbook | null>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [text, setText] = useState("");
  const [event, setEvent] = useState("{}");
  const [token, setToken] = useState<string>();
  const [error, setError] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    void call<{ connections: Connection[] }>("/api/v1/connections").then(
      (r) => (setConnections(r.connections), isNew && setText(example(r.connections))),
      () => {},
    );
    if (!isNew)
      void call<Playbook>(`/api/v1/playbooks/${encodeURIComponent(id)}`).then(
        (x) => (setP(x), setText(definitionOf(x))),
        () => setP(null),
      );
  }, [call, id, isNew]);
  const save = async () => {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      setError(t("playbookPage.notJson"));
      return;
    }
    try {
      const r = await call<{ playbook: Playbook; webhookToken?: string }>(isNew ? "/api/v1/playbooks" : `/api/v1/playbooks/${id}`, {
        method: isNew ? "POST" : "PUT",
        body: JSON.stringify(body),
      });
      setError(undefined);
      setToken(r.webhookToken);
      setP(r.playbook);
      setText(definitionOf(r.playbook));
      reload();
      if (isNew) navigate(`/playbooks/${r.playbook.id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const run = async (dry: boolean) => {
    let e: unknown;
    try {
      e = JSON.parse(event);
    } catch {
      setRunError(t("playbookPage.notJson"));
      return;
    }
    try {
      const r = await call<Run>(`/api/v1/playbooks/${id}/run`, { method: "POST", body: JSON.stringify({ event: e, dry }) });
      navigate(`/runs/${r.id}`);
    } catch (err) {
      setRunError((err as Error).message);
    }
  };
  if (p === null)
    return (
      <EmptyState title={t("playbookPage.notFound")} action={<Button onClick={() => navigate("/playbooks")}>{t("playbookPage.back")}</Button>}>
        {t("playbookPage.notFoundDetail")}
      </EmptyState>
    );
  if (!isNew && !p) return <EmptyState title={t("product.loading")} icon={<BookOpen />} />;
  const hookUrl = `${window.location.origin}/hooks/${p?.id ?? ""}`;
  return (
    <>
      <PageHeader
        title={p?.name ?? t("playbooksPage.newPlaybook")}
        breadcrumbs={[{ label: t("playbooksPage.playbooks"), href: "/playbooks" }, { label: p?.name ?? t("playbooksPage.newPlaybook") }]}
        description={p ? t("playbookPage.updated", { who: p.updatedBy, when: when(p.updatedAt) }) : t("playbookPage.newDescription")}
        meta={p && <StatusBadge tone={p.enabled ? "success" : "neutral"}>{p.enabled ? t("playbooksPage.on") : t("playbooksPage.off")}</StatusBadge>}
        actions={
          p && (
            <span className="flex gap-1.5">
              <Button onClick={() => navigate(`/runs?playbook=${p.id}`)}>{t("playbookPage.runs")}</Button>
              {can("admin") &&
                (removing ? (
                  <Button
                    variant="danger"
                    icon={<Trash2 />}
                    onClick={() => void call(`/api/v1/playbooks/${p.id}`, { method: "DELETE" }).then(() => (reload(), navigate("/playbooks")))}
                  >
                    {t("playbookPage.deleteForGood")}
                  </Button>
                ) : (
                  <Button icon={<Trash2 />} onClick={() => setRemoving(true)}>
                    {t("playbookPage.delete")}
                  </Button>
                ))}
            </span>
          )
        }
      />
      {token && (
        <Callout tone="success" title={t("playbookPage.tokenOnce")}>
          <Code label={t("playbookPage.token")}>{token}</Code>
        </Callout>
      )}
      {p && (
        <div className="grid gap-2.5 xl:grid-cols-2">
          <Panel title={t("playbookPage.steps")} description={t("playbookPage.stepsDetail")}>
            <StepFlow steps={p.steps} connections={connections} />
          </Panel>
          <Panel title={t("playbookPage.startsWhen")}>
            <div className="flex flex-col gap-2 text-sm">
              <TriggerText trigger={p.trigger} />
              {p.conditions.length > 0 ? (
                <ul className="automation-list flex flex-col gap-0.5 font-mono text-xs">
                  {p.conditions.map((c, i) => (
                    <li key={i}>
                      {c.field} {c.op} {c.value ?? ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-xs text-fg-muted">{t("playbookPage.everyEvent")}</span>
              )}
              {p.trigger.kind === "webhook" && (
                <>
                  <Code label={t("playbookPage.hook")}>{`curl -sf -X POST -H "Authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' -d '{"severity":"critical"}' \\
  ${hookUrl}`}</Code>
                  {editor && (
                    <div>
                      <Button
                        size="sm"
                        icon={<KeyRound />}
                        onClick={() =>
                          void call<{ webhookToken: string }>(`/api/v1/playbooks/${p.id}/token`, { method: "POST" }).then((r) => setToken(r.webhookToken))
                        }
                      >
                        {t("playbookPage.newToken")}
                      </Button>
                    </div>
                  )}
                </>
              )}
              {p.nextAt && <span className="text-xs text-fg-muted">{t("playbookPage.next", { when: when(p.nextAt) })}</span>}
            </div>
          </Panel>
        </div>
      )}
      {p && editor && (
        <Panel title={t("playbookPage.tryIt")} description={t("playbookPage.tryItDetail")}>
          <textarea
            className="automation-editor short"
            aria-label={t("playbookPage.event")}
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            spellCheck={false}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<Play />} onClick={() => void run(true)}>
              {t("playbookPage.dryRun")}
            </Button>
            <Button size="sm" variant="primary" icon={<Play />} disabled={!p.enabled} onClick={() => void run(false)}>
              {t("playbookPage.runNow")}
            </Button>
            {runError && <span className="text-xs text-danger">{runError}</span>}
          </div>
        </Panel>
      )}
      <Panel title={t("playbookPage.definition")} description={t("playbookPage.definitionDetail")}>
        <textarea
          className="automation-editor"
          aria-label={t("playbookPage.definition")}
          value={text}
          readOnly={!editor}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        {editor && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void save()} disabled={!!p && text === definitionOf(p)}>
              {t("playbookPage.save")}
            </Button>
            {error && <span className="text-xs text-danger">{error}</span>}
          </div>
        )}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Runs and approvals

function RunsPage({ call }: { call: Call }) {
  const t = useT();
  const playbook = new URLSearchParams(window.location.search).get("playbook");
  const [state, setState] = useState<RunState | "all">("all");
  const [page, setPage] = useState<{ runs: Run[]; nextCursor?: string }>();
  const columns = useRunColumns();
  const query = useMemo(() => {
    const q = new URLSearchParams({ limit: "100" });
    if (state !== "all") q.set("state", state);
    if (playbook) q.set("playbook", playbook);
    return q.toString();
  }, [state, playbook]);
  useEffect(() => {
    setPage(undefined);
    void call<{ runs: Run[]; nextCursor?: string }>(`/api/v1/runs?${query}`).then(setPage, () => setPage({ runs: [] }));
  }, [call, query]);
  const more = () =>
    page?.nextCursor &&
    void call<{ runs: Run[]; nextCursor?: string }>(`/api/v1/runs?${query}&cursor=${encodeURIComponent(page.nextCursor)}`).then((n) =>
      setPage({ runs: [...page.runs, ...n.runs], nextCursor: n.nextCursor }),
    );
  return (
    <>
      <PageHeader
        title={t("runsPage.runs")}
        description={t("runsPage.description")}
        actions={
          <SegmentedControl
            label={t("runs.state")}
            value={state}
            onChange={setState}
            options={[
              { value: "all", label: t("runsPage.all") },
              ...(["failed", "waiting", "succeeded", "refused"] as const).map((s) => ({ value: s, label: t(`runStates.${s}`) })),
            ]}
          />
        }
      />
      <Panel title={t("runsPage.runs")} flush>
        <DataTable
          label={t("runsPage.runs")}
          columns={columns}
          rows={page?.runs ?? []}
          loading={!page}
          getRowId={(r) => r.id}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          minWidth={640}
          empty={<EmptyState title={t("runsPage.none")}>{t("runsPage.noneDetail")}</EmptyState>}
        />
        {page?.nextCursor && (
          <div className="border-t border-line px-3 py-2">
            <Button size="sm" onClick={more}>
              {t("runsPage.more")}
            </Button>
          </div>
        )}
      </Panel>
    </>
  );
}

/** Approve or refuse the step a run waits on, with an optional comment. */
function Decide({ call, run, done }: { call: Call; run: Run; done: () => void }) {
  const t = useT();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();
  const decide = async (approve: boolean) => {
    try {
      await call(`/api/v1/runs/${run.id}/decision`, { method: "POST", body: JSON.stringify({ approve, ...(comment.trim() && { comment: comment.trim() }) }) });
      setError(undefined);
      done();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <TextField label={t("decide.comment")} value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="primary" icon={<CheckCheck />} onClick={() => void decide(true)}>
          {t("decide.approve")}
        </Button>
        <Button size="sm" onClick={() => void decide(false)}>
          {t("decide.refuse")}
        </Button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  );
}

function RunPage({ call, id, reload }: { call: Call; id: string; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [run, setRun] = useState<RunDetail | null>();
  const load = useCallback(() => void call<RunDetail>(`/api/v1/runs/${encodeURIComponent(id)}`).then(setRun, () => setRun(null)), [call, id]);
  useEffect(() => {
    load();
    // A run that is going finishes within seconds; look again until it stops or waits.
    const timer = setInterval(load, 2_000);
    return () => clearInterval(timer);
  }, [load]);
  if (run === null)
    return (
      <EmptyState title={t("runPage.notFound")} action={<Button onClick={() => navigate("/runs")}>{t("runPage.back")}</Button>}>
        {t("runPage.notFoundDetail")}
      </EmptyState>
    );
  if (!run) return <EmptyState title={t("product.loading")} icon={<History />} />;
  return (
    <>
      <PageHeader
        title={run.playbook.name}
        breadcrumbs={[{ label: t("runsPage.runs"), href: "/runs" }, { label: when(run.startedAt) }]}
        description={t(`causes.${run.cause}`, { who: run.startedBy })}
        meta={<RunBadge run={run} />}
        actions={<Button onClick={() => navigate(`/playbooks/${run.playbook.id}`)}>{t("runPage.playbook")}</Button>}
      />
      {run.waiting && (
        <Callout tone="warning" title={run.waiting.text}>
          {can("editor") ? <Decide call={call} run={run} done={() => (load(), reload())} /> : t("runPage.waitsForEditor")}
        </Callout>
      )}
      <Panel title={t("runPage.steps")} description={run.dry ? t("runPage.dryDetail") : t("runPage.stepsDetail")}>
        <ol className="automation-flow" aria-label={t("runPage.steps")}>
          {run.stepsDone.map((s) => (
            <li key={s.position} data-n={s.position + 1}>
              <div className="flex flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{t(`stepKinds.${s.kind as StepKind}`)}</span>
                  <Badge mono>{s.stepId}</Badge>
                  <StatusBadge tone={STEP_TONE[s.state]}>{t(`stepStates.${s.state}`)}</StatusBadge>
                  {s.ms !== null && s.kind !== "approval" && <span className="text-2xs text-fg-muted">{s.ms} ms</span>}
                  {s.decidedBy && <span className="text-xs text-fg-muted">{t("runPage.decidedBy", { who: s.decidedBy, comment: s.comment ?? "" })}</span>}
                </span>
                {s.error && <span className="text-xs text-danger">{s.error}</span>}
                {s.request !== null && s.kind !== "approval" && <Code label={t("runPage.request")}>{pretty(s.request)}</Code>}
                {s.response && <Code label={t("runPage.response")}>{`${s.response.status}\n${pretty(s.response.body)}`}</Code>}
              </div>
            </li>
          ))}
        </ol>
      </Panel>
      <Panel title={t("runPage.event")}>
        <Code label={t("runPage.event")}>{pretty(run.event)}</Code>
      </Panel>
    </>
  );
}

function ApprovalsPage({ call, reload }: { call: Call; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [runs, setRuns] = useState<Run[]>();
  const load = useCallback(
    () =>
      void call<{ runs: Run[] }>("/api/v1/approvals").then(
        (r) => setRuns(r.runs),
        () => setRuns([]),
      ),
    [call],
  );
  useEffect(load, [load]);
  return (
    <>
      <PageHeader title={t("approvalsPage.approvals")} description={t("approvalsPage.description")} />
      {runs && !runs.length && <EmptyState title={t("approvalsPage.none")}>{t("approvalsPage.noneDetail")}</EmptyState>}
      {runs?.map((r) => (
        <Panel key={r.id} title={r.waiting?.text} description={t("approvalsPage.from", { playbook: r.playbook.name, when: when(r.startedAt) })}>
          <div className="flex flex-col gap-2">
            {can("editor") && <Decide call={call} run={r} done={() => (load(), reload())} />}
            <div>
              <Button size="sm" variant="ghost" onClick={() => navigate(`/runs/${r.id}`)}>
                {t("approvalsPage.seeRun")}
              </Button>
            </div>
          </div>
        </Panel>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- Connections

function ConnectionsPage({ call, reload }: { call: Call; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const admin = can("admin");
  const [connections, setConnections] = useState<Connection[]>();
  const [kind, setKind] = useState<ConnectionKind>("openasy");
  const [name, setName] = useState("");
  const [product, setProduct] = useState("incidents");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [tests, setTests] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const load = useCallback(
    () =>
      void call<{ connections: Connection[] }>("/api/v1/connections").then(
        (r) => setConnections(r.connections),
        () => setConnections([]),
      ),
    [call],
  );
  useEffect(load, [load]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await call("/api/v1/connections", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), kind, url: url.trim(), ...(kind === "openasy" && { product, token }) }),
      });
      setName("");
      setUrl("");
      setToken("");
      setError(undefined);
      load();
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const columns: Column<Connection>[] = [
    {
      id: "name",
      header: t("connectionsPage.connection"),
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{c.name}</span>
          <span className="automation-wrap font-mono text-2xs text-fg-muted">{c.address}</span>
        </span>
      ),
    },
    { id: "kind", header: t("connectionsPage.kind"), width: "150px", cell: (c) => <Badge>{c.kind === "openasy" ? c.product : t(`kinds.${c.kind}`)}</Badge> },
    { id: "used", header: t("connectionsPage.used"), width: "90px", align: "right", mono: true, cell: (c) => c.playbooks },
    {
      id: "act",
      header: "",
      width: "220px",
      align: "right",
      cell: (c) => (
        <span className="flex flex-col items-end gap-1">
          <span className="flex gap-1">
            {c.kind === "openasy" && can("editor") && (
              <Button
                size="xs"
                onClick={() =>
                  void call<{ ok: boolean; detail: string }>(`/api/v1/connections/${c.id}/test`, { method: "POST" }).then((r) =>
                    setTests((x) => ({ ...x, [c.id]: r })),
                  )
                }
              >
                {t("connectionsPage.test")}
              </Button>
            )}
            {admin && (
              <Button
                size="xs"
                variant="ghost"
                icon={<Trash2 />}
                aria-label={t("connectionsPage.delete", { name: c.name })}
                disabled={c.playbooks > 0}
                onClick={() => void call(`/api/v1/connections/${c.id}`, { method: "DELETE" }).then(() => (load(), reload()))}
              />
            )}
          </span>
          {tests[c.id] && <span className={`text-2xs ${tests[c.id]!.ok ? "text-success" : "text-danger"}`}>{tests[c.id]!.detail}</span>}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader title={t("connectionsPage.connections")} description={t("connectionsPage.description")} />
      <Panel title={t("connectionsPage.connections")} flush>
        <DataTable
          label={t("connectionsPage.connections")}
          columns={columns}
          rows={connections ?? []}
          loading={!connections}
          getRowId={(c) => c.id}
          minWidth={640}
          empty={<EmptyState title={t("connectionsPage.none")}>{t("connectionsPage.noneDetail")}</EmptyState>}
        />
      </Panel>
      {admin && (
        <Panel title={t("connectionsPage.add")} description={t("connectionsPage.addDetail")}>
          <form className="flex flex-col gap-2" onSubmit={add} aria-label={t("connectionsPage.add")}>
            <div className="grid gap-2 sm:grid-cols-2">
              <SelectField
                label={t("connectionsPage.kind")}
                value={kind}
                onChange={(e) => setKind(e.target.value as ConnectionKind)}
                options={(["openasy", "slack", "teams", "webhook"] as const).map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
              />
              <TextField label={t("connectionsPage.name")} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <TextField
              label={kind === "openasy" ? t("connectionsPage.address") : t("connectionsPage.webhookUrl")}
              mono
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={kind === "openasy" ? "https://incidents.example.com" : "https://hooks.slack.com/services/…"}
            />
            {kind === "openasy" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <TextField
                  label={t("connectionsPage.product")}
                  mono
                  value={product}
                  onChange={(e) => setProduct(e.target.value)}
                  hint={t("connectionsPage.productHint")}
                />
                <TextField
                  label={t("connectionsPage.token")}
                  mono
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  hint={t("connectionsPage.tokenHint")}
                />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" disabled={!name.trim() || !url.trim() || (kind === "openasy" && !token)}>
                {t("connectionsPage.addButton")}
              </Button>
              {error && <span className="text-xs text-danger">{error}</span>}
            </div>
          </form>
        </Panel>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settingsPage.${page}.title`)}
        description={t(`settingsPage.${page}.description`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const path = usePath();
  const route = parseRoute(path);
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const onSearch = useMemo(() => search(call, msg), [call, msg]);

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "automation" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => void call<Summary>("/api/v1/summary").then(setSummary, () => {}), [call]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const nav = [
    { id: "overview", label: msg("product.overview"), icon: LayoutDashboard },
    { id: "playbooks", label: msg("product.playbooks"), icon: BookOpen, count: summary?.playbooks.total || undefined },
    { id: "runs", label: msg("product.runs"), icon: History },
    { id: "approvals", label: msg("product.approvals"), icon: CheckCheck, count: summary?.runs.waiting || undefined },
    { id: "connections", label: msg("product.connections"), icon: Cable },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const settings = route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens";

  return (
    <AppShell
      product="automation"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={route.page === "playbook" ? "playbooks" : route.page === "run" ? "runs" : route.page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {settings ? (
        <SettingsPage page={route.page as "account" | "members" | "signin" | "tokens"} />
      ) : !summary ? (
        <EmptyState title={msg("product.loading")} icon={<BookOpen />}>
          {msg("product.reading")}
        </EmptyState>
      ) : route.page === "overview" ? (
        <OverviewPage summary={summary} />
      ) : route.page === "playbooks" ? (
        <PlaybooksPage call={call} />
      ) : route.page === "playbook" ? (
        <PlaybookPage key={route.id} call={call} id={route.id} reload={reload} />
      ) : route.page === "runs" ? (
        <RunsPage key={window.location.search} call={call} />
      ) : route.page === "run" ? (
        <RunPage key={route.id} call={call} id={route.id} reload={reload} />
      ) : route.page === "approvals" ? (
        <ApprovalsPage call={call} reload={reload} />
      ) : (
        <ConnectionsPage call={call} reload={reload} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Automation">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}

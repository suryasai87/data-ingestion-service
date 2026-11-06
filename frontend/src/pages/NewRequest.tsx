import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft, ArrowRight, Boxes, CheckCircle2, ChevronDown, Database, FileText, Gauge, Lock, Search, ShieldCheck, Sparkles, Waves, X, Zap,
} from "lucide-react";
import { KeyboardEvent, ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useBrand } from "@/brand/BrandContext";
import {
  AnimatedNumber, Badge, Button, Card, CheckRow, cx, EmptyState, ErrorState, Field, Input, PageHeader, Segmented, Select,
  Skeleton, SourcePill, Textarea, Toggle,
} from "@/components/ui";
import { ApiError, fmt, get, post, put, useApi } from "@/lib/api";
import type {
  CheckResult, Classification, CmdbApp, CmdbResponse, Connection, Connector, Destination, Forecast, IngestionConfig, ObjectsResponse, Pattern,
  RequestDetail, SourceTable,
} from "@/lib/types";

const STEPS = ["Source", "Objects", "Destination", "Schedule", "Ownership", "Review"] as const;
const INTERVALS = [5, 15, 30, 60, 240, 1440];
const CATEGORY_LABEL: Record<string, string> = { database: "Databases", warehouse: "Warehouses & federation", saas: "SaaS applications",
  files: "Files (SFTP, volumes, drives)", api: "REST APIs", streaming: "Streaming" };
const PATTERN_LABEL: Record<Pattern, string> = { cdc: "CDC", query: "Query-based", federation: "Federation", saas: "Managed", files: "Files",
  api: "REST API", stream: "Stream", community: "Community" };
const SPEC_CATEGORIES = new Set(["files", "api", "streaming"]);
const FAMILY_NAME: Record<string, string> = { postgresql: "PostgreSQL", sqlserver: "SQL Server", mysql: "MySQL", oracle: "Oracle", salesforce: "Salesforce",
  servicenow: "ServiceNow", sharepoint: "SharePoint", workday: "Workday", ga4: "GA4", jira: "Jira", google_drive: "Google Drive", hubspot: "HubSpot", confluence: "Confluence" };
const CLASS_INFO: Record<Classification, string> = {
  public: "Can be shared outside the company.",
  internal: "For employees; the data owner approves.",
  confidential: "Business-sensitive: needs a justification and an approver other than you.",
  restricted: "Regulated or personal data: justification and independent approval.",
};

export function emptyConfig(owner = ""): IngestionConfig {
  return {
    title: "",
    source: { connector: "", pattern: "cdc", connection: null, database: null },
    objects: [],
    schema: { scd_type: "SCD_TYPE_1", evolution: "add_new_columns" },
    destination: { environment: "dev", catalog: "", schema: "", table_prefix: "" },
    schedule: { mode: "interval", interval_minutes: 15, sla_minutes: 30 },
    ownership: { owner, classification: "internal", domain: "", cost_center: "", justification: "" },
    operations: { retries: 3, recovery: "auto_retry_then_ticket", reconciliation: true, alert_emails: [] },
  };
}

type Patch = { [K in keyof IngestionConfig]?: Partial<IngestionConfig[K]> | IngestionConfig[K] };
function apply(cfg: IngestionConfig, patch: Patch | Record<string, unknown>): IngestionConfig {
  const next = { ...cfg } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    const cur = (cfg as unknown as Record<string, unknown>)[k];
    next[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur) ? { ...cur, ...v } : v;
  }
  return next as unknown as IngestionConfig;
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
/** Additional readers: comma separated emails or group:<name>. */
const parseReaders = (text: string) => text.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
const validReader = (p: string) => EMAIL_RE.test(p) || /^group:\S.*$/.test(p);
const GXP_HELP = "Requires an independent e-signed approval, a qualification run with an evidence pack, and Dev → UAT → Prod promotion.";

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function stepValid(i: number, cfg: IngestionConfig, connector?: Connector): boolean {
  switch (i) {
    case 0: return !!cfg.source.connector && connector?.status !== "extension" && (!!cfg.source.connection || !connector?.connection_type);
    case 1: {
      if (!cfg.objects.length) return false;
      const p = cfg.source.pattern;
      if (p === "query" || p === "federation") return cfg.objects.every((o) => !!o.cursor_column);
      if (p === "files" || p === "api") return cfg.objects.every((o) => !!(o.options as { path?: string } | undefined)?.path);
      if (p === "stream") return cfg.objects.every((o) => !!(o.options as { topic?: string } | undefined)?.topic);
      return true;
    }
    case 2: return !!cfg.destination.catalog && !!cfg.destination.schema;
    case 3: return cfg.schedule.mode === "continuous" || cfg.schedule.interval_minutes > 0;
    case 4: return !!cfg.title.trim() && cfg.ownership.owner.includes("@") &&
      (!["confidential", "restricted"].includes(cfg.ownership.classification) || cfg.ownership.justification.trim().length >= 15) &&
      (cfg.ownership.readers ?? []).every(validReader);
    default: return true;
  }
}

export default function NewRequest() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { me, brand } = useBrand();
  const [cfg, setCfg] = useState<IngestionConfig>(() => emptyConfig());
  const [step, setStep] = useState(0);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [saving, setSaving] = useState<"draft" | "submit" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const connectors = useApi<{ items: Connector[]; source: string }>("/api/connectors");
  const destinations = useApi<{ items: Destination[] }>("/api/destinations");
  const existing = useApi<RequestDetail>(id ? `/api/requests/${id}` : null, [id]);
  const connector = connectors.data?.items.find((c) => c.id === cfg.source.connector);

  // initial state: edit an existing request, a draft handed over by the assistant, or a fresh config
  useEffect(() => {
    if (id && existing.data && loadedId !== id) {
      setCfg(apply(emptyConfig(me?.email ?? ""), existing.data.config as unknown as Record<string, unknown>));
      setLoadedId(id);
      setStep(5);
    }
  }, [id, existing.data, loadedId, me?.email]);
  useEffect(() => {
    if (id) return;
    let draft: Record<string, unknown> | null = null;
    try { draft = JSON.parse(sessionStorage.getItem("dis.draft") || "null"); sessionStorage.removeItem("dis.draft"); } catch { draft = null; }
    setCfg((c) => {
      let next = draft ? apply(emptyConfig(me?.email ?? ""), draft) : c;
      if (!next.ownership.owner && me?.email) next = apply(next, { ownership: { owner: me.email } });
      const pre = params.get("connector");
      if (pre && !next.source.connector) next = apply(next, { source: { connector: pre } });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, me?.email]);
  // default destination for the chosen environment
  useEffect(() => {
    const list = destinations.data?.items ?? [];
    const d = list.find((x) => x.environment === cfg.destination.environment && x.allowed);
    if (d && (cfg.destination.catalog !== d.catalog || cfg.destination.schema !== d.schema) &&
        !list.some((x) => x.catalog === cfg.destination.catalog && x.schema === cfg.destination.schema && x.environment === cfg.destination.environment)) {
      setCfg((c) => apply(c, { destination: { catalog: d.catalog, schema: d.schema } }));
    }
  }, [destinations.data, cfg.destination.environment, cfg.destination.catalog, cfg.destination.schema]);

  const set = (patch: Patch | Record<string, unknown>) => setCfg((c) => apply(c, patch));

  // live forecast + checks (debounced), recomputed on every change
  const debounced = useDebounced(cfg, 350);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [fcError, setFcError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!debounced.source.connector) { setForecast(null); return; }
    const n = ++seq.current;
    post<Forecast>("/api/forecast", { config: debounced })
      .then((f) => { if (n === seq.current) { setForecast(f); setFcError(null); } })
      .catch((e) => { if (n === seq.current) setFcError(e instanceof ApiError ? e.detail : String(e)); });
    post<{ checks: CheckResult[] }>("/api/validate", { config: debounced, live: false })
      .then((r) => { if (n === seq.current) setChecks(r.checks); })
      .catch(() => { /* checks are advisory while editing */ });
  }, [debounced]);

  // live (workspace) checks when the review step opens
  const [liveChecks, setLiveChecks] = useState<CheckResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (step !== 5) return;
    setChecking(true);
    setLiveChecks(null);
    post<{ checks: CheckResult[] }>("/api/validate", { config: cfg, live: true })
      .then((r) => setLiveChecks(r.checks)).catch((e) => setLiveChecks([{ key: "live", label: "Live checks", status: "warn",
        detail: e instanceof ApiError ? e.detail : "Couldn't reach the workspace for live checks." }]))
      .finally(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  async function save(submit: boolean) {
    setSaving(submit ? "submit" : "draft");
    setSaveError(null);
    try {
      let rid = id && loadedId === id ? id : null;
      if (rid) await put<RequestDetail>(`/api/requests/${rid}`, { config: cfg });
      else rid = (await post<RequestDetail>("/api/requests", { config: cfg, channel: "app" })).request.id;
      if (submit) await post<RequestDetail>(`/api/requests/${rid}/submit`);
      nav(`/requests/${rid}`);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.detail : String(e));
    } finally {
      setSaving(null);
    }
  }

  if (id && existing.loading) return <div className="space-y-4"><Skeleton className="h-9 w-72" /><Skeleton className="h-[420px] w-full" /></div>;
  if (id && existing.error) return <ErrorState error={existing.error} onRetry={existing.reload} />;

  const canNext = stepValid(step, cfg, connector);
  const allChecks = step === 5 && liveChecks ? liveChecks : checks;
  const failing = allChecks.filter((c) => c.status === "fail");

  return (
    <div>
      <PageHeader eyebrow={id ? `Edit ${id}` : "New request"} title="Configure ingestion"
        subtitle={<>No custom pipeline code. Pick a source, choose what lands in {brand.destination_label}, and see the cost, time to data and SLA before you submit.</>}
        actions={<SourcePill source={forecast?.source} reason={forecast?.degraded_reason} />} />

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <Card className="p-5 md:p-6">
            <div className="mb-6 overflow-x-auto"><div className="min-w-[560px]"><Stepper steps={[...STEPS]} current={step} onJump={(i) => i < step && setStep(i)} /></div></div>
            <AnimatePresence mode="wait">
              <motion.div key={step} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.3, ease: "easeOut" }}>
                {step === 0 && <SourceStep cfg={cfg} set={set} connectors={connectors.data?.items} loading={connectors.loading} error={connectors.error} retry={connectors.reload} />}
                {step === 1 && <ObjectsStep cfg={cfg} set={set} connector={connector} />}
                {step === 2 && <DestinationStep cfg={cfg} set={set} destinations={destinations.data?.items ?? []} label={brand.destination_label} />}
                {step === 3 && <ScheduleStep cfg={cfg} set={set} connector={connector} />}
                {step === 4 && <OwnershipStep cfg={cfg} set={set} defaultOwner={me?.email ?? ""} />}
                {step === 5 && <ReviewStep cfg={cfg} connector={connector} checks={allChecks} checking={checking} onEdit={setStep} />}
              </motion.div>
            </AnimatePresence>

            {saveError && <div className="mt-5"><ErrorState error={saveError} /></div>}
            <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t pt-5">
              <Button variant="ghost" icon={<ArrowLeft size={15} />} disabled={step === 0} onClick={() => setStep(step - 1)}>Back</Button>
              <div className="flex items-center gap-2">
                {step < 5 ? (
                  <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Continue <ArrowRight size={15} /></Button>
                ) : (
                  <>
                    <Button variant="outline" loading={saving === "draft"} disabled={!!saving || me?.kiosk} title={me?.kiosk ? "Read-only mode" : undefined}
                      onClick={() => save(false)}>Save draft</Button>
                    <Button variant="primary" loading={saving === "submit"} disabled={!!saving || failing.length > 0 || checking || me?.kiosk}
                      title={me?.kiosk ? "Read-only mode" : failing.length ? "Fix the failing checks first" : undefined}
                      onClick={() => save(true)}>Submit for approval</Button>
                  </>
                )}
              </div>
            </div>
          </Card>
          <Lifecycle className="mt-5" />
        </div>

        <aside className="lg:col-span-4">
          <div className="space-y-4 lg:sticky lg:top-2">
            <ForecastRail forecast={forecast} error={fcError} hasSource={!!cfg.source.connector} onApply={(p) => set(p)} />
            <SummaryCard cfg={cfg} checks={allChecks} connector={connector} />
          </div>
        </aside>
      </div>
    </div>
  );
}

// --- stepper + lifecycle --------------------------------------------------------------------------------------------
function Stepper({ steps, current, onJump }: { steps: string[]; current: number; onJump: (i: number) => void }) {
  return (
    <ol className="flex items-center" aria-label="Steps">
      {steps.map((s, i) => {
        const done = i < current, active = i === current;
        return (
          <li key={s} className="flex flex-1 items-center last:flex-none">
            <button type="button" onClick={() => onJump(i)} disabled={!done} aria-current={active ? "step" : undefined}
              className={cx("flex items-center gap-2 rounded-md px-1 py-1 text-left transition", done && "hover:text-foreground")}>
              <span className={cx("grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[length:var(--text-ui-xs)] font-medium transition",
                done ? "border-primary-solid bg-primary-solid text-white" : active ? "border-primary text-primary" : "text-subtle")}>
                {done ? <CheckCircle2 size={13} /> : i + 1}
              </span>
              <span className={cx("whitespace-nowrap text-[length:var(--text-ui-sm)]", active ? "font-medium text-foreground" : "text-subtle")}>{s}</span>
            </button>
            {i < steps.length - 1 && <span className={cx("mx-2 h-px flex-1", done ? "bg-primary-solid" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}

function Lifecycle({ className }: { className?: string }) {
  const items = ["Draft", "Validation", "Approval", "Deployment", "Monitoring"];
  return (
    <div className={cx("flex items-center gap-2 px-1 text-[length:var(--text-ui-xs)] text-subtle", className)}>
      {items.map((s, i) => (
        <span key={s} className="flex items-center gap-2">
          <span className={cx("h-2 w-2 rounded-full", i === 0 ? "bg-primary" : "border border-border-strong")} />
          <span className={i === 0 ? "text-foreground" : ""}>{s}</span>
          {i < items.length - 1 && <span className="mx-1 h-px w-6 bg-border md:w-10" />}
        </span>
      ))}
      <span className="ml-auto hidden md:inline">Both channels create the same governed configuration.</span>
    </div>
  );
}

// --- step 1: source -----------------------------------------------------------------------------------------------
function SourceStep({ cfg, set, connectors, loading, error, retry }: {
  cfg: IngestionConfig; set: (p: Patch) => void; connectors?: Connector[]; loading: boolean; error: string | null; retry: () => void;
}) {
  const [q, setQ] = useState("");
  const selected = connectors?.find((c) => c.id === cfg.source.connector);
  const conns = useApi<{ items: Connection[]; source: string; degraded_reason?: string }>(
    selected?.connection_type ? `/api/connections?connector=${selected.id}` : null, [selected?.id]);
  useEffect(() => {
    const items = conns.data?.items ?? [];
    if (selected && !cfg.source.connection && items.length) {
      const pick = items.find((c) => c.demo) ?? items.find((c) => c.usable);
      if (pick) choose(pick);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conns.data, selected?.id]);

  function choose(c: Connection | undefined) {
    if (!c) { set({ source: { connection: null } }); return; }
    const pats = c.patterns ?? selected?.patterns ?? [];
    set({ source: { connection: c.name, via: c.via ?? "connection", pattern: pats.includes(cfg.source.pattern) ? cfg.source.pattern : pats[0] ?? cfg.source.pattern } });
  }
  const current = conns.data?.items.find((c) => c.name === cfg.source.connection);
  const allowed = (current?.patterns ?? selected?.patterns ?? []);

  if (loading) return <div className="grid grid-cols-2 gap-3 md:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;
  if (error) return <ErrorState error={error} onRetry={retry} />;
  const list = (connectors ?? []).filter((c) => c.enabled && (!q || `${c.name} ${c.description}`.toLowerCase().includes(q.toLowerCase())));
  const groups = ["database", "warehouse", "saas", "files", "api", "streaming"].map((g) => ({ g, items: list.filter((c) => c.category === g) })).filter((x) => x.items.length);

  return (
    <div className="space-y-6">
      <StepIntro icon={<Database size={16} />} title="Where does the data come from?" body="Pick a supported source. Credentials stay in the Unity Catalog connection, never in the request." />
      <div className="relative max-w-sm">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
        <Input aria-label="Search connectors" placeholder="Search sources" value={q} onChange={(e) => setQ(e.target.value)} className="w-full pl-9" />
      </div>
      {groups.map(({ g, items }) => (
        <div key={g}>
          <div className="mb-2.5 text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.14em] text-subtle">{CATEGORY_LABEL[g]}</div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((c) => {
              const active = c.id === cfg.source.connector;
              return (
                <motion.button key={c.id} type="button" whileHover={{ y: -2 }} whileTap={{ scale: 0.99 }} transition={{ type: "spring", stiffness: 520, damping: 32 }}
                  onClick={() => set({ source: { connector: c.id, pattern: c.patterns[0], connection: null, database: null }, objects: [] } as Patch)}
                  aria-pressed={active} data-testid={`connector-${c.id}`}
                  className={cx("group relative rounded-lg border p-3.5 text-left transition",
                    active ? "border-primary bg-accent-soft" : "bg-elevated hover:border-border-strong", c.status === "extension" && "opacity-80")}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{c.name}</span>
                    {c.status !== "supported" && <Badge tone={c.status === "preview" ? "info" : "neutral"}>{c.status === "preview" ? "Preview" : "Extension"}</Badge>}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {c.patterns.map((p) => <span key={p} className="rounded bg-muted px-1.5 py-0.5 text-[length:var(--text-ui-xs)] text-muted-foreground">{PATTERN_LABEL[p]}</span>)}
                  </div>
                  {!!c.history_pipelines && <div className="mt-2 text-[length:var(--text-ui-xs)] text-subtle">Forecast learned from {c.history_pipelines} pipelines</div>}
                </motion.button>
              );
            })}
          </div>
        </div>
      ))}

      {selected && selected.status === "extension" && (
        <div className="rounded-lg border border-dashed p-4 text-[length:var(--text-ui-sm)]">
          <div className="font-medium">{selected.name} needs a platform extension</div>
          <p className="mt-1 text-muted-foreground">{selected.description}</p>
          <Link to={`/assistant?ask=${encodeURIComponent(selected.name)}`} className="mt-2 inline-block text-primary hover:underline">Ask the assistant about onboarding it</Link>
        </div>
      )}

      {selected && selected.status !== "extension" && !selected.connection_type && (
        <div className="rounded-lg border bg-background/40 p-4 text-[length:var(--text-ui-sm)]" data-testid="no-connection">
          <div className="font-medium">No connection needed</div>
          <p className="mt-1 text-muted-foreground">{patternHint(cfg.source.pattern, selected)} Give the volume path of each file set in the next step; the pipeline reads it as the service principal.</p>
        </div>
      )}

      {selected && selected.status !== "extension" && !!selected.connection_type && (
        <div className="grid gap-4 rounded-lg border bg-background/40 p-4 md:grid-cols-2">
          <Field label="Connection" hint={conns.data?.degraded_reason ? "Couldn't list connections from the workspace." : "Connections the service is allowed to use."}>
            {conns.loading ? <Skeleton className="h-10" /> : (
              <Select aria-label="Connection" value={cfg.source.connection ?? ""} onChange={(e) => choose(conns.data?.items.find((c) => c.name === e.target.value))}
                options={[{ value: "", label: (conns.data?.items.length ?? 0) ? "Choose a connection" : "No usable connection" },
                  ...(conns.data?.items ?? []).map((c) => ({ value: c.name, label: `${c.name}${c.via === "uc_catalog" ? "  (UC catalog)" : ""}${c.demo ? "  · demo source" : ""}${c.usable ? "" : "  (no access)"}`, disabled: !c.usable }))]} />
            )}
          </Field>
          {selected.patterns.length > 1 ? (
            <Field group label="Ingestion pattern" hint={current?.via === "uc_catalog"
              ? "This source is registered in Unity Catalog, so Lakeflow Connect reads it query-based. Log-based CDC needs a database connection."
              : patternHint(cfg.source.pattern, selected)}>
              <div><Segmented ariaLabel="Ingestion pattern" value={cfg.source.pattern} onChange={(v) => set({ source: { pattern: v } })}
                options={selected.patterns.map((p) => ({ value: p, label: PATTERN_LABEL[p], disabled: !allowed.includes(p) }))} /></div>
            </Field>
          ) : (
            <Field group label="Ingestion pattern" hint={patternHint(cfg.source.pattern, selected)}><div className="pt-2"><Badge tone="primary">{PATTERN_LABEL[selected.patterns[0]]}</Badge></div></Field>
          )}
          <div className="flex items-center gap-2 text-[length:var(--text-ui-xs)] text-subtle md:col-span-2"><Lock size={12} /> Credentials managed in the connection (vault); the request only names it.</div>
        </div>
      )}
    </div>
  );
}

function patternHint(p: Pattern, c: Connector & { cdc_architecture?: string | null }): string {
  if (p === "cdc") return c.capabilities.needs_gateway
    ? "Log-based change capture through an always-on ingestion gateway. Captures every change, including hard deletes."
    : "Integrated log-based CDC in one serverless pipeline. Captures hard deletes; no gateway to run.";
  if (p === "query") return "Serverless incremental reads on a cursor column (e.g. updated_at). No gateway; hard deletes are synced periodically.";
  if (p === "federation") return "Read query-based from the connection's Lakehouse Federation foreign catalog, incrementally on one cursor column per table.";
  if (p === "api") return "A serverless pipeline calls the API through the Unity Catalog HTTP connection on every run and lands the JSON response (payload as VARIANT).";
  if (p === "community") return "A Lakeflow community connector (Python Data Source) published once by the platform team.";
  if (p === "saas") return "Managed API connector, serverless, incremental where the application allows.";
  if (p === "files") return "New and changed files are picked up incrementally, exactly once.";
  return "Records stream in continuously.";
}

function StepIntro({ icon, title, body }: { icon: ReactNode; title: string; body: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent-soft text-primary">{icon}</span>
      <div>
        <h2 className="text-[length:var(--text-ui-lg)] font-medium tracking-tight">{title}</h2>
        <p className="mt-0.5 text-[length:var(--text-ui-sm)] text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

// --- step 2: objects ----------------------------------------------------------------------------------------------
function ObjectsStep({ cfg, set, connector }: { cfg: IngestionConfig; set: (p: Patch | Record<string, unknown>) => void; connector?: Connector }) {
  const name = cfg.source.connection;
  const objs = useApi<ObjectsResponse & { database?: string }>(name ? `/api/connections/${encodeURIComponent(name)}/objects?connector=${cfg.source.connector}` : null, [name]);
  const [q, setQ] = useState("");
  const [schema, setSchema] = useState("all");
  const [manual, setManual] = useState("");
  const query = cfg.source.pattern === "query" || cfg.source.pattern === "federation";
  const specMode = SPEC_CATEGORIES.has(connector?.category ?? "") || cfg.source.pattern === "files" || cfg.source.pattern === "api" || cfg.source.pattern === "stream";
  useEffect(() => {
    if (objs.data?.database && cfg.source.database !== objs.data.database) set({ source: { database: objs.data.database } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objs.data?.database]);

  const selectedKey = (t: { schema: string; name?: string; table?: string }) => `${t.schema}.${t.name ?? t.table}`;
  const sel = new Set(cfg.objects.map((o) => selectedKey(o)));
  const tables = (objs.data?.tables ?? []).filter((t) => (schema === "all" || t.schema === schema) && (!q || `${t.schema}.${t.name}`.toLowerCase().includes(q.toLowerCase())));

  function toggle(t: SourceTable) {
    const k = selectedKey(t);
    if (sel.has(k)) set({ objects: cfg.objects.filter((o) => selectedKey(o) !== k) });
    else set({ objects: [...cfg.objects, { schema: t.schema, table: t.name, primary_keys: t.primary_keys, cursor_column: t.cursor_candidates[0] ?? null, rows_est: t.rows_est }] });
  }
  function toggleAll() {
    const keys = new Set(tables.map(selectedKey));
    const allOn = tables.every((t) => sel.has(selectedKey(t)));
    if (allOn) set({ objects: cfg.objects.filter((o) => !keys.has(selectedKey(o))) });
    else set({ objects: [...cfg.objects, ...tables.filter((t) => !sel.has(selectedKey(t))).map((t) => ({ schema: t.schema, table: t.name, primary_keys: t.primary_keys, cursor_column: t.cursor_candidates[0] ?? null, rows_est: t.rows_est }))] });
  }
  function addManual() {
    const add = manual.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const [a, b] = s.includes(".") ? s.split(".", 2) : [connector?.category === "saas" ? "objects" : "", s];
      return { schema: a, table: b, primary_keys: [], cursor_column: null, rows_est: null };
    }).filter((o) => !sel.has(`${o.schema}.${o.table}`));
    set({ objects: [...cfg.objects, ...add] });
    setManual("");
  }
  function setObj(i: number, patch: Record<string, unknown>) {
    set({ objects: cfg.objects.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  }

  if (specMode) return <SpecObjects cfg={cfg} set={set} connector={connector} />;
  return (
    <div className="space-y-5">
      <StepIntro icon={<Boxes size={16} />} title="What should land?" body={<>Select tables or objects from <span className="num text-foreground">{name ?? "the source"}</span>. 50+ tables are one bulk request; large tables are snapshotted in chunks automatically.</>} />
      {objs.loading && <Skeleton className="h-64" />}
      {objs.error && <ErrorState error={objs.error} onRetry={objs.reload} />}
      {objs.data && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
              <Input aria-label="Filter tables" placeholder="Filter tables" value={q} onChange={(e) => setQ(e.target.value)} className="w-full pl-9" />
            </div>
            {objs.data.schemas.length > 1 && (
              <Select aria-label="Schema" value={schema} onChange={(e) => setSchema(e.target.value)} className="w-44"
                options={[{ value: "all", label: "All schemas" }, ...objs.data.schemas.map((s) => ({ value: s, label: s }))]} />
            )}
            <Badge tone={objs.data.browse === "direct" ? "success" : objs.data.browse === "federation" ? "info" : "neutral"}>
              {objs.data.browse === "direct" ? "Live from source" : objs.data.browse === "federation" ? "Via federation" : "Enter manually"}
            </Badge>
          </div>
          {tables.length > 0 ? (
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-[length:var(--text-ui-sm)]">
                <thead className="bg-muted/50 text-left text-[length:var(--text-ui-xs)] uppercase tracking-[0.1em] text-subtle">
                  <tr>
                    <th scope="col" className="w-10 px-3 py-2.5"><input type="checkbox" aria-label="Select all" checked={tables.every((t) => sel.has(selectedKey(t)))} onChange={toggleAll} className="accent-[hsl(var(--primary-solid))]" /></th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Table</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Rows</th>
                    <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">Key</th>
                    <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">Readiness</th>
                  </tr>
                </thead>
                <tbody>
                  {tables.map((t) => {
                    const on = sel.has(selectedKey(t));
                    return (
                      <tr key={selectedKey(t)} onClick={() => toggle(t)} className={cx("cursor-pointer border-t transition", on ? "bg-accent-soft/60" : "hover:bg-muted/40")}>
                        <td className="px-3 py-2.5"><input type="checkbox" aria-label={`Select ${t.schema}.${t.name}`} checked={on} onChange={() => toggle(t)} onClick={(e) => e.stopPropagation()} className="accent-[hsl(var(--primary-solid))]" /></td>
                        <td className="px-3 py-2.5"><span className="text-subtle">{t.schema}.</span><span className="font-medium">{t.name}</span></td>
                        <td className="num px-3 py-2.5 text-right text-muted-foreground">{fmt.int(t.rows_est)}</td>
                        <td className="hidden px-3 py-2.5 md:table-cell">{t.primary_keys.length ? <span className="num text-[length:var(--text-ui-xs)] text-muted-foreground">{t.primary_keys.join(", ")}</span> : <span className="text-subtle">—</span>}</td>
                        <td className="hidden px-3 py-2.5 lg:table-cell">{t.issues.length ? <Badge tone="warning">{t.issues[0].split(":")[0]}</Badge> : <Badge tone="success" dot>Ready</Badge>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : objs.data.browse !== "manual" ? <EmptyState title="No tables match" body="Clear the filter or pick another schema." /> : null}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1">
              <Field label={objs.data.browse === "manual" ? "Objects to ingest" : "Add by name"} hint="Comma or space separated, e.g. schema.table or Account, Opportunity">
                <Input aria-label="Add objects by name" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === "Enter" && manual.trim() && addManual()} placeholder="schema.table" />
              </Field>
            </div>
            <Button onClick={addManual} disabled={!manual.trim()}>Add</Button>
          </div>
        </>
      )}

      {cfg.objects.length > 0 && (
        <div className="rounded-lg border bg-background/40">
          <div className="flex items-center justify-between border-b px-4 py-2.5 text-[length:var(--text-ui-sm)]">
            <span className="font-medium">{cfg.objects.length} selected</span>
            <button className="text-[length:var(--text-ui-xs)] text-subtle hover:text-foreground" onClick={() => set({ objects: [] })}>Clear</button>
          </div>
          <div className="scroll-y max-h-64 divide-y">
            {cfg.objects.map((o, i) => (
              <div key={`${o.schema}.${o.table}`} className="grid grid-cols-1 items-center gap-2 px-4 py-2.5 md:grid-cols-[1fr_1fr_1fr]">
                <div className="truncate text-[length:var(--text-ui-sm)]"><span className="text-subtle">{o.schema ? `${o.schema}.` : ""}</span>{o.table}</div>
                <Input aria-label={`Primary keys for ${o.table}`} placeholder="primary keys" value={o.primary_keys.join(", ")}
                  onChange={(e) => setObj(i, { primary_keys: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} className="h-8" />
                {query ? (
                  <Input aria-label={`Cursor column for ${o.table}`} placeholder="cursor column (required)" value={o.cursor_column ?? ""}
                    onChange={(e) => setObj(i, { cursor_column: e.target.value || null })} className={cx("h-8", !o.cursor_column && "border-warning/60")} />
                ) : <span className="text-[length:var(--text-ui-xs)] text-subtle">{o.rows_est != null ? `${fmt.int(o.rows_est)} rows` : ""}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- step 3: destination ------------------------------------------------------------------------------------------
function DestinationStep({ cfg, set, destinations, label }: { cfg: IngestionConfig; set: (p: Patch) => void; destinations: Destination[]; label: string }) {
  const [more, setMore] = useState(false);
  const envs = (["dev", "uat", "prod"] as const).map((e) => ({ value: e, label: e.toUpperCase(), disabled: !destinations.some((d) => d.environment === e && d.allowed) }));
  const d = destinations.find((x) => x.catalog === cfg.destination.catalog && x.schema === cfg.destination.schema);
  const preview = cfg.objects.slice(0, 4).map((o) => `${cfg.destination.catalog}.${cfg.destination.schema}.${(cfg.destination.table_prefix ?? "") + o.table}`.toLowerCase());
  return (
    <div className="space-y-6">
      <StepIntro icon={<Waves size={16} />} title={`Where in ${label}?`} body="Choose the environment. Tables land in the approved schema for it, governed by Unity Catalog." />
      <Field group label="Environment"><div><Segmented ariaLabel="Environment" value={cfg.destination.environment} onChange={(v) => set({ destination: { environment: v } })} options={envs} /></div></Field>
      <div className="rounded-lg border bg-background/40 p-4">
        <div className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.12em] text-subtle">Destination</div>
        <div className="mt-1 text-[length:var(--text-ui-md)] font-medium">{d?.label ?? `${label} · ${cfg.destination.environment.toUpperCase()}`}</div>
        <div className="num mt-0.5 text-[length:var(--text-ui-sm)] text-muted-foreground">{cfg.destination.catalog ? `${cfg.destination.catalog}.${cfg.destination.schema}` : "No approved destination for this environment"}</div>
        {preview.length > 0 && (
          <div className="mt-3 space-y-1 border-t pt-3">
            {preview.map((p) => <div key={p} className="num truncate text-[length:var(--text-ui-xs)] text-subtle">{p}</div>)}
            {cfg.objects.length > 4 && <div className="text-[length:var(--text-ui-xs)] text-subtle">+ {cfg.objects.length - 4} more</div>}
          </div>
        )}
      </div>
      <Field group label="Changes" hint={cfg.schema.scd_type === "SCD_TYPE_2" ? "Keeps every version of a row with __START_AT / __END_AT; costs more to merge and store." : "Keeps the current state of every row (upserts + deletes)."}>
        <div><Segmented ariaLabel="History" value={cfg.schema.scd_type} onChange={(v) => set({ schema: { scd_type: v } })}
          options={[{ value: "SCD_TYPE_1", label: "Current state (SCD 1)" }, { value: "SCD_TYPE_2", label: "Full history (SCD 2)" }]} /></div>
      </Field>
      <Disclosure open={more} onToggle={() => setMore(!more)} label="More options">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Table prefix" hint="Optional, e.g. erp_"><Input aria-label="Table prefix" value={cfg.destination.table_prefix ?? ""} onChange={(e) => set({ destination: { table_prefix: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") } })} /></Field>
          <Field label="Schema evolution" hint="New source columns are added automatically.">
            <Select aria-label="Schema evolution" value={cfg.schema.evolution} onChange={(e) => set({ schema: { evolution: e.target.value as "add_new_columns" | "none" } })}
              options={[{ value: "add_new_columns", label: "Add new columns" }, { value: "none", label: "Fail on change" }]} />
          </Field>
        </div>
      </Disclosure>
    </div>
  );
}

function Disclosure({ open, onToggle, label, children }: { open: boolean; onToggle: () => void; label: string; children: ReactNode }) {
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex items-center gap-1.5 text-[length:var(--text-ui-sm)] text-muted-foreground hover:text-foreground">
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ type: "spring", stiffness: 500, damping: 30 }}><ChevronDown size={15} /></motion.span>{label}
      </button>
      <AnimatePresence initial={false}>
        {open && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden"><div className="pt-4">{children}</div></motion.div>}
      </AnimatePresence>
    </div>
  );
}

// --- step 4: schedule ---------------------------------------------------------------------------------------------
function ScheduleStep({ cfg, set, connector }: { cfg: IngestionConfig; set: (p: Patch) => void; connector?: Connector }) {
  const [more, setMore] = useState(false);
  const floor = connector?.capabilities.min_interval_minutes ?? 5;
  const label = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${m / 60} h` : "Daily");
  return (
    <div className="space-y-6">
      <StepIntro icon={<Zap size={16} />} title="How fresh does it need to be?" body="Set the refresh and the freshness you need. The forecast shows the cost of every choice." />
      <Field group label="Load mode"><div><Segmented ariaLabel="Load mode" value={cfg.schedule.mode} onChange={(v) => set({ schedule: { mode: v } })}
        options={[{ value: "interval", label: "Scheduled" }, { value: "continuous", label: "Continuous" }]} /></div></Field>
      {cfg.schedule.mode === "interval" && (
        <Field group label="Refresh every" hint={`The ${connector?.name ?? "connector"} floor is ${floor} min.`}>
          <div><Segmented ariaLabel="Refresh interval" value={String(cfg.schedule.interval_minutes)} onChange={(v) => set({ schedule: { interval_minutes: Number(v) } })}
            options={INTERVALS.map((m) => ({ value: String(m), label: label(m), disabled: m < floor }))} /></div>
        </Field>
      )}
      <Field group label="Freshness target (SLA)" hint="A change in the source should be queryable within this many minutes.">
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="SLA minutes" type="number" min={1} value={cfg.schedule.sla_minutes} onChange={(e) => set({ schedule: { sla_minutes: Math.max(1, Number(e.target.value) || 1) } })} className="w-28" />
          <span className="text-[length:var(--text-ui-sm)] text-subtle">minutes</span>
          {[15, 30, 60, 240, 1440].map((m) => (
            <button key={m} type="button" onClick={() => set({ schedule: { sla_minutes: m } })}
              className={cx("rounded-full border px-2.5 py-0.5 text-[length:var(--text-ui-xs)] transition", cfg.schedule.sla_minutes === m ? "border-primary text-primary" : "text-muted-foreground hover:text-foreground")}>{label(m)}</button>
          ))}
        </div>
      </Field>
      <Disclosure open={more} onToggle={() => setMore(!more)} label="Recovery and controls">
        <div className="grid gap-5 md:grid-cols-2">
          <Field group label="Automatic retries" hint="Transient failures retry first; the rest open a ticket.">
            <div><Segmented ariaLabel="Retries" value={String(cfg.operations.retries)} onChange={(v) => set({ operations: { retries: Number(v) } })}
              options={[0, 1, 3, 5].map((n) => ({ value: String(n), label: String(n) }))} /></div>
          </Field>
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div><div className="text-[length:var(--text-ui-sm)] font-medium">Reconcile every load</div><div className="text-[length:var(--text-ui-xs)] text-subtle">Source vs destination row counts</div></div>
            <Toggle label="Reconcile every load" checked={cfg.operations.reconciliation} onChange={(v) => set({ operations: { reconciliation: v } })} />
          </div>
        </div>
      </Disclosure>
    </div>
  );
}

// --- step 5: ownership --------------------------------------------------------------------------------------------
function OwnershipStep({ cfg, set, defaultOwner }: { cfg: IngestionConfig; set: (p: Patch) => void; defaultOwner: string }) {
  const needJust = ["confidential", "restricted"].includes(cfg.ownership.classification);
  const [readersText, setReadersText] = useState(() => (cfg.ownership.readers ?? []).join(", "));
  const [prefilled, setPrefilled] = useState<string[]>([]);
  const badReaders = parseReaders(readersText).filter((x) => !validReader(x));

  function pick(a: CmdbApp) {
    const o = cfg.ownership;
    const patch: Partial<IngestionConfig["ownership"]> = { business_app: { sys_id: a.sys_id, name: a.name } };
    const filled: string[] = [];
    // only fill what is still empty (the owner also when it is just the signed-in default)
    if (a.owner && EMAIL_RE.test(a.owner) && (!o.owner || o.owner === defaultOwner) && a.owner.toLowerCase() !== o.owner) { patch.owner = a.owner.toLowerCase(); filled.push("owner"); }
    if (a.domain && !o.domain.trim()) { patch.domain = a.domain; filled.push("domain"); }
    if (a.cost_center && !o.cost_center.trim()) { patch.cost_center = a.cost_center; filled.push("cost center"); }
    if (a.gxp && !o.gxp) { patch.gxp = true; filled.push("GxP"); }
    setPrefilled(filled);
    set({ ownership: patch });
  }

  return (
    <div className="space-y-6">
      <StepIntro icon={<FileText size={16} />} title="Who owns it?" body="The data owner approves the request; the classification decides who else must." />
      <CmdbPicker value={cfg.ownership.business_app ?? null} onPick={pick}
        onClear={() => { setPrefilled([]); set({ ownership: { business_app: null } }); }} prefilled={prefilled} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Request title"><Input aria-label="Request title" value={cfg.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Finance journals for close reporting" /></Field>
        <Field label="Data owner" hint="Approves this request."><Input aria-label="Data owner" type="email" value={cfg.ownership.owner} onChange={(e) => set({ ownership: { owner: e.target.value.trim().toLowerCase() } })} /></Field>
        <Field label="Business domain"><Input aria-label="Business domain" list="dis-domains" value={cfg.ownership.domain} onChange={(e) => set({ ownership: { domain: e.target.value } })} placeholder="finance" /></Field>
        <Field label="Cost center" hint="Tagged on every pipeline for cost allocation."><Input aria-label="Cost center" value={cfg.ownership.cost_center} onChange={(e) => set({ ownership: { cost_center: e.target.value } })} placeholder="CC-1001" /></Field>
      </div>
      <datalist id="dis-domains">{["finance", "supply chain", "manufacturing", "quality", "procurement", "sales", "hr", "regulatory"].map((d) => <option key={d} value={d} />)}</datalist>
      <Field group label="Classification" hint={CLASS_INFO[cfg.ownership.classification]}>
        <div><Segmented ariaLabel="Classification" value={cfg.ownership.classification} onChange={(v) => set({ ownership: { classification: v } })}
          options={(["public", "internal", "confidential", "restricted"] as const).map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))} /></div>
      </Field>
      <div className={cx("flex items-start justify-between gap-4 rounded-lg border p-3.5 transition", cfg.ownership.gxp && "border-warning/50 bg-warning/5")}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[length:var(--text-ui-sm)] font-medium"><ShieldCheck size={14} className="text-primary" />GxP-relevant data</div>
          <div className="mt-0.5 text-[length:var(--text-ui-xs)] text-subtle">{GXP_HELP}</div>
        </div>
        <Toggle label="GxP-relevant data" checked={!!cfg.ownership.gxp} onChange={(v) => set({ ownership: { gxp: v } })} />
      </div>
      <Field label="Additional readers"
        hint="Readers get read-only access (USE CATALOG, USE SCHEMA, SELECT) to the landed tables; nobody but the pipeline's service principal can write or read the source."
        error={badReaders.length ? `Use an email or group:<name> for: ${badReaders.join(", ")}` : null}>
        <Input aria-label="Additional readers" value={readersText} placeholder="jane@example.com, group:finance-analysts"
          onChange={(e) => { setReadersText(e.target.value); set({ ownership: { readers: parseReaders(e.target.value) } }); }} />
      </Field>
      <Field label={`Business justification${needJust ? " (required)" : ""}`} error={needJust && cfg.ownership.justification.trim().length < 15 && cfg.ownership.justification ? "At least 15 characters." : null}>
        <Textarea aria-label="Business justification" value={cfg.ownership.justification} onChange={(e) => set({ ownership: { justification: e.target.value } })} placeholder="Why the data is needed and who will use it" />
      </Field>
    </div>
  );
}

function CmdbSource({ source, reason }: { source: CmdbResponse["source"]; reason?: string | null }) {
  if (source === "synthetic") return <SourcePill source="synthetic" reason={reason} />;
  if (source === "simulator") {
    return <span title="No ServiceNow instance configured: the built-in Table API simulator is used"><Badge tone="neutral">Simulator</Badge></span>;
  }
  return <Badge tone="success">Live · ServiceNow</Badge>;
}

/** Search-as-you-type over the ServiceNow CMDB business applications (debounced 300 ms). */
function CmdbPicker({ value, onPick, onClear, prefilled }: {
  value: { sys_id: string; name: string } | null; onPick: (a: CmdbApp) => void; onClear: () => void; prefilled: string[];
}) {
  const inputId = useId();
  const listId = useId();
  const [q, setQ] = useState(value?.name ?? "");
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<CmdbResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const term = q.trim();
  const isPicked = !!value && term === value.name;

  useEffect(() => {
    if (term.length < 2 || isPicked) { setSearching(false); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await get<CmdbResponse>(`/api/itsm/cmdb?q=${encodeURIComponent(term)}`, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setRes(r); setError(null); setActive(-1);
      } catch (e) {
        if (!ctrl.signal.aborted) setError(e instanceof ApiError ? e.detail : String(e));
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [term, isPicked]);

  const items = res?.items ?? [];
  const showList = open && !isPicked && term.length >= 2 && (items.length > 0 || searching);
  const choose = (a: CmdbApp) => { onPick(a); setQ(a.name); setOpen(false); setActive(-1); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && items.length) { e.preventDefault(); setOpen(true); setActive((i) => (i + 1) % items.length); }
    else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); }
    else if (e.key === "Enter" && showList && active >= 0 && items[active]) { e.preventDefault(); choose(items[active]); }
    else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
  };

  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-[length:var(--text-ui-sm)] font-medium text-muted-foreground">Business application (ServiceNow CMDB)</label>
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
        <Input id={inputId} role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} autoComplete="off" placeholder="Search business applications"
          value={q} className={cx("w-full pl-9", value && "pr-10")}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey} />
        {value && (
          <button type="button" aria-label="Clear business application" onClick={() => { onClear(); setQ(""); setRes(null); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X size={14} />
          </button>
        )}
        {showList && (
          <ul id={listId} role="listbox" aria-label="Business applications"
            className="scroll-y absolute z-20 mt-1 max-h-72 w-full rounded-md border bg-elevated py-1 shadow-xl">
            {searching && items.length === 0 && <li className="px-3 py-2 text-[length:var(--text-ui-sm)] text-muted-foreground">Searching…</li>}
            {items.map((a, i) => (
              <li key={a.sys_id} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()} onClick={() => choose(a)}
                className={cx("flex cursor-pointer items-start justify-between gap-3 px-3 py-2 hover:bg-muted", i === active && "bg-muted")}>
                <span className="min-w-0">
                  <span className="block truncate text-[length:var(--text-ui-sm)] text-foreground">{a.name}</span>
                  <span className="block truncate text-[length:var(--text-ui-xs)] text-muted-foreground">
                    {[a.owner, a.domain, a.cost_center].filter(Boolean).join(" · ") || "No owner recorded"}
                  </span>
                </span>
                {a.gxp && <Badge tone="warning">GxP</Badge>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-1 flex min-h-[1.5em] flex-wrap items-center gap-2 text-[length:var(--text-ui-xs)] text-subtle">
        {error ? <span className="text-destructive">CMDB search failed: {error}. You can still fill the fields below.</span>
          : value ? <span>Linked to <span className="text-foreground">{value.name}</span>{prefilled.length ? `; prefilled ${prefilled.join(", ")}` : ""}.</span>
          : term.length >= 2 && res && !searching && items.length === 0 ? <span>No business application matches “{term}”.</span>
          : <span>Optional. Picking one prefills the owner, domain and cost center, and marks GxP applications.</span>}
        {res && <CmdbSource source={res.source} reason={res.degraded_reason} />}
      </div>
    </div>
  );
}

// --- step 6: review -----------------------------------------------------------------------------------------------
function ReviewStep({ cfg, connector, checks, checking, onEdit }: { cfg: IngestionConfig; connector?: Connector; checks: CheckResult[]; checking: boolean; onEdit: (i: number) => void }) {
  const rows: [string, string, number][] = [
    ["Source", `${connector?.name ?? cfg.source.connector} · ${cfg.source.connection ?? "—"} · ${PATTERN_LABEL[cfg.source.pattern]}`, 0],
    ["Objects", `${cfg.objects.length} table${cfg.objects.length === 1 ? "" : "s"}: ${cfg.objects.slice(0, 3).map((o) => o.table).join(", ")}${cfg.objects.length > 3 ? "…" : ""}`, 1],
    ["Schema", `${cfg.schema.scd_type === "SCD_TYPE_2" ? "Full history (SCD 2)" : "Current state (SCD 1)"} · keys ${cfg.objects.every((o) => o.primary_keys.length) ? "on every table" : "missing on some"}`, 2],
    ["Destination", `${cfg.destination.environment.toUpperCase()} · ${cfg.destination.catalog}.${cfg.destination.schema}`, 2],
    ["Schedule", cfg.schedule.mode === "continuous" ? `Continuous · SLA ${cfg.schedule.sla_minutes} min` : `Every ${cfg.schedule.interval_minutes} min · SLA ${cfg.schedule.sla_minutes} min`, 3],
    ["Ownership", `${cfg.ownership.owner} · ${cfg.ownership.classification}${cfg.ownership.domain ? ` · ${cfg.ownership.domain}` : ""}${cfg.ownership.business_app ? ` · ${cfg.ownership.business_app.name}` : ""}`, 4],
    ["GxP", cfg.ownership.gxp ? "GxP-relevant: e-signed approval, qualification with an evidence pack, Dev → UAT → Prod" : "Not GxP-relevant", 4],
    ...((cfg.ownership.readers ?? []).length ? [["Readers", `${(cfg.ownership.readers ?? []).join(", ")} (read-only)`, 4] as [string, string, number]] : []),
    ["Operations", `${cfg.operations.retries} automatic retries, then a ticket · reconciliation ${cfg.operations.reconciliation ? "on" : "off"}`, 3],
  ];
  return (
    <div className="space-y-6">
      <StepIntro icon={<CheckCircle2 size={16} />} title="Review the approved configuration" body="This is exactly what the shared runtime will execute. Submitting sends it to the data owner." />
      <dl className="divide-y rounded-lg border">
        {rows.map(([k, v, i]) => (
          <div key={k} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 px-4 py-3">
            <dt className="text-[length:var(--text-ui-sm)] text-subtle">{k}</dt>
            <dd className="min-w-0 truncate text-[length:var(--text-ui-sm)]">{v}</dd>
            <button type="button" className="text-[length:var(--text-ui-xs)] text-primary hover:underline" onClick={() => onEdit(i)}>Edit</button>
          </div>
        ))}
      </dl>
      <div>
        <div className="mb-2 flex items-center gap-2 text-[length:var(--text-ui-sm)] font-medium">Validation {checking && <span className="text-[length:var(--text-ui-xs)] font-normal text-subtle">checking access and running a Lakeflow dry run…</span>}</div>
        <div className="rounded-lg border px-4 py-2">{checks.length ? checks.map((c) => <CheckRow key={c.key} c={c} />) : <div className="py-2 text-[length:var(--text-ui-sm)] text-subtle">No checks yet.</div>}</div>
      </div>
    </div>
  );
}

// --- the forecast rail --------------------------------------------------------------------------------------------
function ForecastRail({ forecast, error, hasSource, onApply }: { forecast: Forecast | null; error: string | null; hasSource: boolean; onApply: (p: Record<string, unknown>) => void }) {
  const f = forecast;
  const conf = f?.confidence;
  return (
    <Card className="overflow-hidden" data-testid="forecast-rail">
      <div className="hero-aurora border-b px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.14em] text-primary"><Sparkles size={13} /> AI forecast</div>
          {conf && <Badge tone={conf === "high" ? "success" : conf === "medium" ? "info" : "warning"}>{conf} confidence</Badge>}
        </div>
        {f ? (
          <div className="mt-1 text-[length:var(--text-ui-xs)] text-muted-foreground">
            Based on <span className="num text-foreground">{f.basis.n_pipelines}</span> {f.basis.match === "family" ? (FAMILY_NAME[f.basis.family] ?? f.basis.family) : f.basis.match === "pattern" ? "same-pattern" : "Lakeflow Connect"} pipeline{f.basis.n_pipelines === 1 ? "" : "s"}{f.basis.match === "family" && f.basis.n_pipelines < 8 ? ", blended with same-pattern history" : ""} · {f.basis.window_days} days
          </div>
        ) : <div className="mt-1 text-[length:var(--text-ui-xs)] text-muted-foreground">Pick a source to see cost, time to data and SLA.</div>}
      </div>
      {error && <div className="px-5 pt-4"><ErrorState error={error} /></div>}
      {!f && hasSource && !error && <div className="space-y-3 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>}
      {!f && !hasSource && (
        <div className="grid grid-cols-2 gap-4 p-5 opacity-50">
          {["Monthly cost", "First data", "Freshness", "SLA met"].map((l) => <div key={l}><div className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.12em] text-subtle">{l}</div><div className="num mt-1 text-[length:var(--text-ui-xl)]">—</div></div>)}
        </div>
      )}
      {f && (
        <div className="p-5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-5">
            <Metric label="Monthly cost" testId="fc-cost" main={<AnimatedNumber value={f.cost.month.p50} format={(v) => fmt.usd(v)} />} sub={<>P90 {fmt.usd(f.cost.month.p90)}</>} />
            <Metric label="First data" testId="fc-first" main={<AnimatedNumber value={f.first_data_min.p50} format={(v) => fmt.min(v)} />} sub={<>P90 {fmt.min(f.first_data_min.p90)} after approval</>} />
            <Metric label="Freshness" testId="fc-fresh" main={<AnimatedNumber value={f.freshness_min.p90} format={(v) => fmt.min(v)} />} sub={<>P90 · median {fmt.min(f.freshness_min.p50)}</>} />
            <Metric label="SLA met" testId="fc-sla" accent={f.sla.attainment_pct >= 97 ? "success" : f.sla.attainment_pct >= 90 ? "warning" : "danger"}
              main={<AnimatedNumber value={f.sla.attainment_pct} format={(v) => `${v.toFixed(1)}%`} />} sub={<>of changes within {fmt.min(f.sla.target_min)}</>} />
          </div>
          <div className="mt-5 space-y-2">
            {f.cost.breakdown.map((b) => (
              <div key={b.label}>
                <div className="flex justify-between gap-2 text-[length:var(--text-ui-xs)]"><span className="truncate text-muted-foreground">{b.label}</span><span className="num">{fmt.usd(b.usd_month)}</span></div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted"><motion.div className="h-full rounded-full bg-primary" initial={{ width: 0 }} animate={{ width: `${Math.max(2, b.pct)}%` }} transition={{ duration: 0.6, ease: "easeOut" }} /></div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-1.5 text-[length:var(--text-ui-xs)] text-subtle">
            <Gauge size={12} /> {f.reliability.success_rate}% of updates succeed · {f.reliability.auto_heal_rate}% of failures heal on retry · ~{f.reliability.expected_tickets_month} incidents/month
          </div>
          {f.recommendations.length > 0 && (
            <div className="mt-5 space-y-2 border-t pt-4">
              <div className="text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.12em] text-subtle">What-if</div>
              {f.recommendations.map((r) => (
                <div key={r.id} className="rounded-md border bg-background/50 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-[length:var(--text-ui-sm)] font-medium">{r.title}</div>
                    <Button size="sm" variant="ghost" onClick={() => onApply(r.patch)} aria-label={`Apply: ${r.title}`}>Apply</Button>
                  </div>
                  <div className="mt-0.5 text-[length:var(--text-ui-xs)] text-muted-foreground">{r.detail}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.delta.cost_month !== undefined && <Delta v={r.delta.cost_month} fmtv={(v) => `${v < 0 ? "−" : "+"}${fmt.usd(Math.abs(v))}/mo`} goodWhenNegative />}
                    {r.delta.freshness_p90_min !== undefined && <Delta v={r.delta.freshness_p90_min} fmtv={(v) => `${v < 0 ? "−" : "+"}${fmt.min(Math.abs(v))} P90 latency`} goodWhenNegative />}
                    {r.delta.sla_pct !== undefined && <Delta v={r.delta.sla_pct} fmtv={(v) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)} pts SLA`} />}
                  </div>
                </div>
              ))}
            </div>
          )}
          {f.cost && "free_tier_note" in f.cost && <div className="mt-4 text-[length:var(--text-ui-xs)] text-subtle">{(f.cost as { free_tier_note?: string }).free_tier_note}</div>}
        </div>
      )}
    </Card>
  );
}

function Metric({ label, main, sub, accent, testId }: { label: string; main: ReactNode; sub: ReactNode; accent?: "success" | "warning" | "danger"; testId?: string }) {
  return (
    <div data-testid={testId}>
      <div className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.12em] text-subtle">{label}</div>
      <div className={cx("mt-1 text-[length:var(--text-ui-xl)] font-medium", accent === "success" && "text-success", accent === "warning" && "text-warning", accent === "danger" && "text-destructive")}>{main}</div>
      <div className="text-[length:var(--text-ui-xs)] text-muted-foreground">{sub}</div>
    </div>
  );
}

function Delta({ v, fmtv, goodWhenNegative }: { v: number; fmtv: (v: number) => string; goodWhenNegative?: boolean }) {
  if (Math.abs(v) < 0.05) return null;
  const good = goodWhenNegative ? v < 0 : v > 0;
  return <Badge tone={good ? "success" : "warning"}>{fmtv(v)}</Badge>;
}

function SummaryCard({ cfg, checks, connector }: { cfg: IngestionConfig; checks: CheckResult[]; connector?: Connector }) {
  const schema = checks.find((c) => c.key.startsWith("schema."));
  const policyFail = checks.filter((c) => c.key.startsWith("policy.") && c.status === "fail");
  const policyWarn = checks.filter((c) => c.key.startsWith("policy.") && c.status === "warn");
  const independent = ["confidential", "restricted"].includes(cfg.ownership.classification);
  const items: CheckResult[] = [
    schema ?? { key: "schema", label: "Schema check", status: "warn", detail: "Pick tables to check keys." },
    policyFail.length ? { ...policyFail[0], label: "Policy check" } : policyWarn.length ? { ...policyWarn[0], label: "Policy check" }
      : { key: "policy", label: "Policy check", status: checks.length ? "pass" : "warn", detail: checks.length ? "Within every guardrail." : "Waiting for a source." },
    { key: "approval", label: "Approval", status: "warn", detail: independent ? "Required: an independent data owner" : `Required: ${cfg.ownership.owner || "the data owner"}` },
  ];
  return (
    <Card className="p-5">
      <div className="mb-2 text-[length:var(--text-ui-md)] font-medium">Request summary</div>
      <div className="mb-2 text-[length:var(--text-ui-xs)] text-subtle">{connector?.name ?? "No source yet"} · {cfg.objects.length} object{cfg.objects.length === 1 ? "" : "s"} · {cfg.destination.environment.toUpperCase()}</div>
      {items.map((c) => <CheckRow key={c.key} c={c} />)}
      <div className="mt-3 flex items-center gap-1.5 border-t pt-3 text-[length:var(--text-ui-xs)] text-subtle"><Lock size={12} /> Credentials managed in vault</div>
    </Card>
  );
}


// --- objects for file / API / stream sources: what to read, not a table browse -----------------------------------
type Kind = "files" | "api" | "stream";
const FORMATS = ["csv", "json", "parquet", "avro", "xml", "text"];

function SpecObjects({ cfg, set, connector }: { cfg: IngestionConfig; set: (p: Patch | Record<string, unknown>) => void; connector?: Connector }) {
  const kind: Kind = cfg.source.pattern === "api" ? "api" : cfg.source.pattern === "stream" ? "stream" : "files";
  const sftp = connector?.id === "sftp";
  const volume = connector?.id === "volume";
  const blank = (): Record<string, unknown> => kind === "api" ? { path: "/", method: "GET", params: {} }
    : kind === "stream" ? { topic: "", value_format: "JSON", starting_offset: "earliest" }
    : { path: volume ? "/Volumes/" : "/", format: "csv", header: true };
  const objects = cfg.objects;
  const [rawParams, setRawParams] = useState<Record<number, string>>({}); // what the user typed (parsing on display would eat a trailing "&")
  const update = (i: number, patch: Record<string, unknown>, opts?: Record<string, unknown>) =>
    set({ objects: objects.map((o, j) => (j === i ? { ...o, ...patch, options: { ...(o.options ?? {}), ...(opts ?? {}) } } : o)) });
  const add = () => set({ objects: [...objects, { schema: kind === "api" ? "api" : kind === "stream" ? "kafka" : "files",
    table: `${kind === "api" ? "endpoint" : kind === "stream" ? "topic" : "dataset"}_${objects.length + 1}`, primary_keys: [], cursor_column: null, options: blank() }] });
  useEffect(() => { if (!objects.length) add(); /* one row to start with */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const title = kind === "api" ? "Which endpoints?" : kind === "stream" ? "Which topics?" : "Which files?";
  const body = kind === "api" ? "Each endpoint lands in its own bronze table: path and query parameters are called through the HTTP connection on every run."
    : kind === "stream" ? "Each topic streams into its own bronze table, continuously."
    : sftp ? "Each file set is a path (glob) on the SFTP server, read exactly once by Auto Loader through the SFTP connection."
    : "Each file set is a folder (or glob) in a Unity Catalog volume, read exactly once by Auto Loader.";
  const params = (o: ObjectLike) => Object.entries(((o.options ?? {}).params as Record<string, string>) ?? {}).map(([k, v]) => `${k}=${v}`).join("&");
  return (
    <div className="space-y-5" data-testid="spec-objects">
      <StepIntro icon={<Boxes size={16} />} title={title} body={body} />
      {objects.map((o, i) => {
        const op = (o.options ?? {}) as Record<string, unknown>;
        return (
          <div key={i} className="grid gap-3 rounded-lg border bg-background/40 p-4 md:grid-cols-6">
            <div className="md:col-span-2">
              <Field label="Destination table"><Input aria-label={`Destination table ${i + 1}`} value={o.table} onChange={(e) => update(i, { table: e.target.value.replace(/[^a-zA-Z0-9_]/g, "_") })} /></Field>
            </div>
            {kind === "api" && (<>
              <div className="md:col-span-2"><Field label="Path" hint="Relative to the connection's base URL"><Input aria-label={`Path ${i + 1}`} value={String(op.path ?? "")} onChange={(e) => update(i, {}, { path: e.target.value })} placeholder="/v1/items" /></Field></div>
              <div><Field label="Method"><Select aria-label={`Method ${i + 1}`} value={String(op.method ?? "GET")} onChange={(e) => update(i, {}, { method: e.target.value })} options={["GET", "POST"].map((m) => ({ value: m, label: m }))} /></Field></div>
              <div className="md:col-span-6"><Field label="Query parameters" hint="key=value&key2=value2">
                <Input aria-label={`Query parameters ${i + 1}`} value={rawParams[i] ?? params(o)} placeholder="limit=500"
                  onChange={(e) => {
                    const text = e.target.value;
                    setRawParams((r) => ({ ...r, [i]: text }));
                    update(i, {}, { params: Object.fromEntries(text.split("&").map((kv) => kv.split("=")).filter((kv) => kv[0]).map(([k, ...v]) => [k.trim(), v.join("=").trim()])) });
                  }} />
              </Field></div>
            </>)}
            {kind === "files" && (<>
              <div className="md:col-span-3"><Field label={sftp ? "Path on the server" : "Volume path"} hint={sftp ? "e.g. /outbound/invoices/*.csv" : "e.g. /Volumes/catalog/schema/volume/folder/"}>
                <Input aria-label={`File path ${i + 1}`} value={String(op.path ?? "")} onChange={(e) => update(i, {}, { path: e.target.value })} /></Field></div>
              <div><Field label="Format"><Select aria-label={`Format ${i + 1}`} value={String(op.format ?? "csv")} onChange={(e) => update(i, {}, { format: e.target.value })} options={FORMATS.map((f) => ({ value: f, label: f.toUpperCase() }))} /></Field></div>
              {String(op.format ?? "csv") === "csv" && (
                <div className="flex items-center gap-2 md:col-span-6"><Toggle label={`Header row ${i + 1}`} checked={op.header !== false} onChange={(v) => update(i, {}, { header: v })} /><span className="text-[length:var(--text-ui-sm)] text-muted-foreground">First row is a header</span></div>
              )}
            </>)}
            {kind === "stream" && (<>
              <div className="md:col-span-2"><Field label="Topic"><Input aria-label={`Topic ${i + 1}`} value={String(op.topic ?? "")} onChange={(e) => update(i, {}, { topic: e.target.value })} placeholder="orders" /></Field></div>
              <div><Field label="Value format"><Select aria-label={`Value format ${i + 1}`} value={String(op.value_format ?? "JSON")} onChange={(e) => update(i, {}, { value_format: e.target.value })} options={["JSON", "AVRO", "PROTOBUF"].map((f) => ({ value: f, label: f }))} /></Field></div>
              <div><Field label="Start from"><Select aria-label={`Start from ${i + 1}`} value={String(op.starting_offset ?? "earliest")} onChange={(e) => update(i, {}, { starting_offset: e.target.value })} options={[{ value: "earliest", label: "Earliest" }, { value: "latest", label: "Latest" }]} /></Field></div>
            </>)}
            <div className="flex items-end justify-end md:col-span-6">
              <button type="button" onClick={() => set({ objects: objects.filter((_, j) => j !== i) })} className="text-[length:var(--text-ui-xs)] text-subtle hover:text-destructive">Remove</button>
            </div>
          </div>
        );
      })}
      <Button onClick={add}>Add {kind === "api" ? "endpoint" : kind === "stream" ? "topic" : "file set"}</Button>
    </div>
  );
}

type ObjectLike = { options?: Record<string, unknown> };

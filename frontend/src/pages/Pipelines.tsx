import { motion } from "framer-motion";
import { Activity, ExternalLink, FlaskConical, Pause, Play, RefreshCw, Scale, Siren, Ticket } from "lucide-react";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useBrand } from "@/brand/BrandContext";
import {
  Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Skeleton, SourcePill, Stat, Drawer, cx, fadeUp,
  type Tone,
} from "@/components/ui";
import { ApiError, fmt, post, useApi } from "@/lib/api";
import type { PipelineHealth, Sourced } from "@/lib/types";

const REFRESH_MS = 20000;
const RO_TITLE = "Read-only mode";

interface PipelineList extends Sourced { items: PipelineHealth[] }
interface Incident {
  id?: number | string;
  kind: "transient" | "actionable";
  status: "auto_healed" | "open" | "resolved";
  title: string;
  detail: string;
  ticket_ref: string | null;
  opened_at: string;
  resolved_at?: string | null;
}
interface IncidentList extends Partial<Sourced> { items: Incident[] }
type Op = "run" | "pause" | "unpause" | "reconcile";
interface PauseAll { paused: string[]; already_paused: string[]; failed: { request_id: string; error: string }[] }

const HEALTH: Record<PipelineHealth["health"], { label: string; dot: string; text: string; rank: number }> = {
  failing: { label: "Failing", dot: "bg-destructive", text: "text-destructive", rank: 0 },
  degraded: { label: "Degraded", dot: "bg-warning", text: "text-warning", rank: 1 },
  unknown: { label: "Unknown", dot: "bg-subtle", text: "text-muted-foreground", rank: 2 },
  paused: { label: "Paused", dot: "bg-warning", text: "text-warning", rank: 3 },
  stopped: { label: "Stopped", dot: "bg-subtle", text: "text-muted-foreground", rank: 3 },
  healthy: { label: "Healthy", dot: "bg-success", text: "text-success", rank: 4 },
};
const RECON: Record<"match" | "drift" | "pending", { label: string; tone: Tone }> = {
  match: { label: "Match", tone: "success" },
  drift: { label: "Drift", tone: "warning" },
  pending: { label: "Pending", tone: "neutral" },
};
const INC_KIND: Record<Incident["kind"], { label: string; tone: Tone }> = {
  transient: { label: "Transient", tone: "info" },
  actionable: { label: "Actionable", tone: "warning" },
};
const INC_STATUS: Record<Incident["status"], { label: string; tone: Tone }> = {
  auto_healed: { label: "Auto-healed", tone: "success" },
  open: { label: "Open", tone: "danger" },
  resolved: { label: "Resolved", tone: "neutral" },
};
const OP_DONE: Record<Op, string> = {
  run: "Update started. The schedule is unchanged.",
  pause: "Paused: the schedule is off and the pipeline is stopped. Nothing runs until you unpause it.",
  unpause: "Unpaused: the schedule is back on and an update is running now.",
  reconcile: "Reconciliation started: source and destination row counts are being compared.",
};

function useEscape(active: boolean, onEscape: () => void) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") ref.current(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [active]);
}

export default function Pipelines() {
  const { me, brand } = useBrand();
  const { data, error, loading, reload } = useApi<PipelineList>("/api/pipelines");
  const [busy, setBusy] = useState<Record<string, Op | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [notices, setNotices] = useState<Record<string, string | undefined>>({});
  const [stopFor, setStopFor] = useState<PipelineHealth | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const [allBusy, setAllBusy] = useState(false);
  const [allResult, setAllResult] = useState<PauseAll | null>(null);
  const [allError, setAllError] = useState<string | null>(null);
  const [incFor, setIncFor] = useState<PipelineHealth | null>(null);
  const canOperate = !!(me?.is_admin || me?.is_approver);
  const ro = !!me?.kiosk;

  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) reload(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);

  const operate = useCallback(async (p: PipelineHealth, op: Op) => {
    const rid = p.request_id;
    setBusy((b) => ({ ...b, [rid]: op }));
    setErrors((e) => ({ ...e, [rid]: undefined }));
    setNotices((n) => ({ ...n, [rid]: undefined }));
    try {
      await post(`/api/pipelines/${encodeURIComponent(rid)}/${op}`);
      setNotices((n) => ({ ...n, [rid]: OP_DONE[op] }));
      reload();
      return true;
    } catch (e) {
      setErrors((x) => ({ ...x, [rid]: e instanceof ApiError ? e.detail : String(e) }));
      return false;
    } finally {
      setBusy((b) => ({ ...b, [rid]: undefined }));
    }
  }, [reload]);

  const closeStop = () => { if (!stopFor || !busy[stopFor.request_id]) setStopOpen(false); };
  useEscape(stopOpen, closeStop);
  const closeAll = () => { if (!allBusy) { setAllOpen(false); setAllResult(null); setAllError(null); } };
  useEscape(allOpen, closeAll);

  const items = [...(data?.items ?? [])].sort((a, b) => (HEALTH[a.health]?.rank ?? 2) - (HEALTH[b.health]?.rank ?? 2) || a.title.localeCompare(b.title));
  const active = items.filter((p) => !p.paused_at);

  const pauseAll = async () => {
    setAllBusy(true); setAllError(null);
    try {
      setAllResult(await post<PauseAll>("/api/pipelines/pause-all"));
      reload();
    } catch (e) {
      setAllError(e instanceof ApiError ? e.detail : String(e));
    } finally {
      setAllBusy(false);
    }
  };

  return (
    <motion.div {...fadeUp}>
      <PageHeader
        eyebrow="Operate"
        title="Pipelines"
        subtitle={`Live ingestion into ${brand.destination_label}: freshness against SLA, reconciliation, cost and incidents. Refreshes every 20 s.`}
        actions={<>
          {data && <SourcePill source={data.source} reason={data.degraded_reason} />}
          {me?.is_admin && items.length > 0 && (
            <Button variant="ghost" size="sm" icon={<Pause size={13} />} disabled={ro || active.length === 0}
              title={ro ? RO_TITLE : active.length === 0 ? "Every pipeline is already paused" : undefined}
              onClick={() => { setAllResult(null); setAllError(null); setAllOpen(true); }}>Pause all</Button>
          )}
          <Button variant="ghost" size="sm" icon={<RefreshCw size={13} className={cx(loading && data && "animate-spin")} />} onClick={reload}>Refresh</Button>
        </>}
      />

      {!data && loading ? (
        <div className="space-y-5" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <div className="grid gap-5 xl:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-52 w-full" />)}</div>
        </div>
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : (
        <>
          {error && <div className="mb-4"><ErrorState error={error} onRetry={reload} /></div>}
          {items.length === 0 ? (
            <EmptyState icon={<Activity size={28} />} title="No live pipelines yet"
              body="Approved requests appear here once deployed." action={<Link to="/requests" className="text-[length:var(--text-ui-sm)] text-primary hover:underline">See requests</Link>} />
          ) : (
            <>
              <Summary items={items} />
              <div className="mt-5 grid gap-5 xl:grid-cols-2">
                {items.map((p, i) => (
                  <motion.div key={p.request_id} {...fadeUp} transition={{ ...fadeUp.transition, delay: Math.min(i, 8) * 0.04 }}>
                    <PipelineCard p={p} canOperate={canOperate} ro={ro} busy={busy[p.request_id]} error={errors[p.request_id]} notice={notices[p.request_id]}
                      onRun={() => operate(p, "run")} onUnpause={() => operate(p, "unpause")} onReconcile={() => operate(p, "reconcile")}
                      onStop={() => { setErrors((e) => ({ ...e, [p.request_id]: undefined })); setStopFor(p); setStopOpen(true); }}
                      onIncidents={() => setIncFor(p)} />
                  </motion.div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {me?.is_admin && <SimulateActivity ro={ro} destination={brand.destination_label} />}

      <Modal open={stopOpen} onClose={closeStop} title={stopFor ? `Pause ${stopFor.title}?` : ""}
        footer={stopFor && <>
          <Button variant="ghost" autoFocus onClick={closeStop} disabled={!!busy[stopFor.request_id]}>Keep running</Button>
          <Button variant="danger" icon={<Pause size={13} />} loading={busy[stopFor.request_id] === "pause"} disabled={ro} title={ro ? RO_TITLE : undefined}
            onClick={async () => { if (await operate(stopFor, "pause")) setStopOpen(false); }}>Pause pipeline</Button>
        </>}>
        {stopFor && (
          <div className="space-y-3">
            <p>
              Turns the schedule off, stops the pipeline and, unless another request shares it, the ingestion gateway, so nothing runs or
              bills. Changes keep accumulating at the source. <strong>Unpause pipeline</strong> turns the schedule back on and starts an
              update straight away, picking up from where it stopped.
            </p>
            {errors[stopFor.request_id] && <InlineError text={errors[stopFor.request_id] as string} />}
          </div>
        )}
      </Modal>

      <Modal open={allOpen} onClose={closeAll} title={allResult ? "Pipelines paused" : "Pause every pipeline?"}
        footer={allResult ? <Button variant="primary" autoFocus onClick={closeAll}>Done</Button> : <>
          <Button variant="ghost" autoFocus onClick={closeAll} disabled={allBusy}>Cancel</Button>
          <Button variant="danger" icon={<Pause size={13} />} loading={allBusy} disabled={ro} title={ro ? RO_TITLE : undefined} onClick={pauseAll}>
            Pause {active.length} pipeline{active.length === 1 ? "" : "s"}
          </Button>
        </>}>
        {allResult ? (
          <div className="space-y-2" role="status">
            <p className="text-success">{allResult.paused.length} paused{allResult.already_paused.length ? `, ${allResult.already_paused.length} already paused` : ""}.</p>
            {allResult.failed.map((f) => <InlineError key={f.request_id} text={`${f.request_id}: ${f.error}`} />)}
            <p className="text-muted-foreground">Unpause any of them from its card; it starts running again straight away.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p>
              Pauses all {active.length} running pipeline{active.length === 1 ? "" : "s"}: schedules off, pipelines and gateways stopped, so nothing
              runs or bills until each one is unpaused. Each pause is recorded in the audit trail and on its ServiceNow ticket.
            </p>
            {allError && <InlineError text={allError} />}
          </div>
        )}
      </Modal>

      <Drawer open={!!incFor} onClose={() => setIncFor(null)} title={incFor ? `Incidents · ${incFor.title}` : "Incidents"}>
        {incFor && <Incidents key={incFor.request_id} rid={incFor.request_id} onClose={() => setIncFor(null)} />}
      </Drawer>
    </motion.div>
  );
}

function Summary({ items: all }: { items: PipelineHealth[] }) {
  const paused = all.filter((p) => p.paused_at).length;
  const items = all.filter((p) => !p.paused_at);  // health and SLA are about what is meant to be running
  const healthy = items.filter((p) => p.health === "healthy").length;
  const measured = items.filter((p) => p.freshness_min != null && p.sla_minutes != null && p.sla_minutes > 0);
  const met = measured.filter((p) => (p.freshness_min as number) <= (p.sla_minutes as number)).length;
  const incidents = items.reduce((s, p) => s + (p.incidents_open || 0), 0);
  const costed = all.filter((p) => p.cost_mtd_usd != null);
  const cost = costed.reduce((s, p) => s + (p.cost_mtd_usd ?? 0), 0);
  const forecast = items.reduce((s, p) => s + (p.forecast_month_usd ?? 0), 0);
  return (
    <Card className="grid grid-cols-2 gap-5 p-5 md:grid-cols-3 xl:grid-cols-5">
      <Stat label="Live pipelines" value={all.length} sub={paused ? `${paused} paused` : "None paused"} testId="stat-live" />
      <Stat label="Healthy" value={items.length ? fmt.pct((healthy / items.length) * 100, 0) : "—"}
        sub={items.length ? `${healthy} of ${items.length} running` : "Every pipeline is paused"} testId="stat-healthy" />
      <Stat label="SLA met" value={measured.length ? fmt.pct((met / measured.length) * 100, 0) : "—"}
        sub={measured.length ? `${met} of ${measured.length} within freshness SLA` : "No freshness data yet"} testId="stat-sla" />
      <Stat label="Open incidents" value={incidents} accent={incidents > 0} sub={incidents ? "Tickets raised for the rest" : "Transient failures auto-retry"} testId="stat-incidents" />
      <Stat label="Cost MTD" value={costed.length ? fmt.usd(cost) : "—"} sub={forecast ? `of ${fmt.usd(forecast)} forecast this month${paused ? " (running only)" : ""}` : items.length ? "No forecast" : "Nothing running: $0 forecast while paused"} testId="stat-cost" />
    </Card>
  );
}

function FreshnessBar({ p }: { p: PipelineHealth }) {
  if (p.paused_at) {
    return (
      <div className="rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-[length:var(--text-ui-sm)]" data-testid={`paused-${p.request_id}`}>
        <span className="font-medium text-warning">Paused</span>
        <span className="text-muted-foreground">
          {" "}{fmt.ago(p.paused_at)}{p.paused_by ? ` by ${p.paused_by}` : ""} · schedule off, nothing runs or bills.
          {p.last_update_at ? ` Data as of ${fmt.ago(p.last_update_at)}.` : ""}
        </span>
      </div>
    );
  }
  if (p.freshness_min == null || p.sla_minutes == null || p.sla_minutes <= 0) {
    return <div className="text-[length:var(--text-ui-sm)] text-muted-foreground">No freshness measured yet</div>;
  }
  const ratio = p.freshness_min / p.sla_minutes;
  const level = ratio > 1 ? { bar: "bg-destructive", text: "text-destructive", word: "over SLA" }
    : ratio > 0.8 ? { bar: "bg-warning", text: "text-warning", word: "near SLA" }
    : { bar: "bg-success", text: "text-success", word: "within SLA" };
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[length:var(--text-ui-sm)]">
        <span><span className="num text-foreground">{fmt.min(p.freshness_min)}</span><span className="text-muted-foreground"> behind source · SLA {fmt.min(p.sla_minutes)}</span></span>
        <span className={cx("text-[length:var(--text-ui-xs)] font-medium", level.text)}>{Math.round(ratio * 100)}% · {level.word}</span>
      </div>
      <div role="meter" aria-label="Freshness against SLA" aria-valuemin={0} aria-valuemax={p.sla_minutes} aria-valuenow={p.freshness_min}
        aria-valuetext={`${fmt.min(p.freshness_min)} of ${fmt.min(p.sla_minutes)} SLA, ${level.word}`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <motion.div data-testid={`fresh-${p.request_id}`} data-level={level.word} className={cx("h-full rounded-full", level.bar)}
          initial={{ width: 0 }} animate={{ width: `${Math.min(ratio, 1) * 100}%` }} transition={{ duration: 0.6, ease: "easeOut" }} />
      </div>
    </div>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.12em] text-subtle">{label}</div>
      <div className="mt-1 text-[length:var(--text-ui-sm)]">{children}</div>
    </div>
  );
}

function PipelineCard({ p, canOperate, ro, busy, error, notice, onRun, onStop, onUnpause, onReconcile, onIncidents }: {
  p: PipelineHealth; canOperate: boolean; ro: boolean; busy?: Op; error?: string; notice?: string;
  onRun: () => void; onStop: () => void; onUnpause: () => void; onReconcile: () => void; onIncidents: () => void;
}) {
  const h = HEALTH[p.health] ?? HEALTH.unknown;
  const roTitle = ro ? RO_TITLE : undefined;
  const paused = !!p.paused_at;
  return (
    <Card as="article" className="flex h-full flex-col p-5" aria-label={p.title} data-testid={`pipeline-${p.request_id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cx("h-2 w-2 shrink-0 rounded-full", h.dot, p.health === "healthy" && "pulse-dot")} />
            <span className={cx("text-[length:var(--text-ui-xs)] font-medium", h.text)}>{h.label}</span>
            {paused && p.health !== "paused" && <Badge tone="warning">Paused</Badge>}
            <span className="text-[length:var(--text-ui-xs)] text-subtle">· {p.state}</span>
          </div>
          <h2 className="mt-1 truncate text-[length:var(--text-ui-md)] font-medium">{p.title}</h2>
          <Link to={`/requests/${encodeURIComponent(p.request_id)}`} className="num text-[length:var(--text-ui-xs)] text-muted-foreground hover:text-primary">{p.request_id}</Link>
        </div>
        {p.url && (
          <a href={p.url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[length:var(--text-ui-sm)] text-primary hover:bg-muted">
            Open in Databricks <ExternalLink size={13} />
          </a>
        )}
      </div>

      <div className="mt-4"><FreshnessBar p={p} /></div>

      <div className="mb-4 mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Last update">
          <span className="text-foreground">{p.last_update_state ?? "—"}</span>
          <span className="block text-[length:var(--text-ui-xs)] text-muted-foreground" title={p.last_update_at ? new Date(p.last_update_at).toLocaleString() : undefined}>{fmt.ago(p.last_update_at)}</span>
        </Metric>
        <Metric label="Rows">
          <span className="num">{fmt.int(p.rows_last_update)}</span>
          <span className="block text-[length:var(--text-ui-xs)] text-muted-foreground">last update</span>
        </Metric>
        <Metric label="Reconciliation">
          {p.recon ? (<>
            <Badge tone={RECON[p.recon.status]?.tone ?? "neutral"}>{RECON[p.recon.status]?.label ?? p.recon.status}</Badge>
            <span className="num block text-[length:var(--text-ui-xs)] text-muted-foreground" title="Source rows vs destination rows">
              {fmt.int(p.recon.source_rows)} → {fmt.int(p.recon.target_rows)}
            </span>
          </>) : <span className="text-muted-foreground">Not run yet</span>}
        </Metric>
        <Metric label="Cost MTD">
          <span className="num">{fmt.usd(p.cost_mtd_usd)}</span>
          <span className="block text-[length:var(--text-ui-xs)] text-muted-foreground">of {fmt.usd(p.forecast_month_usd)} forecast</span>
        </Metric>
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <button type="button" onClick={onIncidents}
          className={cx("inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[length:var(--text-ui-sm)] hover:bg-muted",
            p.incidents_open > 0 ? "text-destructive" : "text-muted-foreground")}>
          <Siren size={14} />
          {p.incidents_open > 0 ? `${p.incidents_open} open incident${p.incidents_open === 1 ? "" : "s"}` : "No open incidents"}
        </button>
        {canOperate && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="ghost" icon={<Scale size={13} />} loading={busy === "reconcile"} disabled={ro || (!!busy && busy !== "reconcile")} title={roTitle} onClick={onReconcile}>Reconcile</Button>
            {paused ? (
              <Button size="sm" variant="primary" icon={<Play size={13} />} loading={busy === "unpause"} disabled={ro || (!!busy && busy !== "unpause")}
                title={ro ? RO_TITLE : "Turn the schedule back on and start an update now"} onClick={onUnpause}>Unpause pipeline</Button>
            ) : (<>
              <Button size="sm" variant="ghost" icon={<Pause size={13} />} disabled={ro || !!busy} title={roTitle} onClick={onStop}>Pause</Button>
              <Button size="sm" variant="secondary" icon={<Play size={13} />} loading={busy === "run"} disabled={ro || (!!busy && busy !== "run")} title={roTitle} onClick={onRun}>Run now</Button>
            </>)}
          </div>
        )}
      </div>
      {error && <div className="mt-3"><InlineError text={error} /></div>}
      {notice && !error && <div role="status" className="mt-3 text-[length:var(--text-ui-xs)] text-success">{notice}</div>}
    </Card>
  );
}

function InlineError({ text }: { text: string }) {
  return <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[length:var(--text-ui-sm)] text-destructive">{text}</div>;
}

function Incidents({ rid, onClose }: { rid: string; onClose: () => void }) {
  const { data, error, loading, reload } = useApi<IncidentList>(`/api/pipelines/${encodeURIComponent(rid)}/incidents`);
  useEscape(true, onClose);
  if (!data && (loading || !error)) return <div className="space-y-3" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const items = [...(data?.items ?? [])].sort((a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime());
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">Transient failures are retried automatically; the rest open a ticket.</p>
        <SourcePill source={data?.source} reason={data?.degraded_reason} />
      </div>
      {items.length === 0 ? <EmptyState icon={<Siren size={24} />} title="No incidents" body="Nothing has gone wrong with this pipeline." /> : (
        <ul className="space-y-2.5">
          {items.map((x, i) => (
            <li key={x.id ?? `${x.opened_at}-${i}`} className="rounded-md border bg-elevated p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={INC_KIND[x.kind]?.tone ?? "neutral"}>{INC_KIND[x.kind]?.label ?? x.kind}</Badge>
                <Badge tone={INC_STATUS[x.status]?.tone ?? "neutral"} dot>{INC_STATUS[x.status]?.label ?? x.status}</Badge>
                <span className="ml-auto text-[length:var(--text-ui-xs)] text-subtle" title={new Date(x.opened_at).toLocaleString()}>{fmt.ago(x.opened_at)}</span>
              </div>
              <div className="mt-1.5 text-[length:var(--text-ui-sm)] font-medium">{x.title}</div>
              {x.detail && <div className="mt-0.5 break-words text-[length:var(--text-ui-xs)] text-muted-foreground">{x.detail}</div>}
              {x.ticket_ref && (
                <div className="mt-1.5 inline-flex items-center gap-1.5 text-[length:var(--text-ui-xs)] text-muted-foreground">
                  <Ticket size={12} /> <span className="num">{x.ticket_ref}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SimulateActivity({ ro, destination }: { ro: boolean; destination: string }) {
  const [v, setV] = useState({ inserts: "50", updates: "20", deletes: "5" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const nums = { inserts: Number(v.inserts), updates: Number(v.updates), deletes: Number(v.deletes) };
  const valid = Object.values(nums).every((n) => Number.isInteger(n) && n >= 0 && n <= 10000) && Object.values(nums).some((n) => n > 0);

  const submit = async () => {
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await post<Record<string, unknown> | null>("/api/demo/source-activity", nums);
      const msg = r && typeof r === "object" && typeof (r.message ?? r.detail) === "string" ? String(r.message ?? r.detail) : null;
      setDone(msg ?? `Wrote ${nums.inserts} inserts, ${nums.updates} updates and ${nums.deletes} deletes to the demo source. The next pipeline update carries them into ${destination}.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e));
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof typeof v, label: string) => (
    <Field label={label}>
      <Input type="number" min={0} max={10000} step={1} aria-label={label} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
    </Field>
  );

  return (
    <Card as="section" className="mt-6 p-5" aria-label="Simulate source activity">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 className="flex items-center gap-2 text-[length:var(--text-ui-md)] font-medium"><FlaskConical size={15} className="text-primary" />Simulate source activity</h2>
          <p className="mt-1 text-[length:var(--text-ui-sm)] text-muted-foreground">
            Writes real inserts, updates and deletes to the demo source database (finance journals), so you can watch ingestion carry them into {destination} and reconciliation confirm the counts. Query-based sources pick up deletes at the next hard-delete sync (daily by default); log-based CDC carries them on the next update. Administrators only.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-24">{field("inserts", "Inserts")}</div>
          <div className="w-24">{field("updates", "Updates")}</div>
          <div className="w-24">{field("deletes", "Deletes")}</div>
          <Button variant="outline" loading={busy} disabled={ro || !valid} title={ro ? RO_TITLE : !valid ? "Use whole numbers from 0 to 10,000, at least one above 0" : undefined} onClick={submit}>
            Write changes
          </Button>
        </div>
      </div>
      {error && <div className="mt-3"><InlineError text={error} /></div>}
      {done && <div role="status" className="mt-3 text-[length:var(--text-ui-sm)] text-success">{done}</div>}
    </Card>
  );
}

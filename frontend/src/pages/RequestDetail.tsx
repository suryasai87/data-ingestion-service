import { motion } from "framer-motion";
import {
  ArrowLeft, ArrowUpRight, Bot, CalendarClock, Check, ClipboardCheck, CircleCheck, CircleMinus, CircleX, Circle, Copy, Database, Download,
  ExternalLink, Eye, FileCode2, FileText, FlaskConical, GitBranch, KeyRound, LoaderCircle, Lock, Pencil, RefreshCw, Rocket, Send, ShieldCheck,
  Signature, Table2, Target, ThumbsDown, ThumbsUp, Ticket, TriangleAlert, Users, Wrench,
} from "lucide-react";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useBrand } from "@/brand/BrandContext";
import {
  Badge, Button, Card, CheckRow, Code, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Segmented, Skeleton, SourcePill,
  Stat, StatusBadge, Stepper, Textarea, Drawer, cx, fadeUp, type Tone,
} from "@/components/ui";
import { ApiError, fmt, get, post, useApi } from "@/lib/api";
import type {
  AccessModel, CheckResult, Classification, DataPreview, GxpEvidence, IngestRequest, Pattern, RequestDetail as Detail, RequestStatus,
  Sourced, Spec,
} from "@/lib/types";

const STEPS = ["Draft", "Validation", "Approval", "Deployment", "Live"];
const MIN_REASON = 5;
const POLL_MS = 4000;
const RO_TITLE = "Read-only mode";
const PIN_RE = /^\d{6,12}$/;
const ENV_LABEL = { dev: "Dev", uat: "UAT", prod: "Production" } as const;
const CHANNEL: Record<IngestRequest["channel"], { label: string; icon: ReactNode }> = {
  app: { label: "Guided form", icon: <FileText size={11} /> },
  chat: { label: "Assistant", icon: <Bot size={11} /> },
  servicenow: { label: "ServiceNow", icon: <Ticket size={11} /> },
  api: { label: "API", icon: <FileCode2 size={11} /> },
};

type Write = "validate" | "submit" | "approve" | "reject" | "deploy" | "cancel";
type ReasonAction = "approve" | "reject" | "cancel";
type SpecTab = "gateway" | "ingestion" | "job" | "bundle";
interface WriteError { status: number; detail: string }

const LOAD_MODE: Record<Pattern, string> = {
  cdc: "Initial snapshot, then change data capture",
  query: "Incremental by cursor column",
  saas: "Incremental, connector-managed",
  files: "Incremental, new files only",
  stream: "Streaming",
  federation: "Incremental by cursor column, from the foreign catalog",
  api: "API call on every run (snapshot)",
  community: "Community connector",
};
const CLASS_TONE: Record<Classification, Tone> = { public: "neutral", internal: "neutral", confidential: "warning", restricted: "danger" };
const CONF_TONE = { high: "success", medium: "warning", low: "danger" } as const;

function stepIndex(d: Detail): number {
  const s = d.request.status;
  if (s === "live") return STEPS.length;
  if (s === "approved" || s === "deploying" || s === "failed") return 3;
  if (s === "pending_approval" || s === "rejected") return 2;
  if (s === "cancelled") return d.deployment.some((x) => x.status === "done") ? 3 : d.checks.length ? 1 : 0;
  return d.checks.length ? 1 : 0;
}

function nextStep(d: Detail, dest: string): { tone: Tone; text: string } {
  const sensitive = d.config.ownership.classification === "confidential" || d.config.ownership.classification === "restricted";
  const m: Record<RequestStatus, { tone: Tone; text: string }> = {
    draft: { tone: "neutral", text: "Draft. Run the checks, fix anything that fails, then submit it for approval." },
    pending_approval: {
      tone: "warning",
      text: d.can.approve
        ? `Waiting for your decision as data owner for ${d.config.ownership.domain}.`
        : `Waiting for a data owner of ${d.config.ownership.domain} to approve it.${sensitive ? " This data is " + d.config.ownership.classification + ", so the approval must be independent of the requester." : ""}`,
    },
    approved: { tone: "info", text: "Approved. Deploying creates the ingestion gateway, the managed ingestion pipeline and its schedule job." },
    deploying: { tone: "primary", text: "Deploying: gateway, ingestion pipeline, schedule job, first update. This page refreshes every 4 s." },
    live: { tone: "success", text: `Live in ${dest}. Freshness, reconciliation and incidents are tracked on the Pipelines page.` },
    failed: { tone: "danger", text: "Deployment failed. The failing step and its error are listed under Deployment." },
    rejected: { tone: "danger", text: "Rejected. Edit the configuration to create a new version, then submit it again." },
    cancelled: { tone: "neutral", text: "Cancelled. Nothing further happens to this request." },
  };
  return m[d.request.status];
}

const errOf = (e: unknown): WriteError => (e instanceof ApiError ? { status: e.status, detail: e.detail } : { status: 0, detail: String(e) });
/** A signing failure (wrong / missing PIN, locked) rather than a stale version: shown as a signature problem, not "reload". */
const isSignError = (e: WriteError) => (e.status === 403 || e.status === 409) && /\bPIN\b|\bsigning\b/i.test(e.detail);
const utc = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
};

const isDetail = (v: unknown): v is Detail => !!v && typeof v === "object" && "request" in v && "config" in v;
const hasChecks = (v: unknown): v is { checks: CheckResult[] } => !!v && typeof v === "object" && Array.isArray((v as { checks?: unknown }).checks);

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

export default function RequestDetail() {
  const { id = "" } = useParams();
  const { me, brand } = useBrand();
  const nav = useNavigate();
  const base = `/api/requests/${encodeURIComponent(id)}`;
  const { data, error, loading, reload, setData } = useApi<Detail>(base);
  const [busy, setBusy] = useState<Write | null>(null);
  const [writeError, setWriteError] = useState<WriteError | null>(null);
  const [reasonFor, setReasonFor] = useState<ReasonAction>("approve");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [printedName, setPrintedName] = useState("");
  const [pin, setPin] = useState("");
  const [specOpen, setSpecOpen] = useState(false);
  const ro = !!me?.kiosk;

  const status = data?.request.status;
  useEffect(() => {
    if (status !== "deploying") return;
    const t = setInterval(() => { reload(); }, POLL_MS);
    return () => clearInterval(t);
  }, [status, reload]);

  const write = useCallback(async (key: Write, body?: unknown) => {
    setBusy(key);
    setWriteError(null);
    try {
      const r = await post<unknown>(`${base}/${key}`, body);
      if (isDetail(r)) setData(r);
      else {
        if (hasChecks(r)) setData((prev) => (prev ? { ...prev, checks: r.checks } : prev));
        reload();
      }
      return true;
    } catch (e) {
      setWriteError(errOf(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, [base, reload, setData]);

  const openReason = (a: ReasonAction) => {
    setWriteError(null); setReason(""); setPin(""); setPrintedName(me?.name ?? ""); setReasonFor(a); setReasonOpen(true);
  };
  const closeReason = () => { if (!busy) { setReasonOpen(false); setWriteError(null); setPin(""); } };
  useEscape(reasonOpen, closeReason);
  const reloadFresh = () => { setWriteError(null); setReasonOpen(false); reload(); };

  const back = (
    <Link to="/requests" className="mb-3 inline-flex items-center gap-1.5 text-[length:var(--text-ui-sm)] text-muted-foreground hover:text-foreground">
      <ArrowLeft size={14} /> Requests
    </Link>
  );

  if (!data) {
    return (
      <div>
        {back}
        <PageHeader eyebrow="Request" title={id || "Request"} />
        {error && !loading ? <ErrorState error={error} onRetry={reload} /> : (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-24 w-full" />
            <div className="grid gap-5 lg:grid-cols-12">
              <Skeleton className="h-[420px] lg:col-span-7" />
              <Skeleton className="h-[420px] lg:col-span-5" />
            </div>
          </div>
        )}
      </div>
    );
  }

  const { request: r, config: c, can } = data;
  const failing = data.checks.some((x) => x.status === "fail");
  const next = nextStep(data, brand.destination_label);
  const reasonValid = reason.trim().length >= MIN_REASON;
  const roTitle = ro ? RO_TITLE : undefined;
  const promoteTo = can.promote && data.next_env ? data.next_env : null;
  const anyAction = can.edit || can.submit || can.approve || can.deploy || can.cancel || !!promoteTo;
  // 21 CFR Part 11: a GxP decision (approve or reject) is an electronic signature bound to this version's content hash
  const signing = !!can.sign_required && (reasonFor === "approve" || reasonFor === "reject");
  const meaning = reasonFor === "reject" ? "Rejected"
    : c.destination.environment === "prod" ? "Released to Production" : c.destination.environment === "uat" ? "Released to UAT" : "Approved";
  const signValid = !signing || (PIN_RE.test(pin) && printedName.trim().length > 0);
  const lineage = data.lineage;
  const decide = async () => {
    const body = signing ? { reason: reason.trim(), signature: { pin, printed_name: printedName.trim() } } : { reason: reason.trim() };
    const ok = await write(reasonFor, body);
    setPin("");
    if (ok) setReasonOpen(false);
  };

  const reasonMeta: Record<ReasonAction, { title: string; body: string; confirm: string; variant: "primary" | "danger" }> = {
    approve: {
      title: `Approve ${r.id}`,
      body: `Approving lets ${r.requester} deploy version ${r.version} of this configuration into ${c.destination.catalog}.${c.destination.schema}.`,
      confirm: "Approve", variant: "primary",
    },
    reject: { title: `Reject ${r.id}`, body: "The requester sees your reason and can edit the configuration and submit it again.", confirm: "Reject", variant: "danger" },
    cancel: { title: `Cancel ${r.id}`, body: "Cancelling stops this request for good. Deployed resources are not removed by cancelling.", confirm: "Cancel request", variant: "danger" },
  };

  return (
    <motion.div {...fadeUp}>
      {back}
      <PageHeader
        eyebrow="Request"
        title={c.title || r.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="num text-foreground">{r.id}</span>
            <StatusBadge status={r.status} />
            <Badge tone="neutral" className="gap-1">
              {(CHANNEL[r.channel] ?? CHANNEL.app).icon}
              {(CHANNEL[r.channel] ?? CHANNEL.app).label}
            </Badge>
            <Badge tone="primary"><span className="num">v{r.version}</span></Badge>
            {r.ticket_number && <Badge tone="info" className="gap-1" ><Ticket size={11} /><span className="num">{r.ticket_number}</span></Badge>}
            {r.gxp && <Badge tone="warning" className="gap-1"><ShieldCheck size={11} />GxP</Badge>}
            <span className="text-[length:var(--text-ui-sm)] text-subtle">requested by {r.requester} · updated {fmt.ago(r.updated_at)}</span>
          </span>
        }
        actions={<>
          <SourcePill source={data.source} reason={data.degraded_reason} />
          <Button icon={<FileCode2 size={15} />} onClick={() => setSpecOpen(true)}>View spec</Button>
        </>}
      />

      {lineage && (lineage.parent_id || lineage.children.length > 0) && (
        <div className="-mt-3 mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-ui-sm)] text-muted-foreground" data-testid="lineage">
          <GitBranch size={14} className="text-primary" />
          {lineage.parent_id && (
            <span>Promoted from <Link to={`/requests/${encodeURIComponent(lineage.parent_id)}`} className="num text-primary hover:underline">{lineage.parent_id}</Link></span>
          )}
          {lineage.children.length > 0 && (
            <span>Promoted to{" "}
              {lineage.children.map((ch, i) => (
                <span key={ch}>{i > 0 && ", "}<Link to={`/requests/${encodeURIComponent(ch)}`} className="num text-primary hover:underline">{ch}</Link></span>
              ))}
            </span>
          )}
        </div>
      )}

      <Card className="mb-5 p-5">
        <Stepper steps={STEPS} current={stepIndex(data)} />
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <Badge tone={next.tone} dot>{r.status === "live" ? "Live" : "Next"}</Badge>
            <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">
              {next.text}{" "}
              {r.status === "live" && <Link to="/pipelines" className="text-primary hover:underline">Open Pipelines</Link>}
            </p>
          </div>
          {anyAction && (
            <div className="flex flex-wrap items-center gap-2">
              {can.edit && (
                <Button icon={<Pencil size={14} />} disabled={ro || !!busy} title={roTitle} onClick={() => nav(`/new/${encodeURIComponent(r.id)}`)}>Edit</Button>
              )}
              {can.cancel && (
                <Button variant="ghost" disabled={ro || !!busy} title={roTitle} onClick={() => openReason("cancel")}>Cancel request</Button>
              )}
              {can.approve && (<>
                <Button variant="danger" icon={<ThumbsDown size={14} />} disabled={ro || !!busy} title={roTitle} onClick={() => openReason("reject")}>Reject</Button>
                <Button variant="primary" icon={<ThumbsUp size={14} />} disabled={ro || !!busy} title={roTitle} onClick={() => openReason("approve")}>Approve</Button>
              </>)}
              {can.submit && (
                <Button variant="primary" icon={<Send size={14} />} loading={busy === "submit"} disabled={ro || failing || (!!busy && busy !== "submit")}
                  title={ro ? RO_TITLE : failing ? "Fix the failing checks first" : undefined} onClick={() => write("submit")}>
                  Submit for approval
                </Button>
              )}
              {can.deploy && (
                <Button variant="primary" icon={<Rocket size={14} />} loading={busy === "deploy"} disabled={ro || (!!busy && busy !== "deploy")} title={roTitle}
                  onClick={() => write("deploy")}>Deploy</Button>
              )}
              {promoteTo && (
                <PromoteAction key={r.id} base={base} to={promoteTo} gxp={!!r.gxp} ro={ro} disabled={!!busy}
                  onPromoted={(d) => { setData(d); nav(`/requests/${encodeURIComponent(d.request.id)}`); }} />
              )}
            </div>
          )}
        </div>
        {writeError && !reasonOpen && <div className="mt-4"><WriteErrorView err={writeError} onReload={reloadFresh} /></div>}
      </Card>

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-7">
          <ConfigSummary d={data} />
          <ObjectsCard d={data} />
          {data.access && <AccessCard key={r.id} base={base} access={data.access} landed={r.status === "live" || !!r.pipeline_id} />}
          {data.gxp && (data.gxp.enabled || data.gxp.evidence) && (
            <GxpCard key={r.id} base={base} d={data} ro={ro} onDone={reload} />
          )}
        </div>
        <div className="space-y-5 lg:col-span-5">
          <Card className="p-5">
            <SectionTitle icon={<ShieldCheck size={15} />} title="Checks"
              right={<Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={busy === "validate"}
                disabled={ro || (!!busy && busy !== "validate")} title={roTitle} onClick={() => write("validate")}>Re-validate</Button>} />
            {data.checks.length === 0
              ? <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">No checks have run on this version yet. Re-validate to check access, schema, policy and a Lakeflow dry run.</p>
              : <>
                  <CheckSummary checks={data.checks} />
                  <div className="divide-y">{data.checks.map((x) => <CheckRow key={x.key} c={x} />)}</div>
                </>}
          </Card>
          {(data.itsm_mode || (data.itsm?.length ?? 0) > 0) && <ServiceNowCard d={data} />}
          <ForecastCard d={data} />
          {data.deployment.length > 0 && <DeploymentCard d={data} />}
          {data.links.length > 0 && (
            <Card className="p-5">
              <SectionTitle icon={<ExternalLink size={15} />} title="Open in Databricks" />
              <ul className="space-y-1">
                {data.links.map((l) => (
                  <li key={l.url}>
                    <a href={l.url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[length:var(--text-ui-sm)] text-primary hover:bg-muted">
                      <span className="truncate">{l.label}</span><ExternalLink size={13} className="shrink-0" />
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-12">
        <TimelineCard d={data} />
        <VersionsCard d={data} />
      </div>

      <Modal open={reasonOpen} onClose={closeReason} title={reasonMeta[reasonFor].title}
        footer={<>
          <Button variant="ghost" onClick={closeReason} disabled={!!busy}>Back</Button>
          <Button variant={reasonMeta[reasonFor].variant} loading={busy === reasonFor} disabled={!reasonValid || !signValid || ro} title={roTitle}
            onClick={decide}>
            {signing ? `Sign and ${reasonMeta[reasonFor].confirm.toLowerCase()}` : reasonMeta[reasonFor].confirm}
          </Button>
        </>}>
        <div className="space-y-3">
            <p>{reasonMeta[reasonFor].body}</p>
            <Field label="Reason" hint={`Required, at least ${MIN_REASON} characters. Recorded in the audit trail.`}>
              <Textarea autoFocus aria-label="Reason" aria-required="true" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder={reasonFor === "approve" ? "e.g. Owner sign-off for the finance domain" : "What should change?"} />
            </Field>
            {signing && (
              <section aria-label="Electronic signature" className="space-y-3 rounded-md border bg-background/40 p-3">
                <h3 className="flex items-center gap-2 text-[length:var(--text-ui-sm)] font-medium text-foreground">
                  <Signature size={14} className="text-primary" />Electronic signature (21 CFR Part 11)
                </h3>
                <Field label="Printed name">
                  <Input aria-label="Printed name" autoComplete="name" value={printedName} onChange={(e) => setPrintedName(e.target.value)} />
                </Field>
                <Field label="Signing PIN" hint="6 to 12 digits. Set or change it from your initials menu, top right."
                  error={pin && !PIN_RE.test(pin) ? "The signing PIN is 6 to 12 digits." : null}>
                  <Input aria-label="Signing PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={12} value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
                </Field>
                <p className="text-[length:var(--text-ui-xs)]" data-testid="esign-statement">
                  Signing records your name, the date and time (UTC) and the meaning “{meaning}”, bound to this version's configuration hash.
                </p>
              </section>
            )}
            {writeError && (signing && isSignError(writeError)
              ? <SignErrorView err={writeError} />
              : <WriteErrorView err={writeError} onReload={reloadFresh} />)}
        </div>
      </Modal>

      <SpecDrawer open={specOpen} onClose={() => setSpecOpen(false)} path={`${base}/spec`} requestId={r.id} />
    </motion.div>
  );
}

function WriteErrorView({ err, onReload }: { err: WriteError; onReload: () => void }) {
  const stale = err.status === 409;
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/8 p-3 text-[length:var(--text-ui-sm)]">
      <TriangleAlert size={15} className="mt-0.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{stale ? "This request changed; reload to see the latest version." : "That didn't go through"}</div>
        {err.detail && <div className="mt-0.5 break-words text-muted-foreground">{err.detail}</div>}
      </div>
      {stale && <Button size="sm" icon={<RefreshCw size={13} />} onClick={onReload}>Reload</Button>}
    </div>
  );
}

function SignErrorView({ err }: { err: WriteError }) {
  const noPin = err.status === 409;
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/8 p-3 text-[length:var(--text-ui-sm)]">
      <KeyRound size={15} className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{noPin ? "Set your signing PIN first" : "Signature not accepted"}</div>
        <div className="mt-0.5 break-words text-muted-foreground">{err.detail}</div>
        {noPin && <div className="mt-1 text-[length:var(--text-ui-xs)] text-subtle">Open your initials menu (top right) and choose Signing PIN…</div>}
      </div>
    </div>
  );
}

/** Change control: copy the approved configuration to the next environment as a new, separately approved request. */
function PromoteAction({ base, to, gxp, ro, disabled, onPromoted }: {
  base: string; to: "uat" | "prod"; gxp: boolean; ro: boolean; disabled: boolean; onPromoted: (d: Detail) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<WriteError | null>(null);
  const label = `Promote to ${ENV_LABEL[to]}`;
  const close = () => { if (!busy) { setOpen(false); setErr(null); } };
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await post<Detail>(`${base}/promote`, { to });
      setOpen(false);
      onPromoted(d);
    } catch (e) {
      setErr(errOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="primary" icon={<ArrowUpRight size={14} />} disabled={ro || disabled} title={ro ? RO_TITLE : undefined}
        onClick={() => { setErr(null); setOpen(true); }}>{label}</Button>
      <Modal open={open} onClose={close} title={label}
        footer={<>
          <Button variant="ghost" onClick={close} disabled={busy}>Back</Button>
          <Button variant="primary" loading={busy} disabled={ro} title={ro ? RO_TITLE : undefined} onClick={go}>{label}</Button>
        </>}>
        <div className="space-y-3">
          <p>
            Copies the approved configuration to {ENV_LABEL[to]} as a new request that needs its own approval; GxP requests need a passing
            qualification first.
          </p>
          {gxp && <p className="text-[length:var(--text-ui-xs)] text-subtle">This request is GxP-relevant: the latest qualification run on this version must be PASS.</p>}
          {err && (
            <div role="alert" className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/8 p-3">
              <TriangleAlert size={15} className="mt-0.5 shrink-0 text-destructive" />
              <div className="min-w-0">
                <div className="font-medium text-foreground">{err.status === 409 ? "Can't promote yet" : "That didn't go through"}</div>
                <div className="mt-0.5 break-words text-muted-foreground">{err.detail}</div>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

function ServiceNowCard({ d }: { d: Detail }) {
  const links = d.itsm ?? [];
  return (
    <Card className="p-5" data-testid="servicenow-card">
      <SectionTitle icon={<Ticket size={15} />} title="ServiceNow" right={d.itsm_mode === "simulator"
        ? <span title="No ServiceNow instance configured: the built-in Table API simulator is used"><Badge tone="neutral">Simulator</Badge></span>
        : d.itsm_mode === "rest" ? <Badge tone="success">Connected</Badge> : undefined} />
      {links.length === 0 ? (
        <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">No ServiceNow record is linked yet. A request record is opened when the request is created, and an incident when a pipeline fails.</p>
      ) : (
        <ul className="divide-y">
          {links.map((l) => (
            <li key={`${l.kind}-${l.sys_id}`} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2 text-[length:var(--text-ui-sm)]">
              <Badge tone={l.kind === "incident" ? "warning" : "info"}>{l.kind === "incident" ? "Incident" : "Request"}</Badge>
              {l.url ? (
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="num inline-flex items-center gap-1 text-primary hover:underline">
                  {l.number ?? l.sys_id.slice(0, 8)}<ExternalLink size={12} />
                </a>
              ) : <span className="num text-foreground">{l.number ?? l.sys_id.slice(0, 8)}</span>}
              {l.state && <span className="text-muted-foreground">{l.state}</span>}
              <span className="ml-auto text-[length:var(--text-ui-xs)] text-subtle" title={new Date(l.synced_at).toLocaleString()}>synced {fmt.ago(l.synced_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const VERDICT: Record<GxpEvidence["verdict"], { label: string; tone: Tone }> = {
  PASS: { label: "PASS", tone: "success" },
  PASS_WITH_DEVIATIONS: { label: "PASS WITH DEVIATIONS", tone: "warning" },
  FAIL: { label: "FAIL", tone: "danger" },
};

function GxpCard({ base, d, ro, onDone }: { base: string; d: Detail; ro: boolean; onDone: () => void }) {
  const gxp = d.gxp!;
  const ev = gxp.evidence;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const qualify = async () => {
    setBusy(true); setErr(null);
    try {
      await post(`${base}/qualify`);
      onDone();
    } catch (e) {
      setErr(errOf(e).detail);
    } finally {
      setBusy(false);
    }
  };
  const v = ev ? VERDICT[ev.verdict] ?? { label: ev.verdict, tone: "neutral" as Tone } : null;
  return (
    <Card className="p-5" data-testid="gxp-card">
      <SectionTitle icon={<FlaskConical size={15} />} title="GxP qualification"
        right={<div className="flex items-center gap-2">
          {ev && (
            <a href={`${base}/evidence`} download
              className="inline-flex h-8 items-center gap-2 rounded-md border bg-elevated px-3 text-[length:var(--text-ui-sm)] font-medium text-foreground transition hover:border-border-strong">
              <Download size={13} />Download evidence
            </a>
          )}
          {d.can.qualify && (
            <Button size="sm" variant="primary" icon={<FlaskConical size={13} />} loading={busy} disabled={ro} title={ro ? RO_TITLE : undefined}
              onClick={qualify}>Run qualification</Button>
          )}
        </div>} />
      {err && <div className="mb-3"><ErrorState error={err} /></div>}
      {!ev || !v ? (
        <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">
          No qualification run yet. Once the pipeline is live, a qualification run checks the deployment, data and access against the requirements
          and seals an evidence pack.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[length:var(--text-ui-sm)]">
            <Badge tone={v.tone} dot>{v.label}</Badge>
            <span className="text-muted-foreground">v{ev.version} · run by {ev.created_by} · <span title={new Date(ev.created_at).toLocaleString()}>{fmt.ago(ev.created_at)}</span></span>
            {ev.version !== d.request.version && <Badge tone="warning">Qualified v{ev.version}; current is v{d.request.version}</Badge>}
          </div>
          <dl className="mt-3 grid gap-1.5 text-[length:var(--text-ui-sm)]">
            <div className="grid grid-cols-[128px_1fr] gap-3"><dt className="text-muted-foreground">SHA-256</dt><dd className="num truncate" title={ev.sha256}>{ev.sha256.slice(0, 16)}</dd></div>
            <div className="grid grid-cols-[128px_1fr] gap-3"><dt className="text-muted-foreground">Evidence pack</dt><dd className="num break-all">{ev.volume_path ?? <span className="text-subtle">Not stored in a volume (download it here)</span>}</dd></div>
          </dl>
          {ev.checks.length > 0 && (
            <div className="mt-3 divide-y border-t pt-1">
              {ev.checks.map((x) => (
                <div key={x.key}>
                  <CheckRow c={x} />
                  {x.requirement && <div className="-mt-1 pb-1.5 pl-[25px] text-[length:var(--text-ui-xs)] text-subtle">{x.requirement}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <h3 className="mb-2 mt-5 flex items-center gap-2 text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.12em] text-subtle">
        <Signature size={13} />Electronic signatures
      </h3>
      {gxp.signatures.length === 0 ? (
        <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">No signatures yet. The approver signs with their printed name and signing PIN.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-[length:var(--text-ui-sm)]" aria-label="Electronic signatures">
            <thead className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.1em] text-subtle">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">Printed name</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Signer</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Meaning</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Signed (UTC)</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Reason</th>
                <th scope="col" className="py-1.5 text-right font-medium">Seal</th>
              </tr>
            </thead>
            <tbody>
              {gxp.signatures.map((sg) => (
                <tr key={`${sg.signer}-${sg.signed_at}`} className="border-t align-top">
                  <td className="py-2 pr-3 text-foreground">{sg.printed_name}</td>
                  <td className="max-w-[180px] truncate py-2 pr-3 text-muted-foreground" title={sg.signer}>{sg.signer}</td>
                  <td className="py-2 pr-3">{sg.meaning} <span className="num text-subtle">· v{sg.version}</span></td>
                  <td className="num whitespace-nowrap py-2 pr-3 text-muted-foreground">{utc(sg.signed_at)}</td>
                  <td className="max-w-[200px] py-2 pr-3 text-muted-foreground"><span className="line-clamp-2" title={sg.reason}>{sg.reason}</span></td>
                  <td className="py-2 text-right" title={`Manifest ${sg.manifest_hash.slice(0, 16)} · config ${sg.config_hash.slice(0, 10)}`}>
                    {sg.intact ? <Badge tone="success" dot>Intact</Badge> : <Badge tone="danger" dot>Broken</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const GRANT_TONE: Record<string, Tone> = { granted: "success", pending: "warning", failed: "danger" };
const cell = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

function AccessCard({ base, access, landed }: { base: string; access: AccessModel; landed: boolean }) {
  const [checks, setChecks] = useState<CheckResult[] | null>(access.checks ?? null);
  const [verifying, setVerifying] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<DataPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState<WriteError | null>(null);

  const verify = async () => {
    setVerifying(true); setVerifyErr(null);
    try {
      const r = await get<AccessModel>(`${base}/access?verify=true`);
      setChecks(r.checks ?? []);
    } catch (e) {
      setVerifyErr(errOf(e).detail);
    } finally {
      setVerifying(false);
    }
  };
  const readAsMe = async () => {
    setPreviewing(true); setPreviewErr(null);
    try {
      setPreview(await get<DataPreview>(`${base}/preview`));
    } catch (e) {
      setPreview(null);
      setPreviewErr(errOf(e));
    } finally {
      setPreviewing(false);
    }
  };
  const rows = (preview?.rows ?? []).slice(0, 20);
  const cols = preview ? (preview.columns.length ? preview.columns : Object.keys(rows[0] ?? {})) : [];

  return (
    <Card className="p-5" data-testid="access-card">
      <SectionTitle icon={<Lock size={15} />} title="Access"
        right={<div className="flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" variant="ghost" icon={<ShieldCheck size={13} />} loading={verifying} onClick={verify}>Verify access</Button>
          <Button size="sm" icon={<Eye size={13} />} loading={previewing} disabled={!landed}
            title={landed ? undefined : "Data can be previewed once the pipeline is live"} onClick={readAsMe}>Preview data as me</Button>
        </div>} />
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        <Group icon={<Rocket size={13} />} title="Runtime" rows={[
          ["Runs as", access.run_as],
          ["Identity", <span className="num">{access.service_principal}</span>],
        ]} />
        <Group icon={<Database size={13} />} title="Source" rows={[
          ["Securable", access.source.securable ? <span className="num">{access.source.securable}</span> : <span className="text-subtle">None</span>],
          ["Kind", access.source.kind],
          ["Who", <Badge tone="primary">{access.source.who || "service principal only"}</Badge>],
        ]} />
      </div>
      <div className="mt-4 border-t pt-4">
        <h3 className="mb-2 flex items-center gap-2 text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.12em] text-subtle"><Target size={13} />Target</h3>
        {access.target.tables.length === 0 ? <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">No landed tables yet.</p> : (
          <ul className="space-y-0.5" aria-label="Target tables">
            {access.target.tables.map((t) => <li key={t} className="num break-all text-[length:var(--text-ui-sm)]">{t}</li>)}
          </ul>
        )}
        <div className="mt-3 grid gap-3 text-[length:var(--text-ui-sm)] md:grid-cols-2">
          <div>
            <div className="mb-1 text-muted-foreground">Readers</div>
            <div className="flex flex-wrap gap-1" aria-label="Readers">
              {access.target.readers.length ? access.target.readers.map((p) => <Badge key={p}>{p}</Badge>) : <span className="text-subtle">None</span>}
            </div>
          </div>
          <div>
            <div className="mb-1 text-muted-foreground">Privileges (read-only)</div>
            <div className="flex flex-wrap gap-1" aria-label="Privileges">
              {access.target.privileges.map((p) => <Badge key={p} tone="info" className="num">{p}</Badge>)}
            </div>
          </div>
        </div>
      </div>

      {access.grants.length > 0 && (
        <div className="mt-4 overflow-x-auto border-t pt-3">
          <table className="w-full min-w-[520px] text-left text-[length:var(--text-ui-sm)]" aria-label="Grants">
            <thead className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.1em] text-subtle">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">Principal</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Securable</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Privileges</th>
                <th scope="col" className="py-1.5 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {access.grants.map((g) => (
                <tr key={`${g.principal}|${g.securable}`} className="border-t">
                  <td className="max-w-[180px] truncate py-2 pr-3" title={g.principal}>{g.principal}</td>
                  <td className="num max-w-[220px] truncate py-2 pr-3 text-muted-foreground" title={g.securable}>{g.securable}</td>
                  <td className="num py-2 pr-3 text-muted-foreground">{g.privileges}</td>
                  <td className="py-2 text-right" title={g.detail || undefined}>
                    <Badge tone={GRANT_TONE[g.status] ?? "neutral"} className="capitalize">{g.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {verifyErr && <div className="mt-4"><ErrorState error={verifyErr} onRetry={verify} /></div>}
      {checks && (
        <div className="mt-4 border-t pt-3" data-testid="access-checks">
          {checks.length === 0 ? <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">Nothing to verify yet.</p>
            : <div className="divide-y">{checks.map((x) => <CheckRow key={x.key} c={x} />)}</div>}
        </div>
      )}

      {previewErr && (previewErr.status === 403 ? (
        <div role="status" className="mt-4 flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/8 p-3 text-[length:var(--text-ui-sm)]">
          <Lock size={15} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0">
            <div className="font-medium text-foreground">You can't read this data with your own permissions yet</div>
            <div className="mt-0.5 break-words text-muted-foreground">{previewErr.detail}</div>
          </div>
        </div>
      ) : <div className="mt-4"><ErrorState error={previewErr.detail} onRetry={readAsMe} /></div>)}
      {preview && (
        <div className="mt-4 border-t pt-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-[length:var(--text-ui-xs)] text-subtle">
            <span className="num text-foreground">{preview.table}</span>
            <span>as {preview.as_user} · {rows.length} row{rows.length === 1 ? "" : "s"}</span>
          </div>
          <div className="scroll-y max-h-[360px] overflow-x-auto rounded-md border">
            <table className="w-full text-left text-[length:var(--text-ui-xs)]">
              <caption className="caption-bottom px-3 py-2 text-left text-subtle">Read with your own permissions (on-behalf-of) — this query is attributed to you</caption>
              <thead className="bg-muted/50 uppercase tracking-[0.08em] text-subtle">
                <tr>{cols.map((k) => <th key={k} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{k}</th>)}</tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={Math.max(1, cols.length)} className="px-3 py-3 text-muted-foreground">The table has no rows yet.</td></tr>
                ) : rows.map((row, i) => (
                  <tr key={i} className="border-t">
                    {cols.map((k) => <td key={k} className="num max-w-[220px] truncate whitespace-nowrap px-3 py-1.5" title={cell(row[k])}>{cell(row[k])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}


function SectionTitle({ icon, title, right }: { icon: ReactNode; title: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-[length:var(--text-ui-md)] font-medium">
        <span className="text-primary">{icon}</span>{title}
      </h2>
      {right}
    </div>
  );
}

function CheckSummary({ checks }: { checks: CheckResult[] }) {
  const n = (s: CheckResult["status"]) => checks.filter((c) => c.status === s).length;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      <Badge tone="success">{n("pass")} passed</Badge>
      {n("warn") > 0 && <Badge tone="warning">{n("warn")} warning{n("warn") === 1 ? "" : "s"}</Badge>}
      {n("fail") > 0 && <Badge tone="danger">{n("fail")} failing</Badge>}
    </div>
  );
}

function Group({ icon, title, rows }: { icon: ReactNode; title: string; rows: [string, ReactNode][] }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="mb-2 flex items-center gap-2 text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.12em] text-subtle">
        {icon}{title}
      </h3>
      <dl className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[128px_1fr] gap-3 text-[length:var(--text-ui-sm)]">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ConfigSummary({ d }: { d: Detail }) {
  const c = d.config;
  const keys = Array.from(new Set(c.objects.flatMap((o) => o.primary_keys)));
  const mono = (s: ReactNode) => <span className="num">{s}</span>;
  return (
    <Card className="p-5">
      <SectionTitle icon={<ClipboardCheck size={15} />} title="Approved configuration" right={<span className="num text-[length:var(--text-ui-xs)] text-subtle">version {d.request.version}</span>} />
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <Group icon={<Database size={13} />} title="Source" rows={[
          ["Connector", <>{c.source.connector} <span className="text-subtle">· {c.source.pattern.toUpperCase()}</span></>],
          ["Connection", c.source.connection ? mono(c.source.connection) : <span className="text-subtle">Not chosen</span>],
          ...(c.source.database ? [["Database", mono(c.source.database)] as [string, ReactNode]] : []),
          ["Objects", `${c.objects.length} table${c.objects.length === 1 ? "" : "s"}`],
        ]} />
        <Group icon={<CalendarClock size={13} />} title="Schedule" rows={[
          ["Load mode", LOAD_MODE[c.source.pattern] ?? c.source.pattern],
          ["Refresh", c.schedule.mode === "continuous" ? "Continuous" : `Every ${fmt.min(c.schedule.interval_minutes)}`],
          ["Freshness SLA", fmt.min(c.schedule.sla_minutes)],
        ]} />
        <Group icon={<Table2 size={13} />} title="Schema" rows={[
          ["SCD type", c.schema.scd_type === "SCD_TYPE_2" ? "Type 2 (keeps history)" : "Type 1 (latest values)"],
          ["Keys", keys.length ? mono(keys.join(", ")) : <span className="text-subtle">None declared</span>],
          ["New columns", c.schema.evolution === "add_new_columns" ? "Added automatically" : "Ignored"],
        ]} />
        <Group icon={<Target size={13} />} title="Destination" rows={[
          ["Environment", <Badge tone={c.destination.environment === "prod" ? "primary" : "neutral"} className="uppercase">{c.destination.environment}</Badge>],
          ["Target", mono(`${c.destination.catalog}.${c.destination.schema}`)],
          ...(c.destination.table_prefix ? [["Table prefix", mono(c.destination.table_prefix)] as [string, ReactNode]] : []),
        ]} />
        <Group icon={<Users size={13} />} title="Ownership" rows={[
          ["Owner", c.ownership.owner],
          ["Classification", <Badge tone={CLASS_TONE[c.ownership.classification] ?? "neutral"} className="capitalize">{c.ownership.classification}</Badge>],
          ["Domain", c.ownership.domain],
          ["Cost center", mono(c.ownership.cost_center)],
          ...(c.ownership.justification ? [["Justification", c.ownership.justification] as [string, ReactNode]] : []),
        ]} />
        <Group icon={<Wrench size={13} />} title="Operations" rows={[
          ["Retries", mono(c.operations.retries)],
          ["Recovery", c.operations.recovery === "auto_retry_then_ticket" ? "Auto-retry, then a ticket" : "Ticket only"],
          ["Reconciliation", c.operations.reconciliation ? "Source vs destination row counts" : "Off"],
          ...(c.operations.alert_emails.length ? [["Alerts", c.operations.alert_emails.join(", ")] as [string, ReactNode]] : []),
        ]} />
      </div>
    </Card>
  );
}


function ObjectsCard({ d }: { d: Detail }) {
  const objs = d.config.objects;
  return (
    <Card className="overflow-hidden">
      <div className="px-5 pt-5"><SectionTitle icon={<Table2 size={15} />} title="Objects" /></div>
      {objs.length === 0 ? <div className="px-5 pb-5 text-[length:var(--text-ui-sm)] text-muted-foreground">No objects selected.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[length:var(--text-ui-sm)]">
            <thead className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.1em] text-subtle">
              <tr>
                <th scope="col" className="px-5 py-2 font-medium">Table</th>
                <th scope="col" className="px-5 py-2 font-medium">Primary keys</th>
                <th scope="col" className="px-5 py-2 font-medium">Cursor</th>
                <th scope="col" className="px-5 py-2 text-right font-medium">Rows</th>
              </tr>
            </thead>
            <tbody>
              {objs.map((o) => (
                <tr key={`${o.schema}.${o.table}`} className="border-t">
                  <td className="num px-5 py-2.5">{o.schema}.{o.table}</td>
                  <td className="px-5 py-2.5">
                    {o.primary_keys.length
                      ? <span className="flex flex-wrap gap-1">{o.primary_keys.map((k) => <Badge key={k} className="num">{k}</Badge>)}</span>
                      : <Badge tone="warning">No key</Badge>}
                  </td>
                  <td className="num px-5 py-2.5 text-muted-foreground">{o.cursor_column || "—"}</td>
                  <td className="num px-5 py-2.5 text-right">{fmt.int(o.rows_est ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ForecastCard({ d }: { d: Detail }) {
  const f = d.forecast;
  return (
    <Card className="p-5">
      <SectionTitle icon={<Target size={15} />} title="Forecast" right={f ? <SourcePill source={f.source} reason={f.degraded_reason} /> : undefined} />
      {!f ? (
        <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">No forecast yet. Re-validate to forecast cost, time to first data and freshness.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            <Stat label="Cost / month" value={fmt.usd(f.cost.month.p50)} sub={`p90 ${fmt.usd(f.cost.month.p90)}`} testId="forecast-cost" />
            <Stat label="First data" value={fmt.min(f.first_data_min.p50)} sub={`p90 ${fmt.min(f.first_data_min.p90)}`} />
            <Stat label="Freshness p90" value={fmt.min(f.freshness_min.p90)} sub={`p50 ${fmt.min(f.freshness_min.p50)}`} />
            <Stat label="SLA attainment" value={fmt.pct(f.sla.attainment_pct)} sub={`target ${fmt.min(f.sla.target_min)}`} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3 text-[length:var(--text-ui-xs)] text-muted-foreground">
            <Badge tone={CONF_TONE[f.confidence]} className="capitalize">{f.confidence} confidence</Badge>
            <span>Based on {f.basis.n_pipelines} {f.basis.match === "family" ? f.basis.family : f.basis.match} pipelines, {f.basis.window_days} days · model {f.model_version}</span>
          </div>
        </>
      )}
    </Card>
  );
}

const STEP_META: Record<Detail["deployment"][number]["status"], { icon: ReactNode; label: string; cls: string }> = {
  pending: { icon: <Circle size={15} />, label: "Pending", cls: "text-subtle" },
  running: { icon: <LoaderCircle size={15} className="animate-spin" />, label: "Running", cls: "text-primary" },
  done: { icon: <CircleCheck size={15} />, label: "Done", cls: "text-success" },
  failed: { icon: <CircleX size={15} />, label: "Failed", cls: "text-destructive" },
  skipped: { icon: <CircleMinus size={15} />, label: "Skipped", cls: "text-subtle" },
};

function DeploymentCard({ d }: { d: Detail }) {
  return (
    <Card className="p-5">
      <SectionTitle icon={<Rocket size={15} />} title="Deployment" />
      <ol className="space-y-2.5">
        {d.deployment.map((s) => {
          const m = STEP_META[s.status] ?? STEP_META.pending;
          return (
            <li key={s.step} className="flex items-start gap-2.5" data-testid={`deploy-step-${s.step}`}>
              <span className={cx("mt-0.5 shrink-0", m.cls)}>{m.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[length:var(--text-ui-sm)] font-medium">{s.step}</span>
                  <span className={cx("text-[length:var(--text-ui-xs)]", m.cls)}>{m.label}{s.at ? ` · ${fmt.ago(s.at)}` : ""}</span>
                </div>
                {s.detail && <div className="break-words text-[length:var(--text-ui-xs)] text-muted-foreground">{s.detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function TimelineCard({ d }: { d: Detail }) {
  const events = [...d.timeline].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return (
    <Card className="p-5 lg:col-span-7">
      <SectionTitle icon={<CalendarClock size={15} />} title="Timeline" />
      {events.length === 0 ? <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">No events yet.</p> : (
        <ol className="relative ml-1.5 border-l pl-5">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="relative pb-4 last:pb-0">
              <span className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-primary" />
              <div className="flex flex-wrap items-baseline gap-x-2 text-[length:var(--text-ui-sm)]">
                <span className="font-medium">{e.action}</span>
                <span className="text-muted-foreground">by {e.actor}</span>
                <span className="text-[length:var(--text-ui-xs)] text-subtle" title={new Date(e.at).toLocaleString()}>{fmt.ago(e.at)}</span>
              </div>
              {e.detail && <div className="mt-0.5 break-words text-[length:var(--text-ui-xs)] text-muted-foreground">{e.detail}</div>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function VersionsCard({ d }: { d: Detail }) {
  const versions = [...d.versions].sort((a, b) => b.version - a.version);
  return (
    <Card className="p-5 lg:col-span-5">
      <SectionTitle icon={<FileCode2 size={15} />} title="Versions" />
      {versions.length === 0 ? <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">No versions recorded.</p> : (
        <table className="w-full text-left text-[length:var(--text-ui-sm)]">
          <thead className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.1em] text-subtle">
            <tr>
              <th scope="col" className="py-1.5 font-medium">Version</th>
              <th scope="col" className="py-1.5 font-medium">By</th>
              <th scope="col" className="py-1.5 font-medium">When</th>
              <th scope="col" className="py-1.5 text-right font-medium">Hash</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version} className="border-t">
                <td className="py-2">
                  <span className="num">v{v.version}</span>
                  {v.version === d.request.version && <Badge tone="primary" className="ml-2">current</Badge>}
                </td>
                <td className="max-w-[160px] truncate py-2 text-muted-foreground" title={v.created_by}>{v.created_by}</td>
                <td className="py-2 text-muted-foreground" title={new Date(v.created_at).toLocaleString()}>{fmt.ago(v.created_at)}</td>
                <td className="num py-2 text-right text-subtle" title={v.hash}>{v.hash.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function SpecDrawer({ open, onClose, path, requestId }: { open: boolean; onClose: () => void; path: string; requestId: string }) {
  const { data, error, loading, reload } = useApi<Spec & Partial<Sourced>>(open ? path : null);
  const [tab, setTab] = useState<SpecTab>("gateway");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEscape(open, onClose);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { if (data && !data.gateway) setTab((t) => (t === "gateway" ? "ingestion" : t)); }, [data]);

  const text = !data ? "" : tab === "bundle" ? data.bundle_yaml
    : tab === "gateway" ? (data.gateway ? JSON.stringify(data.gateway, null, 2) : "")
    : tab === "job" ? (data.job ? JSON.stringify(data.job, null, 2) : "")
    : JSON.stringify(data.ingestion, null, 2);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title={`Spec · ${requestId}`} width={760}>
      {!data && (loading || !error) ? (
        <div className="space-y-3" aria-busy="true"><Skeleton className="h-8 w-80" /><Skeleton className="h-96 w-full" /></div>
      ) : error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : data ? (
        <div className="space-y-3">
          <p className="text-[length:var(--text-ui-sm)] text-muted-foreground">
            The exact resources this version deploys: the same JSON the service sends to the Databricks APIs, and the equivalent bundle for Git.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented ariaLabel="Spec format" size="sm" value={tab} onChange={setTab} options={[
              { value: "gateway", label: "Gateway JSON" },
              { value: "ingestion", label: "Ingestion JSON" },
              { value: "job", label: "Job JSON" },
              { value: "bundle", label: "Bundle YAML" },
            ]} />
            <div className="flex items-center gap-2">
              <SourcePill source={data.source} reason={data.degraded_reason} />
              <Button size="sm" variant="ghost" icon={copied ? <Check size={13} /> : <Copy size={13} />} disabled={!text} onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
          {text ? <Code className="max-h-[calc(100vh-220px)]">{text}</Code> : (
            <EmptyState title={tab === "gateway" ? "No ingestion gateway" : "No schedule job"}
              body={tab === "gateway" ? "This pattern reads the source directly, so it doesn't need a gateway." : "This pipeline runs continuously, so it has no schedule job."} />
          )}
        </div>
      ) : null}
    </Drawer>
  );
}

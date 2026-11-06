import { motion } from "framer-motion";
import {
  ChartColumn, KeyRound, Lock, Plug2, RefreshCw, ScrollText, Search, ShieldCheck, ShieldOff, SlidersHorizontal, UserCog, UserPlus, Users,
} from "lucide-react";
import { KeyboardEvent, ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useSearchParams } from "react-router-dom";
import { useBrand } from "@/brand/BrandContext";
import {
  Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Segmented, Skeleton, SourcePill, Stat, Textarea, Toggle,
  cx, fadeUp, type Tone,
} from "@/components/ui";
import { ApiError, del, fmt, get, post, put, useApi } from "@/lib/api";
import type { ItsmStatus, Sourced, Tier, UsageResponse, UsageUser } from "@/lib/types";

type Tab = "admins" | "approvers" | "policies" | "audit" | "usage" | "integrations";
const TABS: { value: Tab; label: string }[] = [
  { value: "admins", label: "Administrators" },
  { value: "approvers", label: "Data owners" },
  { value: "policies", label: "Policies" },
  { value: "audit", label: "Audit" },
  { value: "usage", label: "Usage" },
  { value: "integrations", label: "Integrations" },
];
const MIN_REASON = 5;
const RO_TITLE = "Read-only mode";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AdminRow { email: string; source: "deployer" | "bootstrap" | "granted" | string; granted_by: string | null; granted_at: string | null; reason: string | null; removable: boolean }
interface ApproverRow { email: string; scope: string; granted_by: string | null; granted_at: string | null; reason: string | null }
interface PolicyItem { key: string; label: string; description: string; value: unknown; updated_by: string | null; updated_at: string | null }
interface AuditRow { at: string; actor: string; action: string; entity: string; entity_id: string; detail: unknown }
interface WorkspaceUser { email: string; name: string | null; active: boolean }
type List<T> = Partial<Sourced> & { items: T[] };

const SOURCE_META: Record<string, { label: string; tone: Tone; note: string }> = {
  deployer: { label: "Deployer", tone: "primary", note: "Deployed this app" },
  bootstrap: { label: "Bootstrap", tone: "info", note: "Set at deploy time" },
  granted: { label: "Granted", tone: "neutral", note: "Granted in the app" },
};

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
const errText = (e: unknown) => (e instanceof ApiError ? e.detail : String(e));

function useEscape(active: boolean, onEscape: () => void) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const h = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") ref.current(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [active]);
}

export default function Admin() {
  const { me } = useBrand();
  const [params, setParams] = useSearchParams();
  const t = params.get("tab");
  const tab: Tab = TABS.some((x) => x.value === t) ? (t as Tab) : "admins";
  const header = (
    <PageHeader eyebrow="Govern" title="Administration"
      subtitle="Who administers the service and approves data, the guardrails every request is checked against, and the audit trail." />
  );

  if (!me) {
    return <div>{header}<div className="space-y-3" aria-busy="true"><Skeleton className="h-9 w-96" /><Skeleton className="h-64 w-full" /></div></div>;
  }
  if (!me.is_admin) {
    return (
      <motion.div {...fadeUp}>
        {header}
        <EmptyState icon={<ShieldOff size={28} />} title="Administrators only"
          body="This area manages administrators, data owners and policies. If you need access, ask one of the service's administrators." />
      </motion.div>
    );
  }

  const setTab = (v: Tab) => {
    const next = new URLSearchParams(params);
    if (v === "admins") next.delete("tab"); else next.set("tab", v);
    setParams(next, { replace: true });
  };

  return (
    <motion.div {...fadeUp}>
      {header}
      <div className="mb-5 overflow-x-auto pb-1"><Segmented ariaLabel="Administration section" value={tab} onChange={setTab} options={TABS} /></div>
      <motion.div key={tab} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease: "easeInOut" }}>
        {tab === "admins" && <AdminsSection ro={me.kiosk} myEmail={me.email} />}
        {tab === "approvers" && <ApproversSection ro={me.kiosk} />}
        {tab === "policies" && <PoliciesSection ro={me.kiosk} />}
        {tab === "audit" && <AuditSection />}
        {tab === "usage" && <UsageSection />}
        {tab === "integrations" && <IntegrationsSection ro={me.kiosk} />}
      </motion.div>
    </motion.div>
  );
}

/* ---------- shared bits ---------- */

function SectionBar({ icon, title, body, source, reason, onRefresh }: { icon: ReactNode; title: string; body: string; source?: Tier | null; reason?: string | null; onRefresh: () => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-[length:var(--text-ui-lg)] font-light"><span className="text-primary">{icon}</span>{title}</h2>
        <p className="mt-0.5 max-w-2xl text-[length:var(--text-ui-sm)] text-muted-foreground">{body}</p>
      </div>
      <div className="flex items-center gap-2">
        <SourcePill source={source} reason={reason} />
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={onRefresh}>Refresh</Button>
      </div>
    </div>
  );
}

function InlineError({ text }: { text: string }) {
  return <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[length:var(--text-ui-sm)] text-destructive">{text}</div>;
}

function TableSkeleton() {
  return <Card className="space-y-3 p-5" aria-busy="true">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</Card>;
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th scope="col" className={cx("px-4 py-2.5 font-medium", right && "text-right")}>{children}</th>;
}

function ReasonField({ value, onChange, autoFocus, placeholder }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; placeholder?: string }) {
  return (
    <Field label="Reason" hint={`Required, at least ${MIN_REASON} characters. Recorded in the audit trail.`}>
      <Textarea autoFocus={autoFocus} aria-label="Reason" aria-required="true" rows={2} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** Confirm a governed write; shows its error inline and stays open until it succeeds. */
function ConfirmModal({ open, title, children, confirm, variant = "primary", busy, error, disabled, ro, onConfirm, onClose, firstFieldFocus }: {
  open: boolean; title: string; children: ReactNode; confirm: string; variant?: "primary" | "danger"; busy: boolean; error: string | null;
  disabled?: boolean; ro: boolean; onConfirm: () => void; onClose: () => void; firstFieldFocus?: boolean;
}) {
  const close = () => { if (!busy) onClose(); };
  useEscape(open, close);
  return (
    <Modal open={open} onClose={close} title={title}
      footer={<>
        <Button variant="ghost" autoFocus={!firstFieldFocus} onClick={close} disabled={busy}>Back</Button>
        <Button variant={variant} loading={busy} disabled={disabled || ro} title={ro ? RO_TITLE : undefined} onClick={onConfirm}>{confirm}</Button>
      </>}>
      <div className="space-y-3">
        {children}
        {error && <InlineError text={error} />}
      </div>
    </Modal>
  );
}

/** Search-as-you-type over the workspace directory; any well-formed email is also accepted. */
function PersonPicker({ value, onChange, taken, takenNote, disabled }: {
  value: string; onChange: (v: string) => void; taken: Set<string>; takenNote: string; disabled?: boolean;
}) {
  const inputId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<WorkspaceUser[]>([]);
  const [source, setSource] = useState<Tier | undefined>();
  const [searchedFor, setSearchedFor] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const q = value.trim();

  useEffect(() => {
    if (q.length < 2) { setResults([]); setSearchedFor(""); setError(null); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await get<List<WorkspaceUser>>(`/api/admin/workspace-users?q=${encodeURIComponent(q)}`, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setResults(r.items ?? []);
        setSource(r.source);
        setSearchedFor(q);
        setError(null);
        setActive(-1);
      } catch (e) {
        if (!ctrl.signal.aborted) setError(errText(e));
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [q]);

  const isTaken = (email: string) => taken.has(email.toLowerCase());
  const pick = (u: WorkspaceUser) => { if (isTaken(u.email)) return; onChange(u.email); setOpen(false); setActive(-1); };
  const move = (dir: 1 | -1) => {
    if (!results.length) return;
    let i = active;
    for (let n = 0; n < results.length; n++) {
      i = (i + dir + results.length) % results.length;
      if (!isTaken(results[i].email)) { setActive(i); return; }
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && open && active >= 0 && results[active]) { e.preventDefault(); pick(results[active]); }
    else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
  };

  const exact = results.some((u) => u.email.toLowerCase() === q.toLowerCase());
  const showUnknownHint = EMAIL_RE.test(q) && searchedFor === q && !searching && !error && !exact && !isTaken(q);
  const showList = open && q.length >= 2 && (results.length > 0 || searching);

  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-[length:var(--text-ui-sm)] font-medium text-muted-foreground">Person</label>
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
        <Input id={inputId} role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} autoComplete="off" disabled={disabled}
          placeholder="Search by name or email" value={value} className="w-full pl-8"
          onChange={(e) => { onChange(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey} />
        {showList && (
          <ul id={listId} role="listbox" aria-label="Workspace users"
            className="scroll-y absolute z-20 mt-1 max-h-64 w-full rounded-md border bg-elevated py-1 shadow-xl">
            {searching && results.length === 0 && <li className="px-3 py-2 text-[length:var(--text-ui-sm)] text-muted-foreground">Searching…</li>}
            {results.map((u, i) => {
              const t = isTaken(u.email);
              return (
                <li key={u.email} id={`${listId}-${i}`} role="option" aria-selected={i === active} aria-disabled={t}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => pick(u)}
                  className={cx("flex items-center justify-between gap-2 px-3 py-2 text-[length:var(--text-ui-sm)]",
                    t ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-muted", i === active && "bg-muted")}>
                  <span className="min-w-0">
                    <span className="block truncate text-foreground">{u.name || u.email}</span>
                    {u.name && <span className="block truncate text-[length:var(--text-ui-xs)] text-muted-foreground">{u.email}</span>}
                  </span>
                  <span className="shrink-0 text-[length:var(--text-ui-xs)] text-subtle">{t ? takenNote : !u.active ? "inactive" : ""}</span>
                </li>
              );
            })}
            {source && results.length > 0 && <li aria-hidden="true" className="flex justify-end px-3 pb-1 pt-1.5"><SourcePill source={source} /></li>}
          </ul>
        )}
      </div>
      <div className="mt-1 min-h-[1.25em] text-[length:var(--text-ui-xs)]">
        {isTaken(q) ? <span className="text-warning">{q} is {takenNote}.</span>
          : error ? <span className="text-destructive">Directory search failed: {error}. You can still type a full email.</span>
          : showUnknownHint ? <span className="text-muted-foreground">Not found in the workspace directory yet: they can sign in once they are a workspace user.</span>
          : q && !EMAIL_RE.test(q) && searchedFor === q && results.length === 0 ? <span className="text-subtle">No match. Type a full email address to add someone new.</span>
          : null}
      </div>
    </div>
  );
}

/* ---------- (a) Administrators ---------- */

function AdminsSection({ ro, myEmail }: { ro: boolean; myEmail: string }) {
  const { reloadMe } = useBrand();
  const { data, error, loading, reload } = useApi<List<AdminRow>>("/api/admin/admins");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [revoke, setRevoke] = useState<AdminRow | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const items = data?.items ?? [];
  const taken = useMemo(() => new Set(items.map((a) => a.email.toLowerCase())), [items]);
  const target = email.trim();
  const canAdd = EMAIL_RE.test(target) && !taken.has(target.toLowerCase()) && reason.trim().length >= MIN_REASON && !ro;

  const doAdd = async () => {
    setBusy(true); setWriteError(null);
    try {
      await post("/api/admin/admins", { email: target, reason: reason.trim() });
      setConfirmAdd(false); setEmail(""); setReason(""); setNotice(`${target} is now an administrator.`);
      reload(); reloadMe();
    } catch (e) { setWriteError(errText(e)); } finally { setBusy(false); }
  };
  const doRevoke = async () => {
    if (!revoke) return;
    setBusy(true); setWriteError(null);
    try {
      await del(`/api/admin/admins/${encodeURIComponent(revoke.email)}`, { reason: revokeReason.trim() });
      setNotice(`Revoked administrator access for ${revoke.email}.`);
      setRevokeOpen(false); setRevokeReason("");
      reload(); reloadMe();
    } catch (e) { setWriteError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div>
      <SectionBar icon={<UserCog size={17} />} title="Administrators" source={data?.source} reason={data?.degraded_reason} onRefresh={reload}
        body="Administrators manage who else can administer, who approves data, the policies and the connector catalog. The deployer is always an administrator." />
      <div className="grid gap-5 xl:grid-cols-12">
        <div className="xl:col-span-8">
          {!data && loading ? <TableSkeleton /> : error && !data ? <ErrorState error={error} onRetry={reload} /> : items.length === 0 ? (
            <EmptyState icon={<UserCog size={26} />} title="No administrators listed" body="Add someone with the form on the right." />
          ) : (
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[length:var(--text-ui-sm)]">
                  <thead className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.1em] text-subtle">
                    <tr><Th>Email</Th><Th>Source</Th><Th>Granted</Th><Th>Reason</Th><Th right>Access</Th></tr>
                  </thead>
                  <tbody>
                    {items.map((a) => {
                      const m = SOURCE_META[a.source] ?? { label: a.source, tone: "neutral" as Tone, note: "" };
                      return (
                        <tr key={a.email} className="border-t" data-testid={`admin-${a.email}`}>
                          <td className="px-4 py-3">
                            <span className="text-foreground">{a.email}</span>
                            {a.email.toLowerCase() === myEmail.toLowerCase() && <Badge tone="primary" className="ml-2">you</Badge>}
                          </td>
                          <td className="px-4 py-3"><Badge tone={m.tone}>{m.label}</Badge></td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {a.granted_by ? <>granted by {a.granted_by} on {fmtDate(a.granted_at)}</> : m.note}
                          </td>
                          <td className="max-w-[260px] px-4 py-3 text-muted-foreground"><span className="line-clamp-2" title={a.reason ?? ""}>{a.reason || "—"}</span></td>
                          <td className="px-4 py-3 text-right">
                            {a.removable ? (
                              <Button size="sm" variant="danger" disabled={ro} title={ro ? RO_TITLE : undefined}
                                aria-label={`Revoke ${a.email}`} onClick={() => { setWriteError(null); setRevokeReason(""); setRevoke(a); setRevokeOpen(true); }}>Revoke</Button>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[length:var(--text-ui-xs)] text-subtle" title="The deployer and bootstrap administrators can't be revoked in the app">
                                <Lock size={12} /> Protected
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          {notice && <div role="status" className="mt-3 text-[length:var(--text-ui-sm)] text-success">{notice}</div>}
        </div>

        <Card as="section" aria-label="Add admin" className="space-y-4 p-5 xl:col-span-4">
          <h3 className="flex items-center gap-2 text-[length:var(--text-ui-md)] font-medium"><UserPlus size={15} className="text-primary" />Add admin</h3>
          <PersonPicker value={email} onChange={setEmail} taken={taken} takenNote="already an administrator" disabled={ro} />
          <ReasonField value={reason} onChange={setReason} placeholder="e.g. Platform team on-call for ingestion" />
          <Button variant="primary" className="w-full" icon={<ShieldCheck size={14} />} disabled={!canAdd} title={ro ? RO_TITLE : undefined}
            onClick={() => { setWriteError(null); setNotice(null); setConfirmAdd(true); }}>Add admin</Button>
        </Card>
      </div>

      <ConfirmModal open={confirmAdd} title="Grant administrator access" confirm="Grant access" busy={busy} error={writeError} ro={ro}
        onConfirm={doAdd} onClose={() => setConfirmAdd(false)}>
        <p><span className="text-foreground">{target}</span> will be able to manage administrators, data owners, policies and connectors.</p>
        <p className="text-subtle">Reason: {reason.trim()}</p>
      </ConfirmModal>

      <ConfirmModal open={revokeOpen} title={revoke ? `Revoke ${revoke.email}` : "Revoke"} confirm="Revoke access" variant="danger" busy={busy} error={writeError} ro={ro}
        disabled={revokeReason.trim().length < MIN_REASON} firstFieldFocus onConfirm={doRevoke} onClose={() => setRevokeOpen(false)}>
        <p>They lose administrator access straight away. Requests they made or approved are unaffected.</p>
        <ReasonField autoFocus value={revokeReason} onChange={setRevokeReason} placeholder="e.g. Moved to another team" />
      </ConfirmModal>
    </div>
  );
}

/* ---------- (b) Data owners ---------- */

const scopeLabel = (s: string) => (s === "domain:*" ? "All domains" : s.startsWith("domain:") ? s.slice(7) : s);

function ApproversSection({ ro }: { ro: boolean }) {
  const { reloadMe } = useBrand();
  const { data, error, loading, reload } = useApi<List<ApproverRow>>("/api/admin/approvers");
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"all" | "one">("one");
  const [domain, setDomain] = useState("");
  const [reason, setReason] = useState("");
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [revoke, setRevoke] = useState<ApproverRow | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const domainsId = useId();

  const items = data?.items ?? [];
  const scope = mode === "all" ? "domain:*" : domain.trim() ? `domain:${domain.trim()}` : "";
  const taken = useMemo(() => new Set(items.filter((a) => a.scope === scope).map((a) => a.email.toLowerCase())), [items, scope]);
  const knownDomains = useMemo(() => Array.from(new Set(items.map((a) => a.scope).filter((s) => s.startsWith("domain:") && s !== "domain:*").map((s) => s.slice(7)))).sort(), [items]);
  const target = email.trim();
  const canAdd = EMAIL_RE.test(target) && !!scope && !taken.has(target.toLowerCase()) && reason.trim().length >= MIN_REASON && !ro;

  const doAdd = async () => {
    setBusy(true); setWriteError(null);
    try {
      await post("/api/admin/approvers", { email: target, scope, reason: reason.trim() });
      setConfirmAdd(false); setEmail(""); setReason(""); setNotice(`${target} can now approve ${scopeLabel(scope)} requests.`);
      reload(); reloadMe();
    } catch (e) { setWriteError(errText(e)); } finally { setBusy(false); }
  };
  const doRevoke = async () => {
    if (!revoke) return;
    setBusy(true); setWriteError(null);
    try {
      await del(`/api/admin/approvers/${encodeURIComponent(revoke.email)}?scope=${encodeURIComponent(revoke.scope)}`, { reason: revokeReason.trim() });
      setNotice(`${revoke.email} no longer approves ${scopeLabel(revoke.scope)} requests.`);
      setRevokeOpen(false); setRevokeReason("");
      reload(); reloadMe();
    } catch (e) { setWriteError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div>
      <SectionBar icon={<Users size={17} />} title="Data owners" source={data?.source} reason={data?.degraded_reason} onRefresh={reload}
        body="Data owners approve requests for their domain. Confidential and restricted data needs an approver other than the requester." />
      <div className="grid gap-5 xl:grid-cols-12">
        <div className="xl:col-span-8">
          {!data && loading ? <TableSkeleton /> : error && !data ? <ErrorState error={error} onRetry={reload} /> : items.length === 0 ? (
            <EmptyState icon={<Users size={26} />} title="No data owners yet" body="Until someone is added, only administrators can approve requests." />
          ) : (
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[length:var(--text-ui-sm)]">
                  <thead className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.1em] text-subtle">
                    <tr><Th>Email</Th><Th>Scope</Th><Th>Granted</Th><Th>Reason</Th><Th right>Access</Th></tr>
                  </thead>
                  <tbody>
                    {items.map((a) => (
                      <tr key={`${a.email}|${a.scope}`} className="border-t">
                        <td className="px-4 py-3 text-foreground">{a.email}</td>
                        <td className="px-4 py-3"><Badge tone={a.scope === "domain:*" ? "primary" : "neutral"}>{scopeLabel(a.scope)}</Badge></td>
                        <td className="px-4 py-3 text-muted-foreground">{a.granted_by ? <>granted by {a.granted_by} on {fmtDate(a.granted_at)}</> : "—"}</td>
                        <td className="max-w-[260px] px-4 py-3 text-muted-foreground"><span className="line-clamp-2" title={a.reason ?? ""}>{a.reason || "—"}</span></td>
                        <td className="px-4 py-3 text-right">
                          <Button size="sm" variant="danger" disabled={ro} title={ro ? RO_TITLE : undefined} aria-label={`Revoke ${a.email} for ${scopeLabel(a.scope)}`}
                            onClick={() => { setWriteError(null); setRevokeReason(""); setRevoke(a); setRevokeOpen(true); }}>Revoke</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          {notice && <div role="status" className="mt-3 text-[length:var(--text-ui-sm)] text-success">{notice}</div>}
        </div>

        <Card as="section" aria-label="Add data owner" className="space-y-4 p-5 xl:col-span-4">
          <h3 className="flex items-center gap-2 text-[length:var(--text-ui-md)] font-medium"><UserPlus size={15} className="text-primary" />Add data owner</h3>
          <PersonPicker value={email} onChange={setEmail} taken={taken} takenNote="already a data owner for this scope" disabled={ro} />
          <div>
            <div className="mb-1.5 text-[length:var(--text-ui-sm)] font-medium text-muted-foreground">Scope</div>
            <Segmented ariaLabel="Approval scope" size="sm" value={mode} onChange={setMode}
              options={[{ value: "one", label: "One domain" }, { value: "all", label: "All domains" }]} />
            {mode === "one" && (
              <div className="mt-2">
                <Input aria-label="Domain" list={domainsId} placeholder="e.g. finance" value={domain} onChange={(e) => setDomain(e.target.value)} className="w-full" />
                <datalist id={domainsId}>{knownDomains.map((d) => <option key={d} value={d} />)}</datalist>
              </div>
            )}
            <div className="mt-1 text-[length:var(--text-ui-xs)] text-subtle">{scope ? <>Scope <span className="num">{scope}</span></> : "Type the domain this person owns."}</div>
          </div>
          <ReasonField value={reason} onChange={setReason} placeholder="e.g. Finance data steward" />
          <Button variant="primary" className="w-full" icon={<ShieldCheck size={14} />} disabled={!canAdd} title={ro ? RO_TITLE : undefined}
            onClick={() => { setWriteError(null); setNotice(null); setConfirmAdd(true); }}>Add data owner</Button>
        </Card>
      </div>

      <ConfirmModal open={confirmAdd} title="Add a data owner" confirm="Grant approval rights" busy={busy} error={writeError} ro={ro}
        onConfirm={doAdd} onClose={() => setConfirmAdd(false)}>
        <p><span className="text-foreground">{target}</span> will be able to approve and reject requests for <span className="text-foreground">{scopeLabel(scope)}</span>.</p>
        <p className="text-subtle">Reason: {reason.trim()}</p>
      </ConfirmModal>

      <ConfirmModal open={revokeOpen} title={revoke ? `Revoke ${revoke.email}` : "Revoke"} confirm="Revoke approval rights" variant="danger" busy={busy} error={writeError} ro={ro}
        disabled={revokeReason.trim().length < MIN_REASON} firstFieldFocus onConfirm={doRevoke} onClose={() => setRevokeOpen(false)}>
        <p>They stop approving {revoke ? scopeLabel(revoke.scope) : ""} requests. Decisions they already made stay in the audit trail.</p>
        <ReasonField autoFocus value={revokeReason} onChange={setRevokeReason} placeholder="e.g. Ownership moved to another steward" />
      </ConfirmModal>
    </div>
  );
}

/* ---------- (c) Policies ---------- */

type Kind = "number" | "boolean" | "list" | "string" | "json";
function kindOf(v: unknown): Kind {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "string";
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return "list";
  return "json";
}
function toDraft(v: unknown, k: Kind): string | boolean {
  if (k === "boolean") return !!v;
  if (k === "number") return String(v);
  if (k === "list") return (v as string[]).join(", ");
  if (k === "string") return v as string;
  return JSON.stringify(v, null, 2);
}
function parseDraft(d: string | boolean, k: Kind, original: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (k === "boolean") return { ok: true, value: d };
  const s = String(d);
  if (k === "number") {
    if (!s.trim()) return { ok: false, error: "Enter a number." };
    const n = Number(s);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: "Enter a number." };
  }
  if (k === "list") return { ok: true, value: s.split(",").map((x) => x.trim()).filter(Boolean) };
  if (k === "string") return { ok: true, value: s };
  try {
    const v = JSON.parse(s);
    if (Array.isArray(original) && !Array.isArray(v)) return { ok: false, error: "Expected a JSON array." };
    if (original && typeof original === "object" && !Array.isArray(original) && (typeof v !== "object" || v === null || Array.isArray(v))) {
      return { ok: false, error: "Expected a JSON object." };
    }
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function PoliciesSection({ ro }: { ro: boolean }) {
  const { data, error, loading, reload, setData } = useApi<List<PolicyItem>>("/api/admin/policies");
  const items = data?.items ?? [];
  const onSaved = (p: PolicyItem) => setData((prev) => (prev ? { ...prev, items: prev.items.map((x) => (x.key === p.key ? p : x)) } : prev));
  return (
    <div>
      <SectionBar icon={<SlidersHorizontal size={17} />} title="Policies" source={data?.source} reason={data?.degraded_reason} onRefresh={reload}
        body="The guardrails every request is validated against. Changes apply to the next validation; approved versions keep the policy they were approved under." />
      {!data && loading ? <TableSkeleton /> : error && !data ? <ErrorState error={error} onRetry={reload} /> : items.length === 0 ? (
        <EmptyState icon={<SlidersHorizontal size={26} />} title="No policies defined" body="The service is using its built-in defaults." />
      ) : (
        <div className="space-y-3">
          {items.map((p) => <PolicyRow key={`${p.key}|${p.updated_at ?? ""}`} p={p} ro={ro} onSaved={onSaved} onStale={reload} />)}
        </div>
      )}
    </div>
  );
}

function PolicyRow({ p, ro, onSaved, onStale }: { p: PolicyItem; ro: boolean; onSaved: (p: PolicyItem) => void; onStale: () => void }) {
  const kind = kindOf(p.value);
  const [draft, setDraft] = useState<string | boolean>(() => toDraft(p.value, kind));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseDraft(draft, kind, p.value);
  const dirty = parsed.ok ? JSON.stringify(parsed.value) !== JSON.stringify(p.value) : true;

  const save = async () => {
    if (!parsed.ok) return;
    setBusy(true); setError(null);
    try {
      const r = await put<Partial<PolicyItem> | null>(`/api/admin/policies/${encodeURIComponent(p.key)}`, { value: parsed.value });
      if (r && typeof r === "object" && r.key === p.key && "value" in r) onSaved({ ...p, ...r } as PolicyItem);
      else onStale();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  const label = p.label || p.key;
  let editor: ReactNode;
  if (kind === "boolean") {
    editor = (
      <div className="flex items-center gap-2.5">
        <Toggle checked={draft as boolean} onChange={setDraft} label={label} disabled={ro} />
        <span className="text-[length:var(--text-ui-sm)] text-muted-foreground">{draft ? "On" : "Off"}</span>
      </div>
    );
  } else if (kind === "json") {
    editor = <Textarea aria-label={label} rows={Math.min(12, String(draft).split("\n").length + 1)} value={String(draft)} disabled={ro}
      spellCheck={false} className="num w-full text-[length:var(--text-ui-xs)]" onChange={(e) => setDraft(e.target.value)} />;
  } else {
    editor = <Input aria-label={label} type={kind === "number" ? "number" : "text"} value={String(draft)} disabled={ro}
      className={cx("w-full", kind === "number" && "num max-w-[200px]")} onChange={(e) => setDraft(e.target.value)} />;
  }

  return (
    <Card className="p-4" data-testid={`policy-${p.key}`}>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-5">
          <div className="text-[length:var(--text-ui-base)] font-medium">{label}</div>
          {p.description && <p className="mt-0.5 text-[length:var(--text-ui-sm)] text-muted-foreground">{p.description}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[length:var(--text-ui-xs)] text-subtle">
            <span className="num">{p.key}</span>
            {kind === "list" && <span>· comma-separated</span>}
            {p.updated_by && <span>· updated by {p.updated_by}, {fmt.ago(p.updated_at)}</span>}
          </div>
        </div>
        <div className="min-w-0 lg:col-span-7">
          {editor}
          {!parsed.ok && <div role="alert" className="mt-1 text-[length:var(--text-ui-xs)] text-destructive">{parsed.error}</div>}
          {error && <div className="mt-2"><InlineError text={error} /></div>}
          {dirty && (
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(toDraft(p.value, kind)); setError(null); }}>Discard</Button>
              <Button size="sm" variant="primary" loading={busy} disabled={!parsed.ok || ro} title={ro ? RO_TITLE : undefined} onClick={save}>Save {label}</Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ---------- (d) Audit ---------- */

const detailText = (d: unknown) => (d == null ? "" : typeof d === "string" ? d : JSON.stringify(d));

function AuditSection() {
  const { data, error, loading, reload } = useApi<List<AuditRow>>("/api/admin/audit?limit=200");
  const [q, setQ] = useState("");
  const items = data?.items ?? [];
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? items.filter((a) => [a.actor, a.action, a.entity, a.entity_id, detailText(a.detail)].some((s) => (s ?? "").toLowerCase().includes(needle)))
    : items;
  return (
    <div>
      <SectionBar icon={<ScrollText size={17} />} title="Audit" source={data?.source} reason={data?.degraded_reason} onRefresh={reload}
        body="Append-only record of every governed action: who did what, when, to which request, admin, policy or pipeline. Latest 200 events." />
      {!data && loading ? <TableSkeleton /> : error && !data ? <ErrorState error={error} onRetry={reload} /> : items.length === 0 ? (
        <EmptyState icon={<ScrollText size={26} />} title="No audit events yet" body="Events appear here as soon as anyone creates, approves or changes something." />
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
              <Input type="search" aria-label="Filter audit events" placeholder="Filter by actor, action, entity or detail" value={q}
                onChange={(e) => setQ(e.target.value)} className="w-80 pl-8" />
            </div>
            <span className="text-[length:var(--text-ui-xs)] text-subtle">{shown.length === items.length ? `${items.length} events` : `${shown.length} of ${items.length} events`}</span>
          </div>
          {shown.length === 0 ? <div className="px-4 py-8 text-center text-[length:var(--text-ui-sm)] text-muted-foreground">No events match “{q}”.</div> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-[length:var(--text-ui-xs)]">
                <thead className="uppercase tracking-[0.1em] text-subtle">
                  <tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Entity</Th><Th>Detail</Th></tr>
                </thead>
                <tbody>
                  {shown.map((a, i) => {
                    const d = detailText(a.detail);
                    return (
                      <tr key={`${a.at}-${i}`} className="border-t align-top">
                        <td className="whitespace-nowrap px-4 py-2 text-muted-foreground" title={new Date(a.at).toLocaleString()}>{fmt.ago(a.at)}</td>
                        <td className="max-w-[200px] truncate px-4 py-2 text-foreground" title={a.actor}>{a.actor}</td>
                        <td className="whitespace-nowrap px-4 py-2"><span className="num text-primary">{a.action}</span></td>
                        <td className="whitespace-nowrap px-4 py-2 text-muted-foreground"><span>{a.entity}</span> <span className="num text-foreground">{a.entity_id}</span></td>
                        <td className="max-w-[420px] px-4 py-2 text-muted-foreground"><span className="num line-clamp-2 break-all" title={d}>{d || "—"}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/* ---------- (e) Usage ---------- */

type Days = "7" | "30" | "90";
const ACTION_SHORT: Record<string, string> = { "esign.sign": "sign", "gxp.oq": "qualify" };
const actionsText = (a: Record<string, number> | undefined) =>
  Object.entries(a ?? {}).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1])
    .map(([k, n]) => `${ACTION_SHORT[k] ?? k.split(".").pop()} ${n}`).join(" · ");
const num = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));
const dayLabel = (d: string) => {
  const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
};

function UsageSection() {
  const [days, setDays] = useState<Days>("30");
  const { data, error, loading, reload } = useApi<UsageResponse>(`/api/admin/usage?days=${days}`);
  const users = data?.users ?? [];
  const totals = data?.totals ?? {};
  const sum = (k: keyof UsageUser) => users.reduce((a, u) => a + (Number(u[k]) || 0), 0);
  const chart = useMemo(() => (data?.daily ?? []).map((d) => ({ day: dayLabel(String(d.day)), calls: Number(d.calls) || 0, users: Number(d.users) || 0 })), [data]);
  const axis = "hsl(var(--muted-foreground))";
  const td = "num px-4 py-2.5 text-right";
  return (
    <div>
      <SectionBar icon={<ChartColumn size={17} />} title="Usage" source={data?.source} reason={data?.degraded_reason} onRefresh={reload}
        body="Who uses the service, what they do and what their pipelines cost. Rows come from the signed-in identity Databricks Apps forwards; queries the app runs on a user's behalf (OBO) run as them and are attributed to them in system.query.history." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented ariaLabel="Usage window" size="sm" value={days} onChange={setDays}
          options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />
        {data && (
          <Badge tone={data.otel?.enabled ? "success" : "neutral"} dot>
            {data.otel?.enabled ? "OpenTelemetry export on" : "OpenTelemetry export off"}
          </Badge>
        )}
        {loading && data && <span className="text-[length:var(--text-ui-xs)] text-subtle" aria-live="polite">Updating…</span>}
      </div>
      {!data && loading ? <TableSkeleton /> : error && !data ? <ErrorState error={error} onRetry={reload} /> : data && (
        <div className="space-y-5">
          <Card className="grid grid-cols-3 gap-4 p-5">
            <Stat label="Users" value={fmt.int(totals.users ?? users.length)} sub={`last ${data.days} days`} testId="usage-users" />
            <Stat label="Sessions" value={fmt.int(totals.sessions ?? sum("sessions"))} testId="usage-sessions" />
            <Stat label="API calls" value={fmt.int(totals.api_calls ?? sum("api_calls"))} testId="usage-calls" />
          </Card>
          <Card as="section" aria-labelledby="usage-chart-title" className="p-5">
            <h3 id="usage-chart-title" className="text-[length:var(--text-ui-md)] font-medium">Daily activity</h3>
            <p className="mt-0.5 text-[length:var(--text-ui-sm)] text-muted-foreground">API calls (bars) and distinct users (line) per day; the table below has the numbers per user.</p>
            {chart.length === 0 ? <p className="mt-4 text-[length:var(--text-ui-sm)] text-subtle">No activity in this window.</p> : (
              <figure className="mt-4 text-[length:var(--text-ui-xs)]" aria-label="Chart of daily API calls and users">
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={chart} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="day" tick={{ fill: axis }} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} minTickGap={16} />
                    <YAxis yAxisId="calls" tick={{ fill: axis }} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                    <YAxis yAxisId="users" orientation="right" tick={{ fill: axis }} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                    <Tooltip
                      cursor={{ fill: "hsl(var(--muted) / 0.6)" }}
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--foreground))" }}
                      labelStyle={{ color: "hsl(var(--foreground))", fontWeight: 500 }}
                      itemStyle={{ color: "hsl(var(--muted-foreground))" }}
                    />
                    <Legend formatter={(value) => <span style={{ color: axis }}>{String(value)}</span>} />
                    <Bar yAxisId="calls" dataKey="calls" name="API calls" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={28} />
                    <Line yAxisId="users" dataKey="users" name="Users" type="monotone" stroke="hsl(var(--success))" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </figure>
            )}
          </Card>
          {users.length === 0 ? (
            <EmptyState icon={<ChartColumn size={26} />} title="No usage recorded yet" body="Rows appear as soon as people sign in and use the service." />
          ) : (
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1180px] text-left text-[length:var(--text-ui-sm)]" aria-label="Usage per user">
                  <thead className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.1em] text-subtle">
                    <tr>
                      <Th>User</Th><Th right>Sessions</Th><Th right>API calls</Th><Th right>OBO calls</Th><Th right>OBO queries</Th><Th right>Avg ms</Th>
                      <Th right>Requests</Th><Th right>Live</Th><Th right>Forecast / mo</Th><Th right>Cost MTD</Th><Th right>WH queries</Th><Th>Actions</Th><Th>Last seen</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => {
                      const avg = num(u.avg_ms);
                      return (
                        <tr key={u.user_email} className="border-t" data-testid={`usage-${u.user_email}`}>
                          <td className="max-w-[220px] truncate px-4 py-2.5 text-foreground" title={u.user_email}>{u.user_email}</td>
                          <td className={td}>{fmt.int(u.sessions ?? 0)}</td>
                          <td className={td}>{fmt.int(u.api_calls ?? 0)}</td>
                          <td className={td}>{fmt.int(u.obo_calls ?? 0)}</td>
                          <td className={td}>{fmt.int(u.obo_queries ?? 0)}</td>
                          <td className={td}>{avg === null ? "—" : avg.toFixed(avg < 100 ? 1 : 0)}</td>
                          <td className={td}>{fmt.int(u.requests ?? 0)}</td>
                          <td className={td}>{fmt.int(u.live ?? 0)}</td>
                          <td className={td}>{fmt.usd(u.forecast_month_usd ?? null)}</td>
                          <td className={td}>{fmt.usd(u.cost_mtd_usd ?? null)}</td>
                          <td className={td}>{fmt.int(u.wh_queries ?? 0)}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{actionsText(u.actions) || "—"}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground" title={u.last_seen ? new Date(u.last_seen).toLocaleString() : undefined}>{fmt.ago(u.last_seen)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- (f) Integrations ---------- */

function IntegrationsSection({ ro }: { ro: boolean }) {
  const { data, error, loading, reload } = useApi<ItsmStatus>("/api/itsm/status");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const target = email.trim().toLowerCase();
  const canReset = EMAIL_RE.test(target) && reason.trim().length >= MIN_REASON && !ro;
  const sim = data?.mode === "simulator";

  const doReset = async () => {
    setBusy(true); setWriteError(null);
    try {
      await del(`/api/admin/signers/${encodeURIComponent(target)}/pin`, { reason: reason.trim() });
      setConfirm(false); setEmail(""); setReason("");
      setNotice(`The signing PIN for ${target} was reset. They set a new one from their initials menu before their next signature.`);
    } catch (e) { setWriteError(errText(e)); } finally { setBusy(false); }
  };

  const rows: [string, ReactNode][] = data ? [
    ["Mode", <span title={sim ? "No ServiceNow instance configured: the built-in Table API simulator is used" : undefined}>
      <Badge tone={sim ? "neutral" : "success"} dot>{sim ? "Simulator" : "Connected"}</Badge></span>],
    ["Instance", data.instance ? <span className="num break-all">{data.instance}</span> : <span className="text-subtle">Built-in Table API simulator</span>],
    ["Request table", <span className="num">{data.request_table}</span>],
    ["Incident table", <span className="num">{data.incident_table}</span>],
    ["Assignment group", data.assignment_group || <span className="text-subtle">—</span>],
  ] : [];

  return (
    <div>
      <SectionBar icon={<Plug2 size={17} />} title="Integrations" onRefresh={reload}
        body="ServiceNow: every request opens a request record and every pipeline incident opens an incident, kept in sync with the request's status." />
      <div className="grid gap-5 xl:grid-cols-12">
        <Card as="section" aria-label="ServiceNow" className="p-5 xl:col-span-7">
          <h3 className="mb-3 text-[length:var(--text-ui-md)] font-medium">ServiceNow</h3>
          {!data && loading ? <div className="space-y-2" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
            : error && !data ? <ErrorState error={error} onRetry={reload} /> : (
              <dl className="space-y-2.5">
                {rows.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[150px_1fr] gap-3 text-[length:var(--text-ui-sm)]">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 text-foreground">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
        </Card>

        <Card as="section" aria-label="Signing PINs" className="space-y-4 p-5 xl:col-span-5">
          <div>
            <h3 className="flex items-center gap-2 text-[length:var(--text-ui-md)] font-medium"><KeyRound size={15} className="text-primary" />Signing PINs</h3>
            <p className="mt-1 text-[length:var(--text-ui-sm)] text-muted-foreground">Resets only; nobody can see or set another person's PIN.</p>
          </div>
          <Field label="Signer email">
            <Input aria-label="Signer email" type="email" autoComplete="off" value={email} disabled={ro} placeholder="name@example.com"
              onChange={(e) => { setEmail(e.target.value); setNotice(null); }} />
          </Field>
          <ReasonField value={reason} onChange={setReason} placeholder="e.g. Forgot their PIN; identity confirmed by phone" />
          <Button variant="danger" className="w-full" icon={<KeyRound size={14} />} disabled={!canReset} title={ro ? RO_TITLE : undefined}
            onClick={() => { setWriteError(null); setNotice(null); setConfirm(true); }}>Reset PIN</Button>
          {notice && <div role="status" className="text-[length:var(--text-ui-sm)] text-success">{notice}</div>}
        </Card>
      </div>

      <ConfirmModal open={confirm} title={`Reset the signing PIN for ${target}`} confirm="Reset PIN" variant="danger" busy={busy} error={writeError} ro={ro}
        onConfirm={doReset} onClose={() => setConfirm(false)}>
        <p>{target} can't sign until they set a new PIN. Their existing signatures stay valid. The reset is recorded in the audit trail.</p>
        <p className="text-subtle">Reason: {reason.trim()}</p>
      </ConfirmModal>
    </div>
  );
}

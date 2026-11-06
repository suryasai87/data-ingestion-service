import { AnimatePresence, motion } from "framer-motion";
import { Bot, MessageSquare, Send, Sparkles, User } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useBrand } from "@/brand/BrandContext";
import { AnimatedNumber, Badge, Button, Card, CheckRow, cx, ErrorState, PageHeader } from "@/components/ui";
import { ApiError, fmt, post } from "@/lib/api";
import type { ChatReply, ChatTurn, Forecast, IngestionConfig, RequestDetail } from "@/lib/types";

const SUGGESTIONS = [
  "Ingest the finance journal header and line tables from the ERP Postgres into Foundation every 15 minutes.",
  "Bring Salesforce Account and Opportunity into Foundation DEV every hour.",
  "Ingest SAP HANA tables BKPF and BSEG into Foundation every 15 minutes.",
];

const PATTERN: Record<string, string> = { cdc: "CDC", query: "Query-based", saas: "API", files: "Files", stream: "Stream" };

export default function Assistant() {
  const { brand, me } = useBrand();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [sid, setSid] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [reply, setReply] = useState<ChatReply | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ask = params.get("ask");
    if (ask) setText(`I need data from ${ask}. How do we onboard it into ${brand.destination_label}?`);
  }, [params, brand.destination_label]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" }); }, [turns, busy]);

  const draft = (reply?.draft ?? {}) as Partial<IngestionConfig>;
  useEffect(() => {
    if (!draft.source?.connector || !(draft.objects?.length)) { setForecast(null); return; }
    let live = true;
    post<Forecast>("/api/forecast", { config: draft }).then((f) => live && setForecast(f)).catch(() => live && setForecast(null));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(draft)]);

  async function send(message: string) {
    const m = message.trim();
    if (!m || busy) return;
    setTurns((t) => [...t, { role: "user", content: m }]);
    setText("");
    setBusy(true);
    setError(null);
    try {
      const r = await post<ChatReply>("/api/assistant/chat", { session_id: sid, message: m });
      setSid(r.session_id);
      setReply(r);
      setTurns((t) => [...t, { role: "assistant", content: r.reply }]);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!sid) return;
    setSubmitting(true);
    setError(null);
    try {
      const d = await post<RequestDetail>(`/api/assistant/${sid}/submit`);
      nav(`/requests/${d.request.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function edit() {
    try { sessionStorage.setItem("dis.draft", JSON.stringify(draft)); } catch { /* private mode */ }
    nav("/new");
  }

  const onSubmit = (e: FormEvent) => { e.preventDefault(); send(text); };
  const ready = !!reply?.ready;
  const missing = new Set(reply?.missing ?? []);
  const rows: [string, string | undefined, string][] = [
    ["Source", draft.source?.connector ? `${draft.source.connector}${draft.source.connection ? ` · ${draft.source.connection}` : ""}` : undefined, "source system"],
    ["Tables", draft.objects?.length ? draft.objects.map((o) => o.table).slice(0, 4).join(", ") + (draft.objects.length > 4 ? ` +${draft.objects.length - 4}` : "") : undefined, "tables or objects"],
    ["Target", draft.destination?.catalog ? `${brand.destination_label} · ${(draft.destination.environment ?? "dev").toUpperCase()}` : undefined, "destination"],
    ["Refresh", draft.schedule?.mode === "continuous" ? "Continuous" : draft.schedule?.interval_minutes ? `Every ${fmt.min(draft.schedule.interval_minutes)}` : undefined, "refresh frequency"],
    ["Pattern", draft.source?.pattern ? PATTERN[draft.source.pattern] ?? draft.source.pattern : undefined, ""],
    ["Owner", draft.ownership?.owner || undefined, "data owner"],
    ["Classification", draft.ownership?.classification, "classification"],
  ];

  return (
    <div>
      <PageHeader eyebrow="Conversational intake" title="Ingestion Assistant"
        subtitle="Describe the data and the business need. The assistant drafts the configuration; you confirm it; it goes through the same validation and approval as the form."
        actions={
          <div className="flex items-center gap-2">
            {reply && <Badge tone={reply.llm === "live" ? "primary" : "neutral"}>{reply.llm === "live" ? "Claude" : "Rules mode"}</Badge>}
            <span className="inline-flex items-center gap-1.5 text-[length:var(--text-ui-sm)] text-muted-foreground">
              <span className={cx("h-2 w-2 rounded-full", ready ? "bg-success pulse-dot" : "bg-border-strong")} />{ready ? "Ready for confirmation" : "Drafting"}
            </span>
          </div>
        } />

      <div className="grid gap-6 lg:grid-cols-12">
        <Card className="flex min-h-[560px] flex-col lg:col-span-7">
          <div className="scroll-y flex-1 space-y-5 p-5" aria-live="polite">
            {turns.length === 0 && (
              <div className="py-6 text-center">
                <div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-accent-soft text-primary"><MessageSquare size={18} /></div>
                <div className="mt-3 text-[length:var(--text-ui-md)] font-medium">What data do you need?</div>
                <div className="mx-auto mt-1 max-w-md text-[length:var(--text-ui-sm)] text-muted-foreground">Name the source, the tables and how fresh it must be. I'll ask for anything else.</div>
                <div className="mx-auto mt-5 flex max-w-xl flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => send(s)} className="rounded-lg border bg-elevated px-3.5 py-2.5 text-left text-[length:var(--text-ui-sm)] text-muted-foreground transition hover:border-border-strong hover:text-foreground">{s}</button>
                  ))}
                </div>
              </div>
            )}
            <AnimatePresence initial={false}>
              {turns.map((t, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: "easeOut" }} className="flex gap-3">
                  <span className={cx("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full", t.role === "user" ? "bg-plum text-lavender" : "bg-accent-soft text-primary")}>
                    {t.role === "user" ? <User size={15} /> : <Bot size={15} />}
                  </span>
                  <div className="min-w-0">
                    <div className="mb-1 text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.12em] text-subtle">{t.role === "user" ? (me?.name || "You") : "Assistant"}</div>
                    <div className={cx("rounded-lg px-3.5 py-2.5 text-[length:var(--text-ui-base)] leading-relaxed", t.role === "user" ? "bg-elevated" : "bg-muted/60")}>{t.content}</div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            {busy && (
              <div className="flex items-center gap-3 text-[length:var(--text-ui-sm)] text-subtle">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-primary"><Sparkles size={14} /></span>
                <span className="flex gap-1">{[0, 1, 2].map((d) => <motion.span key={d} className="h-1.5 w-1.5 rounded-full bg-primary" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.2, repeat: Infinity, delay: d * 0.2 }} />)}</span>
              </div>
            )}
            <div ref={endRef} />
          </div>
          {error && <div className="px-5 pb-3"><ErrorState error={error} /></div>}
          <form onSubmit={onSubmit} className="flex items-center gap-2 border-t p-3">
            <input aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about your request…" disabled={busy}
              className="h-11 flex-1 rounded-md border bg-elevated px-3.5 text-[length:var(--text-ui-base)] placeholder:text-subtle focus:border-primary/70 focus:outline-none" />
            <Button type="submit" variant="primary" size="lg" disabled={!text.trim() || busy} aria-label="Send"><Send size={16} /></Button>
          </form>
        </Card>

        <div className="space-y-4 lg:col-span-5">
          <Card className="p-5" data-testid="config-review">
            <div className="mb-3 text-[length:var(--text-ui-md)] font-medium">Configuration review</div>
            <dl className="space-y-2.5">
              {rows.map(([k, v, need]) => (
                <div key={k} className="grid grid-cols-[110px_1fr] gap-3 text-[length:var(--text-ui-sm)]">
                  <dt className="text-subtle">{k}:</dt>
                  <dd className={cx("min-w-0 truncate", !v && "text-subtle", !v && need && missing.has(need) && "text-warning")}>{v ?? (need && missing.has(need) ? "needed" : "—")}</dd>
                </div>
              ))}
            </dl>
            {forecast && (
              <div className="mt-4 grid grid-cols-3 gap-3 border-t pt-4">
                <Mini label="Cost / month" v={<AnimatedNumber value={forecast.cost.month.p50} format={(x) => fmt.usd(x)} />} />
                <Mini label="Freshness P90" v={<AnimatedNumber value={forecast.freshness_min.p90} format={(x) => fmt.min(x)} />} />
                <Mini label="SLA met" v={<AnimatedNumber value={forecast.sla.attainment_pct} format={(x) => `${x.toFixed(1)}%`} />} />
              </div>
            )}
            <div className="mt-5 space-y-2">
              <Button variant="primary" className="w-full" disabled={!ready || submitting || me?.kiosk} loading={submitting} onClick={submit}
                title={me?.kiosk ? "Read-only mode" : !ready ? "Answer the open questions first" : undefined}>Confirm and submit</Button>
              <Button variant="outline" className="w-full" disabled={!reply} onClick={edit}>Edit configuration</Button>
            </div>
            <div className="mt-3 text-[length:var(--text-ui-xs)] text-subtle">Owner approval required before deployment. Chat submits for governed approval, never a direct deployment.</div>
          </Card>
          {reply && reply.checks.length > 0 && (
            <Card className="p-5">
              <div className="mb-1 text-[length:var(--text-ui-sm)] font-medium">Checks</div>
              {reply.checks.map((c) => <CheckRow key={c.key} c={c} />)}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Mini({ label, v }: { label: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.1em] text-subtle">{label}</div>
      <div className="mt-0.5 text-[length:var(--text-ui-md)] font-medium">{v}</div>
    </div>
  );
}

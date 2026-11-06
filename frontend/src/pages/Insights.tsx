import { motion } from "framer-motion";
import { ArrowDown, ArrowUp, Info, Loader2 } from "lucide-react";
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useBrand } from "@/brand/BrandContext";
import {
  AnimatedNumber, Badge, Card, ErrorState, Field, Input, PageHeader, Segmented, Select, Skeleton, SourcePill, Stat, fadeUp,
} from "@/components/ui";
import { ApiError, fmt, post, useApi } from "@/lib/api";
import type { Forecast, IngestionConfig, ModelCard, Pattern } from "@/lib/types";

type Benchmark = ModelCard["benchmarks"][number];

const PATTERNS: Pattern[] = ["cdc", "query", "federation", "saas", "files", "api", "stream", "community"];
const PATTERN_LABEL: Record<Pattern, string> = { cdc: "CDC", query: "Query-based", saas: "API", files: "Files", stream: "Stream", federation: "Federation", api: "REST API", community: "Community" };
const isPattern = (p: string): p is Pattern => (PATTERNS as string[]).includes(p);
const patternLabel = (p: string) => (isPattern(p) ? PATTERN_LABEL[p] : p);

const INTERVALS = ["5", "15", "30", "60", "240"] as const;
type IntervalOpt = (typeof INTERVALS)[number];
const INTERVAL_LABEL: Record<IntervalOpt, string> = { "5": "5 min", "15": "15 min", "30": "30 min", "60": "1 h", "240": "4 h" };

const pctOf = (rate: number) => (rate <= 1 ? rate * 100 : rate);
const secs = (s: number | null | undefined) => {
  if (s === null || s === undefined || Number.isNaN(s)) return "—";
  return `${Math.round(s).toLocaleString()} s`;
};
const dbu = (v: number | null | undefined) => {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v < 1 ? v.toFixed(3) : v.toFixed(2);
};
// The training job's method notes come from Python %-formatting; show a single percent sign.
const cleanNote = (s: string) => s.replace(/%%/g, "%");

function trainedLabel(iso: string | null) {
  if (!iso) return { value: "—", sub: "not trained yet" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { value: "—", sub: iso };
  return { value: d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }), sub: fmt.ago(iso) };
}

function HeaderStats({ m }: { m: ModelCard }) {
  const t = trainedLabel(m.trained_at);
  return (
    <Card as="section" aria-label="Model summary" className="p-5 md:p-6">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3 xl:grid-cols-[1.7fr_1.2fr_repeat(4,minmax(0,1fr))]">
        <Stat testId="model-version" label="Version"
          value={<span className="text-[length:var(--text-ui-md)]" title={m.version}>{m.version}</span>} />
        <Stat testId="model-trained" label="Trained" value={<span className="text-[length:var(--text-ui-md)]">{t.value}</span>} sub={t.sub} />
        <Stat testId="model-window" label="History window" value={`${fmt.int(m.window_days)} d`} sub="of Lakeflow Connect runs" />
        <Stat testId="model-pipelines" label="Pipelines" value={fmt.int(m.n_pipelines)} accent />
        <Stat testId="model-updates" label="Updates" value={fmt.int(m.n_updates)} />
        <Stat testId="model-workspaces" label="Workspaces" value={fmt.int(m.workspaces)} />
      </div>
    </Card>
  );
}

function Honesty({ m }: { m: ModelCard }) {
  return (
    <div role="note" className="flex items-start gap-3 rounded-lg border border-primary/30 bg-accent-soft/50 p-4 text-[length:var(--text-ui-sm)]">
      <Info size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
      <p className="leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Trained on real Lakeflow Connect history in this account</span>:{" "}
        {fmt.int(m.n_pipelines)} pipelines and {fmt.int(m.n_updates)} updates across {fmt.int(m.workspaces)} workspaces over the last{" "}
        {fmt.int(m.window_days)} days, read from system tables. Connector families are inferred from pipeline names, because system tables
        don't record the source. Families with only a few pipelines are shrunk toward their ingestion pattern (and patterns toward the
        overall model), so thin history borrows strength instead of overfitting. Costs are list prices, before the free tier.
      </p>
    </div>
  );
}

function Metrics({ m }: { m: ModelCard }) {
  if (!m.metrics?.length) return null;
  return (
    <section aria-labelledby="model-metrics-title">
      <h2 id="model-metrics-title" className="mb-3 text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.14em] text-subtle">
        Held-out accuracy
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {m.metrics.map((x, i) => (
          <motion.div key={x.name} initial={fadeUp.initial} animate={fadeUp.animate} transition={{ ...fadeUp.transition, delay: i * 0.05 }}>
            <Card className="h-full p-4" data-testid="model-metric">
              <div className="text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.12em] text-subtle">{x.name}</div>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <span className="num text-[length:var(--text-ui-xl)] font-medium">
                  {Number.isFinite(x.value) ? x.value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : "—"}
                </span>
                <span className="text-[length:var(--text-ui-sm)] text-muted-foreground">{x.unit}</span>
              </div>
              {x.note && <p className="mt-1.5 text-[length:var(--text-ui-xs)] leading-relaxed text-muted-foreground">{cleanNote(x.note)}</p>}
            </Card>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

function Method({ m }: { m: ModelCard }) {
  if (!m.method?.length) return null;
  return (
    <Card as="section" aria-labelledby="model-method-title" className="p-5 md:p-6">
      <h2 id="model-method-title" className="mb-3 text-[length:var(--text-ui-md)] font-medium">Method</h2>
      <ol className="grid gap-x-8 gap-y-2.5 md:grid-cols-2">
        {m.method.map((s, i) => (
          <li key={i} className="flex gap-3 text-[length:var(--text-ui-sm)]">
            <span className="num w-5 shrink-0 text-right text-primary">{i + 1}</span>
            <span className="text-muted-foreground">{cleanNote(s)}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function UpdateChart({ rows }: { rows: Benchmark[] }) {
  const data = useMemo(() => {
    const count = new Map<string, number>();
    rows.forEach((b) => count.set(b.family, (count.get(b.family) ?? 0) + 1));
    return [...rows]
      .sort((a, b) => b.upd_p90_s - a.upd_p90_s)
      .map((b) => ({
        label: (count.get(b.family) ?? 0) > 1 ? `${b.family} · ${patternLabel(b.pattern)}` : b.family,
        p50: Math.round(b.upd_p50_s),
        p90: Math.round(b.upd_p90_s),
      }));
  }, [rows]);
  const height = Math.max(220, data.length * 30 + 60);
  const axis = "hsl(var(--muted-foreground))";
  return (
    <Card as="section" aria-labelledby="model-chart-title" className="p-5 md:p-6">
      <h2 id="model-chart-title" className="text-[length:var(--text-ui-md)] font-medium">Update duration by connector family</h2>
      <p className="mt-0.5 text-[length:var(--text-ui-sm)] text-muted-foreground">P50 and P90 seconds per pipeline update; the table below has the numbers.</p>
      <figure className="mt-4 text-[length:var(--text-ui-xs)]" aria-label="Bar chart of P50 and P90 update seconds by connector family">
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }} barGap={2} barCategoryGap="26%">
            <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
            <XAxis type="number" unit=" s" tick={{ fill: axis }} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
            <YAxis type="category" dataKey="label" width={150} tick={{ fill: axis }} tickLine={false} axisLine={false} />
            <Tooltip
              cursor={{ fill: "hsl(var(--muted) / 0.6)" }}
              contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--foreground))" }}
              labelStyle={{ color: "hsl(var(--foreground))", fontWeight: 500 }}
              itemStyle={{ color: "hsl(var(--muted-foreground))" }}
              formatter={(v) => `${Number(v).toLocaleString()} s`}
            />
            <Legend formatter={(value) => <span style={{ color: axis }}>{String(value)}</span>} />
            <Bar dataKey="p50" name="P50" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
            <Bar dataKey="p90" name="P90" fill="hsl(var(--plum))" stroke="hsl(var(--primary))" strokeOpacity={0.55} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </figure>
    </Card>
  );
}

function Benchmarks({ rows }: { rows: Benchmark[] }) {
  const [dir, setDir] = useState<"desc" | "asc">("desc");
  const sorted = useMemo(() => [...rows].sort((a, b) =>
    (dir === "desc" ? b.n_pipelines - a.n_pipelines : a.n_pipelines - b.n_pipelines) || a.family.localeCompare(b.family)), [rows, dir]);
  const th = "px-3 py-2.5 text-left text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.1em] text-subtle";
  const td = "num px-3 py-2.5 text-right text-[length:var(--text-ui-sm)]";
  return (
    <Card as="section" aria-labelledby="model-bench-title" className="p-5 md:p-6">
      <h2 id="model-bench-title" className="text-[length:var(--text-ui-md)] font-medium">Benchmarks by family</h2>
      <p className="mt-0.5 text-[length:var(--text-ui-sm)] text-muted-foreground">What the model learned for each connector family and ingestion pattern.</p>
      <div className="scroll-y mt-4 overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr className="border-b">
              <th scope="col" className={th}>Family</th>
              <th scope="col" className={th}>Pattern</th>
              <th scope="col" className={`${th} text-right`} aria-sort={dir === "desc" ? "descending" : "ascending"}>
                <button type="button" onClick={() => setDir(dir === "desc" ? "asc" : "desc")}
                  className="inline-flex items-center gap-1 rounded-sm uppercase tracking-[0.1em] hover:text-foreground"
                  aria-label={`Pipelines, sorted ${dir === "desc" ? "most first" : "fewest first"}; activate to reverse`}>
                  Pipelines {dir === "desc" ? <ArrowDown size={12} aria-hidden /> : <ArrowUp size={12} aria-hidden />}
                </button>
              </th>
              <th scope="col" className={`${th} text-right`}>Update P50</th>
              <th scope="col" className={`${th} text-right`}>Update P90</th>
              <th scope="col" className={`${th} text-right`}>Success</th>
              <th scope="col" className={`${th} text-right`}>DBU / update</th>
              <th scope="col" className={`${th} text-right`}>Gateway DBU / h</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((b) => (
              <tr key={`${b.family}|${b.pattern}`} className="border-b last:border-0 hover:bg-muted/50" data-testid="bench-row">
                <th scope="row" className="px-3 py-2.5 text-left text-[length:var(--text-ui-sm)] font-medium">{b.family}</th>
                <td className="px-3 py-2.5"><Badge tone="primary">{patternLabel(b.pattern)}</Badge></td>
                <td className={td}>{fmt.int(b.n_pipelines)}</td>
                <td className={td}>{secs(b.upd_p50_s)}</td>
                <td className={td}>{secs(b.upd_p90_s)}</td>
                <td className={td}>{fmt.pct(pctOf(b.success_rate))}</td>
                <td className={td}>{dbu(b.dbu_per_update)}</td>
                <td className={td}>{b.gateway_dbu_hour == null ? "—" : dbu(b.gateway_dbu_hour)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function whatIfConfig(family: string, pattern: Pattern, interval: number, tables: number, sla: number, owner: string): IngestionConfig {
  return {
    title: `What-if: ${family}`,
    source: { connector: family, pattern, connection: null },
    objects: Array.from({ length: tables }, (_, i) => ({ schema: "what_if", table: `table_${i + 1}`, primary_keys: [] })),
    schema: { scd_type: "SCD_TYPE_1", evolution: "add_new_columns" },
    destination: { environment: "dev", catalog: "", schema: "" },
    schedule: { mode: "interval", interval_minutes: interval, sla_minutes: sla },
    ownership: { owner, classification: "internal", domain: "", cost_center: "", justification: "What-if estimate on the forecast model page" },
    operations: { retries: 3, recovery: "auto_retry_then_ticket", reconciliation: true, alert_emails: [] },
  };
}

function Result({ label, testId, children, sub }: { label: string; testId: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div data-testid={testId} className="min-w-0 rounded-md border bg-elevated p-3">
      <div className="text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.12em] text-subtle">{label}</div>
      <div className="mt-1 truncate text-[length:var(--text-ui-lg)] font-medium">{children}</div>
      {sub && <div className="mt-0.5 truncate text-[length:var(--text-ui-xs)] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function WhatIf({ rows }: { rows: Benchmark[] }) {
  const { me } = useBrand();
  const families = useMemo(() => {
    const total = new Map<string, number>();
    rows.forEach((b) => total.set(b.family, (total.get(b.family) ?? 0) + b.n_pipelines));
    return [...total.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f, n]) => ({ family: f, n }));
  }, [rows]);
  const allPatterns = useMemo(() => {
    const seen = new Set(rows.map((b) => b.pattern).filter(isPattern));
    return PATTERNS.filter((p) => seen.has(p));
  }, [rows]);
  const familyPatterns = (f: string) => rows.filter((b) => b.family === f && isPattern(b.pattern))
    .sort((a, b) => b.n_pipelines - a.n_pipelines).map((b) => b.pattern as Pattern);

  const [family, setFamily] = useState<string>(families[0]?.family ?? "");
  const [pattern, setPattern] = useState<Pattern>(() => familyPatterns(families[0]?.family ?? "")[0] ?? allPatterns[0] ?? "cdc");
  const [interval, setIntervalOpt] = useState<IntervalOpt>("15");
  const [tables, setTables] = useState("5");
  const [sla, setSla] = useState("30");
  const [fc, setFc] = useState<Forecast | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);

  const nTables = Number(tables);
  const nSla = Number(sla);
  const tablesErr = tables.trim() !== "" && Number.isInteger(nTables) && nTables >= 1 && nTables <= 500 ? null : "Enter 1 to 500 tables";
  const slaErr = sla.trim() !== "" && Number.isFinite(nSla) && nSla >= 1 && nSla <= 10080 ? null : "Enter 1 to 10,080 minutes";
  const owner = me?.email ?? "";

  useEffect(() => {
    if (!family || tablesErr || slaErr) return;
    const id = ++seq.current;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const f = await post<Forecast>("/api/forecast", { config: whatIfConfig(family, pattern, Number(interval), nTables, nSla, owner) });
        if (id === seq.current) { setFc(f); setErr(null); }
      } catch (e) {
        if (id === seq.current) setErr(e instanceof ApiError ? e.detail : String(e));
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [family, pattern, interval, nTables, nSla, tablesErr, slaErr, owner]);

  const onFamily = (f: string) => {
    setFamily(f);
    const fp = familyPatterns(f);
    if (fp.length && !fp.includes(pattern)) setPattern(fp[0]);
  };

  if (!families.length) return null;
  const fp = familyPatterns(family);
  const basis = fc?.basis;

  return (
    <Card as="section" aria-labelledby="whatif-title" className="p-5 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="whatif-title" className="text-[length:var(--text-ui-md)] font-medium">What-if</h2>
          <p className="mt-0.5 text-[length:var(--text-ui-sm)] text-muted-foreground">Try a shape of request and see what the model predicts.</p>
        </div>
        <span aria-live="polite" className="inline-flex h-6 items-center gap-1.5 text-[length:var(--text-ui-xs)] text-muted-foreground">
          {busy && <><Loader2 size={13} className="animate-spin" aria-hidden /> Recalculating</>}
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Connector family">
          <Select aria-label="Connector family" value={family} onChange={(e) => onFamily(e.target.value)}
            options={families.map((f) => ({ value: f.family, label: `${f.family} (${f.n} ${f.n === 1 ? "pipeline" : "pipelines"})` }))} />
        </Field>
        <div>
          <div className="mb-1.5 text-[length:var(--text-ui-sm)] font-medium text-muted-foreground">Pattern</div>
          <Segmented<Pattern> ariaLabel="Pattern" value={pattern} onChange={setPattern}
            options={allPatterns.map((p) => ({ value: p, label: PATTERN_LABEL[p] }))} />
          {!fp.includes(pattern) && (
            <div className="mt-1 text-[length:var(--text-ui-xs)] text-subtle">No {family} history for this pattern: the pattern-level model answers.</div>
          )}
        </div>
        <div className="sm:col-span-2">
          <div className="mb-1.5 text-[length:var(--text-ui-sm)] font-medium text-muted-foreground">Run every</div>
          <Segmented<IntervalOpt> ariaLabel="Run every" value={interval} onChange={setIntervalOpt}
            options={INTERVALS.map((v) => ({ value: v, label: INTERVAL_LABEL[v] }))} />
        </div>
        <Field label="Tables" error={tablesErr}>
          <Input aria-label="Tables" type="number" inputMode="numeric" min={1} max={500} value={tables} onChange={(e) => setTables(e.target.value)} />
        </Field>
        <Field label="SLA (minutes)" error={slaErr}>
          <Input aria-label="SLA minutes" type="number" inputMode="numeric" min={1} max={10080} value={sla} onChange={(e) => setSla(e.target.value)} />
        </Field>
      </div>

      {err && <div className="mt-4"><ErrorState error={err} /></div>}

      {fc ? (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, ease: "easeInOut" }} className="mt-5">
          <div className="grid grid-cols-2 gap-3">
            <Result label="Cost / month" testId="whatif-cost" sub={<>P90 <AnimatedNumber value={fc.cost.month.p90} format={(v) => fmt.usd(v)} /> · list price</>}>
              <AnimatedNumber value={fc.cost.month.p50} format={(v) => fmt.usd(v)} />
            </Result>
            <Result label="Freshness" testId="whatif-freshness" sub={<>P90 <AnimatedNumber value={fc.freshness_min.p90} format={(v) => fmt.min(v)} /></>}>
              <AnimatedNumber value={fc.freshness_min.p50} format={(v) => fmt.min(v)} />
            </Result>
            <Result label="SLA attainment" testId="whatif-sla" sub={`within ${fmt.min(fc.sla.target_min)}`}>
              <AnimatedNumber value={fc.sla.attainment_pct} format={(v) => fmt.pct(v)} />
            </Result>
            <Result label="First data" testId="whatif-first" sub={<>P90 <AnimatedNumber value={fc.first_data_min.p90} format={(v) => fmt.min(v)} /></>}>
              <AnimatedNumber value={fc.first_data_min.p50} format={(v) => fmt.min(v)} />
            </Result>
          </div>
          {basis && (
            <p className="mt-3 text-[length:var(--text-ui-xs)] text-muted-foreground" data-testid="whatif-basis">
              Based on {fmt.int(basis.n_pipelines)} {basis.match === "family" ? `${basis.family} ` : ""}pipelines
              {basis.match !== "family" ? ` (${basis.match}-level model)` : ""}, {fmt.int(basis.window_days)} days · {fc.confidence} confidence
            </p>
          )}
        </motion.div>
      ) : !err && (
        <div className="mt-5 grid grid-cols-2 gap-3" aria-hidden>
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[74px]" />)}
        </div>
      )}
    </Card>
  );
}

export default function Insights() {
  const { data, error, loading, reload } = useApi<ModelCard>("/api/forecast/model");
  const rows = data && Array.isArray(data.benchmarks) ? data.benchmarks : [];
  return (
    <div>
      <PageHeader eyebrow="Operate" title="Forecast model"
        subtitle="How the service predicts monthly cost, time to first data, freshness and SLA attainment for every request, and how well those predictions hold up."
        actions={data ? <SourcePill source={data.source} reason={data.degraded_reason} /> : undefined} />
      {loading && !data ? (
        <div className="space-y-5" aria-busy="true" aria-label="Loading the forecast model">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
          <Skeleton className="h-72 w-full" />
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : data ? (
        <motion.div {...fadeUp} className="space-y-5">
          <HeaderStats m={data} />
          <Honesty m={data} />
          <Metrics m={data} />
          {rows.length > 0 && (
            <div className="grid gap-5 xl:grid-cols-12">
              <div className="xl:col-span-7"><UpdateChart rows={rows} /></div>
              <div className="xl:col-span-5"><WhatIf rows={rows} /></div>
            </div>
          )}
          {rows.length > 0 ? <Benchmarks rows={rows} /> : (
            <Card className="p-5 text-[length:var(--text-ui-sm)] text-muted-foreground">
              No connector-family benchmarks yet: the model answers every request from the overall history until a family has pipelines of its own.
            </Card>
          )}
          <Method m={data} />
        </motion.div>
      ) : null}
    </div>
  );
}

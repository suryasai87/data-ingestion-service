import { motion } from "framer-motion";
import {
  Activity, ArrowRight, Bot, ChevronRight, ClipboardCheck, Clock, FilePlus2, Inbox, PencilLine, Rocket, ShieldCheck, UserCheck, Zap,
} from "lucide-react";
import { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useBrand } from "@/brand/BrandContext";
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton, SourcePill, Stat, StatusBadge, fadeUp } from "@/components/ui";
import { fmt, useApi } from "@/lib/api";
import type { HomeStats, IngestRequest } from "@/lib/types";

/** Gradient on the product name inside the brand's hero title (falls back to the last word). */
function HeroTitle({ title, highlight }: { title: string; highlight: string }) {
  const at = highlight ? title.indexOf(highlight) : -1;
  if (at >= 0) {
    return <>{title.slice(0, at)}<span className="text-gradient">{highlight}</span>{title.slice(at + highlight.length)}</>;
  }
  const cut = title.lastIndexOf(" ");
  if (cut <= 0) return <span className="text-gradient">{title}</span>;
  return <>{title.slice(0, cut + 1)}<span className="text-gradient">{title.slice(cut + 1)}</span></>;
}

function Hero() {
  const { brand } = useBrand();
  const navigate = useNavigate();
  const proof: { icon: ReactNode; value: string; label: string }[] = [
    { icon: <Clock size={15} />, value: "< 1 day", label: `request to ${brand.destination_label}` },
    { icon: <Zap size={15} />, value: "15 min", label: "near-real-time latency" },
    { icon: <ShieldCheck size={15} />, value: "100%", label: "approved, reconciled and audited" },
  ];
  return (
    <motion.section {...fadeUp} aria-labelledby="home-hero-title"
      className="hero-aurora relative overflow-hidden rounded-lg border px-6 py-10 md:px-12 md:py-14">
      <div className="mb-3 text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.16em] text-primary">{brand.company}</div>
      <h1 id="home-hero-title" className="max-w-4xl text-[length:var(--text-ui-hero)] font-light leading-[1.08] tracking-[-0.025em]">
        <HeroTitle title={brand.hero_title} highlight={brand.product} />
      </h1>
      {brand.hero_subtitle && (
        <p className="mt-4 max-w-2xl text-[length:var(--text-ui-md)] leading-relaxed text-muted-foreground">{brand.hero_subtitle}</p>
      )}
      <div className="mt-7 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" icon={<FilePlus2 size={16} />} onClick={() => navigate("/new")}>New request</Button>
        <Button variant="outline" size="lg" icon={<Bot size={16} />} onClick={() => navigate("/assistant")}>Ask the assistant</Button>
      </div>
      <div className="mt-9">
        <div className="mb-2.5 text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.14em] text-subtle">Service targets</div>
        <ul className="flex flex-wrap gap-x-8 gap-y-3" aria-label="Service targets">
          {proof.map((p) => (
            <li key={p.value} className="flex items-center gap-2.5">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent-soft text-primary" aria-hidden>{p.icon}</span>
              <span className="text-[length:var(--text-ui-sm)]">
                <span className="num font-medium text-foreground">{p.value}</span>{" "}
                <span className="text-muted-foreground">{p.label}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </motion.section>
  );
}

function Kpis({ d }: { d: HomeStats }) {
  const { brand } = useBrand();
  return (
    <Card as="section" aria-labelledby="home-kpi-title" className="p-5 md:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 id="home-kpi-title" className="text-[length:var(--text-ui-md)] font-medium">Service at a glance</h2>
        <SourcePill source={d.source} reason={d.degraded_reason} />
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4 xl:grid-cols-7">
        <Stat testId="kpi-requests-open" label="Open requests" value={fmt.int(d.requests_open)} />
        <Stat testId="kpi-pipelines-live" label="Pipelines live" value={fmt.int(d.pipelines_live)} accent />
        <Stat testId="kpi-tables-live" label="Tables live" value={fmt.int(d.tables_live)} sub={`in ${brand.destination_label}`} />
        <Stat testId="kpi-median-to-live" label="Median to live"
          value={d.median_hours_to_live == null ? "—" : fmt.min(d.median_hours_to_live * 60)} sub="target < 1 day" />
        <Stat testId="kpi-sla" label="SLA attainment" value={fmt.pct(d.sla_attainment_pct)} />
        <Stat testId="kpi-cost" label="Cost this month" value={fmt.usd(d.cost_mtd_usd)} sub="month to date" />
        <Stat testId="kpi-forecast-accuracy" label="Accuracy" value={fmt.pct(d.forecast_accuracy_pct)} sub="forecast vs actual" />
      </div>
    </Card>
  );
}

function RequestRow({ r }: { r: IngestRequest }) {
  return (
    <li>
      <Link to={`/requests/${encodeURIComponent(r.id)}`}
        className="group flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md px-3 py-3 transition hover:bg-muted sm:flex-nowrap">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[length:var(--text-ui-base)] font-medium text-foreground">{r.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[length:var(--text-ui-xs)] text-muted-foreground">
            <span className="num">{r.connector}</span>
            <span aria-hidden>·</span>
            <span>{r.n_objects} {r.n_objects === 1 ? "table" : "tables"}</span>
            <span aria-hidden>·</span>
            <span className="num text-subtle">{r.id}</span>
          </div>
        </div>
        <Badge>{r.environment.toUpperCase()}</Badge>
        <StatusBadge status={r.status} />
        <span className="w-24 shrink-0 text-right text-[length:var(--text-ui-xs)] text-muted-foreground" title={r.updated_at}>
          {fmt.ago(r.updated_at)}
        </span>
        <ChevronRight size={15} className="shrink-0 text-subtle transition group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden />
      </Link>
    </li>
  );
}

function RecentRequests({ items }: { items: IngestRequest[] }) {
  const navigate = useNavigate();
  return (
    <Card as="section" aria-labelledby="home-recent-title" className="p-5 md:p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="home-recent-title" className="text-[length:var(--text-ui-md)] font-medium">Recent requests</h2>
        {items.length > 0 && (
          <Link to="/requests" className="inline-flex items-center gap-1 rounded-md text-[length:var(--text-ui-sm)] text-primary hover:underline">
            All requests <ArrowRight size={13} aria-hidden />
          </Link>
        )}
      </div>
      {items.length === 0 ? (
        <EmptyState icon={<Inbox size={22} />} title="No requests yet"
          body="Start a request with the guided form, or describe the data you need to the assistant. Either way it is validated and approved before anything runs."
          action={<Button variant="primary" icon={<FilePlus2 size={15} />} onClick={() => navigate("/new")}>New request</Button>} />
      ) : (
        <ul className="-mx-2 divide-y">
          {items.map((r) => <RequestRow key={r.id} r={r} />)}
        </ul>
      )}
    </Card>
  );
}

const FLOW: { label: string; detail: string; icon: ReactNode }[] = [
  { label: "Draft", detail: "guided form or assistant", icon: <PencilLine size={15} /> },
  { label: "Validate", detail: "access · schema · policy · dry run", icon: <ClipboardCheck size={15} /> },
  { label: "Approve", detail: "the data owner signs off", icon: <UserCheck size={15} /> },
  { label: "Deploy", detail: "Lakeflow Connect pipeline", icon: <Rocket size={15} /> },
  { label: "Monitor", detail: "reconcile · retry · tickets", icon: <Activity size={15} /> },
];

function FlowStrip() {
  return (
    <Card as="section" aria-labelledby="home-flow-title" className="p-5 md:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="home-flow-title" className="text-[length:var(--text-ui-md)] font-medium">How a request flows</h2>
        <Link to="/how-it-works" className="inline-flex items-center gap-1 rounded-md text-[length:var(--text-ui-sm)] text-primary hover:underline">
          See how it works <ArrowRight size={13} aria-hidden />
        </Link>
      </div>
      <ol className="grid grid-cols-1 gap-3 sm:grid-cols-5">
        {FLOW.map((s, i) => (
          <motion.li key={s.label} initial={fadeUp.initial} animate={fadeUp.animate}
            transition={{ ...fadeUp.transition, delay: 0.05 + i * 0.06 }}
            className="relative flex items-start gap-2.5 rounded-md border bg-elevated px-3 py-3">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent-soft text-primary" aria-hidden>{s.icon}</span>
            <span className="min-w-0">
              <span className="block text-[length:var(--text-ui-sm)] font-medium">
                <span className="num mr-1.5 text-subtle">{i + 1}</span>{s.label}
              </span>
              <span className="block text-[length:var(--text-ui-xs)] text-muted-foreground">{s.detail}</span>
            </span>
            {i < FLOW.length - 1 && (
              <ArrowRight size={13} aria-hidden
                className="absolute -right-[11px] top-1/2 hidden -translate-y-1/2 text-subtle sm:block" />
            )}
          </motion.li>
        ))}
      </ol>
    </Card>
  );
}

export default function Home() {
  const { data, error, loading, reload } = useApi<HomeStats>("/api/home");
  return (
    <div className="space-y-6">
      <Hero />
      {loading && !data ? (
        <div className="space-y-6" aria-busy="true" aria-label="Loading service overview">
          <Card className="p-6"><div className="grid grid-cols-2 gap-5 sm:grid-cols-4 xl:grid-cols-7">
            {Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
          </div></Card>
          <Card className="space-y-3 p-6">
            <Skeleton className="h-5 w-40" />
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </Card>
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : data ? (
        <motion.div {...fadeUp} className="space-y-6">
          <Kpis d={data} />
          <RecentRequests items={Array.isArray(data.recent) ? data.recent : []} />
        </motion.div>
      ) : null}
      <FlowStrip />
    </div>
  );
}

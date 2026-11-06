import { motion } from "framer-motion";
import {
  Bot, Cable, Database, ExternalLink, FileCheck2, FilePlus2, HeartPulse, LayoutDashboard, ShieldCheck, Sparkles, UserCheck,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useBrand } from "@/brand/BrandContext";
import FlowDiagram, { FlowEdge, FlowNode } from "@/components/FlowDiagram";
import { Button, Card, PageHeader, fadeUp } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { ResourceGroup } from "@/lib/types";

const INTAKE = "hsl(var(--primary))";
const GOVERN = "hsl(var(--warning))";
const RUNTIME = "hsl(var(--info))";
const OPERATE = "hsl(var(--success))";
const IC = { size: 15 };

const LANES: { key: string; label: string; color: string }[] = [
  { key: "A", label: "Intake", color: INTAKE },
  { key: "B", label: "Governance", color: GOVERN },
  { key: "C", label: "Runtime", color: RUNTIME },
  { key: "D", label: "Operate + AI", color: OPERATE },
];

function nodes(destination: string): FlowNode[] {
  const W = 220, H = 90;
  return [
    // Lane A: intake (two channels, one configuration)
    { id: "app", x: 20, y: 30, w: W, h: H, step: 1, title: "Self-service app", subtitle: "guided form · live forecast", icon: <LayoutDashboard {...IC} />, accent: INTAKE },
    { id: "chat", x: 20, y: 190, w: W, h: H, step: 2, title: "Conversational assistant", subtitle: "same fields · same checks", icon: <Bot {...IC} />, accent: INTAKE },
    { id: "config", x: 290, y: 110, w: W, h: H, step: 3, title: "Approved configuration", subtitle: "versioned · one spec for both channels", icon: <FileCheck2 {...IC} />, accent: INTAKE },
    // Lane B: governance
    { id: "validate", x: 580, y: 30, w: W, h: H, step: 4, title: "Validate", subtitle: "access · schema · policy · Lakeflow", icon: <ShieldCheck {...IC} />, accent: GOVERN },
    { id: "approve", x: 580, y: 190, w: W, h: H, step: 5, title: "Owner approval", subtitle: "independent for confidential", icon: <UserCheck {...IC} />, accent: GOVERN },
    // Lane C: runtime
    { id: "lfc", x: 870, y: 30, w: W, h: H, step: 6, title: "Lakeflow Connect", subtitle: "gateway · CDC / query-based / SaaS", icon: <Cable {...IC} />, accent: RUNTIME },
    { id: "dest", x: 870, y: 190, w: W, h: H, step: 7, title: destination, subtitle: "Unity Catalog", icon: <Database {...IC} />, accent: RUNTIME },
    // Lane D: operate + AI, feeding back into intake
    { id: "forecast", x: 290, y: 370, w: W, h: H, step: 9, title: "Forecast model", subtitle: "system tables → cost · time · SLA", icon: <Sparkles {...IC} />, accent: OPERATE },
    { id: "guardian", x: 870, y: 370, w: W, h: H, step: 8, title: "Guardian", subtitle: "reconcile · auto-retry · tickets", icon: <HeartPulse {...IC} />, accent: OPERATE },
  ];
}

const EDGES: FlowEdge[] = [
  { from: "app", to: "config", color: INTAKE, dots: 2 },
  { from: "chat", to: "config", color: INTAKE, dots: 2 },
  { from: "config", to: "validate", color: INTAKE, dots: 2, label: "submit" },
  { from: "validate", to: "approve", fromSide: "bottom", toSide: "top", color: GOVERN, dots: 2 },
  { from: "approve", to: "lfc", color: GOVERN, dots: 3, label: "deploy" },
  { from: "lfc", to: "dest", fromSide: "bottom", toSide: "top", color: RUNTIME, dots: 3, label: "CDC" },
  { from: "dest", to: "guardian", fromSide: "bottom", toSide: "top", color: OPERATE, dots: 2, label: "every update" },
  { from: "guardian", to: "forecast", fromSide: "left", toSide: "right", color: OPERATE, dots: 3, label: "run history" },
  { from: "forecast", to: "config", fromSide: "top", toSide: "bottom", color: OPERATE, dots: 3, dashed: true, label: "cost · time · SLA" },
];

function steps(destination: string): [string, string, string][] {
  return [
    ["1–3", "Ask once, in either channel",
      "Fill in the guided form or describe what you need to the assistant. Both produce the same versioned configuration, with a live forecast beside it."],
    ["4–5", "Governed before anything runs",
      "Every version is checked for source access, schema, policy and a Lakeflow validation run. The data owner approves; confidential and restricted data need an independent approver."],
    ["6–7", `Lakeflow Connect lands it in ${destination}`,
      `The approved configuration deploys the gateway (for CDC), the ingestion pipeline and its schedule. Tables land in ${destination} in Unity Catalog, governed from the first row.`],
    ["8", "Guardian keeps it healthy",
      `Every update is watched: source and ${destination} row counts are reconciled, failed updates retry automatically, and anything that doesn't heal opens a ticket.`],
    ["9", "The forecast learns from real history",
      "Cost, time to first data, freshness and SLA attainment are learned from Lakeflow Connect history in system tables, so every request shows what to expect before it is approved."],
  ];
}

const isWebUrl = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);

/** Deep links to the resources this deployment runs on. Renders nothing when the lookup fails or is empty. */
function WhereItRuns() {
  const { data } = useApi<{ groups: ResourceGroup[] }>("/api/platform/resources");
  const raw = data && Array.isArray(data.groups) ? data.groups : [];
  const groups = raw
    .map((g) => ({
      title: typeof g?.title === "string" ? g.title : "",
      items: (Array.isArray(g?.items) ? g.items : []).filter((it) => it && it.value != null && String(it.value) !== ""),
    }))
    .filter((g) => g.title && g.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <motion.section {...fadeUp} aria-labelledby="where-it-runs-title">
      <Card className="p-5 md:p-6">
        <h2 id="where-it-runs-title" className="text-[length:var(--text-ui-md)] font-medium">Where it runs</h2>
        <p className="mt-0.5 text-[length:var(--text-ui-sm)] text-muted-foreground">
          Deep links into this workspace: opening one uses your own permissions.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => (
            <div key={g.title} className="rounded-md border bg-elevated px-3.5 py-3">
              <div className="text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.12em] text-subtle">{g.title}</div>
              <ul className="mt-2 space-y-1.5">
                {g.items.map((it, i) => (
                  <li key={`${it.label}·${it.value}·${i}`} className="flex items-baseline justify-between gap-3 text-[length:var(--text-ui-sm)]">
                    <span className="shrink-0 text-muted-foreground">{it.label}</span>
                    {isWebUrl(it.url) ? (
                      <a href={it.url} target="_blank" rel="noreferrer" title={it.url}
                        className="inline-flex min-w-0 items-center gap-1 rounded-sm text-[length:var(--text-ui-xs)] text-primary hover:underline">
                        <span className="num truncate">{it.value}</span>
                        <ExternalLink size={11} className="shrink-0" aria-hidden />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    ) : (
                      <span className="num min-w-0 truncate text-[length:var(--text-ui-xs)] text-foreground" title={String(it.value)}>{it.value}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </motion.section>
  );
}

export default function HowItWorks() {
  const { brand } = useBrand();
  const navigate = useNavigate();
  const dest = brand.destination_label;
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Overview" title="How it works"
        subtitle={`One governed path from a business request to a monitored table in ${dest}. Both channels produce the same configuration and go through the same checks and the same approval.`}
        actions={<>
          <Button variant="outline" icon={<Bot size={15} />} onClick={() => navigate("/assistant")}>Ask the assistant</Button>
          <Button variant="primary" icon={<FilePlus2 size={15} />} onClick={() => navigate("/new")}>New request</Button>
        </>} />

      <motion.div {...fadeUp}>
        <Card className="p-4 md:p-5">
          <ul aria-label="Lanes" className="mb-3 flex flex-wrap gap-x-5 gap-y-2 px-1">
            {LANES.map((l) => (
              <li key={l.key} className="flex items-center gap-2 text-[length:var(--text-ui-xs)] text-muted-foreground">
                <span className="h-2 w-2 rounded-full" style={{ background: l.color }} aria-hidden />
                <span className="num text-subtle">{l.key}</span>
                <span className="font-medium text-foreground">{l.label}</span>
              </li>
            ))}
          </ul>
          <figure>
            <figcaption className="sr-only">
              Request flow: the self-service app or the assistant produce a versioned configuration; it is validated and approved by the
              data owner; Lakeflow Connect lands the data in {dest}; Guardian watches every update and the forecast model learns from run
              history and feeds cost, time and SLA predictions back into intake.
            </figcaption>
            <FlowDiagram nodes={nodes(dest)} edges={EDGES} width={1110} height={480} />
          </figure>
        </Card>
      </motion.div>

      <section aria-labelledby="hiw-steps-title">
        <h2 id="hiw-steps-title" className="mb-3 text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.14em] text-subtle">Steps</h2>
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {steps(dest).map(([n, t, d], i) => (
            <motion.li key={n} initial={fadeUp.initial} animate={fadeUp.animate} transition={{ ...fadeUp.transition, delay: 0.1 + i * 0.06 }}>
              <Card className="h-full p-4">
                <div className="num text-[length:var(--text-ui-xs)] text-primary">{n}</div>
                <div className="mt-1 text-[length:var(--text-ui-base)] font-medium">{t}</div>
                <p className="mt-1.5 text-[length:var(--text-ui-sm)] leading-relaxed text-muted-foreground">{d}</p>
              </Card>
            </motion.li>
          ))}
        </ol>
      </section>

      <WhereItRuns />
    </div>
  );
}

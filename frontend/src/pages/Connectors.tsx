import { AnimatePresence, motion } from "framer-motion";
import { Puzzle, Search, Sparkles, X } from "lucide-react";
import { ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBrand } from "@/brand/BrandContext";
import {
  Badge, Button, EmptyState, ErrorState, Input, PageHeader, Segmented, Skeleton, SourcePill, Toggle, Tone, cx, fadeUp,
} from "@/components/ui";
import { ApiError, fmt, put, useApi } from "@/lib/api";
import type { Category, Connector, Pattern, Tier } from "@/lib/types";

interface ConnectorList { source: Tier; degraded_reason?: string | null; items: Connector[] }

const CATEGORIES: { key: Category; label: string }[] = [
  { key: "database", label: "Databases" },
  { key: "warehouse", label: "Warehouses & federation" },
  { key: "saas", label: "SaaS applications" },
  { key: "files", label: "Files" },
  { key: "api", label: "REST APIs" },
  { key: "streaming", label: "Streaming" },
];
const PATTERN_LABEL: Record<Pattern, string> = { cdc: "CDC", query: "Query-based", saas: "API", files: "Files", stream: "Stream", federation: "Federation", api: "REST API", community: "Community" };
const STATUS_META: Record<Connector["status"], { label: string; tone: Tone }> = {
  supported: { label: "Supported", tone: "success" },
  preview: { label: "Preview", tone: "info" },
  extension: { label: "Needs extension", tone: "warning" },
};
type StatusFilter = "all" | Connector["status"];

function matches(c: Connector, q: string) {
  if (!q) return true;
  const hay = [c.name, c.id, c.description, c.connection_type ?? "", ...c.patterns.map((p) => PATTERN_LABEL[p] ?? p)].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-[length:var(--text-ui-xs)] text-muted-foreground">{children}</span>
  );
}

function Tile({ c, admin, kiosk, saving, error, onToggle }: {
  c: Connector; admin: boolean; kiosk: boolean; saving: boolean; error: string | null; onToggle: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const st = STATUS_META[c.status] ?? { label: c.status, tone: "neutral" as Tone };
  const cap = c.capabilities;
  return (
    <motion.article layout="position" initial={fadeUp.initial} animate={fadeUp.animate} exit={{ opacity: 0 }} transition={fadeUp.transition}
      data-testid={`connector-${c.id}`} aria-label={c.name}
      className={cx("flex h-full flex-col rounded-lg border bg-card p-4 transition", !c.enabled && "border-dashed bg-card/60")}>
      <div className={cx("flex-1", !c.enabled && "opacity-60 grayscale")}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-[length:var(--text-ui-md)] font-medium leading-tight">{c.name}</h3>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            {!c.enabled && <Badge>Disabled</Badge>}
            <Badge tone={st.tone} dot>{st.label}</Badge>
          </div>
        </div>
        <p className="mt-1.5 text-[length:var(--text-ui-sm)] leading-relaxed text-muted-foreground">{c.description}</p>
        {c.patterns.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Ingestion patterns">
            {c.patterns.map((p, i) => (
              <Badge key={p} tone="primary">
                {PATTERN_LABEL[p] ?? p}{i === 0 && c.patterns.length > 1 ? <span className="sr-only"> (default)</span> : null}
              </Badge>
            ))}
          </div>
        )}
        {cap && (
          <div className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Capabilities">
            {cap.hard_deletes && <Chip>Hard deletes</Chip>}
            {cap.scd2 && <Chip>SCD type 2</Chip>}
            {cap.min_interval_minutes > 0 && <Chip>Min interval {fmt.min(cap.min_interval_minutes)}</Chip>}
            {cap.needs_gateway && <Chip>Ingestion gateway</Chip>}
          </div>
        )}
        {(c.history_pipelines ?? 0) > 0 && (
          <div className="mt-3 inline-flex items-center gap-1.5 text-[length:var(--text-ui-xs)] text-muted-foreground">
            <Sparkles size={12} className="text-primary" aria-hidden />
            Forecast learned from {fmt.int(c.history_pipelines)} {c.history_pipelines === 1 ? "pipeline" : "pipelines"}
          </div>
        )}
        {c.status === "extension" && (
          <div className="mt-3 rounded-md border border-warning/30 bg-warning/8 p-3">
            <p className="text-[length:var(--text-ui-xs)] text-muted-foreground">
              The platform team adds a reusable extension when a new pattern needs support.
            </p>
            <Button size="sm" variant="outline" className="mt-2" icon={<Puzzle size={13} />}
              onClick={() => navigate(`/assistant?ask=${encodeURIComponent(c.name)}`)}>
              Request extension
            </Button>
          </div>
        )}
      </div>
      {admin && (
        <div className="mt-4 border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-ui-xs)] text-muted-foreground">{c.enabled ? "Offered in new requests" : "Hidden from new requests"}</span>
            <Toggle checked={c.enabled} onChange={onToggle} disabled={saving || kiosk} label={`Offer ${c.name} in new requests`} />
          </div>
          {error && <div role="alert" className="mt-1.5 text-[length:var(--text-ui-xs)] text-destructive">Couldn't save: {error}</div>}
        </div>
      )}
    </motion.article>
  );
}

export default function Connectors() {
  const { me } = useBrand();
  const { data, error, loading, reload, setData } = useApi<ConnectorList>("/api/connectors");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const admin = !!me?.is_admin;
  const items = useMemo(() => (data && Array.isArray(data.items) ? data.items : []), [data]);

  const counts = useMemo(() => {
    const c = { all: items.length, supported: 0, preview: 0, extension: 0 } as Record<StatusFilter, number>;
    items.forEach((i) => { if (i.status in c) c[i.status] += 1; });
    return c;
  }, [items]);

  const visible = items.filter((c) => (status === "all" || c.status === status) && matches(c, q.trim()));
  const known = new Set(CATEGORIES.map((g) => g.key));
  const groups = [
    ...CATEGORIES.map((g) => ({ ...g, items: visible.filter((c) => c.category === g.key) })),
    { key: "other", label: "Other", items: visible.filter((c) => !known.has(c.category)) },
  ].filter((g) => g.items.length > 0);

  const setEnabled = (id: string, enabled: boolean) =>
    setData((d) => d && { ...d, items: d.items.map((c) => (c.id === id ? { ...c, enabled } : c)) });

  async function toggle(c: Connector, next: boolean) {
    const prev = c.enabled;
    setEnabled(c.id, next);
    setSaving((s) => ({ ...s, [c.id]: true }));
    setErrors((e) => ({ ...e, [c.id]: null }));
    try {
      const saved = await put<Connector>(`/api/connectors/${encodeURIComponent(c.id)}`, { enabled: next });
      if (saved && typeof saved === "object" && saved.id === c.id) {
        setData((d) => d && { ...d, items: d.items.map((x) => (x.id === c.id ? { ...x, ...saved } : x)) });
      }
    } catch (e) {
      setEnabled(c.id, prev);
      setErrors((er) => ({ ...er, [c.id]: e instanceof ApiError ? e.detail : String(e) }));
    } finally {
      setSaving((s) => ({ ...s, [c.id]: false }));
    }
  }

  const filtered = q.trim() !== "" || status !== "all";
  return (
    <div>
      <PageHeader eyebrow="Operate" title="Connectors"
        subtitle="What the service can ingest today. Every connector goes through the same request, validation, approval and monitoring."
        actions={data ? <SourcePill source={data.source} reason={data.degraded_reason} /> : undefined} />

      {loading && !data ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading connectors">
          <Skeleton className="h-10 w-full max-w-xl" />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44" />)}</div>
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : data && items.length === 0 ? (
        <EmptyState icon={<Puzzle size={22} />} title="No connectors are available yet"
          body="The platform team publishes connectors here as they are enabled for this service. Ask the assistant if you need a source that isn't listed." />
      ) : data ? (
        <motion.div {...fadeUp} className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-sm">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
              <Input type="search" aria-label="Search connectors" placeholder="Search connectors" value={q}
                onChange={(e) => setQ(e.target.value)} className="w-full pl-9" />
            </div>
            <Segmented<StatusFilter> ariaLabel="Filter by status" value={status} onChange={setStatus} options={[
              { value: "all", label: `All ${counts.all}` },
              { value: "supported", label: `Supported ${counts.supported}` },
              { value: "preview", label: `Preview ${counts.preview}` },
              { value: "extension", label: `Needs extension ${counts.extension}` },
            ]} />
          </div>

          {groups.length === 0 ? (
            <EmptyState icon={<Search size={22} />} title="No connectors match"
              body="Try another name or pattern, or clear the filters."
              action={<Button variant="secondary" icon={<X size={14} />} onClick={() => { setQ(""); setStatus("all"); }}>Clear filters</Button>} />
          ) : groups.map((g) => (
            <section key={g.key} aria-labelledby={`cat-${g.key}`}>
              <h2 id={`cat-${g.key}`} className="mb-3 flex items-baseline gap-2 text-[length:var(--text-ui-md)] font-medium">
                {g.label} <span className="num text-[length:var(--text-ui-xs)] text-subtle">{g.items.length}</span>
              </h2>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <AnimatePresence initial={false}>
                  {g.items.map((c) => (
                    <Tile key={c.id} c={c} admin={admin} kiosk={!!me?.kiosk} saving={!!saving[c.id]} error={errors[c.id] ?? null}
                      onToggle={(v) => toggle(c, v)} />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          ))}
          {filtered && groups.length > 0 && (
            <div className="text-[length:var(--text-ui-xs)] text-subtle">Showing {visible.length} of {items.length} connectors.</div>
          )}
        </motion.div>
      ) : null}
    </div>
  );
}


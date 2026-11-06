import { motion } from "framer-motion";
import { FilePlus2, Inbox, Search, SearchX } from "lucide-react";
import { ReactNode, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useBrand } from "@/brand/BrandContext";
import {
  Badge, Button, Card, EmptyState, ErrorState, Input, PageHeader, Segmented, Select, Skeleton, SourcePill,
  STATUS_META, StatusBadge, fadeUp,
} from "@/components/ui";
import { fmt, useApi } from "@/lib/api";
import type { IngestRequest, Pattern, RequestStatus, Sourced } from "@/lib/types";

type Scope = "mine" | "approvals" | "all";
interface RequestList extends Sourced { items: IngestRequest[] }

const PATTERN_LABEL: Record<Pattern, string> = { cdc: "CDC", query: "Query-based", saas: "SaaS", files: "Files", stream: "Streaming", federation: "Federation", api: "REST API", community: "Community" };
const STATUSES = Object.keys(STATUS_META) as RequestStatus[];
const COLUMNS: { label: string; align?: "right" }[] = [
  { label: "Request" }, { label: "Title" }, { label: "Status" }, { label: "Source" }, { label: "Env" }, { label: "Owner" },
  { label: "Objects", align: "right" }, { label: "Forecast / mo", align: "right" }, { label: "Updated", align: "right" },
];

export default function Requests() {
  const { me, brand } = useBrand();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const canApprove = !!(me?.is_approver || me?.is_admin);
  const isAdmin = !!me?.is_admin;
  const wanted = params.get("scope");
  const scope: Scope = wanted === "approvals" && canApprove ? "approvals" : wanted === "all" && isAdmin ? "all" : "mine";
  const [status, setStatus] = useState<RequestStatus | "">("");
  const [q, setQ] = useState("");

  const list = useApi<RequestList>(`/api/requests?scope=${scope}`);
  const approvals = useApi<RequestList>(canApprove ? "/api/requests?scope=approvals" : null);
  const pending = approvals.data?.items.filter((r) => r.status === "pending_approval").length ?? 0;

  const items = useMemo(
    () => [...(list.data?.items ?? [])].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    [list.data],
  );
  const counts = useMemo(() => {
    const c: Partial<Record<RequestStatus, number>> = {};
    for (const r of items) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [items]);
  const needle = q.trim().toLowerCase();
  const shown = items.filter((r) => (!status || r.status === status)
    && (!needle || [r.title, r.id, r.connector].some((s) => (s ?? "").toLowerCase().includes(needle))));
  const filtered = !!status || !!needle;

  const tabs: { value: Scope; label: ReactNode }[] = [{ value: "mine", label: "Mine" }];
  if (canApprove) {
    tabs.push({
      value: "approvals",
      label: (
        <span className="inline-flex items-center gap-1.5">
          Approvals
          {pending > 0 && (
            <Badge tone="warning" className="px-1.5 py-0">
              <span className="num">{pending}</span><span className="sr-only"> pending</span>
            </Badge>
          )}
        </span>
      ),
    });
  }
  if (isAdmin) tabs.push({ value: "all", label: "All" });

  const setScope = (s: Scope) => {
    const next = new URLSearchParams(params);
    if (s === "mine") next.delete("scope"); else next.set("scope", s);
    setParams(next, { replace: true });
  };

  const dest = brand.destination_label;
  const empty: Record<Scope, { title: string; body: string }> = {
    mine: { title: "You haven't requested any ingestion yet", body: `Start a request to land source tables in ${dest}. It is validated, approved by the data owner and deployed for you.` },
    approvals: { title: "Nothing is waiting for your approval", body: "Requests for data you own appear here as soon as they are submitted." },
    all: { title: "No requests yet", body: `Requests from every team appear here once someone asks for data in ${dest}.` },
  };

  return (
    <motion.div {...fadeUp}>
      <PageHeader
        eyebrow="Request"
        title="Requests"
        subtitle={`Every ingestion request into ${dest}, where it is in its lifecycle and what it is forecast to cost.`}
        actions={<>
          {!list.loading && <SourcePill source={list.data?.source} reason={list.data?.degraded_reason} />}
          <Button variant="primary" icon={<FilePlus2 size={15} />} onClick={() => nav("/new")}>New request</Button>
        </>}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented ariaLabel="Request scope" value={scope} onChange={setScope} options={tabs} />
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <Input type="search" aria-label="Search requests" placeholder="Search title, id or connector" value={q}
              onChange={(e) => setQ(e.target.value)} className="w-64 pl-8" />
          </div>
          <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as RequestStatus | "")}
            className="w-52"
            options={[{ value: "", label: `All statuses (${items.length})` },
              ...STATUSES.map((s) => ({ value: s, label: `${STATUS_META[s].label} (${counts[s] ?? 0})` }))]} />
        </div>
      </div>

      {list.loading ? (
        <Card className="space-y-3 p-5" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
        </Card>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Inbox size={28} />} title={empty[scope].title} body={empty[scope].body}
          action={scope === "mine" ? <Button variant="primary" icon={<FilePlus2 size={15} />} onClick={() => nav("/new")}>New request</Button> : undefined} />
      ) : shown.length === 0 ? (
        <EmptyState icon={<SearchX size={28} />} title="No requests match these filters" body="Try another search term or status."
          action={filtered ? <Button onClick={() => { setQ(""); setStatus(""); }}>Clear filters</Button> : undefined} />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-left text-[length:var(--text-ui-sm)]">
              <thead className="text-[length:var(--text-ui-xs)] uppercase tracking-[0.1em] text-subtle">
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.label} scope="col" className={`px-4 py-3 font-medium ${c.align === "right" ? "text-right" : ""}`}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} data-testid={`request-row-${r.id}`} onClick={() => nav(`/requests/${encodeURIComponent(r.id)}`)}
                    className="cursor-pointer border-t transition-colors hover:bg-muted/50">
                    <td className="num whitespace-nowrap px-4 py-3 text-muted-foreground">{r.id}</td>
                    <td className="max-w-[320px] px-4 py-3">
                      <Link to={`/requests/${encodeURIComponent(r.id)}`} onClick={(e) => e.stopPropagation()}
                        className="block truncate font-medium text-foreground hover:text-primary">{r.title}</Link>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="text-foreground">{r.connector}</span>
                      <span className="text-subtle"> · {PATTERN_LABEL[r.pattern] ?? r.pattern}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={r.environment === "prod" ? "primary" : "neutral"} className="uppercase">{r.environment}</Badge>
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-3 text-muted-foreground" title={r.owner}>{r.owner}</td>
                    <td className="num px-4 py-3 text-right">{r.n_objects}</td>
                    <td className="num px-4 py-3 text-right">{fmt.usd(r.forecast_month_usd)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-muted-foreground" title={new Date(r.updated_at).toLocaleString()}>
                      {fmt.ago(r.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t px-4 py-2.5 text-[length:var(--text-ui-xs)] text-subtle">
            {shown.length === items.length ? `${items.length} request${items.length === 1 ? "" : "s"}` : `${shown.length} of ${items.length} requests`}
          </div>
        </Card>
      )}
    </motion.div>
  );
}

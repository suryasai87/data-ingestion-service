import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import type { Me, PipelineHealth } from "@/lib/types";
import Pipelines from "./Pipelines";

type Reply = [number, unknown] | ((body: unknown) => [number, unknown]);
interface Call { method: string; url: string; body: unknown }

function mockApi(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const r = routes[`${method} ${url}`];
    const [status, payload] = typeof r === "function" ? r(body) : r ?? [404, { detail: `unmocked ${method} ${url}` }];
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const BRAND = {
  key: "databricks", company: "Databricks", product: "Data Ingestion Service", hero_title: "Welcome", hero_subtitle: "",
  destination_label: "Foundation", logo_url: null, powered_by: "Powered by Databricks", palette: { brand_h: 262, brand_s: "58%" },
};
const me = (o: Partial<Me> = {}): Me => ({
  email: "owner@example.com", name: "Olu Owner", is_admin: false, is_approver: true, approver_scopes: ["domain:*"], kiosk: false, ...o,
});
const recent = new Date(Date.now() - 4 * 60 * 1000).toISOString();
const pipe = (o: Partial<PipelineHealth> = {}): PipelineHealth => ({
  request_id: "REQ-1001", title: "ERP orders", pipeline_id: "p-1", state: "RUNNING", health: "healthy",
  last_update_at: recent, last_update_state: "COMPLETED", freshness_min: 12, sla_minutes: 60, rows_last_update: 1204,
  cost_mtd_usd: 120, forecast_month_usd: 400, recon: { status: "match", source_rows: 125000, target_rows: 125000 },
  incidents_open: 0, url: "https://example.cloud.databricks.com/pipelines/p-1", ...o,
});
const TWO = [
  pipe(),
  pipe({
    request_id: "REQ-1002", title: "Salesforce accounts", pipeline_id: "p-2", health: "degraded", freshness_min: 75, sla_minutes: 60,
    cost_mtd_usd: 80, forecast_month_usd: 100, recon: { status: "drift", source_rows: 5000, target_rows: 4980 }, incidents_open: 2, url: null,
  }),
];
const brandRoutes = (user: Me): Record<string, Reply> => ({ "GET /api/brand": [200, BRAND], "GET /api/me": [200, user] });

function renderPage() {
  return render(<MemoryRouter initialEntries={["/pipelines"]}><BrandProvider><Pipelines /></BrandProvider></MemoryRouter>);
}

describe("Pipelines", () => {
  it("summarises health and shows freshness, reconciliation and cost per pipeline", async () => {
    mockApi({ ...brandRoutes(me()), "GET /api/pipelines": [200, { source: "workspace", items: TWO }] });
    renderPage();
    expect(await screen.findByRole("article", { name: "ERP orders" })).toBeInTheDocument();
    expect(screen.getByTestId("stat-live")).toHaveTextContent("2");
    expect(screen.getByTestId("stat-healthy")).toHaveTextContent("50%");
    expect(screen.getByTestId("stat-sla")).toHaveTextContent("50%");
    expect(screen.getByTestId("stat-incidents")).toHaveTextContent("2");
    expect(screen.getByTestId("stat-cost")).toHaveTextContent("$200");
    expect(screen.getByTestId("stat-cost")).toHaveTextContent("of $500 forecast");
    expect(screen.getByTestId("source-pill")).toHaveTextContent("Live · Workspace");

    expect(screen.getByTestId("fresh-REQ-1001")).toHaveAttribute("data-level", "within SLA");
    expect(screen.getByTestId("fresh-REQ-1002")).toHaveAttribute("data-level", "over SLA");
    const sf = screen.getByRole("article", { name: "Salesforce accounts" });
    expect(within(sf).getByText("Degraded")).toBeInTheDocument();
    expect(within(sf).getByText("Drift")).toBeInTheDocument();
    expect(within(sf).getByText("5,000 → 4,980")).toBeInTheDocument();
    expect(within(sf).getByText("125% · over SLA")).toBeInTheDocument();
    expect(within(sf).queryByRole("link", { name: /Open in Databricks/ })).not.toBeInTheDocument();
    const erp = screen.getByRole("article", { name: "ERP orders" });
    expect(within(erp).getByRole("link", { name: /Open in Databricks/ })).toHaveAttribute("target", "_blank");
    expect(within(erp).getByText("Match")).toBeInTheDocument();
    expect(within(erp).getByRole("meter", { name: "Freshness against SLA" })).toHaveAttribute("aria-valuenow", "12");
  });

  it("asks for confirmation before pausing, then POSTs pause and shows the paused card", async () => {
    let paused = false;
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/pipelines": () => [200, { source: "workspace", items: paused
        ? [pipe({ health: "paused", state: "PAUSED", paused_at: recent, paused_by: "owner@example.com" })] : [pipe()] }],
      "POST /api/pipelines/REQ-1001/pause": () => { paused = true; return [200, { ok: true, done: ["schedule paused", "pipeline stopped"] }]; },
    });
    const user = userEvent.setup();
    renderPage();
    const card = await screen.findByRole("article", { name: "ERP orders" });
    await user.click(within(card).getByRole("button", { name: "Pause" }));
    const dialog = await screen.findByRole("dialog", { name: "Pause ERP orders?" });
    expect(dialog).toHaveTextContent("Turns the schedule off, stops the pipeline");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Pause pipeline" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.url).toBe("/api/pipelines/REQ-1001/pause"));
    expect(await screen.findByText(/Paused: the schedule is off/)).toBeInTheDocument();
    expect(await screen.findByTestId("paused-REQ-1001")).toHaveTextContent("by owner@example.com");
    // paused: one action, Unpause; no Pause / Run now; health and SLA leave it out
    expect(within(card).getByRole("button", { name: "Unpause pipeline" })).toBeEnabled();
    expect(within(card).queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
    expect(screen.getByTestId("stat-live")).toHaveTextContent("1 paused");
    expect(screen.getByTestId("stat-healthy")).toHaveTextContent("Every pipeline is paused");
  });

  it("unpauses a paused pipeline straight into a running update", async () => {
    let paused = true;
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/pipelines": () => [200, { source: "workspace", items: [paused
        ? pipe({ health: "paused", state: "PAUSED", paused_at: recent, paused_by: "owner@example.com" })
        : pipe({ state: "RUNNING", last_update_state: "RUNNING" })] }],
      "POST /api/pipelines/REQ-1001/unpause": () => { paused = false; return [200, { ok: true, update_id: "u-1", done: ["schedule on", "update started"] }]; },
    });
    const user = userEvent.setup();
    renderPage();
    const card = await screen.findByRole("article", { name: "ERP orders" });
    expect(within(card).getByTestId("paused-REQ-1001")).toHaveTextContent("Paused");
    await user.click(within(card).getByRole("button", { name: "Unpause pipeline" }));
    expect(await within(card).findByText(/Unpaused: the schedule is back on and an update is running now/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/pipelines/REQ-1001/unpause"]);
    expect(await within(card).findByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(within(card).queryByTestId("paused-REQ-1001")).not.toBeInTheDocument();
  });

  it("lets admins pause every running pipeline at once", async () => {
    let paused = false;
    const calls = mockApi({
      ...brandRoutes(me({ is_admin: true })),
      "GET /api/pipelines": () => [200, { source: "workspace", items: paused
        ? TWO.map((p) => ({ ...p, health: "paused", state: "PAUSED", paused_at: recent, paused_by: "owner@example.com" })) : TWO }],
      "POST /api/pipelines/pause-all": () => { paused = true; return [200, { paused: ["REQ-1001", "REQ-1002"], already_paused: [], failed: [] }]; },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("article", { name: "ERP orders" });
    await user.click(screen.getByRole("button", { name: "Pause all" }));
    const dialog = await screen.findByRole("dialog", { name: "Pause every pipeline?" });
    await user.click(within(dialog).getByRole("button", { name: "Pause 2 pipelines" }));
    expect(await within(dialog).findByText("2 paused.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/pipelines/pause-all"]);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(await screen.findAllByRole("button", { name: "Unpause pipeline" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Pause all" })).toBeDisabled();
  });

  it("runs now and reconciles, and shows a write error inline", async () => {
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/pipelines": [200, { source: "workspace", items: [pipe()] }],
      "POST /api/pipelines/REQ-1001/run": [200, { update_id: "u-9" }],
      "POST /api/pipelines/REQ-1001/reconcile": [409, { detail: "A reconciliation is already running" }],
    });
    const user = userEvent.setup();
    renderPage();
    const card = await screen.findByRole("article", { name: "ERP orders" });
    await user.click(within(card).getByRole("button", { name: "Run now" }));
    expect(await within(card).findByText("Update started. The schedule is unchanged.")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Reconcile" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("A reconciliation is already running");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/pipelines/REQ-1001/run", "/api/pipelines/REQ-1001/reconcile"]);
  });

  it("lists incidents in a drawer", async () => {
    mockApi({
      ...brandRoutes(me()),
      "GET /api/pipelines": [200, { source: "workspace", items: TWO }],
      "GET /api/pipelines/REQ-1002/incidents": [200, { items: [
        { id: 1, kind: "transient", status: "auto_healed", title: "Gateway restarted", detail: "Retried after a network blip", ticket_ref: null, opened_at: recent },
        { id: 2, kind: "actionable", status: "open", title: "Column type changed", detail: "amount: int → decimal", ticket_ref: "INC-4821", opened_at: recent },
      ] }],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "2 open incidents" }));
    const drawer = await screen.findByRole("dialog", { name: "Incidents · Salesforce accounts" });
    expect(await within(drawer).findByText("Column type changed")).toBeInTheDocument();
    expect(within(drawer).getByText("Auto-healed")).toBeInTheDocument();
    expect(within(drawer).getByText("Actionable")).toBeInTheDocument();
    expect(within(drawer).getByText("INC-4821")).toBeInTheDocument();
  });

  it("hides operate actions from viewers who are not approvers", async () => {
    mockApi({ ...brandRoutes(me({ is_approver: false })), "GET /api/pipelines": [200, { source: "workspace", items: [pipe()] }] });
    renderPage();
    const card = await screen.findByRole("article", { name: "ERP orders" });
    await waitFor(() => expect(within(card).queryByRole("button", { name: "Run now" })).not.toBeInTheDocument());
    expect(within(card).getByRole("link", { name: /Open in Databricks/ })).toBeInTheDocument();
  });

  it("disables operate actions in read-only mode", async () => {
    mockApi({ ...brandRoutes(me({ kiosk: true })), "GET /api/pipelines": [200, { source: "workspace", items: [pipe()] }] });
    renderPage();
    const run = await screen.findByRole("button", { name: "Run now" });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute("title", "Read-only mode");
  });

  it("lets admins simulate source activity with the default counts", async () => {
    const calls = mockApi({
      ...brandRoutes(me({ is_admin: true })),
      "GET /api/pipelines": [200, { source: "workspace", items: [pipe()] }],
      "POST /api/demo/source-activity": [200, { ok: true }],
    });
    const user = userEvent.setup();
    renderPage();
    const card = await screen.findByRole("region", { name: "Simulate source activity" });
    expect(within(card).getByRole("spinbutton", { name: "Inserts" })).toHaveValue(50);
    await user.click(within(card).getByRole("button", { name: "Write changes" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/demo/source-activity")?.body).toEqual({ inserts: 50, updates: 20, deletes: 5 }));
    expect(await within(card).findByText(/Wrote 50 inserts, 20 updates and 5 deletes/)).toBeInTheDocument();
  });

  it("shows the empty state when nothing is deployed", async () => {
    mockApi({ ...brandRoutes(me()), "GET /api/pipelines": [200, { source: "lakebase", items: [] }] });
    renderPage();
    expect(await screen.findByText("No live pipelines yet")).toBeInTheDocument();
    expect(screen.getByText("Approved requests appear here once deployed.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Simulate source activity" })).not.toBeInTheDocument();
  });

  it("shows an error with Retry and recovers", async () => {
    let n = 0;
    mockApi({
      ...brandRoutes(me()),
      "GET /api/pipelines": () => (n++ === 0 ? [500, { detail: "workspace API timed out" }] : [200, { source: "workspace", items: [pipe()] }]),
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("workspace API timed out")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("article", { name: "ERP orders" })).toBeInTheDocument();
  });
});

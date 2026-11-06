import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import type { Brand, Forecast, IngestionConfig, Me, ModelCard } from "@/lib/types";
import Insights from "./Insights";

type Reply = { status?: number; body: unknown };
type RouteMap = Record<string, Reply | ((init?: RequestInit) => Reply)>;

const BRAND: Brand = {
  key: "databricks", company: "Databricks", product: "Data Ingestion Service",
  hero_title: "Welcome to Data Ingestion Service", hero_subtitle: "Governed ingestion into Foundation.",
  destination_label: "Foundation", logo_url: null, powered_by: "Powered by Databricks Lakeflow Connect",
  palette: { brand_h: 262, brand_s: "58%" },
};
const ME: Me = { email: "ana@example.com", name: "Ana", is_admin: false, is_approver: false, approver_scopes: [], kiosk: false };

function mockFetch(routes: RouteMap) {
  const all: RouteMap = { "GET /api/brand": { body: BRAND }, "GET /api/me": { body: ME }, ...routes };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`;
    const r = all[key];
    const reply = typeof r === "function" ? r(init) : r ?? { status: 404, body: { detail: `unmocked ${key}` } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  });
}

const CARD: ModelCard = {
  source: "warehouse", version: "builtin-20261031.1944", trained_at: "2026-10-31T19:44:35+00:00", window_days: 365,
  n_pipelines: 206, n_updates: 48210, workspaces: 31,
  metrics: [
    { name: "Update duration P50 error", value: 27.8, unit: "% MdAPE", note: "median absolute % error on 45 held-out pipelines" },
    { name: "Update duration P90 coverage", value: 88.9, unit: "%", note: "target ~90%" },
  ],
  method: ["Account-wide system.lakeflow history, last 365 days", "Abandoned pipelines dropped (< 20%% success)"],
  benchmarks: [
    { family: "salesforce", pattern: "saas", n_pipelines: 46, n_updates: 9000, upd_p50_s: 62, upd_p90_s: 180, success_rate: 0.962, dbu_per_update: 0.118, gateway_dbu_hour: null },
    { family: "sqlserver", pattern: "cdc", n_pipelines: 12, n_updates: 4000, upd_p50_s: 95, upd_p90_s: 260, success_rate: 0.91, dbu_per_update: 0.2, gateway_dbu_hour: 0.4365 },
    { family: "postgresql", pattern: "query", n_pipelines: 3, n_updates: 300, upd_p50_s: 40, upd_p90_s: 120, success_rate: 0.88, dbu_per_update: 0.09, gateway_dbu_hour: null },
  ],
};

const FORECAST: Forecast = {
  source: "lakebase", model_version: CARD.version,
  basis: { n_pipelines: 46, n_updates: 9000, workspaces: 12, window_days: 365, match: "family", family: "salesforce" },
  cost: { month: { p50: 210, p90: 480 }, dbu_day: 13.3, usd_per_dbu: 0.45, breakdown: [] },
  first_data_min: { p50: 9, p90: 21 }, freshness_min: { p50: 12, p90: 24 },
  sla: { target_min: 30, attainment_pct: 94.2 },
  reliability: { success_rate: 0.962, auto_heal_rate: 0.8, expected_tickets_month: 0.4 },
  confidence: "high", drivers: [], recommendations: [],
};

function renderPage() {
  return render(<MemoryRouter><BrandProvider><Insights /></BrandProvider></MemoryRouter>);
}

const forecastBodies = (spy: ReturnType<typeof mockFetch>) => spy.mock.calls
  .filter(([u, init]) => u === "/api/forecast" && init?.method === "POST")
  .map(([, init]) => JSON.parse(String(init?.body)) as { config: IngestionConfig });

describe("Insights (forecast model)", () => {
  it("renders the model card, honesty callout, metrics, method and benchmarks", async () => {
    mockFetch({ "GET /api/forecast/model": { body: CARD }, "POST /api/forecast": { body: FORECAST } });
    renderPage();
    expect(await screen.findByTestId("model-version")).toHaveTextContent("builtin-20261031.1944");
    expect(screen.getByTestId("model-pipelines")).toHaveTextContent("206");
    expect(screen.getByTestId("model-workspaces")).toHaveTextContent("31");
    expect(screen.getByTestId("source-pill")).toHaveTextContent("Lakehouse");
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(/real Lakeflow Connect history in this account/);
    expect(note).toHaveTextContent(/inferred from pipeline names/);
    expect(note).toHaveTextContent(/shrunk toward their ingestion pattern/);
    expect(note).toHaveTextContent(/list prices, before the free tier/);
    expect(screen.getAllByTestId("model-metric")).toHaveLength(2);
    expect(screen.getByText("Abandoned pipelines dropped (< 20% success)")).toBeInTheDocument();
    const rows = screen.getAllByTestId("bench-row");
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual(["salesforce", "sqlserver", "postgresql"]);
    expect(within(rows[0]).getByText("96.2%")).toBeInTheDocument();
  });

  it("sorts benchmarks by pipelines when the header is activated", async () => {
    mockFetch({ "GET /api/forecast/model": { body: CARD }, "POST /api/forecast": { body: FORECAST } });
    renderPage();
    await screen.findAllByTestId("bench-row");
    await userEvent.click(screen.getByRole("button", { name: /Pipelines, sorted/ }));
    const rows = screen.getAllByTestId("bench-row");
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual(["postgresql", "sqlserver", "salesforce"]);
    expect(screen.getByRole("columnheader", { name: /Pipelines/ })).toHaveAttribute("aria-sort", "ascending");
  });

  it("what-if posts a minimal configuration to /api/forecast and shows the prediction", async () => {
    const spy = mockFetch({ "GET /api/forecast/model": { body: CARD }, "POST /api/forecast": { body: FORECAST } });
    renderPage();
    await waitFor(() => expect(forecastBodies(spy).length).toBe(1), { timeout: 2000 });
    const first = forecastBodies(spy)[0].config;
    expect(first.source).toMatchObject({ connector: "salesforce", pattern: "saas" });
    expect(first.schedule).toMatchObject({ mode: "interval", interval_minutes: 15, sla_minutes: 30 });
    expect(first.objects).toHaveLength(5);
    expect(await screen.findByTestId("whatif-cost")).toBeInTheDocument();
    expect(screen.getByTestId("whatif-sla")).toHaveTextContent("within 30 min");
    expect(screen.getByTestId("whatif-basis")).toHaveTextContent("Based on 46 salesforce pipelines");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Connector family" }), "sqlserver");
    await userEvent.click(screen.getByRole("radio", { name: "1 h" }));
    await waitFor(() => {
      const last = forecastBodies(spy).at(-1)!.config;
      expect(last.source).toMatchObject({ connector: "sqlserver", pattern: "cdc" });
      expect(last.schedule.interval_minutes).toBe(60);
    }, { timeout: 2000 });
  });

  it("what-if does not post while an input is invalid", async () => {
    const spy = mockFetch({ "GET /api/forecast/model": { body: CARD }, "POST /api/forecast": { body: FORECAST } });
    renderPage();
    await waitFor(() => expect(forecastBodies(spy).length).toBe(1), { timeout: 2000 });
    const tables = screen.getByRole("spinbutton", { name: "Tables" });
    await userEvent.clear(tables);
    expect(await screen.findByText("Enter 1 to 500 tables")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 450));
    expect(forecastBodies(spy).length).toBe(1);
  });

  it("shows an error card with Retry when the model card fails", async () => {
    let calls = 0;
    mockFetch({
      "GET /api/forecast/model": () => (++calls === 1 ? { status: 500, body: { detail: "warehouse timeout" } } : { body: CARD }),
      "POST /api/forecast": { body: FORECAST },
    });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("warehouse timeout");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("model-version")).toBeInTheDocument();
  });

  it("explains an empty benchmark list instead of rendering an empty table", async () => {
    mockFetch({ "GET /api/forecast/model": { body: { ...CARD, benchmarks: [] } } });
    renderPage();
    expect(await screen.findByText(/No connector-family benchmarks yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("bench-row")).toBeNull();
    expect(screen.queryByRole("region", { name: "What-if" })).toBeNull();
  });
});

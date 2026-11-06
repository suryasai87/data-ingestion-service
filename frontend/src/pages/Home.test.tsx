import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import type { Brand, HomeStats, IngestRequest, Me } from "@/lib/types";
import Home from "./Home";

type Reply = { status?: number; body: unknown };
type RouteMap = Record<string, Reply | ((init?: RequestInit) => Reply)>;

const BRAND: Brand = {
  key: "databricks", company: "Databricks", product: "Data Ingestion Service",
  hero_title: "Welcome to Data Ingestion Service", hero_subtitle: "Request governed, CDC-based ingestion into Foundation.",
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

const REQ: IngestRequest = {
  id: "req-1001", title: "SAP orders to Foundation", status: "live", channel: "app", requester: "ana@example.com",
  owner: "ana@example.com", classification: "internal", environment: "prod", connector: "sqlserver", pattern: "cdc",
  n_objects: 4, version: 2, created_at: "2026-10-30T10:00:00Z", updated_at: new Date().toISOString(),
  pipeline_id: "p-1", gateway_id: "g-1", job_id: "j-1", forecast_month_usd: 412, sla_minutes: 30,
};
const STATS: HomeStats = {
  source: "lakebase", requests_open: 3, pipelines_live: 12, tables_live: 87, median_hours_to_live: 6.5,
  sla_attainment_pct: 98.4, cost_mtd_usd: 1234, forecast_accuracy_pct: 91.2, recent: [REQ],
};

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <BrandProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/requests/:id" element={<div>request detail page</div>} />
          <Route path="/new" element={<div>new request page</div>} />
        </Routes>
      </BrandProvider>
    </MemoryRouter>,
  );
}

describe("Home", () => {
  it("renders the brand hero, CTAs, targets, KPIs and recent requests", async () => {
    mockFetch({ "GET /api/home": { body: STATS } });
    renderHome();
    expect(screen.getByRole("heading", { level: 1, name: "Welcome to Data Ingestion Service" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New request" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask the assistant" })).toBeInTheDocument();
    const targets = screen.getByRole("list", { name: "Service targets" });
    expect(within(targets).getByText("< 1 day")).toBeInTheDocument();
    expect(within(targets).getByText("request to Foundation")).toBeInTheDocument();
    expect(within(targets).getByText("near-real-time latency")).toBeInTheDocument();
    expect(within(targets).getByText("approved, reconciled and audited")).toBeInTheDocument();

    expect(await screen.findByText("SAP orders to Foundation")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-pipelines-live")).toHaveTextContent("12");
    expect(screen.getByTestId("kpi-tables-live")).toHaveTextContent("87");
    expect(screen.getByTestId("kpi-sla")).toHaveTextContent("98.4%");
    expect(screen.getByTestId("kpi-median-to-live")).toHaveTextContent("6.5 h");
    expect(screen.getByTestId("source-pill")).toHaveTextContent("Live · Lakebase");
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("PROD")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See how it works" })).toHaveAttribute("href", "/how-it-works");
  });

  it("opens a request when its row is clicked", async () => {
    mockFetch({ "GET /api/home": { body: STATS } });
    renderHome();
    await userEvent.click(await screen.findByRole("link", { name: /SAP orders to Foundation/ }));
    expect(await screen.findByText("request detail page")).toBeInTheDocument();
  });

  it("shows an empty state with a next step when there are no requests", async () => {
    mockFetch({ "GET /api/home": { body: { ...STATS, recent: [] } } });
    renderHome();
    expect(await screen.findByText("No requests yet")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "New request" });
    await userEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByText("new request page")).toBeInTheDocument();
  });

  it("shows an error card with Retry when the overview fails, and recovers", async () => {
    let calls = 0;
    mockFetch({
      "GET /api/home": () => (++calls === 1 ? { status: 500, body: { detail: "store unavailable" } } : { body: STATS }),
    });
    renderHome();
    expect(await screen.findByRole("alert")).toHaveTextContent("store unavailable");
    expect(screen.getByRole("heading", { level: 1, name: "Welcome to Data Ingestion Service" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("SAP orders to Foundation")).toBeInTheDocument());
  });
});

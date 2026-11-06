import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import { BRAND, ME, mockApi } from "@/test/mockApi";
import NewRequest from "./NewRequest";

const caps = { hard_deletes: false, scd2: false, min_interval_minutes: 15, needs_gateway: false, incremental: true };
const CONNECTORS = { source: "lakebase", items: [
  { id: "http", name: "REST API (HTTP connection)", category: "api", patterns: ["api"], status: "supported", connection_type: "HTTP", capabilities: caps, description: "", enabled: true },
  { id: "volume", name: "Unity Catalog volume (file drop)", category: "files", patterns: ["files"], status: "supported", connection_type: null, capabilities: caps, description: "", enabled: true },
] };
const FORECAST = { source: "synthetic", model_version: "b", confidence: "low", basis: { n_pipelines: 1, n_updates: 1, workspaces: 1, window_days: 365, match: "global", family: "http" },
  cost: { month: { p50: 3, p90: 9 }, dbu_day: 0.1, usd_per_dbu: 0.45, breakdown: [] }, first_data_min: { p50: 3, p90: 5 }, freshness_min: { p50: 100, p90: 200 },
  sla: { target_min: 480, attainment_pct: 99 }, reliability: { success_rate: 97, auto_heal_rate: 10, expected_tickets_month: 0.1 }, drivers: [], recommendations: [] };

function setup() {
  return mockApi({
    "GET /api/brand": [200, BRAND], "GET /api/me": [200, ME], "GET /api/connectors": [200, CONNECTORS],
    "GET /api/destinations": [200, { items: [{ environment: "dev", label: "Foundation · DEV", catalog: "cat", schema: "foundation_dev", allowed: true, requires_approval: true }] }],
    "GET /api/connections?connector=http": [200, { source: "workspace", items: [{ name: "open_meteo", connection_type: "HTTP", host: "https://api.open-meteo.com", owner: null, usable: true, foreign_catalog: null, via: "connection", patterns: ["api"] }] }],
    "POST /api/forecast": [200, FORECAST], "POST /api/validate": [200, { checks: [] }],
  });
}

function renderPage() {
  return render(<MemoryRouter initialEntries={["/new"]}><BrandProvider><Routes><Route path="/new" element={<NewRequest />} /></Routes></BrandProvider></MemoryRouter>);
}

describe("NewRequest: API and file sources", () => {
  it("builds an API endpoint with path and query parameters", async () => {
    const calls = setup();
    const u = userEvent.setup();
    renderPage();
    await u.click(await screen.findByTestId("connector-http"));
    await waitFor(() => expect(screen.getByLabelText("Connection")).toHaveValue("open_meteo"));
    await u.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByTestId("spec-objects")).toBeInTheDocument();
    const path = await screen.findByLabelText("Path 1");
    await u.clear(path);
    await u.type(path, "/v1/forecast");
    await u.type(screen.getByLabelText("Query parameters 1"), "latitude=40.7&longitude=-74.0");
    await waitFor(() => {
      const last = [...calls].reverse().find((c) => c.url === "/api/forecast")!;
      const o = (last.body as { config: { objects: { options: Record<string, unknown> }[] } }).config.objects[0];
      expect(o.options.path).toBe("/v1/forecast");
      expect(o.options.params).toEqual({ latitude: "40.7", longitude: "-74.0" });
    });
    expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled();
  });

  it("asks for no connection for a UC volume and requires a path", async () => {
    setup();
    const u = userEvent.setup();
    renderPage();
    await u.click(await screen.findByTestId("connector-volume"));
    expect(await screen.findByTestId("no-connection")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: /Continue/ }));
    const p = await screen.findByLabelText("File path 1");
    await u.clear(p);
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
    await u.type(p, "/Volumes/cat/sch/drop/lab/");
    expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled();
  });
});

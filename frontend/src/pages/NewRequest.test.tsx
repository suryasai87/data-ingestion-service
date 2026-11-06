import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import type { IngestionConfig } from "@/lib/types";
import { BRAND, ME, mockApi } from "@/test/mockApi";
import NewRequest from "./NewRequest";

const CONNECTORS = { source: "lakebase", items: [
  { id: "postgresql", name: "PostgreSQL", category: "database", patterns: ["cdc", "query"], status: "supported", connection_type: "POSTGRESQL",
    capabilities: { hard_deletes: true, scd2: true, min_interval_minutes: 5, needs_gateway: true, incremental: true }, description: "", enabled: true, history_pipelines: 6 },
  { id: "sap", name: "SAP (S/4HANA, ECC, BW)", category: "database", patterns: ["saas"], status: "extension", connection_type: null,
    capabilities: { hard_deletes: true, scd2: false, min_interval_minutes: 15, needs_gateway: false, incremental: true }, description: "Shared through SAP BDC.", enabled: true },
] };
const CONNS = { source: "workspace", items: [{ name: "dis_erp_source", connection_type: "UC_DATABASE_CATALOG", host: null, owner: null, usable: true,
  foreign_catalog: "dis_erp_source", demo: true, via: "uc_catalog", patterns: ["query"] }] };
const OBJECTS = { source: "workspace", connection: "dis_erp_source", schemas: ["finance"], browse: "direct", database: "erp", tables: [
  { schema: "finance", name: "journal_header", rows_est: 20000, size_bytes: 1, primary_keys: ["doc_id"], columns: 9, cursor_candidates: ["updated_at"], cdc_ready: true, issues: [] },
  { schema: "finance", name: "journal_line", rows_est: 60000, size_bytes: 1, primary_keys: ["doc_id", "line_no"], columns: 7, cursor_candidates: ["updated_at"], cdc_ready: true, issues: [] },
] };
const DESTS = { items: [{ environment: "dev", label: "Foundation · DEV", catalog: "cat", schema: "foundation_dev", allowed: true, requires_approval: true }] };
const FORECAST = {
  source: "lakebase", model_version: "20261031.1", confidence: "medium",
  basis: { n_pipelines: 14, n_updates: 900, workspaces: 9, window_days: 365, match: "pattern", family: "postgresql" },
  cost: { month: { p50: 61.5, p90: 140 }, dbu_day: 4.5, usd_per_dbu: 0.45, breakdown: [{ label: "Ingestion updates (96/day, serverless)", usd_month: 61.5, pct: 100 }] },
  first_data_min: { p50: 4, p90: 7 }, freshness_min: { p50: 9, p90: 15 }, sla: { target_min: 30, attainment_pct: 99.1 },
  reliability: { success_rate: 97, auto_heal_rate: 12, expected_tickets_month: 3 }, drivers: [],
  recommendations: [{ id: "relax", title: "Relax to every 30 min and still meet the SLA", detail: "headroom", delta: { cost_month: -30 }, patch: { schedule: { interval_minutes: 30 } } }],
};

function routes(extra = {}) {
  return {
    "GET /api/brand": [200, BRAND], "GET /api/me": [200, ME], "GET /api/connectors": [200, CONNECTORS],
    "GET /api/destinations": [200, DESTS], "GET /api/connections?connector=postgresql": [200, CONNS],
    "GET /api/connections/dis_erp_source/objects?connector=postgresql": [200, OBJECTS],
    "POST /api/forecast": [200, FORECAST], "POST /api/validate": [200, { checks: [{ key: "schema.keys", label: "Schema check: primary keys", status: "pass", detail: "" }] }],
    ...extra,
  } as Record<string, [number, unknown]>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/new"]}>
      <BrandProvider>
        <Routes>
          <Route path="/new" element={<NewRequest />} />
          <Route path="/requests/:id" element={<div>request page</div>} />
        </Routes>
      </BrandProvider>
    </MemoryRouter>,
  );
}

describe("NewRequest", () => {
  it("walks source -> objects -> destination -> schedule -> ownership -> review and submits", async () => {
    const calls = mockApi(routes({
      "POST /api/requests": [200, { request: { id: "IR-1001" } }],
      "POST /api/requests/IR-1001/submit": [200, { request: { id: "IR-1001", status: "pending_approval" } }],
    }));
    const u = userEvent.setup();
    renderPage();
    await u.click(await screen.findByTestId("connector-postgresql"));
    // the UC-catalog demo source is preselected and only allows query-based
    await waitFor(() => expect(screen.getByLabelText("Connection")).toHaveValue("dis_erp_source"));
    expect(screen.getByRole("radio", { name: "CDC" })).toBeDisabled();
    // the forecast rail shows the model's numbers and their basis
    expect(await screen.findByText(/Based on/)).toHaveTextContent("14");
    await u.click(screen.getByRole("button", { name: /Continue/ }));
    await u.click(await screen.findByLabelText("Select finance.journal_header"));
    expect(screen.getByLabelText("Cursor column for journal_header")).toHaveValue("updated_at");
    await u.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByText("cat.foundation_dev")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: /Continue/ }));
    await u.click(await screen.findByRole("button", { name: /Continue/ }));
    const title = await screen.findByLabelText("Request title");
    await u.type(title, "Finance journals");
    expect(screen.getByLabelText("Data owner")).toHaveValue("ana@example.com");
    await u.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByText("Review the approved configuration")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Submit for approval" });
    await waitFor(() => expect(submit).toBeEnabled());
    await u.click(submit);
    expect(await screen.findByText("request page")).toBeInTheDocument();
    const create = calls.find((c) => c.method === "POST" && c.url === "/api/requests")!;
    const cfg = (create.body as { config: Record<string, any> }).config;
    expect(cfg.source).toMatchObject({ connector: "postgresql", connection: "dis_erp_source", via: "uc_catalog", pattern: "query", database: "erp" });
    expect(cfg.objects[0]).toMatchObject({ schema: "finance", table: "journal_header", primary_keys: ["doc_id"], cursor_column: "updated_at" });
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/requests/IR-1001/submit")).toBe(true);
  });

  it("applies a what-if recommendation to the configuration", async () => {
    const calls = mockApi(routes());
    const u = userEvent.setup();
    renderPage();
    await u.click(await screen.findByTestId("connector-postgresql"));
    await u.click(await screen.findByRole("button", { name: /Apply: Relax/ }));
    await waitFor(() => {
      const last = [...calls].reverse().find((c) => c.url === "/api/forecast")!;
      expect((last.body as { config: { schedule: { interval_minutes: number } } }).config.schedule.interval_minutes).toBe(30);
    });
  });

  it("explains that an extension connector can't be requested yet", async () => {
    mockApi(routes());
    const u = userEvent.setup();
    renderPage();
    await u.click(await screen.findByTestId("connector-sap"));
    expect(await screen.findByText(/needs a platform extension/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
  });

  it("shows a save error inline without losing the form", async () => {
    mockApi(routes({ "POST /api/requests": [503, { detail: "The request store (Lakebase) is not configured." }] }));
    const u = userEvent.setup();
    renderPage();
    await u.click(await screen.findByTestId("connector-postgresql"));
    await u.click(screen.getByRole("button", { name: /Continue/ }));
    await u.click(await screen.findByLabelText("Select finance.journal_header"));
    for (let i = 0; i < 3; i++) await u.click(screen.getByRole("button", { name: /Continue/ }));
    await u.type(await screen.findByLabelText("Request title"), "x");
    await u.click(screen.getByRole("button", { name: /Continue/ }));
    await u.click(await screen.findByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/not configured/)).toBeInTheDocument();
    // still on the review step (it mounts after the previous step's exit animation)
    expect(await screen.findByText("Review the approved configuration")).toBeInTheDocument();
  });
});

const CMDB = { source: "simulator", items: [
  { sys_id: "apm-fin", name: "Finance Close & Consolidation", owner: "fin.owner@example.com", domain: "finance", cost_center: "CC-FIN-100", support_group: "Finance Data Office", gxp: false },
  { sys_id: "apm-qms", name: "Quality Management System", owner: "qa.owner@example.com", domain: "quality", cost_center: "CC-QA-300", support_group: "Quality IT", gxp: true },
] };

async function toOwnership(u: ReturnType<typeof userEvent.setup>) {
  await u.click(await screen.findByTestId("connector-postgresql"));
  await u.click(screen.getByRole("button", { name: /Continue/ }));
  await u.click(await screen.findByLabelText("Select finance.journal_header"));
  for (let i = 0; i < 3; i++) await u.click(screen.getByRole("button", { name: /Continue/ }));
  await screen.findByLabelText("Request title");
}

describe("NewRequest · ownership (ServiceNow CMDB, GxP, readers)", () => {
  it("picks a CMDB business application: prefills empty owner/domain/cost center, marks GxP, and saves readers as an array", async () => {
    const calls = mockApi(routes({
      "GET /api/itsm/cmdb?q=qual": [200, { ...CMDB, items: [CMDB.items[1]] }],
      "POST /api/requests": [200, { request: { id: "IR-1002" } }],
    }));
    const u = userEvent.setup();
    renderPage();
    await toOwnership(u);
    expect(screen.getByRole("switch", { name: "GxP-relevant data" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/Requires an independent e-signed approval, a qualification run with an evidence pack, and Dev → UAT → Prod promotion/)).toBeInTheDocument();
    await u.type(screen.getByLabelText("Cost center"), "CC-MINE");

    await u.type(screen.getByRole("combobox", { name: "Business application (ServiceNow CMDB)" }), "qual");
    const opt = await screen.findByRole("option", { name: /Quality Management System/ });
    const sim = screen.getByText("Simulator");
    expect(sim.closest("[title]")).toHaveAttribute("title", "No ServiceNow instance configured: the built-in Table API simulator is used");
    await u.click(opt);
    expect(screen.getByLabelText("Data owner")).toHaveValue("qa.owner@example.com");
    expect(screen.getByLabelText("Business domain")).toHaveValue("quality");
    expect(screen.getByLabelText("Cost center")).toHaveValue("CC-MINE");
    expect(screen.getByRole("switch", { name: "GxP-relevant data" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Linked to/)).toHaveTextContent("Linked to Quality Management System; prefilled owner, domain, GxP.");
    expect(calls.filter((c) => c.url.startsWith("/api/itsm/cmdb"))).toHaveLength(1);

    await u.type(screen.getByLabelText("Additional readers"), "jane@example.com, group:finance-analysts");
    expect(screen.getByText(/Readers get read-only access \(USE CATALOG, USE SCHEMA, SELECT\) to the landed tables/)).toBeInTheDocument();
    await u.type(screen.getByLabelText("Request title"), "Quality deviations");
    await u.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByText("Review the approved configuration")).toBeInTheDocument();
    expect(screen.getByText("GxP-relevant: e-signed approval, qualification with an evidence pack, Dev → UAT → Prod")).toBeInTheDocument();
    expect(screen.getByText("jane@example.com, group:finance-analysts (read-only)")).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("request page")).toBeInTheDocument();
    const own = (calls.find((c) => c.method === "POST" && c.url === "/api/requests")!.body as { config: IngestionConfig }).config.ownership;
    expect(own).toMatchObject({
      owner: "qa.owner@example.com", domain: "quality", cost_center: "CC-MINE", gxp: true,
      business_app: { sys_id: "apm-qms", name: "Quality Management System" },
      readers: ["jane@example.com", "group:finance-analysts"],
    });
  });

  it("keeps a typed owner and blocks Continue on a malformed reader", async () => {
    mockApi(routes({ "GET /api/itsm/cmdb?q=fin": [200, CMDB] }));
    const u = userEvent.setup();
    renderPage();
    await toOwnership(u);
    const owner = screen.getByLabelText("Data owner");
    await u.clear(owner);
    await u.type(owner, "me.too@example.com");
    await u.type(screen.getByRole("combobox", { name: "Business application (ServiceNow CMDB)" }), "fin");
    await u.click(await screen.findByRole("option", { name: /Finance Close/ }));
    expect(owner).toHaveValue("me.too@example.com");
    expect(screen.getByLabelText("Business domain")).toHaveValue("finance");
    expect(screen.getByLabelText("Cost center")).toHaveValue("CC-FIN-100");
    expect(screen.getByRole("switch", { name: "GxP-relevant data" })).toHaveAttribute("aria-checked", "false");

    await u.type(screen.getByLabelText("Request title"), "Close data");
    await u.type(screen.getByLabelText("Additional readers"), "jane@example.com, finance team");
    expect(screen.getByText("Use an email or group:<name> for: finance team")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
    await u.click(screen.getByRole("button", { name: "Clear business application" }));
    expect(screen.getByRole("combobox", { name: "Business application (ServiceNow CMDB)" })).toHaveValue("");
  });
});

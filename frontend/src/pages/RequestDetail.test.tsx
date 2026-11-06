import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import type { Forecast, IngestionConfig, Me, RequestDetail as Detail } from "@/lib/types";
import RequestDetail from "./RequestDetail";

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
  email: "owner@example.com", name: "Olu Owner", is_admin: false, is_approver: true, approver_scopes: ["domain:finance"], kiosk: false, ...o,
});
const t0 = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
const t1 = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

const CONFIG: IngestionConfig = {
  title: "ERP orders to Foundation",
  source: { connector: "postgresql", pattern: "cdc", connection: "erp_pg", database: "erp" },
  objects: [{ schema: "sales", table: "orders", primary_keys: ["order_id"], cursor_column: "updated_at", rows_est: 125000 }],
  schema: { scd_type: "SCD_TYPE_2", evolution: "add_new_columns" },
  destination: { environment: "prod", catalog: "foundation", schema: "erp_sales" },
  schedule: { mode: "interval", interval_minutes: 15, sla_minutes: 60 },
  ownership: { owner: "ana@example.com", classification: "confidential", domain: "finance", cost_center: "CC-4410", justification: "Revenue reporting" },
  operations: { retries: 3, recovery: "auto_retry_then_ticket", reconciliation: true, alert_emails: [] },
};
const FORECAST: Forecast = {
  source: "lakebase", model_version: "fm-2026.10",
  basis: { n_pipelines: 46, n_updates: 9120, workspaces: 4, window_days: 365, match: "family", family: "postgresql" },
  cost: { month: { p50: 1234, p90: 1810 }, dbu_day: 12, usd_per_dbu: 0.5, breakdown: [] },
  first_data_min: { p50: 35, p90: 70 }, freshness_min: { p50: 18, p90: 41 },
  sla: { target_min: 60, attainment_pct: 97.4 },
  reliability: { success_rate: 0.99, auto_heal_rate: 0.8, expected_tickets_month: 0.3 },
  confidence: "high", drivers: [], recommendations: [],
};
const detail = (o: Partial<Detail> = {}, status: Detail["request"]["status"] = "pending_approval"): Detail => ({
  source: "lakebase",
  request: {
    id: "REQ-1001", title: "ERP orders to Foundation", status, channel: "app", requester: "ana@example.com", owner: "ana@example.com",
    classification: "confidential", environment: "prod", connector: "postgresql", pattern: "cdc", n_objects: 1, version: 2,
    created_at: t0, updated_at: t1, pipeline_id: null, gateway_id: null, job_id: null, forecast_month_usd: 1234, sla_minutes: 60,
  },
  config: CONFIG,
  versions: [
    { version: 1, created_at: t0, created_by: "ana@example.com", hash: "1111aaaa2222bbbb" },
    { version: 2, created_at: t1, created_by: "ana@example.com", hash: "abcdef1234567890" },
  ],
  checks: [
    { key: "access", label: "Connection access", status: "pass", detail: "USE CONNECTION granted" },
    { key: "dry_run", label: "Lakeflow dry run", status: "warn", detail: "1 column type widened" },
  ],
  forecast: FORECAST,
  timeline: [
    { at: t0, actor: "ana@example.com", action: "created", detail: "version 1" },
    { at: t1, actor: "ana@example.com", action: "submitted", detail: "for approval" },
  ],
  deployment: [],
  links: [{ label: "Destination schema", url: "https://example.cloud.databricks.com/explore/data/foundation/erp_sales" }],
  can: { edit: false, submit: false, approve: true, deploy: false, cancel: false },
  ...o,
});
const SPEC = {
  gateway: { name: "dis-req-1001-gateway", gateway_definition: { connection_name: "erp_pg" } },
  ingestion: { name: "dis-req-1001", ingestion_definition: { objects: [] } },
  job: { name: "dis-req-1001-schedule" },
  bundle_yaml: "resources:\n  pipelines:\n    dis_req_1001:\n      name: dis-req-1001\n",
};

const brandRoutes = (user: Me): Record<string, Reply> => ({ "GET /api/brand": [200, BRAND], "GET /api/me": [200, user] });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/requests/REQ-1001"]}>
      <BrandProvider>
        <Routes>
          <Route path="/requests/:id" element={<RequestDetail />} />
          <Route path="/new/:id" element={<div>edit page</div>} />
        </Routes>
      </BrandProvider>
    </MemoryRouter>,
  );
}

describe("RequestDetail", () => {
  it("renders the header, lifecycle, configuration, checks, forecast, links, timeline and versions", async () => {
    mockApi({ ...brandRoutes(me()), "GET /api/requests/REQ-1001": [200, detail()] });
    renderPage();
    expect(await screen.findByRole("heading", { name: "ERP orders to Foundation" })).toBeInTheDocument();
    expect(screen.getByText("REQ-1001")).toHaveClass("num");
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(screen.getByText("Guided form")).toBeInTheDocument();
    expect(screen.getAllByText("v2")).toHaveLength(2);
    expect(screen.getByRole("list", { name: "Progress" })).toHaveTextContent(/Draft.*Validation.*Approval.*Deployment.*Live/);

    const source = screen.getByRole("region", { name: "Source" });
    expect(within(source).getByText("erp_pg")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Schedule" })).getByText("Every 15 min")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Schema" })).getByText("Type 2 (keeps history)")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Destination" })).getByText("foundation.erp_sales")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Ownership" })).getByText("CC-4410")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Operations" })).getByText("Auto-retry, then a ticket")).toBeInTheDocument();
    expect(screen.getByText("sales.orders")).toBeInTheDocument();
    expect(screen.getByText("125.0k")).toBeInTheDocument();

    expect(screen.getByTestId("check-dry_run")).toHaveTextContent("Lakeflow dry run");
    expect(screen.getByTestId("forecast-cost")).toHaveTextContent("$1,234");
    expect(screen.getByText(/Based on 46 postgresql pipelines, 365 days/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Destination schema/ });
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText("submitted")).toBeInTheDocument();
    expect(screen.getByText("abcdef1234")).toBeInTheDocument();
    expect(screen.getAllByTestId("source-pill")[0]).toHaveTextContent("Live · Lakebase");
  });

  it("requires a reason to approve and POSTs it", async () => {
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": [200, detail()],
      "POST /api/requests/REQ-1001/approve": [200, detail({ can: { edit: false, submit: false, approve: false, deploy: true, cancel: true } }, "approved")],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve REQ-1001" });
    const reason = within(dialog).getByRole("textbox", { name: "Reason" });
    expect(reason).toHaveFocus();
    const confirm = within(dialog).getByRole("button", { name: "Approve" });
    expect(confirm).toBeDisabled();
    await user.type(reason, "ok");
    expect(confirm).toBeDisabled();
    await user.type(reason, " for finance");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toEqual({ method: "POST", url: "/api/requests/REQ-1001/approve", body: { reason: "ok for finance" } }));
    expect(await screen.findByRole("button", { name: "Deploy" })).toBeInTheDocument();
    expect(screen.getAllByText("Approved").length).toBeGreaterThan(0);
  });

  it("closes the reason modal with Escape without writing", async () => {
    const calls = mockApi({ ...brandRoutes(me()), "GET /api/requests/REQ-1001": [200, detail()] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    expect(await screen.findByRole("dialog", { name: "Reject REQ-1001" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("shows a reload hint when a write answers 409", async () => {
    let gets = 0;
    const calls = mockApi({
      ...brandRoutes(me({ is_approver: false })),
      "GET /api/requests/REQ-1001": () => { gets++; return [200, detail({ can: { edit: true, submit: true, approve: false, deploy: false, cancel: true } }, "draft")]; },
      "POST /api/requests/REQ-1001/submit": [409, { detail: "Version 3 was saved after you opened this page" }],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Submit for approval" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This request changed; reload");
    expect(alert).toHaveTextContent("Version 3 was saved after you opened this page");
    expect(screen.getByRole("heading", { name: "ERP orders to Foundation" })).toBeInTheDocument();
    const before = gets;
    await user.click(within(alert).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(gets).toBeGreaterThan(before));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("shows other write errors inline without losing the page", async () => {
    mockApi({
      ...brandRoutes(me({ is_approver: false })),
      "GET /api/requests/REQ-1001": [200, detail({ can: { edit: false, submit: false, approve: false, deploy: true, cancel: false } }, "approved")],
      "POST /api/requests/REQ-1001/deploy": [403, { detail: "Only approvers or admins can deploy" }],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Deploy" }));
    expect(await screen.findByText("Only approvers or admins can deploy")).toBeInTheDocument();
    expect(screen.queryByText(/This request changed/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deploy" })).toBeEnabled();
  });

  it("opens the spec drawer and renders the bundle YAML", async () => {
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": [200, detail()],
      "GET /api/requests/REQ-1001/spec": [200, SPEC],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "View spec" }));
    const drawer = await screen.findByRole("dialog", { name: "Spec · REQ-1001" });
    expect(await within(drawer).findByText(/dis-req-1001-gateway/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole("radio", { name: "Bundle YAML" }));
    expect(within(drawer).getByText(/resources:\s+pipelines:\s+dis_req_1001:/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole("button", { name: "Copy" }));
    expect(await within(drawer).findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/requests/REQ-1001/spec")).toBe(true);
  });

  it("re-validates and shows the new checks", async () => {
    const fresh = [{ key: "policy", label: "Refresh policy", status: "fail" as const, detail: "Below the 15 min minimum" }];
    let validated = false;
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": () => [200, validated ? detail({ checks: fresh }) : detail()],
      "POST /api/requests/REQ-1001/validate": () => { validated = true; return [200, { checks: fresh }]; },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Re-validate" }));
    expect(await screen.findByTestId("check-policy")).toHaveTextContent("Refresh policy");
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/requests/REQ-1001/validate")).toBe(true);
  });

  it("disables write actions in read-only mode", async () => {
    mockApi({ ...brandRoutes(me({ kiosk: true })), "GET /api/requests/REQ-1001": [200, detail()] });
    renderPage();
    const approve = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect(approve).toBeDisabled());
    expect(approve).toHaveAttribute("title", "Read-only mode");
    expect(screen.getByRole("button", { name: "Re-validate" })).toBeDisabled();
  });

  it("navigates to the editor on Edit", async () => {
    mockApi({
      ...brandRoutes(me({ is_approver: false })),
      "GET /api/requests/REQ-1001": [200, detail({ can: { edit: true, submit: false, approve: false, deploy: false, cancel: false } }, "rejected")],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByText("edit page")).toBeInTheDocument();
  });

  it("polls every 4 s while deploying until the status changes", async () => {
    let gets = 0;
    const deploying = detail({
      can: { edit: false, submit: false, approve: false, deploy: false, cancel: false },
      deployment: [
        { step: "Ingestion gateway", status: "done", detail: "gw-1", at: t1 },
        { step: "Ingestion pipeline", status: "running", detail: "", at: null },
      ],
    }, "deploying");
    const live: Detail = {
      ...deploying,
      request: { ...deploying.request, status: "live" },
      deployment: deploying.deployment.map((s) => ({ ...s, status: "done" as const })),
    };
    mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": () => [200, gets++ === 0 ? deploying : live],
    });
    renderPage();
    expect(await screen.findByTestId("deploy-step-Ingestion pipeline")).toHaveTextContent("Running");
    expect(await screen.findByText(/Live in Foundation/, undefined, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByTestId("deploy-step-Ingestion pipeline")).toHaveTextContent("Done");
    const after = gets;
    await new Promise((r) => setTimeout(r, 4300));
    expect(gets).toBe(after);
  }, 15000);

  it("shows an error with Retry when the request can't be loaded", async () => {
    let n = 0;
    mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": () => (n++ === 0 ? [500, { detail: "Lakebase unavailable" }] : [200, detail()]),
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("Couldn't load this")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "ERP orders to Foundation" })).toBeInTheDocument();
  });
});

// --- GxP, e-signature, access, promotion, ServiceNow ------------------------------------------------------------
const CAN0 = { edit: false, submit: false, approve: false, deploy: false, cancel: false };
const gxpDetail = (o: Partial<Detail> = {}, status: Detail["request"]["status"] = "pending_approval"): Detail => {
  const d = detail(o, status);
  return { ...d, request: { ...d.request, gxp: true, ticket_number: "REQ0010042" } };
};
const SIGS = [
  { signer: "olu@example.com", printed_name: "Olu Owner", meaning: "Approved", reason: "QA sign-off", signed_at: "2026-10-30T14:02:11+00:00",
    version: 2, config_hash: "c0ffee1234", manifest_hash: "feedbeef5678aaaa", intact: true },
  { signer: "eve@example.com", printed_name: "Eve Edit", meaning: "Reviewed", reason: "Second look", signed_at: "2026-10-30T15:00:00+00:00",
    version: 2, config_hash: "c0ffee1234", manifest_hash: "0000000000000000", intact: false },
];
const EVIDENCE = {
  id: 7, version: 2, verdict: "PASS_WITH_DEVIATIONS" as const, sha256: "ab12cd34ef56ab12cd34ef56ab12cd34ef56", volume_path: "/Volumes/gxp/evidence/REQ-1001-v2-oq.zip",
  created_by: "qa@example.com", created_at: t1,
  checks: [
    { key: "deploy.pipeline", label: "Pipeline deployed as specified", status: "pass" as const, detail: "pipeline p-1", requirement: "URS-02 deployment" },
    { key: "recon.match", label: "Reconciliation matches", status: "warn" as const, detail: "1 table pending", requirement: "URS-08 completeness" },
  ],
};
const ACCESS = {
  run_as: "app service principal (headless)", service_principal: "data-ingestion-service",
  source: { securable: "erp_pg", kind: "connection", who: "service principal only" },
  target: { tables: ["foundation.erp_sales.orders"], readers: ["ana@example.com", "group:finance-analysts"], privileges: ["USE CATALOG", "USE SCHEMA", "SELECT"] },
  grants: [{ principal: "ana@example.com", securable: "foundation.erp_sales.orders", privileges: "SELECT", status: "granted" as const, detail: "", at: t1 }],
};

describe("RequestDetail · GxP, access, promotion, ServiceNow", () => {
  it("asks for no signature when the request isn't GxP", async () => {
    mockApi({ ...brandRoutes(me()), "GET /api/requests/REQ-1001": [200, detail()] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve REQ-1001" });
    expect(within(dialog).queryByLabelText("Signing PIN")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/21 CFR Part 11/)).not.toBeInTheDocument();
  });

  it("signs a GxP approval: printed name prefilled, PIN 6-12 digits, POST {reason, signature}", async () => {
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": [200, gxpDetail({ can: { ...CAN0, approve: true, sign_required: true } })],
      "POST /api/requests/REQ-1001/approve": [200, gxpDetail({ can: CAN0 }, "approved")],
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("REQ0010042")).toBeInTheDocument();
    expect(screen.getByText("GxP")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve REQ-1001" });
    expect(within(dialog).getByText("Electronic signature (21 CFR Part 11)")).toBeInTheDocument();
    expect(within(dialog).getByTestId("esign-statement")).toHaveTextContent("the meaning “Released to Production”, bound to this version's configuration hash");
    const name = within(dialog).getByLabelText("Printed name");
    await waitFor(() => expect(name).toHaveValue("Olu Owner"));
    const pin = within(dialog).getByLabelText("Signing PIN");
    expect(pin).toHaveAttribute("type", "password");
    expect(pin).toHaveAttribute("inputmode", "numeric");
    const confirm = within(dialog).getByRole("button", { name: "Sign and approve" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "QA release for finance");
    expect(confirm).toBeDisabled();
    await user.type(pin, "1234");
    expect(within(dialog).getByText("The signing PIN is 6 to 12 digits.")).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    await user.type(pin, "56");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST", url: "/api/requests/REQ-1001/approve",
      body: { reason: "QA release for finance", signature: { pin: "123456", printed_name: "Olu Owner" } },
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows a wrong-PIN 403 inline, keeps the dialog open and clears the PIN", async () => {
    mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": [200, gxpDetail({ can: { ...CAN0, approve: true, sign_required: true } })],
      "POST /api/requests/REQ-1001/reject": [403, { detail: "Wrong signing PIN." }],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject REQ-1001" });
    expect(within(dialog).getByTestId("esign-statement")).toHaveTextContent("“Rejected”");
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Keys are missing");
    await user.type(within(dialog).getByLabelText("Signing PIN"), "999999");
    await user.click(within(dialog).getByRole("button", { name: "Sign and reject" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Signature not accepted");
    expect(alert).toHaveTextContent("Wrong signing PIN.");
    expect(alert).not.toHaveTextContent(/reload/i);
    expect(within(dialog).getByLabelText("Signing PIN")).toHaveValue("");
    expect(screen.getByRole("dialog", { name: "Reject REQ-1001" })).toBeInTheDocument();
  });

  it("explains a missing PIN (409) as 'set your signing PIN first'", async () => {
    mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": [200, gxpDetail({ can: { ...CAN0, approve: true, sign_required: true } })],
      "POST /api/requests/REQ-1001/approve": [409, { detail: "Set your signing PIN first (your initials menu, top right)." }],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve REQ-1001" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Release it");
    await user.type(within(dialog).getByLabelText("Signing PIN"), "123456");
    await user.click(within(dialog).getByRole("button", { name: "Sign and approve" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Set your signing PIN first");
    expect(within(alert).queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
  });

  it("renders the GxP card (verdict, checks, signatures) and runs a qualification", async () => {
    let gets = 0;
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": () => { gets++; return [200, gxpDetail({
        can: { ...CAN0, qualify: true, sign_required: true }, gxp: { enabled: true, signatures: SIGS, evidence: EVIDENCE } }, "live")]; },
      "POST /api/requests/REQ-1001/qualify": [200, { verdict: "PASS", checks: [], id: 8, sha256: "x", volume_path: null }],
    });
    const user = userEvent.setup();
    renderPage();
    const card = await screen.findByTestId("gxp-card");
    expect(within(card).getByText("PASS WITH DEVIATIONS")).toBeInTheDocument();
    expect(within(card).getByText(/run by qa@example.com/)).toBeInTheDocument();
    expect(within(card).getByText("ab12cd34ef56ab12")).toHaveClass("num");
    expect(within(card).getByText("/Volumes/gxp/evidence/REQ-1001-v2-oq.zip")).toBeInTheDocument();
    expect(within(card).getByTestId("check-recon.match")).toHaveTextContent("Reconciliation matches");
    expect(within(card).getByText("URS-08 completeness")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /Download evidence/ })).toHaveAttribute("href", "/api/requests/REQ-1001/evidence");
    const sigs = within(card).getByRole("table", { name: "Electronic signatures" });
    expect(within(sigs).getByText("Olu Owner")).toBeInTheDocument();
    expect(within(sigs).getByText("2026-10-30 14:02:11 UTC")).toBeInTheDocument();
    expect(within(sigs).getByText("Intact")).toBeInTheDocument();
    expect(within(sigs).getByText("Broken")).toBeInTheDocument();

    const before = gets;
    await user.click(within(card).getByRole("button", { name: "Run qualification" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/requests/REQ-1001/qualify")).toBe(true));
    await waitFor(() => expect(gets).toBeGreaterThan(before));
  });

  it("disables Run qualification in read-only mode", async () => {
    mockApi({
      ...brandRoutes(me({ kiosk: true })),
      "GET /api/requests/REQ-1001": [200, gxpDetail({ can: { ...CAN0, qualify: true }, gxp: { enabled: true, signatures: [], evidence: null } }, "live")],
    });
    renderPage();
    const run = await within(await screen.findByTestId("gxp-card")).findByRole("button", { name: "Run qualification" });
    await waitFor(() => expect(run).toBeDisabled());
    expect(run).toHaveAttribute("title", "Read-only mode");
    expect(screen.getByText(/No qualification run yet/)).toBeInTheDocument();
  });

  it("verifies access and previews data as the user", async () => {
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": [200, detail({ access: ACCESS }, "live")],
      "GET /api/requests/REQ-1001/access?verify=true": [200, { ...ACCESS, checks: [
        { key: "access.target_read_only", label: "People have read-only access to the landed tables", status: "pass", detail: "SELECT only." },
      ] }],
      "GET /api/requests/REQ-1001/preview": [200, { table: "foundation.erp_sales.orders", tables: ["foundation.erp_sales.orders"], as_user: "owner@example.com",
        columns: ["order_id", "amount", "note"], rows: [{ order_id: 1, amount: 12.5, note: null }, { order_id: 2, amount: 7, note: "rush" }] }],
    });
    const user = userEvent.setup();
    renderPage();
    const card = await screen.findByTestId("access-card");
    expect(within(card).getByText("app service principal (headless)")).toBeInTheDocument();
    expect(within(card).getByText("erp_pg")).toBeInTheDocument();
    expect(within(card).getAllByText("service principal only").length).toBeGreaterThan(0);
    expect(within(within(card).getByRole("list", { name: "Target tables" })).getByText("foundation.erp_sales.orders")).toHaveClass("num");
    expect(within(card).getByText("group:finance-analysts")).toBeInTheDocument();
    expect(within(card).getByText("USE SCHEMA")).toBeInTheDocument();
    expect(within(within(card).getByRole("table", { name: "Grants" })).getByText("granted")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Verify access" }));
    expect(await within(card).findByTestId("check-access.target_read_only")).toHaveTextContent("read-only");
    await user.click(within(card).getByRole("button", { name: "Preview data as me" }));
    const caption = await within(card).findByText("Read with your own permissions (on-behalf-of) — this query is attributed to you");
    const table = caption.closest("table")!;
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["order_id", "amount", "note"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("rush")).toBeInTheDocument();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("shows a 403 preview as a calm message, not an error page", async () => {
    mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": [200, detail({ access: ACCESS }, "live")],
      "GET /api/requests/REQ-1001/preview": [403, { detail: "You don't have read access to foundation.erp_sales.orders yet" }],
    });
    const user = userEvent.setup();
    renderPage();
    const card = await screen.findByTestId("access-card");
    await user.click(within(card).getByRole("button", { name: "Preview data as me" }));
    const msg = await within(card).findByRole("status");
    expect(msg).toHaveTextContent("You don't have read access to foundation.erp_sales.orders yet");
    expect(screen.queryByText("Couldn't load this")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ERP orders to Foundation" })).toBeInTheDocument();
  });

  it("promotes after confirming, POSTs {to} and opens the new request", async () => {
    const base = detail({ can: { ...CAN0, promote: true }, next_env: "uat" }, "live");
    const devCfg = { ...base, config: { ...CONFIG, destination: { ...CONFIG.destination, environment: "dev" as const } } };
    const promoted: Detail = {
      ...detail({ can: { ...CAN0, edit: true, submit: true }, lineage: { parent_id: "REQ-1001", children: [] } }, "draft"),
      request: { ...detail().request, id: "REQ-1002", status: "draft", parent_id: "REQ-1001" },
    };
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": [200, devCfg],
      "POST /api/requests/REQ-1001/promote": [200, promoted],
      "GET /api/requests/REQ-1002": [200, promoted],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Promote to UAT" }));
    const dialog = await screen.findByRole("dialog", { name: "Promote to UAT" });
    expect(dialog).toHaveTextContent("Copies the approved configuration to UAT as a new request that needs its own approval; GxP requests need a passing qualification first");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Promote to UAT" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toEqual({ method: "POST", url: "/api/requests/REQ-1001/promote", body: { to: "uat" } }));
    expect(await screen.findByText("REQ-1002")).toBeInTheDocument();
    const lineage = screen.getByTestId("lineage");
    expect(within(lineage).getByRole("link", { name: "REQ-1001" })).toHaveAttribute("href", "/requests/REQ-1001");
  });

  it("shows a promotion 409 inline in the dialog", async () => {
    mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": [200, gxpDetail({ can: { ...CAN0, promote: true }, next_env: "prod" }, "live")],
      "POST /api/requests/REQ-1001/promote": [409, { detail: "GxP promotion needs a PASS qualification run on the current version first (Run qualification)." }],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Promote to Production" }));
    const dialog = await screen.findByRole("dialog", { name: "Promote to Production" });
    await user.click(within(dialog).getByRole("button", { name: "Promote to Production" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Can't promote yet");
    expect(alert).toHaveTextContent("needs a PASS qualification run");
  });

  it("lists ServiceNow records with the Simulator badge", async () => {
    mockApi({
      ...brandRoutes(me()),
      "GET /api/requests/REQ-1001": [200, detail({
        itsm_mode: "simulator",
        itsm: [
          { kind: "request", table_name: "sc_request", sys_id: "a1b2c3d4e5", number: "REQ0010042", url: null, state: "pending_approval", synced_at: t1 },
          { kind: "incident", table_name: "incident", sys_id: "f6e5d4c3b2", number: "INC0000017", url: "https://acme.service-now.com/nav_to.do?uri=incident.do?sys_id=f6e5d4c3b2", state: "New", synced_at: t1 },
        ],
      })],
    });
    renderPage();
    const card = await screen.findByTestId("servicenow-card");
    expect(within(card).getByText("REQ0010042")).toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: /REQ0010042/ })).not.toBeInTheDocument();
    const inc = within(card).getByRole("link", { name: /INC0000017/ });
    expect(inc).toHaveAttribute("target", "_blank");
    expect(inc).toHaveAttribute("href", expect.stringContaining("incident.do"));
    expect(within(card).getByText("Incident")).toBeInTheDocument();
    expect(within(card).getAllByText(/synced 2 h ago/)).toHaveLength(2);
    const sim = within(card).getByText("Simulator");
    expect(sim.closest("[title]")).toHaveAttribute("title", "No ServiceNow instance configured: the built-in Table API simulator is used");
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import type { Me } from "@/lib/types";
import Admin from "./Admin";

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
  email: "root@example.com", name: "Rae Root", is_admin: true, is_approver: true, approver_scopes: ["domain:*"], kiosk: false, ...o,
});
const when = "2026-10-01T09:00:00Z";
const ADMINS = { source: "lakebase", items: [
  { email: "root@example.com", source: "deployer", granted_by: null, granted_at: null, reason: null, removable: false },
  { email: "bea@example.com", source: "granted", granted_by: "root@example.com", granted_at: when, reason: "Platform on-call", removable: true },
] };
const USERS = { source: "workspace", items: [
  { email: "jane@example.com", name: "Jane Doe", active: true },
  { email: "root@example.com", name: "Rae Root", active: true },
] };
const brandRoutes = (user: Me): Record<string, Reply> => ({ "GET /api/brand": [200, BRAND], "GET /api/me": [200, user] });

function renderPage(entry = "/admin") {
  return render(<MemoryRouter initialEntries={[entry]}><BrandProvider><Admin /></BrandProvider></MemoryRouter>);
}

describe("Admin", () => {
  it("shows a polite admins-only state to everyone else", async () => {
    const calls = mockApi(brandRoutes(me({ is_admin: false })));
    renderPage();
    expect(await screen.findByText("Administrators only")).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith("/api/admin"))).toBe(false);
  });

  it("lists administrators; revoke only where removable", async () => {
    mockApi({ ...brandRoutes(me()), "GET /api/admin/admins": [200, ADMINS] });
    renderPage();
    const bea = await screen.findByTestId("admin-bea@example.com");
    expect(within(bea).getByText(/granted by root@example.com on/)).toBeInTheDocument();
    expect(within(bea).getByText("Platform on-call")).toBeInTheDocument();
    expect(within(bea).getByRole("button", { name: "Revoke bea@example.com" })).toBeInTheDocument();
    const root = screen.getByTestId("admin-root@example.com");
    expect(within(root).getByText("Deployer")).toBeInTheDocument();
    expect(within(root).getByText("you")).toBeInTheDocument();
    expect(within(root).queryByRole("button", { name: /Revoke/ })).not.toBeInTheDocument();
    expect(within(root).getByText("Protected")).toBeInTheDocument();
    expect(screen.getByTestId("source-pill")).toHaveTextContent("Live · Lakebase");
  });

  it("adds an admin from the directory: reason required, confirm, then POST {email, reason}", async () => {
    let added = false;
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/admin/admins": () => [200, added ? { ...ADMINS, items: [...ADMINS.items, { email: "jane@example.com", source: "granted", granted_by: "root@example.com", granted_at: when, reason: "Ingestion on-call", removable: true }] } : ADMINS],
      "GET /api/admin/workspace-users?q=jan": [200, USERS],
      "GET /api/admin/workspace-users?q=jane%40example.com": [200, { source: "workspace", items: [USERS.items[0]] }],
      "POST /api/admin/admins": () => { added = true; return [200, { ok: true }]; },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("admin-bea@example.com");
    const form = screen.getByRole("region", { name: "Add admin" });
    await user.type(within(form).getByRole("combobox", { name: "Person" }), "jan");
    const jane = await within(form).findByRole("option", { name: /Jane Doe/ });
    expect(within(form).getByRole("option", { name: /Rae Root/ })).toHaveAttribute("aria-disabled", "true");
    expect(within(form).getByText("already an administrator")).toBeInTheDocument();
    await user.click(jane);
    expect(within(form).getByRole("combobox", { name: "Person" })).toHaveValue("jane@example.com");

    const add = within(form).getByRole("button", { name: "Add admin" });
    expect(add).toBeDisabled();
    await user.type(within(form).getByRole("textbox", { name: "Reason" }), "Ingestion on-call");
    expect(add).toBeEnabled();
    await user.click(add);
    const dialog = await screen.findByRole("dialog", { name: "Grant administrator access" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST", url: "/api/admin/admins", body: { email: "jane@example.com", reason: "Ingestion on-call" },
    }));
    expect(await screen.findByText("jane@example.com is now an administrator.")).toBeInTheDocument();
    expect(await screen.findByTestId("admin-jane@example.com")).toBeInTheDocument();
  });

  it("accepts a typed email that isn't in the directory yet, with a hint", async () => {
    mockApi({
      ...brandRoutes(me()),
      "GET /api/admin/admins": [200, ADMINS],
      "GET /api/admin/workspace-users?q=new.person%40example.com": [200, { source: "workspace", items: [] }],
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("admin-bea@example.com");
    const form = screen.getByRole("region", { name: "Add admin" });
    await user.type(within(form).getByRole("combobox", { name: "Person" }), "new.person@example.com");
    expect(await within(form).findByText(/not found in the workspace directory yet: they can sign in once they are a workspace user/i)).toBeInTheDocument();
    await user.type(within(form).getByRole("textbox", { name: "Reason" }), "New platform lead");
    expect(within(form).getByRole("button", { name: "Add admin" })).toBeEnabled();
  });

  it("shows a 409 on revoke inline in the dialog", async () => {
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/admin/admins": [200, ADMINS],
      "DELETE /api/admin/admins/bea%40example.com": [409, { detail: "Can't revoke the last granted administrator" }],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Revoke bea@example.com" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke bea@example.com" });
    const reason = within(dialog).getByRole("textbox", { name: "Reason" });
    expect(reason).toHaveFocus();
    const confirm = within(dialog).getByRole("button", { name: "Revoke access" });
    expect(confirm).toBeDisabled();
    await user.type(reason, "Left the team");
    await user.click(confirm);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Can't revoke the last granted administrator");
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ reason: "Left the team" });
    expect(screen.getByRole("dialog", { name: "Revoke bea@example.com" })).toBeInTheDocument();
  });

  it("adds a data owner for one domain", async () => {
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/admin/approvers": [200, { source: "lakebase", items: [
        { email: "fin@example.com", scope: "domain:finance", granted_by: "root@example.com", granted_at: when, reason: "Finance steward" },
      ] }],
      "GET /api/admin/workspace-users?q=jan": [200, USERS],
      "POST /api/admin/approvers": [200, { ok: true }],
    });
    const user = userEvent.setup();
    renderPage("/admin?tab=approvers");
    expect(await screen.findByText("fin@example.com")).toBeInTheDocument();
    const form = screen.getByRole("region", { name: "Add data owner" });
    await user.type(within(form).getByRole("combobox", { name: "Person" }), "jan");
    await user.click(await within(form).findByRole("option", { name: /Jane Doe/ }));
    await user.type(within(form).getByRole("combobox", { name: "Domain" }), "finance");
    expect(within(form).getByText("domain:finance")).toBeInTheDocument();
    await user.type(within(form).getByRole("textbox", { name: "Reason" }), "Second finance steward");
    await user.click(within(form).getByRole("button", { name: "Add data owner" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Add a data owner" })).getByRole("button", { name: "Grant approval rights" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ email: "jane@example.com", scope: "domain:finance", reason: "Second finance steward" }));
  });

  it("edits policies inline by type and validates JSON", async () => {
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/admin/policies": [200, { source: "lakebase", items: [
        { key: "min_interval_minutes", label: "Minimum refresh", description: "Shortest allowed schedule", value: 15, updated_by: "root@example.com", updated_at: when },
        { key: "require_reconciliation", label: "Require reconciliation", description: "", value: true, updated_by: null, updated_at: null },
        { key: "allowed_connectors", label: "Allowed connectors", description: "", value: ["postgresql", "salesforce"], updated_by: null, updated_at: null },
        { key: "cost_caps", label: "Cost caps", description: "Per environment", value: { dev: 200, prod: 2000 }, updated_by: null, updated_at: null },
      ] }],
      "PUT /api/admin/policies/min_interval_minutes": (b) => [200, { key: "min_interval_minutes", label: "Minimum refresh", description: "Shortest allowed schedule", value: (b as { value: number }).value, updated_by: "root@example.com", updated_at: new Date().toISOString() }],
    });
    const user = userEvent.setup();
    renderPage("/admin?tab=policies");
    const min = await screen.findByRole("spinbutton", { name: "Minimum refresh" });
    expect(screen.getByRole("switch", { name: "Require reconciliation" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: "Allowed connectors" })).toHaveValue("postgresql, salesforce");
    expect(screen.getByText(/updated by root@example.com/)).toBeInTheDocument();

    await user.clear(min);
    await user.type(min, "30");
    await user.click(screen.getByRole("button", { name: "Save Minimum refresh" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toEqual({ method: "PUT", url: "/api/admin/policies/min_interval_minutes", body: { value: 30 } }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save Minimum refresh" })).not.toBeInTheDocument());

    const caps = screen.getByRole("textbox", { name: "Cost caps" });
    await user.clear(caps);
    await user.type(caps, "{{ broken");
    expect(within(screen.getByTestId("policy-cost_caps")).getByRole("alert")).toHaveTextContent("Invalid JSON");
    expect(screen.getByRole("button", { name: "Save Cost caps" })).toBeDisabled();
  });

  it("filters the audit trail", async () => {
    mockApi({
      ...brandRoutes(me()),
      "GET /api/admin/audit?limit=200": [200, { items: [
        { at: when, actor: "root@example.com", action: "admin.grant", entity: "admin", entity_id: "bea@example.com", detail: { reason: "Platform on-call" } },
        { at: when, actor: "fin@example.com", action: "request.approve", entity: "request", entity_id: "REQ-1001", detail: "ok for finance" },
      ] }],
    });
    const user = userEvent.setup();
    renderPage("/admin?tab=audit");
    expect(await screen.findByText("request.approve")).toBeInTheDocument();
    expect(screen.getByText("2 events")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Filter audit events" }), "on-call");
    expect(screen.getByText("admin.grant")).toBeInTheDocument();
    expect(screen.queryByText("request.approve")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2 events")).toBeInTheDocument();
  });

  it("shows an error with Retry when a section fails, and switches tabs", async () => {
    let n = 0;
    mockApi({
      ...brandRoutes(me()),
      "GET /api/admin/admins": () => (n++ === 0 ? [500, { detail: "Lakebase unavailable" }] : [200, ADMINS]),
      "GET /api/admin/audit?limit=200": [200, { items: [] }],
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("Lakebase unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("admin-bea@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Audit" }));
    expect(await screen.findByText("No audit events yet")).toBeInTheDocument();
  });
});

const usage = (days: number, rows: Record<string, unknown>[]) => ({
  source: "lakebase", days, otel: { enabled: days === 30 },
  totals: { users: rows.length, api_calls: rows.reduce((a, r) => a + Number(r.api_calls ?? 0), 0), sessions: rows.reduce((a, r) => a + Number(r.sessions ?? 0), 0) },
  daily: [{ day: "2026-10-30", calls: 140, users: 3 }, { day: "2026-10-31", calls: 96, users: 2 }],
  users: rows,
});
const U30 = [
  { user_email: "ana@example.com", sessions: 6, api_calls: 1840, obo_calls: 1200, obo_queries: 14, avg_ms: 42.5, last_seen: new Date(Date.now() - 3600 * 1000).toISOString(),
    actions: { "request.create": 3, "request.approve": 1, "esign.sign": 1 }, requests: 4, live: 2, forecast_month_usd: 1234.5, cost_mtd_usd: 310.2, wh_queries: 22 },
  { user_email: "bo@example.com", sessions: 1, api_calls: 12, actions: {} },
];

describe("Admin · usage and integrations", () => {
  it("shows usage totals, the OTel badge and the per-user table; switching the window refetches", async () => {
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/admin/usage?days=30": [200, usage(30, U30)],
      "GET /api/admin/usage?days=7": [200, usage(7, [U30[1]])],
    });
    const user = userEvent.setup();
    renderPage("/admin?tab=usage");
    const ana = await screen.findByTestId("usage-ana@example.com");
    expect(screen.getByTestId("usage-users")).toHaveTextContent("2");
    expect(screen.getByTestId("usage-sessions")).toHaveTextContent("7");
    expect(screen.getByTestId("usage-calls")).toHaveTextContent("1,852");
    expect(screen.getByText("OpenTelemetry export on")).toBeInTheDocument();
    expect(screen.getByText(/signed-in identity Databricks Apps forwards/)).toHaveTextContent("system.query.history");
    expect(screen.getByTestId("source-pill")).toHaveTextContent("Live · Lakebase");
    const cells = within(ana).getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toEqual(["ana@example.com", "6", "1,840", "1,200", "14", "42.5", "4", "2", "$1,235", "$310", "22", "create 3 · approve 1 · sign 1", "1 h ago"]);
    expect(within(screen.getByTestId("usage-bo@example.com")).getAllByRole("cell").at(-2)).toHaveTextContent("—");
    expect(screen.getByRole("figure", { name: "Chart of daily API calls and users" })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "7 days" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/admin/usage?days=7")).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("usage-ana@example.com")).not.toBeInTheDocument());
    expect(screen.getByTestId("usage-bo@example.com")).toBeInTheDocument();
    expect(screen.getByText("OpenTelemetry export off")).toBeInTheDocument();
  });

  it("shows the ServiceNow status and resets a signing PIN: reason required, confirm, DELETE {reason}", async () => {
    const calls = mockApi({
      ...brandRoutes(me()),
      "GET /api/itsm/status": [200, { mode: "simulator", instance: null, request_table: "sc_request", incident_table: "incident", assignment_group: "Data Platform" }],
      "DELETE /api/admin/signers/bea%40example.com/pin": [200, { ok: true }],
    });
    const user = userEvent.setup();
    renderPage("/admin?tab=integrations");
    const snow = await screen.findByRole("region", { name: "ServiceNow" });
    expect(await within(snow).findByText("Simulator")).toBeInTheDocument();
    expect(within(snow).getByText("sc_request")).toBeInTheDocument();
    expect(within(snow).getByText("Data Platform")).toBeInTheDocument();
    expect(within(snow).getByText("Built-in Table API simulator")).toBeInTheDocument();

    const pins = screen.getByRole("region", { name: "Signing PINs" });
    expect(within(pins).getByText("Resets only; nobody can see or set another person's PIN.")).toBeInTheDocument();
    const reset = within(pins).getByRole("button", { name: "Reset PIN" });
    await user.type(within(pins).getByRole("textbox", { name: "Signer email" }), "bea@example.com");
    expect(reset).toBeDisabled();
    await user.type(within(pins).getByRole("textbox", { name: "Reason" }), "ok");
    expect(reset).toBeDisabled();
    await user.type(within(pins).getByRole("textbox", { name: "Reason" }), " forgot PIN, identity confirmed");
    expect(reset).toBeEnabled();
    await user.click(reset);
    const dialog = await screen.findByRole("dialog", { name: "Reset the signing PIN for bea@example.com" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Reset PIN" }));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")).toEqual({
      method: "DELETE", url: "/api/admin/signers/bea%40example.com/pin", body: { reason: "ok forgot PIN, identity confirmed" },
    }));
    expect(await within(pins).findByRole("status")).toHaveTextContent("The signing PIN for bea@example.com was reset.");
  });

  it("shows a reset 409 inline in the confirm dialog", async () => {
    mockApi({
      ...brandRoutes(me()),
      "GET /api/itsm/status": [200, { mode: "rest", instance: "https://acme.service-now.com", request_table: "sc_request", incident_table: "incident", assignment_group: null }],
      "DELETE /api/admin/signers/zed%40example.com/pin": [409, { detail: "zed@example.com has no signing PIN." }],
    });
    const user = userEvent.setup();
    renderPage("/admin?tab=integrations");
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    const pins = screen.getByRole("region", { name: "Signing PINs" });
    await user.type(within(pins).getByRole("textbox", { name: "Signer email" }), "zed@example.com");
    await user.type(within(pins).getByRole("textbox", { name: "Reason" }), "Locked out twice");
    await user.click(within(pins).getByRole("button", { name: "Reset PIN" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset the signing PIN for zed@example.com" });
    await user.click(within(dialog).getByRole("button", { name: "Reset PIN" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("zed@example.com has no signing PIN.");
  });
});

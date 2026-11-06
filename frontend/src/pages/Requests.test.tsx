import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import type { IngestRequest, Me } from "@/lib/types";
import Requests from "./Requests";

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
  email: "ana@example.com", name: "Ana Diaz", is_admin: false, is_approver: false, approver_scopes: [], kiosk: false, ...o,
});
const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const req = (o: Partial<IngestRequest> = {}): IngestRequest => ({
  id: "REQ-1001", title: "ERP orders", status: "draft", channel: "app", requester: "ana@example.com", owner: "ana@example.com",
  classification: "internal", environment: "dev", connector: "postgresql", pattern: "cdc", n_objects: 3, version: 1,
  created_at: recent, updated_at: recent, pipeline_id: null, gateway_id: null, job_id: null, forecast_month_usd: 42, sla_minutes: 60, ...o,
});

function base(user: Me): Record<string, Reply> {
  return { "GET /api/brand": [200, BRAND], "GET /api/me": [200, user] };
}

function renderPage(entry = "/requests") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <BrandProvider>
        <Routes>
          <Route path="/requests" element={<Requests />} />
          <Route path="/requests/:id" element={<div>detail page</div>} />
          <Route path="/new" element={<div>new page</div>} />
        </Routes>
      </BrandProvider>
    </MemoryRouter>,
  );
}

describe("Requests", () => {
  it("lists my requests in a table with the source pill, and opens a row", async () => {
    mockApi({
      ...base(me({ is_approver: true })),
      "GET /api/requests?scope=mine": [200, { source: "lakebase", items: [req(), req({ id: "REQ-1002", title: "Salesforce accounts", status: "live", connector: "salesforce", pattern: "saas", environment: "prod", forecast_month_usd: 310 })] }],
      "GET /api/requests?scope=approvals": [200, { source: "lakebase", items: [req({ id: "REQ-2001", status: "pending_approval" }), req({ id: "REQ-2002", status: "approved" })] }],
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("ERP orders")).toBeInTheDocument();
    expect(screen.getByText("REQ-1001")).toHaveClass("num");
    expect(screen.getByText("Salesforce accounts")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("$310")).toBeInTheDocument();
    expect(screen.getByTestId("source-pill")).toHaveTextContent("Live · Lakebase");
    expect(await screen.findByRole("radio", { name: /Approvals.*1.*pending/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "All" })).not.toBeInTheDocument();

    await user.click(within(screen.getByTestId("request-row-REQ-1002")).getByText("prod"));
    expect(await screen.findByText("detail page")).toBeInTheDocument();
  });

  it("hides the Approvals tab from people who are not approvers", async () => {
    const calls = mockApi({
      ...base(me()),
      "GET /api/requests?scope=mine": [200, { source: "lakebase", items: [req()] }],
    });
    renderPage("/requests?scope=approvals");
    expect(await screen.findByText("ERP orders")).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/me")).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByRole("radio", { name: "Mine" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Approvals/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "All" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("scope=approvals"))).toBe(false);
  });

  it("gives admins an All tab that loads every request", async () => {
    const calls = mockApi({
      ...base(me({ is_admin: true })),
      "GET /api/requests?scope=mine": [200, { source: "lakebase", items: [] }],
      "GET /api/requests?scope=approvals": [200, { source: "lakebase", items: [] }],
      "GET /api/requests?scope=all": [200, { source: "warehouse", items: [req({ id: "REQ-3001", title: "Workday workers", requester: "bo@example.com" })] }],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("radio", { name: "All" }));
    expect(await screen.findByText("Workday workers")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/requests?scope=all")).toBe(true);
    expect(screen.getByTestId("source-pill")).toHaveTextContent("Lakehouse");
  });

  it("filters client-side by text and by status", async () => {
    mockApi({
      ...base(me()),
      "GET /api/requests?scope=mine": [200, { source: "lakebase", items: [
        req(), req({ id: "REQ-1002", title: "Salesforce accounts", status: "live", connector: "salesforce" }),
        req({ id: "REQ-1003", title: "HR people", status: "rejected", connector: "workday" }),
      ] }],
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("ERP orders");

    await user.type(screen.getByRole("searchbox", { name: "Search requests" }), "workday");
    expect(screen.getByText("HR people")).toBeInTheDocument();
    expect(screen.queryByText("ERP orders")).not.toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "Search requests" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by status" }), "live");
    expect(screen.getByText("Salesforce accounts")).toBeInTheDocument();
    expect(screen.queryByText("HR people")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3 requests")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search requests" }), "nothing-like-this");
    expect(screen.getByText("No requests match these filters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("HR people")).toBeInTheDocument();
  });

  it("shows an empty state per tab", async () => {
    mockApi({
      ...base(me({ is_approver: true })),
      "GET /api/requests?scope=mine": [200, { source: "lakebase", items: [] }],
      "GET /api/requests?scope=approvals": [200, { source: "lakebase", items: [] }],
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("You haven't requested any ingestion yet")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "New request" })[1]);
    expect(await screen.findByText("new page")).toBeInTheDocument();
  });

  it("shows the approvals empty state", async () => {
    mockApi({
      ...base(me({ is_approver: true })),
      "GET /api/requests?scope=mine": [200, { source: "lakebase", items: [] }],
      "GET /api/requests?scope=approvals": [200, { source: "lakebase", items: [] }],
    });
    renderPage("/requests?scope=approvals");
    expect(await screen.findByText("Nothing is waiting for your approval")).toBeInTheDocument();
  });

  it("shows an error with Retry when the list fails, and recovers", async () => {
    let n = 0;
    mockApi({
      ...base(me()),
      "GET /api/requests?scope=mine": () => (n++ === 0 ? [500, { detail: "store unavailable" }] : [200, { source: "synthetic", items: [req()] }]),
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("Couldn't load this")).toBeInTheDocument();
    expect(screen.getByText("store unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("ERP orders")).toBeInTheDocument();
    expect(screen.getByTestId("source-pill")).toHaveTextContent("Synthetic");
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import type { Brand, Connector, Me } from "@/lib/types";
import Connectors from "./Connectors";

type Reply = { status?: number; body: unknown };
type RouteMap = Record<string, Reply | ((init?: RequestInit) => Reply)>;

const BRAND: Brand = {
  key: "databricks", company: "Databricks", product: "Data Ingestion Service",
  hero_title: "Welcome to Data Ingestion Service", hero_subtitle: "Governed ingestion into Foundation.",
  destination_label: "Foundation", logo_url: null, powered_by: "Powered by Databricks Lakeflow Connect",
  palette: { brand_h: 262, brand_s: "58%" },
};
const USER: Me = { email: "ana@example.com", name: "Ana", is_admin: false, is_approver: false, approver_scopes: [], kiosk: false };
const ADMIN: Me = { ...USER, email: "admin@example.com", is_admin: true };

function mockFetch(routes: RouteMap, me: Me = USER) {
  const all: RouteMap = { "GET /api/brand": { body: BRAND }, "GET /api/me": { body: me }, ...routes };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`;
    const r = all[key];
    const reply = typeof r === "function" ? r(init) : r ?? { status: 404, body: { detail: `unmocked ${key}` } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  });
}

const cap = (o: Partial<Connector["capabilities"]> = {}): Connector["capabilities"] =>
  ({ hard_deletes: false, scd2: false, min_interval_minutes: 5, needs_gateway: false, incremental: true, ...o });

const ITEMS: Connector[] = [
  { id: "postgresql", name: "PostgreSQL", category: "database", patterns: ["cdc", "query"], status: "supported", connection_type: "POSTGRESQL",
    capabilities: cap({ hard_deletes: true, scd2: true, needs_gateway: true }), description: "Change data capture from PostgreSQL.", enabled: true, history_pipelines: 18 },
  { id: "salesforce", name: "Salesforce", category: "saas", patterns: ["saas"], status: "supported", connection_type: "SALESFORCE",
    capabilities: cap({ scd2: true, min_interval_minutes: 15 }), description: "Objects from Salesforce Sales Cloud.", enabled: true, history_pipelines: 46 },
  { id: "workday", name: "Workday Reports", category: "saas", patterns: ["saas"], status: "preview", connection_type: "WORKDAY_RAAS",
    capabilities: cap(), description: "Report-as-a-service extracts.", enabled: false },
  { id: "kafka", name: "Kafka", category: "streaming", patterns: ["stream"], status: "extension", connection_type: null,
    capabilities: cap({ min_interval_minutes: 0 }), description: "Topics from a Kafka cluster.", enabled: true, history_pipelines: 0 },
];

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}{loc.search}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/connectors"]}>
      <BrandProvider>
        <Routes>
          <Route path="/connectors" element={<Connectors />} />
          <Route path="/assistant" element={<Where />} />
        </Routes>
      </BrandProvider>
    </MemoryRouter>,
  );
}

describe("Connectors", () => {
  it("groups connectors by category with patterns, capabilities, history and status", async () => {
    mockFetch({ "GET /api/connectors": { body: { source: "lakebase", items: ITEMS } } });
    renderPage();
    const dbs = await screen.findByRole("region", { name: /Databases/ });
    const pg = within(dbs).getByRole("article", { name: "PostgreSQL" });
    expect(within(pg).getByText("CDC")).toBeInTheDocument();
    expect(within(pg).getByText("Query-based")).toBeInTheDocument();
    expect(within(pg).getByText("Hard deletes")).toBeInTheDocument();
    expect(within(pg).getByText("SCD type 2")).toBeInTheDocument();
    expect(within(pg).getByText("Ingestion gateway")).toBeInTheDocument();
    expect(within(pg).getByText(/learned from 18 pipelines/)).toBeInTheDocument();
    expect(within(pg).getByText("Supported")).toBeInTheDocument();
    const saas = screen.getByRole("region", { name: /SaaS applications/ });
    expect(within(saas).getAllByRole("article")).toHaveLength(2);
    expect(within(saas).getByText("Min interval 15 min")).toBeInTheDocument();
    const wd = within(saas).getByRole("article", { name: "Workday Reports" });
    expect(within(wd).getByText("Disabled")).toBeInTheDocument();
    expect(within(wd).queryByText(/learned from/)).toBeNull();
    expect(screen.getByTestId("source-pill")).toHaveTextContent("Live · Lakebase");
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("filters by search and status, with an empty state that clears filters", async () => {
    mockFetch({ "GET /api/connectors": { body: { source: "lakebase", items: ITEMS } } });
    renderPage();
    await screen.findByRole("article", { name: "PostgreSQL" });
    await userEvent.click(screen.getByRole("radio", { name: /Preview/ }));
    await waitFor(() => expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["Workday Reports"]));
    await userEvent.click(screen.getByRole("radio", { name: /All/ }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search connectors" }), "sales");
    await waitFor(() => expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["Salesforce"]));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search connectors" }), "zzz");
    expect(await screen.findByText("No connectors match")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(4));
  });

  it("routes Request extension to the assistant with the connector", async () => {
    mockFetch({ "GET /api/connectors": { body: { source: "lakebase", items: ITEMS } } });
    renderPage();
    const kafka = await screen.findByRole("article", { name: "Kafka" });
    expect(within(kafka).getByText(/adds a reusable extension when a new pattern needs support/)).toBeInTheDocument();
    await userEvent.click(within(kafka).getByRole("button", { name: "Request extension" }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/assistant?ask=Kafka");
  });

  it("lets an admin disable a connector with PUT", async () => {
    const spy = mockFetch({
      "GET /api/connectors": { body: { source: "lakebase", items: ITEMS } },
      "PUT /api/connectors/postgresql": (init) => ({ body: { ...ITEMS[0], ...JSON.parse(String(init?.body)) } }),
    }, ADMIN);
    renderPage();
    const sw = await screen.findByRole("switch", { name: "Offer PostgreSQL in new requests" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    await userEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(spy).toHaveBeenCalledWith("/api/connectors/postgresql", expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: false }) })));
    await waitFor(() => expect(sw).not.toBeDisabled());
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(within(screen.getByRole("article", { name: "PostgreSQL" })).getByText("Disabled")).toBeInTheDocument();
  });

  it("reverts the optimistic toggle and shows the error when the save fails", async () => {
    const spy = mockFetch({
      "GET /api/connectors": { body: { source: "lakebase", items: ITEMS } },
      "PUT /api/connectors/workday": { status: 409, body: { detail: "connector is in use by a pending request" } },
    }, ADMIN);
    renderPage();
    const sw = await screen.findByRole("switch", { name: "Offer Workday Reports in new requests" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("/api/connectors/workday", expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true }) })));
    const tile = screen.getByRole("article", { name: "Workday Reports" });
    expect(await within(tile).findByRole("alert")).toHaveTextContent("connector is in use by a pending request");
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("shows an empty state when no connectors are available", async () => {
    mockFetch({ "GET /api/connectors": { body: { source: "synthetic", items: [] } } });
    renderPage();
    expect(await screen.findByText("No connectors are available yet")).toBeInTheDocument();
  });

  it("shows an error card with Retry when the list fails", async () => {
    let calls = 0;
    mockFetch({
      "GET /api/connectors": () => (++calls === 1 ? { status: 500, body: { detail: "catalog unavailable" } } : { body: { source: "lakebase", items: ITEMS } }),
    });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("catalog unavailable");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("article", { name: "PostgreSQL" })).toBeInTheDocument();
  });
});

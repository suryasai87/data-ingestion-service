import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import type { Brand, Me, ResourceGroup } from "@/lib/types";
import HowItWorks from "./HowItWorks";

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

const GROUPS: ResourceGroup[] = [
  { title: "Lakebase", items: [
    { label: "Project", value: "dis-store", url: "https://example.cloud.databricks.com/lakebase/projects/dis-store" },
    { label: "Database", value: "dis · app", url: null },
  ] },
  { title: "Compute", items: [{ label: "App", value: "data-ingestion-service", url: "https://example.cloud.databricks.com/apps/data-ingestion-service" }] },
];

function renderPage() {
  return render(<MemoryRouter><BrandProvider><HowItWorks /></BrandProvider></MemoryRouter>);
}

describe("HowItWorks", () => {
  it("renders the flow diagram lanes, every node and the steps legend", async () => {
    mockFetch({ "GET /api/platform/resources": { body: { groups: [] } } });
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "How it works" })).toBeInTheDocument();
    for (const t of ["Self-service app", "Conversational assistant", "Approved configuration", "Validate", "Owner approval",
      "Lakeflow Connect", "Guardian", "Forecast model"]) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    expect(screen.getByText("access · schema · policy · Lakeflow")).toBeInTheDocument();
    expect(screen.getByText("independent for confidential")).toBeInTheDocument();
    expect(screen.getByText("Unity Catalog")).toBeInTheDocument();
    const lanes = screen.getByRole("list", { name: "Lanes" });
    expect(within(lanes).getAllByRole("listitem")).toHaveLength(4);
    const steps = screen.getByRole("region", { name: "Steps" });
    expect(within(steps).getAllByRole("listitem").length).toBeGreaterThanOrEqual(4);
    expect(within(steps).getAllByRole("listitem").length).toBeLessThanOrEqual(6);
    expect(within(steps).getByText("Guardian keeps it healthy")).toBeInTheDocument();
  });

  it("shows Where it runs with links that open in a new tab and plain text when there is no url", async () => {
    mockFetch({ "GET /api/platform/resources": { body: { groups: GROUPS } } });
    renderPage();
    const panel = await screen.findByRole("region", { name: "Where it runs" });
    expect(within(panel).getByText(/opening one uses your own permissions/)).toBeInTheDocument();
    const link = within(panel).getByRole("link", { name: /dis-store/ });
    expect(link).toHaveAttribute("href", "https://example.cloud.databricks.com/lakebase/projects/dis-store");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(within(panel).getAllByRole("link")).toHaveLength(2);
    const plain = within(panel).getByText("dis · app");
    expect(plain.closest("a")).toBeNull();
  });

  it("renders no panel when the resource list is empty", async () => {
    const spy = mockFetch({ "GET /api/platform/resources": { body: { groups: [{ title: "Unity Catalog", items: [] }] } } });
    renderPage();
    await waitFor(() => expect(spy).toHaveBeenCalledWith("/api/platform/resources", expect.anything()));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: "Where it runs" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "How it works" })).toBeInTheDocument();
  });

  it("renders no panel and keeps the page when the resource lookup fails", async () => {
    const spy = mockFetch({ "GET /api/platform/resources": { status: 500, body: { detail: "boom" } } });
    renderPage();
    await waitFor(() => expect(spy).toHaveBeenCalledWith("/api/platform/resources", expect.anything()));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: "Where it runs" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Self-service app")).toBeInTheDocument();
  });
});

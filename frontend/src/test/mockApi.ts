import { vi } from "vitest";
import type { Me } from "@/lib/types";

export type Reply = [number, unknown] | ((body: unknown) => [number, unknown]);
export interface Call { method: string; url: string; body: unknown }

/** Route-table fetch mock: "METHOD /path?query" -> [status, body] (or a function of the request body). */
export function mockApi(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const r = routes[`${method} ${url}`] ?? routes[`${method} ${url.split("?")[0]}`];
    const [status, payload] = typeof r === "function" ? r(body) : r ?? [404, { detail: `unmocked ${method} ${url}` }];
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

export const BRAND = {
  key: "databricks", company: "Databricks", product: "Data Ingestion Service", hero_title: "Welcome to Data Ingestion Service",
  hero_subtitle: "", destination_label: "Foundation", logo_url: null, powered_by: "Powered by Databricks Lakeflow Connect",
  palette: { brand_h: 262, brand_s: "58%" },
};

export const ME: Me = { email: "ana@example.com", name: "Ana Diaz", is_admin: true, is_approver: true, approver_scopes: ["domain:*"], kiosk: false };

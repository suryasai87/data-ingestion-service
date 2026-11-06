import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import { BRAND, ME, mockApi } from "@/test/mockApi";
import Assistant from "./Assistant";

const DRAFT = { title: "PostgreSQL journal_header", source: { connector: "postgresql", pattern: "query", connection: "dis_erp_source", via: "uc_catalog" },
  objects: [{ schema: "finance", table: "journal_header", primary_keys: ["doc_id"], cursor_column: "updated_at" }],
  destination: { environment: "dev", catalog: "cat", schema: "foundation_dev" }, schedule: { mode: "interval", interval_minutes: 15 },
  ownership: { owner: "", classification: "internal" } };

function renderPage(entry = "/assistant") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <BrandProvider>
        <Routes>
          <Route path="/assistant" element={<Assistant />} />
          <Route path="/requests/:id" element={<div>request page</div>} />
          <Route path="/new" element={<div>wizard</div>} />
        </Routes>
      </BrandProvider>
    </MemoryRouter>,
  );
}

describe("Assistant", () => {
  it("drafts from a suggestion, asks for the owner, then submits for approval", async () => {
    let turn = 0;
    const calls = mockApi({
      "GET /api/brand": [200, BRAND], "GET /api/me": [200, ME],
      "POST /api/forecast": [200, { cost: { month: { p50: 61, p90: 120 } }, freshness_min: { p50: 9, p90: 15 }, sla: { attainment_pct: 99, target_min: 30 } }],
      "POST /api/assistant/chat": () => {
        turn += 1;
        return turn === 1
          ? [200, { session_id: "s1", reply: "I drafted a configuration. Please confirm the data owner.", draft: DRAFT, missing: ["data owner"], ready: false, checks: [], llm: "live" }]
          : [200, { session_id: "s1", reply: "Validation passed. Review the configuration before submitting it for approval.", draft: { ...DRAFT, ownership: { owner: "ana@example.com", classification: "internal" } }, missing: [], ready: true, checks: [], llm: "live" }];
      },
      "POST /api/assistant/s1/submit": [200, { request: { id: "IR-1002", status: "pending_approval" } }],
    });
    const u = userEvent.setup();
    renderPage();
    await u.click(await screen.findByText(/finance journal header/));
    expect(await screen.findByText(/Please confirm the data owner/)).toBeInTheDocument();
    const review = screen.getByTestId("config-review");
    expect(review).toHaveTextContent("journal_header");
    expect(review).toHaveTextContent("needed");
    expect(screen.getByRole("button", { name: "Confirm and submit" })).toBeDisabled();
    await u.type(screen.getByLabelText("Message"), "Owner ana@example.com");
    await u.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Ready for confirmation")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm and submit" })).toBeEnabled());
    await u.click(screen.getByRole("button", { name: "Confirm and submit" }));
    expect(await screen.findByText("request page")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/assistant/chat")[1].body).toMatchObject({ session_id: "s1" });
  });

  it("hands the draft to the wizard for editing", async () => {
    mockApi({ "GET /api/brand": [200, BRAND], "GET /api/me": [200, ME], "POST /api/forecast": [500, {}],
      "POST /api/assistant/chat": [200, { session_id: "s1", reply: "ok", draft: DRAFT, missing: [], ready: true, checks: [], llm: "rules" }] });
    const u = userEvent.setup();
    renderPage();
    await u.type(await screen.findByLabelText("Message"), "hello");
    await u.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Rules mode")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Edit configuration" }));
    expect(await screen.findByText("wizard")).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem("dis.draft")!).source.connector).toBe("postgresql");
  });

  it("prefills an onboarding question from ?ask=", async () => {
    mockApi({ "GET /api/brand": [200, BRAND], "GET /api/me": [200, ME] });
    renderPage("/assistant?ask=Kafka");
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("I need data from Kafka. How do we onboard it into Foundation?"));
  });

  it("shows a chat error inline", async () => {
    mockApi({ "GET /api/brand": [200, BRAND], "GET /api/me": [200, ME], "POST /api/assistant/chat": [503, { detail: "model unavailable" }] });
    const u = userEvent.setup();
    renderPage();
    await u.type(await screen.findByLabelText("Message"), "hi");
    await u.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("model unavailable")).toBeInTheDocument();
  });
});

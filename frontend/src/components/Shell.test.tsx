import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { BrandProvider } from "@/brand/BrandContext";
import type { Me } from "@/lib/types";
import { BRAND, ME, mockApi, type Reply } from "@/test/mockApi";
import Shell from "./Shell";

const routes = (me: Me, extra: Record<string, Reply> = {}): Record<string, Reply> => ({
  "GET /api/brand": [200, BRAND], "GET /api/me": [200, me], ...extra,
});

function renderShell() {
  return render(<MemoryRouter><BrandProvider><Shell><div>page body</div></Shell></BrandProvider></MemoryRouter>);
}

async function openPinModal(user: ReturnType<typeof userEvent.setup>) {
  const avatar = await screen.findByRole("button", { name: "Account menu for ana@example.com" });
  await waitFor(() => expect(avatar).toHaveTextContent("AD"));
  await user.click(avatar);
  const menu = await screen.findByRole("menu", { name: "Account" });
  expect(within(menu).getByTestId("account-email")).toHaveTextContent("ana@example.com");
  await user.click(within(menu).getByRole("menuitem", { name: /Signing PIN/ }));
}

describe("Shell account menu", () => {
  it("opens from the avatar, shows the email and closes with Escape", async () => {
    mockApi(routes(ME));
    const user = userEvent.setup();
    renderShell();
    const avatar = await screen.findByRole("button", { name: "Account menu for ana@example.com" });
    expect(avatar).toHaveAttribute("aria-expanded", "false");
    await user.click(avatar);
    expect(avatar).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: /Signing PIN/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(avatar).toHaveFocus();
  });

  it("validates a new PIN (length, confirmation) and PUTs {pin} when none is set", async () => {
    const calls = mockApi(routes(ME, {
      "GET /api/gxp/pin": [200, { has_pin: false, set_at: null, locked_until: null }],
      "PUT /api/gxp/pin": [200, { has_pin: true, set_at: new Date().toISOString(), locked_until: null }],
    }));
    const user = userEvent.setup();
    renderShell();
    await openPinModal(user);
    const dialog = await screen.findByRole("dialog", { name: "Set your signing PIN" });
    expect(await within(dialog).findByTestId("pin-status")).toHaveTextContent("You haven't set a signing PIN yet.");
    expect(within(dialog).queryByLabelText("Current PIN")).not.toBeInTheDocument();
    const pin = within(dialog).getByLabelText("New PIN");
    const confirm = within(dialog).getByLabelText("Confirm new PIN");
    const save = within(dialog).getByRole("button", { name: "Save PIN" });
    expect(pin).toHaveAttribute("type", "password");

    await user.type(pin, "123");
    expect(within(dialog).getByText("The PIN must be 6 to 12 digits.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.type(pin, "456");
    expect(within(dialog).queryByText("The PIN must be 6 to 12 digits.")).not.toBeInTheDocument();
    await user.type(confirm, "123457");
    expect(within(dialog).getByText("The PINs don't match.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(confirm);
    await user.type(confirm, "123456");
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toEqual({ method: "PUT", url: "/api/gxp/pin", body: { pin: "123456" } }));
    const done = await screen.findByRole("dialog", { name: "Signing PIN saved" });
    expect(within(done).getByRole("status")).toHaveTextContent("Your signing PIN is set.");
    expect(done).not.toHaveTextContent("123456");
  });

  it("requires the current PIN to change it and shows a 403 inline", async () => {
    const calls = mockApi(routes(ME, {
      "GET /api/gxp/pin": [200, { has_pin: true, set_at: new Date(Date.now() - 2 * 86400 * 1000).toISOString(), locked_until: null }],
      "PUT /api/gxp/pin": [403, { detail: "Enter your current signing PIN to change it." }],
    }));
    const user = userEvent.setup();
    renderShell();
    await openPinModal(user);
    const dialog = await screen.findByRole("dialog", { name: "Change your signing PIN" });
    expect(await within(dialog).findByTestId("pin-status")).toHaveTextContent("PIN set 2 d ago.");
    const save = within(dialog).getByRole("button", { name: "Save PIN" });
    await user.type(within(dialog).getByLabelText("New PIN"), "24681357");
    await user.type(within(dialog).getByLabelText("Confirm new PIN"), "24681357");
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Current PIN"), "11112222");
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ pin: "24681357", current_pin: "11112222" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter your current signing PIN to change it.");
    expect(within(dialog).getByLabelText("Current PIN")).toHaveValue("");
  });

  it("disables saving in read-only mode", async () => {
    mockApi(routes({ ...ME, kiosk: true }, { "GET /api/gxp/pin": [200, { has_pin: false, set_at: null, locked_until: null }] }));
    const user = userEvent.setup();
    renderShell();
    await openPinModal(user);
    const dialog = await screen.findByRole("dialog", { name: "Set your signing PIN" });
    await user.type(await within(dialog).findByLabelText("New PIN"), "123456");
    await user.type(within(dialog).getByLabelText("Confirm new PIN"), "123456");
    const save = within(dialog).getByRole("button", { name: "Save PIN" });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("title", "Read-only mode");
  });
});

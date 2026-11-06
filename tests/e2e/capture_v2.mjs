// Screens for the deck / Confluence: GxP card, Access card + preview, Admin Usage + Integrations, API endpoint editor.
import { chromium } from "playwright-core";
const BASE = process.env.APP_URL.replace(/\/$/, ""), headers = { Authorization: `Bearer ${process.env.TOKEN}` };
const OUT = new URL("./screenshots/", import.meta.url).pathname;
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ extraHTTPHeaders: headers, viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
async function go(path) { await page.goto(BASE + path, { waitUntil: "domcontentloaded" }); await page.waitForSelector("h1", { timeout: 60000 }); await page.waitForTimeout(2500); }
async function card(text, file) {
  const el = page.locator("section, div.rounded-lg").filter({ hasText: text }).last();
  await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(600);
  const box = await el.boundingBox();
  await page.evaluate((y) => document.querySelector("#main").scrollBy(0, y - 120), box.y);
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + file });
}
await go(`/requests/${process.env.GXP_RID}`);
await card("Signatures", "request-gxp.png");
await go(`/requests/${process.env.ACCESS_RID}`);
const prev = page.getByRole("button", { name: /Preview data as me/ });
await prev.scrollIntoViewIfNeeded(); await prev.click(); await page.waitForTimeout(6000);
const ver = page.getByRole("button", { name: /Verify access/ }); await ver.click(); await page.waitForTimeout(5000);
await card("Runs as", "request-access.png");
await go("/admin");
await page.getByRole("radio", { name: "Usage" }).click(); await page.waitForTimeout(5000);
await page.screenshot({ path: OUT + "admin-usage.png" });
await page.getByRole("radio", { name: "Integrations" }).click(); await page.waitForTimeout(3000);
await page.screenshot({ path: OUT + "admin-integrations.png" });
await go("/new");
await page.click('[data-testid="connector-http"]');
await page.waitForFunction(() => document.querySelector('select[aria-label="Connection"]')?.value, null, { timeout: 60000 });
await page.click('button:has-text("Continue")'); await page.waitForTimeout(1500);
await page.fill('input[aria-label="Path 1"]', "/v1/forecast");
await page.fill('input[aria-label="Query parameters 1"]', "latitude=40.71&longitude=-74.01&hourly=temperature_2m");
await page.fill('input[aria-label="Destination table 1"]', "forecast_nyc"); await page.waitForTimeout(2500);
await page.screenshot({ path: OUT + "wizard-api.png" });
await go("/connectors"); await page.screenshot({ path: OUT + "connectors.png" });
await b.close();
console.log("captured");

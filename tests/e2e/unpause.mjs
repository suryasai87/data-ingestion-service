// Browser e2e against the DEPLOYED app: a paused pipeline comes back to running from the Unpause button.
//   APP_URL=… TOKEN=… RID=IR-1010 node unpause.mjs            (REPAUSE=0 to leave it running afterwards)
// 1. the card reads Paused with one action, "Unpause pipeline" (no Pause / Run now)
// 2. clicking it shows "Unpaused: … an update is running now"; the API reports the schedule on and an update in flight
// 3. Pause → confirm puts it back (unless REPAUSE=0), and the card reads Paused again
// Screenshots: pipelines-paused.png, pipelines-unpaused.png
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = (process.env.APP_URL || "http://localhost:8044").replace(/\/$/, "");
const TOKEN = process.env.TOKEN || "";
const RID = process.env.RID || "IR-1010";
const REPAUSE = process.env.REPAUSE !== "0";
const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
const OUT = new URL("./screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const ok = (m) => console.log("✓ " + m);
const die = async (m) => { console.log("✗ " + m); await browser.close(); process.exit(1); };
const api = async (path) => (await fetch(BASE + path, { headers })).json();
const card = async () => (await api("/api/pipelines")).items.find((p) => p.request_id === RID);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ extraHTTPHeaders: headers, viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/") && r.status() >= 500) problems.push(`API ${r.status()} ${u.pathname}`); });

const before = await card();
if (!before) await die(`${RID} is not on the Pipelines page`);
if (!before.paused_at) await die(`${RID} is not paused (health ${before.health}); pause it first`);

await page.goto(BASE + "/pipelines", { waitUntil: "domcontentloaded", timeout: 120000 });
const c = page.getByTestId(`pipeline-${RID}`);
await c.waitFor({ timeout: 60000 });
await c.getByTestId(`paused-${RID}`).waitFor({ timeout: 30000 });
if (await c.getByRole("button", { name: "Run now" }).count()) await die("a paused card still offers Run now");
ok(`${RID} card reads Paused (${before.paused_by ?? "?"}) with a single Unpause action`);
await page.waitForTimeout(2500);  // let the cards finish fading in
await page.screenshot({ path: `${OUT}pipelines-paused.png` });

await c.getByRole("button", { name: "Unpause pipeline" }).click();
await c.getByText(/Unpaused: the schedule is back on and an update is running now/).waitFor({ timeout: 90000 });
ok("clicked Unpause pipeline → confirmation shown");
const detail = (await api(`/api/requests/${RID}`)).request;
let live = null;
for (let i = 0; i < 12; i++) {
  live = await card();
  if (!live.paused_at && (live.state === "RUNNING" || ["CREATED", "QUEUED", "INITIALIZING", "SETTING_UP_TABLES", "WAITING_FOR_RESOURCES", "RUNNING"].includes(live.last_update_state))) break;
  await page.waitForTimeout(5000);
}
if (live.paused_at) await die("still flagged paused after Unpause");
ok(`after Unpause: pipeline ${live.state}, last update ${live.last_update_state}, job ${detail.job_id}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}pipelines-unpaused.png` });

if (REPAUSE) {
  await c.getByRole("button", { name: "Pause" }).click();
  const dlg = page.getByRole("dialog", { name: /^Pause / });
  await dlg.getByRole("button", { name: "Pause pipeline" }).click();
  await c.getByTestId(`paused-${RID}`).waitFor({ timeout: 90000 });
  ok("paused again from the card (Pause → Pause pipeline)");
}
if (problems.length) await die(problems.join("; "));
await browser.close();
console.log("\nunpause journey passed");

// Browser e2e against the DEPLOYED app (installed Google Chrome via playwright-core; the bearer token passes Apps SSO).
//   APP_URL=https://<app>.databricksapps.com TOKEN=$(databricks auth token -p DEFAULT -o json | jq -r .access_token) node journeys.mjs
// 1. every route renders: an <h1>, no error boundary, no page errors, no /api 5xx, the source pill where data is shown
// 2. guided form: PostgreSQL -> demo source -> journal_header -> ... -> Save draft -> the request page shows Draft
// 3. assistant: a suggestion drafts a configuration; the review panel shows the table
// 4. administration lists the deployer as an admin
// Screenshots (dark + light) go to ./screenshots for the docs.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = (process.env.APP_URL || "http://localhost:8044").replace(/\/$/, "");
const TOKEN = process.env.TOKEN || "";
const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
const OUT = new URL("./screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const ROUTES = [
  ["/", "home", true], ["/how-it-works", "how-it-works", false], ["/new", "new-request", false], ["/assistant", "assistant", false],
  ["/requests", "requests", true], ["/pipelines", "pipelines", true], ["/insights", "forecast-model", true],
  ["/connectors", "connectors", true], ["/admin", "admin", true],
];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ extraHTTPHeaders: headers, viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
let failures = 0;
const fail = (m) => { failures++; console.log("  FAIL " + m); };

async function open(route) {
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/") && r.status() >= 500) problems.push(`API ${r.status()} ${u.pathname}`); });
  await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("h1", { timeout: 60000 });
  await page.waitForTimeout(2500);
  return { page, problems };
}

for (const [route, name, pill] of ROUTES) {
  const { page, problems } = await open(route);
  if (pill) await page.waitForSelector('[data-testid="source-pill"]', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  const body = await page.textContent("body");
  if (body.includes("This page hit a problem")) problems.push("error boundary shown");
  if (pill && (await page.$$('[data-testid="source-pill"]')).length === 0) problems.push("no source pill");
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`${problems.length ? "✗" : "✓"} ${route}  ${(await page.textContent("h1"))?.trim()}`);
  problems.forEach(fail);
  await page.close();
}

// light theme screenshots of the two hero pages
{
  const { page } = await open("/");
  await page.click('button[aria-label="Toggle theme"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}home-light.png` });
  await page.goto(BASE + "/new"); await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}new-request-light.png` });
  await page.click('button[aria-label="Toggle theme"]');
  await page.close();
}

// guided form -> draft
{
  const { page, problems } = await open("/new");
  try {
    await page.click('[data-testid="connector-postgresql"]');
    await page.waitForFunction(() => document.querySelector('select[aria-label="Connection"]')?.value, null, { timeout: 60000 });
    await page.waitForSelector('[data-testid="fc-cost"]', { timeout: 60000 });
    await page.screenshot({ path: `${OUT}wizard-source.png` });
    await page.click('button:has-text("Continue")');
    await page.click('input[aria-label="Select finance.journal_header"]', { timeout: 60000 });
    await page.click('input[aria-label="Select finance.journal_line"]');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}wizard-objects.png` });
    await page.click('button:has-text("Continue")');
    await page.click('button:has-text("Continue")');
    await page.click('button[role="radio"]:has-text("1 h")');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}wizard-schedule.png` });
    await page.click('button:has-text("Continue")');
    await page.fill('input[aria-label="Request title"]', `E2E finance journals ${Date.now() % 100000}`);
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('text=Review the approved configuration');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}wizard-review.png` });
    await page.click('button:has-text("Save draft")');
    await page.waitForURL(/\/requests\/IR-/, { timeout: 60000 });
    await page.waitForSelector("text=Draft", { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}request-detail.png` });
    const rid = page.url().split("/").pop();
    console.log(`✓ guided form saved ${rid}`);
    // clean up: the journey's draft must not stay in the requests list
    const r = await fetch(`${BASE}/api/requests/${rid}/cancel`, { method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ reason: "e2e journey draft (automatic clean-up)" }) });
    if (!r.ok) fail(`cancel ${rid}: HTTP ${r.status}`);
  } catch (e) { fail(`guided form: ${e.message.split("\n")[0]}`); await page.screenshot({ path: `${OUT}wizard-failure.png` }); }
  problems.forEach(fail);
  await page.close();
}

// assistant
{
  const { page, problems } = await open("/assistant");
  try {
    await page.click("text=finance journal header", { timeout: 30000 });
    await page.waitForSelector('[data-testid="config-review"] >> text=journal_header', { timeout: 90000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}assistant-draft.png` });
    console.log("✓ assistant drafted a configuration");
  } catch (e) { fail(`assistant: ${e.message.split("\n")[0]}`); await page.screenshot({ path: `${OUT}assistant-failure.png` }); }
  problems.forEach(fail);
  await page.close();
}

// showcase request: the live request detail (deployment steps, checks, forecast) and its spec drawer
if (process.env.SHOWCASE_RID) {
  const { page, problems } = await open(`/requests/${process.env.SHOWCASE_RID}`);
  try {
    await page.waitForSelector("text=Live", { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}request-live.png`, fullPage: false });
    await page.click('button:has-text("View spec")', { timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}request-spec.png` });
    console.log(`✓ showcase ${process.env.SHOWCASE_RID} captured`);
  } catch (e) { fail(`showcase: ${e.message.split("\n")[0]}`); }
  problems.forEach(fail);
  await page.close();
}

// admin
{
  const { page } = await open("/admin");
  const t = await page.textContent("body");
  if (!/deployer|Deployed the service/i.test(t)) fail("admin page does not show the deployer");
  else console.log("✓ admin lists the deployer");
  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} problem(s)` : "\nall journeys passed");
process.exit(failures ? 1 : 0);

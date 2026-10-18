// Phase 4: FitBasket with NO watsonx credentials (the built-in assistant answers), against the real
// map, data and resource API. Run against a chat-api started without WATSONX_* variables:
//   P4_URL=http://127.0.0.1:8011 npx playwright test e2e/phase4.spec.ts
// The provider-offline test needs a second server whose WATSONX_URL points at a closed port (P4_OFFLINE_URL).
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const BASE = process.env.P4_URL;
const OFFLINE = process.env.P4_OFFLINE_URL;
const SHOTS = process.env.SHOT_DIR ?? "test-results";
test.skip(!BASE, "P4_URL not set (needs a chat-api started without watsonx credentials)");

type Props = { County: string; TotalPop: number | null; overall_need_score: number | null; low_access_pct: number | null };
const features: { properties: Props }[] = JSON.parse(
  readFileSync(new URL("../public/data/texas_heatmap.geojson", import.meta.url), "utf8"),
).features;

/** Population-weighted mean, exactly as the app computes county values. */
function countyOverall(county: string): string {
  let sum = 0;
  let w = 0;
  for (const { properties: p } of features) {
    if (p.County !== county || p.overall_need_score === null || !p.TotalPop || p.TotalPop <= 0) continue;
    sum += p.overall_need_score * p.TotalPop;
    w += p.TotalPop;
  }
  return (Math.round((sum / w) * 10) / 10).toFixed(1);
}

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|tile\.openstreetmap|ERR_/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function tileZoom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const levels = [...document.querySelectorAll<HTMLElement>(".leaflet-tile-container")];
    levels.sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex));
    const m = levels[0]?.querySelector<HTMLImageElement>("img.leaflet-tile")?.src.match(/\/(\d+)\/\d+\/\d+\.png/);
    return m ? Number(m[1]) : -1;
  });
}

async function open(page: Page, base: string) {
  await page.goto(`${base}/heatmap`);
  await expect.poll(() => page.locator("path.leaflet-interactive").count(), { timeout: 30_000 }).toBeGreaterThan(5000);
  await page.getByRole("button", { name: "Open FitBasket chat" }).click();
}

async function ask(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Message FitBasket" });
  await input.fill(text);
  await input.press("Enter");
  await expect(page.getByText("FitBasket is thinking…")).toHaveCount(0, { timeout: 20_000 });
  return page.locator(".ffc-assistant").last();
}

test("health reports missing credentials by name only", async ({ request }) => {
  const h = await (await request.get(`${BASE}/api/health`)).json();
  expect(h).toMatchObject({ ok: true, ai_configured: false, assistant: "built-in rules only", geography_loaded: true });
  expect(h.ai_missing).toEqual(expect.arrayContaining(["WATSONX_API_KEY", "WATSONX_PROJECT_ID"]));
  expect(JSON.stringify(h)).not.toMatch(/offline-test|apikey/i); // names only, never values
});

test("no credentials: Dallas County, comparison, data gaps, explanation, unknown place and reset all work", async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, BASE!);
  const start = await tileZoom(page);

  let a = await ask(page, "Show me Dallas County on the map");
  await expect(a).toContainText("Dallas County on the map — its 528 census tracts are shaded");
  await expect(a).toContainText("Answered by FitBasket's built-in assistant");
  await expect(a).toContainText("isn't configured on this server");
  await expect(page.getByText("Map moved to Dallas County")).toBeVisible();
  const dallas = await tileZoom(page);
  expect(dallas).toBeGreaterThanOrEqual(start + 3); // the real viewport changed
  await page.screenshot({ path: `${SHOTS}/p4-01-dallas.png` });

  a = await ask(page, "Compare Dallas County and Collin County");
  const table = a.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Dallas County" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Collin County" })).toBeVisible();
  const overallRow = table.getByRole("row", { name: /Overall need score/ });
  await expect(overallRow).toContainText(countyOverall("Dallas")); // numbers come from the real data
  await expect(overallRow).toContainText(countyOverall("Collin"));
  await expect(a).toContainText("American Community Survey");
  await page.screenshot({ path: `${SHOTS}/p4-02-compare.png` });

  const missingLowAccess = features.filter((f) => f.properties.low_access_pct === null).length;
  a = await ask(page, "Which counties have missing data?");
  await expect(a).toContainText(`missing in ${missingLowAccess.toLocaleString("en-US")} tracts`);
  await expect(a).toContainText("not zero");

  a = await ask(page, "What does this heatmap show?");
  await expect(a).toContainText("Choropleth");
  await expect(a).toContainText("Overall need");

  const before = await tileZoom(page);
  a = await ask(page, "Show me Springfield");
  await expect(a).toContainText(`couldn't find "Springfield" as a Texas county`);
  expect(await tileZoom(page)).toBe(before); // map state preserved

  a = await ask(page, "Go back to the Texas overview");
  await expect(a).toContainText("Back to the full Texas overview.");
  expect(await tileZoom(page)).toBeLessThan(dallas);
  expect(errors).toEqual([]);
});

test("no credentials: resource lookup for Plano uses the resource list, shows markers, and follow-ups work", async ({ page }) => {
  await open(page, BASE!);
  let a = await ask(page, "Find food pantries in Plano");
  await expect(a).toContainText(/Found \d+ listed resources? for Plano listings/);
  await expect(a).toContainText("Call before visiting");
  await expect(a).toContainText("capture date not recorded");
  const panel = page.getByRole("region", { name: "Food assistance resources" });
  await expect(panel.getByRole("status")).toContainText("among listings with a Plano address");
  const firstName = (await panel.getByRole("list", { name: "Search results" }).locator("article h3").first().textContent())!;
  expect(await page.locator(".leaflet-marker-icon.ffr-marker").count()).toBeGreaterThan(0);
  await expect(a).not.toContainText(/open now/i);

  a = await ask(page, "How can I contact the first one?");
  await expect(a).toContainText(firstName);
  await expect(a).toContainText("Eligibility requirements are not listed");

  // a suggestion chip sends a real follow-up
  await page.getByRole("button", { name: "Show the first one on the map" }).click();
  await expect(page.locator(".ffc-chip", { hasText: `Showing ${firstName} on the map` }).last()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/p4-03-resources.png` });

  a = await ask(page, "clear the resource search");
  await expect(a).toContainText("Cleared the resource search.");
  await expect(page.locator(".leaflet-marker-icon.ffr-marker")).toHaveCount(0);

  a = await ask(page, "Find food pantries in Houston");
  await expect(a).toContainText(`"Houston" isn't in FoodFit's food-resource list`);
});

test("provider offline: supported requests fall back to the built-in assistant with the reason", async ({ page }) => {
  test.skip(!OFFLINE, "P4_OFFLINE_URL not set");
  await open(page, OFFLINE!);
  const a = await ask(page, "Compare Dallas County and Collin County");
  await expect(a.getByRole("table")).toBeVisible();
  await expect(a).toContainText("Answered by FitBasket's built-in assistant");
  await expect(a).toContainText("The AI model is unavailable right now");
});

// Phase 5 acceptance: FitBasket with NO IBM credentials driving the real map, at the window sizes
// where "The map did not move to the requested county." used to appear (1920x1080 and wider).
// The map's live viewport is read from data-* attributes HeatmapPage mirrors onto the map element
// on every move (data-zoom, data-center, data-bounds, data-selected-county) — a reply that merely
// names the county is NOT enough to pass.
//
// Start chat-api without WATSONX_* variables (production build served by the API, or Vite dev), then:
//   P5_URL=http://127.0.0.1:8001 npx playwright test e2e/phase5.spec.ts      (API serving frontend/dist)
//   P5_URL=http://localhost:5173 npx playwright test e2e/phase5.spec.ts      (Vite dev server)
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const BASE = process.env.P5_URL;
const SHOTS = process.env.SHOT_DIR ?? "test-results";
test.skip(!BASE, "P5_URL not set (needs a running chat-api without watsonx credentials)");

type Props = { County: string; TotalPop: number | null; overall_need_score: number | null };
type Geo = { type: string; coordinates: unknown };
const features: { properties: Props; geometry: Geo }[] = JSON.parse(
  readFileSync(new URL("../public/data/texas_heatmap.geojson", import.meta.url), "utf8"),
).features;
const snapshot: { records: { name: string; city: string | null }[] } = JSON.parse(
  readFileSync(new URL("../../chat-api/resources/data/locationlist_snapshot.json", import.meta.url), "utf8"),
);

function walk(c: unknown, f: (lng: number, lat: number) => void) {
  if (Array.isArray(c) && typeof c[0] === "number") f(c[0] as number, c[1] as number);
  else if (Array.isArray(c)) c.forEach((x) => walk(x, f));
}

/** County bounding box computed independently from the GeoJSON the map draws. */
function countyBox(county: string) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const f of features) {
    if (f.properties.County !== county) continue;
    walk(f.geometry.coordinates, (lng, lat) => {
      s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng);
    });
  }
  return { s, w, n, e, lat: (s + n) / 2, lng: (w + e) / 2 };
}

function countyOverall(county: string): string {
  let sum = 0, wt = 0;
  for (const { properties: p } of features) {
    if (p.County !== county || p.overall_need_score === null || !p.TotalPop || p.TotalPop <= 0) continue;
    sum += p.overall_need_score * p.TotalPop;
    wt += p.TotalPop;
  }
  return (Math.round((sum / wt) * 10) / 10).toFixed(1);
}

/** Every console warning or error is a failure, except map tiles this test machine cannot download. */
function trackConsole(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const t = m.text();
    const loc = m.location().url ?? "";
    if (/tile\.openstreetmap\.org/.test(loc) || (/Failed to load resource/.test(t) && /openstreetmap/.test(loc))) return;
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/.test(t)) return; // offline tiles
    problems.push(`${m.type()}: ${t}`);
  });
  return problems;
}

type View = { zoom: number; lat: number; lng: number; bounds: number[]; selected: string };
async function view(page: Page): Promise<View> {
  return page.locator(".heatmap-map").evaluate((el: HTMLElement) => {
    const [lat, lng] = (el.dataset.center ?? "0,0").split(",").map(Number);
    return {
      zoom: Number(el.dataset.zoom),
      lat,
      lng,
      bounds: (el.dataset.bounds ?? "").split(",").map(Number),
      selected: el.dataset.selectedCounty ?? "",
    };
  });
}

function showsCounty(v: View, county: string) {
  const box = countyBox(county);
  const [s, w, n, e] = v.bounds;
  // the county's centre is on screen, the view is centred on it, and the whole county fits
  expect(box.lat).toBeGreaterThan(s);
  expect(box.lat).toBeLessThan(n);
  expect(box.lng).toBeGreaterThan(w);
  expect(box.lng).toBeLessThan(e);
  expect(Math.abs(v.lat - box.lat)).toBeLessThan(0.05);
  expect(Math.abs(v.lng - box.lng)).toBeLessThan(0.05);
  expect(s).toBeLessThanOrEqual(box.s + 0.01);
  expect(n).toBeGreaterThanOrEqual(box.n - 0.01);
  expect(v.selected).toBe(county);
}

async function open(page: Page) {
  await page.goto(`${BASE}/heatmap`);
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

const VIEWPORTS: { name: string; width: number; height: number; dpr: number }[] = [
  { name: "full-hd-1920", width: 1920, height: 1080, dpr: 1 },
  { name: "qhd-2560", width: 2560, height: 1440, dpr: 1 },
  { name: "retina-1728", width: 1728, height: 1117, dpr: 2 },
  { name: "macbook-1440", width: 1440, height: 900, dpr: 2 },
  { name: "phone-390", width: 390, height: 844, dpr: 3 },
];

for (const vp of VIEWPORTS) {
  test.describe(`at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });

    test("Dallas -> Collin -> all of Texas moves the real map, with no console warnings", async ({ page }) => {
      const problems = trackConsole(page);
      await open(page);
      const start = await view(page);

      let a = await ask(page, "Show me Dallas County on the map");
      await expect(a.locator(".ffc-chip-success")).toContainText("Map moved to Dallas County");
      await expect(a.getByRole("alert")).toHaveCount(0);
      await expect(a).toContainText("Answered by FitBasket's built-in assistant");
      const dallas = await view(page);
      expect(dallas.zoom).toBeGreaterThan(start.zoom);
      showsCounty(dallas, "Dallas");
      await page.screenshot({ path: `${SHOTS}/p5-${vp.name}-dallas.png` });

      a = await ask(page, "Show me Collin County");
      await expect(a.locator(".ffc-chip-success")).toContainText("Map moved to Collin County");
      const collin = await view(page);
      showsCounty(collin, "Collin");
      expect(collin.lat).toBeGreaterThan(dallas.lat); // Collin is north of Dallas

      a = await ask(page, "Show me all of Texas");
      await expect(a).toContainText("Back to the full Texas overview.");
      const texas = await view(page);
      expect(texas.zoom).toBeLessThan(collin.zoom);
      expect(texas.selected).toBe("");
      const [s, w, n, e] = texas.bounds;
      expect(s).toBeLessThan(26.5); // the southern tip and the panhandle are both in view
      expect(n).toBeGreaterThan(36);
      expect(w).toBeLessThan(-106);
      expect(e).toBeGreaterThan(-94);
      expect(problems).toEqual([]);
    });
  });
}

test.describe("built-in assistant answers (1920x1080)", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("comparison from the dataset, resources from the list, and honest refusals", async ({ page }) => {
    const problems = trackConsole(page);
    await open(page);

    let a = await ask(page, "Compare Dallas County and Collin County");
    const row = a.getByRole("table").getByRole("row", { name: /Overall need score/ });
    await expect(row).toContainText(countyOverall("Dallas"));
    await expect(row).toContainText(countyOverall("Collin"));

    a = await ask(page, "Find food pantries in Plano");
    await expect(a).toContainText(/Found \d+ listed resources? for Plano listings/);
    const names = await page.getByRole("region", { name: "Food assistance resources" })
      .getByRole("list", { name: "Search results" }).locator("article h3").allTextContents();
    expect(names.length).toBeGreaterThan(0);
    const plano = new Set(snapshot.records.filter((r) => r.city === "Plano").map((r) => r.name));
    for (const n of names) expect(plano.has(n)).toBe(true); // every card is a real Plano listing

    // Service-gap finder: need model x resource list, computed in the browser from loaded data.
    a = await ask(page, "Where are the service gaps?");
    const gapTable = a.getByRole("table");
    await expect(gapTable.getByRole("columnheader", { name: "Nearest listed resource" })).toBeVisible();
    const firstGeoid = (await gapTable.getByRole("row").nth(1).getByRole("cell").first().textContent())!.trim();
    expect(features.some((f) => (f.properties as unknown as { GEOID: string }).GEOID === firstGeoid)).toBe(true);
    await expect(a).toContainText("not a needs assessment");
    await page.getByRole("button", { name: `Show tract ${firstGeoid}` }).click();
    await expect(page.locator(".ffc-chip-success", { hasText: `Selected tract ${firstGeoid}` })).toBeVisible();
    const tract = features.find((f) => (f.properties as unknown as { GEOID: string }).GEOID === firstGeoid)!;
    let ts = 90, tn = -90, tw = 180, te = -180;
    walk(tract.geometry.coordinates, (lng, lat) => { ts = Math.min(ts, lat); tn = Math.max(tn, lat); tw = Math.min(tw, lng); te = Math.max(te, lng); });
    const tv = await view(page);
    expect(Math.abs(tv.lat - (ts + tn) / 2)).toBeLessThan(0.02); // the map is centred on that tract
    expect(Math.abs(tv.lng - (tw + te) / 2)).toBeLessThan(0.02);

    const before = await view(page);
    a = await ask(page, "Show me Springfield County");
    await expect(a).toContainText(`couldn't find "Springfield County"`);
    expect((await view(page)).zoom).toBe(before.zoom); // map untouched

    a = await ask(page, "Switch to census tracts.");
    await expect(a).toContainText("already shows census tracts");

    a = await ask(page, "Book me a flight to Paris");
    await expect(a).toContainText("I can't help with that one");
    await page.screenshot({ path: `${SHOTS}/p5-answers.png` });
    expect(problems).toEqual([]);
  });
});

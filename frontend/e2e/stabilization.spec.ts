// Phase 3: browser regression tests for defects found during stabilization.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|tile\.openstreetmap|ERR_/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

test("D1/D6: incomplete tract records don't crash the map; missing scores show as 'No data'", async ({ page }) => {
  const errors = trackErrors(page);
  const geo = JSON.parse(readFileSync(new URL("../public/data/texas_heatmap.geojson", import.meta.url), "utf8"));
  const base = geo.features.slice(0, 40);
  const withNulls = { type: "Feature", geometry: base[0].geometry, properties: { ...base[0].properties, GEOID: "48999000001", TotalPop: null, overall_need_score: null, income_score: null } };
  const broken = [
    { type: "Feature", geometry: null, properties: { ...base[1].properties, GEOID: "48999000002" } },
    { type: "Feature", geometry: base[2].geometry, properties: null },
    { type: "Feature", geometry: base[3].geometry, properties: { County: "Dallas" } },
  ];
  await page.route("**/data/texas_heatmap.geojson", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ ...geo, features: [...base, withNulls, ...broken] }) }));
  await page.goto("/heatmap");
  await expect(page.locator("path.leaflet-interactive")).toHaveCount(41);
  await expect(page.getByText("3 map records were skipped because they were incomplete")).toBeVisible();
  await expect(page.locator('path.leaflet-interactive[fill="#bdbdbd"]')).toHaveCount(1);
  await expect(page.getByText("No data for this layer")).toBeVisible();
  // Every layer still renders, and the sidebar ranks only tracts with real scores.
  for (const t of ["Transportation", "Grocery access", "Income barriers", "Overall need"]) {
    await page.getByRole("tab", { name: t }).click();
    await expect(page.locator(".heatmap-item")).toHaveCount(3);
  }
  expect(errors).toEqual([]);
});

test("D5: unknown URLs show a 'Page not found' view with working links", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.getByRole("link", { name: "Food-access map" }).click();
  await expect(page).toHaveURL(/\/heatmap$/);
  await expect.poll(() => page.locator("path.leaflet-interactive").count(), { timeout: 30_000 }).toBeGreaterThan(5000);
});

test("D4: when the API isn't deployed, chat and resources say so clearly", async ({ page }) => {
  await page.route("**/api/**", (r) => r.fulfill({ status: 404, contentType: "text/html", body: "<h1>Not Found</h1>" }));
  await page.goto("/heatmap");
  await expect.poll(() => page.locator("path.leaflet-interactive").count(), { timeout: 30_000 }).toBeGreaterThan(5000);
  const panel = page.getByRole("region", { name: "Food assistance resources" });
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("isn't reachable at this address");
  await page.getByRole("button", { name: "Open FitBasket chat" }).click();
  await page.getByRole("textbox", { name: "Message FitBasket" }).fill("hello");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ffc-error")).toContainText("isn't reachable at this address");
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0); // retrying can't fix a deployment problem
});

test("narrow 320px screen: heatmap page has no horizontal overflow and controls stay usable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/heatmap");
  await expect.poll(() => page.locator("path.leaflet-interactive").count(), { timeout: 30_000 }).toBeGreaterThan(5000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("tab", { name: "Income barriers" }).click();
  await expect(page.getByRole("tab", { name: "Income barriers" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Open FitBasket chat" }).click();
  const box = (await page.getByRole("dialog").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
});

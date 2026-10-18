import { expect, test, type Page } from "@playwright/test";

const SHOTS = process.env.SHOT_DIR ?? "test-results";

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|tile\.openstreetmap|ERR_/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function loadMap(page: Page) {
  await page.goto("/heatmap");
  await expect.poll(() => page.locator("path.leaflet-interactive").count(), { timeout: 30_000 }).toBeGreaterThan(5000);
}

async function openChat(page: Page) {
  await page.getByRole("button", { name: "Open FitBasket chat" }).click();
}

async function ask(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Message FitBasket" });
  await input.fill(text);
  await input.press("Enter");
  await expect(page.getByText("FitBasket is thinking…")).toHaveCount(0, { timeout: 20_000 });
}

async function zoomToDallas(page: Page) {
  await openChat(page);
  await ask(page, "Show me Dallas");
  await expect(page.getByText("Map moved to Dallas County")).toBeVisible();
  await page.getByRole("button", { name: "Close chat" }).click();
}

const panel = (page: Page) => page.getByRole("region", { name: "Food assistance resources" });
const markers = (page: Page) => page.locator(".leaflet-marker-icon.ffr-marker");
const cards = (page: Page) => panel(page).getByRole("list", { name: "Search results" }).locator("article");

/** One marker per unique located address in the results — never more (no duplicates/stale markers). */
async function expectMarkersMatchResults(page: Page) {
  const addrs = await cards(page).evaluateAll((els) =>
    els.filter((e) => e.querySelector(".ffr-show")).map((e) => e.querySelectorAll("p")[e.querySelector(".ffr-program") ? 1 : 0]?.textContent?.trim()));
  const unique = new Set(addrs).size;
  await expect(markers(page)).toHaveCount(unique);
  return unique;
}

async function panelSearch(page: Page, opts: { radius?: string; day?: string } = {}) {
  const p = panel(page);
  if (opts.radius) await p.getByLabel("Within").selectOption(opts.radius);
  if (opts.day) await p.getByLabel("Listed hours on").selectOption(opts.day);
  await p.getByRole("button", { name: "Search", exact: true }).click();
  await expect(p.getByRole("status")).not.toHaveText(/Searching/, { timeout: 15_000 });
}

test("panel search shows real records as markers, updates without stale markers, and clears back to the previous view", async ({ page }) => {
  const errors = trackErrors(page);
  await loadMap(page);

  // Statewide view centre is far outside the list's coverage.
  await panelSearch(page, { radius: "25" });
  await expect(panel(page).getByText(/outside the area FoodFit's resource list covers/)).toBeVisible();
  await expect(markers(page)).toHaveCount(0);
  await panel(page).getByRole("button", { name: /Clear search/ }).click();

  await zoomToDallas(page);
  const beforeCenter = await page.evaluate(() => document.querySelector(".leaflet-map-pane")!.getAttribute("style"));

  await panelSearch(page, { radius: "15" });
  const n15 = await cards(page).count();
  expect(n15).toBeGreaterThan(0);
  await expect(panel(page).getByRole("status")).toContainText(/resources? within 15 mi \(straight-line\) of the centre of the current map view/);
  await expect(panel(page).getByText(/LocationListInfo\.pdf .*capture date not recorded\. Call before visiting\./)).toBeVisible();
  // Every visible card's distance is labelled straight-line and within the radius.
  const dists = await cards(page).locator(".ffr-dist").allTextContents();
  for (const d of dists) {
    const m = d.match(/^([\d.]+) mi straight-line$/);
    expect(m, d).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(15);
  }
  const m15 = await expectMarkersMatchResults(page);
  expect(m15).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/p2-01-panel-search.png`, fullPage: true });

  // Narrow the radius: results and markers both shrink, no leftovers.
  await panelSearch(page, { radius: "5" });
  const n5 = await cards(page).count();
  expect(n5).toBeLessThan(n15);
  const m5 = await expectMarkersMatchResults(page);
  expect(m5).toBeLessThan(m15);
  // Searching again (the map has refit, so the centre moved) still leaves exactly one marker per result address.
  await panelSearch(page);
  await expectMarkersMatchResults(page);

  await panel(page).getByRole("button", { name: /Clear search/ }).click();
  await expect(markers(page)).toHaveCount(0);
  await expect(panel(page).getByRole("status")).toHaveText(/No search yet/);
  const afterCenter = await page.evaluate(() => document.querySelector(".leaflet-map-pane")!.getAttribute("style"));
  expect(afterCenter).toBe(beforeCenter); // map view restored
  expect(errors).toEqual([]);
});

test("selecting a card shows the marker details, and selecting a marker highlights its card", async ({ page }) => {
  await loadMap(page);
  await zoomToDallas(page);
  await panelSearch(page, { radius: "15" });
  const first = cards(page).first();
  const name = (await first.locator("h3").textContent())!;
  await first.getByRole("button", { name: "Show on map" }).click();
  const popup = page.locator(".leaflet-popup-content .ffr-popup");
  await expect(popup).toContainText(name);
  await expect(popup).toContainText("Call to confirm");
  await expect(page.locator(".ffr-marker.ffr-selected")).toHaveCount(1);
  await expect(first).toHaveAttribute("aria-current", "true");

  // Click a different marker: its card becomes the selected one.
  await page.locator(".leaflet-popup-close-button").click();
  const other = markers(page).nth(1);
  const otherTitle = (await other.getAttribute("title"))!.replace(/ \(\d+ programs\)$/, "");
  await other.focus();
  await page.keyboard.press("Enter"); // Leaflet markers are keyboard-activatable
  await expect(panel(page).locator('article[aria-current="true"] h3')).toHaveText(otherTitle);
});

test("day filter only claims listed hours and keeps unknown hours separate", async ({ page }) => {
  await loadMap(page);
  await zoomToDallas(page);
  await panelSearch(page, { radius: "15", day: "Saturday" });
  const statuses = await cards(page).locator(".ffr-day strong").allTextContents();
  expect(statuses.length).toBeGreaterThan(0);
  for (const s of statuses) expect(["Listed:", "Some weeks only:"]).toContain(s);
  await expect(panel(page).getByText(/no parseable hours/)).toBeVisible();
  await expect(page.getByText(/open now/i)).toHaveCount(0);
});

test("chatbot searches, shows, describes and compares the same records the panel and map show", async ({ page }) => {
  const errors = trackErrors(page);
  await loadMap(page);
  await zoomToDallas(page);
  await openChat(page);

  await ask(page, "Where can I find food assistance near the map?"); // resource questions go to the configured (scripted) LLM
  const chip = page.getByText(/^Found \d+ resources? within 15 mi \(straight-line\)$/);
  await expect(chip).toBeVisible();
  const chatCount = Number((await chip.textContent())!.match(/Found (\d+)/)![1]);
  // The panel shows the same search (synchronised).
  await expect(panel(page).getByRole("status")).toContainText(`${chatCount} resource`);
  await expect(panel(page).getByRole("status")).toContainText("within 15 mi");
  expect(await markers(page).count()).toBeGreaterThan(0);
  await expect(page.getByText(/Food resources: LocationListInfo\.pdf/).first()).toBeVisible();
  const firstCardName = (await cards(page).first().locator("h3").textContent())!;

  await ask(page, "show the first one on the map");
  await expect(page.getByText(`Showing ${firstCardName} on the map`)).toBeVisible();
  await expect(page.locator(".leaflet-popup-content .ffr-popup")).toContainText(firstCardName);

  await ask(page, "how can I contact the first one?");
  await expect(page.getByText(new RegExp(`TOOL RESULT: .*"resource": \\{"name": "${firstCardName}"`))).toBeVisible();

  await ask(page, "compare the first two");
  await expect(page.getByText(/TOOL RESULT: .*"compared": \[/)).toBeVisible();

  await ask(page, "harris county pantries please");
  await expect(page.getByText(/TOOL RESULT: .*"total_in_radius": 0, "out_of_coverage": true/)).toBeVisible();
  await expect(panel(page).getByText(/outside the area FoodFit's resource list covers/)).toBeVisible();

  await ask(page, "tell me about the fake pantry");
  // No location given: the built-in assistant asks where to look instead of inventing a listing.
  await expect(page.locator(".ffc-assistant").last()).toContainText("Where should I look?");

  await ask(page, "clear the resource search");
  await expect(page.getByText("Resource search cleared")).toBeVisible();
  await expect(markers(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/p2-02-chat.png` });
  expect(errors).toEqual([]);
});

test("chat search respects the user's selected tract and asks when none is selected", async ({ page }) => {
  await loadMap(page);
  await zoomToDallas(page);
  await openChat(page);
  await ask(page, "pantries near the selected tract");
  await expect(page.getByText(/No tract is selected/).first()).toBeVisible();
  await page.getByRole("button", { name: "Close chat" }).click();
  const box = (await page.locator(".heatmap-map").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const suffix = (await page.locator(".leaflet-popup-content strong").textContent())!.match(/Tract (\d{6})/)![1];
  await openChat(page);
  await ask(page, "pantries near the selected tract");
  await expect(page.getByText(new RegExp(`"searched_from": "the centre of Dallas County tract ${suffix}"`))).toBeVisible();
});

test("resource API failure shows an error with a working retry; Phase 1 map still works", async ({ page }) => {
  await loadMap(page);
  await zoomToDallas(page);
  let fail = true;
  await page.route("**/api/resources/search**", (route) => (fail ? route.abort("connectionrefused") : route.continue()));
  await panelSearch(page, { radius: "15" });
  await expect(panel(page).getByRole("alert")).toContainText("Can't reach the FoodFit resource service");
  fail = false;
  await panel(page).getByRole("button", { name: "Retry" }).click();
  await expect(cards(page).first()).toBeVisible();
  // Existing heatmap controls are unaffected.
  await page.getByRole("tab", { name: "Grocery access" }).click();
  await expect(page.getByRole("heading", { name: "Top 3: Grocery access" })).toBeVisible();
  expect(await page.locator("path.leaflet-interactive").count()).toBe(5238);
});

test("keyboard: search from the panel and open a marker without a mouse", async ({ page }) => {
  await loadMap(page);
  await zoomToDallas(page);
  await panel(page).getByLabel("Within").selectOption("15");
  await panel(page).getByRole("button", { name: "Search", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(cards(page).first()).toBeVisible();
  const marker = markers(page).first();
  await marker.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".leaflet-popup-content .ffr-popup")).toBeVisible();
});

test("mobile: resource panel is usable without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadMap(page);
  await zoomToDallas(page);
  await panel(page).scrollIntoViewIfNeeded();
  await panelSearch(page, { radius: "15" });
  await expect(cards(page).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = (await cards(page).first().boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await cards(page).first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/p2-03-mobile.png` });
});

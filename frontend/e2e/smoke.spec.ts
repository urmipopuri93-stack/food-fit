import { expect, test, type Page } from "@playwright/test";

const SHOTS = process.env.SHOT_DIR ?? "test-results";

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // Map tiles come from openstreetmap.org; offline test machines can't load them.
    if (/Failed to load resource|tile\.openstreetmap|ERR_/.test(t)) return;
    errors.push(t);
  });
  return errors;
}

async function currentTileZoom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const levels = [...document.querySelectorAll<HTMLElement>(".leaflet-tile-container")];
    levels.sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex));
    const img = levels[0]?.querySelector<HTMLImageElement>("img.leaflet-tile");
    const m = img?.src.match(/\/(\d+)\/\d+\/\d+\.png/);
    return m ? Number(m[1]) : -1;
  });
}

async function loadMap(page: Page) {
  await page.goto("/heatmap");
  await expect.poll(() => page.locator("path.leaflet-interactive").count(), { timeout: 30_000 }).toBeGreaterThan(5000);
}

async function ask(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Message FitBasket" });
  await input.fill(text);
  await input.press("Enter");
  await expect(page.getByText("FitBasket is thinking…")).toHaveCount(0, { timeout: 20_000 });
}

test("heatmap page loads and existing map features still work without the chatbot", async ({ page }) => {
  const errors = trackErrors(page);
  await loadMap(page);
  expect(await page.locator("path.leaflet-interactive").count()).toBe(5238);
  await page.getByRole("tab", { name: "Transportation" }).click();
  await expect(page.getByRole("heading", { name: "Top 3: Transportation" })).toBeVisible();
  await page.locator(".heatmap-item").first().click();
  await expect(page.locator(".leaflet-popup-content")).toContainText("Transportation:");
  await page.locator(".leaflet-control-zoom-in").click();
  expect(errors).toEqual([]);
});

test("chat navigates the real map, reports failures honestly, and tracks manual selection", async ({ page }) => {
  const errors = trackErrors(page);
  await loadMap(page);
  const startZoom = await currentTileZoom(page);

  await page.getByRole("button", { name: "Open FitBasket chat" }).click();
  await expect(page.getByRole("dialog", { name: "Ask FitBasket" })).toBeVisible();

  // Desktop: the panel must not cover the Leaflet zoom control.
  const panel = await page.getByRole("dialog").boundingBox();
  const zoomCtl = await page.locator(".leaflet-control-zoom").boundingBox();
  const overlap = !(panel!.x > zoomCtl!.x + zoomCtl!.width || panel!.x + panel!.width < zoomCtl!.x ||
    panel!.y > zoomCtl!.y + zoomCtl!.height || panel!.y + panel!.height < zoomCtl!.y);
  expect(overlap).toBe(false);

  await ask(page, "Show me Dallas");
  await expect(page.getByText("Map moved to Dallas County")).toBeVisible();
  await expect(page.locator(".ffc-assistant").last()).toContainText(/Dallas County on the map — its 528 census tracts/);
  const dallasZoom = await currentTileZoom(page);
  expect(dallasZoom).toBeGreaterThanOrEqual(startZoom + 3);
  await page.screenshot({ path: `${SHOTS}/01-dallas.png` });

  await ask(page, "Now show Fort Worth");
  await expect(page.locator(".ffc-assistant").last()).toContainText(/couldn't find "Fort Worth" as a Texas county/);
  expect(await currentTileZoom(page)).toBe(dallasZoom); // map did not move

  await ask(page, "switch to the income layer");
  await expect(page.getByRole("tab", { name: "Income barriers" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Top 3: Income barriers" })).toBeVisible();

  // Manual interaction: click a tract on the map, then ask about "here".
  await page.getByRole("button", { name: "Close chat" }).click();
  const box = (await page.locator(".heatmap-map").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const popup = page.locator(".leaflet-popup-content strong");
  await expect(popup).toBeVisible();
  const tractSuffix = (await popup.textContent())!.match(/Tract (\d{6})/)![1];
  await page.getByRole("button", { name: "Open FitBasket chat" }).click();
  await ask(page, "what is here?");
  await expect(page.getByText(new RegExp(`TOOL RESULT: .*"selected_tract": \\{"geoid": "48\\d{3}${tractSuffix}"`))).toBeVisible();

  await ask(page, "compare dallas county and tarrant county");
  await expect(page.getByText(/difference_a_minus_b/)).toBeVisible(); // answered by the (scripted) LLM path
  await expect(page.getByText(/American Community Survey census-tract data \(2015\)/).first()).toBeVisible();

  await ask(page, "reset the map");
  await expect(page.getByText("Map reset to full Texas view")).toBeVisible();
  expect(await currentTileZoom(page)).toBeLessThan(dallasZoom);
  await page.screenshot({ path: `${SHOTS}/02-conversation.png` });

  expect(errors).toEqual([]);
});

test("model attempts at unsupported actions are refused and shown as errors", async ({ page }) => {
  await loadMap(page);
  await page.getByRole("button", { name: "Open FitBasket chat" }).click();
  await ask(page, "hack the page");
  await expect(page.getByRole("alert")).toContainText("unreadable answer");
  expect(await page.evaluate(() => document.title)).not.toBe("hacked");
});

test("network failure shows a friendly error and retry works", async ({ page }) => {
  await loadMap(page);
  let fail = true;
  await page.route("**/api/chat", (route) => (fail ? route.abort("connectionrefused") : route.continue()));
  await page.getByRole("button", { name: "Open FitBasket chat" }).click();
  await ask(page, "explain the map");
  await expect(page.getByRole("alert")).toContainText("can't reach the FoodFit assistant");
  fail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Read map legend & metadata")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("keyboard only: open, send, and close with focus returned", async ({ page }) => {
  await loadMap(page);
  const launcher = page.getByRole("button", { name: "Open FitBasket chat" });
  await launcher.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Message FitBasket" })).toBeFocused();
  await page.keyboard.type("zoom in please");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Zoom \d+ → \d+/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open FitBasket chat" })).toBeFocused();
});

for (const [name, viewport] of [["tablet", { width: 820, height: 1180 }], ["mobile", { width: 390, height: 844 }]] as const) {
  test(`chat panel fits on ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await loadMap(page);
    await page.getByRole("button", { name: "Open FitBasket chat" }).click();
    const panel = (await page.getByRole("dialog").boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width);
    expect(panel.y).toBeGreaterThanOrEqual(0);
    await ask(page, "Show me Dallas");
    await expect(page.getByText("Map moved to Dallas County")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/03-${name}.png` });
    // the page beside the closed panel stays interactive
    await page.getByRole("button", { name: "Close chat" }).click();
    await page.getByRole("tab", { name: "Grocery access" }).click();
    await expect(page.getByRole("tab", { name: "Grocery access" })).toHaveAttribute("aria-selected", "true");
  });
}

test("other routes are unaffected (dashboard and its demo chat still work)", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/dashboard");
  await expect(page.getByText("Community Food Dashboard")).toBeVisible();
  await page.getByRole("button", { name: "Open FitBasket chat" }).click();
  await page.getByRole("button", { name: "Why is the top area prioritized?" }).click();
  await expect(page.getByText("FOODFIT RESPONSE")).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("Harvest")).toBeVisible();
  expect(errors).toEqual([]);
});

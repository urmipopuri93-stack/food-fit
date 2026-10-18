// Phase 3 regression tests for defects found during stabilization.
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCount, formatScore, sanitizeTractFeatures } from "../src/heatmapLayers";
import { postChat } from "../src/chat/chatClient";
import { searchResources } from "../src/resources/resourceClient";

afterEach(() => vi.unstubAllGlobals());

describe("D1/D6: incomplete tract data never crashes the map", () => {
  const poly = { type: "Polygon", coordinates: [] };
  const good = { type: "Feature", geometry: poly, properties: { GEOID: "48113000100", County: "Dallas", TotalPop: null, overall_need_score: null } };

  it("keeps drawable features (even with missing scores) and counts broken ones", () => {
    const { features, skipped } = sanitizeTractFeatures([
      good,
      { type: "Feature", geometry: null, properties: { GEOID: "48113000200", County: "Dallas" } },
      { type: "Feature", geometry: poly, properties: null },
      { type: "Feature", geometry: poly, properties: { GEOID: 48113, County: "Dallas" } },
      { type: "Feature", geometry: { type: "Point", coordinates: [] }, properties: { GEOID: "48113000300", County: "Dallas" } },
    ]);
    expect(features).toEqual([good]);
    expect(skipped).toBe(4);
  });

  it("formats missing values as 'not available' instead of throwing", () => {
    expect(formatScore(null)).toBe("not available");
    expect(formatScore(undefined)).toBe("not available");
    expect(formatScore(Number.NaN)).toBe("not available");
    expect(formatScore(72.345)).toBe("72.3 / 100");
    expect(formatCount(null)).toBe("not available");
    expect(formatCount(5981)).toBe((5981).toLocaleString());
  });
});

describe("D4: a missing or misrouted API gives an accurate message", () => {
  const respond = (status: number, body: string, type = "text/html") =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "content-type": type } })));
  const params = { origin: { lat: 33, lng: -96.7, label: "x" }, radiusMiles: 5, categories: ["food_distribution" as const], day: null, limit: 5 };

  it.each([404, 405, 501])("chat: static-host %i page => service_missing (not retryable)", async (status) => {
    respond(status, "<h1>Not Found</h1>");
    await expect(postChat([{ role: "user", content: "hi" }], null, new AbortController().signal))
      .rejects.toMatchObject({ code: "service_missing", retryable: false });
  });

  it("chat: 200 with HTML (SPA fallback answering /api) => service_missing", async () => {
    respond(200, "<!doctype html><div id=root></div>");
    await expect(postChat([{ role: "user", content: "hi" }], null, new AbortController().signal))
      .rejects.toMatchObject({ code: "service_missing" });
  });

  it("chat: proxy 502 with no API body => can't reach (retryable)", async () => {
    respond(502, "Bad Gateway");
    await expect(postChat([{ role: "user", content: "hi" }], null, new AbortController().signal))
      .rejects.toMatchObject({ code: "network", retryable: true });
  });

  it("chat: real API errors still pass through", async () => {
    respond(503, JSON.stringify({ error: { code: "not_configured", message: "x" } }), "application/json");
    await expect(postChat([{ role: "user", content: "hi" }], null, new AbortController().signal))
      .rejects.toMatchObject({ code: "not_configured" });
  });

  it("resources: 404 page => service_missing, not 'check your filters'", async () => {
    respond(404, "<h1>Not Found</h1>");
    const e = await searchResources(params).catch((x) => x);
    expect(e).toMatchObject({ code: "service_missing", retryable: false });
    expect(e.message).not.toMatch(/filters/);
  });

  it("resources: 502/504 => retryable", async () => {
    respond(502, "Bad Gateway");
    await expect(searchResources(params)).rejects.toMatchObject({ code: "network", retryable: true });
    respond(504, "Gateway Timeout");
    await expect(searchResources(params)).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("resources: API validation errors keep their meaning", async () => {
    respond(422, JSON.stringify({ error: { code: "invalid_request" } }), "application/json");
    await expect(searchResources(params)).rejects.toMatchObject({ code: "invalid_request" });
  });
});

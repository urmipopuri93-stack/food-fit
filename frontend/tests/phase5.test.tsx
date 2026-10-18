// Phase 5: chatbot -> map integration against a REAL Leaflet map, the real chat bridge used by
// /heatmap, and the real Texas tract GeoJSON. The map container is given real-world sizes,
// including the wide desktop sizes where "The map did not move to the requested county." used
// to appear even though the map had moved (root cause: a viewport-span heuristic that rejected
// correct fits on wide maps).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import L from "leaflet";
import type { FeatureCollection, Geometry } from "geojson";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import ChatPanel from "../src/chat/ChatPanel";
import { COUNTY_HIGHLIGHT, createChatBridge } from "../src/chat/chatBridge";
import type { PostChat } from "../src/chat/chatClient";
import { validBounds, viewFits } from "../src/chat/mapController";
import { buildTractIndex, type TractIndex } from "../src/chat/tractIndex";
import type { ApiMessage, ChatApiResponse, MapContextPayload } from "../src/chat/types";
import type { TabId, TractProperties } from "../src/heatmapLayers";
import { createResourceStore } from "../src/resources/resourceStore";
import { findServiceGaps, haversineMi } from "../src/chat/serviceGaps";
import { executeResourceTool } from "../src/resources/resourceTools";
import type { LocationsResponse } from "../src/resources/types";
import { SOURCE } from "./resourceFixtures";
import { makeIndex } from "./fixtures";

type Data = FeatureCollection<Geometry, TractProperties>;
let DATA: Data;
let INDEX: TractIndex;

beforeAll(() => {
  DATA = JSON.parse(readFileSync(resolve(__dirname, "../public/data/texas_heatmap.geojson"), "utf8"));
  INDEX = buildTractIndex(DATA);
});

const mounted: L.Map[] = [];
afterEach(() => {
  cleanup();
  while (mounted.length) mounted.pop()!.remove();
  document.body.innerHTML = "";
});

const BASE_STYLE: L.PathOptions = { weight: 0.4, color: "#ffffff", opacity: 0.9 };

/** Builds the same objects HeatmapPage builds: a real L.Map in a sized container, the tract layer and the bridge. */
function mountMap(width: number, height: number, opts: { brokenFit?: boolean } = {}) {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: height });
  document.body.appendChild(el);
  const map = L.map(el).setView([31, -99], 6);
  mounted.push(map);
  if (opts.brokenFit) map.fitBounds = (() => map) as typeof map.fitBounds; // simulates a map that ignores the request

  const tractLayer = L.geoJSON(DATA, { style: () => BASE_STYLE }); // not added to the map: jsdom has no renderer
  const polygons = new Map<string, L.Polygon>();
  tractLayer.eachLayer((l) => {
    const p = (l as L.Polygon & { feature: { properties: TractProperties } }).feature.properties;
    polygons.set(p.GEOID, l as L.Polygon);
  });
  const refs = {
    map: { current: map as L.Map | null },
    polygonLayers: { current: polygons },
    indexRef: { current: INDEX as TractIndex | null },
    tabRef: { current: "combined" as TabId },
    selectedRef: { current: null as string | null },
    selectedCountyRef: { current: null as string | null },
    tractLayer: { current: tractLayer as L.GeoJSON | null },
    mapEl: { current: el as HTMLDivElement | null },
    resourceLayerRef: { current: null },
    store: createResourceStore(vi.fn()),
    setTab: (t: TabId) => {
      refs.tabRef.current = t;
    },
  };
  const bridge = createChatBridge(refs);
  return { map, el, polygons, refs, ...bridge };
}

const countyBounds = (name: string) => {
  const b = [...INDEX.counties.values()].find((c) => c.name === name)!.bounds;
  return L.latLngBounds([b.south, b.west], [b.north, b.east]);
};
const geoidsOf = (name: string) => [...INDEX.counties.values()].find((c) => c.name === name)!.geoids;
const isHighlighted = (p: L.Polygon) => p.options.weight === COUNTY_HIGHLIGHT.weight && p.options.color === COUNTY_HIGHLIGHT.color;

// Map container sizes measured in a real browser at common window sizes.
const SIZES: [string, number, number][] = [
  ["MacBook 1440x900", 1114, 464],
  ["Retina 1728x1117", 1402, 577],
  ["Full HD 1920x1080 (used to fail)", 1594, 558],
  ["QHD 2560x1440 (used to fail)", 2234, 745],
  ["Phone 390x844", 354, 261],
];

describe("zoom_to_county on a real Leaflet map", () => {
  it.each(SIZES)("Dallas County at %s: viewport moves, county is selected and highlighted", (_label, w, h) => {
    const { map, el, controller, polygons } = mountMap(w, h);
    const before = map.getZoom();
    const r = controller.zoomToCounty("Dallas");
    const dallas = countyBounds("Dallas");
    expect(r).toMatchObject({ ok: true, county: "Dallas County", selected_county: "Dallas", tract_count: geoidsOf("Dallas").length });
    expect(r.highlighted_tracts).toBe(geoidsOf("Dallas").length);
    // The actual viewport: centred on Dallas County and zoomed to fit it.
    expect(map.getBounds().contains(dallas.getCenter())).toBe(true);
    expect(map.getZoom()).toBeGreaterThan(before);
    expect(map.getZoom()).toBeGreaterThanOrEqual(map.getBoundsZoom(dallas, false, L.point(60, 60)));
    expect(viewFits(map, dallas, 30)).toBe(true);
    expect(el.dataset.selectedCounty).toBe("Dallas");
    expect(isHighlighted(polygons.get(geoidsOf("Dallas")[0])!)).toBe(true);
    expect(isHighlighted(polygons.get(geoidsOf("Collin")[0])!)).toBe(false);
  });

  it("then Collin County: the map moves again and the highlight follows", () => {
    const { map, controller, polygons } = mountMap(1594, 558);
    expect(controller.zoomToCounty("Dallas").ok).toBe(true);
    const dallasCenter = map.getCenter();
    const r = controller.zoomToCounty("Collin County");
    expect(r).toMatchObject({ ok: true, county: "Collin County", selected_county: "Collin" });
    expect(map.getCenter().equals(dallasCenter)).toBe(false);
    expect(map.getBounds().contains(countyBounds("Collin").getCenter())).toBe(true);
    expect(isHighlighted(polygons.get(geoidsOf("Collin")[0])!)).toBe(true);
    expect(isHighlighted(polygons.get(geoidsOf("Dallas")[0])!)).toBe(false);
    expect(controller.getContext()?.selected_county).toBe("Collin");
  });

  it("reset returns to the statewide view and clears the selected county", () => {
    const { map, el, controller, polygons } = mountMap(2234, 745);
    controller.zoomToCounty("Tarrant");
    const countyZoom = map.getZoom();
    const r = controller.reset();
    expect(r.ok).toBe(true);
    expect(map.getZoom()).toBeLessThan(countyZoom);
    const texas = INDEX.fullBounds!;
    expect(map.getBounds().contains(L.latLng((texas.south + texas.north) / 2, (texas.west + texas.east) / 2))).toBe(true);
    expect(el.dataset.selectedCounty).toBe("");
    expect(isHighlighted(polygons.get(geoidsOf("Tarrant")[0])!)).toBe(false);
    expect(controller.getContext()).not.toHaveProperty("selected_county");
  });

  it("a map that does not move reports move_failed, and nothing is highlighted", () => {
    const { map, el, controller, polygons } = mountMap(1594, 558, { brokenFit: true });
    const zoom = map.getZoom();
    const r = controller.zoomToCounty("Dallas");
    expect(r).toMatchObject({ ok: false, error: "move_failed", message: "The map did not move to the requested county." });
    expect(map.getZoom()).toBe(zoom);
    expect(el.dataset.selectedCounty ?? "").toBe("");
    expect(isHighlighted(polygons.get(geoidsOf("Dallas")[0])!)).toBe(false);
  });

  it("unknown places leave the map exactly where it was", () => {
    const { map, controller } = mountMap(1114, 464);
    controller.zoomToCounty("Dallas");
    const view = map.getBounds();
    expect(controller.zoomToCounty("Springfield")).toMatchObject({ ok: false, error: "not_found" });
    expect(map.getBounds().equals(view)).toBe(true);
  });

  it("rejects a county whose stored geometry is unusable", () => {
    const index = buildTractIndex(DATA);
    const dallas = [...index.counties.values()].find((c) => c.name === "Dallas")!;
    dallas.bounds = { ...dallas.bounds, north: Number.NaN };
    const { controller, refs } = mountMap(1114, 464);
    refs.indexRef.current = index;
    expect(controller.zoomToCounty("Dallas")).toMatchObject({ ok: false, error: "invalid_geometry" });
  });

  it("validBounds accepts real Texas county bounds and rejects broken ones", () => {
    for (const c of INDEX.counties.values()) expect(validBounds(c.bounds)).toBe(true);
    expect(validBounds({ south: 33, west: -96, north: 32, east: -95 })).toBe(false);
    expect(validBounds({ south: 0, west: 0, north: 1, east: 1 })).toBe(false);
    expect(validBounds(null)).toBe(false);
  });
});

// ---- Chat panel + real map ----

type Post = Parameters<PostChat>;

/** Mimics chat-api's built-in assistant: round 1 requests the map action, round 2 composes from the browser result. */
function rulesServer() {
  const calls: { messages: ApiMessage[]; context: MapContextPayload | null }[] = [];
  const post = vi.fn(async (messages: Post[0], context: Post[1]): Promise<ChatApiResponse> => {
    calls.push({ messages, context });
    const last = messages[messages.length - 1];
    if (last.role === "user") {
      const text = last.content.toLowerCase();
      if (/reset|all of texas|whole state/.test(text)) return call("reset_map", {}, "reset_view");
      const county = /collin/.test(text) ? "Collin" : "Dallas";
      return call("zoom_to_county", { county }, "navigate_county");
    }
    const result = JSON.parse((last as { content: string }).content);
    const content = result.ok ? (result.county ? `Here's **${result.county}** on the map.` : "Back to the full Texas overview.") : String(result.message);
    return {
      type: "message", content, message: content, intent: "navigate_county", source: "rules", fallback_used: true, notice: null,
      suggestions: result.ok ? ["Summarize this county"] : ["Show me Dallas County", "Reset the map"],
      map_action: { type: "zoom_to_county", arguments: {}, status: result.ok ? "applied" : "failed" },
      error: result.ok ? null : { code: String(result.error), message: String(result.message), retryable: true },
    };
  });
  return { post: post as unknown as PostChat, calls, spy: post };
}

function call(name: string, args: Record<string, unknown>, intent: string): ChatApiResponse {
  const id = `rules_r_${intent}_0`;
  return {
    type: "tool_calls", intent, source: "rules", fallback_used: true, notice: null, suggestions: [], message: null,
    map_action: { type: name, arguments: args, status: "requested" },
    assistant_message: { role: "assistant", content: "", tool_calls: [{ id, name: name as never, arguments: JSON.stringify(args) }] },
    tool_calls: [{ id, name, arguments: args }],
  };
}

function renderChat(m: ReturnType<typeof mountMap>, post: PostChat) {
  const user = userEvent.setup();
  render(<ChatPanel controller={m.controller} getIndex={m.getIndex} dataStatus="ready" post={post} />);
  return user;
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  if (!screen.queryByRole("dialog")) await user.click(screen.getByRole("button", { name: "Open FitBasket chat" }));
  await user.type(screen.getByRole("textbox", { name: "Message FitBasket" }), `${text}{Enter}`);
}

describe("FitBasket chat driving the real map", () => {
  it('"Show me Dallas County": sends the right request, applies the action, moves the viewport and confirms it', async () => {
    const m = mountMap(1594, 558);
    const server = rulesServer();
    const user = renderChat(m, server.post);
    const startZoom = m.map.getZoom();
    await ask(user, "Show me Dallas County");
    expect(await screen.findByText("Dallas County", { selector: "strong" })).toBeTruthy();

    // 1) correct API request: the user's text plus the live map context
    const first = server.calls[0];
    expect(first.messages.at(-1)).toEqual({ role: "user", content: "Show me Dallas County" });
    expect(first.context).toMatchObject({ layer: "combined", zoom: startZoom });
    // 2) the browser reported a verified success back to the server
    const toolMsg = server.calls[1].messages.at(-1) as { role: string; content: string };
    expect(toolMsg.role).toBe("tool");
    expect(JSON.parse(toolMsg.content)).toMatchObject({ ok: true, county: "Dallas County", selected_county: "Dallas" });
    // 3) the real viewport changed
    expect(m.map.getZoom()).toBeGreaterThan(startZoom);
    expect(m.map.getBounds().contains(countyBounds("Dallas").getCenter())).toBe(true);
    // 4) the UI shows the applied action separately from the answer, and no error
    expect(screen.getByText("Map moved to Dallas County")).toBeTruthy();
    expect(screen.queryByText(/The map did not change/)).toBeNull();
  });

  it("Dallas -> Collin -> all of Texas, and the selected county is sent as context", async () => {
    const m = mountMap(2234, 745);
    const server = rulesServer();
    const user = renderChat(m, server.post);
    await ask(user, "Show me Dallas County");
    await screen.findByText("Map moved to Dallas County");
    await ask(user, "Show me Collin County");
    await screen.findByText("Map moved to Collin County");
    expect(server.calls[2].context?.selected_county).toBe("Dallas"); // context sent with the Collin request
    expect(m.map.getBounds().contains(countyBounds("Collin").getCenter())).toBe(true);
    const countyZoom = m.map.getZoom();
    await ask(user, "Show me all of Texas");
    await screen.findByText("Back to the full Texas overview.");
    expect(m.map.getZoom()).toBeLessThan(countyZoom);
    expect(m.el.dataset.selectedCounty).toBe("");
  });

  it("a failed map operation shows an error with a recovery option, never a success", async () => {
    const m = mountMap(1594, 558, { brokenFit: true });
    const server = rulesServer();
    const user = renderChat(m, server.post);
    await ask(user, "Show me Dallas County");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/The map did not change\..*The map did not move to the requested county\./);
    expect(screen.queryByText("Map moved to Dallas County")).toBeNull();
    expect(screen.getByText(/Failed:/)).toBeTruthy();
    // recovery: the server's suggestions include a retry and a reset
    const reset = screen.getByRole("button", { name: "Reset the map" });
    await user.click(reset);
    await waitFor(() => expect(server.calls.at(-2)?.messages.at(-1)).toEqual({ role: "user", content: "Reset the map" }));
  });

  it("blocks duplicate submissions while a map request is in flight", async () => {
    const m = mountMap(1114, 464);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server = rulesServer();
    const post = vi.fn<PostChat>(async (msgs, ctx, signal) => {
      await gate;
      return server.post(msgs, ctx, signal);
    });
    const user = renderChat(m, post);
    await ask(user, "Show me Dallas County");
    const input = screen.getByRole("textbox", { name: "Message FitBasket" });
    await user.type(input, "Show me Dallas County{Enter}");
    expect(screen.getByText("FitBasket is thinking…")).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
    release();
    await screen.findByText("Map moved to Dallas County");
    expect(post).toHaveBeenCalledTimes(2); // round 1 + round 2 of the single submitted turn
  });
});

// ---- Service-gap finder (need model x resource list) ----


function locations(over: Partial<LocationsResponse> = {}): LocationsResponse {
  // Fixture tracts: Dallas 48113000100 centre (32.75,-96.75), 48113000200 centre (32.85,-96.65), Tarrant (32.75,-97.25)
  return {
    locations: [{ id: "near-pantry", name: "Near Pantry", city: "Dallas", category: "food_distribution", category_label: "Food pantry / distribution", lat: 32.75, lng: -96.75 }],
    unlocated_count: 2,
    coverage: { lat: 32.8, lng: -96.7, reach_miles: 10 },
    source: SOURCE,
    distance_note: "Distances are straight-line (as the crow flies), not travel distance or time.",
    ...over,
  };
}

describe("find_service_gaps", () => {
  it("ranks covered high-need tracts by straight-line distance to the nearest mapped listing", () => {
    const r = findServiceGaps(makeIndex(), locations(), { limit: 5 });
    expect(r.ok).toBe(true);
    // Only the two Dallas tracts are inside the list's coverage; Tarrant/Fort Bend/etc. are not measured.
    expect(r.tracts_analyzed).toBe(2);
    const gaps = r.gaps as { geoid: string; distance_miles_straight_line: number; nearest_resource: { name: string } }[];
    expect(gaps[0].geoid).toBe("48113000100"); // need 80 = top quarter; need 40 tract is below the threshold
    expect(gaps).toHaveLength(1);
    expect(gaps[0].nearest_resource.name).toBe("Near Pantry");
    expect(gaps[0].distance_miles_straight_line).toBe(0);
    expect(r.caveats).toEqual(expect.arrayContaining([expect.stringMatching(/straight-line/), expect.stringMatching(/not a needs assessment/)]));
  });

  it("is honest outside the coverage area and with no mapped listings", () => {
    expect(findServiceGaps(makeIndex(), locations(), { county: "Tarrant" })).toMatchObject({ ok: false, error: "out_of_coverage" });
    expect(findServiceGaps(makeIndex(), locations({ locations: [], coverage: null }), {})).toMatchObject({ ok: false, error: "no_locations" });
    expect(findServiceGaps(makeIndex(), locations(), { county: "Gotham" })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("haversine matches a known distance (Dallas to Fort Worth downtowns ~ 30.6 mi)", () => {
    expect(haversineMi(32.7767, -96.797, 32.7555, -97.3308)).toBeGreaterThan(30);
    expect(haversineMi(32.7767, -96.797, 32.7555, -97.3308)).toBeLessThan(31.5);
  });

  it("the chat tool validates arguments and attaches the source line", async () => {
    const deps = {
      getMap: () => null, getIndex: () => makeIndex(), getSelected: () => null, store: createResourceStore(vi.fn()),
      getLayer: () => null, getLocations: vi.fn(async () => locations()),
    };
    expect(await executeResourceTool("find_service_gaps", { county: 5 }, deps)).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(await executeResourceTool("find_service_gaps", { limit: 50 }, deps)).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(await executeResourceTool("find_service_gaps", { radius: 1 }, deps)).toMatchObject({ ok: false, error: "invalid_arguments" });
    const ok = await executeResourceTool("find_service_gaps", {}, deps);
    expect(ok).toMatchObject({ ok: true, tracts_analyzed: 2 });
    expect(String(ok.source)).toMatch(/capture date not recorded|LocationListInfo/);
  });
});

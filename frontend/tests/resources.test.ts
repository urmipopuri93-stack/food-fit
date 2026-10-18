import L from "leaflet";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getResource, ResourceError, searchResources } from "../src/resources/resourceClient";
import { createResourceStore } from "../src/resources/resourceStore";
import { createResourceLayer, groupByLocation, popupHtml } from "../src/resources/ResourceLayer";
import { resolveOrigin } from "../src/resources/origin";
import { executeResourceTool, forModel } from "../src/resources/resourceTools";
import { sourceLine, type SearchParams, type SearchResponse } from "../src/resources/types";
import { runTurn, type PostChat } from "../src/chat/chatClient";
import { A, B, SAME_ADDRESS_AS_A, SOURCE, UNLOCATED, rec, response } from "./resourceFixtures";
import { makeIndex } from "./fixtures";

const PARAMS: SearchParams = { origin: { lat: 32.95, lng: -96.73, label: "test" }, radiusMiles: 5, categories: ["food_distribution"], day: null, limit: 10 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resource client", () => {
  const stub = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("builds a validated query (categories repeated, day, limit)", async () => {
    stub(200, response());
    await searchResources({ ...PARAMS, categories: ["food_distribution", "senior_food_box"], day: "today" });
    const url = String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toMatch(/^\/api\/resources\/search\?/);
    const q = new URL(url, "http://x").searchParams;
    expect(q.getAll("category")).toEqual(["food_distribution", "senior_food_box"]);
    expect(q.get("day")).toBe("today");
    expect(q.get("radius_miles")).toBe("5");
  });

  it.each([
    [503, { error: { code: "resources_unavailable" } }, "resources_unavailable", true],
    [429, { error: { code: "too_many_requests" } }, "too_many_requests", true],
    [422, { error: { code: "invalid_request" } }, "invalid_request", false],
    [404, { error: { code: "not_found" } }, "not_found", false],
  ])("maps HTTP %i to a safe error", async (status, body, code, retryable) => {
    stub(status, body);
    const e = await searchResources(PARAMS).catch((x) => x);
    expect(e).toBeInstanceOf(ResourceError);
    expect(e).toMatchObject({ code, retryable });
  });

  it("rejects malformed responses instead of showing them", async () => {
    stub(200, { results: "nope" });
    await expect(searchResources(PARAMS)).rejects.toMatchObject({ code: "bad_response" });
    stub(200, { ...response(), results: [{ name: "no id" }] });
    await expect(searchResources(PARAMS)).rejects.toMatchObject({ code: "bad_response" });
  });

  it("handles network failure and timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fail"); }));
    await expect(searchResources(PARAMS)).rejects.toMatchObject({ code: "network", retryable: true });
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("x", "AbortError"))))));
    const p = searchResources(PARAMS).catch((x) => x);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await p).toMatchObject({ code: "timeout" });
  });

  it("validates ids before requesting and checks the response id", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(getResource("../etc/passwd")).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
    stub(200, { ...A, id: "someone-else" });
    await expect(getResource(A.id)).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("resource store", () => {
  it("runs a search, exposes results and finds records", async () => {
    const store = createResourceStore(async () => response());
    const res = await store.search(PARAMS);
    expect(store.getState().status).toBe("ready");
    expect(res.results).toHaveLength(2);
    expect(store.find(UNLOCATED.id)?.name).toBe(UNLOCATED.name);
  });

  it("a newer search wins; the older response is discarded (no stale results)", async () => {
    let resolveFirst!: (v: SearchResponse) => void;
    const search = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockImplementationOnce(async () => response({ results: [B], total_in_radius: 1 }));
    const store = createResourceStore(search);
    const first = store.search(PARAMS).catch((e) => e);
    await store.search({ ...PARAMS, radiusMiles: 10 });
    resolveFirst(response());
    expect(await first).toMatchObject({ code: "aborted" });
    expect(store.getState().response?.results.map((r) => r.id)).toEqual([B.id]);
  });

  it("records errors and retries the same query", async () => {
    const search = vi.fn()
      .mockRejectedValueOnce(new ResourceError("timeout", "slow", true))
      .mockResolvedValueOnce(response());
    const store = createResourceStore(search);
    await store.search(PARAMS).catch(() => {});
    expect(store.getState()).toMatchObject({ status: "error", error: { code: "timeout" } });
    await store.retry();
    expect(store.getState().status).toBe("ready");
    expect(search.mock.calls[1][0]).toEqual(PARAMS);
  });

  it("clear resets everything", async () => {
    const store = createResourceStore(async () => response());
    await store.search(PARAMS);
    store.select(A.id);
    store.clear();
    expect(store.getState()).toMatchObject({ status: "idle", response: null, selectedId: null, pinned: [] });
  });
});

describe("resource map layer", () => {
  it("groups programs at one address into one marker", () => {
    const groups = groupByLocation([A, SAME_ADDRESS_AS_A, B, UNLOCATED, A]);
    expect(groups).toHaveLength(2);
    expect(groups[0].records.map((r) => r.id)).toEqual([A.id, SAME_ADDRESS_AS_A.id]);
  });

  it("escapes record text in popups", () => {
    const html = popupHtml({ key: "k", lat: 1, lng: 1, records: [rec({ name: "<img src=x onerror=alert(1)>", phone: null })] });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("Phone: not listed");
    expect(html).toContain("Call to confirm");
  });

  it("draws markers for located results only, replaces them on each search, and removes them on clear", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const map = L.map(div).setView([32.9, -96.7], 9);
    const store = createResourceStore(vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ results: [B], total_in_radius: 1 })));
    const layer = createResourceLayer(map, store);
    await store.search(PARAMS);
    expect(layer.markerCount()).toBe(2);
    expect(layer.has(UNLOCATED.id)).toBe(false);
    await store.search(PARAMS);
    expect(layer.markerCount()).toBe(1);
    expect(layer.has(A.id)).toBe(false);
    store.clear();
    expect(layer.markerCount()).toBe(0);
    layer.destroy();
    map.remove();
  });
});

describe("search origin", () => {
  const index = makeIndex();
  const base = { getMap: () => ({ getCenter: () => L.latLng(32.9, -96.8) }), getIndex: () => index, getSelected: () => null as string | null, store: createResourceStore() };

  it("resolves map centre, county and tract from verified data", () => {
    expect(resolveOrigin("map_center", undefined, base)).toMatchObject({ ok: true, origin: { lat: 32.9, lng: -96.8 } });
    expect(resolveOrigin("county", "Dallas", base)).toMatchObject({ ok: true, origin: { label: "the centre of Dallas County" } });
    expect(resolveOrigin("tract", "48113000100", base)).toMatchObject({ ok: true });
  });

  it("asks instead of guessing when the location is missing or ambiguous", () => {
    expect(resolveOrigin("selected_tract", undefined, base)).toMatchObject({ ok: false, error: "no_selection" });
    expect(resolveOrigin("county", "San", base)).toMatchObject({ ok: false, error: "ambiguous", options: ["San Jacinto County", "San Saba County"] });
    expect(resolveOrigin("county", "Plano", base)).toMatchObject({ ok: false, error: "not_found" });
    expect(resolveOrigin("gps", undefined, base)).toMatchObject({ ok: false, error: "invalid_arguments" });
  });
});

describe("resource chat tools", () => {
  function deps(searchImpl = async () => response()) {
    const store = createResourceStore(searchImpl);
    const focus = vi.fn(() => true);
    return {
      store,
      focus,
      d: {
        getMap: () => ({ getCenter: () => L.latLng(32.95, -96.73) }),
        getIndex: () => makeIndex(),
        getSelected: () => null,
        store,
        getLayer: () => ({ focus, has: () => true, markerCount: () => 1, destroy() {} }),
        getResource: vi.fn(async (id: string) => {
          const r = [A, B, UNLOCATED].find((x) => x.id === id);
          if (!r) throw new ResourceError("not_found", "That resource is not in FoodFit's data.", false);
          return { ...r, source: SOURCE };
        }),
      },
    };
  }

  it.each([
    [{ near: { kind: "map_center" }, radius_miles: 100 }, /radius_miles/],
    [{ near: { kind: "map_center" }, categories: ["groceries"] }, /categories/],
    [{ near: { kind: "map_center" }, day: "someday" }, /day/],
    [{ near: { kind: "map_center", lat: 1 } }, /near accepts only/],
    [{ near: "Plano" }, /near must be an object/],
    [{ near: { kind: "map_center" }, script: "x" }, /Unexpected/],
  ])("rejects invalid search args %j", async (args, msg) => {
    const { d, store } = deps();
    const r = await executeResourceTool("search_resources", args, d);
    expect(r).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(String(r.message)).toMatch(msg);
    expect(store.getState().status).toBe("idle");
  });

  it("searches through the shared store and returns only record fields", async () => {
    const { d, store } = deps();
    const r = await executeResourceTool("search_resources", { near: { kind: "map_center" } }, d);
    expect(r).toMatchObject({ ok: true, total_in_radius: 2, out_of_coverage: false, shown_on_map: true });
    expect(store.getState().status).toBe("ready"); // panel + map see the same search
    expect((r.results as unknown[])[0]).toEqual(forModel(A));
    expect(String(r.source)).toBe(sourceLine(SOURCE));
    expect(String(r.source)).toMatch(/capture date not recorded/);
    expect(r.listed_without_map_location).toEqual([{ id: UNLOCATED.id, name: UNLOCATED.name, program: UNLOCATED.program, address: UNLOCATED.address }]);
  });

  it("asks for a location when no tract is selected", async () => {
    const { d } = deps();
    expect(await executeResourceTool("search_resources", { near: { kind: "selected_tract" } }, d)).toMatchObject({ ok: false, error: "no_selection" });
  });

  it("reports API failures without inventing results", async () => {
    const { d, store } = deps(async () => { throw new ResourceError("resources_unavailable", "Food resource data is unavailable right now.", true); });
    const r = await executeResourceTool("search_resources", { near: { kind: "map_center" } }, d);
    expect(r).toEqual({ ok: false, error: "resources_unavailable", message: "Food resource data is unavailable right now." });
    expect(store.getState().status).toBe("error");
  });

  it("details: missing fields stay missing", async () => {
    const { d } = deps();
    const r = await executeResourceTool("get_resource_details", { resource_id: B.id }, d);
    const resource = r.resource as Record<string, unknown>;
    expect(resource.phone).toBeNull();
    expect(resource.not_listed).toEqual(["phone", "website", "hours", "appointment requirement"]);
    expect(await executeResourceTool("get_resource_details", { resource_id: "made-up-pantry" }, d)).toMatchObject({ ok: false, error: "not_found" });
    expect(await executeResourceTool("get_resource_details", { resource_id: "<script>" }, d)).toMatchObject({ ok: false, error: "invalid_arguments" });
  });

  it("compare: side by side, no ranking, rejects same id", async () => {
    const { d } = deps();
    const r = await executeResourceTool("compare_resources", { a: A.id, b: B.id }, d);
    expect(r).toMatchObject({ ok: true, a: { name: A.name }, b: { name: B.name } });
    expect(String(r.note)).toMatch(/does not rate/);
    expect(await executeResourceTool("compare_resources", { a: A.id, b: A.id }, d)).toMatchObject({ ok: false, error: "same_resource" });
  });

  it("show on map: refuses resources without verified coordinates", async () => {
    const { d, focus } = deps();
    expect(await executeResourceTool("show_resource_on_map", { resource_id: UNLOCATED.id }, d)).toMatchObject({ ok: false, error: "no_coordinates" });
    expect(focus).not.toHaveBeenCalled();
    expect(await executeResourceTool("show_resource_on_map", { resource_id: A.id }, d)).toMatchObject({ ok: true, name: A.name });
    expect(focus).toHaveBeenCalledWith(A.id);
  });

  it("clear empties the shared search", async () => {
    const { d, store } = deps();
    await executeResourceTool("search_resources", { near: { kind: "map_center" } }, d);
    expect(await executeResourceTool("clear_resource_search", {}, d)).toEqual({ ok: true, cleared: true });
    expect(store.getState().status).toBe("idle");
  });

  it("the chat turn awaits async tools and cites the resource source", async () => {
    const { d } = deps();
    const replies = [
      {
        type: "tool_calls" as const,
        assistant_message: { role: "assistant" as const, content: "", tool_calls: [{ id: "c1", name: "search_resources" as const, arguments: "{}" }] },
        tool_calls: [{ id: "c1", name: "search_resources", arguments: { near: { kind: "map_center" } } }],
      },
      { type: "message" as const, content: "Here are two." },
    ];
    const post: PostChat = async () => replies.shift()!;
    const r = await runTurn([], "food near me", {
      post,
      execute: (n, a) => executeResourceTool(n as "search_resources", a, d),
      getContext: () => null,
    }, new AbortController().signal);
    expect(r.actions[0]).toEqual({ status: "info", text: "Found 2 resources within 5 mi (straight-line)" });
    expect(r.sources).toEqual([`Food resources: ${sourceLine(SOURCE)}`]);
  });
});

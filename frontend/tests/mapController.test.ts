import L from "leaflet";
import { describe, expect, it } from "vitest";
import { makeController } from "./fixtures";

describe("map controller", () => {
  it("zooms the existing map to a supported county and confirms it", () => {
    const { controller, map } = makeController();
    const r = controller.zoomToCounty("Dallas County");
    expect(r).toMatchObject({ ok: true, county: "Dallas County", tract_count: 2 });
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    expect(map.getBounds().contains(L.latLng(32.8, -96.7))).toBe(true);
  });

  it.each([
    ["Fort Worth", "not_found"],
    ["San", "ambiguous"],
    ["<img onerror=x>", "invalid_county"],
  ])("does not move the map for %j (%s)", (q, error) => {
    const { controller, map } = makeController();
    const r = controller.zoomToCounty(q);
    expect(r).toMatchObject({ ok: false, error });
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it("returns clarification options for ambiguous names", () => {
    const { controller } = makeController();
    expect(controller.zoomToCounty("San").options).toEqual(["San Jacinto County", "San Saba County"]);
  });

  it("reports failure honestly when the map does not actually move", () => {
    const { controller, state } = makeController({ broken: true });
    expect(controller.zoomToCounty("Dallas")).toMatchObject({ ok: false, error: "move_failed" });
    expect(controller.selectTract("48113000100")).toMatchObject({ ok: false, error: "select_failed" });
    expect(controller.zoomIn()).toMatchObject({ ok: false, error: "zoom_failed" });
    expect(controller.setLayer("income")).toMatchObject({ ok: false, error: "layer_failed" });
    expect(state.tab).toBe("combined");
  });

  it("refuses actions when data has not loaded", () => {
    const { controller, map } = makeController({ noData: true });
    expect(controller.zoomToCounty("Dallas")).toMatchObject({ ok: false, error: "data_unavailable" });
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it("selects a tract, opens its popup and updates the selection", () => {
    const { controller, state, polygons } = makeController();
    const r = controller.selectTract("48439000100");
    expect(r).toMatchObject({ ok: true, geoid: "48439000100", county: "Tarrant" });
    expect(state.selected).toBe("48439000100");
    expect(polygons.popups.get("48439000100")).toBe(true);
  });

  it.each(["4843900010", "48439000100; alert(1)", "99999999999", "48000000000"])("rejects bad tract id %j without moving", (g) => {
    const { controller, map, state } = makeController();
    expect(controller.selectTract(g).ok).toBe(false);
    expect(map.fitBounds).not.toHaveBeenCalled();
    expect(state.selected).toBeNull();
  });

  it("zooms within limits and validates steps", () => {
    const { controller, map } = makeController();
    expect(controller.zoomIn()).toMatchObject({ ok: true, from_zoom: 6, zoom: 7 });
    expect(controller.zoomOut(2)).toMatchObject({ ok: true, zoom: 5 });
    expect(controller.zoomIn(10)).toMatchObject({ ok: false, error: "invalid_steps" });
    expect(controller.zoomIn("2")).toMatchObject({ ok: false, error: "invalid_steps" });
    expect(controller.zoomIn(1.5)).toMatchObject({ ok: false, error: "invalid_steps" });
    map.setZoom(18);
    expect(controller.zoomIn()).toMatchObject({ ok: false, error: "at_limit" });
  });

  it("resets to the full extent and clears the selection", () => {
    const { controller, map, state } = makeController();
    controller.selectTract("48113000100");
    const r = controller.reset();
    expect(r.ok).toBe(true);
    expect(state.selected).toBeNull();
    expect(map.closePopup).toHaveBeenCalled();
  });

  it("switches layers only to allowlisted values", () => {
    const { controller, state } = makeController();
    expect(controller.setLayer("income")).toMatchObject({ ok: true, label: "Income barriers" });
    expect(state.tab).toBe("income");
    expect(controller.setLayer("satellite")).toMatchObject({ ok: false, error: "invalid_layer" });
    expect(state.tab).toBe("income");
  });

  it("reflects manual map interaction in the context (no stale state)", () => {
    const { controller, map, state } = makeController();
    controller.zoomToCounty("Dallas");
    expect(controller.getContext()?.visible_counties).toEqual(["Dallas"]);
    map.__pan(L.latLngBounds([32.6, -97.4], [32.9, -97.1])); // user drags to Tarrant
    state.selected = "48439000100"; // user clicks a tract
    const ctx = controller.getContext()!;
    expect(ctx.visible_counties).toEqual(["Tarrant"]);
    expect(ctx.selected_tract).toEqual({ geoid: "48439000100", county: "Tarrant" });
  });
});

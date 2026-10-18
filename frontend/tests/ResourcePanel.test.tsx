import L from "leaflet";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResourcePanel from "../src/resources/ResourcePanel";
import { ResourceError } from "../src/resources/resourceClient";
import { createResourceStore } from "../src/resources/resourceStore";
import type { SearchParams, SearchResponse } from "../src/resources/types";
import { A, B, UNLOCATED, response } from "./resourceFixtures";
import { makeIndex } from "./fixtures";

afterEach(cleanup);

type SearchFn = (p: SearchParams, s?: AbortSignal) => Promise<SearchResponse>;

function setup(search = vi.fn<SearchFn>(async () => response())) {
  const store = createResourceStore(search);
  const focus = vi.fn(() => true);
  const user = userEvent.setup();
  render(
    <ResourcePanel
      store={store}
      getLayer={() => ({ focus, has: () => true, markerCount: () => 0, destroy() {} })}
      originDeps={{ getMap: () => ({ getCenter: () => L.latLng(32.95, -96.73) }), getIndex: () => makeIndex(), getSelected: () => null, store }}
    />,
  );
  const region = screen.getByRole("region", { name: "Food assistance resources" });
  const searchBtn = within(region).getByRole("button", { name: "Search" });
  return { store, focus, user, region, search, searchBtn };
}

describe("ResourcePanel", () => {
  it("starts empty with a clear instruction and disabled clear button", () => {
    const { region } = setup();
    expect(within(region).getByRole("status").textContent).toMatch(/No search yet/);
    expect((within(region).getByRole("button", { name: /Clear search/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("searches with defaults (food categories only) and renders results with honest labels", async () => {
    const { user, searchBtn, region, search } = setup();
    await user.click(searchBtn);
    const params = search.mock.calls[0][0];
    expect(params.categories).toEqual(["food_distribution", "snap_application_help", "senior_food_box"]);
    expect(params.radiusMiles).toBe(5);
    expect(await within(region).findByText(A.name)).toBeTruthy();
    expect(within(region).getByRole("status").textContent).toMatch(/2 resources within 5 mi \(straight-line\) of the centre of the current map view/);
    expect(within(region).getByText(/capture date not recorded/)).toBeTruthy();
    expect(within(region).getByText("0.8 mi straight-line")).toBeTruthy();
    // Missing fields are labelled, not filled in.
    const bCard = within(region).getByText(B.name).closest("article")!;
    expect(within(bCard).getByText("Phone not listed")).toBeTruthy();
    expect(within(bCard).getByText("Website not listed")).toBeTruthy();
    expect(region.textContent).not.toMatch(/open now/i);
  });

  it("lists resources without a verified location separately, with no distance or map button", async () => {
    const { user, searchBtn, region } = setup();
    await user.click(searchBtn);
    await user.click(await within(region).findByText(/1 listed without a verified map location/));
    const card = within(region).getByText(UNLOCATED.name).closest("article")!;
    expect(within(card).getByText("Distance unknown")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Show on map" })).toBeNull();
    expect(UNLOCATED.name).toContain("<b>"); // rendered as text, not HTML
    expect(card.querySelector("b")?.textContent).not.toBe("Org");
  });

  it("'Show on map' focuses the marker and the selected card is marked current", async () => {
    const { user, searchBtn, region, focus, store } = setup();
    await user.click(searchBtn);
    const card = (await within(region).findByText(A.name)).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Show on map" }));
    expect(focus).toHaveBeenCalledWith(A.id);
    store.select(A.id);
    expect((await within(region).findByText(A.name)).closest("article")!.getAttribute("aria-current")).toBe("true");
  });

  it("city searches label located listings by city instead of 'Distance unknown'", async () => {
    const { user, searchBtn, region } = setup(vi.fn<SearchFn>(async () => response({ results: [{ ...A, distance_miles_straight_line: null }], total_in_radius: 1, unlocated: [] })));
    await user.click(searchBtn);
    const card = (await within(region).findByText(A.name)).closest("article")!;
    expect(within(card).getByText("Richardson listing")).toBeTruthy();
    expect(within(card).queryByText("Distance unknown")).toBeNull();
  });

  it("shows an error with retry", async () => {
    const search = vi.fn<SearchFn>()
      .mockRejectedValueOnce(new ResourceError("network", "Can't reach the FoodFit resource service. Check your connection, or make sure the server is running.", true))
      .mockResolvedValueOnce(response());
    const { user, searchBtn, region } = setup(search);
    await user.click(searchBtn);
    expect((await within(region).findByRole("alert")).textContent).toMatch(/Can't reach/);
    await user.click(within(region).getByRole("button", { name: "Retry" }));
    expect(await within(region).findByText(A.name)).toBeTruthy();
  });

  it("explains empty and out-of-coverage results", async () => {
    const empty = setup(vi.fn<SearchFn>(async () => response({ results: [], total_in_radius: 0, unlocated: [] })));
    await empty.user.click(empty.searchBtn);
    expect(await within(empty.region).findByText(/No listed resources match within 5 mi/)).toBeTruthy();
    cleanup();
    const out = setup(vi.fn<SearchFn>(async () => response({ results: [], total_in_radius: 0, unlocated: [], out_of_coverage: true })));
    await out.user.click(out.searchBtn);
    expect(await within(out.region).findByText(/outside the area FoodFit's resource list covers/)).toBeTruthy();
  });

  it("requires a category and a valid origin before searching", async () => {
    const { user, searchBtn, region, search } = setup();
    for (const box of within(region).getAllByRole("checkbox")) if ((box as HTMLInputElement).checked) await user.click(box);
    await user.click(searchBtn);
    expect(within(region).getByRole("alert").textContent).toMatch(/at least one category/);
    await user.click(within(region).getByRole("checkbox", { name: "Food pantry / distribution" }));
    await user.selectOptions(within(region).getByLabelText("Search near"), "selected_tract");
    await user.click(searchBtn);
    expect(within(region).getByRole("alert").textContent).toMatch(/No tract is selected/);
    expect(search).not.toHaveBeenCalled();
  });

  it("passes day and radius filters through", async () => {
    const { user, searchBtn, region, search } = setup();
    await user.selectOptions(within(region).getByLabelText("Listed hours on"), "Saturday");
    await user.selectOptions(within(region).getByLabelText("Within"), "15");
    await user.click(searchBtn);
    expect(search.mock.calls[0][0]).toMatchObject({ day: "Saturday", radiusMiles: 15 });
  });
});

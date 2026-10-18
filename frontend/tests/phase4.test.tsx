// Phase 4: FitBasket with the deterministic (rules) assistant and the structured response contract.
import L from "leaflet";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatPanel from "../src/chat/ChatPanel";
import { ChatError, type PostChat } from "../src/chat/chatClient";
import { executeTool } from "../src/chat/toolExecutor";
import { coverageReport } from "../src/chat/tractIndex";
import type { ApiMessage, ChatApiResponse } from "../src/chat/types";
import { createResourceStore } from "../src/resources/resourceStore";
import { executeResourceTool } from "../src/resources/resourceTools";
import { searchResources } from "../src/resources/resourceClient";
import { makeController, makeIndex } from "./fixtures";
import { response, SOURCE } from "./resourceFixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOTICE = "The AI model isn't configured on this server, so FitBasket's built-in assistant answered from FoodFit's data.";

function rulesCall(name: string, args: Record<string, unknown>, intent: string): ChatApiResponse {
  const id = `rules_fb_${intent}_0`;
  return {
    type: "tool_calls",
    intent,
    source: "rules",
    fallback_used: true,
    notice: null,
    suggestions: [],
    assistant_message: { role: "assistant", content: "", tool_calls: [{ id, name: name as never, arguments: JSON.stringify(args) }] },
    tool_calls: [{ id, name, arguments: args }],
  };
}

function rulesMessage(content: string, intent: string, suggestions: string[] = []): ChatApiResponse {
  return { type: "message", content, intent, source: "rules", fallback_used: true, notice: NOTICE, suggestions };
}

function setup(post: PostChat, resourceTools?: Parameters<typeof ChatPanel>[0]["resourceTools"]) {
  const c = makeController();
  const user = userEvent.setup();
  render(<ChatPanel controller={c.controller} getIndex={() => c.index} dataStatus="ready" post={post} resourceTools={resourceTools} />);
  return { ...c, user };
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  if (!screen.queryByRole("dialog")) await user.click(screen.getByRole("button", { name: "Open FitBasket chat" }));
  await user.type(screen.getByRole("textbox", { name: "Message FitBasket" }), `${text}{Enter}`);
}

/** Simulates the server: first a rules tool call, then a message composed from the browser's real tool result. */
function rulesServer(name: string, args: Record<string, unknown>, intent: string, compose: (result: Record<string, unknown>) => string) {
  const seen: ApiMessage[][] = [];
  const post = vi.fn<PostChat>(async (messages) => {
    seen.push(messages);
    const last = messages[messages.length - 1];
    if (last.role === "user") return rulesCall(name, args, intent);
    const result = JSON.parse((last as { content: string }).content);
    return rulesMessage(compose(result), intent, ["Summarize this area", "Go back to the Texas overview"]);
  });
  return { post, seen };
}

describe("FitBasket with the built-in (rules) assistant", () => {
  it("Dallas County: executes the validated map action and renders the rules answer, notice and suggestions", async () => {
    const { post, seen } = rulesServer("zoom_to_county", { county: "Dallas" }, "navigate_county",
      (r) => (r.ok ? `Here's **${r.county}** on the map — its ${r.tract_count} census tracts are shaded.` : String(r.message)));
    const { user, map } = setup(post);
    await ask(user, "Show me Dallas County on the map");
    expect(await screen.findByText(/on the map — its 2 census tracts are shaded/)).toBeTruthy();
    expect(map.fitBounds).toHaveBeenCalledTimes(1); // the real map moved
    expect(map.getBounds().contains(L.latLng(32.8, -96.7))).toBe(true);
    expect(screen.getByText("Map moved to Dallas County")).toBeTruthy();
    expect(screen.getByText(/Answered by FitBasket's built-in assistant/)).toBeTruthy();
    expect(screen.getByText(new RegExp("isn't configured on this server"))).toBeTruthy();
    // the browser's actual result went back to the server
    expect(JSON.parse((seen[1].at(-1) as { content: string }).content)).toMatchObject({ ok: true, county: "Dallas County" });
    // suggestions are clickable follow-ups
    await user.click(screen.getByRole("button", { name: "Go back to the Texas overview" }));
    expect(post).toHaveBeenCalledTimes(4); // the follow-up is a full turn: tool call + composed answer
  });

  it("reset: returns the map to the full view", async () => {
    const { post } = rulesServer("reset_map", {}, "reset_view", () => "Back to the full Texas overview.");
    const { user, map, state } = setup(post);
    state.selected = "48113000100";
    await ask(user, "Reset the map");
    expect(await screen.findByText("Back to the full Texas overview.")).toBeTruthy();
    expect(map.closePopup).toHaveBeenCalled();
    expect(state.selected).toBeNull();
    expect(screen.getByText("Map reset to full Texas view")).toBeTruthy();
  });

  it("unknown county: the map is not moved and the failure is shown", async () => {
    const { post } = rulesServer("zoom_to_county", { county: "gotham" }, "navigate_county", (r) => String(r.message));
    const { user, map } = setup(post);
    await ask(user, "Show Gotham County");
    expect((await screen.findAllByText(/not a Texas county in FoodFit data/)).length).toBeGreaterThan(0);
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it("comparison: renders the composed markdown table", async () => {
    const post = vi.fn<PostChat>()
      .mockResolvedValueOnce(rulesCall("compare_locations", { a: { kind: "county", id: "Dallas" }, b: { kind: "county", id: "Tarrant" } }, "compare"))
      .mockResolvedValueOnce(rulesMessage("| Indicator | Dallas County | Tarrant County | Difference |\n|---|---|---|---|\n| Overall need score | 50.0 | 60.0 | -10.0 |", "compare"));
    const { user } = setup(post);
    await ask(user, "Compare Dallas County and Tarrant County");
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Tarrant County" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "-10.0" })).toBeTruthy();
    expect(screen.getByText("Compared FoodFit data")).toBeTruthy();
  });

  it("resource search: runs the shared search and renders the composed list", async () => {
    const store = createResourceStore(async () => response());
    const tools = {
      getMap: () => ({ getCenter: () => L.latLng(32.95, -96.73) }),
      getIndex: () => makeIndex(),
      getSelected: () => null,
      store,
      getLayer: () => null,
    };
    const { post } = rulesServer("search_resources", { near: { kind: "city", id: "Richardson" } }, "resource_search",
      (r) => `Found ${r.total_in_radius} listed resources for ${r.searched_from}:\n1. **${(r.results as { name: string }[])[0].name}** · phone not listed`);
    const { user } = setup(post, tools);
    await ask(user, "Find food pantries near Richardson");
    expect(await screen.findByText(/Found 2 listed resources for Richardson listings/)).toBeTruthy();
    expect(screen.getByText("TEST Pantry A").tagName).toBe("STRONG");
    expect(store.getState().params).toMatchObject({ origin: null, city: "Richardson" });
    expect(screen.getByText(/Food resources: .*capture date not recorded/)).toBeTruthy();
  });

  it("LLM answers are labelled as such", async () => {
    const post = vi.fn<PostChat>(async () => ({ type: "message", content: "From the model.", intent: "explain_heatmap", source: "watsonx", fallback_used: false, notice: null, suggestions: [] }));
    const { user } = setup(post);
    await ask(user, "What does this heatmap show?");
    expect(await screen.findByText("From the model.")).toBeTruthy();
    expect(screen.getByText("Answered by the AI model (IBM watsonx.ai)")).toBeTruthy();
  });

  it("backend unavailable: clear error with retry", async () => {
    const post = vi.fn<PostChat>().mockRejectedValue(new ChatError("network", "I can't reach the FoodFit assistant service. Check your connection, or make sure the chat server is running.", true));
    const { user } = setup(post);
    await ask(user, "Show me Dallas County");
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't reach the FoodFit assistant/);
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
  });

  it("ignores malformed suggestion values from the server", async () => {
    const post = vi.fn<PostChat>(async () => ({ ...rulesMessage("ok", "help"), suggestions: ["Good one", "", "x".repeat(500), 5 as never] }));
    const { user } = setup(post);
    await ask(user, "hello");
    const box = await screen.findByLabelText("Suggested follow-ups");
    expect(within(box).getAllByRole("button").map((b) => b.textContent)).toEqual(["Good one"]);
  });
});

describe("data_coverage tool", () => {
  it("reports missing values (null, not zero) from the loaded tracts", () => {
    const c = makeController();
    const r = executeTool("data_coverage", {}, { controller: c.controller, getIndex: () => c.index });
    expect(r).toMatchObject({ ok: true, total_tracts: 6, counties: 5, raw_missing: { low_access_pct: 1, poverty_rate: 0 } });
    expect(r.counties_with_unobserved_grocery).toEqual([{ county: "Dallas", total: 2, missing: 1 }]);
    expect(executeTool("data_coverage", { x: 1 }, { controller: c.controller, getIndex: () => c.index })).toMatchObject({ ok: false, error: "invalid_arguments" });
  });

  it("coverageReport counts unobserved source values", () => {
    expect(coverageReport(makeIndex()).unobserved_source_values).toEqual({ income: 0, transportation: 0, grocery: 1 });
  });
});

describe("city resource searches", () => {
  it("send ?city= without coordinates and validate the name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response({ query: { lat: null, lng: null, radius_miles: null, city: "Plano", categories: ["food_distribution"], day: null, date: null } })), { status: 200 })));
    await searchResources({ origin: null, city: "Plano", radiusMiles: 5, categories: ["food_distribution"], day: null, limit: 5 });
    const url = new URL(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]), "http://x");
    expect(url.searchParams.get("city")).toBe("Plano");
    expect(url.searchParams.has("lat")).toBe(false);
    await expect(searchResources({ origin: null, city: "<script>", radiusMiles: 5, categories: ["food_distribution"], day: null, limit: 5 }))
      .rejects.toMatchObject({ code: "invalid_request" });
  });

  it("the chat tool rejects invalid city ids and reports unknown cities honestly", async () => {
    const store = createResourceStore(async () => response({ results: [], total_in_radius: 0, unlocated: [], unknown_city: true, known_cities: ["Plano", "Richardson"], query: { lat: null, lng: null, radius_miles: null, city: "Frisco", categories: [], day: null, date: null } }));
    const deps = { getMap: () => null, getIndex: () => null, getSelected: () => null, store, getLayer: () => null, getResource: vi.fn() };
    expect(await executeResourceTool("search_resources", { near: { kind: "city", id: "1; drop" } }, deps)).toMatchObject({ ok: false, error: "invalid_arguments" });
    const r = await executeResourceTool("search_resources", { near: { kind: "city", id: "Frisco" } }, deps);
    expect(r).toMatchObject({ ok: true, unknown_city: true, known_cities: ["Plano", "Richardson"], total_in_radius: 0 });
    expect(String(r.source)).toContain(SOURCE.file);
  });
});

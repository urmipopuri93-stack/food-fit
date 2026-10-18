import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatError, postChat, runTurn, trimHistory, type PostChat } from "../src/chat/chatClient";
import { executeTool } from "../src/chat/toolExecutor";
import type { ApiMessage, ChatApiResponse } from "../src/chat/types";
import { makeController } from "./fixtures";

function deps(responses: ChatApiResponse[]) {
  const c = makeController();
  const calls: ApiMessage[][] = [];
  const post: PostChat = vi.fn(async (messages) => {
    calls.push(structuredClone(messages));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  });
  return {
    c,
    calls,
    post,
    turn: {
      post,
      execute: (n: string, a: unknown) => executeTool(n, a, { controller: c.controller, getIndex: () => c.index }),
      getContext: () => c.controller.getContext(),
    },
  };
}

const toolCall = (id: string, name: string, args: Record<string, unknown> | null): ChatApiResponse => ({
  type: "tool_calls",
  assistant_message: { role: "assistant", content: "", tool_calls: [{ id, name: name as never, arguments: JSON.stringify(args) }] },
  tool_calls: [{ id, name, arguments: args }],
});

describe("runTurn", () => {
  it("returns a plain reply", async () => {
    const d = deps([{ type: "message", content: "Hello" }]);
    const r = await runTurn([], "hi", d.turn, new AbortController().signal);
    expect(r.reply).toBe("Hello");
    expect(r.history).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "Hello" }]);
  });

  it("executes tool calls locally and sends real results back before replying", async () => {
    const d = deps([toolCall("c1", "zoom_to_county", { county: "Dallas" }), { type: "message", content: "Moved." }]);
    const r = await runTurn([], "show me dallas", d.turn, new AbortController().signal);
    expect(d.c.map.fitBounds).toHaveBeenCalledTimes(1);
    const toolMsg = d.calls[1].at(-1)!;
    expect(toolMsg.role).toBe("tool");
    expect(JSON.parse((toolMsg as { content: string }).content)).toMatchObject({ ok: true, county: "Dallas County" });
    expect(r.actions).toEqual([{ status: "success", text: "Map moved to Dallas County" }]);
  });

  it("reports failed actions and never moves the map for unsupported places", async () => {
    const d = deps([toolCall("c1", "zoom_to_county", { county: "Fort Worth" }), { type: "message", content: "Not available." }]);
    const r = await runTurn([], "fort worth", d.turn, new AbortController().signal);
    expect(d.c.map.fitBounds).not.toHaveBeenCalled();
    expect(r.actions[0].status).toBe("failed");
  });

  it("does not execute calls whose arguments were malformed", async () => {
    const d = deps([toolCall("c1", "zoom_to_county", null), { type: "message", content: "ok" }]);
    await runTurn([], "x", d.turn, new AbortController().signal);
    expect(d.c.map.fitBounds).not.toHaveBeenCalled();
    expect(JSON.parse((d.calls[1].at(-1) as { content: string }).content).error).toBe("invalid_arguments");
  });

  it("sends fresh map context with every request", async () => {
    const d = deps([toolCall("c1", "zoom_to_county", { county: "Tarrant" }), { type: "message", content: "ok" }]);
    const contexts: unknown[] = [];
    await runTurn([], "x", { ...d.turn, post: async (m, ctx, s) => { contexts.push(ctx); return d.post(m, ctx, s); } }, new AbortController().signal);
    expect((contexts[0] as { visible_counties: string[] }).visible_counties).not.toEqual(["Tarrant"]);
    expect((contexts[1] as { visible_counties: string[] }).visible_counties).toEqual(["Tarrant"]);
  });

  it("stops after too many tool rounds", async () => {
    const d = deps(Array.from({ length: 6 }, (_, i) => toolCall(`c${i}`, "get_map_context", {})));
    await expect(runTurn([], "loop", d.turn, new AbortController().signal)).rejects.toMatchObject({ code: "too_many_rounds" });
  });
});

describe("trimHistory", () => {
  it("cuts only at user boundaries", () => {
    const h: ApiMessage[] = [];
    for (let i = 0; i < 10; i++) {
      h.push({ role: "user", content: `u${i}` });
      h.push({ role: "assistant", content: "", tool_calls: [{ id: `t${i}`, name: "get_map_context", arguments: "{}" }] });
      h.push({ role: "tool", tool_call_id: `t${i}`, content: "{}" });
      h.push({ role: "assistant", content: `a${i}` });
    }
    const t = trimHistory(h, 3);
    expect(t[0]).toEqual({ role: "user", content: "u7" });
    expect(t).toHaveLength(12);
  });
});

describe("postChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const respond = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

  it("posts to the same-origin chat endpoint with no credentials in the body", async () => {
    respond(200, { type: "message", content: "hi" });
    await postChat([{ role: "user", content: "x" }], null, new AbortController().signal);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/chat");
    expect(String(init.body)).not.toMatch(/apikey|api_key|token/i);
  });

  it.each([
    [503, { error: { code: "not_configured", message: "x" } }, "not_configured", false],
    [504, { error: { code: "timeout", message: "x" } }, "timeout", true],
    [429, { error: { code: "too_many_requests", message: "Too many messages." } }, "too_many_requests", true],
    [502, { error: { code: "provider_error", message: "The AI service is unavailable right now." } }, "provider_error", true],
    [422, { error: { code: "invalid_request" } }, "invalid_request", false],
  ])("maps HTTP %i to a friendly error", async (status, body, code, retryable) => {
    respond(status, body);
    const err = await postChat([{ role: "user", content: "x" }], null, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect(err).toMatchObject({ code, retryable });
    expect(err.message).not.toMatch(/stack|Traceback/);
  });

  it("treats malformed responses as errors, not answers", async () => {
    respond(200, { choices: [] });
    await expect(postChat([{ role: "user", content: "x" }], null, new AbortController().signal)).rejects.toMatchObject({ code: "bad_response" });
  });

  it("handles network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(postChat([{ role: "user", content: "x" }], null, new AbortController().signal)).rejects.toMatchObject({ code: "network", retryable: true });
  });

  it("times out a hung request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    const p = postChat([{ role: "user", content: "x" }], null, new AbortController().signal).catch((e) => e);
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await p).toMatchObject({ code: "timeout", retryable: true });
  });
});

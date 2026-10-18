import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatPanel from "../src/chat/ChatPanel";
import { GREETING } from "../src/chat/chatCopy";
import { ChatError, type PostChat } from "../src/chat/chatClient";
import type { ChatApiResponse } from "../src/chat/types";
import { makeController } from "./fixtures";

afterEach(cleanup);

function setup(post: PostChat, dataStatus: "ready" | "loading" | "error" = "ready") {
  const c = makeController();
  const user = userEvent.setup();
  render(<ChatPanel controller={c.controller} getIndex={() => c.index} dataStatus={dataStatus} post={post} />);
  return { ...c, user };
}

async function openChat(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open FitBasket chat" }));
  return screen.getByRole("textbox", { name: "Message FitBasket" });
}

const reply = (content: string): ChatApiResponse => ({ type: "message", content });

describe("ChatPanel", () => {
  it("opens with a greeting and closes, returning focus to the launcher", async () => {
    const { user, map } = setup(vi.fn());
    const input = await openChat(user);
    expect(screen.getByRole("dialog", { name: "Ask FitBasket" })).toBeTruthy();
    expect(screen.getByText(GREETING)).toBeTruthy();
    expect(document.activeElement).toBe(input);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open FitBasket chat" })));
    expect(map.fitBounds).not.toHaveBeenCalled(); // opening/closing never touches the map
  });

  it("does not submit empty or whitespace-only messages", async () => {
    const post = vi.fn();
    const { user } = setup(post);
    const input = await openChat(user);
    const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await user.type(input, "   ");
    expect(send.disabled).toBe(true);
    await user.keyboard("{Enter}");
    expect(post).not.toHaveBeenCalled();
  });

  it("sends with Enter, inserts a newline with Shift+Enter, and shows the reply", async () => {
    const post = vi.fn<PostChat>(async () => reply("FoodFit maps estimated barriers."));
    const { user } = setup(post);
    const input = (await openChat(user)) as HTMLTextAreaElement;
    await user.type(input, "line one{Shift>}{Enter}{/Shift}line two");
    expect(input.value).toBe("line one\nline two");
    expect(post).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("FoodFit maps estimated barriers.")).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toEqual([{ role: "user", content: "line one\nline two" }]);
    expect(input.value).toBe("");
  });

  it("sends with the send button", async () => {
    const post = vi.fn<PostChat>(async () => reply("ok"));
    const { user } = setup(post);
    await user.type(await openChat(user), "hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("ok")).toBeTruthy();
  });

  it("shows a loading indicator and blocks duplicate submissions while waiting", async () => {
    let resolve!: (v: ChatApiResponse) => void;
    const post = vi.fn<PostChat>(() => new Promise((r) => (resolve = r)));
    const { user } = setup(post);
    const input = await openChat(user);
    await user.type(input, "first{Enter}");
    expect(screen.getByText("FitBasket is thinking…")).toBeTruthy();
    expect(screen.getByRole("log").getAttribute("aria-busy")).toBe("true");
    await user.type(input, "second{Enter}");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => resolve(reply("done")));
    expect(await screen.findByText("done")).toBeTruthy();
    expect(screen.queryByText("FitBasket is thinking…")).toBeNull();
  });

  it("shows an understandable error and lets the user retry", async () => {
    const post = vi
      .fn<PostChat>()
      .mockRejectedValueOnce(new ChatError("timeout", "The assistant took too long to respond. Please try again.", true))
      .mockResolvedValueOnce(reply("Second time lucky."));
    const { user } = setup(post);
    await user.type(await openChat(user), "explain the map{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/took too long/);
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("Second time lucky.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(post.mock.calls[1][0]).toEqual([{ role: "user", content: "explain the map" }]);
    expect(screen.getAllByText("explain the map")).toHaveLength(1);
  });

  it("does not offer retry or pretend to answer when the AI is not configured", async () => {
    const post = vi.fn<PostChat>().mockRejectedValue(new ChatError("not_configured", "The AI assistant isn't set up on this server yet, so I can't answer questions. The map still works normally.", false));
    const { user } = setup(post);
    await user.type(await openChat(user), "hi{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn't set up/);
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("performs a validated map action and shows what actually happened", async () => {
    const post = vi
      .fn<PostChat>()
      .mockResolvedValueOnce({
        type: "tool_calls",
        assistant_message: { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "zoom_to_county", arguments: '{"county":"Dallas"}' }] },
        tool_calls: [{ id: "c1", name: "zoom_to_county", arguments: { county: "Dallas" } }],
      })
      .mockResolvedValueOnce(reply("Here is Dallas County."));
    const { user, map } = setup(post);
    await user.type(await openChat(user), "Show me Dallas{Enter}");
    expect(await screen.findByText("Here is Dallas County.")).toBeTruthy();
    expect(screen.getByText("Map moved to Dallas County")).toBeTruthy();
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it("shows a failed action and leaves the map alone for unsupported places", async () => {
    const post = vi
      .fn<PostChat>()
      .mockResolvedValueOnce({
        type: "tool_calls",
        assistant_message: { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "zoom_to_county", arguments: '{"county":"Fort Worth"}' }] },
        tool_calls: [{ id: "c1", name: "zoom_to_county", arguments: { county: "Fort Worth" } }],
      })
      .mockResolvedValueOnce(reply("FoodFit only has counties. Which county do you mean?"));
    const { user, map } = setup(post);
    await user.type(await openChat(user), "show fort worth{Enter}");
    expect(await screen.findByText(/Which county do you mean/)).toBeTruthy();
    expect(screen.getByText(/not a Texas county in FoodFit data/)).toBeTruthy();
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it("labels data-backed answers with their sources", async () => {
    const post = vi
      .fn<PostChat>()
      .mockResolvedValueOnce({
        type: "tool_calls",
        assistant_message: { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "summarize_location", arguments: "{}" }] },
        tool_calls: [{ id: "c1", name: "summarize_location", arguments: { location: { kind: "county", id: "Tarrant" } } }],
      })
      .mockResolvedValueOnce(reply("**Tarrant County** overall score 60."));
    const { user } = setup(post);
    await user.type(await openChat(user), "summarize tarrant{Enter}");
    await screen.findByText("Tarrant County");
    expect(screen.getByText(/American Community Survey census-tract data \(2015\)/)).toBeTruthy();
    expect(screen.getByText("Read FoodFit data: Tarrant County")).toBeTruthy();
  });

  it("starter prompts send immediately and only advertise implemented features", async () => {
    const post = vi.fn<PostChat>(async () => reply("ok"));
    const { user } = setup(post);
    await openChat(user);
    const starters = screen.getByLabelText("Suggested questions").querySelectorAll("button");
    expect([...starters].map((b) => b.textContent)).not.toContain("Show me a city on the map.");
    await user.click(screen.getByRole("button", { name: /Show me Dallas County/ }));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("warns when map data is unavailable", async () => {
    const { user } = setup(vi.fn(), "error");
    await openChat(user);
    expect(screen.getByRole("status").textContent).toMatch(/failed to load/);
  });

  it("New chat clears the session (no cross-session memory)", async () => {
    const post = vi.fn<PostChat>(async () => reply("first answer"));
    const { user } = setup(post);
    await user.type(await openChat(user), "one{Enter}");
    await screen.findByText("first answer");
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.queryByText("first answer")).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Message FitBasket" }), "two{Enter}");
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][0]).toEqual([{ role: "user", content: "two" }]);
  });
});

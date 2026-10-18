import { describeResult, sourceFor } from "./toolExecutor";
import type { ActionChip, ApiMessage, ChatApiResponse, MapContextPayload, ToolResult } from "./types";
import { MAP_ACTION_TOOLS } from "./types";

export const CHAT_ENDPOINT = `${import.meta.env.VITE_CHAT_API_BASE ?? ""}/api/chat`;
export const REQUEST_TIMEOUT_MS = 45_000;
export const MAX_TOOL_ROUNDS = 5;
export const MAX_USER_TURNS_KEPT = 8;

export class ChatError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const FRIENDLY: Record<string, [string, boolean]> = {
  network: ["I can't reach the FoodFit assistant service. Check your connection, or make sure the chat server is running.", true],
  timeout: ["The assistant took too long to respond. Please try again.", true],
  not_configured: ["The AI assistant isn't set up on this server yet, so I can't answer questions. The map still works normally.", false],
  invalid_request: ["That message couldn't be processed. Try rephrasing it, or start a new chat.", false],
  too_large: ["This conversation is too long. Please start a new chat.", false],
  bad_response: ["The AI service returned an unreadable answer. Please try again.", true],
  too_many_rounds: ["I couldn't complete that request. Please try rephrasing it more simply.", true],
  service_missing: ["The FoodFit assistant service isn't reachable at this address. If you deployed the site, make sure chat-api is running and /api is routed to it.", false],
};

function friendly(code: string, serverMessage?: string, fallbackRetry = true): ChatError {
  const known = FRIENDLY[code];
  if (known) return new ChatError(code, known[0], known[1]);
  return new ChatError(code, serverMessage || "Something went wrong. Please try again.", fallbackRetry);
}

function isChatApiResponse(v: unknown): v is ChatApiResponse {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (r.type === "message") return typeof r.content === "string";
  if (r.type === "tool_calls") {
    const am = r.assistant_message as Record<string, unknown> | undefined;
    return Array.isArray(r.tool_calls) && !!am && Array.isArray(am.tool_calls) &&
      r.tool_calls.every((c) => c && typeof c === "object" && typeof (c as Record<string, unknown>).id === "string" &&
        typeof (c as Record<string, unknown>).name === "string");
  }
  return false;
}

export type PostChat = (
  messages: ApiMessage[],
  context: MapContextPayload | null,
  signal: AbortSignal,
) => Promise<ChatApiResponse>;

export const postChat: PostChat = async (messages, context, signal) => {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  signal.addEventListener("abort", onAbort);
  let res: Response;
  try {
    res = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, context }),
      signal: timeout.signal,
    });
  } catch (err) {
    if (signal.aborted) throw new ChatError("aborted", "Request cancelled.", false);
    if (timeout.signal.aborted) throw friendly("timeout");
    void err;
    throw friendly("network");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const apiError = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (!res.ok) {
    if (!apiError || typeof apiError.code !== "string") {
      // Not a response from chat-api (e.g. a static host's 404 page): the API isn't deployed or routed here.
      if ([404, 405, 501].includes(res.status)) throw friendly("service_missing");
      if (res.status === 504) throw friendly("timeout");
      if (res.status >= 500) throw friendly("network"); // e.g. a proxy in front of a stopped chat-api
      throw friendly(body === null ? "service_missing" : `http_${res.status}`, undefined, res.status === 429);
    }
    throw friendly(apiError.code, typeof apiError.message === "string" ? apiError.message : undefined, res.status >= 500 || res.status === 429);
  }
  if (body === null) throw friendly("service_missing");
  if (!isChatApiResponse(body)) throw friendly("bad_response");
  return body;
};

/** Keep the last N user turns; cut only at user-message boundaries so tool pairs stay intact. */
export function trimHistory(history: ApiMessage[], maxUserTurns = MAX_USER_TURNS_KEPT): ApiMessage[] {
  const userIdx = history.flatMap((m, i) => (m.role === "user" ? [i] : []));
  if (userIdx.length <= maxUserTurns) return history;
  return history.slice(userIdx[userIdx.length - maxUserTurns]);
}

export type TurnDeps = {
  post: PostChat;
  execute: (name: string, args: unknown) => ToolResult | Promise<ToolResult>;
  getContext: () => MapContextPayload | null;
  onAction?: (chip: ActionChip) => void;
};

export type TurnResult = {
  history: ApiMessage[];
  reply: string;
  actions: ActionChip[];
  sources: string[];
  /** Who wrote the final answer: the AI model, or FitBasket's built-in (deterministic) assistant. */
  answeredBy?: "watsonx" | "rules";
  /** Why the built-in assistant answered (e.g. the AI model isn't configured), when the server says so. */
  notice?: string | null;
  suggestions: string[];
  /** Message of the first map action the browser failed to apply this turn, if any. */
  mapError?: string | null;
};

const EXPECTED_REFUSALS = new Set(["not_found", "ambiguous", "at_limit", "unsupported_action", "no_coordinates", "same_resource"]);
function isExpectedRefusal(result: ToolResult): boolean {
  const code = typeof result.error === "string" ? result.error : "";
  return EXPECTED_REFUSALS.has(code) || code.startsWith("invalid_");
}

export async function runTurn(history: ApiMessage[], userText: string, deps: TurnDeps, signal: AbortSignal): Promise<TurnResult> {
  const working: ApiMessage[] = [...trimHistory(history), { role: "user", content: userText }];
  const actions: ActionChip[] = [];
  const sources: string[] = [];
  let notice: string | null = null;
  let mapError: string | null = null;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Re-read map state every round: the user may have moved the map manually.
    const res = await deps.post([...working], deps.getContext(), signal);
    notice = (typeof res.notice === "string" && res.notice) || notice;
    if (res.type === "message") {
      working.push({ role: "assistant", content: res.content });
      return {
        history: working,
        reply: res.content,
        actions,
        sources,
        answeredBy: res.source === "watsonx" || res.source === "rules" ? res.source : undefined,
        notice,
        mapError,
        suggestions: Array.isArray(res.suggestions)
          ? res.suggestions.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 120).slice(0, 5)
          : [],
      };
    }
    working.push({
      role: "assistant",
      content: res.assistant_message.content ?? "",
      tool_calls: res.assistant_message.tool_calls,
    });
    for (const call of res.tool_calls) {
      let result: ToolResult;
      try {
        result = call.arguments === null
          ? { ok: false, error: "invalid_arguments", message: "Arguments were not valid JSON." }
          : await deps.execute(call.name, call.arguments);
      } catch {
        result = { ok: false, error: "execution_failed", message: "The action failed unexpectedly." };
      }
      // Operational failures only: an unknown/ambiguous place or a zoom limit is a normal answer, not a broken map.
      if ((MAP_ACTION_TOOLS as readonly string[]).includes(call.name) && !result.ok && mapError === null && !isExpectedRefusal(result)) {
        mapError = typeof result.message === "string" && result.message ? result.message : "The map action could not be applied.";
      }
      const chip = describeResult(call.name, result);
      if (chip) {
        actions.push(chip);
        deps.onAction?.(chip);
      }
      const src = sourceFor(call.name, result);
      if (src && !sources.includes(src)) sources.push(src);
      working.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
    }
  }
  throw friendly("too_many_rounds");
}

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Send, Sparkles, X, RotateCcw, CheckCircle2, AlertTriangle, Database } from "lucide-react";
import mascot from "../../assets/Untitled 10.png";
import { ChatError, postChat as defaultPost, runTurn, type PostChat } from "./chatClient";
import MessageText from "./MessageText";
import { GREETING, STARTERS } from "./chatCopy";
import type { MapController } from "./mapController";
import { executeTool } from "./toolExecutor";
import { executeResourceTool, isResourceTool, type ResourceToolDeps } from "../resources/resourceTools";
import type { TractIndex } from "./tractIndex";
import type { ActionChip, ApiMessage, UiMessage } from "./types";
import "./chat.css";


type Props = {
  controller: MapController;
  getIndex: () => TractIndex | null;
  dataStatus: "loading" | "ready" | "error";
  post?: PostChat;
  /** Food-resource tools; when absent, resource requests are reported as unavailable. */
  resourceTools?: ResourceToolDeps;
};

type ErrorMsg = Extract<UiMessage, { role: "error" }> & { actions?: ActionChip[] };
type Msg = Exclude<UiMessage, { role: "error" }> | ErrorMsg;

let seq = 0;
const nextId = () => `m${++seq}`;

export default function ChatPanel({ controller, getIndex, dataStatus, post = defaultPost, resourceTools }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastFailed, setLastFailed] = useState<string | null>(null);

  const busyRef = useRef(false); // guards double submits within one render
  const history = useRef<ApiMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const stickToBottom = useRef(true);
  const panelId = useId();
  const titleId = useId();

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const el = logRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  }, []);

  const send = useCallback(
    async (raw: string, isRetry = false) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;
      busyRef.current = true;
      if (!isRetry) setMessages((m) => [...m, { id: nextId(), role: "user", text }]);
      else setMessages((m) => m.filter((x) => x.role !== "error"));
      setInput("");
      setBusy(true);
      setLastFailed(null);
      stickToBottom.current = true;

      const gen = ++generation.current;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const performed: ActionChip[] = [];
      try {
        const result = await runTurn(
          history.current,
          text,
          {
            post,
            execute: (name, args) => {
              if (!isResourceTool(name)) return executeTool(name, args, { controller, getIndex });
              if (!resourceTools) return { ok: false, error: "unsupported_action", message: "Resource search is not available on this page." };
              return executeResourceTool(name, args, resourceTools);
            },
            getContext: () => controller.getContext(),
            onAction: (chip) => performed.push(chip),
          },
          ctrl.signal,
        );
        if (gen !== generation.current) return; // stale (chat was reset)
        history.current = result.history;
        setMessages((m) => [
          ...m,
          {
            id: nextId(),
            role: "assistant",
            text: result.reply,
            actions: result.actions,
            sources: result.sources,
            answeredBy: result.answeredBy,
            notice: result.notice,
            suggestions: result.suggestions,
            mapError: result.mapError ?? null,
          },
        ]);
      } catch (err) {
        if (gen !== generation.current) return;
        const e = err instanceof ChatError ? err : new ChatError("unknown", "Something went wrong. Please try again.", true);
        if (e.code === "aborted") return;
        setMessages((m) => [...m, { id: nextId(), role: "error", text: e.message, retryable: e.retryable, actions: performed }]);
        if (e.retryable) setLastFailed(text);
      } finally {
        if (gen === generation.current) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [controller, getIndex, post, resourceTools],
  );

  function resetChat() {
    generation.current++;
    abortRef.current?.abort();
    history.current = [];
    busyRef.current = false;
    setMessages([]);
    setBusy(false);
    setLastFailed(null);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  }

  const canSend = input.trim().length > 0 && !busy;
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <div className="ffc-root">
      {open && (
        <section
          id={panelId}
          className="ffc-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <header className="ffc-header">
            <img src={mascot} alt="" className="ffc-avatar" />
            <h2 id={titleId}>Ask FitBasket</h2>
            <button type="button" className="ffc-text-btn" onClick={resetChat} disabled={messages.length === 0}>
              New chat
            </button>
            <button type="button" className="ffc-icon-btn" onClick={close} aria-label="Close chat">
              <X size={18} aria-hidden="true" />
            </button>
          </header>

          {dataStatus !== "ready" && (
            <p className="ffc-banner" role="status">
              {dataStatus === "loading"
                ? "Map data is still loading. Location answers will be available shortly."
                : "Map data failed to load, so I can't look up locations right now."}
            </p>
          )}

          <div
            ref={logRef}
            className="ffc-log"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-busy={busy}
            tabIndex={0}
            aria-label="Conversation"
            onScroll={(e) => {
              const el = e.currentTarget;
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            <div className="ffc-msg ffc-assistant">
              <p>{GREETING}</p>
            </div>

            {messages.length === 0 && (
              <div className="ffc-starters" aria-label="Suggested questions">
                {STARTERS.map((q) => (
                  <button key={q} type="button" onClick={() => void send(q)} disabled={busy}>
                    <Sparkles size={14} aria-hidden="true" />
                    {q}
                  </button>
                ))}
              </div>
            )}

            {messages.map((m) => {
              if (m.role === "user") {
                return (
                  <div key={m.id} className="ffc-msg ffc-user">
                    <span className="ffc-sr">You said: </span>
                    {m.text}
                  </div>
                );
              }
              if (m.role === "error") {
                return (
                  <div key={m.id} className="ffc-msg ffc-error" role="alert">
                    <Actions actions={m.actions ?? []} />
                    <p>
                      <AlertTriangle size={15} aria-hidden="true" /> {m.text}
                    </p>
                    {m.retryable && lastFailed && (
                      <button type="button" className="ffc-retry" onClick={() => void send(lastFailed, true)} disabled={busy}>
                        <RotateCcw size={14} aria-hidden="true" /> Retry
                      </button>
                    )}
                  </div>
                );
              }
              return (
                <div key={m.id} className="ffc-msg ffc-assistant">
                  <span className="ffc-sr">FitBasket said: </span>
                  <Actions actions={m.actions} />
                  {m.mapError && (
                    <p className="ffc-map-error" role="alert">
                      <strong>The map did not change.</strong> {m.mapError}{" "}
                      {m.id === lastAssistantId && !busy && !m.suggestions?.includes("Reset the map") && (
                        <button type="button" className="ffc-map-recover" onClick={() => void send("Reset the map")}>
                          Reset the map
                        </button>
                      )}
                    </p>
                  )}
                  <MessageText text={m.text} />
                  {m.sources.length > 0 && (
                    <p className="ffc-sources">
                      <Database size={12} aria-hidden="true" />
                      <span>{m.sources.join(" ")}</span>
                    </p>
                  )}
                  {m.answeredBy && (
                    <p className={`ffc-answered ffc-answered-${m.answeredBy}`}>
                      {m.answeredBy === "rules" ? "Answered by FitBasket's built-in assistant" : "Answered by the AI model (IBM watsonx.ai)"}
                      {m.notice ? <span className="ffc-notice"> — {m.notice}</span> : null}
                    </p>
                  )}
                  {m.id === lastAssistantId && m.suggestions && m.suggestions.length > 0 && !busy && (
                    <div className="ffc-suggestions" aria-label="Suggested follow-ups">
                      {m.suggestions.map((q) => (
                        <button key={q} type="button" onClick={() => void send(q)}>
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {busy && (
              <div className="ffc-msg ffc-assistant ffc-thinking" role="status">
                <span className="ffc-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                FitBasket is thinking…
              </div>
            )}
          </div>

          <form
            className="ffc-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <label htmlFor={`${panelId}-input`} className="ffc-sr">
              Message FitBasket
            </label>
            <textarea
              id={`${panelId}-input`}
              ref={inputRef}
              rows={2}
              maxLength={2000}
              value={input}
              placeholder="Ask about the map, a county, or a tract…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button type="submit" aria-label="Send message" disabled={!canSend}>
              <Send size={17} aria-hidden="true" />
            </button>
          </form>
          <p className="ffc-footnote">AI answers use FoodFit data only. Enter to send · Shift+Enter for a new line.</p>
        </section>
      )}

      <button
        ref={launcherRef}
        type="button"
        className="ffc-launcher"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={open ? "Close FitBasket chat" : "Open FitBasket chat"}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <img src={mascot} alt="" />
      </button>
    </div>
  );
}

function Actions({ actions }: { actions: ActionChip[] }) {
  if (!actions.length) return null;
  return (
    <ul className="ffc-actions" aria-label="Actions performed">
      {actions.map((a, i) => (
        <li key={i} className={`ffc-chip ffc-chip-${a.status}`}>
          {a.status === "success" && <CheckCircle2 size={13} aria-hidden="true" />}
          {a.status === "failed" && <AlertTriangle size={13} aria-hidden="true" />}
          {a.status === "info" && <Database size={13} aria-hidden="true" />}
          <span>
            <span className="ffc-sr">{a.status === "failed" ? "Failed: " : a.status === "success" ? "Done: " : ""}</span>
            {a.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

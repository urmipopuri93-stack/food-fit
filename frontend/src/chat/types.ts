import type { TabId } from "../heatmapLayers";

// Must match chat-api/tools.py
export const TOOL_NAMES = [
  "explain_heatmap",
  "get_map_context",
  "zoom_to_county",
  "select_tract",
  "zoom_in",
  "zoom_out",
  "reset_map",
  "set_layer",
  "summarize_location",
  "compare_locations",
  "list_top_tracts",
  "search_resources",
  "get_resource_details",
  "compare_resources",
  "show_resource_on_map",
  "clear_resource_search",
  "data_coverage",
  "find_service_gaps",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const MAP_ACTION_TOOLS: readonly ToolName[] = [
  "zoom_to_county",
  "select_tract",
  "zoom_in",
  "zoom_out",
  "reset_map",
  "set_layer",
  "show_resource_on_map",
  "clear_resource_search",
];

export function isToolName(v: unknown): v is ToolName {
  return typeof v === "string" && (TOOL_NAMES as readonly string[]).includes(v);
}

export type ToolResult = { ok: boolean; [key: string]: unknown };

// ---- API wire format (see chat-api/main.py) ----

export type ApiToolCallRef = { id: string; name: ToolName; arguments: string };

export type ApiMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ApiToolCallRef[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type MapContextPayload = {
  layer: TabId;
  zoom: number;
  center: { lat: number; lng: number };
  selected_tract: { geoid: string; county: string } | null;
  /** County FitBasket last navigated to (highlighted on the map), if any. */
  selected_county?: string | null;
  visible_counties: string[];
  visible_county_count: number;
};

/** Metadata the API adds to every reply (see chat-api/assistant.py). All optional for older servers. */
export type ChatMeta = {
  intent?: string;
  source?: "watsonx" | "rules";
  fallback_used?: boolean;
  notice?: string | null;
  suggestions?: string[];
  geography?: { level: string; name?: string | null; names?: string[] | null; id?: string | null; validated?: boolean | null } | null;
  /** Standardized fields (Phase 5). `message` mirrors `content`; null while tools run. */
  message?: string | null;
  /** "requested" = the browser must apply it; "applied"/"failed" = what the browser reported back. */
  map_action?: { type: string; arguments: Record<string, unknown>; status: "requested" | "applied" | "failed"; result?: Record<string, unknown> | null } | null;
  data?: Record<string, unknown> | null;
  error?: { code: string; message: string; retryable: boolean } | null;
};

export type ChatApiResponse =
  | ({ type: "message"; content: string } & ChatMeta)
  | ({
      type: "tool_calls";
      assistant_message: { role: "assistant"; content: string; tool_calls: ApiToolCallRef[] };
      tool_calls: { id: string; name: string; arguments: Record<string, unknown> | null }[];
    } & ChatMeta);

// ---- UI ----

export type ActionChip = { status: "success" | "failed" | "info"; text: string };

export type UiMessage =
  | { id: string; role: "user"; text: string }
  | {
      id: string;
      role: "assistant";
      text: string;
      actions: ActionChip[];
      sources: string[];
      answeredBy?: "watsonx" | "rules";
      notice?: string | null;
      suggestions?: string[];
      /** A map action in this turn that the browser could NOT apply (never shown as success). */
      mapError?: string | null;
    }
  | { id: string; role: "error"; text: string; retryable: boolean };

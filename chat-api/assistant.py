"""FitBasket response contract and the rules/LLM routing used by POST /api/chat.

The contract keeps the original shape, `{"type": "message", "content"}` or
`{"type": "tool_calls", ...}`, and adds metadata. Every response is validated
by the models below before it is returned.

| Field           | Meaning                                                                 |
|-----------------|-------------------------------------------------------------------------|
| content         | user-facing message (type "message")                                    |
| tool_calls      | the structured, allowlisted map / data actions the browser must execute |
| intent          | request category from the deterministic classifier                     |
| geography       | the geography the request refers to, and whether it was validated       |
| source          | "watsonx" (LLM wrote it) or "rules" (deterministic assistant wrote it)  |
| fallback_used   | true when the deterministic assistant answered                          |
| notice          | why the built-in assistant answered (AI not configured / unavailable)   |
| suggestions     | follow-up questions                                                     |
| message         | the human-readable answer (same text as `content`; null while tools run) |
| map_action      | the structured map operation: `requested` (round 1, the browser must      |
|                 | apply it) or `applied` / `failed` as REPORTED BY THE BROWSER (round 2)   |
| data            | the browser-computed data the answer was written from (summaries,       |
|                 | comparisons, coverage, resource results), when relevant                 |
| error           | structured failure (e.g. a map action the browser could not apply)     |

The server never claims it moved the map: it can only request a map action.
`map_action.status == "applied"` appears only when the browser's own tool result
says the map was verified in the new position.

The "data" for an answer is the tool results the browser computes from the
loaded map and resource data. Rules answers are written only from those results.
"""

from __future__ import annotations

import json
import re
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from rules import RULES_PREFIX, Plan, compose
from tools import LAYER_IDS, TOOL_NAMES

ToolName = Literal[tuple(sorted(TOOL_NAMES))]  # type: ignore[valid-type]
Suggestion = Annotated[str, StringConstraints(min_length=1, max_length=120)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GeographyOut(Strict):
    level: Literal["state", "county", "tract", "city", "map_view"]
    name: str | None = None
    names: list[str] | None = None
    id: str | None = None
    validated: bool | None = None  # None = checked by the browser against the loaded map


MAP_ACTIONS = ("zoom_to_county", "select_tract", "zoom_in", "zoom_out", "reset_map", "set_layer")
MapActionType = Literal[MAP_ACTIONS]  # type: ignore[valid-type]
DATA_TOOLS = ("summarize_location", "compare_locations", "data_coverage", "search_resources",
              "get_resource_details", "compare_resources", "explain_heatmap", "get_map_context", "find_service_gaps")
MAX_DATA_BYTES = 24_000


class LatLngOut(Strict):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lng: float = Field(ge=-180, le=180, allow_inf_nan=False)


class MapActionResult(Strict):
    """What the browser reported after applying (or failing to apply) the action."""
    county: Annotated[str, StringConstraints(max_length=80)] | None = None
    selected_county: Annotated[str, StringConstraints(max_length=60)] | None = None
    geoid: Annotated[str, StringConstraints(pattern=r"^48\d{9}$")] | None = None
    layer: Annotated[str, StringConstraints(max_length=40)] | None = None
    tract_count: int | None = Field(default=None, ge=0)
    zoom: float | None = Field(default=None, ge=0, le=22, allow_inf_nan=False)
    center: LatLngOut | None = None


class MapAction(Strict):
    type: MapActionType
    arguments: dict = Field(default_factory=dict)
    status: Literal["requested", "applied", "failed"]
    result: MapActionResult | None = None

    @model_validator(mode="after")
    def _check_arguments(self) -> "MapAction":
        a = self.arguments
        if self.type == "zoom_to_county":
            c = a.get("county")
            if not isinstance(c, str) or not c.strip() or len(c) > 60:
                raise ValueError("zoom_to_county needs a county name (1-60 characters)")
        elif self.type == "select_tract":
            g = a.get("geoid")
            if not isinstance(g, str) or not re.fullmatch(r"48\d{9}", g):
                raise ValueError("select_tract needs an 11-digit Texas GEOID")
        elif self.type == "set_layer":
            if a.get("layer") not in LAYER_IDS:
                raise ValueError("set_layer needs a known layer id")
        elif self.type in ("zoom_in", "zoom_out"):
            n = a.get("steps", 1)
            if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= 3:
                raise ValueError("zoom steps must be 1-3")
        return self


class ErrorOut(Strict):
    code: Annotated[str, StringConstraints(min_length=1, max_length=40)]
    message: Annotated[str, StringConstraints(min_length=1, max_length=400)]
    retryable: bool = False


class Meta(Strict):
    intent: Annotated[str, StringConstraints(min_length=1, max_length=40)]
    source: Literal["watsonx", "rules"]
    fallback_used: bool
    notice: Annotated[str, StringConstraints(max_length=300)] | None = None
    suggestions: list[Suggestion] = Field(default_factory=list, max_length=5)
    geography: GeographyOut | None = None
    message: Annotated[str, StringConstraints(max_length=8000)] | None = None
    map_action: MapAction | None = None
    data: dict | None = None
    error: ErrorOut | None = None


class OutToolCall(Strict):
    id: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    name: ToolName
    arguments: dict | None


class OutAssistantCall(Strict):
    id: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    name: ToolName
    arguments: Annotated[str, StringConstraints(max_length=2000)]


class OutAssistantMessage(Strict):
    role: Literal["assistant"]
    content: str
    tool_calls: list[OutAssistantCall] = Field(min_length=1, max_length=5)


class MessageResponse(Meta):
    type: Literal["message"]
    content: Annotated[str, StringConstraints(min_length=1, max_length=8000)]


class ToolCallsResponse(Meta):
    type: Literal["tool_calls"]
    assistant_message: OutAssistantMessage
    tool_calls: list[OutToolCall] = Field(min_length=1, max_length=5)


ChatResponse = Annotated[Union[MessageResponse, ToolCallsResponse], Field(discriminator="type")]

NOTICE_NOT_CONFIGURED = "The AI model isn't configured on this server, so FitBasket's built-in assistant answered from FoodFit's data."
NOTICE_PROVIDER = {
    "timeout": "The AI model took too long to respond, so FitBasket's built-in assistant answered from FoodFit's data.",
    "rate_limited": "The AI model is busy right now, so FitBasket's built-in assistant answered from FoodFit's data.",
    "auth_failed": "The server couldn't sign in to the AI model (check its credentials), so FitBasket's built-in assistant answered.",
    "bad_response": "The AI model gave an unusable answer, so FitBasket's built-in assistant answered from FoodFit's data.",
}
NOTICE_PROVIDER_DEFAULT = "The AI model is unavailable right now, so FitBasket's built-in assistant answered from FoodFit's data."


def validated(model: type[BaseModel], payload: dict) -> dict:
    return model.model_validate(payload).model_dump(mode="json", exclude_none=False)


def rules_reply(plan: Plan, fallback: bool, notice: str | None) -> dict:
    """Turn a rules Plan into a validated response (direct message or tool calls)."""
    meta = {"intent": plan.intent, "source": "rules", "fallback_used": True, "notice": notice,
            "suggestions": plan.suggestions[:5], "geography": plan.geography}
    if plan.calls:
        tag = "fb" if fallback else "r"
        calls = [{**c, "id": c["id"].replace(RULES_PREFIX, f"{RULES_PREFIX}{tag}_", 1)} for c in plan.calls]
        return validated(ToolCallsResponse, {
            **meta,
            "type": "tool_calls",
            "assistant_message": {"role": "assistant", "content": "",
                                  "tool_calls": [{"id": c["id"], "name": c["name"], "arguments": json.dumps(c["arguments"])} for c in calls]},
            "tool_calls": [{"id": c["id"], "name": c["name"], "arguments": c["arguments"]} for c in calls],
            "message": None,
            "map_action": requested_map_action({"tool_calls": calls}),
        })
    content = plan.message or "How can I help with FoodFit's map?"
    return validated(MessageResponse, {**meta, "type": "message", "content": content, "message": content})


def rules_ids(tool_call_ids: list[str]) -> tuple[bool, bool, str] | None:
    """('rules_fb_<intent>_<n>') -> (is_rules, was_fallback, intent); None if not all ids are rules ids."""
    if not tool_call_ids or not all(i.startswith(RULES_PREFIX) for i in tool_call_ids):
        return None
    rest = tool_call_ids[0][len(RULES_PREFIX):]
    tag, _, tail = rest.partition("_")
    intent = tail.rsplit("_", 1)[0] if "_" in tail else tail
    return True, tag == "fb", intent or "followup"


_RESULT_KEYS = ("county", "selected_county", "geoid", "layer", "tract_count", "zoom", "center")


def _map_result(r: dict) -> dict | None:
    out = {k: r[k] for k in _RESULT_KEYS if r.get(k) is not None}
    try:
        return MapActionResult.model_validate(out).model_dump(mode="json", exclude_none=True) if out else None
    except ValueError:
        return None  # the browser's free-form result is reported in `content`, never trusted blindly


def _reported_map_action(calls: list[dict], results: list[dict]) -> tuple[dict | None, dict | None]:
    """(map_action, error) from what the browser reported for the first map tool call."""
    for c, r in zip(calls, results):
        if c.get("name") not in MAP_ACTIONS:
            continue
        r = r if isinstance(r, dict) else {}
        ok = r.get("ok") is True
        try:
            action = MapAction.model_validate({"type": c["name"], "arguments": c.get("arguments") or {},
                                               "status": "applied" if ok else "failed", "result": _map_result(r)})
        except ValueError:
            return None, {"code": "invalid_map_action", "message": "The map action was not valid.", "retryable": False}
        err = None
        if not ok:
            code = str(r.get("error") or "map_action_failed")[:40]
            msg = str(r.get("message") or "The map action could not be applied.")[:400]
            err = {"code": code, "message": msg, "retryable": code in ("move_failed", "select_failed", "map_unavailable", "data_unavailable", "zoom_failed", "layer_failed")}
        return action.model_dump(mode="json"), err
    return None, None


def _data(calls: list[dict], results: list[dict]) -> dict | None:
    items = [{"tool": c.get("name"), "result": r} for c, r in zip(calls, results)
             if c.get("name") in DATA_TOOLS and isinstance(r, dict) and r.get("ok") is not False]
    if not items:
        return None
    blob = {"results": items}
    if len(json.dumps(blob, default=str)) > MAX_DATA_BYTES:
        return {"results": [{"tool": i["tool"], "truncated": True} for i in items]}
    return blob


def recovery_suggestions(calls: list[dict], err: dict | None, base: list[str]) -> list[str]:
    """Offer a retry and a way back to a known-good view when a map action failed."""
    if not err:
        return base[:5]
    rec: list[str] = []
    for c in calls:
        if c.get("name") == "zoom_to_county" and err.get("retryable"):
            county = str((c.get("arguments") or {}).get("county") or "").strip()
            if county:
                rec.append(f"Show me {county} County")
    rec.append("Reset the map")
    return list(dict.fromkeys(rec + [s for s in base if s not in rec]))[:5]


def result_suggestions(calls: list[dict], results: list[dict]) -> list[str]:
    """Follow-ups that depend on what the browser found (e.g. 'Show tract <first service gap>')."""
    out: list[str] = []
    for c, r in zip(calls, results):
        if c.get("name") == "find_service_gaps" and isinstance(r, dict) and r.get("ok"):
            gaps = r.get("gaps") or []
            g = gaps[0].get("geoid") if gaps and isinstance(gaps[0], dict) else None
            if isinstance(g, str) and re.fullmatch(r"48\d{9}", g):
                out += [f"Show tract {g}", f"Summarize tract {g}"]
    return out


def requested_map_action(result: dict) -> dict | None:
    """Round 1: the map action the browser is being asked to apply. Raises ValueError if invalid."""
    for tc in result.get("tool_calls") or []:
        if tc.get("name") in MAP_ACTIONS:
            return MapAction.model_validate({"type": tc["name"], "arguments": tc.get("arguments") or {},
                                             "status": "requested"}).model_dump(mode="json")
    return None


def standardize(result: dict) -> dict:
    """Fill the standardized fields (message, map_action) on a round-1 or plain response and re-validate.

    Raises ValueError when a requested map action has invalid arguments, so an LLM response
    carrying one is rejected (the caller falls back to the built-in assistant).
    """
    out = dict(result)
    if out["type"] == "message":
        out["message"] = out.get("message") or out["content"]
        return validated(MessageResponse, out)
    out["message"] = None
    out["map_action"] = out.get("map_action") or requested_map_action(out)
    return validated(ToolCallsResponse, out)


def with_reported(result: dict, calls: list[dict], results: list[dict]) -> dict:
    """Round 2 answered by the AI model: attach what the BROWSER reported (never the model's claim)."""
    if result.get("type") != "message":
        return result
    map_action, err = _reported_map_action(calls, results)
    out = {**result, "map_action": map_action, "error": err, "data": _data(calls, results)}
    if err:
        out["suggestions"] = recovery_suggestions(calls, err, result.get("suggestions") or [])
    return validated(MessageResponse, out)


def compose_reply(intent: str, calls: list[dict], results: list[dict], notice: str | None,
                  suggestions: list[str]) -> dict:
    content = compose(intent, calls, results)[:8000]
    map_action, err = _reported_map_action(calls, results)
    return validated(MessageResponse, {
        "type": "message", "content": content, "message": content, "intent": intent[:40], "source": "rules",
        "fallback_used": True, "notice": notice,
        "suggestions": recovery_suggestions(calls, err, list(dict.fromkeys(result_suggestions(calls, results) + suggestions))),
        "geography": None, "map_action": map_action, "data": _data(calls, results), "error": err,
    })

"""FoodFit chat API: a thin, validated proxy between the browser and watsonx.ai.

Run:  uvicorn main:app --port 8001 --reload   (from the chat-api/ directory)

The server never executes map or data actions. It forwards allowlisted tool
*requests* from the model to the browser, which validates and executes them
against the real map and data, then sends the actual results back here.
"""

from __future__ import annotations

import sys

if sys.version_info < (3, 10):  # pragma: no cover - checked before any 3.10+ syntax is imported
    sys.exit(
        f"FoodFit chat-api needs Python 3.10 or newer, but this is Python {sys.version.split()[0]}.\n"
        "On macOS: brew install python@3.12 && python3.12 -m venv .venv && source .venv/bin/activate"
    )

import json
import logging
import os
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from typing import Annotated, Literal, Union

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, model_validator

from pathlib import Path

from fastapi import Query

from resources.models import ALL_CATEGORIES
from resources.service import DAYS, MAX_RADIUS_MI, ResourceProviderError, ResourceService, SnapshotProvider
from assistant import (NOTICE_NOT_CONFIGURED, NOTICE_PROVIDER, NOTICE_PROVIDER_DEFAULT, ToolCallsResponse, MessageResponse,
                       compose_reply, rules_ids, rules_reply, standardize, validated, with_reported)
from rules import Geography, Rules, follow_ups
from tools import LAYER_IDS, SYSTEM_PROMPT, TOOL_NAMES, TOOLS
from watsonx import ProviderError, WatsonxClient, WatsonxConfig

# Always read chat-api/.env (next to this file), whatever directory the server is started from.
# Real environment variables take precedence over the file.
ENV_FILE = Path(__file__).resolve().with_name(".env")
load_dotenv(ENV_FILE, override=False)


def env(name: str, default: str = "") -> str:
    """Environment value with surrounding whitespace and accidental quotes removed."""
    v = os.getenv(name, default).strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1].strip()
    return v

log = logging.getLogger("foodfit.chat")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

MAX_BODY_BYTES = 96_000
MAX_TOOL_CALLS_PER_TURN = 5
RATE_LIMIT_REQUESTS = int(os.getenv("CHAT_RATE_LIMIT_PER_MIN", "30"))
RATE_LIMIT_WINDOW_S = 60.0

ToolName = Literal[tuple(sorted(TOOL_NAMES))]  # type: ignore[valid-type]
LayerId = Literal[tuple(LAYER_IDS)]  # type: ignore[valid-type]
ShortStr = Annotated[str, StringConstraints(max_length=60)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolCall(Strict):
    id: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    name: ToolName
    arguments: Annotated[str, StringConstraints(max_length=2000)]


class UserMessage(Strict):
    role: Literal["user"]
    content: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class AssistantMessage(Strict):
    role: Literal["assistant"]
    content: Annotated[str, StringConstraints(max_length=6000)] = ""
    tool_calls: list[ToolCall] = Field(default_factory=list, max_length=MAX_TOOL_CALLS_PER_TURN)


class ToolMessage(Strict):
    role: Literal["tool"]
    tool_call_id: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    content: Annotated[str, StringConstraints(max_length=12000)]


Message = Annotated[Union[UserMessage, AssistantMessage, ToolMessage], Field(discriminator="role")]


class LatLng(Strict):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lng: float = Field(ge=-180, le=180, allow_inf_nan=False)


class SelectedTract(Strict):
    geoid: Annotated[str, StringConstraints(pattern=r"^48\d{9}$")]
    county: ShortStr


class MapContext(Strict):
    layer: LayerId
    zoom: float = Field(ge=0, le=22, allow_inf_nan=False)
    center: LatLng
    selected_tract: SelectedTract | None = None
    selected_county: ShortStr | None = None
    visible_counties: list[ShortStr] = Field(default_factory=list, max_length=12)
    visible_county_count: int = Field(default=0, ge=0, le=254)


class ChatRequest(Strict):
    messages: list[Message] = Field(min_length=1, max_length=60)
    context: MapContext | None = None

    @model_validator(mode="after")
    def check_sequence(self) -> "ChatRequest":
        if self.messages[-1].role not in ("user", "tool"):
            raise ValueError("last message must be from the user or a tool result")
        if self.messages[0].role != "user":
            raise ValueError("conversation must start with a user message")
        pending: set[str] = set()
        for m in self.messages:
            if isinstance(m, AssistantMessage):
                pending = {c.id for c in m.tool_calls}
            elif isinstance(m, ToolMessage):
                if m.tool_call_id not in pending:
                    raise ValueError("tool result does not match a requested tool call")
                pending.discard(m.tool_call_id)
            else:
                pending = set()
        return self


def invalid_response(errors: list) -> JSONResponse:
    # Do not echo user input back; report only where validation failed.
    fields = [".".join(str(p) for p in e.get("loc", ())) or "body" for e in errors][:5]
    return JSONResponse(status_code=422, content={"error": {
        "code": "invalid_request", "message": "The request was not valid.", "fields": fields}})


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


PROVIDER_ERRORS: dict[str, tuple[int, str]] = {
    "not_configured": (503, "The AI service is not configured on the server."),
    "timeout": (504, "The AI service took too long to respond."),
    "rate_limited": (429, "The AI service is busy. Please wait a moment and try again."),
    "auth_failed": (502, "The server could not authenticate with the AI service."),
    "bad_response": (502, "The AI service returned an unreadable response."),
    "provider_error": (502, "The AI service is unavailable right now."),
}


class RateLimiter:
    def __init__(self, limit: int, window_s: float):
        self.limit, self.window_s = limit, window_s
        self.hits: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        q = self.hits.setdefault(key, deque())
        while q and now - q[0] > self.window_s:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        if len(self.hits) > 10_000:  # bound memory
            for k in [k for k, v in self.hits.items() if not v]:
                del self.hits[k]
        return True


def to_provider_messages(req: ChatRequest) -> list[dict]:
    system = SYSTEM_PROMPT
    if req.context is not None:
        system += "\n\nCurrent map state (JSON):\n" + json.dumps(req.context.model_dump())
    out: list[dict] = [{"role": "system", "content": system}]
    for m in req.messages:
        if isinstance(m, UserMessage):
            out.append({"role": "user", "content": [{"type": "text", "text": m.content}]})
        elif isinstance(m, AssistantMessage):
            msg: dict = {"role": "assistant", "content": m.content}
            if m.tool_calls:
                msg["tool_calls"] = [
                    {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}
                    for c in m.tool_calls
                ]
            out.append(msg)
        else:
            out.append({"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content})
    return out


def parse_provider_message(message: dict) -> dict:
    """Normalise the model's reply. Raises ValueError if unusable."""
    content = message.get("content") or ""
    if not isinstance(content, str):
        content = ""
    raw_calls = message.get("tool_calls") or []
    if not isinstance(raw_calls, list):
        raw_calls = []
    calls = []
    for raw in raw_calls[:MAX_TOOL_CALLS_PER_TURN]:
        fn = raw.get("function") if isinstance(raw, dict) else None
        if not isinstance(fn, dict):
            continue
        name = fn.get("name")
        if not isinstance(name, str):
            continue
        args_text = fn.get("arguments")
        if isinstance(args_text, dict):
            args_text = json.dumps(args_text)
        if not isinstance(args_text, str) or len(args_text) > 2000:
            args_text = ""
        try:
            args = json.loads(args_text) if args_text else {}
            if not isinstance(args, dict):
                args = None
        except ValueError:
            args = None
        call_id = raw.get("id") if isinstance(raw.get("id"), str) and raw.get("id") else f"call_{uuid.uuid4().hex[:12]}"
        calls.append({"id": call_id[:100], "name": name, "arguments": args, "allowed": name in TOOL_NAMES,
                      "arguments_text": args_text})

    allowed = [c for c in calls if c["allowed"]]
    if allowed:
        return {
            "type": "tool_calls",
            # Only allowlisted calls are echoed back so the next request validates.
            "assistant_message": {
                "role": "assistant",
                "content": content[:6000],
                "tool_calls": [{"id": c["id"], "name": c["name"], "arguments": c["arguments_text"] or "{}"} for c in allowed],
            },
            "tool_calls": [{"id": c["id"], "name": c["name"], "arguments": c["arguments"]} for c in allowed],
        }
    if content.strip():
        return {"type": "message", "content": content[:6000]}
    raise ValueError("empty or unsupported model response")


DEFAULT_SNAPSHOT = Path(__file__).resolve().parent / "resources" / "data" / "locationlist_snapshot.json"
DEFAULT_GEOJSON = Path(__file__).resolve().parent.parent / "frontend" / "public" / "data" / "texas_heatmap.geojson"


def _json_or_empty(text: str) -> dict:
    try:
        v = json.loads(text) if text else {}
    except ValueError:
        return {}
    return v if isinstance(v, dict) else {}


def _tool_results(messages: list, ids: list[str]) -> list[dict]:
    """The browser's results for the given tool-call ids, in call order ({} if one is missing)."""
    by_id: dict[str, dict] = {}
    for m in messages:
        if isinstance(m, ToolMessage) and m.tool_call_id in ids:
            try:
                v = json.loads(m.content)
            except ValueError:
                v = {"ok": False, "message": "The map returned an unreadable result."}
            by_id[m.tool_call_id] = v if isinstance(v, dict) else {"ok": False, "message": "The map returned an unreadable result."}
    return [by_id.get(i, {"ok": False, "message": "No result was returned for this action."}) for i in ids]


def _with_meta(result: dict, intent: str, geography: dict | None = None) -> dict:
    """Validate an LLM-produced response against the same contract as rules responses."""
    meta = {"intent": intent, "source": "watsonx", "fallback_used": False, "notice": None, "suggestions": [], "geography": geography}
    model = ToolCallsResponse if result["type"] == "tool_calls" else MessageResponse
    return standardize(validated(model, {**result, **meta}))
RESOURCE_ID_PATTERN = r"^[a-z0-9-]{3,120}$"


def create_app(client: WatsonxClient | None = None, resources: ResourceService | None = None) -> FastAPI:
    try:
        timeout_s = min(max(float(env("WATSONX_TIMEOUT_S", "30")), 5.0), 120.0)
    except ValueError:
        timeout_s = 30.0
    config = WatsonxConfig(
        api_key=env("WATSONX_API_KEY"),
        project_id=env("WATSONX_PROJECT_ID"),
        url=env("WATSONX_URL"),
        model_id=env("WATSONX_MODEL_ID", "mistralai/mistral-large") or "mistralai/mistral-large",
        timeout_s=timeout_s,
        iam_url=env("WATSONX_IAM_URL", "https://iam.cloud.ibm.com/identity/token"),
    )
    state: dict = {"client": client}

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if state["client"] is None:
            state["client"] = WatsonxClient(config)
        yield
        await state["client"].aclose()

    app = FastAPI(title="FoodFit Chat API", version="1.0.0", lifespan=lifespan)
    limiter = RateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_S)
    resource_limiter = RateLimiter(int(os.getenv("RESOURCE_RATE_LIMIT_PER_MIN", "60")), RATE_LIMIT_WINDOW_S)
    resource_service = resources or ResourceService(
        SnapshotProvider(Path(os.getenv("RESOURCE_SNAPSHOT_PATH", str(DEFAULT_SNAPSHOT))))
    )

    geo_path = Path(env("TRACT_GEOJSON_PATH") or DEFAULT_GEOJSON)
    if not geo_path.is_file() and env("FRONTEND_DIST"):
        geo_path = Path(env("FRONTEND_DIST")) / "data" / "texas_heatmap.geojson"
    geography = Geography.from_geojson(geo_path)
    try:
        cities = sorted({r.city for r in resource_service.provider.records() if r.city})
    except ResourceProviderError:
        cities = []
    rules = Rules(geography, cities)

    def resources_unavailable() -> JSONResponse:
        return error(503, "resources_unavailable", "Food resource data is unavailable right now.")
    origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type"])

    @app.exception_handler(RequestValidationError)
    async def on_validation(_req: Request, exc: RequestValidationError):
        return invalid_response(exc.errors())

    @app.get("/api/health")
    async def health():
        c: WatsonxClient = state["client"]
        missing = c.config.missing() if c else ["WATSONX_API_KEY", "WATSONX_PROJECT_ID", "WATSONX_URL", "WATSONX_MODEL_ID"]
        return {
            "ok": True,
            "ai_configured": not missing,
            "ai_missing": missing,  # variable names only, never values
            "assistant": "watsonx + built-in rules" if not missing else "built-in rules only",
            "env_file_found": ENV_FILE.is_file(),
            "geography_loaded": geography.loaded,
            "resource_cities": cities,
        }

    @app.get("/api/resources/meta")
    async def resources_meta(request: Request):
        if not resource_limiter.allow(request.client.host if request.client else "unknown"):
            return error(429, "too_many_requests", "Too many requests. Please wait a minute and try again.")
        try:
            return resource_service.meta()
        except ResourceProviderError:
            return resources_unavailable()

    @app.get("/api/resources/search")
    async def resources_search(
        request: Request,
        lat: float | None = Query(None, ge=-90, le=90, allow_inf_nan=False),
        lng: float | None = Query(None, ge=-180, le=180, allow_inf_nan=False),
        city: str | None = Query(None, pattern=r"^[A-Za-z][A-Za-z .'-]{1,39}$"),
        radius_miles: float = Query(5.0, gt=0, le=MAX_RADIUS_MI, allow_inf_nan=False),
        category: list[Literal[ALL_CATEGORIES]] | None = Query(None, max_length=4),  # type: ignore[valid-type]
        day: Literal[tuple(["today", *DAYS])] | None = None,  # type: ignore[valid-type]
        limit: int = Query(10, ge=1, le=25),
    ):
        if not resource_limiter.allow(request.client.host if request.client else "unknown"):
            return error(429, "too_many_requests", "Too many requests. Please wait a minute and try again.")
        if city is None and (lat is None or lng is None):
            return error(422, "invalid_request", "The request was not valid.")
        try:
            if city is not None and (lat is None or lng is None):
                return resource_service.search_city(city, category, day, limit)
            return resource_service.search(lat, lng, radius_miles, category, day, limit)
        except ResourceProviderError:
            return resources_unavailable()

    @app.get("/api/resources/locations")
    async def resources_locations(request: Request):
        # Registered before /{resource_id} so "locations" is not read as an id.
        if not resource_limiter.allow(request.client.host if request.client else "unknown"):
            return error(429, "too_many_requests", "Too many requests. Please wait a minute and try again.")
        try:
            return resource_service.locations()
        except ResourceProviderError:
            return resources_unavailable()

    @app.get("/api/resources/{resource_id}")
    async def resources_get(request: Request, resource_id: str):
        if not resource_limiter.allow(request.client.host if request.client else "unknown"):
            return error(429, "too_many_requests", "Too many requests. Please wait a minute and try again.")
        import re as _re
        if not _re.match(RESOURCE_ID_PATTERN, resource_id):
            return error(422, "invalid_request", "The request was not valid.")
        try:
            found = resource_service.get(resource_id)
        except ResourceProviderError:
            return resources_unavailable()
        if found is None:
            return error(404, "not_found", "That resource is not in FoodFit's data.")
        return found

    @app.post("/api/chat")
    async def chat(request: Request):
        ip = request.client.host if request.client else "unknown"
        if not limiter.allow(ip):
            return error(429, "too_many_requests", "Too many messages. Please wait a minute and try again.")
        raw = await request.body()
        if len(raw) > MAX_BODY_BYTES:
            return error(413, "too_large", "The conversation is too long. Start a new chat.")
        try:
            req = ChatRequest.model_validate_json(raw)
        except ValidationError as exc:
            return invalid_response(exc.errors())

        started = time.monotonic()
        c: WatsonxClient = state["client"]
        configured = c.config.configured
        history = [m.model_dump() for m in req.messages]
        context = req.context.model_dump() if req.context else None
        last = req.messages[-1]
        user_text = next((m.content for m in reversed(req.messages) if isinstance(m, UserMessage)), "")

        def done(result: dict, how: str) -> dict:
            log.info("chat ok route=%s type=%s intent=%s tools=%d latency_ms=%d", how, result["type"], result.get("intent"),
                     len(result.get("tool_calls", [])), (time.monotonic() - started) * 1000)
            return result

        # Round 2: the browser sent back results of tool calls the deterministic assistant planned.
        if isinstance(last, ToolMessage):
            prev = next(m for m in reversed(req.messages) if isinstance(m, AssistantMessage) and m.tool_calls)
            ids = [tc.id for tc in prev.tool_calls]
            tagged = rules_ids(ids)
            calls = [{"name": tc.name, "arguments": _json_or_empty(tc.arguments)} for tc in prev.tool_calls]
            results = _tool_results(req.messages, ids)
            if tagged:
                _, was_fallback, intent = tagged
                notice = (NOTICE_NOT_CONFIGURED if not configured else None) if was_fallback else None
                return done(compose_reply(intent, calls, results, notice, follow_ups(intent)), "rules")
            if not configured:
                return done(compose_reply("followup", calls, results, NOTICE_NOT_CONFIGURED, []), "rules")
            try:
                result = parse_provider_message(await c.chat(to_provider_messages(req), TOOLS))
                result = _with_meta(result, rules.plan(user_text, context, history).intent)
                return done(with_reported(result, calls, results), "watsonx")
            except (ProviderError, ValueError) as exc:
                code = getattr(exc, "code", "bad_response")
                log.warning("chat provider failed code=%s; composing from tool results", code)
                return done(compose_reply("followup", calls, results, NOTICE_PROVIDER.get(code, NOTICE_PROVIDER_DEFAULT), []), "rules")

        # Round 1: a new user message.
        plan = rules.plan(user_text, context, history)
        if plan.deterministic:
            # Map commands are always handled deterministically: an LLM must not invent a county or a map action.
            return done(rules_reply(plan, fallback=not configured, notice=None), "rules")
        if not configured:
            return done(rules_reply(plan, fallback=True, notice=NOTICE_NOT_CONFIGURED), "rules")
        try:
            result = parse_provider_message(await c.chat(to_provider_messages(req), TOOLS))
            return done(_with_meta(result, plan.intent, plan.geography), "watsonx")
        except (ProviderError, ValueError) as exc:
            code = getattr(exc, "code", "bad_response")
            log.warning("chat provider failed code=%s intent=%s latency_ms=%d", code, plan.intent, (time.monotonic() - started) * 1000)
            if plan.intent != "unsupported":
                return done(rules_reply(plan, fallback=True, notice=NOTICE_PROVIDER.get(code, NOTICE_PROVIDER_DEFAULT)), "rules")
            status, text = PROVIDER_ERRORS.get(code, PROVIDER_ERRORS["provider_error"])
            return error(status, code, text)

    mount_frontend(app, os.getenv("FRONTEND_DIST", ""))
    return app


def mount_frontend(app: FastAPI, dist: str) -> None:
    """Optionally serve the built React app (frontend/dist) from this same process.

    One deployable unit: /api/* is the API, any other path is a file from dist/
    or index.html (so client-side routes such as /heatmap work on reload).
    """
    if not dist:
        return
    root = Path(dist).resolve()
    index = root / "index.html"
    if not index.is_file():
        raise SystemExit(f"FRONTEND_DIST={dist!r} has no index.html. Run `npm run build` in frontend/ first.")
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    @app.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str):
        if path == "api" or path.startswith("api/"):
            return error(404, "not_found", "Unknown API endpoint.")
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
            return FileResponse(candidate, headers={"Cache-Control": cache})
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


app = create_app()

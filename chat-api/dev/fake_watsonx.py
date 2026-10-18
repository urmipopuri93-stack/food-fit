"""TEST-ONLY stand-in for watsonx.ai, used by the browser smoke test.

It is NOT an AI and must never be used to serve real users. It returns scripted
tool calls for a few phrases and, after a tool runs, echoes the real tool result
so the test can verify that what the user sees came from the application.

Run: uvicorn dev.fake_watsonx:app --port 8099
Then start chat-api with:
  WATSONX_URL=http://127.0.0.1:8099 WATSONX_IAM_URL=http://127.0.0.1:8099/identity/token \
  WATSONX_API_KEY=test WATSONX_PROJECT_ID=test uvicorn main:app --port 8001
"""
import json

from fastapi import FastAPI, Request

app = FastAPI()
RESOURCE_SCRIPT = [
    ("harris county pantries", "search_resources", {"near": {"kind": "county", "id": "Harris"}, "radius_miles": 10}),
    ("saturday", "search_resources", {"near": {"kind": "map_center"}, "radius_miles": 10, "day": "Saturday"}),
    ("selected tract", "search_resources", {"near": {"kind": "selected_tract"}, "radius_miles": 5}),
    ("food assistance near", "search_resources", {"near": {"kind": "map_center"}, "radius_miles": 15}),
    ("fake pantry", "get_resource_details", {"resource_id": "made-up-pantry--food"}),
]
FOLLOWUPS = [
    ("compare the first two", "compare_resources", 2),
    ("contact the first", "get_resource_details", 1),
    ("show the first", "show_resource_on_map", 1),
]

SCRIPT = [
    ("compare", "compare_locations", {"a": {"kind": "county", "id": "Dallas"}, "b": {"kind": "county", "id": "Tarrant"}}),
    ("fort worth", "zoom_to_county", {"county": "Fort Worth"}),
    ("dallas", "zoom_to_county", {"county": "Dallas"}),
    ("income layer", "set_layer", {"layer": "income"}),
    ("reset", "reset_map", {}),
    ("here", "get_map_context", {}),
    ("explain", "explain_heatmap", {}),
    ("zoom in", "zoom_in", {"steps": 1}),
    ("hack", "run_javascript", {"code": "alert(1)"}),
]


@app.post("/identity/token")
async def token():
    return {"access_token": "fake-token", "expires_in": 3600}


@app.post("/ml/v1/text/chat")
async def chat(request: Request):
    body = await request.json()
    assert request.headers.get("authorization") == "Bearer fake-token"
    last = body["messages"][-1]
    if last["role"] == "tool":
        result = json.loads(last["content"])
        keys = ["ok", "error", "county", "layer", "zoom", "selected_tract", "message", "total_in_radius",
                "out_of_coverage", "searched_from", "name", "cleared", "source"]
        echo = {k: result[k] for k in keys if k in result}
        if "results" in result:
            echo["first_results"] = [r["name"] for r in result["results"][:3]]
        if "resource" in result:
            echo["resource"] = {k: result["resource"][k] for k in ("name", "phone", "website", "not_listed")}
        if "a" in result and isinstance(result["a"], dict) and "name" in result["a"]:
            echo["compared"] = [result["a"]["name"], result["b"]["name"]]
        if "difference_a_minus_b" in result:
            echo["difference_a_minus_b"] = result["difference_a_minus_b"]
        return {"choices": [{"message": {"role": "assistant", "content": "TOOL RESULT: " + json.dumps(echo)}}]}
    text = last["content"][0]["text"].lower() if isinstance(last["content"], list) else last["content"].lower()
    if "clear the resource" in text:
        return _call("clear_resource_search", {})
    for phrase, name, args in RESOURCE_SCRIPT:
        if phrase in text:
            return _call(name, args)
    for phrase, name, n in FOLLOWUPS:
        if phrase in text:
            ids = _last_result_ids(body["messages"])
            if len(ids) < n:
                return {"choices": [{"message": {"role": "assistant", "content": "Which resource do you mean?"}}]}
            args = {"a": ids[0], "b": ids[1]} if n == 2 else {"resource_id": ids[0]}
            return _call(name, args)
    for phrase, name, args in SCRIPT:
        if phrase in text:
            return {"choices": [{"message": {"role": "assistant", "content": "", "tool_calls": [
                {"id": f"call_{name}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}}]}
    return {"choices": [{"message": {"role": "assistant", "content": "PLAIN REPLY"}}]}


def _call(name, args):
    return {"choices": [{"message": {"role": "assistant", "content": "", "tool_calls": [
        {"id": f"call_{name}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}}]}


def _last_result_ids(messages):
    """Ids from the most recent search_resources tool result in the conversation (what a model would see)."""
    for m in reversed(messages):
        if m["role"] == "tool":
            try:
                data = json.loads(m["content"])
            except ValueError:
                continue
            if isinstance(data.get("results"), list) and data["results"]:
                return [r["id"] for r in data["results"]]
    return []

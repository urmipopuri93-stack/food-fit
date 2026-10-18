"""Local smoke test for a running chat-api. Needs no watsonx credentials.

    python smoke_test.py                      # checks http://127.0.0.1:8001
    python smoke_test.py http://127.0.0.1:8001

Checks: health, resource data, the built-in assistant's map-command contract
(Dallas County), a county comparison request, and a resource lookup. The second
chat round sends a *simulated* browser tool result to verify that the server
composes its answer from that result; it does not touch a real map.
Exit code 0 = all checks passed.
"""

from __future__ import annotations

import json
import sys

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8001").rstrip("/")
failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail and not ok else ""))
    failures += 0 if ok else 1


def chat(client: httpx.Client, messages: list[dict]) -> dict:
    r = client.post(f"{BASE}/api/chat", json={"messages": messages})
    r.raise_for_status()
    return r.json()


def main() -> int:
    try:
        client = httpx.Client(timeout=40)
        health = client.get(f"{BASE}/api/health").json()
    except httpx.HTTPError as exc:
        print(f"FAIL  backend not reachable at {BASE} ({type(exc).__name__}). Is uvicorn running on that port?")
        return 1

    check("backend health", health.get("ok") is True)
    print(f"      assistant: {health.get('assistant')}; missing settings: {health.get('ai_missing') or 'none'}")
    check("tract geography loaded for county names", health.get("geography_loaded") is True,
          "frontend/public/data/texas_heatmap.geojson not found next to chat-api")

    meta = client.get(f"{BASE}/api/resources/meta").json()
    check("food-resource list loaded", meta.get("total", 0) > 0, str(meta)[:200])
    plano = client.get(f"{BASE}/api/resources/search", params={"city": "Plano"}).json()
    check("resource lookup: Plano listings", plano.get("total_in_radius", 0) > 0 and all(r["city"] == "Plano" for r in plano["results"]))

    text = "Show me Dallas County on the map"
    first = chat(client, [{"role": "user", "content": text}])
    call = (first.get("tool_calls") or [{}])[0]
    check("map command returns a validated zoom_to_county action",
          first.get("type") == "tool_calls" and call.get("name") == "zoom_to_county" and call.get("arguments") == {"county": "Dallas"},
          json.dumps(first)[:300])
    check("map commands are answered by the built-in rules (never invented by an LLM)", first.get("source") == "rules")
    check("structured map_action is 'requested' (the server never claims the map moved)",
          (first.get("map_action") or {}).get("status") == "requested" and first.get("message") is None, json.dumps(first)[:300])

    if call.get("id"):
        simulated = {"ok": True, "action": "zoom_to_county", "county": "Dallas County", "tract_count": 528, "zoom": 10}
        second = chat(client, [{"role": "user", "content": text}, first["assistant_message"],
                               {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(simulated)}])
        check("answer is composed from the tool result", second.get("type") == "message" and "Dallas County" in second.get("content", ""),
              json.dumps(second)[:300])
        check("map_action is 'applied' only because the browser reported ok",
              (second.get("map_action") or {}).get("status") == "applied" and second.get("error") is None)
        failed = {"ok": False, "action": "zoom_to_county", "error": "move_failed", "message": "The map did not move to the requested county."}
        third = chat(client, [{"role": "user", "content": text}, first["assistant_message"],
                              {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(failed)}])
        check("a failed map action is reported as failed, with recovery suggestions",
              (third.get("map_action") or {}).get("status") == "failed" and (third.get("error") or {}).get("code") == "move_failed"
              and "Reset the map" in third.get("suggestions", []), json.dumps(third)[:300])

    unknown = chat(client, [{"role": "user", "content": "Show me Springfield County"}])
    check("unknown county is explained, map untouched", unknown.get("type") == "message" and unknown.get("map_action") is None)
    locs = client.get(f"{BASE}/api/resources/locations").json()
    check("resource locations for the service-gap finder", len(locs.get("locations", [])) > 0 and locs.get("coverage") is not None)

    cmp_ = chat(client, [{"role": "user", "content": "Compare Dallas County and Collin County"}])
    cmp_call = (cmp_.get("tool_calls") or [{}])[0]
    check("county comparison is planned (with or without an LLM)",
          cmp_.get("type") in ("tool_calls", "message") and (cmp_.get("source") == "watsonx" or cmp_call.get("name") == "compare_locations"),
          json.dumps(cmp_)[:300])

    print("\nAll checks passed." if not failures else f"\n{failures} check(s) failed.")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())

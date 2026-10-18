"""Phase 4: FitBasket deterministic assistant (rules.py), response contract (assistant.py) and routing (main.py)."""

import json
import logging

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import main
from assistant import MessageResponse, ToolCallsResponse
from rules import Geography, Rules, compose
from watsonx import ProviderAuthError, ProviderTimeout, WatsonxConfig

GEO = Geography.from_geojson(main.DEFAULT_GEOJSON)
CITIES = ["Addison", "Dallas", "Garland", "Plano", "Richardson"]
RULES = Rules(GEO, CITIES)
SECRET = "sk-REAL-LOOKING-SECRET-123"
CTX = {"layer": "combined", "zoom": 9, "center": {"lat": 32.8, "lng": -96.8}, "selected_tract": None,
       "visible_counties": ["Dallas"], "visible_county_count": 1}


def plan(text, ctx=None, history=None):
    p = RULES.plan(text, ctx, history or [])
    return p, [(c["name"], c["arguments"]) for c in p.calls]


# ---------------------------------------------------------------- intent classification

@pytest.mark.parametrize("text,intent,call", [
    ("Show me Dallas County on the map.", "navigate_county", ("zoom_to_county", {"county": "Dallas"})),
    ("Zoom into Collin County.", "navigate_county", ("zoom_to_county", {"county": "Collin"})),
    ("Show Tarrant County.", "navigate_county", ("zoom_to_county", {"county": "Tarrant"})),
    ("Move the map to Denton County.", "navigate_county", ("zoom_to_county", {"county": "Denton"})),
    ("Show census tracts in Dallas County.", "navigate_county", ("zoom_to_county", {"county": "Dallas"})),
    ("dallas co", "navigate_county", ("zoom_to_county", {"county": "Dallas"})),
    ("take me to ft bend", "navigate_county", ("zoom_to_county", {"county": "Fort Bend"})),
    ("Zoom in on this area.", "zoom_in", ("zoom_in", {"steps": 1})),
    ("zoom out", "zoom_out", ("zoom_out", {"steps": 1})),
    ("Go back to the Texas overview.", "reset_view", ("reset_map", {})),
    ("Reset the map.", "reset_view", ("reset_map", {})),
    ("switch to the income layer", "set_layer", ("set_layer", {"layer": "income"})),
    ("Show tract 48113000100", "navigate_tract", ("select_tract", {"geoid": "48113000100"})),
    ("Summarize tract 48113000100", "summarize", ("summarize_location", {"location": {"kind": "tract", "id": "48113000100"}})),
    ("Compare Dallas County and Collin County.", "compare",
     ("compare_locations", {"a": {"kind": "county", "id": "Dallas"}, "b": {"kind": "county", "id": "Collin"}})),
    ("Compare the available indicators for Dallas County and Collin County.", "compare",
     ("compare_locations", {"a": {"kind": "county", "id": "Dallas"}, "b": {"kind": "county", "id": "Collin"}})),
    ("What does this heatmap show?", "explain_heatmap", ("explain_heatmap", {})),
    ("What does food access mean here?", "explain_food_access", ("explain_heatmap", {})),
    ("What is the difference between county and tract data?", "explain_levels", ("explain_heatmap", {})),
    ("What data sources does FoodFit use?", "explain_sources", ("explain_heatmap", {})),
    ("Summarize Dallas County.", "summarize", ("summarize_location", {"location": {"kind": "county", "id": "Dallas"}})),
    ("Which counties have missing data?", "data_coverage", ("data_coverage", {})),
    ("Find food pantries near Richardson.", "resource_search", ("search_resources", {"near": {"kind": "city", "id": "Richardson"}})),
    ("Where can I get food assistance in Plano?", "resource_search", ("search_resources", {"near": {"kind": "city", "id": "Plano"}})),
    ("Show available food resources in North Dallas.", "resource_search", ("search_resources", {"near": {"kind": "city", "id": "Dallas"}})),
    ("find food pantries in dallas county", "resource_search",
     ("search_resources", {"near": {"kind": "county", "id": "Dallas"}, "radius_miles": 15})),
    ("Find SNAP help in Plano open on Saturday", "resource_search",
     ("search_resources", {"categories": ["snap_application_help"], "day": "Saturday", "near": {"kind": "city", "id": "Plano"}})),
])
def test_supported_intents(text, intent, call):
    p, calls = plan(text, CTX)
    assert p.intent == intent
    assert calls == [call]


def test_area_summary_uses_map_context():
    p, calls = plan("What information is available for this area?", CTX)
    assert calls == [("summarize_location", {"location": {"kind": "county", "id": "Dallas"}})]
    sel = dict(CTX, selected_tract={"geoid": "48113000100", "county": "Dallas"})
    assert plan("Summarize this area", sel)[1] == [("summarize_location", {"location": {"kind": "tract", "id": "48113000100"}})]
    p, calls = plan("Summarize this area", dict(CTX, visible_counties=[], visible_county_count=5))
    assert calls == [] and "Which area" in p.message


def test_resources_near_me_uses_selected_tract_or_asks():
    sel = dict(CTX, selected_tract={"geoid": "48113000100", "county": "Dallas"})
    assert plan("What resources are available near me?", sel)[1] == [("search_resources", {"near": {"kind": "selected_tract"}})]
    p, calls = plan("What resources are available near me?", CTX)
    assert calls == [] and "doesn't use your device location" in p.message


@pytest.mark.parametrize("text,expect", [
    ("Show me Springfield", "couldn't find \"Springfield\" as a Texas county"),
    ("Show me Richardson", "Richardson is a city"),
    ("Show me Austin", "could mean a place or Austin County"),
    ("Find food pantries in Houston", "isn't in FoodFit's food-resource list"),
    ("Compare Dallas County with Fort Worth", "Which two counties"),
])
def test_unknown_or_ambiguous_places_get_an_explanation_and_no_map_action(text, expect):
    p, calls = plan(text, CTX)
    assert calls == [] and expect in p.message


def test_unknown_county_phrase_is_rejected_against_the_map_geography():
    # Phase 5: the server checks "<name> County" against the same GeoJSON the map draws.
    p, calls = plan("Show Gotham County", CTX)
    assert calls == [] and p.intent == "navigate_county"
    assert "couldn't find \"Gotham County\"" in p.message and "left the map where it is" in p.message
    assert p.geography == {"level": "county", "name": "Gotham", "validated": False}


def test_unknown_county_phrase_without_geography_is_left_to_the_browser():
    p = Rules(Geography(), CITIES).plan("Show Gotham County", CTX, [])
    assert [(c["name"], c["arguments"]) for c in p.calls] == [("zoom_to_county", {"county": "gotham"})]


def test_common_words_are_not_read_as_counties():
    for text in ["show me the real data", "young people need food help? tell me a joke", "the hill"]:
        _, calls = plan(text, CTX)
        assert not any(c[0] == "zoom_to_county" for c in calls), text
    assert plan("Show Young County", CTX)[1] == [("zoom_to_county", {"county": "Young"})]


@pytest.mark.parametrize("text,intent", [("hello", "help"), ("How do I use this?", "help"), ("Tell me a joke", "unsupported"), ("", "help")])
def test_help_and_unsupported_are_not_generic_errors(text, intent):
    p, calls = plan(text, CTX)
    assert p.intent == intent and calls == [] and "Dallas County" in p.message


def test_resource_follow_ups_use_ids_from_the_last_search():
    history = [{"role": "tool", "tool_call_id": "x", "content": json.dumps({"ok": True, "results": [{"id": "aa-1"}, {"id": "bb-2"}]})}]
    assert plan("how can I contact the first one?", CTX, history)[1] == [("get_resource_details", {"resource_id": "aa-1"})]
    assert plan("show the second one on the map", CTX, history)[1] == [("show_resource_on_map", {"resource_id": "bb-2"})]
    assert plan("compare the first two", CTX, history)[1] == [("compare_resources", {"a": "aa-1", "b": "bb-2"})]
    p, calls = plan("tell me about the third one", CTX, history)
    assert calls == [] and "only returned 2" in p.message


def test_missing_geography_data_still_works_safely():
    rules = Rules(Geography.from_geojson(None), CITIES)  # GeoJSON not found
    p = rules.plan("Show Dallas County", CTX, [])
    assert p.calls[0]["name"] == "zoom_to_county" and p.calls[0]["arguments"] == {"county": "dallas"}
    assert p.geography["validated"] is False  # the browser validates against the real map


# ---------------------------------------------------------------- composing answers from real tool results

def test_county_summary_distinguishes_missing_from_zero():
    r = {"ok": True, "kind": "county", "name": "Dallas County", "tract_count": 528, "population": 2553385,
         "scores": {"overall_need_score": 61.2, "income_score": 0.0, "transportation_score": None, "grocery_score": 55.5},
         "raw_indicators": {"poverty_rate": {"value": 18.4, "tracts_missing": 2}, "no_vehicle_pct": {"value": None, "tracts_missing": 528},
                            "low_access_pct": {"value": 40.0, "tracts_missing": 0}},
         "notes": ["County values are population-weighted averages."], "sources": ["ACS (2015)", "USDA Atlas (2019)"]}
    text = compose("summarize", [{"name": "summarize_location", "arguments": {}}], [r])
    assert "Dallas County" in text and "528 census tracts" in text and "2,553,385" in text
    assert "Income-barrier score: 0.0" in text  # zero is a value
    assert "Transportation-barrier score: missing" in text  # null is missing, never 0
    assert "Households without a vehicle (%): missing (missing in 528 tracts)" in text
    assert "Source: ACS (2015); USDA Atlas (2019)" in text


def test_comparison_table_only_uses_returned_values():
    r = {"ok": True, "kind": "county",
         "a": {"name": "Dallas County", "scores": {"overall_need_score": 60.0, "income_score": None}, "population": 10, "tract_count": 2},
         "b": {"name": "Collin County", "scores": {"overall_need_score": 30.0, "income_score": 12.0}, "population": 20, "tract_count": 3},
         "difference_a_minus_b": {"overall_need_score": 30.0, "income_score": None},
         "comparability_notes": ["Same definitions."], "sources": ["ACS (2015)"]}
    text = compose("compare", [{"name": "compare_locations", "arguments": {}}], [r])
    assert "| Indicator | Dallas County | Collin County | Difference |" in text
    assert "| Overall need score | 60.0 | 30.0 | 30.0 |" in text
    assert "| Income-barrier score | missing | 12.0 | missing |" in text


def test_failed_actions_are_reported_not_hidden():
    r = {"ok": False, "error": "ambiguous", "message": "\"San\" could mean more than one county.", "options": ["San Jacinto County", "San Saba County"]}
    text = compose("navigate_county", [{"name": "zoom_to_county", "arguments": {}}], [r])
    assert "could mean more than one county" in text and "San Saba County" in text
    assert "Here's" not in text


def test_resource_answers_use_only_listed_fields():
    r = {"ok": True, "searched_from": "Plano listings", "radius_miles": None, "total_in_radius": 1,
         "results": [{"id": "x", "name": "Test Pantry", "program": "Food Pantry", "category": "Food pantry / distribution",
                      "address": "1 Main St, Plano, TX 75074", "phone": None, "distance_miles_straight_line": None}],
         "listed_without_map_location": [], "hours_note": "Hours are as listed. Call before visiting.",
         "source": "LocationListInfo.pdf, capture date not recorded. Call before visiting."}
    text = compose("resource_search", [{"name": "search_resources", "arguments": {}}], [r])
    assert "Test Pantry" in text and "phone not listed" in text and "capture date not recorded" in text
    assert "open now" not in text.lower()
    none = compose("resource_search", [{"name": "search_resources", "arguments": {}}],
                   [{**r, "results": [], "total_in_radius": 0, "day": "Sunday"}])
    assert "No listed resources matched" in none and "Sunday" in none
    unknown = compose("resource_search", [{"name": "search_resources", "arguments": {}}],
                      [{"ok": True, "unknown_city": True, "searched_from": "Frisco listings", "known_cities": CITIES}])
    assert "no listings in Frisco" in unknown and "Plano" in unknown


def test_resource_detail_never_invents_eligibility():
    text = compose("resource_details", [{"name": "get_resource_details", "arguments": {}}],
                   [{"ok": True, "resource": {"name": "Test Pantry", "address": "1 Main St", "phone": None, "website": None,
                                              "listed_hours": None, "not_listed": ["phone", "hours"]}, "source": "list"}])
    assert "Phone: not listed" in text and "Listed hours: not listed" in text
    assert "Eligibility requirements are not listed" in text


# ---------------------------------------------------------------- API routing, two rounds, schema

def client(configured=False, exc=None, reply=None):
    class Fake:
        def __init__(self):
            self.config = WatsonxConfig(SECRET if configured else "", "proj" if configured else "", "https://x" if configured else "", "m")
            self.calls = 0

        async def chat(self, messages, tools):
            self.calls += 1
            if exc:
                raise exc
            return reply or {"role": "assistant", "content": "LLM answer"}

        async def aclose(self):
            pass

    fake = Fake()
    return TestClient(main.create_app(fake)), fake


def two_rounds(c, text, result, ctx=None):
    first = c.post("/api/chat", json={"messages": [{"role": "user", "content": text}], "context": ctx}).json()
    assert first["type"] == "tool_calls", first
    call = first["tool_calls"][0]
    second = c.post("/api/chat", json={"context": ctx, "messages": [
        {"role": "user", "content": text},
        first["assistant_message"],
        {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result)},
    ]})
    return first, second


def test_dallas_county_end_to_end_without_credentials():
    c, fake = client(configured=False)
    with c:
        first, second = two_rounds(c, "Show me Dallas County on the map", {"ok": True, "action": "zoom_to_county", "county": "Dallas County", "tract_count": 528, "zoom": 10})
    assert first["tool_calls"][0]["name"] == "zoom_to_county" and first["tool_calls"][0]["arguments"] == {"county": "Dallas"}
    assert first["intent"] == "navigate_county" and first["source"] == "rules" and first["fallback_used"] is True
    body = second.json()
    assert second.status_code == 200 and body["type"] == "message"
    assert "Dallas County" in body["content"] and "528" in body["content"]
    assert "isn't configured" in body["notice"] and body["suggestions"]
    assert fake.calls == 0


def test_failed_map_action_is_reported_honestly():
    c, _ = client()
    with c:
        _, second = two_rounds(c, "Show Gonzales County", {"ok": False, "error": "not_found", "message": "\"gonzales\" is not a Texas county in FoodFit data."})
    assert "not a Texas county" in second.json()["content"]


def test_provider_offline_falls_back_for_supported_requests():
    c, fake = client(configured=True, exc=ProviderTimeout())
    with c:
        first, second = two_rounds(c, "Compare Dallas County and Collin County", {
            "ok": True, "kind": "county", "a": {"name": "Dallas County", "scores": {}}, "b": {"name": "Collin County", "scores": {}},
            "difference_a_minus_b": {}, "comparability_notes": [], "sources": ["ACS (2015)"]})
    assert fake.calls == 1  # the LLM was tried first
    assert first["source"] == "rules" and "took too long" in first["notice"]
    assert "| Indicator | Dallas County | Collin County |" in second.json()["content"]


def test_every_response_matches_the_contract():
    c, _ = client()
    with c:
        for text in ["Show me Dallas County", "What does this heatmap show?", "hello", "Find food pantries in Plano", "Show me Springfield"]:
            body = c.post("/api/chat", json={"messages": [{"role": "user", "content": text}]}).json()
            model = ToolCallsResponse if body["type"] == "tool_calls" else MessageResponse
            model.model_validate(body)
            assert set(body) >= {"type", "intent", "source", "fallback_used", "suggestions", "geography", "notice"}


def test_contract_rejects_bad_payloads():
    with pytest.raises(ValidationError):
        MessageResponse.model_validate({"type": "message", "content": "", "intent": "x", "source": "rules", "fallback_used": True})
    with pytest.raises(ValidationError):
        ToolCallsResponse.model_validate({"type": "tool_calls", "intent": "x", "source": "rules", "fallback_used": True,
                                          "assistant_message": {"role": "assistant", "content": "", "tool_calls": [{"id": "a", "name": "eval", "arguments": "{}"}]},
                                          "tool_calls": [{"id": "a", "name": "eval", "arguments": {}}]})
    with pytest.raises(ValidationError):
        MessageResponse.model_validate({"type": "message", "content": "x", "intent": "x", "source": "gpt", "fallback_used": True})


def test_no_secrets_in_responses_or_logs(caplog):
    caplog.set_level(logging.DEBUG)
    c, _ = client(configured=True, exc=ProviderAuthError())
    with c:
        texts = [c.post("/api/chat", json={"messages": [{"role": "user", "content": t}]}).text
                 for t in ["What does this heatmap show?", "Tell me a joke"]]
        texts.append(c.get("/api/health").text)
    for t in texts + [caplog.text]:
        assert SECRET not in t
    assert "auth_failed" in caplog.text  # sanitized diagnostic code is logged

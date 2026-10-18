"""FitBasket deterministic assistant (no LLM required).

Two stateless steps over the existing /api/chat contract:

1. plan(user_text, context, history) -> either a direct message, or allowlisted
   tool calls (ids prefixed "rules_") for the browser to execute against the
   real loaded map and data.
2. compose(tool_calls, tool_results) -> the user-facing answer, written ONLY from
   the tool results the browser sent back (never from the LLM, never invented).

Geographic names are validated against the county / tract lists loaded from the
same GeoJSON the map draws; anything unknown is still checked by the browser and
reported honestly ("not a Texas county in FoodFit data").
"""

from __future__ import annotations

import difflib
import json
import logging
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

log = logging.getLogger("foodfit.rules")

RULES_PREFIX = "rules_"
LAYER_WORDS = {
    "income": "income", "poverty": "income",
    "transportation": "transportation", "transport": "transportation", "vehicle": "transportation", "car": "transportation",
    "grocery": "access", "grocery access": "access", "access": "access",
    "overall": "combined", "overall need": "combined", "combined": "combined", "need": "combined",
}
LAYER_LABELS = {"combined": "Overall need", "transportation": "Transportation", "access": "Grocery access", "income": "Income barriers"}
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
ORDINALS = {"first": 0, "1st": 0, "second": 1, "2nd": 1, "third": 2, "3rd": 2, "fourth": 3, "4th": 3, "fifth": 4, "5th": 4}
COUNTY_ALIASES = {"ft bend": "Fort Bend", "de witt": "DeWitt", "dewitt": "DeWitt"}
# A bare county name (no "County" after it) only counts right after one of these words,
# so that e.g. "young people" or "the hill" are not read as Young or Hill County.
TRIGGERS = {"show", "me", "zoom", "into", "to", "on", "move", "go", "take", "summarize", "summarise", "summary",
            "about", "compare", "and", "vs", "versus", "with", "for", "in", "of", "focus", "center", "centre", "pan",
            "view", "near", "between", "see", "display"}

# Texas county names that are also everyday words: only recognised as "<name> County".
COMMON_WORD_COUNTIES = {
    "young", "hill", "hall", "brown", "king", "bell", "clay", "wood", "jack", "lamb", "hood", "ward", "lee", "real",
    "rains", "mills", "live oak", "gray", "bee", "starr", "kent", "martin", "wise", "mason", "potter", "parker",
    "archer", "crane", "terry", "wilson", "jones", "trinity", "liberty", "victoria", "falls", "loving", "sterling",
    "carson", "motley", "frio", "upton", "lynn", "knox", "floyd", "rusk", "dawson", "coke", "coleman", "castro",
    "kerr", "hale", "camp", "cass", "duval", "polk", "lamar", "houston", "austin", "washington", "madison", "jefferson",
}

SUGGESTIONS_DEFAULT = [
    "Show me Dallas County on the map",
    "What does this heatmap show?",
    "Compare Dallas County and Collin County",
    "Find food pantries in Plano",
]

GENERAL_VISIT_TIPS = (
    "**General suggestions** (not specific to any listing): call ahead to confirm the listed hours; ask whether you need "
    "an appointment, ID or proof of address; ask what you should bring (for example bags); and check for holiday closures."
)


@dataclass
class Geography:
    counties: dict[str, str] = field(default_factory=dict)  # normalised -> canonical name
    tracts: set[str] = field(default_factory=set)
    loaded: bool = False

    @classmethod
    def from_geojson(cls, path: Path | None) -> "Geography":
        if not path or not path.is_file():
            log.warning("geography not loaded: tract GeoJSON not found (map commands are still validated in the browser)")
            return cls()
        return _load_geography(str(path.resolve()), path.stat().st_mtime_ns)

    @classmethod
    def _parse(cls, path: Path) -> "Geography":
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            counties: dict[str, str] = {}
            tracts: set[str] = set()
            for f in data.get("features", []):
                p = (f or {}).get("properties") or {}
                c, g = p.get("County"), p.get("GEOID")
                if isinstance(c, str) and c.strip():
                    counties[norm(c)] = c.strip()
                if isinstance(g, str) and re.fullmatch(r"48\d{9}", g):
                    tracts.add(g)
            log.info("geography loaded counties=%d tracts=%d", len(counties), len(tracts))
            return cls(counties, tracts, True)
        except (OSError, ValueError) as exc:
            log.warning("geography not loaded: %s", type(exc).__name__)
            return cls()


@lru_cache(maxsize=4)
def _load_geography(path: str, _mtime_ns: int) -> Geography:
    """Parse once per file version (the 8 MB GeoJSON is shared by every app instance)."""
    return Geography._parse(Path(path))


def norm(s: str) -> str:
    s = s.lower().replace("’", "'")
    s = re.sub(r"[^a-z0-9' -]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------- understanding

@dataclass
class Plan:
    intent: str
    message: str | None = None
    calls: list[dict] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)
    geography: dict | None = None
    deterministic: bool = False  # answer with rules even when an LLM is configured


class Rules:
    def __init__(self, geo: Geography, resource_cities: list[str] | None = None):
        self.geo = geo
        self.cities = {c.lower(): c for c in (resource_cities or [])}
        names = sorted(set(geo.counties) | set(COUNTY_ALIASES), key=len, reverse=True)
        self._county_re = re.compile(r"\b(" + "|".join(re.escape(n) for n in names) + r")\b(\s+(county|co)\b)?") if names else None

    # -- entity extraction
    def find_counties(self, t: str) -> list[str]:
        """Known county names in text order, deduplicated."""
        out: list[str] = []
        if not self._county_re:
            return out
        for m in self._county_re.finditer(t):
            name = COUNTY_ALIASES.get(m.group(1)) or self.geo.counties.get(m.group(1))
            if not name:
                continue
            before = t[: m.start()].split()[-3:]
            bare_ok = m.group(1) not in COMMON_WORD_COUNTIES and (t.strip() == m.group(1) or any(w in TRIGGERS for w in before))
            if m.group(2) or bare_ok:
                if "north dallas" in t and m.group(1) == "dallas" and not m.group(2):
                    continue
                if name not in out:
                    out.append(name)
        return out

    @staticmethod
    def unknown_county_phrase(t: str) -> str | None:
        """'zoom into gotham county' -> 'gotham' (validated later by the browser)."""
        m = re.search(r"(?:^|\b(?:show|zoom|into|to|on|move|go|take|me|at|the|of|in))\s+([a-z][a-z' -]{1,30}?)\s+(?:county|co)\b", t)
        if not m:
            return None
        words = [w for w in m.group(1).split() if w not in TRIGGERS and w not in {"the", "a", "map"}]
        return " ".join(words) or None

    @staticmethod
    def nav_target(t: str) -> str | None:
        m = re.search(r"\b(?:show me|show|zoom (?:in )?(?:to|into|on)|move (?:the map )?to|go to|take me to|focus on|center on|centre on|pan to)\s+(.+)$", t)
        if not m:
            return None
        target = re.sub(r"\b(on|in) the map\b|\bthe map\b|\bplease\b|\bnow\b", " ", m.group(1))
        target = re.sub(r"^(the|a)\s+", "", re.sub(r"\s+", " ", target).strip())
        return target or None

    def city_in(self, t: str) -> str | None:
        if "north dallas" in t and "dallas" in self.cities:
            return "north dallas"
        for c in sorted(self.cities, key=len, reverse=True):
            if re.search(rf"\b{re.escape(c)}\b", t):
                return c
        return None

    # -- planning
    def plan(self, text: str, context: dict | None, history: list[dict]) -> Plan:
        t = norm(text)
        ctx = context or {}
        geoids = re.findall(r"\b48\d{9}\b", t)

        if not t or len(t) < 2:
            return self._help("help")

        # 1. Follow-ups about resources from the last search in this conversation.
        last_ids = last_resource_ids(history)
        ords = [ORDINALS[w] for w in t.split() if w in ORDINALS]
        if "first two" in t or "top two" in t:
            ords = [0, 1]
        if last_ids and ords and re.search(r"\b(show|map|where|contact|call|phone|hours|details?|address|website|more|tell|compare|open|check|visit)\b", t):
            if "compare" in t and len(ords) >= 2:
                if max(ords) >= len(last_ids):
                    return Plan("resource_followup", f"The last search only returned {len(last_ids)} result(s).", deterministic=True)
                return self._calls("resource_compare", ("compare_resources", {"a": last_ids[ords[0]], "b": last_ids[ords[1]]}))
            i = ords[0]
            if i >= len(last_ids):
                return Plan("resource_followup", f"The last search only returned {len(last_ids)} result(s).", deterministic=True)
            if re.search(r"\b(show|map|where)\b", t) and not re.search(r"\b(contact|call|phone|hours|details?|website)\b", t):
                return self._calls("resource_show", ("show_resource_on_map", {"resource_id": last_ids[i]}))
            return self._calls("resource_details", ("get_resource_details", {"resource_id": last_ids[i]}))

        # 2. "What should I check before visiting?"
        if re.search(r"\b(before (i )?(visit|go)|what should i (bring|check|know))\b", t):
            return Plan("visit_tips", GENERAL_VISIT_TIPS + " For a specific place, search for resources and ask about the first, second… result.",
                        suggestions=["Find food pantries in Plano", "Find food assistance near Richardson"])

        # 2c. Service gaps: high-need tracts far from any listed food resource (joins the need model with the resource list).
        if re.search(r"\b(service gaps?|coverage gaps?|gaps? in (food )?(service|coverage|access|help)|underserved|under-served|"
                     r"far(thest| away)? from (any |a |the |listed )?(food )?(pantr|resource|help|assistance|listing)|"
                     r"(no|few|without) (food )?(pantr\w*|resources?|listings?) (nearby|close)|"
                     r"(where|which area\w*) (should|could|would) (a |the )?new (food )?(pantry|distribution|site)|new pantry go)", t):
            counties_here = self.find_counties(t)
            args: dict[str, Any] = {"county": counties_here[0]} if counties_here else {}
            geo = {"level": "county", "name": counties_here[0], "validated": True} if counties_here else None
            return self._calls("service_gaps", ("find_service_gaps", args), geography=geo)

        # 2b. Geography level: the map is tract-level only; say so instead of pretending to switch.
        if not geoids and re.search(r"\b(switch|change|go|show|use|display|view|see)\b", t):
            if re.search(r"\b(census )?tracts?( level| view)?\b", t) and not self.find_counties(t):
                n = f"{len(self.geo.tracts):,} " if self.geo.loaded and self.geo.tracts else ""
                return Plan("geography_level", f"The map already shows census tracts — each of its {n}shaded shapes is one Texas census tract, coloured by the active layer. Click any tract for its scores, or ask me to move to a county to see its tracts up close.",
                            suggestions=["Show me Dallas County", "What do the layers mean?", "Reset the map"], deterministic=True)
            if re.search(r"\b(count(y|ies)[ -]level|county view|by county|counties)\b", t) and not self.find_counties(t):
                return Plan("geography_level", "FoodFit has no separate county-shaded layer — the map shades census tracts. To look at a county, ask me to move to it (I'll zoom there and outline its tracts), or ask for a county summary, which combines its tracts weighted by population.",
                            suggestions=["Show me Dallas County", "Summarize Collin County", "Compare Dallas County and Collin County"], deterministic=True)

        # 3. Explanations (before resource/compare so "food access mean" etc. land here).
        if re.search(r"\b(missing|incomplete|no data|lack)\b", t) and re.search(r"\b(data|counties|county|values?|indicators?)\b", t):
            return self._calls("data_coverage", ("data_coverage", {}))
        if re.search(r"\bcounty\b.*\btract\b|\btract\b.*\bcounty\b", t) and re.search(r"\b(difference|differ|vs|versus|mean|compare)\b", t) and not geoids:
            return self._calls("explain_levels", ("explain_heatmap", {}))
        if re.search(r"\b(data sources?|where does (the|this) data|sources? (of|for) (the )?data|what data)\b", t):
            return self._calls("explain_sources", ("explain_heatmap", {}))
        if re.search(r"\bfood access\b.*\b(mean|means|definition)\b|\bwhat is food access\b", t):
            return self._calls("explain_food_access", ("explain_heatmap", {}))
        if re.search(r"\b(heat ?map|map|legend|colou?rs?|layers?|darker|scores?)\b", t) and re.search(r"\b(what|explain|mean|means|understand|how)\b", t) \
                and not self.find_counties(t) and not re.search(r"\b(show me|zoom|move|go to|reset)\b", t):
            return self._calls("explain_heatmap", ("explain_heatmap", {}))

        # 4. Food-assistance resources.
        if re.search(r"\b(clear|remove|hide|reset)\b.*\b(resources?|search|markers?|pins?|results?)\b", t) and not re.search(r"\breset (the )?map\b", t):
            return self._calls("resource_clear", ("clear_resource_search", {}), deterministic=True)
        if re.search(r"\b(pantr(y|ies)|food banks?|food assistance|food resources?|free food|get food|food help|snap|csfp|senior food|food distribution|resources?)\b", t):
            return self._resource_plan(t, ctx)

        # 5. Comparisons.
        if re.search(r"\b(compare|comparison|vs|versus|difference between)\b", t):
            if len(geoids) >= 2:
                return self._calls("compare", ("compare_locations", {"a": {"kind": "tract", "id": geoids[0]}, "b": {"kind": "tract", "id": geoids[1]}}))
            cs = self.find_counties(t)
            if len(cs) >= 2:
                return self._calls("compare", ("compare_locations", {"a": {"kind": "county", "id": cs[0]}, "b": {"kind": "county", "id": cs[1]}}),
                                   geography={"level": "county", "names": cs[:2], "validated": True})
            return Plan("compare", "Which two counties (or two census tracts) should I compare? For example: \"Compare Dallas County and Collin County\".",
                        suggestions=["Compare Dallas County and Collin County", "Compare Tarrant County and Denton County"], deterministic=True)

        # 6. Map controls.
        if re.search(r"\b(reset|start over|texas overview|whole (state|map|texas)|full (map|view|texas)|all of texas|back to (the )?(texas|overview|start)|zoom out (all the way|fully))\b", t):
            return self._calls("reset_view", ("reset_map", {}), deterministic=True, geography={"level": "state", "name": "Texas", "validated": True})
        if "layer" in t or re.search(r"\b(switch|change) to\b", t):
            for word in sorted(LAYER_WORDS, key=len, reverse=True):
                if re.search(rf"\b{word}\b", t):
                    return self._calls("set_layer", ("set_layer", {"layer": LAYER_WORDS[word]}), deterministic=True)
        if re.search(r"\bzoom (in|closer)\b", t) and not self.find_counties(t) and not geoids:
            return self._calls("zoom_in", ("zoom_in", {"steps": 1}), deterministic=True)
        if re.search(r"\bzoom (out|back)\b", t) and not self.find_counties(t):
            return self._calls("zoom_out", ("zoom_out", {"steps": 1}), deterministic=True)

        # 7. Tracts.
        if geoids:
            g = geoids[0]
            geo = {"level": "tract", "id": g, "validated": (g in self.geo.tracts) if self.geo.loaded else None}
            if re.search(r"\b(summar|tell me|about|data|info|stats|details?|scores?)\w*", t):
                return self._calls("summarize", ("summarize_location", {"location": {"kind": "tract", "id": g}}), geography=geo)
            return self._calls("navigate_tract", ("select_tract", {"geoid": g}), deterministic=True, geography=geo)

        counties = self.find_counties(t)

        # 8. Summaries.
        if re.search(r"\b(summar\w*|tell me about|information|info|data for|stats|statistics|indicators?|details)\b", t):
            if counties:
                return self._calls("summarize", ("summarize_location", {"location": {"kind": "county", "id": counties[0]}}),
                                   geography={"level": "county", "name": counties[0], "validated": True})
            if re.search(r"\b(this|here|selected|current)\b", t):
                return self._context_summary(ctx)
            return Plan("summarize", "Which county or census tract should I summarize? Name a county (e.g. \"Summarize Dallas County\") or click a tract on the map and ask \"Summarize this area\".",
                        suggestions=["Summarize Dallas County", "Summarize Collin County"], deterministic=True)

        # 9. Navigation.
        nav_verb = re.search(r"\b(show|zoom|move|go to|take me|focus|center|centre|pan|navigate|display|view)\b", t)
        if counties and (nav_verb or len(t.split()) <= 3):
            return self._calls("navigate_county", ("zoom_to_county", {"county": counties[0]}), deterministic=True,
                               geography={"level": "county", "name": counties[0], "validated": True})
        if nav_verb:
            if "north dallas" in t:
                return Plan("navigate_county", "FoodFit's map has no neighbourhood boundaries, so I can't outline North Dallas. Try \"Show Dallas County\", or ask \"Find food pantries in North Dallas\".",
                            suggestions=["Show me Dallas County on the map", "Find food pantries in North Dallas"], deterministic=True)
            phrase = self.unknown_county_phrase(t)
            target = phrase or self.nav_target(t)
            if target and target in self.cities and not phrase:
                return Plan("navigate_county", f"{self.cities[target]} is a city, and FoodFit's map is organised by Texas county and census tract — it has no city boundaries. Tell me which county you'd like, or ask \"Find food pantries in {self.cities[target]}\".",
                            suggestions=[f"Find food pantries in {self.cities[target]}", "Show me Collin County"], deterministic=True)
            if target and not phrase and target in COMMON_WORD_COUNTIES and target in self.geo.counties:
                county = self.geo.counties[target]
                return Plan("navigate_county", f"\"{target.title()}\" could mean a place or {county} County. FoodFit's map only has county and census-tract boundaries, so say \"Show {county} County\" if you mean the county.",
                            suggestions=[f"Show {county} County"], deterministic=True)
            if phrase and self.geo.loaded and norm(phrase) not in self.geo.counties:
                # Checked against the same GeoJSON the map draws: never send an unknown county to the browser.
                close = difflib.get_close_matches(norm(phrase), list(self.geo.counties), n=3, cutoff=0.75)
                names = [self.geo.counties[c] for c in close]
                hint = (" Did you mean " + " or ".join(f"{n} County" for n in names) + "?") if names else " Try \"Show Dallas County\"."
                return Plan("navigate_county", f"I couldn't find \"{phrase.title()} County\" among the {len(set(self.geo.counties.values()))} Texas counties in FoodFit's map data, so I left the map where it is.{hint}",
                            suggestions=[f"Show me {n} County" for n in names] or ["Show me Dallas County on the map", "Show me Collin County"],
                            deterministic=True, geography={"level": "county", "name": phrase.title(), "validated": False})
            if phrase:
                # "<name> County" with no geography loaded: the browser validates it against the loaded map.
                return self._calls("navigate_county", ("zoom_to_county", {"county": phrase}), deterministic=True,
                                   geography={"level": "county", "name": phrase, "validated": False})
            if target and not re.search(r"\b(this|here|it|that|them|first|second|third|one|area|results?|data|info|information|stats|everything|map|layers?|legend)\b", target) \
                    and re.fullmatch(r"[a-z][a-z' .-]{1,40}", target):
                return Plan("navigate_county", f"I couldn't find \"{target.title()}\" as a Texas county in FoodFit's data. FoodFit's map is organised by county and census tract (no city or neighbourhood boundaries). Try \"Show Dallas County\".",
                            suggestions=["Show me Dallas County on the map", "Show me Collin County"], deterministic=True,
                            geography=None)

        if re.search(r"^(hi|hello|hey|help|what can you do|who are you)\b|\b(how (do|can) i use|how does (this|it|fitbasket) work|what can i ask|what can you do)\b", t):
            return self._help("help")
        return self._help("unsupported")

    def _resource_plan(self, t: str, ctx: dict) -> Plan:
        args: dict[str, Any] = {}
        cats = []
        if re.search(r"\bsnap\b", t):
            cats.append("snap_application_help")
        if re.search(r"\b(senior|csfp|elderly)\b", t):
            cats.append("senior_food_box")
        if re.search(r"\b(pantr(y|ies)|food banks?|food distribution|free food|get food)\b", t) and cats:
            cats.append("food_distribution")
        if cats:
            args["categories"] = sorted(set(cats))
        day = next((d for d in WEEKDAYS if re.search(rf"\b{d}\b", t)), None)
        if re.search(r"\b(today|open now|right now|tonight)\b", t):
            args["day"] = "today"
        elif day:
            args["day"] = day.capitalize()
        m = re.search(r"\bwithin\s+(\d+(?:\.\d+)?)\s*(mi|miles?)\b", t)
        if m:
            args["radius_miles"] = max(0.5, min(25.0, float(m.group(1))))

        city = self.city_in(t)
        counties = self.find_counties(t)
        explicit_county = bool(counties) and re.search(rf"\b{re.escape(counties[0].lower())}\s+(county|co)\b", t)
        if explicit_county:
            args["near"] = {"kind": "county", "id": counties[0]}
            args.setdefault("radius_miles", 15)
            geo = {"level": "county", "name": counties[0], "validated": True}
        elif city:
            args["near"] = {"kind": "city", "id": "Dallas" if city == "north dallas" else self.cities[city]}
            geo = {"level": "city", "name": "North Dallas" if city == "north dallas" else self.cities[city], "validated": True}
        elif counties:
            args["near"] = {"kind": "county", "id": counties[0]}
            args.setdefault("radius_miles", 15)
            geo = {"level": "county", "name": counties[0], "validated": True}
        elif re.search(r"\b(near me|my location|close to me|around me)\b", t):
            if ctx.get("selected_tract"):
                args["near"] = {"kind": "selected_tract"}
                geo = {"level": "tract", "id": ctx["selected_tract"].get("geoid"), "validated": True}
            else:
                return Plan("resource_search", "FoodFit doesn't use your device location. Click your area on the map (to select a tract) and ask again, or name a city such as Plano, Richardson or North Dallas.",
                            suggestions=self._city_suggestions(), deterministic=True)
        elif re.search(r"\b(selected|this tract)\b", t):
            if not ctx.get("selected_tract"):
                return Plan("resource_search", "No tract is selected. Click a tract on the map first, or name a city.", suggestions=self._city_suggestions(), deterministic=True)
            args["near"] = {"kind": "selected_tract"}
            geo = {"level": "tract", "id": ctx["selected_tract"].get("geoid"), "validated": True}
        elif re.search(r"\b(here|this area|the map|map view|current view|nearby|around here)\b", t):
            args["near"] = {"kind": "selected_tract"} if ctx.get("selected_tract") else {"kind": "map_center"}
            geo = {"level": "map_view", "validated": True}
        else:
            other = self.unknown_place(t)
            if other:
                return Plan("resource_search", f"\"{other.title()}\" isn't in FoodFit's food-resource list, which only covers {self._city_list()}. I won't guess listings elsewhere — 2-1-1 Texas can help outside this area.",
                            suggestions=self._city_suggestions(), deterministic=True)
            return Plan("resource_search", f"Where should I look? FoodFit's resource list covers {self._city_list()}.",
                        suggestions=self._city_suggestions(), deterministic=True)
        return self._calls("resource_search", ("search_resources", args), geography=geo)

    @staticmethod
    def unknown_place(t: str) -> str | None:
        m = re.search(r"\b(?:in|near|around)\s+([a-z][a-z ]{2,30})$", t)
        if not m:
            return None
        place = re.sub(r"\b(me|the|area|texas|tx)\b", " ", m.group(1)).strip()
        return place or None

    def _city_list(self) -> str:
        names = sorted(self.cities.values())
        if not names:
            return "the Richardson, Plano and North Dallas area"
        pretty = [("Dallas (North Dallas)" if n == "Dallas" else n) for n in names]
        return ", ".join(pretty[:-1]) + " and " + pretty[-1] if len(pretty) > 1 else pretty[0]

    def _city_suggestions(self) -> list[str]:
        return ["Find food pantries in Plano", "Find food assistance near Richardson", "Show food resources in North Dallas"]

    def _context_summary(self, ctx: dict) -> Plan:
        sel = ctx.get("selected_tract")
        if sel and sel.get("geoid"):
            return self._calls("summarize", ("summarize_location", {"location": {"kind": "tract", "id": sel["geoid"]}}),
                               geography={"level": "tract", "id": sel["geoid"], "validated": True})
        county = ctx.get("selected_county")
        if county and isinstance(county, str) and (not self.geo.loaded or norm(county) in self.geo.counties):
            # The county FitBasket last moved the map to (confirmed by the browser).
            county = self.geo.counties.get(norm(county), county)
            return self._calls("summarize", ("summarize_location", {"location": {"kind": "county", "id": county}}),
                               geography={"level": "county", "name": county, "validated": True})
        vis = ctx.get("visible_counties") or []
        if len(vis) == 1:
            return self._calls("summarize", ("summarize_location", {"location": {"kind": "county", "id": vis[0]}}),
                               geography={"level": "county", "name": vis[0], "validated": True})
        return Plan("summarize", "Which area do you mean? Click a census tract on the map, zoom to one county, or name a county (e.g. \"Summarize Dallas County\").",
                    suggestions=["Summarize Dallas County", "Show me Collin County"], deterministic=True)

    def _calls(self, intent: str, *calls: tuple[str, dict], deterministic: bool = False, geography: dict | None = None) -> Plan:
        return Plan(intent, calls=[{"id": f"{RULES_PREFIX}{intent}_{i}", "name": n, "arguments": a} for i, (n, a) in enumerate(calls)],
                    deterministic=deterministic, geography=geography, suggestions=follow_ups(intent))

    def _help(self, intent: str) -> Plan:
        lead = "I can help with FoodFit's map and data." if intent == "help" else "I can't help with that one, but I can help with FoodFit's map and data."
        return Plan(intent, lead + " Try: moving the map to a county (\"Show me Dallas County\"), explaining the map, summarizing or comparing counties, spotting high-need areas far from listed food resources (\"Where are the service gaps?\"), or finding food-assistance resources in "
                    + self._city_list() + ".", suggestions=SUGGESTIONS_DEFAULT)


def follow_ups(intent: str) -> list[str]:
    return {
        "navigate_county": ["Summarize this area", "Find food pantries near the current map view", "Go back to the Texas overview"],
        "navigate_tract": ["Summarize this area", "Go back to the Texas overview"],
        "reset_view": ["Show me Dallas County on the map", "What does this heatmap show?"],
        "summarize": ["Compare Dallas County and Collin County", "Which counties have missing data?"],
        "resource_search": ["Tell me more about the first one", "Show the first one on the map", "What should I check before visiting?"],
        "resource_details": ["Show the first one on the map", "Compare the first two", "What should I check before visiting?"],
        "resource_show": ["Tell me more about the first one", "Clear the resource search"],
        "resource_compare": ["Show the first one on the map", "What should I check before visiting?"],
        "resource_clear": ["Find food pantries in Plano", "Go back to the Texas overview"],
        "compare": ["What is the difference between county and tract data?", "Show me Collin County"],
        "explain_heatmap": ["What is the difference between county and tract data?", "Which counties have missing data?"],
        "data_coverage": ["What data sources does FoodFit use?", "Summarize Dallas County"],
        "service_gaps": ["Find food pantries in Richardson", "What does the overall need score mean?", "Service gaps in Collin County"],
    }.get(intent, [])


def last_resource_ids(history: list[dict]) -> list[str]:
    """Resource ids from the most recent search_resources result the browser returned."""
    for m in reversed(history):
        if m.get("role") != "tool":
            continue
        try:
            data = json.loads(m.get("content") or "")
        except ValueError:
            continue
        results = data.get("results") if isinstance(data, dict) else None
        if isinstance(results, list) and results and all(isinstance(r, dict) and isinstance(r.get("id"), str) for r in results):
            return [r["id"] for r in results]
    return []


# ---------------------------------------------------------------- composing

def _num(v: Any, digits: int = 1) -> str | None:
    return f"{v:,.{digits}f}" if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _score(v: Any) -> str:
    s = _num(v)
    return s if s is not None else "missing"


SCORE_ROWS = [("overall_need_score", "Overall need score"), ("income_score", "Income-barrier score"),
              ("transportation_score", "Transportation-barrier score"), ("grocery_score", "Grocery-access-barrier score")]
RAW_ROWS = [("poverty_rate", "Poverty rate (%)"), ("no_vehicle_pct", "Households without a vehicle (%)"), ("low_access_pct", "Residents with low grocery access (%)")]


def _sources(r: dict) -> str:
    src = r.get("sources") or r.get("source")
    if isinstance(src, list):
        return "Source: " + "; ".join(str(s) for s in src) + ". Historical estimates, not current conditions."
    if isinstance(src, str):
        return "Source: " + src
    return ""


def compose(intent: str, calls: list[dict], results: list[dict]) -> str:
    parts = [compose_one(intent, c.get("name", ""), c.get("arguments") or {}, r) for c, r in zip(calls, results)]
    return "\n\n".join(p for p in parts if p).strip() or "That request couldn't be completed."


def compose_one(intent: str, name: str, args: dict, r: dict) -> str:
    if not isinstance(r, dict):
        return "The map didn't return a usable result."
    if not r.get("ok"):
        msg = str(r.get("message") or "That request couldn't be completed.")
        opts = r.get("options")
        if isinstance(opts, list) and opts:
            msg += " Did you mean: " + ", ".join(str(o) for o in opts[:8]) + "?"
        return msg

    if name == "zoom_to_county":
        n = r.get("tract_count")
        return f"Here's **{r.get('county')}** on the map" + (f" — its {n:,} census tracts are shaded by the active layer." if isinstance(n, int) else ".") + " Click a tract for its scores."
    if name == "select_tract":
        return f"Selected census tract **{r.get('geoid')}** in {r.get('county')} County. Its scores are in the popup."
    if name == "reset_map":
        return "Back to the full Texas overview."
    if name in ("zoom_in", "zoom_out"):
        return f"Zoomed {'in' if name == 'zoom_in' else 'out'} (zoom {r.get('from_zoom')} → {r.get('zoom')})."
    if name == "set_layer":
        return f"Switched the map to the **{r.get('label')}** layer."
    if name == "explain_heatmap":
        return _explain(intent, r)
    if name == "data_coverage":
        return _coverage(r)
    if name == "find_service_gaps":
        return _gaps(r)
    if name == "summarize_location":
        return _summary(r)
    if name == "compare_locations":
        return _comparison(r)
    if name == "list_top_tracts":
        rows = r.get("tracts") or []
        lines = [f"{t.get('rank')}. {t.get('name')} — score {_score(t.get('score'))}" for t in rows]
        return f"Highest-scoring tracts in {r.get('within')}:\n" + "\n".join(lines) if lines else "No tracts with scores were found."
    if name == "search_resources":
        return _resources(r)
    if name == "get_resource_details":
        return _resource_detail(r.get("resource") or {}, r.get("source"))
    if name == "compare_resources":
        return _resource_compare(r)
    if name == "show_resource_on_map":
        return f"Showing **{r.get('name')}** on the map ({r.get('address')}). Its marker popup has the listed details."
    if name == "clear_resource_search":
        return "Cleared the resource search."
    if name == "get_map_context":
        sel = r.get("selected_tract")
        return f"The map shows the {LAYER_LABELS.get(r.get('layer'), r.get('layer'))} layer at zoom {r.get('zoom')}" + (f"; tract {sel.get('geoid')} is selected." if isinstance(sel, dict) else ".")
    return ""


def _explain(intent: str, r: dict) -> str:
    layers = r.get("layers") or []
    active = next((l for l in layers if l.get("id") == r.get("active_layer")), None)
    src = "; ".join(f"{s.get('name')} ({s.get('year')})" for s in (r.get("sources") or []) if isinstance(s, dict))
    if intent == "explain_levels":
        return ("**Census tract vs county.** FoodFit's data is recorded per census tract (" + ", ".join(r.get("geographic_levels") or []) +
                " are the only levels). Each tract has its own four scores. County figures in FoodFit are population-weighted averages of that county's tracts — "
                "not separate county measurements. There are no city or neighbourhood boundaries. Not available: " + "; ".join(r.get("not_available") or []) + ".")
    if intent == "explain_sources":
        return f"FoodFit's map data comes from: {src}. {r.get('score_method')} {r.get('warning')}"
    if intent == "explain_food_access":
        g = next((l for l in layers if l.get("id") == "access"), {})
        return (f"**Food access** on this map means the **{g.get('label', 'Grocery access')}** layer: {g.get('description', '')} "
                f"Its score is defined as: {g.get('score_definition', '')} {r.get('score_method')} Data: {src}.")
    lines = [f"- **{l.get('label')}**: {l.get('description')}" for l in layers]
    return ("**What this map shows.** " + str(r.get("visualisation", "")) +
            (f" The active layer is **{active.get('label')}**." if active else "") + "\n\n" + "\n".join(lines) +
            f"\n\n{r.get('colour_bins')} {r.get('score_method')}\n\nSource: {src}. {r.get('warning')}")


def _coverage(r: dict) -> str:
    total = r.get("total_tracts")
    miss_scores = {k: v for k, v in (r.get("tracts_missing_scores") or {}).items() if v}
    raw = r.get("raw_missing") or {}
    labels = dict(RAW_ROWS)
    raw_lines = [f"- {labels.get(k, k)}: missing in {v:,} tracts" for k, v in raw.items() if v]
    out = [f"FoodFit has {total:,} census tracts in {r.get('counties')} counties." if isinstance(total, int) else ""]
    out.append("Every tract has all four scores." if not miss_scores else
               "Tracts missing scores: " + ", ".join(f"{k} ({v:,})" for k, v in miss_scores.items()) + ".")
    if raw_lines:
        out.append("Source values that are **missing** (not zero) — for these tracts the matching score is a model estimate only:\n" + "\n".join(raw_lines))
    top = r.get("counties_with_unobserved_grocery") or []
    if top:
        out.append("Counties with the largest share of tracts lacking an observed grocery-access value:\n" +
                   "\n".join(f"- {c.get('county')} County: {c.get('missing')} of {c.get('total')} tracts" for c in top))
    full = r.get("counties_fully_observed")
    if isinstance(full, int):
        out.append(f"{full} counties have observed grocery-access values for every tract.")
    out.append("Why: the USDA Food Access Research Atlas (2019) has no low-access value for those tracts in the source file.")
    return "\n\n".join(o for o in out if o)


def _summary(r: dict) -> str:
    if r.get("kind") == "tract":
        head = f"**{r.get('name')}** (tract {r.get('geoid')}) — population {(_num(r.get('population'), 0) or 'missing')}."
        scores = [(lbl, r.get("scores", {}).get(k)) for k, lbl in SCORE_ROWS]
        raw = [(lbl, r.get("raw_indicators", {}).get(k)) for k, lbl in RAW_ROWS]
        raw_fmt = [f"- {lbl}: {_score(v)}" for lbl, v in raw]
    else:
        head = f"**{r.get('name')}** — {r.get('tract_count')} census tracts, population {(_num(r.get('population'), 0) or 'missing')}."
        scores = [(lbl, r.get("scores", {}).get(k)) for k, lbl in SCORE_ROWS]
        raw_fmt = []
        for k, lbl in RAW_ROWS:
            v = (r.get("raw_indicators") or {}).get(k) or {}
            m = v.get("tracts_missing")
            raw_fmt.append(f"- {lbl}: {_score(v.get('value'))}" + (f" (missing in {m} tracts)" if m else ""))
        top = r.get("highest_overall_need_tract")
        if isinstance(top, dict):
            raw_fmt.append(f"- Highest overall-need tract: {top.get('name')} ({_score(top.get('score'))})")
    score_fmt = [f"- {lbl}: {_score(v)}" for lbl, v in scores]
    notes = r.get("notes") or []
    return "\n".join([head, "", "Scores (Texas-relative percentile ranks, 0–100; higher = higher estimated barrier):", *score_fmt,
                      "", "Source indicators:", *raw_fmt] + (["", *[f"Note: {n}" for n in notes]] if notes else []) + ["", _sources(r)])


def _comparison(r: dict) -> str:
    a, b, d = r.get("a") or {}, r.get("b") or {}, r.get("difference_a_minus_b") or {}
    rows = ["| Indicator | " + str(a.get("name") or a.get("geoid")) + " | " + str(b.get("name") or b.get("geoid")) + " | Difference |", "|---|---|---|---|"]
    for k, lbl in SCORE_ROWS:
        rows.append(f"| {lbl} | {_score((a.get('scores') or {}).get(k))} | {_score((b.get('scores') or {}).get(k))} | {_score(d.get(k))} |")
    rows.append(f"| Population | {_num(a.get('population'), 0) or 'missing'} | {_num(b.get('population'), 0) or 'missing'} | — |")
    if r.get("kind") == "county":
        rows.append(f"| Census tracts | {a.get('tract_count')} | {b.get('tract_count')} | — |")
        for k, lbl in RAW_ROWS:
            va, vb = ((a.get("raw_indicators") or {}).get(k) or {}), ((b.get("raw_indicators") or {}).get(k) or {})
            rows.append(f"| {lbl} | {_score(va.get('value'))} | {_score(vb.get('value'))} | — |")
    notes = r.get("comparability_notes") or []
    return "\n".join(rows) + "\n\nScores are 0–100 Texas-relative percentile ranks; a difference is in percentile points.\n" + \
        "\n".join(f"- {n}" for n in notes) + "\n\n" + _sources(r)


def _resource_line(i: int, x: dict) -> str:
    bits = [f"{i}. **{x.get('name')}**" + (f" — {x.get('program')}" if x.get("program") and x.get("program") != x.get("name") else "")]
    bits.append(f"({x.get('category')})")
    bits.append(x.get("address") or "address not listed")
    bits.append(f"phone {x['phone']}" if x.get("phone") else "phone not listed")
    if isinstance(x.get("distance_miles_straight_line"), (int, float)):
        bits.append(f"{x['distance_miles_straight_line']} mi straight-line")
    ds = x.get("day_status")
    if isinstance(ds, dict) and ds.get("detail"):
        bits.append(ds["detail"])
    return " · ".join(bits)


def _resources(r: dict) -> str:
    if r.get("unknown_city"):
        known = ", ".join(r.get("known_cities") or [])
        return f"FoodFit's resource list has no listings in {r.get('searched_from')}. It covers: {known}. I won't guess listings elsewhere — 2-1-1 Texas can help outside this area."
    results = r.get("results") or []
    where = r.get("searched_from")
    if r.get("out_of_coverage"):
        return f"That search ({where}) is outside the area FoodFit's resource list covers (around Richardson, Plano and North Dallas), so there are no listings there. {r.get('source', '')}"
    if not results:
        msg = f"No listed resources matched near {where}" + (f" within {r.get('radius_miles')} mi" if r.get("radius_miles") else "") + "."
        if r.get("day"):
            msg += f" (Filter: listed hours on {r.get('day')}.)"
        return msg + " Try a larger radius, another day, or other categories.\n\n" + str(r.get("source", ""))
    total = r.get("total_in_radius", len(results))
    head = f"Found {total} listed resource{'s' if total != 1 else ''} " + (f"within {r.get('radius_miles')} mi (straight-line) of {where}" if r.get("radius_miles") else f"for {where}")
    if r.get("day"):
        head += f" with listed hours on {r.get('day')}"
    lines = [_resource_line(i + 1, x) for i, x in enumerate(results[:6])]
    out = [head + ":", *lines]
    if total > 6:
        out.append(f"…and {total - 6} more in the resource panel.")
    unl = r.get("listed_without_map_location") or []
    if unl:
        out.append(f"{len(unl)} more listing(s) have no verified map location: " + ", ".join(sorted({u.get('name') for u in unl if u.get('name')})) + ".")
    out.append(str(r.get("hours_note") or "Hours are as listed, not live. Call before visiting."))
    out.append(str(r.get("source") or ""))
    return "\n".join(o for o in out if o)


def _resource_detail(x: dict, source: Any) -> str:
    lines = [f"**{x.get('name')}**" + (f" — {x.get('program')}" if x.get("program") else ""),
             f"- Category: {x.get('category')}",
             f"- Address: {x.get('address') or 'not listed'}",
             f"- Phone: {x.get('phone') or 'not listed'}" + (f" ({x.get('phone_label')})" if x.get("phone_label") else ""),
             f"- Website: {x.get('website') or 'not listed'}",
             f"- Listed hours: {x.get('listed_hours') or 'not listed'}"]
    if x.get("appointment"):
        lines.append(f"- Appointment: {x['appointment']}")
    if x.get("listed_closures"):
        lines.append("- Listed closures: " + ", ".join(x["listed_closures"]))
    for n in (x.get("hours_notes") or []) + (x.get("notes") or []):
        lines.append(f"- Note: {n}")
    if x.get("not_listed"):
        lines.append("- Not listed in the source: " + ", ".join(x["not_listed"]))
    lines.append("")
    lines.append("Eligibility requirements are not listed in FoodFit's data. Call before visiting to confirm hours and requirements.")
    if source:
        lines.append(f"Source: {source}")
    return "\n".join(lines)


def _resource_compare(r: dict) -> str:
    a, b = r.get("a") or {}, r.get("b") or {}
    def cell(x: dict, k: str) -> str:
        v = x.get(k)
        return str(v) if v not in (None, "", []) else "not listed"
    rows = [f"| | {a.get('name')} | {b.get('name')} |", "|---|---|---|"]
    for k, lbl in [("program", "Program"), ("category", "Category"), ("address", "Address"), ("phone", "Phone"), ("website", "Website"),
                   ("listed_hours", "Listed hours"), ("appointment", "Appointment"), ("distance_miles_straight_line", "Distance (mi, straight-line)")]:
        rows.append(f"| {lbl} | {cell(a, k)} | {cell(b, k)} |")
    return "\n".join(rows) + f"\n\n{r.get('note', '')} Call before visiting.\n\nSource: {r.get('source', '')}"


def _gaps(r: dict) -> str:
    """Service-gap table, written only from the browser's computed result."""
    gaps = [g for g in (r.get("gaps") or []) if isinstance(g, dict)]
    area = str(r.get("area") or "the area covered by FoodFit's resource list")
    n = r.get("tracts_analyzed")
    lead = (f"Across {area} ({n:,} census tracts with data), these high-need tracts are the farthest from any mapped listing "
            f"in FoodFit's resource list:" if isinstance(n, int) else f"High-need tracts farthest from a listed resource in {area}:")
    if not gaps:
        return f"In {area}, no high-need tracts could be ranked."
    rows = ["| Tract | County | Overall need | Nearest listed resource | Straight-line distance |", "|---|---|---|---|---|"]
    for g in gaps:
        near = g.get("nearest_resource") or {}
        city = f" ({near.get('city')})" if near.get("city") else ""
        rows.append(f"| {g.get('geoid')} | {g.get('county')} | {_score(g.get('overall_need_score'))} | {near.get('name', 'unknown')}{city} | "
                    f"{_score(g.get('distance_miles_straight_line'))} mi |")
    parts = [lead, "\n".join(rows)]
    thr, cnt, med = r.get("high_need_threshold"), r.get("high_need_count"), r.get("median_distance_high_need")
    if thr is not None and cnt is not None:
        parts.append(f"**How:** high-need means an overall need score of {_score(thr)} or more (the top quarter of tracts analyzed; {cnt} tracts). "
                     + (f"For those tracts the median straight-line distance to the nearest listing is {_score(med)} mi. " if med is not None else "")
                     + "Ranked by distance from each tract's centre.")
    caveats = [str(c) for c in (r.get("caveats") or [])][:5]
    if caveats:
        parts.append("**Keep in mind:** " + " ".join(caveats))
    if r.get("source"):
        parts.append(f"Sources: {r['source']}")
    return "\n\n".join(parts)

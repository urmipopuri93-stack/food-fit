import { CITY_PATTERN, RESOURCE_ID_PATTERN, type LocationsResponse, type ResourceDetail, type SearchParams, type SearchResponse } from "./types";

const BASE = `${import.meta.env.VITE_CHAT_API_BASE ?? ""}/api/resources`;
export const RESOURCE_TIMEOUT_MS = 15_000;

export class ResourceError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const MESSAGES: Record<string, [string, boolean]> = {
  network: ["Can't reach the FoodFit resource service. Check your connection, or make sure the server is running.", true],
  timeout: ["The resource search took too long. Please try again.", true],
  too_many_requests: ["Too many searches in a short time. Please wait a minute and try again.", true],
  resources_unavailable: ["Food resource data is unavailable right now.", true],
  invalid_request: ["That search couldn't be run. Check the location and filters.", false],
  not_found: ["That resource is not in FoodFit's data.", false],
  bad_response: ["The resource service returned unreadable data.", true],
  service_missing: ["The FoodFit resource service isn't reachable at this address. If you deployed the site, make sure chat-api is running and /api is routed to it.", false],
};

function err(code: string): ResourceError {
  const [msg, retry] = MESSAGES[code] ?? ["Something went wrong loading resources.", true];
  return new ResourceError(code, msg, retry);
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), RESOURCE_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  signal?.addEventListener("abort", onAbort);
  let res: Response;
  try {
    res = await fetch(url, { signal: timeout.signal, headers: { Accept: "application/json" } });
  } catch {
    if (signal?.aborted) throw new ResourceError("aborted", "Cancelled.", false);
    throw err(timeout.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (!res.ok) {
    if (typeof code === "string") throw err(code);
    // Not a response from chat-api (e.g. a static host's 404 page): the API isn't deployed or routed here.
    if ([404, 405, 501].includes(res.status)) throw err("service_missing");
    if (res.status === 504) throw err("timeout");
    if (res.status >= 500) throw err("network"); // e.g. a proxy in front of a stopped chat-api
    throw err(res.status === 429 ? "too_many_requests" : body === null ? "service_missing" : "invalid_request");
  }
  if (body === null) throw err("service_missing");
  return body;
}

function isSearchResponse(v: unknown): v is SearchResponse {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return Array.isArray(r.results) && Array.isArray(r.unlocated) && typeof r.out_of_coverage === "boolean" &&
    !!r.source && typeof r.total_in_radius === "number" &&
    (r.results as unknown[]).every((x) => !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string");
}

export async function searchResources(p: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
  const q = new URLSearchParams({ limit: String(p.limit) });
  if (p.origin) {
    q.set("lat", p.origin.lat.toFixed(6));
    q.set("lng", p.origin.lng.toFixed(6));
    q.set("radius_miles", String(p.radiusMiles));
  } else if (p.city && CITY_PATTERN.test(p.city)) {
    q.set("city", p.city);
  } else {
    throw err("invalid_request");
  }
  for (const c of p.categories) q.append("category", c);
  if (p.day) q.set("day", p.day);
  const body = await getJson(`${BASE}/search?${q}`, signal);
  if (!isSearchResponse(body)) throw err("bad_response");
  return body;
}

export async function getResource(id: string, signal?: AbortSignal): Promise<ResourceDetail> {
  if (!RESOURCE_ID_PATTERN.test(id)) throw err("invalid_request");
  const body = await getJson(`${BASE}/${encodeURIComponent(id)}`, signal);
  if (!body || typeof body !== "object" || (body as { id?: unknown }).id !== id) throw err("bad_response");
  return body as ResourceDetail;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isLocationsResponse(v: unknown): v is LocationsResponse {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const cov = r.coverage as Record<string, unknown> | null;
  return Array.isArray(r.locations) && typeof r.unlocated_count === "number" && !!r.source &&
    (cov === null || (!!cov && finite(cov.lat) && finite(cov.lng) && finite(cov.reach_miles))) &&
    (r.locations as unknown[]).every((x) => {
      const l = x as Record<string, unknown> | null;
      return !!l && typeof l.id === "string" && typeof l.name === "string" && finite(l.lat) && finite(l.lng);
    });
}

export async function getLocations(signal?: AbortSignal): Promise<LocationsResponse> {
  const body = await getJson(`${BASE}/locations`, signal);
  if (!isLocationsResponse(body)) throw err("bad_response");
  return body;
}

import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { MapPin, Phone, Globe, RotateCcw, Search, X, AlertTriangle } from "lucide-react";
import type { ResourceLayer } from "./ResourceLayer";
import type { ResourceStore } from "./resourceStore";
import { resolveOrigin, type OriginDeps } from "./origin";
import {
  CATEGORY_LABELS,
  FOOD_CATEGORIES,
  RESOURCE_CATEGORIES,
  WEEKDAYS,
  searchLabel,
  sourceLine,
  type DayFilter,
  type ResourceCategory,
  type ResourceRecord,
} from "./types";
import "./resources.css";

type Props = { store: ResourceStore; getLayer: () => ResourceLayer | null; originDeps: OriginDeps };

const RADII = [1, 2, 5, 10, 15, 25];

const STATUS_TEXT: Record<string, string> = {
  listed: "Listed",
  some_weeks_only: "Some weeks only",
  not_listed: "Not listed",
  listed_closed: "Listed closed",
  unknown: "Hours unknown",
};

export default function ResourcePanel({ store, getLayer, originDeps }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [near, setNear] = useState<"map_center" | "selected_tract">("map_center");
  const [radius, setRadius] = useState(5);
  const [day, setDay] = useState<DayFilter | "">("");
  const [cats, setCats] = useState<ResourceCategory[]>([...FOOD_CATEGORIES]);
  const [formError, setFormError] = useState<string | null>(null);
  const titleId = useId();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (cats.length === 0) {
      setFormError("Choose at least one category.");
      return;
    }
    const origin = resolveOrigin(near, undefined, originDeps);
    if (!origin.ok) {
      setFormError(origin.message);
      return;
    }
    setFormError(null);
    store.search({ origin: origin.origin, radiusMiles: radius, categories: cats, day: day || null, limit: 25 }).catch(() => {
      /* error state is rendered from the store */
    });
  }

  const r = state.response;
  const label = searchLabel(state.params);

  return (
    <section className="ffr-panel" aria-labelledby={titleId}>
      <div className="ffr-head">
        <h2 id={titleId}>Food assistance resources</h2>
        <p>
          From FoodFit's resource list for the Richardson, Plano and North Dallas area. Hours and details are as listed, not live —
          always call before visiting.
        </p>
      </div>

      <form className="ffr-form" onSubmit={submit}>
        <label>
          Search near
          <select value={near} onChange={(e) => setNear(e.target.value as typeof near)}>
            <option value="map_center">Current map view (centre)</option>
            <option value="selected_tract">Selected tract (click one on the map)</option>
          </select>
        </label>
        <label>
          Within
          <select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
            {RADII.map((m) => (
              <option key={m} value={m}>{m} mi (straight-line)</option>
            ))}
          </select>
        </label>
        <label>
          Listed hours on
          <select value={day} onChange={(e) => setDay(e.target.value as DayFilter | "")}>
            <option value="">Any day</option>
            <option value="today">Today</option>
            {WEEKDAYS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Categories</legend>
          {RESOURCE_CATEGORIES.map((c) => (
            <label key={c} className="ffr-check">
              <input
                type="checkbox"
                checked={cats.includes(c)}
                onChange={(e) => setCats((prev) => (e.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))}
              />
              {CATEGORY_LABELS[c]}
            </label>
          ))}
        </fieldset>
        <div className="ffr-actions">
          <button type="submit" className="ffr-primary" disabled={state.status === "loading"}>
            <Search size={15} aria-hidden="true" /> Search
          </button>
          <button type="button" onClick={() => store.clear()} disabled={state.status === "idle"}>
            <X size={15} aria-hidden="true" /> Clear search &amp; restore map
          </button>
        </div>
        {formError && <p className="ffr-form-error" role="alert">{formError}</p>}
      </form>

      <div className="ffr-status" role="status" aria-live="polite">
        {state.status === "idle" && "No search yet. Choose where to search and press Search."}
        {state.status === "loading" && "Searching FoodFit's resource list…"}
        {state.status === "ready" && r &&
          `${r.total_in_radius} resource${r.total_in_radius === 1 ? "" : "s"} ` +
            (r.query.radius_miles !== null ? `within ${r.query.radius_miles} mi (straight-line) of ${label}` : `among ${label}`) +
            (r.query.day ? ` with listed hours on ${r.query.day}${r.query.date ? ` (${r.query.date})` : ""}` : "") + "."}
      </div>

      {state.status === "error" && state.error && (
        <div className="ffr-error" role="alert">
          <p><AlertTriangle size={15} aria-hidden="true" /> {state.error.message}</p>
          {state.error.retryable && (
            <button type="button" onClick={() => store.retry().catch(() => {})}>
              <RotateCcw size={14} aria-hidden="true" /> Retry
            </button>
          )}
        </div>
      )}

      {state.status === "ready" && r && (
        <>
          <p className={`ffr-source${r.source.freshness.stale !== false ? " ffr-warn" : ""}`}>
            <strong>Source:</strong> {sourceLine(r.source)} {r.distance_note}
          </p>
          {r.out_of_coverage && (
            <p className="ffr-empty">This search is outside the area FoodFit's resource list covers (about 15 miles around Richardson, TX), so there are no listings here. This does not mean no help exists — try 2-1-1 Texas or your local food bank.</p>
          )}
          {r.unknown_city && (
            <p className="ffr-empty">FoodFit's resource list has no listings in {r.query.city}. It covers: {(r.known_cities ?? []).join(", ")}.</p>
          )}
          {!r.out_of_coverage && !r.unknown_city && r.results.length === 0 && (
            <p className="ffr-empty">
              No listed resources match{r.query.radius_miles !== null ? ` within ${r.query.radius_miles} mi` : ""}. Try a larger radius, another day, or more categories.
            </p>
          )}
          {r.results.length > 0 && (
            <ul className="ffr-list" aria-label="Search results">
              {r.results.map((rec) => (
                <ResourceCard key={rec.id} rec={rec} selected={state.selectedId === rec.id} onShow={() => getLayer()?.focus(rec.id)} />
              ))}
            </ul>
          )}
          {r.hours_unknown_in_radius.length > 0 && (
            <details className="ffr-more">
              <summary>{r.hours_unknown_in_radius.length} nearby with no parseable hours (can't tell if they serve on {r.query.day})</summary>
              <ul className="ffr-list">
                {r.hours_unknown_in_radius.map((rec) => (
                  <ResourceCard key={rec.id} rec={rec} selected={state.selectedId === rec.id} onShow={() => getLayer()?.focus(rec.id)} />
                ))}
              </ul>
            </details>
          )}
          {r.unlocated.length > 0 && (
            <details className="ffr-more">
              <summary>{r.unlocated.length} listed without a verified map location (distance unknown)</summary>
              <ul className="ffr-list">
                {r.unlocated.map((rec) => (
                  <ResourceCard key={rec.id} rec={rec} selected={false} onShow={null} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function ResourceCard({ rec, selected, onShow }: { rec: ResourceRecord; selected: boolean; onShow: (() => void) | null }) {
  const headingId = useId();
  return (
    <li>
      <article className={`ffr-card${selected ? " ffr-card-selected" : ""}`} aria-labelledby={headingId} aria-current={selected || undefined}>
        <div className="ffr-card-top">
          <span className={`ffr-tag ffr-tag-${rec.category}`}>{rec.category_label}</span>
          <span className="ffr-dist">
            {rec.distance_miles_straight_line !== null
              ? `${rec.distance_miles_straight_line} mi straight-line`
              : rec.location
                ? `${rec.city ?? "City"} listing` /* city search: no search point, so no distance */
                : "Distance unknown"}
          </span>
        </div>
        <h3 id={headingId}>{rec.name}</h3>
        {rec.program && rec.program !== rec.name && <p className="ffr-program">{rec.program}</p>}
        <p><MapPin size={13} aria-hidden="true" /> {rec.address}</p>
        <p>
          <Phone size={13} aria-hidden="true" />{" "}
          {rec.phone ? <a href={`tel:${rec.phone.replace(/-/g, "")}`}>{rec.phone}</a> : "Phone not listed"}
          {rec.phone_label && <span className="ffr-muted"> ({rec.phone_label})</span>}
        </p>
        <p>
          <Globe size={13} aria-hidden="true" />{" "}
          {rec.website ? <a href={rec.website} target="_blank" rel="noopener noreferrer">{rec.website.replace(/^https?:\/\//, "")}</a> : "Website not listed"}
        </p>
        {rec.day_status && (
          <p className={`ffr-day ffr-day-${rec.day_status.status}`}>
            <strong>{STATUS_TEXT[rec.day_status.status]}:</strong> {rec.day_status.detail}
          </p>
        )}
        {rec.appointment && (
          <p className="ffr-appt">{rec.appointment === "required" ? "Appointment required (as listed)" : "Appointments prioritized; walk-ins welcome (as listed)"}</p>
        )}
        <details>
          <summary>Listed hours &amp; details</summary>
          <p><strong>Listed hours:</strong> {rec.hours_text ?? "Not listed"}</p>
          {rec.hours_notes.map((n, i) => <p key={i} className="ffr-muted">{n}</p>)}
          {rec.closures.length > 0 && <p><strong>Listed closures:</strong> {rec.closures.join(", ")}</p>}
          {rec.email && <p><strong>Email:</strong> {rec.email}</p>}
          {rec.notes.map((n, i) => <p key={`n${i}`} className="ffr-muted">{n}</p>)}
          {rec.location?.note && <p className="ffr-muted">Map location: {rec.location.note}.</p>}
          {rec.missing_fields.length > 0 && <p className="ffr-muted">Not listed in the source: {rec.missing_fields.join(", ")}.</p>}
        </details>
        {onShow ? (
          <button type="button" className="ffr-show" onClick={onShow}>Show on map</button>
        ) : (
          <p className="ffr-muted">No verified map location (address could not be geocoded).</p>
        )}
      </article>
    </li>
  );
}

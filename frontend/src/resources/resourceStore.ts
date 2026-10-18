// One shared source of truth for the current resource search, used by the
// panel, the map markers and the chatbot so they never disagree.

import { searchResources as defaultSearch, ResourceError } from "./resourceClient";
import type { ResourceRecord, SearchParams, SearchResponse } from "./types";

export type ResourceState = {
  status: "idle" | "loading" | "ready" | "error";
  params: SearchParams | null;
  response: SearchResponse | null;
  error: ResourceError | null;
  selectedId: string | null;
  /** Records shown on request (e.g. by the chatbot) that are not part of the current results. */
  pinned: ResourceRecord[];
  /** Bumped on every completed search or clear; the map uses it to refit once. */
  version: number;
};

type Listener = () => void;

export function createResourceStore(search: typeof defaultSearch = defaultSearch) {
  let state: ResourceState = { status: "idle", params: null, response: null, error: null, selectedId: null, pinned: [], version: 0 };
  const listeners = new Set<Listener>();
  let controller: AbortController | null = null;
  let seq = 0;

  const set = (patch: Partial<ResourceState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  async function run(params: SearchParams): Promise<SearchResponse> {
    controller?.abort(); // a newer search always wins
    const ctrl = new AbortController();
    controller = ctrl;
    const mine = ++seq;
    set({ status: "loading", params, error: null, selectedId: null, pinned: [] });
    try {
      const response = await search(params, ctrl.signal);
      if (mine !== seq) throw new ResourceError("aborted", "Superseded by a newer search.", false);
      set({ status: "ready", response, version: state.version + 1 });
      return response;
    } catch (e) {
      const error = e instanceof ResourceError ? e : new ResourceError("unknown", "Something went wrong loading resources.", true);
      if (mine === seq && error.code !== "aborted") set({ status: "error", error, response: null, version: state.version + 1 });
      throw error;
    }
  }

  return {
    getState: () => state,
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    search: run,
    retry: () => (state.params ? run(state.params) : Promise.reject(new ResourceError("invalid_request", "Nothing to retry.", false))),
    select(id: string | null) {
      set({ selectedId: id });
    },
    clear() {
      controller?.abort();
      seq++;
      set({ status: "idle", params: null, response: null, error: null, selectedId: null, pinned: [], version: state.version + 1 });
    },
    pin(record: ResourceRecord) {
      if (this.find(record.id)) return;
      set({ pinned: [...state.pinned, record], version: state.version + 1 });
    },
    find(id: string): ResourceRecord | undefined {
      const r = state.response;
      const all = [...(r ? [...r.results, ...r.hours_unknown_in_radius, ...r.unlocated] : []), ...state.pinned];
      return all.find((x) => x.id === id);
    },
  };
}

export type ResourceStore = ReturnType<typeof createResourceStore>;

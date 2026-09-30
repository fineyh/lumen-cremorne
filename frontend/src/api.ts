export type Scenario = { key: string; label: string; note: string; tmax: number };
export type Stop = { id: string; name: string; kind: "train" | "tram"; lon: number; lat: number };
export type Office = { id: string; name: string | null; street: string | null; lon: number; lat: number; levels: number };
export type WindowNode = { id: string; street: string; edge: number; lon: number; lat: number; source: string };
export type SmartPole = { id: string; address: string; landmark: string; lon: number; lat: number };

export type Meta = {
  scenarios: Scenario[];
  modes: { key: string; label: string }[];
  stops: Stop[];
  offices: Office[];
  nodes: WindowNode[];
  poles: { sensors: string[]; items: SmartPole[] };
  center: [number, number];
  stats: { buildings: number; trees: number; segments: number; network_km: number };
  llm: string | null;
  streets: string[];
  lan_url: string;
  whatif: {
    tree_sizes: Record<TreeSize, { r: number; h: number; label: string }>;
    canopies: Record<"sail" | "awning", { length: number; width: number; height: number; label: string }>;
    mature_years: number;
    costs: Record<string, [number, number]>;
    cost_note: string;
  };
};

export type NodeReading = WindowNode & { ppm: number; per_10s: number; los: string; temp_c: number; noise_db: number };

export type State = {
  scenario: { key: string; label: string; date: string; tmin: number; tmax: number; note: string };
  minutes: number;
  time: string;
  temp_c: number;
  heat_factor: number;
  sun: { azimuth: number; elevation: number; up: boolean; sunrise: number; sunset: number };
  shaded_share: number;
  comfort: number;
  plan: string | null;
  edges: { shade: number[]; per_m: number[]; los: number[]; comfort: number[] };
  los_counts: Record<string, number>;
  stop_outflow: Record<string, number>;
  nodes: NodeReading[];
  hotspots: {
    crowded: { street: string; per_m: number; los: string }[];
    hot: { street: string; sunlit_pct: number; person_sun_min: number }[];
  };
};

export type Step = { street: string; length_m: number; shaded_pct: number; shady_side: string | null; los: string };
export type Route = {
  mode: "shortest" | "coolest" | "calmest";
  label: string;
  note: string | null;
  distance_m: number;
  minutes: number;
  sun_minutes: number;
  shaded_pct: number;
  crowded_minutes: number;
  worst_los: string;
  comfort: number;
  edges: number[];
  steps: Step[];
  geometry: { type: "LineString"; coordinates: [number, number][] };
  vs_shortest: { extra_min: number; sun_min_saved: number; crowd_min_saved: number; comfort_gain: number };
  same_as_shortest: boolean;
};
export type RouteResponse = { from: string; to: string; time: string; temp_c: number; heat_factor: number; plan: string | null; routes: Route[] };

// ------------------------------------------------------------------ what-if
export type TreeSize = "small" | "medium" | "large";
export type Tool = "tree" | "sail" | "awning" | "remove_tree" | "closure" | "erase";
export type PlanItem =
  | { kind: "tree"; lon: number; lat: number; size: TreeSize }
  | { kind: "sail" | "awning"; lon: number; lat: number }
  | { kind: "remove_tree"; tree: number }
  | { kind: "closure"; lon: number; lat: number };
export type Draft = { items: PlanItem[]; years: number };
export type Cost = {
  low: number; high: number; mid: number;
  by_kind: Record<string, { n: number; low: number; high: number }>;
  closure_per_day: [number, number] | null;
  quick_win_mid: number;
  value?: { person_min_per_10k: number | null; aud_per_route_improved: number | null };
};
export type ModeDelta = {
  trips: number;
  sun_min: [number, number];
  sun_min_saved: number;
  sun_saved_pct: number;
  walk_min: [number, number];
  comfort: [number, number];
  trips_benefit: number;
  trips_worse: number;
  median_saved_benefit: number;
  trips_detoured: number;
  median_detour_min: number;
  unreachable: number;
  person_sun_min_saved: number;
};
export type TripRow = {
  origin: string; destination: string; route: string;
  minutes_before: number; minutes_after: number; sun_min_before: number; sun_min_after: number;
  comfort_before: number; comfort_after: number;
};
export type WhatIfResult = {
  key: string; scenario: string; minutes: number; time: string; temp_c: number; sun_up: boolean; heat_matters: boolean;
  cost: Cost;
  precinct: { shaded_share: [number, number]; comfort: [number, number]; sunlit_km: [number, number] };
  edges?: { changed: [number, number][]; closed: number[] };
  affected_edges: number; trips_total: number; trips_recomputed: number; trips_benefit: number;
  usual: ModeDelta; coolest: ModeDelta; top: TripRow[];
  new_shadows?: GeoJSON.FeatureCollection;
  compute_ms: number;
};
export type PlanInfo = { key: string; years: number; overlay: GeoJSON.FeatureCollection; n_items: number; counts: Record<string, number>; cost: Cost };
export type WhatIfResponse = { plan: PlanInfo; result: WhatIfResult };
export type SavedPlan = { id: string; name: string; note: string; created: number; years: number; items: PlanItem[] };
export type SideBySide = SavedPlan & WhatIfResponse;

// ------------------------------------------------------------------ phone app
export type Role = "commuter" | "driver" | "merchant" | "council";
export type Rec = { kind: string; title: string; text: string; data?: unknown };
export type Walk = {
  leave_at: string; leave_minutes: number; arrive_at: string; temp_c: number; route: Route;
  vs_shortest: { sun_saved: number; crowd_saved: number; extra_min: number };
  lines: string[];
};
export type CommuterHome = {
  role: "commuter";
  scenario: { key: string; label: string; tmax: number; tmin: number; date: string; heat_matters: boolean };
  from: string; to: string; arrive_by: string;
  today: Walk & {
    vs_usual_time: { leave: string; crowded_min: number; sun_min: number; comfort: number } | null;
    engine: string;
  };
  /** the best departure for each route mode, so the phone can switch without another request */
  options: Partial<Record<Route["mode"], Walk>>;
  recommendations: Rec[];
};
export type StreetDay = {
  street: string; short: string;
  timeline: { t: number; per_m: number; los: string }[];
  busy: { from: string; to: string; from_min: number; to_min: number; worst: string }[];
  quiet: { from: string; to: string; from_min: number; to_min: number }[];
  peak: { time: string; los: string; per_m: number };
};
export type DriverHome = {
  role: "driver"; scenario: { key: string; label: string; tmax: number };
  streets: StreetDay[]; best_window: { from: string; to: string } | null; lines: string[]; engine: string; sms: string;
};
export type MerchantHome = {
  role: "merchant"; node: { id: string; street: string; lon: number; lat: number };
  today: { hour: number; people: number }[]; last_week: { hour: number; people: number }[];
  total: number; wow_pct: number; peak: { hour: number; people: number };
  open: string; close: string; lines: string[]; engine: string; recommendations: Rec[];
};
export type CouncilHome = {
  role: "council"; comfort_1530: number; shaded_share_1530: number; n_streets: number;
  crowded: StreetRow[]; sunny: StreetRow[];
};

export type Brief = { posted_at: string; channel: string; lines: string[]; engine: string; facts: Record<string, unknown> };
export type AskAnswer = {
  answer: string;
  tool: string | null;
  engine: string;
  action: null | { type: string; from?: string; to?: string; mode?: string; minutes: number; streets?: MarkedStreet[] };
};

// streets an Ask Lumen answer names, outlined on the map
export type MarkedStreet = { name: string; tone: "busy" | "quiet" | "hot" };

export type EvalCase = {
  key: string;
  label: string;
  scenario: string;
  minutes: number;
  temp_c: number;
  n_trips: number;
  sun: {
    baseline_median_min: number;
    saved_median_min: number;
    saved_p75_min: number;
    saved_median_pct: number;
    total_saved_min: number;
    share_trips_improved: number;
    detour_median_min: number;
    detour_p90_min: number;
    hist_saved_min: { edges: number[]; counts: number[] };
  };
  crowd: {
    trips_through_los_d: number;
    baseline_median_min: number;
    saved_median_min: number;
    saved_median_pct: number;
    detour_median_min: number;
  };
  scatter: [number, number][];
};
export type Evaluation = { origins: string[]; n_destinations: number; cases: EvalCase[] };

export type StreetRow = {
  street: string;
  length_m: number;
  effective_width_m: number;
  am_peak_ppm_per_m: number;
  am_peak_los: string;
  pm_peak_ppm_per_m: number;
  sunlit_pct_1530_hot_day: number;
};

const cache = new Map<string, Promise<unknown>>();

export async function get<T>(url: string, useCache = true): Promise<T> {
  if (useCache && cache.has(url)) return cache.get(url) as Promise<T>;
  const p = fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json() as Promise<T>;
  });
  if (useCache) {
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return p;
}

export async function del(url: string): Promise<void> {
  const r = await fetch(url, { method: "DELETE" });
  if (!r.ok) throw new Error(`${r.status}`);
}

export async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<T>;
}

export const LOS = ["A", "B", "C", "D", "E", "F"];
export const LOS_COLORS = ["#10b981", "#84cc16", "#eab308", "#f97316", "#ef4444", "#9f1239"];
export const LOS_TEXT = ["Free flow", "Minor conflicts", "Need to give way", "Crowded", "Near capacity", "Jammed"];
export const MODE_COLORS: Record<string, string> = { shortest: "#64748b", coolest: "#0d9488", calmest: "#7c3aed" };

export const aud = (n: number) => (n >= 1000 ? `A$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `A$${Math.round(n)}`);
export const audRange = (lo: number, hi: number) => `${aud(lo)}–${aud(hi)}`;

export function fmtTime(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 || 12;
  return `${h12}:${mm.toString().padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

export function placeName(meta: Meta, ref: string): string {
  const s = meta.stops.find((x) => x.id === ref);
  if (s) return s.name;
  const o = meta.offices.find((x) => x.id === ref);
  if (o) return o.name ?? `${o.street ?? "Office"} building`;
  return "Dropped pin";
}

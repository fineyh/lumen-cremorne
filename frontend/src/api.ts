export type Scenario = { key: string; label: string; note: string; tmax: number };
export type Stop = { id: string; name: string; kind: "train" | "tram"; lon: number; lat: number };
export type Office = { id: string; name: string | null; street: string | null; lon: number; lat: number; levels: number };
export type WindowNode = { id: string; street: string; edge: number; lon: number; lat: number; live: boolean; source: string };

export type Meta = {
  scenarios: Scenario[];
  modes: { key: string; label: string }[];
  stops: Stop[];
  offices: Office[];
  nodes: WindowNode[];
  center: [number, number];
  stats: { buildings: number; trees: number; segments: number; network_km: number };
  llm: string | null;
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
  edges: { shade: number[]; per_m: number[]; los: number[] };
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
  edges: number[];
  steps: Step[];
  geometry: { type: "LineString"; coordinates: [number, number][] };
  vs_shortest: { extra_min: number; sun_min_saved: number; crowd_min_saved: number };
  same_as_shortest: boolean;
};
export type RouteResponse = { from: string; to: string; time: string; temp_c: number; heat_factor: number; routes: Route[] };

export type Brief = { posted_at: string; channel: string; lines: string[]; engine: string; facts: Record<string, unknown> };
export type AskAnswer = {
  answer: string;
  tool: string | null;
  engine: string;
  action: null | { type: string; from?: string; to?: string; mode?: string; minutes: number };
};

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

export async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<T>;
}

export const LOS = ["A", "B", "C", "D", "E", "F"];
export const LOS_COLORS = ["#2f9e6b", "#8cc152", "#f2c230", "#f08a24", "#e0492f", "#a61e4d"];
export const LOS_TEXT = ["Free flow", "Minor conflicts", "Need to give way", "Crowded", "Near capacity", "Jammed"];
export const MODE_COLORS: Record<string, string> = { shortest: "#6b7a8f", coolest: "#0f9d8a", calmest: "#7c4dff" };

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

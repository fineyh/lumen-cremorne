import { useEffect, useRef, useState } from "react";
import { ArrowDownUp, Clock, Footprints, Navigation2, Sun, Users } from "lucide-react";
import { fmtTime, get, MODE_COLORS, type Meta, type Route, type RouteResponse } from "../api";
import { AccessNote, barrierMarks, StepFreeSwitch, StopNotes } from "./access";
import { Offline } from "./CommuterHome";
import MiniMap from "./MiniMap";
import type { Settings } from "./MobileApp";
import RouteWalk from "./RouteWalk";
import { loadPref, PREFS, savePref, type Pref } from "./routePref";

/** Where a walk opened from elsewhere (an Ask Lumen answer) should start. */
export type GoInit = { from?: string; to?: string; mode?: string; minutes?: number; toLabel?: string };

const STOPS = ["train-richmond", "train-east-richmond", "tram-swan-street-shopping-centre", "tram-balmain-street", "tram-lennox-street", "tram-adelaide-street"];

const toMin = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + (m || 0);
};
const hhmm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
/** The phone's clock rounded to 5 min, kept inside the modelled walking day. */
export function phoneNow() {
  const d = new Date();
  return Math.max(420, Math.min(1260, 5 * Math.round((d.getHours() * 60 + d.getMinutes()) / 5)));
}
/** Auto: the most comfortable of the three, the quicker one on a tie. */
function autoPick(routes: Route[]) {
  return [...routes].sort((a, b) => b.comfort - a.comfort || a.minutes - b.minutes)[0];
}

export default function GoView({ meta, s, scenario, init, onStepFree }: {
  meta: Meta; s: Settings; scenario: string; init: GoInit | null; onStepFree: (on: boolean) => void;
}) {
  const [from, setFrom] = useState(init?.from ?? s.office);
  const [to, setTo] = useState(init?.to ?? s.stop);
  const [t, setT] = useState(init?.minutes ?? phoneNow());
  const [pref, setPrefState] = useState<Pref>(() => (init?.mode && PREFS.some((p) => p.key === init.mode) ? (init.mode as Pref) : loadPref()));
  const [data, setData] = useState<RouteResponse | null>(null);
  const [err, setErr] = useState(false);
  const [tick, setTick] = useState(0);
  const [walking, setWalking] = useState(false);
  const req = useRef(0);
  const stepFree = !!s.stepFree;
  const setPref = (p: Pref) => {
    setPrefState(p);
    savePref(p);
  };

  useEffect(() => {
    if (from === to) return;
    const id = ++req.current;
    setErr(false);
    const q = new URLSearchParams({ from, to, scenario, t: String(t), walk: "1" });
    if (stepFree) q.set("step_free", "true");
    get<RouteResponse>(`/api/route?${q}`)
      .then((d) => id === req.current && setData(d))
      .catch(() => id === req.current && setErr(true));
  }, [from, to, t, scenario, stepFree, tick]);

  const name = (ref: string) => {
    if (ref === s.office) return "Your building";
    if (ref === s.stop) return meta.stops.find((x) => x.id === ref)?.name.replace(" Station", "") ?? "Your stop";
    const st = meta.stops.find((x) => x.id === ref);
    if (st) return st.name;
    const o = meta.offices.find((x) => x.id === ref);
    if (o) return o.name ?? `${o.street ?? "Office"} building`;
    return (ref === init?.to && init.toLabel) || "Pinned place";
  };

  const routes = data?.routes ?? [];
  const r = pref === "auto" ? (routes.length ? autoPick(routes) : undefined) : routes.find((x) => x.mode === pref);
  const hot = (data?.heat_factor ?? 0) > 0;
  const color = r ? MODE_COLORS[r.mode] : "var(--ink)";

  if (walking && r)
    return <RouteWalk route={r} start={t} from={name(from)} to={name(to)} hot={hot} stepFree={!!data?.step_free} back="Route" onClose={() => setWalking(false)} />;

  // one line per distinct path, the chosen one on top
  const same = (a: Route, b: Route) => a.edges.join() === b.edges.join();
  const distinct = routes.filter((x, k) => routes.findIndex((y) => same(x, y)) === k);
  const lines = r ? distinct.map((x) => ({ coords: x.geometry.coordinates, color: MODE_COLORS[same(x, r) ? r.mode : x.mode], muted: !same(x, r) })) : [];

  const select = (value: string, set: (v: string) => void, which: "a" | "b") => (
    <label className="go-pl">
      <span className={`go-pin ${which}`}>{which.toUpperCase()}</span>
      <select value={value} onChange={(e) => set(e.target.value)} aria-label={which === "a" ? "From" : "To"}>
        {value.includes(",") && <option value={value}>{name(value)}</option>}
        <optgroup label="Yours">
          <option value={s.office}>Your building</option>
          <option value={s.stop}>{name(s.stop)} (your stop)</option>
        </optgroup>
        <optgroup label="Stations & tram stops">
          {meta.stops.filter((x) => STOPS.includes(x.id) && x.id !== s.stop).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </optgroup>
        <optgroup label="Buildings">
          {meta.offices.filter((o) => o.name && /[A-Za-z]{3}/.test(o.name) && o.id !== s.office).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </optgroup>
      </select>
    </label>
  );

  return (
    <div className="m-stack nb go" style={{ ["--c" as string]: color }}>
      <section className="nb-hero">
        <div className="nb-top">
          <span className="nb-kicker">Where to?</span>
          <label className="nb-time" title="Leaving at">
            <Clock size={13} /> {fmtTime(t)}
            <input type="time" value={hhmm(t)} step={300} aria-label="Leaving at"
              onClick={(e) => {
                try {
                  e.currentTarget.showPicker();
                } catch {
                  /* older browsers open their own picker */
                }
              }}
              onChange={(e) => e.target.value && setT(toMin(e.target.value))} />
          </label>
        </div>
        <div className="go-places">
          {select(from, setFrom, "a")}
          <button className="go-swap" aria-label="Swap start and destination" onClick={() => { setFrom(to); setTo(from); }}><ArrowDownUp size={14} /></button>
          {select(to, setTo, "b")}
        </div>
        <StepFreeSwitch on={stepFree} onChange={onStepFree} dark />
      </section>

      {stepFree && <StopNotes meta={meta} refs={[from, to]} onUse={(stop, alt) => (stop === from ? setFrom(alt) : setTo(alt))} />}

      {from === to ? <p className="m-empty">Pick two different places.</p>
        : err ? <Offline onRetry={() => setTick(tick + 1)} />
        : !data || !r ? <div className="sk sk-card" />
        : (
          <section className="m-card">
            <div className="pref" role="radiogroup" aria-label="Route preference">
              {PREFS.map(({ key, label, icon: Icon }) => {
                const o = key === "auto" ? autoPick(routes) : routes.find((x) => x.mode === key);
                if (!o) return null;
                const c = key === "auto" ? "var(--ink)" : MODE_COLORS[key];
                return (
                  <button key={key} role="radio" aria-checked={pref === key} className={pref === key ? "on" : ""}
                    style={{ ["--c" as string]: c }} onClick={() => setPref(key)}>
                    <span className="pref-ic"><Icon size={15} /></span>
                    <b>{key === "calmest" ? o.label.replace("Least crowded", "Quietest") : label}</b>
                    <small>{o.minutes.toFixed(1)} min</small>
                  </button>
                );
              })}
            </div>
            <p className="pref-note">
              {pref === "auto" ? <>The most comfortable way at {fmtTime(t)}: the <b style={{ color }}>{r.label.toLowerCase()}</b> route.</>
                : r.note ?? (pref === "coolest" && !hot ? <>It's under 24°C then, so shade barely matters.</> : <>Tap a faded line on the map to compare.</>)}
            </p>
            <MiniMap lines={lines} marks={barrierMarks(r.access.barriers)} onPick={(k) => {
              const hit = distinct[k];
              if (hit && !same(hit, r)) setPref(hit.mode);
            }} />
            <AccessNote access={r.access} vs={data.step_free_vs} stepFree={data.step_free} onStepFree={onStepFree} />
            <div className="route-sum" key={`${pref}-${r.mode}`}>
              <div><b>{r.minutes.toFixed(1)}</b><small>min walk</small></div>
              <div><b>{r.sun_minutes.toFixed(1)}</b><small>min in sun</small></div>
              <div><b>{r.shaded_pct}%</b><small>shaded</small></div>
              <div><b>{r.comfort}</b><small>comfort</small></div>
            </div>
            {r.mode !== "shortest" && (
              <div className="nb-chips">
                {r.same_as_shortest ? <span className="nb-chip">Same as the shortest way</span> : (
                  <>
                    {r.vs_shortest.sun_min_saved > 0.05 && <span className="nb-chip shade"><Sun size={12} /> {r.vs_shortest.sun_min_saved.toFixed(1)} min less sun</span>}
                    {r.vs_shortest.crowd_min_saved > 0.05 && <span className="nb-chip quiet"><Users size={12} /> {r.vs_shortest.crowd_min_saved.toFixed(1)} min less crowding</span>}
                    <span className="nb-chip"><Footprints size={12} /> {r.vs_shortest.extra_min > 0.05 ? `+${r.vs_shortest.extra_min.toFixed(1)} min walk` : "no extra walking"}</span>
                  </>
                )}
              </div>
            )}
            <button className="m-btn primary go-start" onClick={() => setWalking(true)} disabled={!r.walk_steps?.length}>
              <Navigation2 size={16} /> Walk it step by step
            </button>
          </section>
        )}

      <p className="m-fine">Shade and crowding for {fmtTime(t)} on the {scenario === "today" ? "forecast" : "demo"} day. Your places are sent with this request only and never stored.</p>
    </div>
  );
}

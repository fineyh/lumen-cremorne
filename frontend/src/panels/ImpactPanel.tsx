import { useEffect, useState } from "react";
import { get, type EvalCase, type Evaluation } from "../api";

export default function ImpactPanel({ onShow }: { onShow: (scenario: string, minutes: number) => void }) {
  const [ev, setEv] = useState<Evaluation | null>(null);
  const [err, setErr] = useState(false);
  const [sel, setSel] = useState("hot_1530");

  useEffect(() => {
    let alive = true;
    const load = () =>
      get<Evaluation>("/api/evaluation", false)
        .then((e) => alive && setEv(e))
        .catch(() => {
          setErr(true);
          if (alive) setTimeout(load, 3000);
        });
    load();
    return () => {
      alive = false;
    };
  }, []);

  if (!ev) return <p className="muted">{err ? "Evaluation still computing on the server…" : "Loading evaluation…"}</p>;
  const c = ev.cases.find((x) => x.key === sel) ?? ev.cases[0];
  const hot1530 = ev.cases.find((x) => x.key === "hot_1530");
  const hot0845 = ev.cases.find((x) => x.key === "hot_0845");
  const mild = ev.cases.find((x) => x.key === "mild_1530");

  return (
    <div className="impact">
      <p className="lede">
        Offline, reproducible test: every trip from {ev.origins.length} stops ({ev.origins.join(", ")}) to {ev.n_destinations} workplaces
        in Cremorne, shortest route vs Lumen's routes.
      </p>

      <div className="headline">
        {hot1530 && (
          <div className="hl">
            <b>−{Math.round(hot1530.sun.saved_median_pct)}%</b>
            <span>median time in the sun, 3:30pm on a 35°C day, for a median detour of {hot1530.sun.detour_median_min.toFixed(1)} min</span>
          </div>
        )}
        {hot0845 && (
          <div className="hl calm">
            <b>−{Math.round(hot0845.crowd.saved_median_pct)}%</b>
            <span>crowded walking (LOS D+) at 8:45am for the {hot0845.crowd.trips_through_los_d} trips that hit it, +{hot0845.crowd.detour_median_min.toFixed(1)} min median</span>
          </div>
        )}
        {mild && (
          <div className="hl neutral">
            <b>{Math.round(mild.sun.share_trips_improved * 100)}%</b>
            <span>of trips re-routed on the 21°C control day. When shade doesn't matter, Lumen doesn't send you the long way.</span>
          </div>
        )}
      </div>

      <div className="seg wide">
        {ev.cases.map((x) => (
          <button key={x.key} className={x.key === sel ? "on" : ""} onClick={() => setSel(x.key)}>{x.label}</button>
        ))}
      </div>
      <CaseDetail c={c} />
      <button className="btn" onClick={() => onShow(c.scenario, c.minutes)}>See this moment on the map →</button>

      <h4>How it's computed</h4>
      <ul className="method">
        <li>Sun position from the NOAA solar algorithm. Building shadows from OSM footprints, with heights from OSM tags, else floors × 3.5 m, else a type default.</li>
        <li>Tree shade: {`City of Yarra's`} street-tree inventory, crown size estimated from trunk diameter.</li>
        <li>Each road segment is scored on its shadier footpath. The walker can pick a side.</li>
        <li>Crowding: train-arrival pulses assigned along shortest paths to workplaces, divided by effective footpath width (Fruin LOS). A heuristic, not measured yet.</li>
        <li>Walking speed 1.3 m/s. Heat weight H = max(0, (T − 24) / 10).</li>
      </ul>
    </div>
  );
}

function CaseDetail({ c }: { c: EvalCase }) {
  const h = c.sun.hist_saved_min;
  const max = Math.max(1, ...h.counts);
  return (
    <div className="case">
      <div className="stat-row">
        <div className="stat"><b>{c.sun.baseline_median_min.toFixed(1)}</b><small>median min in sun, shortest</small></div>
        <div className="stat"><b>{c.sun.saved_median_min.toFixed(1)}</b><small>median min saved, coolest</small></div>
        <div className="stat"><b>{Math.round(c.sun.share_trips_improved * 100)}%</b><small>trips improved</small></div>
        <div className="stat"><b>{c.sun.detour_p90_min.toFixed(1)}</b><small>90th pct detour (min)</small></div>
      </div>
      <div className="hist" aria-label="Distribution of sun minutes saved per trip">
        {h.counts.map((n, i) => (
          <div key={i} className="hb" title={`${n} trips saved ${h.edges[i]}–${h.edges[i + 1]} min`}>
            <span className="n">{n || ""}</span>
            <i style={{ height: `${(n / max) * 100}%` }} />
            <span className="x">{h.edges[i]}{i === h.counts.length - 1 ? "+" : ""}</span>
          </div>
        ))}
      </div>
      <p className="fine">Sun minutes saved per trip (n = {c.n_trips}), {c.label}, {c.temp_c}°C.</p>
      <Scatter pts={c.scatter} />
    </div>
  );
}

function Scatter({ pts }: { pts: [number, number][] }) {
  const W = 320, H = 150, P = 26;
  const xmax = Math.max(3, ...pts.map((p) => p[0]));
  const ymax = Math.max(3, ...pts.map((p) => p[1]));
  const x = (v: number) => P + (Math.max(0, v) / xmax) * (W - P - 8);
  const y = (v: number) => H - P - (Math.max(0, v) / ymax) * (H - P - 8);
  return (
    <svg className="scatter" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Detour versus sun minutes saved">
      <line x1={P} y1={H - P} x2={W - 4} y2={H - P} className="axis" />
      <line x1={P} y1={4} x2={P} y2={H - P} className="axis" />
      <line x1={x(0)} y1={y(0)} x2={x(Math.min(xmax, ymax))} y2={y(Math.min(xmax, ymax))} className="diag" />
      {pts.map((p, i) => (
        <circle key={i} cx={x(p[0])} cy={y(p[1])} r={2.6} className="pt" />
      ))}
      <text x={W / 2} y={H - 6} textAnchor="middle">extra walking (min)</text>
      <text x={10} y={H / 2} textAnchor="middle" transform={`rotate(-90 10 ${H / 2})`}>sun min saved</text>
    </svg>
  );
}

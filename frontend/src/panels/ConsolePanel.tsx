import { useEffect, useState } from "react";
import { LOS, LOS_COLORS, fmtTime, get, type Meta, type State, type StreetRow } from "../api";
import type { Live } from "../App";

type Props = { meta: Meta; state: State | null; live: Live; liveNodeId: string; scenario: string };

export default function ConsolePanel({ meta, state, live, liveNodeId, scenario }: Props) {
  const [nodeId, setNodeId] = useState("node-04");
  const [profile, setProfile] = useState<{ hour: number; people: number }[]>([]);
  const [report, setReport] = useState<StreetRow[]>([]);
  const [view, setView] = useState<"hub" | "tenant">("hub");

  useEffect(() => {
    get<{ hour: number; people: number }[]>(`/api/nodes/${nodeId}/profile`).then(setProfile).catch(() => setProfile([]));
  }, [nodeId]);
  useEffect(() => {
    get<StreetRow[]>(`/api/report?scenario=${scenario}`).then(setReport).catch(() => setReport([]));
  }, [scenario]);

  const node = meta.nodes.find((n) => n.id === nodeId);
  const maxP = Math.max(1, ...profile.map((p) => p.people));
  const nowH = state ? Math.floor(state.minutes / 60) : -1;

  return (
    <div className="console">
      <div className="seg wide">
        <button className={view === "hub" ? "on" : ""} onClick={() => setView("hub")}>Hub view</button>
        <button className={view === "tenant" ? "on" : ""} onClick={() => setView("tenant")}>Tenant view</button>
      </div>

      {view === "hub" && state && (
        <>
          <section>
            <h3>Right now · {fmtTime(state.minutes)}</h3>
            <div className="stat-row">
              <Stat label="paths with a shaded side" value={`${Math.round(state.shaded_share * 100)}%`} />
              <Stat label="km at LOS D or worse" value={(state.los_counts.D + state.los_counts.E + state.los_counts.F).toFixed(2)} />
              <Stat label="leaving Richmond Stn / min" value={String(state.stop_outflow["train-richmond"] ?? 0)} />
            </div>
          </section>
          <section className="two">
            <div>
              <h4>Most crowded</h4>
              <ul className="rank">
                {state.hotspots.crowded.map((c) => (
                  <li key={c.street}>
                    <span>{c.street}</span>
                    <b className="los" style={{ background: LOS_COLORS[LOS.indexOf(c.los)] }}>{c.los}</b>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4>Most sun-exposed</h4>
              <ul className="rank">
                {state.hotspots.hot.map((h) => (
                  <li key={h.street}>
                    <span>{h.street}</span>
                    <b className="sunpct">{state.sun.up ? `${h.sunlit_pct}%` : "–"}</b>
                  </li>
                ))}
              </ul>
            </div>
          </section>
          <section>
            <h3>Window nodes</h3>
            <table className="nodes">
              <thead>
                <tr><th>node</th><th>street</th><th>ppl/min</th><th>LOS</th><th>°C</th><th>dB</th></tr>
              </thead>
              <tbody>
                <tr className="live-row">
                  <td>{liveNodeId}</td><td>Cremorne St</td>
                  <td>{live.online ? live.perMin.toFixed(0) : "–"}</td><td colSpan={3}><span className={`tag ${live.online ? "live" : ""}`}>{live.online ? "live" : "offline"}</span> {live.total} counted</td>
                </tr>
                {state.nodes.filter((n) => !n.live).map((n) => (
                  <tr key={n.id} onClick={() => { setNodeId(n.id); setView("tenant"); }}>
                    <td>{n.id}</td><td>{n.street.replace(" Street", " St")}</td><td>{n.ppm.toFixed(0)}</td>
                    <td><b className="los" style={{ background: LOS_COLORS[LOS.indexOf(n.los)] }}>{n.los}</b></td>
                    <td>{n.temp_c}</td><td>{n.noise_db}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="fine"><span className="tag">replayed</span> rows are synthetic readings generated from the model, labelled that way on purpose. Only node-00 is a real sensor.</p>
          </section>
          <section>
            <h3>Weekly evidence for council</h3>
            <table className="report">
              <thead><tr><th>street</th><th>clear width</th><th>8:45 LOS</th><th>sunlit 3:30pm</th></tr></thead>
              <tbody>
                {report.slice(0, 8).map((r) => (
                  <tr key={r.street}>
                    <td>{r.street}</td><td>{r.effective_width_m} m</td>
                    <td><b className="los" style={{ background: LOS_COLORS[LOS.indexOf(r.am_peak_los)] }}>{r.am_peak_los}</b></td>
                    <td>{r.sunlit_pct_1530_hot_day}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <a className="btn" href={`/api/report.csv?scenario=${scenario}`} download>Download CSV</a>
          </section>
        </>
      )}

      {view === "tenant" && (
        <section>
          <h3>Foot traffic outside your window</h3>
          <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            {meta.nodes.filter((n) => !n.live).map((n) => (
              <option key={n.id} value={n.id}>{n.id} · {n.street}</option>
            ))}
          </select>
          <p className="lede">What a café owner on {node?.street} sees on Monday, no IT needed: people passing each hour, for rostering and opening hours.</p>
          <div className="bars">
            {profile.map((p) => (
              <div key={p.hour} className={`b ${p.hour === nowH ? "now" : ""}`} title={`${p.people} people`}>
                <i style={{ height: `${(p.people / maxP) * 100}%` }} />
                <span>{p.hour % 3 === 0 ? (p.hour > 12 ? `${p.hour - 12}p` : `${p.hour}${p.hour === 12 ? "p" : "a"}`) : ""}</span>
              </div>
            ))}
          </div>
          <p className="fine">Busiest hour: {profile.length ? (() => { const b = profile.reduce((a, c) => (c.people > a.people ? c : a)); return `${b.hour}:00, about ${b.people.toLocaleString()} people`; })() : "–"} (replayed data). The tenant owns this data. Only anonymous totals are shared with the precinct.</p>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <b>{value}</b>
      <small>{label}</small>
    </div>
  );
}

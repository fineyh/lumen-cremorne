import { useEffect, useState } from "react";
import { Download, Sun, TrainFront, Users } from "lucide-react";
import { LOS, LOS_COLORS, fmtTime, get, type Meta, type State, type StreetRow } from "../api";

type Props = { meta: Meta; state: State | null; scenario: string };

export default function ConsolePanel({ meta, state, scenario }: Props) {
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
            <div className="now-grid">
              <ComfortGauge value={state.comfort} />
              <div className="stat-col">
                <Stat icon={Sun} label="paths with a shaded side" value={`${Math.round(state.shaded_share * 100)}%`} />
                <Stat icon={Users} label="km at LOS D or worse" value={(state.los_counts.D + state.los_counts.E + state.los_counts.F).toFixed(2)} />
                <Stat icon={TrainFront} label="leaving Richmond Stn / min" value={String(state.stop_outflow["train-richmond"] ?? 0)} />
              </div>
            </div>
            <p className="fine">Comfort Score = 100 − 60 × sunlit share × heat weight − 40 × crowding penalty, per metre of footpath in Cremorne.</p>
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
                {state.nodes.map((n) => (
                  <tr key={n.id} onClick={() => { setNodeId(n.id); setView("tenant"); }}>
                    <td>{n.id}</td><td>{n.street.replace(" Street", " St")}</td><td>{n.ppm.toFixed(0)}</td>
                    <td><b className="los" style={{ background: LOS_COLORS[LOS.indexOf(n.los)] }}>{n.los}</b></td>
                    <td>{n.temp_c}</td><td>{n.noise_db}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="fine"><span className="tag">replayed</span> All rows are synthetic readings generated from the model, labelled that way on purpose. No node is deployed yet.</p>
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
            <a className="btn" href={`/api/report.csv?scenario=${scenario}`} download><Download size={14} /> Download CSV</a>
          </section>
        </>
      )}

      {view === "tenant" && (
        <section>
          <h3>Foot traffic outside your window</h3>
          <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            {meta.nodes.map((n) => (
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

function Stat({ label, value, icon: I }: { label: string; value: string; icon: typeof Sun }) {
  return (
    <div className="stat">
      <span className="stat-ic"><I size={15} /></span>
      <div><b>{value}</b><small>{label}</small></div>
    </div>
  );
}

export function ComfortGauge({ value, size = 132, label = "Comfort Score" }: { value: number; size?: number; label?: string }) {
  const r = 52, c = 2 * Math.PI * r, arc = 0.75;
  const frac = Math.max(0, Math.min(1, value / 100));
  const color = value >= 85 ? "#0d9488" : value >= 70 ? "#65a30d" : value >= 55 ? "#f59e0b" : "#e11d48";
  return (
    <div className="gauge" style={{ width: size }}>
      <svg viewBox="0 0 128 128" width={size} height={size}>
        <defs>
          <linearGradient id="gg" x1="0" x2="1" y1="1" y2="0">
            <stop offset="0" stopColor="#f59e0b" /><stop offset="0.5" stopColor="#facc15" /><stop offset="1" stopColor="#0d9488" />
          </linearGradient>
        </defs>
        <circle cx="64" cy="64" r={r} fill="none" stroke="rgba(11,19,36,.08)" strokeWidth="11" strokeLinecap="round"
          strokeDasharray={`${c * arc} ${c}`} transform="rotate(135 64 64)" />
        <circle cx="64" cy="64" r={r} fill="none" stroke="url(#gg)" strokeWidth="11" strokeLinecap="round"
          strokeDasharray={`${c * arc * frac} ${c}`} transform="rotate(135 64 64)" style={{ transition: "stroke-dasharray .6s ease" }} />
      </svg>
      <div className="gauge-v"><b style={{ color }}>{value.toFixed(0)}</b><small>{label}</small></div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { fmtTime, get, type Scenario, type State } from "./api";

const MIN = 360;
const MAX = 1260;
const STEP = 15;

type Props = {
  scenarios: Scenario[];
  scenario: string;
  setScenario: (s: string) => void;
  minutes: number;
  setMinutes: (m: number | ((m: number) => number)) => void;
  state: State | null;
  loading: boolean;
};

export default function TimeBar(p: Props) {
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      p.setMinutes((m: number) => (m + STEP > MAX ? MIN : m + STEP));
    }, 900);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // prefetch the next frames so playback stays smooth
  useEffect(() => {
    for (let k = 1; k <= 3; k++) {
      const m = p.minutes + k * STEP;
      if (m > MAX) break;
      get(`/api/shadows?scenario=${p.scenario}&t=${m}`).catch(() => undefined);
      get(`/api/state?scenario=${p.scenario}&t=${m}`).catch(() => undefined);
    }
  }, [p.minutes, p.scenario]);

  const st = p.state;
  const marks = [
    { m: 525, label: "8:45 rush" },
    { m: 750, label: "lunch" },
    { m: 930, label: "3:30 heat" },
    { m: 1050, label: "home time" },
  ];

  return (
    <div className="timebar">
      <div className="tb-top">
        <div className="scen">
          {p.scenarios.map((s) => (
            <button key={s.key} className={p.scenario === s.key ? "on" : ""} onClick={() => p.setScenario(s.key)} title={s.note}>
              {s.label}
            </button>
          ))}
        </div>
        {st && (
          <div className="readouts">
            <SunDial az={st.sun.azimuth} el={st.sun.elevation} />
            <div><b>{fmtTime(p.minutes)}</b><small>{st.scenario.date}</small></div>
            <div><b className={st.temp_c >= 30 ? "hot" : ""}>{st.temp_c.toFixed(1)}°C</b><small>{st.heat_factor > 0 ? `heat weight ${st.heat_factor}` : "shade not weighted"}</small></div>
            <div><b>{st.sun.up ? `${st.sun.elevation.toFixed(0)}°` : "—"}</b><small>{st.sun.up ? `sun elevation, az ${st.sun.azimuth.toFixed(0)}°` : "sun down"}</small></div>
            <div><b>{Math.round(st.shaded_share * 100)}%</b><small>of paths have a shaded side</small></div>
          </div>
        )}
        {p.loading && <span className="spinner" aria-label="computing" />}
      </div>
      <div className="tb-slider">
        <button className="play" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="track">
          <input type="range" min={MIN} max={MAX} step={STEP} value={p.minutes} onChange={(e) => p.setMinutes(Number(e.target.value))} />
          <div className="marks">
            {marks.map((k) => (
              <button key={k.m} style={{ left: `${((k.m - MIN) / (MAX - MIN)) * 100}%` }} onClick={() => p.setMinutes(k.m)}>
                {k.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SunDial({ az, el }: { az: number; el: number }) {
  const r = 17;
  const up = el > 0;
  const d = up ? r * (1 - el / 90) : r;
  const x = 20 + d * Math.sin((az * Math.PI) / 180);
  const y = 20 - d * Math.cos((az * Math.PI) / 180);
  return (
    <svg className="sundial" width="40" height="40" viewBox="0 0 40 40" aria-label="sun position">
      <circle cx="20" cy="20" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" />
      <text x="20" y="7" fontSize="6" textAnchor="middle" fill="currentColor" opacity="0.6">N</text>
      <circle cx={x} cy={y} r="4" fill={up ? "#f5a524" : "#7a8594"} />
    </svg>
  );
}

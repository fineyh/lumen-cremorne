import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView, { type LayerToggles } from "./MapView";
import TimeBar from "./TimeBar";
import RoutePanel from "./panels/RoutePanel";
import ConsolePanel from "./panels/ConsolePanel";
import BriefPanel from "./panels/BriefPanel";
import ImpactPanel from "./panels/ImpactPanel";
import LimitsPanel from "./panels/LimitsPanel";
import { get, type Meta, type RouteResponse, type State } from "./api";

type Tab = "route" | "console" | "brief" | "impact" | "limits";
const TABS: { key: Tab; label: string }[] = [
  { key: "route", label: "Route" },
  { key: "console", label: "Precinct" },
  { key: "brief", label: "Brief" },
  { key: "impact", label: "Impact" },
  { key: "limits", label: "Limits" },
];

export type Live = { total: number; perMin: number; online: boolean; flash: number; temp?: number; noise?: number };

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("route");
  const [scenario, setScenario] = useState("hot");
  const [minutes, setMinutes] = useState(930);
  const [state, setState] = useState<State | null>(null);
  const [shadows, setShadows] = useState<GeoJSON.FeatureCollection | null>(null);
  const [from, setFrom] = useState("train-richmond");
  const [to, setTo] = useState<string>("");
  const [routes, setRoutes] = useState<RouteResponse | null>(null);
  const [selectedMode, setSelectedMode] = useState("coolest");
  const [pickMode, setPickMode] = useState<"from" | "to" | null>(null);
  const [toggles, setToggles] = useState<LayerToggles>({ shadows: true, trees: true, network: "shade", buildings3d: false, nodes: true });
  const [live, setLive] = useState<Live>({ total: 0, perMin: 0, online: false, flash: 0 });
  const [loading, setLoading] = useState(false);
  const liveNodeId = meta?.nodes.find((n) => n.live)?.id ?? "node-00";

  // ------------------------------------------------------------------ bootstrap
  useEffect(() => {
    get<Meta>("/api/meta")
      .then((m) => {
        setMeta(m);
        const dover = m.offices.find((o) => o.name === "Dover House") ?? m.offices[0];
        setTo(dover.id);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  // ------------------------------------------------------------------ time-dependent state
  const reqId = useRef(0);
  useEffect(() => {
    if (!meta) return;
    const id = ++reqId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      Promise.all([
        get<State>(`/api/state?scenario=${scenario}&t=${minutes}`),
        get<GeoJSON.FeatureCollection>(`/api/shadows?scenario=${scenario}&t=${minutes}`),
      ])
        .then(([s, sh]) => {
          if (id !== reqId.current) return;
          setState(s);
          setShadows(sh);
          setLoading(false);
        })
        .catch((e) => setErr(String(e)));
    }, 90);
    return () => clearTimeout(timer);
  }, [meta, scenario, minutes]);

  useEffect(() => {
    if (!meta || !from || !to) return;
    get<RouteResponse>(`/api/route?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&scenario=${scenario}&t=${minutes}`)
      .then(setRoutes)
      .catch(() => setRoutes(null));
  }, [meta, from, to, scenario, minutes]);

  // ------------------------------------------------------------------ live node (SSE)
  useEffect(() => {
    if (!meta) return;
    const es = new EventSource("/api/live/stream");
    es.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.type === "snapshot") {
        const n = d.nodes[liveNodeId];
        if (n) setLive({ total: n.in + n.out, perMin: n.per_min, online: n.online, flash: 0, temp: n.temp_c, noise: n.noise_db });
      } else if (d.type === "reading" && d.node_id === liveNodeId) {
        setLive((l) => ({ total: d.in + d.out, perMin: d.per_min, online: true, flash: l.flash + 1, temp: d.temp_c, noise: d.noise_db }));
      } else if (d.type === "reset") {
        setLive({ total: 0, perMin: 0, online: false, flash: 0 });
      }
    };
    const t = setInterval(() => {
      get<Record<string, { online: boolean; per_min: number }>>("/api/live/state", false).then((s) => {
        const n = s[liveNodeId];
        setLive((l) => ({ ...l, online: !!n?.online, perMin: n?.per_min ?? 0 }));
      }).catch(() => undefined);
    }, 5000);
    return () => {
      es.close();
      clearInterval(t);
    };
  }, [meta, liveNodeId]);

  const onPick = useCallback(
    (ll: [number, number]) => {
      const ref = `${ll[0].toFixed(6)},${ll[1].toFixed(6)}`;
      if (pickMode === "from") setFrom(ref);
      if (pickMode === "to") setTo(ref);
      setPickMode(null);
    },
    [pickMode],
  );

  const pos = useCallback(
    (ref: string): [number, number] | null => {
      if (!meta || !ref) return null;
      const s = meta.stops.find((x) => x.id === ref) ?? meta.offices.find((x) => x.id === ref);
      if (s) return [s.lon, s.lat];
      const [a, b] = ref.split(",").map(Number);
      return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
    },
    [meta],
  );
  const fromPos = useMemo(() => pos(from), [pos, from]);
  const toPos = useMemo(() => pos(to), [pos, to]);

  if (err) return <div className="fatal">Can't reach the Lumen server. Start it with <code>python backend/server.py</code>.<br /><small>{err}</small></div>;
  if (!meta) return <div className="fatal">Lighting up Cremorne…</div>;

  return (
    <div className="app">
      <aside className="side">
        <header className="brand">
          <img src="/lumen.svg" alt="" width={34} height={34} />
          <div>
            <h1>Lumen</h1>
            <p>700 windows, one precinct</p>
          </div>
          <span className="privacy-pill" title="Window nodes send counts only. No frames are stored or transmitted.">no images leave the node</span>
        </header>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="panel">
          {tab === "route" && (
            <RoutePanel
              meta={meta} from={from} to={to} setFrom={setFrom} setTo={setTo} routes={routes}
              selectedMode={selectedMode} setSelectedMode={setSelectedMode} pickMode={pickMode} setPickMode={setPickMode}
            />
          )}
          {tab === "console" && <ConsolePanel meta={meta} state={state} live={live} liveNodeId={liveNodeId} scenario={scenario} />}
          {tab === "brief" && (
            <BriefPanel
              meta={meta} scenario={scenario} minutes={minutes} office={to}
              onShowRoute={(a) => {
                if (a.from) setFrom(a.from);
                if (a.to) setTo(a.to);
                if (a.mode) setSelectedMode(a.mode);
                setMinutes(a.minutes);
                setTab("route");
              }}
              onShowTime={(m) => setMinutes(m)}
            />
          )}
          {tab === "impact" && <ImpactPanel onShow={(sc, m) => { setScenario(sc); setMinutes(m); setTab("route"); }} />}
          {tab === "limits" && <LimitsPanel />}
        </div>
        <footer className="side-foot">
          {meta.stats.buildings.toLocaleString()} buildings · {meta.stats.trees.toLocaleString()} trees · {meta.stats.network_km} km of paths · all computed on this laptop
        </footer>
      </aside>
      <main className="stage">
        <MapView
          meta={meta} state={state} shadows={shadows} routes={routes?.routes ?? []} selectedMode={selectedMode}
          toggles={toggles} from={fromPos} to={toPos} pickMode={pickMode} onPick={onPick}
          liveCount={live.total} livePerMin={live.perMin} liveOnline={live.online} liveFlash={live.flash}
        />
        <LayerPanel toggles={toggles} setToggles={setToggles} />
        {pickMode && <div className="pick-hint">Click the map to set {pickMode === "from" ? "the start" : "the destination"} · <button onClick={() => setPickMode(null)}>cancel</button></div>}
        <LiveCard live={live} />
        <TimeBar
          scenarios={meta.scenarios} scenario={scenario} setScenario={setScenario}
          minutes={minutes} setMinutes={setMinutes} state={state} loading={loading}
        />
      </main>
    </div>
  );
}

function LayerPanel({ toggles, setToggles }: { toggles: LayerToggles; setToggles: (t: LayerToggles) => void }) {
  const set = (k: keyof LayerToggles, v: LayerToggles[keyof LayerToggles]) => setToggles({ ...toggles, [k]: v });
  return (
    <div className="layers">
      <div className="seg">
        {(["shade", "crowd", "off"] as const).map((k) => (
          <button key={k} className={toggles.network === k ? "on" : ""} onClick={() => set("network", k)}>
            {k === "shade" ? "Shade" : k === "crowd" ? "Crowding" : "Paths off"}
          </button>
        ))}
      </div>
      <label><input type="checkbox" checked={toggles.shadows} onChange={(e) => set("shadows", e.target.checked)} /> Shadows</label>
      <label><input type="checkbox" checked={toggles.trees} onChange={(e) => set("trees", e.target.checked)} /> Tree canopy</label>
      <label><input type="checkbox" checked={toggles.nodes} onChange={(e) => set("nodes", e.target.checked)} /> Window nodes</label>
      <label><input type="checkbox" checked={toggles.buildings3d} onChange={(e) => set("buildings3d", e.target.checked)} /> 3D</label>
      <Legend mode={toggles.network} />
    </div>
  );
}

function Legend({ mode }: { mode: LayerToggles["network"] }) {
  if (mode === "shade")
    return (
      <div className="legend">
        <div className="grad shade" />
        <div className="grad-l"><span>in sun</span><span>shaded side</span></div>
      </div>
    );
  if (mode === "crowd")
    return (
      <div className="legend los">
        {["A", "B", "C", "D", "E", "F"].map((l, i) => (
          <span key={l} style={{ background: ["#2f9e6b", "#8cc152", "#f2c230", "#f08a24", "#e0492f", "#a61e4d"][i] }}>{l}</span>
        ))}
        <small>Fruin level of service, peak minute</small>
      </div>
    );
  return null;
}

function LiveCard({ live }: { live: Live }) {
  return (
    <div className={`live-card ${live.online ? "on" : ""}`}>
      <div className="live-head">
        <span className="dot" /> node-00 · Cremorne St {live.online ? "LIVE" : "waiting for node"}
      </div>
      <div className="live-num" key={live.flash}>{live.total}</div>
      <div className="live-sub">
        passers-by counted · {live.perMin.toFixed(0)}/min
        {live.temp != null && <> · {live.temp}°C</>}
        {live.noise != null && <> · {live.noise} dB</>}
      </div>
    </div>
  );
}

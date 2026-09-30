import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3, Eye, EyeOff, Layers, LayoutDashboard, MessageSquareText, MousePointerClick, Route as RouteIcon,
  ShieldCheck, Smartphone, Sprout, X,
} from "lucide-react";
import QRCode from "qrcode";
import MapView, { type EditClick, type LayerToggles } from "./MapView";
import TimeBar from "./TimeBar";
import { ACCESS_LEGEND, badgeUrl } from "./accessIcons";
import RoutePanel from "./panels/RoutePanel";
import ConsolePanel from "./panels/ConsolePanel";
import BriefPanel from "./panels/BriefPanel";
import ImpactPanel from "./panels/ImpactPanel";
import LimitsPanel from "./panels/LimitsPanel";
import WhatIfPanel, { TOOL_INFO } from "./panels/WhatIfPanel";
import {
  fmtTime, get, post, type Draft, type MarkedStreet, type Meta, type RouteResponse, type State, type Tool, type TreeSize, type WhatIfResponse,
} from "./api";

type Tab = "route" | "console" | "whatif" | "brief" | "impact" | "limits";
const TABS: { key: Tab; label: string; icon: typeof RouteIcon }[] = [
  { key: "route", label: "Route", icon: RouteIcon },
  { key: "console", label: "Precinct", icon: LayoutDashboard },
  { key: "whatif", label: "What-if", icon: Sprout },
  { key: "brief", label: "Brief", icon: MessageSquareText },
  { key: "impact", label: "Impact", icon: BarChart3 },
  { key: "limits", label: "Limits", icon: ShieldCheck },
];
const SIDE = 412;

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
  const [toggles, setToggles] = useState<LayerToggles>({ shadows: true, trees: true, network: "shade", buildings3d: false, nodes: true, poles: true, stops: true, access: true });
  const [stepFree, setStepFreeRaw] = useState(() => {
    try {
      return localStorage.getItem("lumen.console.stepFree") === "1";
    } catch {
      return false;
    }
  });
  const setStepFree = useCallback((on: boolean) => {
    setStepFreeRaw(on);
    // planning step-free is when the ramps, crossings and steps matter: make sure they're on the map
    if (on) setToggles((t) => (t.access ? t : { ...t, access: true }));
    try {
      localStorage.setItem("lumen.console.stepFree", on ? "1" : "0");
    } catch {
      /* private mode: remembered for this visit only */
    }
  }, []);
  const [loading, setLoading] = useState(false);
  const [showPhone, setShowPhone] = useState(false);
  // streets named by the last Ask Lumen answer, valid only for the scenario and time it was asked about
  const [marked, setMarked] = useState<{ kind: string; scenario: string; minutes: number; streets: MarkedStreet[] } | null>(null);
  // what-if
  const [draft, setDraftRaw] = useState<Draft>({ items: [], years: 1 });
  const [history, setHistory] = useState<Draft[]>([]);
  const [tool, setTool] = useState<Tool | null>(null);
  const [treeSize, setTreeSize] = useState<TreeSize>("medium");
  const [whatif, setWhatif] = useState<WhatIfResponse | null>(null);
  const [whatifBusy, setWhatifBusy] = useState(false);
  const [showAfter, setShowAfter] = useState(true);

  const draftRef = useRef(draft);
  const setDraft = useCallback((d: Draft | ((d: Draft) => Draft)) => {
    const cur = draftRef.current;
    const next = typeof d === "function" ? d(cur) : d;
    if (next === cur) return;
    draftRef.current = next;
    setHistory((h) => [...h.slice(-40), cur]);
    setDraftRaw(next);
  }, []);
  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    draftRef.current = prev;
    setHistory(history.slice(0, -1));
    setDraftRaw(prev);
  };

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

  // ------------------------------------------------------------------ what-if: recompute on every edit
  const planActive = draft.items.length > 0;
  const planKey = planActive && showAfter && whatif && whatif.result.key === whatif.plan.key ? whatif.plan.key : null;
  const wiReq = useRef(0);
  useEffect(() => {
    if (!meta) return;
    if (!planActive) {
      setWhatif(null);
      return;
    }
    const id = ++wiReq.current;
    setWhatifBusy(true);
    const timer = setTimeout(() => {
      post<WhatIfResponse>("/api/whatif/compare", { items: draft.items, years: draft.years, scenario, t: minutes })
        .then((r) => {
          if (id !== wiReq.current) return;
          setWhatif(r);
          setWhatifBusy(false);
        })
        .catch(() => id === wiReq.current && setWhatifBusy(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [meta, draft, scenario, minutes, planActive]);

  // ------------------------------------------------------------------ time-dependent state
  const planQ = planKey ? `&plan=${planKey}` : "";
  const reqId = useRef(0);
  useEffect(() => {
    if (!meta) return;
    const id = ++reqId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      Promise.all([
        get<State>(`/api/state?scenario=${scenario}&t=${minutes}${planQ}`),
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
  }, [meta, scenario, minutes, planQ]);

  useEffect(() => {
    if (!meta || !from || !to) return;
    get<RouteResponse>(`/api/route?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&scenario=${scenario}&t=${minutes}${planQ}${stepFree ? "&step_free=true" : ""}`)
      .then(setRoutes)
      .catch(() => setRoutes(null));
  }, [meta, from, to, scenario, minutes, planQ, stepFree]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTool(null);
        setPickMode(null);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && tab === "whatif") undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onPick = useCallback(
    (ll: [number, number]) => {
      const ref = `${ll[0].toFixed(6)},${ll[1].toFixed(6)}`;
      if (pickMode === "from") setFrom(ref);
      if (pickMode === "to") setTo(ref);
      setPickMode(null);
    },
    [pickMode],
  );

  // a stop's "Start here" / "Go here" (or a click on a stop while picking)
  const onRouteEnd = useCallback((ref: string, which: "from" | "to") => {
    if (which === "from") setFrom(ref);
    else setTo(ref);
    setPickMode(null);
    setTab("route");
    setTool(null);
  }, []);

  const onEdit = useCallback(
    (e: EditClick) => {
      if (!tool) return;
      const [lon, lat] = e.lngLat;
      setShowAfter(true);
      setDraft((d) => {
        if (tool === "erase") return e.itemIndex == null ? d : { ...d, items: d.items.filter((_, i) => i !== e.itemIndex) };
        if (tool === "remove_tree") {
          if (e.treeIndex == null || d.items.some((it) => it.kind === "remove_tree" && it.tree === e.treeIndex)) return d;
          return { ...d, items: [...d.items, { kind: "remove_tree", tree: e.treeIndex }] };
        }
        if (tool === "tree") return { ...d, items: [...d.items, { kind: "tree", lon, lat, size: treeSize }] };
        return { ...d, items: [...d.items, { kind: tool, lon, lat }] };
      });
    },
    [tool, treeSize, setDraft],
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
  const changed = useMemo(() => (planKey && whatif?.result.edges?.changed) || [], [planKey, whatif]);
  // once the time or weather moves on, the answer no longer describes the map
  const shownMarks = marked && marked.scenario === scenario && marked.minutes === minutes ? marked : null;
  const markStreets = useMemo(() => shownMarks?.streets ?? [], [shownMarks]);
  const barriers = useMemo(
    () => routes?.routes.find((r) => r.mode === selectedMode)?.access?.barriers ?? [],
    [routes, selectedMode],
  );

  if (err) return <div className="fatal"><div><b>Can't reach the Lumen server.</b><br />It may be restarting. Try reloading in a minute.<br /><small>{err}</small></div></div>;
  if (!meta) return <div className="fatal"><div className="boot"><img src="/lumen.svg" alt="" width={48} height={48} /><span>Lighting up Cremorne…</span></div></div>;

  const editing = tab === "whatif" && tool;
  return (
    <div className="app" style={{ ["--side" as string]: `${SIDE}px` }}>
      <main className="stage">
        <MapView
          meta={meta} state={state} shadows={shadows} routes={routes?.routes ?? []} selectedMode={selectedMode}
          toggles={toggles} from={fromPos} to={toPos} pickMode={pickMode} onPick={onPick}
          editTool={editing ? tool : null} onEdit={onEdit}
          overlay={planActive ? whatif?.plan.overlay ?? null : null}
          newShadows={planKey ? whatif?.result.new_shadows ?? null : null}
          changed={changed} sidePad={SIDE} marked={markStreets}
          barriers={barriers} onRouteEnd={onRouteEnd}
        />
      </main>

      <aside className="side glass">
        <header className="brand">
          <div className="logo"><img src="/lumen.svg" alt="" width={30} height={30} /></div>
          <div className="brand-t">
            <h1>Lumen</h1>
            <p>Precinct Console · Cremorne</p>
          </div>
          <button className="icon-btn" onClick={() => setShowPhone(true)} title="Open the phone app">
            <Smartphone size={16} /> <span>Phone app</span>
          </button>
        </header>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => { setTab(t.key); if (t.key !== "whatif") setTool(null); }}>
              <t.icon size={17} strokeWidth={2} />
              <span>{t.label}</span>
              {t.key === "whatif" && planActive && <i className="tab-dot" />}
            </button>
          ))}
        </nav>
        <div className="panel">
          {tab === "route" && (
            <RoutePanel
              meta={meta} from={from} to={to} setFrom={setFrom} setTo={setTo} routes={routes}
              selectedMode={selectedMode} setSelectedMode={setSelectedMode} pickMode={pickMode} setPickMode={setPickMode}
              planActive={!!planKey} stepFree={stepFree} setStepFree={setStepFree}
            />
          )}
          {tab === "console" && <ConsolePanel meta={meta} state={state} scenario={scenario} />}
          {tab === "whatif" && (
            <WhatIfPanel
              meta={meta} draft={draft} setDraft={setDraft} undo={undo} canUndo={history.length > 0}
              tool={tool} setTool={setTool} treeSize={treeSize} setTreeSize={setTreeSize}
              res={planActive ? whatif : null} busy={whatifBusy} scenario={scenario} minutes={minutes}
              onShowRoutes={() => { setTab("route"); setTool(null); }}
            />
          )}
          {tab === "brief" && (
            <BriefPanel
              meta={meta} scenario={scenario} minutes={minutes} office={to}
              onShowRoute={(a) => {
                if (a.from) setFrom(a.from);
                if (a.to) setTo(a.to);
                if (a.mode) setSelectedMode(a.mode);
                setMinutes(a.minutes);
                setMarked(null);
                setTab("route");
              }}
              onAnswer={(a) => {
                setMinutes(a.minutes);
                // show the layer the answer is about: crowding for crowd questions, shade for heat
                if (a.type === "crowd" || a.type === "hotspots") {
                  setToggles((t) => ({ ...t, network: a.type === "crowd" ? "crowd" : "shade" }));
                }
                setMarked(a.streets?.length ? { kind: a.type, scenario, minutes: a.minutes, streets: a.streets } : null);
              }}
            />
          )}
          {tab === "impact" && <ImpactPanel onShow={(sc, m) => { setScenario(sc); setMinutes(m); setTab("route"); }} />}
          {tab === "limits" && <LimitsPanel />}
        </div>
        <footer className="side-foot">
          <span>{meta.stats.buildings.toLocaleString()} buildings</span>
          <span>{meta.stats.trees.toLocaleString()} trees</span>
          <span>{meta.stats.network_km} km paths</span>
          <span className="ok"><ShieldCheck size={12} /> no cloud AI</span>
        </footer>
      </aside>

      <LayerBar toggles={toggles} setToggles={setToggles} />
      {planActive && (
        <div className="plan-banner glass">
          <Sprout size={15} />
          <span><b>What-if plan</b> · {draft.items.length} change{draft.items.length > 1 ? "s" : ""}</span>
          <span className="est">Model estimate</span>
          <div className="seg mini">
            <button className={!showAfter ? "on" : ""} onClick={() => setShowAfter(false)}><EyeOff size={13} /> Before</button>
            <button className={showAfter ? "on" : ""} onClick={() => setShowAfter(true)}><Eye size={13} /> After</button>
          </div>
        </div>
      )}
      {shownMarks && (
        <div className={`ask-banner glass${planActive ? " below-plan" : ""}`}>
          <MessageSquareText size={15} />
          {shownMarks.kind === "crowd" ? (
            <span><b>Ask Lumen</b> · {fmtTime(shownMarks.minutes)} · <i className="mk busy" /> busiest <i className="mk quiet" /> quietest</span>
          ) : (
            <span><b>Ask Lumen</b> · {fmtTime(shownMarks.minutes)} · <i className="mk hot" /> most walked in the sun</span>
          )}
          <button className="icon-btn" onClick={() => setMarked(null)} title="Clear"><X size={14} /></button>
        </div>
      )}
      {pickMode && (
        <div className="hint-pill"><MousePointerClick size={15} /> Click the map to set {pickMode === "from" ? "the start" : "the destination"} <button onClick={() => setPickMode(null)}>Cancel</button></div>
      )}
      {editing && (
        <div className="hint-pill edit">
          <MousePointerClick size={15} /> {TOOL_INFO[tool].hint(treeSize)} <kbd>Esc</kbd> <button onClick={() => setTool(null)}>Done</button>
        </div>
      )}
      <TimeBar
        scenarios={meta.scenarios} scenario={scenario} setScenario={setScenario}
        minutes={minutes} setMinutes={setMinutes} state={state} loading={loading}
      />
      {showPhone && <PhoneModal meta={meta} onClose={() => setShowPhone(false)} />}
    </div>
  );
}

function LayerBar({ toggles, setToggles }: { toggles: LayerToggles; setToggles: (t: LayerToggles) => void }) {
  const set = (k: keyof LayerToggles, v: LayerToggles[keyof LayerToggles]) => setToggles({ ...toggles, [k]: v });
  const chips: { k: "shadows" | "trees" | "nodes" | "poles" | "stops" | "access" | "buildings3d"; label: string }[] = [
    { k: "shadows", label: "Shadows" }, { k: "trees", label: "Canopy" }, { k: "nodes", label: "Nodes" },
    { k: "poles", label: "Poles" }, { k: "stops", label: "Stops" }, { k: "access", label: "Access" }, { k: "buildings3d", label: "3D" },
  ];
  return (
    <div className="layerbar glass">
      <div className="lb-row">
        <Layers size={15} className="muted-ic" />
        <div className="seg">
          {(["shade", "crowd", "comfort", "off"] as const).map((k) => (
            <button key={k} className={toggles.network === k ? "on" : ""} onClick={() => set("network", k)}>
              {k === "shade" ? "Shade" : k === "crowd" ? "Crowding" : k === "comfort" ? "Comfort" : "Off"}
            </button>
          ))}
        </div>
        <div className="chips">
          {chips.map((c) => (
            <button key={c.k} className={`chip-t ${toggles[c.k] ? "on" : ""}`} onClick={() => set(c.k, !toggles[c.k])}>{c.label}</button>
          ))}
        </div>
      </div>
      <Legend mode={toggles.network} />
      {toggles.access && <AccessLegend />}
    </div>
  );
}

function AccessLegend() {
  return (
    <div className="legend acc">
      {ACCESS_LEGEND.map((l) => (
        <span key={l.key}><img src={badgeUrl(l.key)} alt="" width={15} height={15} />{l.label}</span>
      ))}
      <small>OpenStreetMap · zoom in for crossings and kerb ramps</small>
    </div>
  );
}

function Legend({ mode }: { mode: LayerToggles["network"] }) {
  if (mode === "shade")
    return (
      <div className="legend">
        <span>in sun</span><div className="grad shade" /><span>shaded side</span>
      </div>
    );
  if (mode === "comfort")
    return (
      <div className="legend">
        <span>0</span><div className="grad comfort" /><span>100 Comfort Score</span>
      </div>
    );
  if (mode === "crowd")
    return (
      <div className="legend los">
        {["A", "B", "C", "D", "E", "F"].map((l, i) => (
          <span key={l} style={{ background: ["#10b981", "#84cc16", "#eab308", "#f97316", "#ef4444", "#9f1239"][i] }}>{l}</span>
        ))}
        <small>Fruin level of service, peak minute</small>
      </div>
    );
  return null;
}

function PhoneModal({ meta, onClose }: { meta: Meta; onClose: () => void }) {
  const [qr, setQr] = useState("");
  const [role, setRole] = useState("");
  const url = `${meta.lan_url}/m${role ? `?role=${role}` : ""}`;
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: "#0b1324", light: "#ffffff" } }).then(setQr).catch(() => setQr(""));
  }, [url]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-x" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <h2>Lumen on your phone</h2>
        <p className="lede">Scan with your phone camera. No app, no login: pick a role and a couple of places. Settings stay on the phone.</p>
        <div className="seg wide">
          {[["", "Any role"], ["commuter", "Office worker"], ["driver", "Driver"], ["merchant", "Shop owner"]].map(([k, l]) => (
            <button key={k} className={role === k ? "on" : ""} onClick={() => setRole(k)}>{l}</button>
          ))}
        </div>
        <div className="qr">{qr ? <img src={qr} alt="QR code for the phone app" /> : <div className="qr-ph" />}</div>
        <a className="qr-url" href={`/m${role ? `?role=${role}` : ""}`} target="_blank" rel="noreferrer">{url}</a>
        <p className="fine">This QR code is what goes on café tables and light poles. Drivers can also text JOIN (SMS, simulated in the demo).</p>
      </div>
    </div>
  );
}

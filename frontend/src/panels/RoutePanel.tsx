import { Accessibility, ArrowDownUp, CircleCheck, Crosshair, Footprints, Sparkles, Sprout, Sun, TreeDeciduous, TriangleAlert, Users } from "lucide-react";
import { LOS, LOS_COLORS, MODE_COLORS, placeName, type Meta, type Route, type RouteResponse, type Stop } from "../api";

type Props = {
  meta: Meta;
  from: string;
  to: string;
  setFrom: (s: string) => void;
  setTo: (s: string) => void;
  routes: RouteResponse | null;
  selectedMode: string;
  setSelectedMode: (m: string) => void;
  pickMode: "from" | "to" | null;
  setPickMode: (m: "from" | "to" | null) => void;
  planActive: boolean;
  stepFree: boolean;
  setStepFree: (on: boolean) => void;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const flights = (n: number) => plural(n, "flight", "flights") + " of steps";

/** Tram stops without a level-access platform, and where to board step-free instead on the same route. */
function stopWarnings(meta: Meta, refs: string[]) {
  const out: { stop: Stop; alt: Stop | null }[] = [];
  for (const ref of refs) {
    const s = meta.stops.find((x) => x.id === ref);
    if (!s || s.kind !== "tram" || s.access?.wheelchair !== "no") continue;
    const routes = s.access.routes ?? [];
    const alts = meta.stops.filter((x) => x.kind === "tram" && x.access?.wheelchair === "yes" && (x.access.routes ?? []).some((r) => routes.includes(r)));
    const d = (x: Stop) => (x.lon - s.lon) ** 2 + (x.lat - s.lat) ** 2;
    out.push({ stop: s, alt: alts.sort((a, b) => d(a) - d(b))[0] ?? null });
  }
  return out;
}

const MAIN_STOPS = [
  "train-richmond",
  "train-east-richmond",
  "tram-swan-street-shopping-centre",
  "tram-lennox-street",
  "tram-east-richmond-station-church-street",
  "tram-balmain-street",
  "tram-adelaide-street",
  "tram-howard-street",
];

export default function RoutePanel(p: Props) {
  const stops = p.meta.stops.filter((s) => MAIN_STOPS.includes(s.id));
  const named = p.meta.offices.filter((o) => o.name);
  const others = p.meta.offices.filter((o) => !o.name);
  const sel = p.routes?.routes.find((r) => r.mode === p.selectedMode);

  const placeSelect = (value: string, set: (s: string) => void, which: "from" | "to") => {
    const custom = value.includes(",");
    return (
      <div className="place">
        <span className={`pin ${which}`}>{which === "from" ? "A" : "B"}</span>
        <select value={custom ? "__pin" : value} onChange={(e) => set(e.target.value)}>
          {custom && <option value="__pin">Dropped pin</option>}
          <optgroup label="Stations & tram stops">
            {stops.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </optgroup>
          <optgroup label="Named workplaces">
            {named.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </optgroup>
          <optgroup label="Other workplaces (3+ floors)">
            {others.map((o) => (
              <option key={o.id} value={o.id}>{o.street ? `${o.street} building` : `Building ${o.id.slice(1)}`} · {o.levels} fl</option>
            ))}
          </optgroup>
        </select>
        <button className={`icon-only ${p.pickMode === which ? "on" : ""}`} onClick={() => p.setPickMode(p.pickMode === which ? null : which)} title="Pick on map">
          <Crosshair size={16} />
        </button>
      </div>
    );
  };

  return (
    <div className="route-panel">
      <p className="lede">Shade Router finds the shortest, coolest and least crowded walk. Every number comes from the shadow and crowd models for the time on the slider.</p>
      <div className="places card-s">
        {placeSelect(p.from, p.setFrom, "from")}
        <button className="swap" onClick={() => { const f = p.from; p.setFrom(p.to); p.setTo(f); }} aria-label="Swap"><ArrowDownUp size={13} /></button>
        {placeSelect(p.to, p.setTo, "to")}
      </div>

      <button className={`sf-toggle ${p.stepFree ? "on" : ""}`} role="switch" aria-checked={p.stepFree} onClick={() => p.setStepFree(!p.stepFree)}>
        <span className="sf-ic"><Accessibility size={17} /></span>
        <span className="sf-t">
          <b>Step-free</b>
          <small>Avoid steps and raised kerbs, prefer signalised crossings. For wheelchairs, prams and walking frames</small>
        </span>
        <span className="switch" aria-hidden="true"><i /></span>
      </button>
      {p.stepFree && <AccessNotes {...p} sel={sel} />}
      {!p.stepFree && sel && !sel.access.step_free && (
        <div className="note warn acc-note">
          <TriangleAlert size={14} />
          <span>This route has {flights(sel.access.steps)}{sel.access.kerbs ? ` and ${plural(sel.access.kerbs, "raised kerb")}` : ""}, marked on the map.</span>
          <button className="txt-btn" onClick={() => p.setStepFree(true)}>Go step-free</button>
        </div>
      )}

      {p.routes && (
        <>
          <div className="route-meta">
            <span>{p.routes.time} · {p.routes.temp_c}°C</span>
            <span className={p.routes.heat_factor > 0 ? "pill warn" : "pill"}>
              {p.routes.heat_factor > 0 ? <>shade weighted ×{p.routes.heat_factor}</> : <>below 24°C: shade not weighted</>}
            </span>
            {p.planActive && <span className="pill good"><Sprout size={11} /> with what-if plan</span>}
          </div>
          <div className="cards">
            {p.routes.routes.map((r) => (
              <RouteCard key={r.mode} r={r} on={r.mode === p.selectedMode} onClick={() => p.setSelectedMode(r.mode)} stepFree={p.stepFree} />
            ))}
          </div>
        </>
      )}

      {sel && (
        <div className="steps">
          <div className="steps-h">
            <b>{sel.label} route</b>
            <span>{placeName(p.meta, p.from)} → {placeName(p.meta, p.to)}</span>
          </div>
          {sel.note && <p className="note">{sel.note}</p>}
          <ol>
            {sel.steps.map((s, i) => (
              <li key={i}>
                <span className="st">{s.street === "laneway" ? "Laneway" : s.street}</span>
                <span className="len">{s.length_m} m</span>
                <span className="bar" title={`${s.shaded_pct}% shaded`}>
                  <i style={{ width: `${s.shaded_pct}%` }} />
                </span>
                <span className="los" style={{ background: LOS_COLORS[LOS.indexOf(s.los)] }}>{s.los}</span>
                {s.shady_side && <span className="tip"><TreeDeciduous size={12} /> keep to the {s.shady_side} side</span>}
              </li>
            ))}
          </ol>
          <p className="fine">Bar = share of the segment in shade on its shadier side. Letter = worst footpath level of service.</p>
          {p.stepFree && (
            <p className="fine">
              Crossings: {sel.access.signal_crossings} with signals, {sel.access.unmarked_crossings} without
              {sel.access.rough_m > 0 && <> · {sel.access.rough_m} m of rough surface</>}. From OpenStreetMap, which doesn't record every kerb.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function AccessNotes(p: Props & { sel: Route | undefined }) {
  const vs = p.routes?.step_free ? p.routes.step_free_vs : undefined;
  const warn = stopWarnings(p.meta, [p.from, p.to]);
  const avoided = vs ? vs.avoided_steps + vs.avoided_kerbs : 0;
  return (
    <>
      {vs && !vs.possible && p.sel && (
        <div className="note warn acc-note">
          <TriangleAlert size={14} />
          <span>No fully step-free way found. This route still has {flights(p.sel.access.steps)}{p.sel.access.kerbs ? ` and ${plural(p.sel.access.kerbs, "raised kerb")}` : ""}, marked on the map.</span>
        </div>
      )}
      {vs && vs.possible && (
        <div className="note good acc-note">
          <CircleCheck size={14} />
          {avoided > 0 ? (
            <span>
              Avoids {vs.avoided_steps ? flights(vs.avoided_steps) : ""}{vs.avoided_steps && vs.avoided_kerbs ? " and " : ""}
              {vs.avoided_kerbs ? plural(vs.avoided_kerbs, "raised kerb") : ""} for {vs.extra_min > 0 ? `+${vs.extra_min.toFixed(1)} min` : "no extra time"}.
            </span>
          ) : (
            <span>No steps on this walk: the usual route is already step-free.</span>
          )}
        </div>
      )}
      {warn.map(({ stop, alt }) => (
        <div key={stop.id} className="note warn acc-note">
          <Accessibility size={14} />
          <span>
            <b>{stop.name.replace(" (tram)", "")}</b> tram stop has no level-access platform.{" "}
            {alt ? (
              <>Nearest level-access stop on Route {(alt.access.routes ?? []).join(", ")}: <b>{alt.name.replace(" (tram)", "")}</b>.</>
            ) : (
              <>There's no level-access stop on Route {(stop.access.routes ?? []).join(", ")} nearby.</>
            )}
          </span>
          {alt && (
            <button className="txt-btn" onClick={() => (stop.id === p.from ? p.setFrom(alt.id) : p.setTo(alt.id))}>
              Use it
            </button>
          )}
        </div>
      ))}
    </>
  );
}

function RouteCard({ r, on, onClick, stepFree }: { r: Route; on: boolean; onClick: () => void; stepFree: boolean }) {
  const v = r.vs_shortest;
  const isBase = r.mode === "shortest";
  return (
    <button className={`rcard ${on ? "on" : ""}`} onClick={onClick} style={{ ["--c" as string]: MODE_COLORS[r.mode] }}>
      <div className="rcard-h">
        <span className="swatch" />
        {r.label}
      </div>
      <div className="big">{r.minutes.toFixed(1)}<small> min</small></div>
      <div className="kv"><span><Sun size={12} /> sun</span><b>{r.sun_minutes.toFixed(1)}</b></div>
      <div className="kv"><span><Users size={12} /> crowd</span><b>{r.crowded_minutes.toFixed(1)}</b></div>
      <div className="kv"><span><Footprints size={12} /> shade</span><b>{r.shaded_pct}%</b></div>
      <div className="kv"><span><Sparkles size={12} /> comfort</span><b>{r.comfort}</b></div>
      {!isBase && (
        <div className="deltas">
          {r.same_as_shortest ? (
            <span className="chip muted">same as shortest</span>
          ) : (
            <>
              <span className="chip">+{Math.max(0, v.extra_min).toFixed(1)} min</span>
              {v.sun_min_saved > 0.05 && <span className="chip good">−{v.sun_min_saved.toFixed(1)} sun</span>}
              {v.crowd_min_saved > 0.05 && <span className="chip good">−{v.crowd_min_saved.toFixed(1)} crowd</span>}
            </>
          )}
        </div>
      )}
      {!r.access.step_free ? (
        <span className="acc-chip warn" title={[r.access.steps && flights(r.access.steps), r.access.kerbs && plural(r.access.kerbs, "raised kerb"), r.access.blocked && plural(r.access.blocked, "path", "paths") + " not wheelchair-accessible"].filter(Boolean).join(", ")}>
          <TriangleAlert size={11} /> {r.access.steps ? "has steps" : "not step-free"}
        </span>
      ) : stepFree ? (
        <span className="acc-chip ok"><Accessibility size={11} /> step-free</span>
      ) : null}
    </button>
  );
}

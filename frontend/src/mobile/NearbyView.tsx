import { useEffect, useRef, useState } from "react";
import {
  Armchair, Banknote, Briefcase, Clock, Coffee, Croissant, Droplet, Dumbbell, ExternalLink, Footprints, Hourglass, LogIn, LogOut, MapPinned, Minus,
  MoonStar, Navigation2, Pill, Plus, RotateCcw, ShoppingBasket, Store, Sun, Toilet, TrainFront, TreeDeciduous, Trees, Users, UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import { fmtTime, get, MODE_COLORS, type Meta, type NearbyChip, type NearbyPlace, type NearbyResponse, type NearbyWalk, type Route } from "../api";
import { AccessNote, barrierMarks, StepFreeSwitch } from "./access";
import { Offline } from "./CommuterHome";
import MiniMap, { type Pin } from "./MiniMap";
import type { Settings } from "./MobileApp";
import WalkView from "./WalkView";
import { loadPref, PREFS, savePref, type Pref } from "./routePref";

export type Trip = "back" | "in" | "home";
/** focus: a place to pick out of the results (opened from "On your way" on the Today card) */
export type NearbyPreset = { want: string; budget?: number; trip?: Trip; t?: number; focus?: string };

// budget = the starting time budget when you pick the category; trip = the trip it usually is
export const CATS: Record<string, { icon: LucideIcon; color: string; short: string; budget: number; trip?: Trip; indie?: boolean }> = {
  coffee: { icon: Coffee, color: "#b45309", short: "Coffee", budget: 15 },
  bite: { icon: Croissant, color: "#ea580c", short: "Quick bite", budget: 15 },
  lunch: { icon: UtensilsCrossed, color: "#db2777", short: "Lunch", budget: 45 },
  rest: { icon: Trees, color: "#0d9488", short: "Shady rest", budget: 20 },
  local: { icon: Store, color: "#c026d3", short: "Local shops", budget: 20, indie: true },
  fitness: { icon: Dumbbell, color: "#4f46e5", short: "Gym & class", budget: 90, trip: "home", indie: true },
  groceries: { icon: ShoppingBasket, color: "#7c3aed", short: "Groceries", budget: 15 },
  pharmacy: { icon: Pill, color: "#e11d48", short: "Pharmacy", budget: 20 },
  cash: { icon: Banknote, color: "#059669", short: "Cash", budget: 15 },
  toilets: { icon: Toilet, color: "#2563eb", short: "Toilets", budget: 30 },
  water: { icon: Droplet, color: "#0284c7", short: "Water", budget: 20 },
};
const TRIPS: { key: Trip; label: string; icon: LucideIcon }[] = [
  { key: "back", label: "Back to desk", icon: RotateCcw },
  { key: "in", label: "On my way in", icon: LogIn },
  { key: "home", label: "Heading home", icon: LogOut },
];
const STEPS = [5, 10, 15, 20, 25, 30, 45, 60, 90];
const CHIP_ICON: Record<NearbyChip["k"], LucideIcon> = {
  open: Clock, unknown: Clock, shade: TreeDeciduous, sun: Sun, seat: Armchair, warn: MoonStar, queue: Hourglass, quiet: Users, busy: Users,
};
const KEY = "lumen.phone.nearby";

const toMin = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + (m || 0);
};
const hhmm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Website";
  }
};
const n1 = (x: number) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : x.toFixed(1));

function defaultTime(trip: Trip, s: Settings) {
  if (trip === "in") return Math.max(360, toMin(s.arrive) - 25);
  if (trip === "home") return 1050;
  return 750;
}
function load(): { want: string; budget: number; trip: Trip } | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    return v && CATS[v.want] ? v : null;
  } catch {
    return null;
  }
}
function store(v: { want: string; budget: number; trip: Trip }) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private mode: remembered for this visit only */
  }
}

export default function NearbyView({ meta, s, scenario, preset, onStepFree }: {
  meta: Meta; s: Settings; scenario: string; preset: NearbyPreset | null; onStepFree: (on: boolean) => void;
}) {
  const saved = load();
  const [want, setWant] = useState(preset?.want ?? saved?.want ?? "coffee");
  const [budget, setBudget] = useState(preset?.budget ?? saved?.budget ?? CATS[want].budget);
  const [trip, setTrip] = useState<Trip>(preset?.trip ?? saved?.trip ?? "back");
  const [t, setT] = useState(preset?.t ?? defaultTime(preset?.trip ?? saved?.trip ?? "back", s));
  const [data, setData] = useState<NearbyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [tick, setTick] = useState(0);
  const [sel, setSel] = useState(0);
  const [focus, setFocus] = useState(preset?.focus);
  const [walk, setWalk] = useState<{ data: NearbyResponse; place: NearbyPlace; trip: Trip } | null>(null);
  const req = useRef(0);
  const stepFree = !!s.stepFree;

  useEffect(() => {
    if (!preset) return;
    setWant(preset.want);
    setBudget(preset.budget ?? CATS[preset.want].budget);
    if (preset.trip) setTrip(preset.trip);
    setT(preset.t ?? defaultTime(preset.trip ?? trip, s));
    setFocus(preset.focus);
    setWalk(null);
  }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => store({ want, budget, trip }), [want, budget, trip]);

  useEffect(() => {
    const id = ++req.current;
    setBusy(true);
    setErr(false);
    const q = new URLSearchParams({ want, budget: String(budget), t: String(t), scenario });
    if (stepFree) q.set("step_free", "true");
    if (focus) q.set("focus", focus);
    if (trip === "back") q.set("from", s.office);
    else {
      q.set("shape", "via");
      q.set("from", trip === "in" ? s.stop : s.office);
      q.set("to", trip === "in" ? s.office : s.stop);
    }
    // a short pause so tapping + three times sends one request, not three
    const timer = setTimeout(() => {
      get<NearbyResponse>(`/api/nearby?${q}`)
        .then((d) => {
          if (id !== req.current) return;
          setData(d);
          setSel(Math.max(0, focus ? d.results.findIndex((r) => r.id === focus) : 0));
        })
        .catch(() => id === req.current && setErr(true))
        .finally(() => id === req.current && setBusy(false));
    }, 160);
    return () => clearTimeout(timer);
  }, [want, budget, trip, t, scenario, s.office, s.stop, stepFree, tick, focus]);

  const cat = CATS[want];
  const counts = Object.fromEntries(meta.nearby?.map((c) => [c.key, c.count]) ?? []);
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? STEPS.find((x) => x > budget) : [...STEPS].reverse().find((x) => x < budget);
    if (next) setBudget(next);
  };
  const pickTrip = (k: Trip) => {
    setTrip(k);
    setT(defaultTime(k, s));
  };
  const pickWant = (k: string) => {
    setWant(k);
    setBudget(CATS[k].budget);
    setFocus(undefined);
    const tr = CATS[k].trip;
    if (tr && tr !== trip) pickTrip(tr);
  };
  // keep the chosen category in view when it arrives from a shortcut
  const onTile = (el: HTMLButtonElement | null) => {
    const row = el?.parentElement;
    if (el && row && (el.offsetLeft < row.scrollLeft || el.offsetLeft + el.offsetWidth > row.scrollLeft + row.clientWidth))
      row.scrollTo({ left: el.offsetLeft - 14, behavior: "smooth" });
  };

  if (walk) return <WalkView key={`${walk.place.id}-${walk.place.mode}`} {...walk} onClose={() => setWalk(null)} />;

  return (
    <div className="m-stack nb" style={{ ["--c" as string]: cat.color }}>
      <section className="nb-hero">
        <div className="nb-top">
          <span className="nb-kicker">Got a few minutes?</span>
          <label className="nb-time" title="Leaving at">
            <Clock size={13} /> {fmtTime(t)}
            <input type="time" value={hhmm(t)} step={300} aria-label="Leaving at"
              onClick={(e) => {
                try {
                  e.currentTarget.showPicker(); // desktop browsers otherwise only focus the hour field
                } catch {
                  /* older browsers open their own picker */
                }
              }}
              onChange={(e) => e.target.value && setT(toMin(e.target.value))} />
          </label>
        </div>
        <div className="nb-sentence">
          <span>I've got</span>
          <span className="nb-budget">
            <button aria-label="Less time" onClick={() => step(-1)} disabled={budget <= STEPS[0]}><Minus size={16} /></button>
            <b key={budget}>{budget}</b>
            <i>min</i>
            <button aria-label="More time" onClick={() => step(1)} disabled={budget >= STEPS[STEPS.length - 1]}><Plus size={16} /></button>
          </span>
          <span>for</span>
        </div>
        <div className="nb-cats" role="radiogroup" aria-label="What do you need?">
          {Object.entries(CATS).map(([k, c]) => {
            const Icon = c.icon;
            return (
              <button key={k} role="radio" aria-checked={want === k} className={want === k ? "on" : ""}
                ref={want === k ? onTile : undefined} aria-label={c.short}
                style={{ ["--cc" as string]: c.color }} onClick={() => pickWant(k)}>
                <span className="nb-cat-ic"><Icon size={19} /></span>
                <b>{c.short}</b>
                {counts[k] !== undefined && <small>{counts[k]}</small>}
              </button>
            );
          })}
        </div>
        <div className="nb-trip" role="radiogroup" aria-label="Trip">
          {TRIPS.map(({ key, label, icon: Icon }) => (
            <button key={key} role="radio" aria-checked={trip === key} className={trip === key ? "on" : ""} onClick={() => pickTrip(key)}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        <StepFreeSwitch on={stepFree} onChange={onStepFree} dark />
      </section>

      {err && <Offline onRetry={() => setTick(tick + 1)} />}
      {!err && !data && <div className="sk sk-card" />}
      {!err && data && (
        <>
          {data.focus && !data.focus.fits && <FocusNote f={data.focus} budget={data.budget} onBudget={setBudget} onTime={setT} onClear={() => setFocus(undefined)} />}
          <Results data={data} sel={Math.min(sel, Math.max(0, data.results.length - 1))} setSel={setSel} busy={busy} trip={trip}
            focus={data.focus?.fits ? data.focus.id : undefined}
            onBudget={setBudget} onTime={setT} onWalk={(place) => setWalk({ data, place, trip })} onStepFree={onStepFree} />
        </>
      )}
    </div>
  );
}

/** The place you tapped on the Today card didn't make this list: say why, and offer the one change that fixes it. */
function FocusNote({ f, budget, onBudget, onTime, onClear }: {
  f: NonNullable<NearbyResponse["focus"]>; budget: number; onBudget: (b: number) => void; onTime: (t: number) => void; onClear: () => void;
}) {
  const fix = f.reason === "too_far" && f.need_min
    ? { text: `needs about ${f.need_min} min, more than ${budget}`, btn: `Make it ${STEPS.find((x) => x >= f.need_min!) ?? f.need_min} min`,
      go: () => onBudget(STEPS.find((x) => x >= f.need_min!) ?? f.need_min!) }
    : f.reason === "closed"
      ? { text: f.hours?.text?.toLowerCase() ?? "is closed then", btn: f.hours?.opens != null ? `Try ${fmtTime(f.hours.opens)}` : null,
        go: () => f.hours?.opens != null && onTime(f.hours.opens) }
      : f.reason === "not_step_free"
        ? { text: "is only reachable past steps or a raised kerb", btn: null, go: () => {} }
        : { text: "isn't on this trip", btn: null, go: () => {} };
  return (
    <section className="nb-focus" role="status">
      <span className="nb-focus-ic"><MapPinned size={16} /></span>
      <p><b>{f.name}</b> {fix.text}.</p>
      {fix.btn ? <button className="m-btn primary" onClick={fix.go}>{fix.btn}</button>
        : <button className="m-btn" onClick={onClear}>Show the best</button>}
    </section>
  );
}

function Results({ data, sel, setSel, busy, trip, focus, onBudget, onTime, onWalk, onStepFree }: {
  data: NearbyResponse; sel: number; setSel: (i: number) => void; busy: boolean; trip: Trip; focus?: string;
  onBudget: (b: number) => void; onTime: (t: number) => void; onWalk: (p: NearbyPlace) => void; onStepFree: (on: boolean) => void;
}) {
  const cat = CATS[data.want];
  const c = data.counts;
  const place = data.results[sel];
  const stay = data.kind === "stay";
  const bestRef = useRef<HTMLElement>(null);
  const [pref, setPrefState] = useState<Pref>(loadPref);
  const setPref = (p: Pref) => {
    setPrefState(p);
    savePref(p);
  };

  const sfSkipped = data.step_free && c.not_step_free > 0
    ? <p className="nb-sf-note">{c.not_step_free} {c.not_step_free === 1 ? data.noun : data.nouns} left out: only reachable past steps or a raised kerb.</p>
    : null;

  if (!place) {
    const allClosed = c.places > 0 && c.closed === c.places;
    return (
      <section className={`m-card nb-empty ${busy ? "busy" : ""}`}>
        <span className="nb-empty-ic">{allClosed ? <MoonStar size={22} /> : <Hourglass size={22} />}</span>
        {allClosed ? (
          <>
            <b>All {c.places} {data.nouns} are closed at {data.time}</b>
            <p>Most of Cremorne's cafés and lunch spots close mid-afternoon.</p>
            <button className="m-btn primary" onClick={() => onTime(trip === "home" ? 1020 : 600)}>Try {trip === "home" ? "5pm" : "10am"}</button>
          </>
        ) : data.need_min ? (
          <>
            <b>{data.budget} min is a little tight</b>
            <p>The closest {data.noun} needs about <b>{data.need_min} min</b> {trip === "back" ? "there and back" : "including the detour"}.</p>
            <button className="m-btn primary" onClick={() => onBudget(data.need_min!)}>Make it {data.need_min} min</button>
          </>
        ) : (
          <>
            <b>No {data.nouns} on Lumen's map yet</b>
            <p>Places come from OpenStreetMap. Missing one? Add it there and it shows up here.</p>
          </>
        )}
        {sfSkipped}
      </section>
    );
  }

  // the chosen way of walking it; "auto" (or a way that doesn't fit) is the pick Lumen ranked on
  const opt = pref !== "auto" ? place.options?.[pref] : undefined;
  const best: NearbyPlace = opt ? { ...place, ...opt } : place;
  const geoKey = (w: NearbyWalk) => JSON.stringify(w.geometry);
  const groups: { modes: Route["mode"][]; w: NearbyWalk }[] = [];
  for (const m of ["shortest", "coolest", "calmest"] as const) {
    const o = place.options?.[m];
    if (!o) continue;
    const g = groups.find((x) => geoKey(x.w) === geoKey(o));
    if (g) g.modes.push(m);
    else groups.push({ modes: [m], w: o });
  }

  const Icon = cat.icon;
  const pins: Pin[] = [
    ...data.results.map((r, i) => ({ r, i })).filter(({ i }) => i !== sel).map(({ r, i }) => ({
      coord: [r.lon, r.lat] as [number, number], label: String(i + 1), cls: "alt", title: r.name, color: cat.color, onClick: () => setSel(i),
    })),
    {
      coord: best.geometry.out[0] ?? [best.lon, best.lat], label: "A", cls: "from", title: data.from,
      icon: trip === "in" ? <TrainFront size={13} strokeWidth={2.5} /> : <Briefcase size={13} strokeWidth={2.5} />,
    },
    ...(data.shape === "via" && best.geometry.back?.length
      ? [{
        coord: best.geometry.back[best.geometry.back.length - 1], label: "B", cls: "to", title: data.to ?? "",
        icon: trip === "in" ? <Briefcase size={13} strokeWidth={2.5} /> : <TrainFront size={13} strokeWidth={2.5} />,
      }] : []),
    { coord: [best.lon, best.lat], label: "", cls: "place", title: best.name, color: cat.color, icon: <Icon size={18} strokeWidth={2.4} /> },
  ];
  // other ways sit faded underneath and can be tapped; lineMode says which way each line belongs to
  const lines: { coords: [number, number][]; color: string; dashed?: boolean; muted?: boolean }[] = [];
  const lineMode: Route["mode"][] = [];
  const addWay = (w: NearbyWalk, mode: Route["mode"], muted: boolean) => {
    const color = MODE_COLORS[muted ? mode : best.mode];
    for (const [coords, dashed] of [[w.geometry.out, false], [w.geometry.back ?? [], true]] as const) {
      if (coords.length < 2) continue;
      lines.push({ coords, color, dashed, muted });
      lineMode.push(mode);
    }
  };
  for (const g of groups) if (geoKey(g.w) !== geoKey(best)) addWay(g.w, g.modes[0], true);
  addWay(best, best.mode, false);
  const autoLabel = PREFS.find((x) => x.key === place.mode)!.label.toLowerCase();
  const headline = stay
    ? { lbl: "You can sit for", big: `${Math.floor(best.dwell)} min`, sub: `back by ${best.back_at}` }
    : trip === "back"
      ? { lbl: "Back at your desk by", big: best.back_at, sub: null }
      : { lbl: `At ${data.to?.replace(" Station", "")} by`, big: best.back_at, sub: null };

  return (
    <div className={`nb-results ${busy ? "busy" : ""}`}>
      <p className="nb-count">
        <b>{c.fit}</b> of {c.places} {data.nouns} fit{data.step_free ? " step-free" : ""} · {data.time}{data.hot ? `, ${Math.round(data.temp_c)}°C` : ""}
      </p>

      <section className="m-card nb-best" key={best.id} ref={bestRef}>
        <div className="nb-head">
          <span className="nb-av"><Icon size={20} /></span>
          <div className="nb-title">
            <b>{best.name}</b>
            <small>{best.type} · {best.address}</small>
          </div>
          {best.id === focus ? <span className="nb-badge">On your way</span> : sel === 0 && <span className="nb-badge">Best pick</span>}
        </div>
        {(cat.indie || best.blurb || best.website) && (
          <div className="nb-local">
            {cat.indie && <span className="nb-indie">Independent</span>}
            {best.blurb && <p>{best.blurb}</p>}
            {best.website && (
              <a href={best.website} target="_blank" rel="noreferrer noopener">
                {host(best.website)} <ExternalLink size={11} />
              </a>
            )}
          </div>
        )}

        <div className="nb-hl">
          <div>
            <small>{headline.lbl}</small>
            <strong>{headline.big}</strong>
            {headline.sub && <small className="nb-hl-sub">{headline.sub}</small>}
          </div>
          {stay && best.spot && data.hot ? (
            <ShadeTag spot={best.spot} />
          ) : !stay ? (
            <span className={`nb-spare ${best.spare < 1 ? "tight" : ""}`}><Hourglass size={13} /> {best.spare < 1 ? "Just fits" : `${n1(best.spare)} min spare`}</span>
          ) : null}
        </div>

        <BudgetBar p={best} budget={data.budget} stay={stay} verb={data.verb} trip={trip} />

        <div className="pref nb-pref" role="radiogroup" aria-label="Which way to walk">
          {PREFS.map(({ key, label, icon: PI }) => {
            const o = key === "auto" ? place : place.options?.[key];
            const c = key === "auto" ? "var(--ink)" : MODE_COLORS[key];
            return (
              <button key={key} role="radio" aria-checked={pref === key} className={pref === key ? "on" : ""} disabled={!o}
                title={o ? undefined : `The ${label.toLowerCase()} way doesn't fit in ${data.budget} min`}
                style={{ ["--c" as string]: c }} onClick={() => setPref(key)}>
                <span className="pref-ic"><PI size={15} /></span>
                <b>{label}</b>
                <small>{o ? `${n1(o.walk)} min` : "too long"}</small>
              </button>
            );
          })}
        </div>
        <p className="pref-note">
          {groups.length <= 1
            ? <>Every way here is the same walk.</>
            : pref === "auto" || !opt
              ? <>Weighs sun, crowds and walking time. Here that's the <b style={{ color: MODE_COLORS[place.mode] }}>{autoLabel}</b> way. Tap a faded line to compare.</>
              : <>Tap a faded line on the map to compare.</>}
        </p>

        <MiniMap lines={lines} pins={pins} marks={barrierMarks(best.access?.barriers ?? [])} height={196} onPick={groups.length > 1 ? (i) => {
          const m = lineMode[i];
          if (m && m !== best.mode) setPref(m);
        } : undefined} />
        {best.access && <AccessNote access={best.access} stepFree={data.step_free} onStepFree={onStepFree} />}

        {best.chips.length > 0 && (
          <div className="nb-chips">
            {best.chips.map((ch, i) => {
              const CI = CHIP_ICON[ch.k];
              return <span key={i} className={`nb-chip ${ch.k}`}><CI size={12} /> {ch.t}</span>;
            })}
          </div>
        )}
        <p className="nb-route">
          <Footprints size={13} />
          <span>
            <b style={{ color: MODE_COLORS[best.mode] }}>{best.route_label}</b> way
            {data.hot && best.walk > 1 ? ` · ${best.shaded_pct}% of the walk in shade` : ""}
            {best.detour !== null ? ` · ${best.detour > 0.05 ? `+${n1(best.detour)} min` : "no extra walking"} vs going straight` : ""}
          </span>
        </p>
        <button className="m-btn primary nb-go" onClick={() => onWalk(best)}>
          <Navigation2 size={16} fill="currentColor" /> Start walk
        </button>
      </section>

      {data.results.length > 1 && (
        <section className="m-card nb-list">
          <h4>Also fits</h4>
          {data.results.map((r, i) => i === sel ? null : (
            <button key={r.id} className="nb-row" onClick={() => {
              setSel(i);
              bestRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}>
              <span className="nb-rank">{i + 1}</span>
              <span className="nb-row-main">
                <b>{r.name}</b>
                <small>
                  {r.spot && data.hot ? shade(r.spot).text : r.hours.state === "assumed_open" ? "Hours not listed" : r.hours.text ?? r.type}
                  {" · "}{n1(r.walk_out)} min away
                </small>
                <MiniBar p={r} budget={data.budget} stay={stay} />
              </span>
              <span className="nb-row-end">
                {stay ? <><b>{Math.floor(r.dwell)}</b><small>min sit</small></> : <><b>{n1(r.spare)}</b><small>min spare</small></>}
              </span>
            </button>
          ))}
        </section>
      )}

      {sfSkipped}

      <p className="m-fine">
        {data.note} Walks use Lumen's shade and crowd models; you're routed the most comfortable way that still fits.
      </p>
    </div>
  );
}

/** How shady a rest spot is: covered, a park's shaded area, or the share of time a seat is in shade. */
function shade(spot: NonNullable<NearbyPlace["spot"]>) {
  const ok = spot.shade_ok;
  const text = spot.covered ? "Covered" : spot.park ? (ok ? `~${spot.shade_m2?.toLocaleString()} m² of shade` : "Little shade")
    : `${spot.shade_pct}% shade`;
  return { ok, text };
}
function ShadeTag({ spot }: { spot: NonNullable<NearbyPlace["spot"]> }) {
  const { ok, text } = shade(spot);
  return <span className={`nb-spare ${ok ? "" : "warm"}`}><TreeDeciduous size={13} /> {text}</span>;
}

/** The time budget as one bar: walk there, time there, walk back or on, and what's left over. */
function BudgetBar({ p, budget, stay, verb, trip }: { p: NearbyPlace; budget: number; stay: boolean; verb: string; trip: Trip }) {
  const segs = [
    { k: "out", v: p.walk_out, label: "Walk" },
    { k: "there", v: p.dwell, label: stay ? "Sit" : verb ? `${verb[0].toUpperCase()}${verb.slice(1)}` : "There" },
    ...(p.walk_back > 0 ? [{ k: "back", v: p.walk_back, label: trip === "back" ? "Back" : "Walk on" }] : []),
    ...(p.spare >= 0.1 ? [{ k: "spare", v: p.spare, label: "Spare" }] : []),
  ];
  const total = Math.max(budget, segs.reduce((a, x) => a + x.v, 0));
  return (
    <div className="nb-bar-wrap">
      <div className="nb-bar" role="img" aria-label={segs.map((x) => `${x.label} ${n1(x.v)} min`).join(", ")}>
        {segs.map((x, i) => (
          <i key={x.k} className={x.k} style={{ flexGrow: x.v / total, animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
      <div className="nb-legend">
        {segs.map((x) => (
          <span key={x.k}><i className={x.k} />{x.label} <b>{x.k === "there" && !stay ? "~" : ""}{n1(x.v)}</b></span>
        ))}
        <span className="nb-legend-total">of {budget} min</span>
      </div>
    </div>
  );
}

function MiniBar({ p, budget, stay }: { p: NearbyPlace; budget: number; stay: boolean }) {
  const total = Math.max(budget, p.total);
  return (
    <span className="nb-minibar" aria-hidden>
      <i className="out" style={{ flexGrow: p.walk_out / total }} />
      <i className="there" style={{ flexGrow: p.dwell / total }} />
      {p.walk_back > 0 && <i className="back" style={{ flexGrow: p.walk_back / total }} />}
      {!stay && p.spare > 0 && <i className="spare" style={{ flexGrow: p.spare / total }} />}
    </span>
  );
}

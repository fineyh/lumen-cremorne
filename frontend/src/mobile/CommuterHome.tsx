import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Clock, Compass, Footprints, MapPin, Navigation2, RotateCw, Sun, Thermometer, TreeDeciduous, Users, Utensils, CalendarClock, WifiOff } from "lucide-react";
import { fmtTime, get, LOS, LOS_COLORS, MODE_COLORS, type CommuterHome as Home, type Meta, type OnTheWay, type Route, type StepFreeVs } from "../api";
import { AccessNote, barrierMarks, barrierText, StepFreeSwitch, StopNotes } from "./access";
import MiniMap from "./MiniMap";
import RouteWalk from "./RouteWalk";
import type { Settings } from "./MobileApp";
import { CATS, type NearbyPreset } from "./NearbyView";
import { loadPref, PREFS, savePref, type Pref } from "./routePref";

// shortcuts into Nearby: a coffee on the way in, then the classic between-meetings trips
const POP: (NearbyPreset & { label: string })[] = [
  { want: "coffee", budget: 20, trip: "in", label: "Coffee on the way" },
  { want: "bite", budget: 15, trip: "back", t: 750, label: "Quick bite" },
  { want: "rest", budget: 20, trip: "back", t: 750, label: "Shady break" },
  { want: "local", budget: 20, trip: "back", t: 750, label: "Browse local" },
  { want: "fitness", budget: 90, trip: "home", label: "After-work class" },
];
const STEPS = [5, 10, 15, 20, 25, 30, 45, 60, 90];

type MeetingData = { to: string; to_id: string; time: string; temp_c: number; heat_matters: boolean; route: Route; shortest: Route; step_free_vs: StepFreeVs | null };

export default function CommuterHome({ meta, s, scenario, onNearby, onStepFree }: {
  meta: Meta; s: Settings; scenario: string; onNearby: (p: NearbyPreset) => void; onStepFree: (on: boolean) => void;
}) {
  const [home, setHome] = useState<Home | null>(null);
  const [meeting, setMeeting] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(false);
  const [tick, setTick] = useState(0);
  const [walking, setWalking] = useState<"commute" | "meeting" | null>(null);
  const [pref, setPrefState] = useState<Pref>(loadPref);
  const stepFree = !!s.stepFree;
  const setPref = (p: Pref) => {
    setPrefState(p);
    savePref(p);
  };

  useEffect(() => {
    setErr(false);
    const q = new URLSearchParams({ stop: s.stop, office: s.office, arrive: s.arrive, scenario });
    if (meeting) q.set("meeting", meeting);
    if (stepFree) q.set("step_free", "true");
    get<Home>(`/api/me/commuter?${q}`).then(setHome).catch(() => setErr(true));
  }, [s.stop, s.office, s.arrive, scenario, meeting, stepFree, tick]);

  if (err) return <Offline onRetry={() => setTick(tick + 1)} />;
  if (!home) return <Skeleton />;
  const t = home.today;
  const w = (pref !== "auto" && home.options?.[pref]) || t;
  const r = w.route;
  const v = w.vs_shortest;
  const lines = w === t ? t.lines : w.lines;
  const autoLabel = PREFS.find((p) => p.key === t.route.mode)!.label.toLowerCase();

  // one line per distinct path; the chosen one is drawn on top in its colour, the rest stay tappable underneath
  const same = (x: Route) => x.edges.join();
  const groups: { modes: Route["mode"][]; route: Route }[] = [];
  for (const m of ["shortest", "coolest", "calmest"] as const) {
    const o = home.options?.[m];
    if (!o) continue;
    const g = groups.find((x) => same(x.route) === same(o.route));
    if (g) g.modes.push(m);
    else groups.push({ modes: [m], route: o.route });
  }
  if (!groups.some((g) => same(g.route) === same(r))) groups.push({ modes: [r.mode], route: r });
  const mapLines = groups.map((g) => {
    const on = same(g.route) === same(r);
    return { coords: g.route.geometry.coordinates, color: MODE_COLORS[on ? r.mode : g.modes[0]], muted: !on };
  });
  const hot = home.scenario.heat_matters;
  const lunch = home.recommendations.find((x) => x.kind === "lunch");
  const meet = home.recommendations.find((x) => x.kind === "meeting");
  const md = meet?.data as MeetingData | undefined;
  const offices = meta.offices.filter((o) => o.name && /[A-Za-z]{3}/.test(o.name) && o.id !== s.office);

  if (walking === "commute")
    return <RouteWalk route={r} start={w.leave_minutes} from={home.from} to={home.to} hot={hot} stepFree={home.step_free} back="Today" onClose={() => setWalking(null)} />;
  if (walking === "meeting" && md)
    return <RouteWalk route={md.route} start={900} from="your building" to={md.to} hot={md.heat_matters} stepFree={home.step_free} back="Today" onClose={() => setWalking(null)} />;

  return (
    <div className="m-stack">
      <section className={`today ${hot ? "hot" : "mild"}`}>
        <div className="today-top">
          <span className="today-tag">Today's card</span>
          <span className="today-temp"><Thermometer size={13} /> {home.scenario.tmax}°C max</span>
        </div>
        <small className="today-lbl">Leave {home.from.replace(" Station", "")} at</small>
        <div className="today-time">{w.leave_at}</div>
        <div className="today-sub"><Clock size={13} /> at {home.to} by {w.arrive_at} · you start {home.arrive_by}</div>
        <div className="today-chips">
          {v.sun_saved > 0.05 && <span className="tchip"><Sun size={12} /> {v.sun_saved.toFixed(1)} min less sun</span>}
          {v.crowd_saved > 0.05 && <span className="tchip"><Users size={12} /> {v.crowd_saved.toFixed(1)} min less crowding</span>}
          <span className="tchip ghost"><Footprints size={12} /> {v.extra_min > 0.05 ? `+${v.extra_min.toFixed(1)} min walk` : "no extra walking"}</span>
        </div>
        <p className="today-vs">vs the shortest route, same departure</p>
      </section>

      {stepFree && <StopNotes meta={meta} refs={[s.stop]} />}

      <section className="m-card">
        <StepFreeSwitch on={stepFree} onChange={onStepFree} />
        <div className="pref" role="radiogroup" aria-label="Route preference">
          {PREFS.map(({ key, label, icon: Icon }) => {
            const o = key === "auto" ? t : home.options?.[key];
            if (!o) return null;
            const c = key === "auto" ? "var(--ink)" : MODE_COLORS[key];
            return (
              <button key={key} role="radio" aria-checked={pref === key} className={pref === key ? "on" : ""}
                style={{ ["--c" as string]: c }} onClick={() => setPref(key)}>
                <span className="pref-ic"><Icon size={15} /></span>
                <b>{label}</b>
                <small>{o.route.minutes.toFixed(1)} min</small>
              </button>
            );
          })}
        </div>
        <p className="pref-note">
          {pref === "auto"
            ? <>Weighs sun, crowds and walking time. Right now that's the <b style={{ color: MODE_COLORS[t.route.mode] }}>{autoLabel}</b> route.</>
            : pref === "coolest" && !hot
              ? <>It's mild today, so shade barely matters. Tap a faded line to compare.</>
              : <>Tap a faded line on the map to compare.</>}
        </p>
        <MiniMap lines={mapLines} marks={[...barrierMarks(r.access.barriers), ...owMarks(w.on_the_way ?? [], onNearby, r.minutes, w.leave_minutes)]} onPick={(i) => setPref(groups[i].modes.includes(r.mode) ? pref : groups[i].modes[0])} />
        <AccessNote access={r.access} vs={w.step_free_vs} stepFree={home.step_free} onStepFree={onStepFree} />
        <div className="route-sum" key={pref}>
          <div><b>{r.minutes.toFixed(1)}</b><small>min walk</small></div>
          <div><b>{r.sun_minutes.toFixed(1)}</b><small>min in sun</small></div>
          <div><b>{r.shaded_pct}%</b><small>shaded</small></div>
          <div><b>{r.comfort}</b><small>comfort</small></div>
        </div>
        <OnYourWay places={w.on_the_way ?? []} walkMin={r.minutes} leave={w.leave_minutes} onNearby={onNearby} key={`ow-${pref}`} />
        <ul className="m-lines">
          {lines.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
        <button className="m-expand" onClick={() => setOpen(!open)}>
          Turn by turn <ChevronDown size={15} style={{ transform: open ? "rotate(180deg)" : "none" }} />
        </button>
        {open && (
          <ol className="m-steps">
            {r.steps.map((st, i) => (
              <li key={i}>
                <span>{st.street === "laneway" ? "Laneway" : st.street}<small>{st.length_m} m · {st.shaded_pct}% shade</small></span>
                <b className="los" style={{ background: LOS_COLORS[LOS.indexOf(st.los)] }}>{st.los}</b>
                {st.shady_side && <em><TreeDeciduous size={11} /> {st.shady_side} side</em>}
              </li>
            ))}
          </ol>
        )}
        {!!r.walk_steps?.length && (
          <button className="m-btn primary go-start" onClick={() => setWalking("commute")}><Navigation2 size={16} /> Walk it step by step</button>
        )}
      </section>

      <section className="m-card rec">
        <div className="rec-h"><span className="rec-ic pop-ic"><Compass size={16} /></span><b>Got a few minutes?</b></div>
        <p>See what you can get to and back from in the time you have, taking the shady way.</p>
        <div className="pop">
          {POP.map((p) => {
            const c = CATS[p.want];
            const Icon = c.icon;
            return (
              <button key={p.label} style={{ ["--cc" as string]: c.color }} onClick={() => onNearby(p)}>
                <span><Icon size={13} /></span>{p.label} <small>{p.budget} min</small>
              </button>
            );
          })}
        </div>
      </section>

      {lunch && (
        <section className="m-card rec">
          <div className="rec-h"><span className="rec-ic lunch"><Utensils size={16} /></span><b>{lunch.title}</b></div>
          <p>{lunch.text}</p>
        </section>
      )}

      {meet && md && (
        <section className="m-card rec">
          <div className="rec-h"><span className="rec-ic meet"><CalendarClock size={16} /></span><b>{hot ? "Hot-day meeting" : "Meeting"} at {md.time}</b></div>
          <label className="m-inline">
            <MapPin size={13} />
            <select value={meeting || md.to_id} onChange={(e) => setMeeting(e.target.value)}>
              {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <p>{meet.text}</p>
          {!md.route.access.step_free && (
            <p className="m-acc-line">{home.step_free ? "No fully step-free way: " : "On the way: "}{barrierText(md.route.access)}.</p>
          )}
          <MiniMap height={150} lines={[
            { coords: md.route.geometry.coordinates, color: MODE_COLORS.coolest },
          ]} marks={barrierMarks(md.route.access.barriers)} />
          {!!md.route.walk_steps?.length && (
            <button className="m-btn go-start" onClick={() => setWalking("meeting")}><Navigation2 size={16} /> Walk it step by step</button>
          )}
        </section>
      )}

      <p className="m-fine">
        Numbers come from Lumen's shade and crowd models. Text written by {t.engine === "template" ? "a fixed template" : "a local model that can't change any number"}.
        Your stop and building are sent with this request only and never stored.
      </p>
    </div>
  );
}

/** Where tapping an "On your way" place goes: Nearby, on the trip it fits best, with that place picked out. */
function owPreset(p: OnTheWay, walkMin: number, leave: number): NearbyPreset {
  if (p.category === "fitness") return { want: "fitness", budget: 90, trip: "home", focus: p.id };
  if (p.category === "rest") return { want: "rest", budget: 20, trip: "back", t: 750, focus: p.id };
  // open as you pass: stop on the way in. Otherwise it's a lunchtime wander from the desk.
  if (p.hours.state === "open" || p.hours.state === "assumed_open") {
    const need = walkMin + p.off_min + 10;
    return { want: "local", budget: STEPS.find((x) => x >= need) ?? 60, trip: "in", t: leave, focus: p.id };
  }
  return { want: "local", budget: 30, trip: "back", t: 750, focus: p.id };
}

function owWhen(p: OnTheWay) {
  if (p.category === "rest") return p.on_route ? "your walk goes through it" : null;
  if (p.hours.state === "closed") return p.hours.opens != null ? `opens ${fmtTime(p.hours.opens)}` : "closed today";
  if (p.hours.state === "assumed_open") return "usually open now";
  return p.hours.text ? p.hours.text.replace(/^Open/, "open") : null;
}

function owMarks(places: OnTheWay[], onNearby: (p: NearbyPreset) => void, walkMin: number, leave: number) {
  return places.map((p) => {
    const c = CATS[p.category];
    const Icon = c.icon;
    return { coord: [p.lon, p.lat] as [number, number], label: "", cls: "local", color: c.color, title: p.name,
      icon: <Icon size={12} strokeWidth={2.6} />, onClick: () => onNearby(owPreset(p, walkMin, leave)) };
  });
}

/** Lumen Local on the Today card: one or two independent places, or a park, right beside the walk. */
function OnYourWay({ places, walkMin, leave, onNearby }: {
  places: OnTheWay[]; walkMin: number; leave: number; onNearby: (p: NearbyPreset) => void;
}) {
  if (!places.length) return null;
  return (
    <div className="ow">
      <div className="ow-h"><span>On your way</span><small>Cremorne's own, right beside this walk</small></div>
      {places.map((p, i) => {
        const c = CATS[p.category];
        const Icon = c.icon;
        const off = p.on_route ? "right on your route" : p.off_min < 1 ? `${p.off_m} m off route` : `${p.off_min.toFixed(1).replace(/\.0$/, "")} min off route`;
        const when = owWhen(p);
        return (
          <button key={p.id} className="ow-row" style={{ ["--cc" as string]: c.color, animationDelay: `${i * 70}ms` }}
            onClick={() => onNearby(owPreset(p, walkMin, leave))}>
            <span className="ow-ic"><Icon size={17} /></span>
            <span className="ow-main">
              <b>{p.name}</b>
              <small>{p.type_label} · {off}{when && <> · <em className={p.hours.state === "closed" ? "later" : ""}>{when}</em></>}</small>
            </span>
            <ChevronRight size={17} className="ow-go" />
          </button>
        );
      })}
    </div>
  );
}

/** When a request fails: say so and offer another go, instead of loading forever. */
export function Offline({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="m-empty m-offline">
      <WifiOff size={28} />
      <p>Couldn't reach Lumen. Check your connection and try again.</p>
      <button className="m-btn" onClick={onRetry}><RotateCw size={15} /> Try again</button>
    </div>
  );
}

export function Skeleton() {
  return (
    <div className="m-stack">
      <div className="sk sk-hero" />
      <div className="sk sk-card" />
      <div className="sk sk-row" />
    </div>
  );
}

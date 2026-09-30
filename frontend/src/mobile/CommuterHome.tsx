import { useEffect, useState } from "react";
import { ChevronDown, Clock, Footprints, MapPin, Sparkles, Sun, Thermometer, TreeDeciduous, Users, Utensils, CalendarClock, type LucideIcon } from "lucide-react";
import { get, LOS, LOS_COLORS, MODE_COLORS, type CommuterHome as Home, type Meta, type Route } from "../api";
import MiniMap from "./MiniMap";
import type { Settings } from "./MobileApp";

type Pref = "auto" | Route["mode"];
const PREFS: { key: Pref; label: string; icon: LucideIcon }[] = [
  { key: "auto", label: "Auto", icon: Sparkles },
  { key: "shortest", label: "Shortest", icon: Footprints },
  { key: "coolest", label: "Shadiest", icon: TreeDeciduous },
  { key: "calmest", label: "Quietest", icon: Users },
];
const PREF_KEY = "lumen.phone.routePref";
function loadPref(): Pref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return PREFS.some((p) => p.key === v) ? (v as Pref) : "auto";
  } catch {
    return "auto";
  }
}

type MeetingData = { to: string; to_id: string; time: string; temp_c: number; heat_matters: boolean; route: Route; shortest: Route };

export default function CommuterHome({ meta, s, scenario }: { meta: Meta; s: Settings; scenario: string }) {
  const [home, setHome] = useState<Home | null>(null);
  const [meeting, setMeeting] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(false);
  const [pref, setPrefState] = useState<Pref>(loadPref);
  const setPref = (p: Pref) => {
    setPrefState(p);
    try {
      localStorage.setItem(PREF_KEY, p);
    } catch {
      /* private mode: remembered for this visit only */
    }
  };

  useEffect(() => {
    setErr(false);
    const q = new URLSearchParams({ stop: s.stop, office: s.office, arrive: s.arrive, scenario });
    if (meeting) q.set("meeting", meeting);
    get<Home>(`/api/me/commuter?${q}`).then(setHome).catch(() => setErr(true));
  }, [s.stop, s.office, s.arrive, scenario, meeting]);

  if (err) return <p className="m-empty">Couldn't reach Lumen. Are you on the precinct Wi-Fi?</p>;
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

      <section className="m-card">
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
        <MiniMap lines={mapLines} onPick={(i) => setPref(groups[i].modes.includes(r.mode) ? pref : groups[i].modes[0])} />
        <div className="route-sum" key={pref}>
          <div><b>{r.minutes.toFixed(1)}</b><small>min walk</small></div>
          <div><b>{r.sun_minutes.toFixed(1)}</b><small>min in sun</small></div>
          <div><b>{r.shaded_pct}%</b><small>shaded</small></div>
          <div><b>{r.comfort}</b><small>comfort</small></div>
        </div>
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
          <MiniMap height={150} lines={[
            { coords: md.route.geometry.coordinates, color: MODE_COLORS.coolest },
          ]} />
        </section>
      )}

      <p className="m-fine">
        Numbers come from Lumen's shade and crowd models. Text written by {t.engine === "template" ? "a fixed template" : "a local model that can't change any number"}.
        Your stop and building are sent with this request only and never stored.
      </p>
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

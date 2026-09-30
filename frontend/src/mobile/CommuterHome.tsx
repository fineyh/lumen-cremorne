import { useEffect, useState } from "react";
import { ChevronDown, Clock, Footprints, MapPin, Sun, Thermometer, TreeDeciduous, Users, Utensils, CalendarClock } from "lucide-react";
import { get, LOS, LOS_COLORS, MODE_COLORS, type CommuterHome as Home, type Meta, type Route } from "../api";
import MiniMap from "./MiniMap";
import type { Settings } from "./MobileApp";

type MeetingData = { to: string; to_id: string; time: string; temp_c: number; heat_matters: boolean; route: Route; shortest: Route };

export default function CommuterHome({ meta, s, scenario }: { meta: Meta; s: Settings; scenario: string }) {
  const [home, setHome] = useState<Home | null>(null);
  const [meeting, setMeeting] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    setErr(false);
    const q = new URLSearchParams({ stop: s.stop, office: s.office, arrive: s.arrive, scenario });
    if (meeting) q.set("meeting", meeting);
    get<Home>(`/api/me/commuter?${q}`).then(setHome).catch(() => setErr(true));
  }, [s.stop, s.office, s.arrive, scenario, meeting]);

  if (err) return <p className="m-empty">Couldn't reach Lumen. Are you on the precinct Wi-Fi?</p>;
  if (!home) return <Skeleton />;
  const t = home.today;
  const r = t.route;
  const v = t.vs_shortest;
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
        <div className="today-time">{t.leave_at}</div>
        <div className="today-sub"><Clock size={13} /> at {home.to} by {t.arrive_at} · you start {home.arrive_by}</div>
        <div className="today-chips">
          {v.sun_saved > 0.05 && <span className="tchip"><Sun size={12} /> {v.sun_saved.toFixed(1)} min less sun</span>}
          {v.crowd_saved > 0.05 && <span className="tchip"><Users size={12} /> {v.crowd_saved.toFixed(1)} min less crowding</span>}
          <span className="tchip ghost"><Footprints size={12} /> {v.extra_min > 0.05 ? `+${v.extra_min.toFixed(1)} min walk` : "no extra walking"}</span>
        </div>
        <p className="today-vs">vs the shortest route, same departure</p>
      </section>

      <section className="m-card">
        <MiniMap lines={[{ coords: r.geometry.coordinates, color: MODE_COLORS[r.mode] }]} />
        <div className="route-sum">
          <div><b>{r.minutes.toFixed(1)}</b><small>min walk</small></div>
          <div><b>{r.sun_minutes.toFixed(1)}</b><small>min in sun</small></div>
          <div><b>{r.shaded_pct}%</b><small>shaded</small></div>
          <div><b>{r.comfort}</b><small>comfort</small></div>
        </div>
        <ul className="m-lines">
          {t.lines.map((l, i) => <li key={i}>{l}</li>)}
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

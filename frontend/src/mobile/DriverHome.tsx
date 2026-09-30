import { useEffect, useState } from "react";
import { MessageSquare, PackageCheck, TrainFront } from "lucide-react";
import { fmtTime, get, LOS, LOS_COLORS, type DriverHome as Home } from "../api";
import { Offline, Skeleton } from "./CommuterHome";
import type { Settings } from "./MobileApp";

const START = 360, END = 1200;

export default function DriverHome({ s, scenario, onSms }: { s: Settings; scenario: string; onSms: () => void }) {
  const [home, setHome] = useState<Home | null>(null);
  const [err, setErr] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setErr(false);
    get<Home>(`/api/me/driver?streets=${encodeURIComponent(s.streets.join(","))}&scenario=${scenario}`).then(setHome).catch(() => setErr(true));
  }, [s.streets, scenario, tick]);
  if (err) return <Offline onRetry={() => setTick(tick + 1)} />;
  if (!home) return <Skeleton />;
  const pct = (m: number) => `${((m - START) / (END - START)) * 100}%`;
  const worst = home.streets
    .flatMap((d) => d.busy.map((b) => ({ ...b, short: d.short })))
    .sort((a, b) => LOS.indexOf(b.worst) - LOS.indexOf(a.worst) || a.from_min - b.from_min)[0];

  return (
    <div className="m-stack">
      <section className="today driver">
        <div className="today-top"><span className="today-tag">Best window for your run</span></div>
        {home.best_window ? (
          <>
            <div className="today-time">{home.best_window.from}<span>–{home.best_window.to}</span></div>
            <div className="today-sub"><PackageCheck size={13} /> no footpath crowding on any of your {home.streets.length} streets</div>
          </>
        ) : (
          <div className="today-time small">Check each street below</div>
        )}
        {worst && (
          <div className="today-chips">
            <span className="tchip"><TrainFront size={12} /> avoid {worst.from}–{worst.to} on {worst.short} (LOS {worst.worst}, train arrivals)</span>
          </div>
        )}
      </section>

      {home.streets.map((d) => (
        <section key={d.street} className="m-card street">
          <div className="street-h">
            <b>{d.street}</b>
            <span className="los" style={{ background: LOS_COLORS[LOS.indexOf(d.peak.los)] }}>{d.peak.los}</span>
            <small>peak {d.peak.time}</small>
          </div>
          <div className="strip" aria-label={`Crowding on ${d.street} across the day`}>
            {d.timeline.map((x) => (
              <i key={x.t} style={{ background: LOS_COLORS[LOS.indexOf(x.los)], opacity: 0.35 + Math.min(0.65, x.per_m / 60) }} title={`${fmtTime(x.t)} LOS ${x.los}`} />
            ))}
            {d.quiet.map((q) => <span key={q.from} className="q" style={{ left: pct(q.from_min), width: `calc(${pct(q.to_min)} - ${pct(q.from_min)})` }} />)}
          </div>
          <div className="strip-axis"><span>6am</span><span>9am</span><span>12pm</span><span>3pm</span><span>6pm</span></div>
          <div className="win">
            {d.busy.length ? d.busy.slice(0, 3).map((b) => <span key={b.from} className="w busy">Busy {b.from}–{b.to} · {b.worst}</span>)
              : <span className="w ok">No crowding expected</span>}
            {d.quiet.map((q) => <span key={q.from} className="w ok">Unload {q.from}–{q.to}</span>)}
          </div>
        </section>
      ))}

      <section className="m-card sms-prev" onClick={onSms}>
        <div className="rec-h"><span className="rec-ic sms"><MessageSquare size={16} /></span><b>As a text at 6:30am</b></div>
        <div className="bubble-in">{home.sms}</div>
        <small>{home.sms.length} characters · plain GSM text · tap to try the SMS sign-up</small>
      </section>
      <p className="m-fine">Windows come from the pedestrian model (train arrivals + footpath width), not from tracking anyone. Replayed data, labelled as such in the Console.</p>
    </div>
  );
}

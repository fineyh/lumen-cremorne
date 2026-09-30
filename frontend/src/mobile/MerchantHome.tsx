import { useEffect, useState } from "react";
import { Clock, DoorOpen, Sun, TrendingDown, TrendingUp, UserPlus, Coffee } from "lucide-react";
import { get, type MerchantHome as Home, type Meta } from "../api";
import { Offline, Skeleton } from "./CommuterHome";
import type { Settings } from "./MobileApp";

const ICONS: Record<string, typeof Sun> = { roster: UserPlus, open: DoorOpen, close: Clock, quiet: Coffee, heat: Sun };

export default function MerchantHome({ s, scenario }: { meta: Meta; s: Settings; scenario: string }) {
  const [home, setHome] = useState<Home | null>(null);
  const [err, setErr] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setErr(false);
    get<Home>(`/api/me/merchant?node=${s.node}&open=${s.open}&close=${s.close}&scenario=${scenario}`).then(setHome).catch(() => setErr(true));
  }, [s.node, s.open, s.close, scenario, tick]);
  if (err) return <Offline onRetry={() => setTick(tick + 1)} />;
  if (!home) return <Skeleton />;
  const max = Math.max(...home.today.map((h) => h.people), ...home.last_week.map((h) => h.people));
  const [oh, ch] = [parseInt(s.open), parseInt(s.close)];
  const up = home.wow_pct >= 0;

  return (
    <div className="m-stack">
      <section className="today shop">
        <div className="today-top"><span className="today-tag">{home.node.street}</span><span className="today-temp">replayed data</span></div>
        <small className="today-lbl">People past your window</small>
        <div className="today-time">{home.total.toLocaleString()}</div>
        <div className="today-chips">
          <span className={`tchip ${up ? "" : "down"}`}>{up ? <TrendingUp size={12} /> : <TrendingDown size={12} />} {up ? "+" : ""}{home.wow_pct}% vs same day last week</span>
          <span className="tchip ghost">peak {home.peak.hour > 12 ? home.peak.hour - 12 : home.peak.hour}{home.peak.hour >= 12 ? "pm" : "am"}</span>
        </div>
      </section>

      <section className="m-card">
        <div className="chart-h"><b>Each hour</b><span><i className="lg now" /> today <i className="lg last" /> last week <i className="lg open" /> your hours</span></div>
        <div className="hbars">
          {home.today.map((h, i) => {
            const lw = home.last_week[i]?.people ?? 0;
            const isOpen = h.hour >= oh && h.hour < ch;
            return (
              <div key={h.hour} className={`hb2 ${isOpen ? "open" : ""}`} title={`${h.hour}:00 · ${h.people} today, ${lw} last week`}>
                <div className="pair">
                  <i className="last" style={{ height: `${(lw / max) * 100}%` }} />
                  <i className="now" style={{ height: `${(h.people / max) * 100}%` }} />
                </div>
                <span>{h.hour % 3 === 0 ? (h.hour > 12 ? `${h.hour - 12}p` : `${h.hour}${h.hour === 12 ? "p" : "a"}`) : ""}</span>
              </div>
            );
          })}
        </div>
        <ul className="m-lines">{home.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      </section>

      {home.recommendations.map((r) => {
        const I = ICONS[r.kind] ?? Clock;
        return (
          <section key={r.title} className="m-card rec">
            <div className="rec-h"><span className={`rec-ic ${r.kind}`}><I size={16} /></span><b>{r.title}</b></div>
            <p>{r.text}</p>
          </section>
        );
      })}
      <p className="m-fine">From the window node on {home.node.street} ({home.node.id}). Counts only, no images. You own this data; only precinct totals are shared.</p>
    </div>
  );
}

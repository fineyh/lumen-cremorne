import { useEffect, useState } from "react";
import { Download, ExternalLink, Sprout, Sun, Users } from "lucide-react";
import { get, type CouncilHome as Home } from "../api";
import { Offline, Skeleton } from "./CommuterHome";

export default function CouncilHome({ scenario }: { scenario: string }) {
  const [home, setHome] = useState<Home | null>(null);
  const [err, setErr] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setErr(false);
    get<Home>(`/api/me/council?scenario=${scenario}`).then(setHome).catch(() => setErr(true));
  }, [scenario, tick]);
  if (err) return <Offline onRetry={() => setTick(tick + 1)} />;
  if (!home) return <Skeleton />;
  return (
    <div className="m-stack">
      <section className="today council">
        <div className="today-top"><span className="today-tag">Weekly report</span><span className="today-temp">3:30pm, hot day</span></div>
        <small className="today-lbl">Precinct Comfort Score</small>
        <div className="today-time">{home.comfort_1530.toFixed(0)}<span>/100</span></div>
        <div className="today-chips"><span className="tchip">{Math.round(home.shaded_share_1530 * 100)}% of paths have a shaded side</span></div>
      </section>
      <section className="m-card rec">
        <div className="rec-h"><span className="rec-ic roster"><Users size={16} /></span><b>Over capacity at 8:45am</b></div>
        {home.crowded.length ? home.crowded.map((r) => <p key={r.street}><b>{r.street}</b>: LOS {r.am_peak_los}, {r.effective_width_m} m clear width</p>)
          : <p>No street reaches LOS D this week.</p>}
      </section>
      <section className="m-card rec">
        <div className="rec-h"><span className="rec-ic heat"><Sun size={16} /></span><b>Longest sunlit walks at 3:30pm</b></div>
        {home.sunny.map((r) => <p key={r.street}><b>{r.street}</b>: {r.sunlit_pct_1530_hot_day}% sunlit over {r.length_m} m</p>)}
      </section>
      <a className="m-btn primary" href="/" target="_blank" rel="noreferrer"><Sprout size={16} /> Open Console · What-if plans <ExternalLink size={14} /></a>
      <a className="m-btn" href={`/api/report.csv?scenario=${scenario}`} download><Download size={16} /> Weekly report CSV</a>
    </div>
  );
}

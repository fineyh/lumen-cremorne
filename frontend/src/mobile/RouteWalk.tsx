import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Flag, Footprints, Navigation2 } from "lucide-react";
import { fmtTime, MODE_COLORS, type Route, type WalkStep } from "../api";
import MiniMap, { type Pin } from "./MiniMap";
import { HEADING, Row, say, TURN_ICON, Walk } from "./WalkView";

type Item = { k: "walk"; st: WalkStep; at: number } | { k: "end"; at: number };

/** Follow a plain A to B walk (commute, meeting, anywhere) step by step, like a Nearby walk without the stop. */
export default function RouteWalk({ route, start, from, to, hot, back = "Back", onClose }: {
  route: Route; start: number; from: string; to: string; hot: boolean; back?: string; onClose: () => void;
}) {
  const color = MODE_COLORS[route.mode];
  const root = useRef<HTMLDivElement>(null);
  const steps = route.walk_steps ?? [];

  const items: Item[] = [];
  let at = start;
  for (const st of steps) {
    items.push({ k: "walk", st, at });
    at += st.minutes;
  }
  items.push({ k: "end", at: start + route.minutes });

  const [i, setI] = useState(0);
  const cur = items[Math.min(i, items.length - 1)];
  const go = (k: number) => setI(Math.max(0, Math.min(items.length - 1, k)));

  useEffect(() => {
    root.current?.closest(".m-body")?.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setI((k) => Math.min(items.length - 1, k + 1));
      else if (e.key === "ArrowLeft") setI((k) => Math.max(0, k - 1));
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length, onClose]);

  const line = route.geometry.coordinates;
  const end = line[line.length - 1];
  const lines = [
    { coords: line, color, muted: true },
    ...(cur.k === "walk" && cur.st.path.length > 1 ? [{ coords: cur.st.path, color, width: 7 }] : []),
  ];
  const pins: Pin[] = [
    { coord: line[0], label: "A", cls: "from", title: from },
    { coord: end, label: "B", cls: "to", title: to },
    ...(cur.k === "walk" ? [{
      coord: cur.st.path[0], label: cur.st.heading, cls: "here", title: "Start of this step",
      icon: <Navigation2 size={14} strokeWidth={2.6} fill="currentColor" style={{ rotate: `${HEADING.indexOf(cur.st.heading) * 45}deg` }} />,
    }] : []),
  ];
  const focus = cur.k === "walk" ? cur.st.path : [end];

  return (
    <div className="m-stack nb wk" ref={root} style={{ ["--c" as string]: color, ["--rc" as string]: color }}>
      <section className="wk-bar">
        <button className="wk-back" onClick={onClose}><ChevronLeft size={16} /> {back}</button>
        <div className="wk-dest">
          <span className="nb-av"><Footprints size={18} /></span>
          <div className="nb-title">
            <b>{to}</b>
            <small>{route.label} way from {from} · {route.minutes.toFixed(1)} min · there by {fmtTime(Math.round(start + route.minutes))}</small>
          </div>
        </div>
      </section>

      <section className="m-card wk-now">
        <MiniMap lines={lines} pins={pins} focus={focus} height={236} />
        <div className="wk-cur" key={i}>
          {cur.k === "walk" ? <Walk st={cur.st} at={cur.at} leg={`To ${to}`} hot={hot} />
            : <Row icon={Flag} tone="end" kicker={`${fmtTime(Math.round(cur.at))} · done`} title={`At ${to}`}
                sub={`${route.minutes.toFixed(1)} min walk, ${route.sun_minutes.toFixed(1)} min of it in the sun`} />}
        </div>
        <div className="wk-ctl">
          <button onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous step"><ChevronLeft size={18} /></button>
          <div className="wk-dots" aria-label={`Step ${i + 1} of ${items.length}`}>
            {items.map((it, k) => <i key={k} className={`${k === i ? "on" : k < i ? "done" : ""} ${it.k}`} />)}
          </div>
          <button className="next" onClick={() => (i === items.length - 1 ? onClose() : go(i + 1))} aria-label={i === items.length - 1 ? "Finish walk" : "Next step"}>
            {i === items.length - 1 ? "Done" : "Next"} <ChevronRight size={18} />
          </button>
        </div>
      </section>

      <section className="m-card wk-list">
        {items.map((it, k) => {
          const TI = it.k === "walk" ? TURN_ICON[it.st.turn] : Flag;
          return (
            <button key={k} className={`wk-row ${it.k} ${k === i ? "on" : ""}`} onClick={() => setI(k)}>
              <span className="wk-row-ic"><TI size={15} /></span>
              <span className="wk-row-main">
                <b>{it.k === "walk" ? say(it.st) : to}</b>
                <small>{it.k === "walk" ? `${it.st.length_m} m${hot ? ` · ${it.st.shaded_pct}% shade` : ""}` : "Arrive"}</small>
              </span>
              <span className="wk-row-t">{fmtTime(Math.round(it.at))}</span>
            </button>
          );
        })}
      </section>

      <p className="m-fine">
        Steps follow Lumen's walking network. Street names on footpaths come from the street they run beside.
      </p>
    </div>
  );
}

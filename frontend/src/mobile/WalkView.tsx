import { useEffect, useRef, useState } from "react";
import {
  ArrowUp, ArrowUpLeft, ArrowUpRight, Briefcase, ChevronLeft, ChevronRight, CornerUpLeft, CornerUpRight, Flag, Navigation2,
  TrainFront, TreeDeciduous, Undo2, Users, type LucideIcon,
} from "lucide-react";
import { fmtTime, LOS, MODE_COLORS, type NearbyPlace, type NearbyResponse, type Turn, type WalkStep } from "../api";
import MiniMap, { type Pin } from "./MiniMap";
import { CATS, type Trip } from "./NearbyView";

type Item =
  | { k: "walk"; leg: "out" | "back"; st: WalkStep; at: number }
  | { k: "stop"; at: number }
  | { k: "end"; at: number };

const TURN_ICON: Record<Turn, LucideIcon> = {
  start: Navigation2, straight: ArrowUp, "slight-left": ArrowUpLeft, "slight-right": ArrowUpRight,
  left: CornerUpLeft, right: CornerUpRight, uturn: Undo2,
};
const HEADING = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const n1 = (x: number) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : x.toFixed(1));

function say(st: WalkStep) {
  const street = st.street === "laneway" ? "the laneway" : st.street === "crossing" ? "the crossing" : st.street;
  const side = st.turn.endsWith("left") ? "left" : "right";
  switch (st.turn) {
    case "start": return st.street === "crossing" ? `Cross the road, heading ${st.heading}` : `Head ${st.heading} on ${street}`;
    case "straight": return `Continue onto ${street}`;
    case "slight-left": case "slight-right": return `Bear ${side} onto ${street}`;
    case "uturn": return `Turn back along ${street}`;
    default: return `Turn ${side} onto ${street}`;
  }
}

/** Follow the chosen walk step by step inside Lumen, so you stay on the shady, calmer way it picked. */
export default function WalkView({ data, place, trip, onClose }: { data: NearbyResponse; place: NearbyPlace; trip: Trip; onClose: () => void }) {
  const cat = CATS[data.want];
  const Icon = cat.icon;
  const stay = data.kind === "stay";
  const color = MODE_COLORS[place.mode];
  const root = useRef<HTMLDivElement>(null);

  const items: Item[] = [];
  let at = data.minutes;
  for (const st of place.steps.out) {
    items.push({ k: "walk", leg: "out", st, at });
    at += st.minutes;
  }
  items.push({ k: "stop", at: data.minutes + place.walk_out });
  at = data.minutes + place.walk_out + place.dwell;
  for (const st of place.steps.back ?? []) {
    items.push({ k: "walk", leg: "back", st, at });
    at += st.minutes;
  }
  if (place.steps.back) items.push({ k: "end", at: data.minutes + place.total });

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

  const endName = trip === "back" ? "your desk" : (data.to ?? "").replace(" Station", " station");
  const legLabel = (leg: "out" | "back") => (leg === "out" ? `To ${place.name}` : trip === "back" ? "Back to your desk" : `On to ${endName}`);
  const placeCoord: [number, number] = [place.lon, place.lat];
  const whole = [...place.geometry.out, ...(place.geometry.back ?? [])];

  const lines = [
    ...(place.geometry.out.length > 1 ? [{ coords: place.geometry.out, color, muted: true }] : []),
    ...(place.geometry.back && place.geometry.back.length > 1 ? [{ coords: place.geometry.back, color, dashed: true, muted: true }] : []),
    ...(cur.k === "walk" && cur.st.path.length > 1 ? [{ coords: cur.st.path, color, width: 7 }] : []),
  ];
  const pins: Pin[] = [
    {
      coord: place.geometry.out[0] ?? placeCoord, label: "A", cls: "from", title: data.from,
      icon: trip === "in" ? <TrainFront size={13} strokeWidth={2.5} /> : <Briefcase size={13} strokeWidth={2.5} />,
    },
    ...(data.shape === "via" && place.geometry.back?.length ? [{
      coord: place.geometry.back[place.geometry.back.length - 1], label: "B", cls: "to", title: data.to ?? "",
      icon: trip === "in" ? <Briefcase size={13} strokeWidth={2.5} /> : <TrainFront size={13} strokeWidth={2.5} />,
    }] : []),
    { coord: placeCoord, label: "", cls: "place", title: place.name, color: cat.color, icon: <Icon size={18} strokeWidth={2.4} /> },
    ...(cur.k === "walk" ? [{
      coord: cur.st.path[0], label: cur.st.heading, cls: "here", title: "Start of this step",
      icon: <Navigation2 size={14} strokeWidth={2.6} fill="currentColor" style={{ rotate: `${HEADING.indexOf(cur.st.heading) * 45}deg` }} />,
    }] : []),
  ];
  const focus = cur.k === "walk" ? cur.st.path : cur.k === "stop" ? [placeCoord] : whole;

  return (
    <div className="m-stack nb wk" ref={root} style={{ ["--c" as string]: cat.color, ["--rc" as string]: color }}>
      <section className="wk-bar">
        <button className="wk-back" onClick={onClose}><ChevronLeft size={16} /> Places</button>
        <div className="wk-dest">
          <span className="nb-av"><Icon size={18} /></span>
          <div className="nb-title">
            <b>{place.name}</b>
            <small>{place.route_label} way · {n1(place.walk)} min walking · {trip === "back" ? "back" : "there"} by {place.back_at}</small>
          </div>
        </div>
      </section>

      <section className="m-card wk-now">
        <MiniMap lines={lines} pins={pins} focus={focus} height={236} />
        <div className="wk-cur" key={i}>
          {cur.k === "walk" ? <Walk st={cur.st} at={cur.at} leg={legLabel(cur.leg)} hot={data.hot} />
            : cur.k === "stop" ? (
              <Row icon={Icon} tone="place" kicker={`${fmtTime(Math.round(cur.at))} · you're there`}
                title={stay ? `Sit at ${place.name}` : `Arrive at ${place.name}`}
                sub={stay ? `${Math.floor(place.dwell)} min to sit, then head ${trip === "back" ? "back" : "on"} at ${place.leave_at}`
                  : `About ${n1(place.dwell)} min ${data.verb || "there"}, leave by ${place.leave_at}`} />
            ) : (
              <Row icon={Flag} tone="end" kicker={`${fmtTime(Math.round(cur.at))} · done`}
                title={trip === "back" ? "Back at your desk" : `At ${endName}`}
                sub={place.spare >= 1 ? `${n1(place.spare)} min to spare in your ${data.budget} min` : `Right on your ${data.budget} min`} />
            )}
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
          const head = it.k === "walk" && (k === 0 || items[k - 1].k !== "walk") ? <h4 key={`h${k}`}>{legLabel(it.leg)}</h4> : null;
          const TI = it.k === "walk" ? TURN_ICON[it.st.turn] : it.k === "stop" ? Icon : Flag;
          return [
            head,
            <button key={k} className={`wk-row ${it.k} ${k === i ? "on" : ""}`} onClick={() => setI(k)}>
              <span className="wk-row-ic"><TI size={15} /></span>
              <span className="wk-row-main">
                <b>{it.k === "walk" ? say(it.st) : it.k === "stop" ? place.name : trip === "back" ? "Your desk" : endName}</b>
                <small>
                  {it.k === "walk" ? `${it.st.length_m} m${data.hot ? ` · ${it.st.shaded_pct}% shade` : ""}`
                    : it.k === "stop" ? (stay ? `${Math.floor(place.dwell)} min sit` : `~${n1(place.dwell)} min ${data.verb || "there"}`) : "Arrive"}
                </small>
              </span>
              <span className="wk-row-t">{fmtTime(Math.round(it.at))}</span>
            </button>,
          ];
        })}
      </section>

      <p className="m-fine">
        Steps follow Lumen's walking network. Street names on footpaths come from the street they run beside.
      </p>
    </div>
  );
}

function Walk({ st, at, leg, hot }: { st: WalkStep; at: number; leg: string; hot: boolean }) {
  const busy = LOS.indexOf(st.los) >= 3;
  return (
    <>
      <Row icon={TURN_ICON[st.turn]} rot={st.turn === "start" ? HEADING.indexOf(st.heading) * 45 : 0} tone="turn" kicker={`${leg} · ${fmtTime(Math.round(at))}`} title={say(st)}
        sub={`${st.length_m} m · about ${Math.max(1, Math.round(st.minutes))} min${hot ? ` · ${st.shaded_pct}% in shade` : ""}`} />
      {(st.shady_side || busy) && (
        <div className="nb-chips">
          {st.shady_side && <span className="nb-chip shade"><TreeDeciduous size={12} /> Keep to the {st.shady_side} side, it's shadier</span>}
          {busy && <span className="nb-chip busy"><Users size={12} /> Busy footpath here</span>}
        </div>
      )}
    </>
  );
}

function Row({ icon: I, rot = 0, tone, kicker, title, sub }: { icon: LucideIcon; rot?: number; tone: string; kicker: string; title: string; sub: string }) {
  return (
    <div className={`wk-step ${tone}`}>
      <span className="wk-turn"><I size={26} strokeWidth={2.4} style={rot ? { rotate: `${rot}deg` } : undefined} /></span>
      <div>
        <small>{kicker}</small>
        <b>{title}</b>
        <p>{sub}</p>
      </div>
    </div>
  );
}

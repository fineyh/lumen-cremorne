import { useState } from "react";
import { ArrowLeft, ArrowRight, Briefcase, Building2, Check, Lock, MessageSquare, Store, Truck } from "lucide-react";
import type { Meta, Role } from "../api";
import type { Settings } from "./MobileApp";

const ROLES: { key: Role; label: string; sub: string; icon: typeof Truck }[] = [
  { key: "commuter", label: "I work in Cremorne", sub: "Best time and route from the station, lunch, meetings", icon: Briefcase },
  { key: "driver", label: "I deliver here", sub: "When your streets are quiet enough to unload. SMS works too", icon: Truck },
  { key: "merchant", label: "I run a shop or café", sub: "People past your window each hour, rostering tips", icon: Store },
  { key: "council", label: "CDH / City of Yarra", sub: "Precinct summary and the full Console", icon: Building2 },
];
const MAIN_STOPS = ["train-richmond", "train-east-richmond", "tram-swan-street-shopping-centre", "tram-balmain-street", "tram-lennox-street", "tram-adelaide-street"];

type Props = { meta: Meta; initial: Settings | null; presetRole: Role | null; onDone: (s: Settings) => void; onReset: () => void };

export default function Onboarding({ meta, initial, presetRole, onDone, onReset }: Props) {
  const dover = meta.offices.find((o) => o.name === "Dover House")?.id ?? meta.offices[0].id;
  const [s, setS] = useState<Settings>(
    initial ?? {
      role: presetRole ?? "commuter", stop: "train-richmond", office: dover, arrive: "09:00",
      streets: ["Swan Street", "Cremorne Street"], node: "node-03", open: "07:00", close: "16:00", channel: "web",
    },
  );
  const [step, setStep] = useState(initial || presetRole ? 1 : 0);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const stops = meta.stops.filter((x) => MAIN_STOPS.includes(x.id));
  const offices = meta.offices.filter((o) => o.name && /[A-Za-z]{3}/.test(o.name));
  const nodes = meta.nodes.filter((n) => !n.live);

  if (step === 0)
    return (
      <div className="ob">
        <div className="ob-hero">
          <img src="/lumen.svg" alt="" width={52} />
          <h1>Cremorne, a bit cooler<br />and less crowded.</h1>
          <p>Tell us who you are and a couple of places. That's it. No name, no email, no location tracking.</p>
        </div>
        <div className="ob-roles">
          {ROLES.map((r) => (
            <button key={r.key} className={`ob-role ${s.role === r.key ? "on" : ""}`} onClick={() => { set("role", r.key); setStep(1); }}>
              <span className="ob-ic"><r.icon size={20} /></span>
              <span><b>{r.label}</b><small>{r.sub}</small></span>
              <ArrowRight size={16} className="ob-go" />
            </button>
          ))}
        </div>
        <p className="ob-privacy"><Lock size={12} /> Only you see these settings. They stay on this phone.</p>
      </div>
    );

  const role = ROLES.find((r) => r.key === s.role)!;
  return (
    <div className="ob">
      <button className="ob-back" onClick={() => setStep(0)}><ArrowLeft size={16} /> {role.label}</button>
      <h2 className="ob-h">A few places</h2>

      {s.role === "commuter" && (
        <div className="ob-form">
          <label>Station or tram stop<select value={s.stop} onChange={(e) => set("stop", e.target.value)}>
            {stops.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select></label>
          <label>Your building<select value={s.office} onChange={(e) => set("office", e.target.value)}>
            {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select></label>
          <label>Start work at<input type="time" value={s.arrive} onChange={(e) => set("arrive", e.target.value)} /></label>
        </div>
      )}

      {s.role === "driver" && (
        <div className="ob-form">
          <span className="ob-lbl">Streets you deliver on <small>(up to 3)</small></span>
          <div className="ob-chips">
            {meta.streets.slice(0, 12).map((st) => {
              const on = s.streets.includes(st);
              return (
                <button key={st} className={on ? "on" : ""}
                  onClick={() => set("streets", on ? s.streets.filter((x) => x !== st) : [...s.streets, st].slice(-3))}>
                  {on && <Check size={12} />} {st.replace(" Street", " St")}
                </button>
              );
            })}
          </div>
          <span className="ob-lbl">How should we reach you?</span>
          <div className="ob-channel">
            <button className={s.channel === "web" ? "on" : ""} onClick={() => set("channel", "web")}><Truck size={16} /><b>This page</b><small>check before your run</small></button>
            <button className={s.channel === "sms" ? "on" : ""} onClick={() => set("channel", "sms")}><MessageSquare size={16} /><b>Text me</b><small>one SMS at 6:30am</small></button>
          </div>
        </div>
      )}

      {s.role === "merchant" && (
        <div className="ob-form">
          <label>Your street (nearest window node)<select value={s.node} onChange={(e) => set("node", e.target.value)}>
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.street} · {n.id}</option>)}
          </select></label>
          <div className="ob-two">
            <label>Open<input type="time" value={s.open} onChange={(e) => set("open", e.target.value)} /></label>
            <label>Close<input type="time" value={s.close} onChange={(e) => set("close", e.target.value)} /></label>
          </div>
        </div>
      )}

      {s.role === "council" && <p className="ob-p">You'll see a precinct summary here and a link to the full Console, including What-if plans and the weekly report.</p>}

      <button className="m-btn primary" onClick={() => onDone(s)} disabled={s.role === "driver" && !s.streets.length}>
        {initial ? "Save" : "Show my day"} <ArrowRight size={16} />
      </button>
      <p className="ob-privacy"><Lock size={12} /> Stored only on this phone. Lumen never asks for your location.</p>
      {initial && <button className="m-link danger" onClick={onReset}>Forget me (delete settings)</button>}
    </div>
  );
}

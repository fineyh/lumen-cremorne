import { useEffect, useState } from "react";
import { CalendarDays, Compass, MessageSquare, Settings2, Sun } from "lucide-react";
import { get, type Meta, type Role } from "../api";
import Onboarding from "./Onboarding";
import CommuterHome from "./CommuterHome";
import DriverHome from "./DriverHome";
import MerchantHome from "./MerchantHome";
import CouncilHome from "./CouncilHome";
import SmsSim from "./SmsSim";
import NearbyView, { type NearbyPreset } from "./NearbyView";
import "./mobile.css";

export type Settings = {
  role: Role;
  stop: string;
  office: string;
  arrive: string;
  streets: string[];
  node: string;
  open: string;
  close: string;
  channel: "web" | "sms";
};

const KEY = "lumen.phone.settings";
export const SCENARIOS = [
  { key: "hot", label: "Hot 35°" },
  { key: "mild", label: "Mild 21°" },
  { key: "today", label: "Today" },
];

// Settings live only in this phone's storage. The server gets place ids per request and forgets them.
function loadSettings(): Settings | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Settings) : null;
  } catch {
    return null;
  }
}
function storeSettings(s: Settings | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: settings last for this visit only */
  }
}

export default function MobileApp() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [settings, setSettings] = useState<Settings | null>(loadSettings);
  const [view, setView] = useState<"home" | "nearby" | "sms" | "settings">("home");
  const [preset, setPreset] = useState<NearbyPreset | null>(null);
  const openNearby = (p: NearbyPreset) => {
    setPreset(p);
    setView("nearby");
  };
  const [scenario, setScenario] = useState("hot");
  const presetRole = new URLSearchParams(window.location.search).get("role") as Role | null;

  useEffect(() => {
    get<Meta>("/api/meta").then(setMeta).catch(() => setMeta(null));
    document.title = "Lumen · Cremorne";
  }, []);

  const save = (s: Settings | null) => {
    storeSettings(s);
    setSettings(s);
    setView(s?.channel === "sms" ? "sms" : "home");
  };

  const body = () => {
    if (!meta) return <div className="m-loading"><img src="/lumen.svg" alt="" width={44} /><span>Loading Cremorne…</span></div>;
    if (!settings || view === "settings")
      return <Onboarding meta={meta} initial={settings} presetRole={presetRole} onDone={save} onReset={() => save(null)} />;
    if (view === "sms") return <SmsSim />;
    if (view === "nearby" && settings.role === "commuter") return <NearbyView meta={meta} s={settings} scenario={scenario} preset={preset} />;
    switch (settings.role) {
      case "commuter": return <CommuterHome meta={meta} s={settings} scenario={scenario} onNearby={openNearby} />;
      case "driver": return <DriverHome s={settings} scenario={scenario} onSms={() => setView("sms")} />;
      case "merchant": return <MerchantHome meta={meta} s={settings} scenario={scenario} />;
      default: return <CouncilHome scenario={scenario} />;
    }
  };

  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return (
    <div className="m-shell">
      <div className="m-side-note">
        <img src="/lumen.svg" alt="" width={40} />
        <h1>Lumen for your phone</h1>
        <p>One screen, the one or two things that matter to you today. No app store, no login. Settings stay on the phone.</p>
        <p className="m-note-small">Open <b>/m</b> on a phone, or scan the QR code in the Console.</p>
      </div>
      <div className="m-phone">
        <div className="m-screen">
          {settings && view !== "settings" && (
            <header className="m-top">
              <div>
                <small>{greet}</small>
                <h2>{view === "nearby" ? "Pop out nearby" : roleTitle(settings.role)}</h2>
              </div>
              <div className={`m-scen ${scenario === "today" ? "live" : "demo"}`}
                title={scenario === "today" ? "Today's real forecast" : "Simulated day for the demo, not today's weather"}>
                <span className="m-scen-tag">{scenario === "today" ? "Live" : "Demo"}</span>
                <Sun size={13} />
                <select value={scenario} onChange={(e) => setScenario(e.target.value)} aria-label="Demo day">
                  {SCENARIOS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
            </header>
          )}
          <div className="m-body">{body()}</div>
          {settings && (
            <nav className="m-nav">
              <button className={view === "home" ? "on" : ""} onClick={() => setView("home")}><CalendarDays size={19} /><span>Today</span></button>
              {settings.role === "commuter" && (
                <button className={view === "nearby" ? "on" : ""} onClick={() => setView("nearby")}><Compass size={19} /><span>Nearby</span></button>
              )}
              {settings.role === "driver" && (
                <button className={view === "sms" ? "on" : ""} onClick={() => setView("sms")}><MessageSquare size={19} /><span>Texts</span></button>
              )}
              <button className={view === "settings" ? "on" : ""} onClick={() => setView("settings")}><Settings2 size={19} /><span>Settings</span></button>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}

export function roleTitle(r: Role) {
  return { commuter: "Your walk today", driver: "Your streets today", merchant: "Your shopfront", council: "Precinct this week" }[r];
}

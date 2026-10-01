import { useEffect, useState, type CSSProperties } from "react";
import { CalendarDays, Compass, Footprints, MessageSquare, MessagesSquare, Settings2, Sun } from "lucide-react";
import { get, type AskAnswer, type Meta, type Role } from "../api";
import Onboarding from "./Onboarding";
import CommuterHome from "./CommuterHome";
import DriverHome from "./DriverHome";
import MerchantHome from "./MerchantHome";
import CouncilHome from "./CouncilHome";
import { Offline } from "./CommuterHome";
import SmsSim from "./SmsSim";
import NearbyView, { type NearbyPreset } from "./NearbyView";
import GoView, { type GoInit } from "./GoView";
import AskView, { type AskMsg } from "./AskView";
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
  /** plan every walk step-free (wheelchair, pram, walking frame) */
  stepFree?: boolean;
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
  const [metaErr, setMetaErr] = useState(false);
  const [metaTry, setMetaTry] = useState(0);
  const [settings, setSettings] = useState<Settings | null>(loadSettings);
  const [view, setView] = useState<"home" | "nearby" | "go" | "ask" | "sms" | "settings">("home");
  const [preset, setPreset] = useState<NearbyPreset | null>(null);
  const openNearby = (p: NearbyPreset) => {
    setPreset(p);
    setView("nearby");
  };
  // a Walk opened from an Ask answer; the counter remounts Walk so it takes the new places
  const [go, setGo] = useState<{ init: GoInit | null; n: number }>({ init: null, n: 0 });
  const openGo = (a: NonNullable<AskAnswer["action"]>, label: string) => {
    setGo({ init: { from: a.from, to: a.to, mode: a.mode, minutes: a.minutes, toLabel: label }, n: go.n + 1 });
    setView("go");
  };
  const [askMsgs, setAskMsgs] = useState<AskMsg[]>([]);
  const [scenario, setScenario] = useState("hot");
  const presetRole = new URLSearchParams(window.location.search).get("role") as Role | null;

  useEffect(() => {
    setMetaErr(false);
    get<Meta>("/api/meta").then(setMeta).catch(() => setMetaErr(true));
    document.title = "Lumen · Cremorne";
  }, [metaTry]);

  const save = (s: Settings | null) => {
    storeSettings(s);
    setSettings(s);
    setView("home");
  };
  // flipped from any walk screen: remembered with the rest of the settings, without leaving the screen
  const setStepFree = (on: boolean) => {
    if (!settings) return;
    const s = { ...settings, stepFree: on };
    storeSettings(s);
    setSettings(s);
  };

  const body = () => {
    if (!meta && metaErr) return <Offline onRetry={() => setMetaTry(metaTry + 1)} />;
    if (!meta) return <div className="m-loading"><img src="/lumen.svg" alt="" width={44} /><span>Loading Cremorne…</span></div>;
    if (!settings || view === "settings")
      return <Onboarding meta={meta} initial={settings} presetRole={presetRole} onDone={save} onReset={() => save(null)} />;
    if (view === "sms") return <SmsSim />;
    if (settings.role === "commuter") {
      if (view === "nearby") return <NearbyView meta={meta} s={settings} scenario={scenario} preset={preset} onStepFree={setStepFree} />;
      if (view === "go") return <GoView key={go.n} meta={meta} s={settings} scenario={scenario} init={go.init} onStepFree={setStepFree} />;
      if (view === "ask") return <AskView s={settings} scenario={scenario} msgs={askMsgs} setMsgs={setAskMsgs} onRoute={openGo} />;
    }
    switch (settings.role) {
      case "commuter": return <CommuterHome meta={meta} s={settings} scenario={scenario} onNearby={openNearby} onStepFree={setStepFree} />;
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
        <div className={`m-screen${settings ? " has-nav" : ""}`}>
          {settings && view !== "settings" && (
            <header className="m-top">
              <div>
                <small>{greet}</small>
                <h2>{view === "nearby" ? "Pop out nearby" : view === "go" ? "Walk anywhere" : view === "ask" ? "Ask Lumen" : roleTitle(settings.role)}</h2>
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
          {settings && (() => {
            const tabs: { v: typeof view; label: string; icon: typeof Sun }[] = [
              { v: "home", label: "Today", icon: CalendarDays },
              ...(settings.role === "commuter"
                ? [
                    { v: "nearby" as const, label: "Nearby", icon: Compass },
                    { v: "go" as const, label: "Walk", icon: Footprints },
                    { v: "ask" as const, label: "Ask", icon: MessagesSquare },
                  ]
                : []),
              ...(settings.role === "driver" ? [{ v: "sms" as const, label: "Texts", icon: MessageSquare }] : []),
              { v: "settings", label: "Settings", icon: Settings2 },
            ];
            const at = tabs.findIndex((t) => t.v === view);
            // the glass lens slides under whichever tab is on
            return (
              <nav className="m-nav" style={{ "--n": tabs.length, "--i": Math.max(at, 0) } as CSSProperties} data-lens={at >= 0 ? "" : undefined}>
                {tabs.map(({ v, label, icon: Icon }) => (
                  <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)} aria-current={view === v ? "page" : undefined}>
                    <Icon size={20} /><span>{label}</span>
                  </button>
                ))}
              </nav>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

export function roleTitle(r: Role) {
  return { commuter: "Your walk today", driver: "Your streets today", merchant: "Your shopfront", council: "Precinct this week" }[r];
}

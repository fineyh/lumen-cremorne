import { Globe2, Lock, Scale, Users, Wallet } from "lucide-react";

type Status = "now" | "partial" | "no";
const ROWS: [string, string, string, Status][] = [
  ["Delivery drivers", "No desk, no Slack, no time to open an app mid-shift", "Opt-in SMS at 6:30am: quiet unloading windows for their own streets, from the crowd model. Works on any phone", "now"],
  ["Shop and café owners", "Won't run a sensor dashboard", "Phone home screen: people past their window each hour vs last week, with rostering and opening-hours tips", "now"],
  ["Hospitality, retail and cleaning staff", "Not on the tech companies' Slack or Teams", "QR codes on café tables and light poles open the phone app. No login, no install", "now"],
  ["People without a smartphone", "Web and map first", "The SMS channel covers drivers today. Other roles by SMS are next", "partial"],
  ["Wheelchair, pram and mobility-aid users", "The coolest route may use narrow or uneven footpaths", "Routes are marked “accessibility not verified”. Kerb and width constraints come next", "partial"],
  ["People with low vision", "The Console is map-first", "Morning Brief, phone cards and SMS are plain text and work with screen readers", "partial"],
  ["Night-time commuters", "“Least crowded” at night can mean deserted", "After 6pm that mode becomes “Lit & lively”", "now"],
  ["Residents", "Built around the weekday commute", "Not covered. On the roadmap", "no"],
  ["Cyclists and motorists", "Walking routes only", "Smart-pole bike and vehicle counts can plug in later", "no"],
  ["Tenants without a street window", "Upstairs offices can't host a node", "Sponsor a street-level shop's node in exchange for data access", "partial"],
  ["Streets without a node", "Data blind spot. The model interpolates", "The map shows modelled vs measured, never fake precision", "partial"],
];
const STATUS: Record<Status, string> = { now: "covered", partial: "partly", no: "not yet" };

export default function LimitsPanel() {
  return (
    <div className="limits">
      <h3><Users size={14} /> Who it does not serve (yet)</h3>
      <div className="who-list">
        {ROWS.map(([who, why, fix, st]) => (
          <div key={who} className={`who-row ${st}`}>
            <div className="who-top"><b>{who}</b><span className={`status ${st}`}>{STATUS[st]}</span></div>
            <span className="why">{why}</span>
            <span className="fix">→ {fix}</span>
          </div>
        ))}
      </div>

      <h3><Lock size={14} /> Privacy by construction</h3>
      <ul className="method">
        <li>Nodes send <code>{"{node_id, ts, count_in, count_out, temp_c, rh, noise_db}"}</code>. The server rejects any other field, so there is no image field to fill.</li>
        <li>Frames live in memory for one loop iteration. The production node uses mmWave radar, so it can't see faces at all.</li>
        <li>No Wi-Fi or Bluetooth MAC sniffing. It would count better, but it can track individuals.</li>
        <li>Phone app: no account. Role, station and building stay in the phone's own storage. Requests carry place ids, never GPS, and are answered then discarded.</li>
        <li>SMS: opt-in only (text JOIN). We keep only the streets you pick, not your location. Reply CHANGE to switch role, STOP to leave and delete.</li>
        <li>Each tenant owns its node's data. Only precinct-level totals are shared.</li>
      </ul>

      <h3><Globe2 size={14} /> Sovereignty</h3>
      <ul className="method">
        <li>Everything runs on this laptop: shadow model, router, crowd model, what-if engine and the open-weights LLM (Ollama). No cloud AI.</li>
        <li>The LLM only rewords text. Every number on the phone and in the brief comes from the backend, and a rewrite that changes a number is thrown away.</li>
        <li>SMS gateways are usually overseas (e.g. Twilio). The demo simulates the texts on screen. In production we'd swap in an Australian-hosted SMS gateway, and texts carry only public street-level information.</li>
        <li>Open data only: OpenStreetMap, City of Yarra trees, PTV timetable. Basemap tiles can be self-hosted with Protomaps PMTiles.</li>
      </ul>

      <h3><Scale size={14} /> What-if plans are estimates</h3>
      <ul className="method">
        <li>New trees take ~15 years to reach full canopy, but the brief asks for impact inside 12 months with existing assets. The maturity slider shows both. Sails and awnings are the 12-month options.</li>
        <li>Costs are indicative planning ranges, not quotes. A new footpath tree pit can cost several times a nature-strip planting.</li>
        <li>Closures reroute walkers but don't yet redistribute the crowd model.</li>
      </ul>

      <h3><Wallet size={14} /> Pilot cost</h3>
      <table className="report">
        <tbody>
          <tr><td>30 × window node (ESP32-S3, 24 GHz mmWave, temp/RH, I²S mic, case)</td><td>≈ A$1,800</td></tr>
          <tr><td>Local server at the Hub (mini PC)</td><td>≈ A$1,000</td></tr>
          <tr><td>SMS, Australian gateway (≈ 200 drivers × 1 text/weekday)</td><td>≈ A$10/day</td></tr>
          <tr><td>Software and models (open source)</td><td>A$0</td></tr>
          <tr><td><b>Total up-front</b></td><td><b>≈ A$2,800</b></td></tr>
        </tbody>
      </table>
    </div>
  );
}

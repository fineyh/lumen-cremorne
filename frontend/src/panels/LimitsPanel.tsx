const ROWS: [string, string, string][] = [
  ["Hospitality, retail, cleaning and delivery workers", "Not on the tech companies' Slack or Teams", "QR codes in cafés and on light poles open a no-login web version"],
  ["Wheelchair, pram and mobility-aid users", "The coolest route may use narrow or uneven footpaths", "MVP marks routes “accessibility not verified”. Kerb and width constraints come next"],
  ["People with low vision", "The interface is map-first", "Morning Brief is plain text and works with screen readers"],
  ["Night-time commuters", "“Least crowded” at night can mean deserted", "After 6pm that mode becomes “Lit & lively”"],
  ["Residents", "Built around the weekday commute", "Not covered. On the roadmap"],
  ["Cyclists and drivers", "Walking routes only", "Smart-pole bike and vehicle counts can plug in later"],
  ["Tenants without a street window", "Upstairs offices can't host a node", "Sponsor a street-level shop's node in exchange for data access"],
  ["Streets without a node", "Data blind spot. The model interpolates", "The map shows modelled vs measured, never fake precision"],
];

export default function LimitsPanel() {
  return (
    <div className="limits">
      <h3>Who it does not serve</h3>
      <div className="who-list">
        {ROWS.map(([who, why, fix]) => (
          <div key={who} className="who-row">
            <b>{who}</b>
            <span className="why">{why}</span>
            <span className="fix">→ {fix}</span>
          </div>
        ))}
      </div>

      <h3>Privacy by construction</h3>
      <ul className="method">
        <li>Nodes send <code>{"{node_id, ts, count_in, count_out, temp_c, rh, noise_db}"}</code>. The server rejects any other field, so there is no image field to fill.</li>
        <li>Frames live in memory for one loop iteration. The production node uses mmWave radar, so it can't see faces at all.</li>
        <li>No Wi-Fi or Bluetooth MAC sniffing. It would count better, but it can track individuals.</li>
        <li>Ask Lumen and routing requests are answered and discarded. No locations are stored.</li>
        <li>Each tenant owns its node's data. Only precinct-level totals are shared.</li>
      </ul>

      <h3>Sovereignty</h3>
      <ul className="method">
        <li>Everything runs on this laptop: shadow model, router, crowd model and the open-weights LLM (Ollama). No cloud AI.</li>
        <li>Open data only: OpenStreetMap, City of Yarra trees, PTV timetable. Basemap tiles can be self-hosted with Protomaps PMTiles.</li>
        <li>Slack is an overseas service, so the Slack brief carries only public precinct information. Stricter tenants get the self-hosted web view or Mattermost.</li>
      </ul>

      <h3>Pilot cost</h3>
      <table className="report">
        <tbody>
          <tr><td>30 × window node (ESP32-S3, 24 GHz mmWave, temp/RH, I²S mic, case)</td><td>≈ A$1,800</td></tr>
          <tr><td>Local server at the Hub (mini PC)</td><td>≈ A$1,000</td></tr>
          <tr><td>Software and models (open source)</td><td>A$0</td></tr>
          <tr><td><b>Total</b></td><td><b>≈ A$2,800</b></td></tr>
        </tbody>
      </table>
    </div>
  );
}

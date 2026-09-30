import { useEffect, useState } from "react";
import {
  ArrowRight, Axe, Clock, Construction, Download, Eraser, FolderOpen, Info, Loader2, Save, Sparkles, Sun, Tent,
  Trash2, TreeDeciduous, Undo2, Users, Wallet, Store,
} from "lucide-react";
import {
  aud, audRange, del, fmtTime, get, post, type Draft, type Meta, type SavedPlan, type SideBySide, type Tool,
  type TreeSize, type WhatIfResponse,
} from "../api";

type Props = {
  meta: Meta;
  draft: Draft;
  setDraft: (d: Draft | ((d: Draft) => Draft)) => void;
  undo: () => void;
  canUndo: boolean;
  tool: Tool | null;
  setTool: (t: Tool | null) => void;
  treeSize: TreeSize;
  setTreeSize: (s: TreeSize) => void;
  res: WhatIfResponse | null;
  busy: boolean;
  scenario: string;
  minutes: number;
  onShowRoutes: () => void;
};

const SIZE_LABEL: Record<TreeSize, string> = { small: "S", medium: "M", large: "L" };

export const TOOL_INFO: Record<Tool, { label: string; icon: typeof Sun; hint: (s: TreeSize) => string; cost?: string; quick?: boolean }> = {
  tree: { label: "Plant tree", icon: TreeDeciduous, hint: (s) => `Click to plant a ${s} tree`, cost: "tree" },
  sail: { label: "Shade sail", icon: Tent, hint: () => "Click to put up a 6 × 6 m shade sail", cost: "sail", quick: true },
  awning: { label: "Awning", icon: Store, hint: () => "Click beside a shopfront to add a 12 m awning", cost: "awning", quick: true },
  remove_tree: { label: "Remove tree", icon: Axe, hint: () => "Click an existing tree canopy to remove it", cost: "remove_tree", quick: true },
  closure: { label: "Close block", icon: Construction, hint: () => "Click a footpath to close that block for works", cost: "closure", quick: true },
  erase: { label: "Erase", icon: Eraser, hint: () => "Click one of your changes to undo it" },
};
const TOOLS: Tool[] = ["tree", "sail", "awning", "remove_tree", "closure", "erase"];
const KIND_LABEL: Record<string, string> = {
  "tree:small": "Small trees", "tree:medium": "Medium trees", "tree:large": "Large trees", tree: "Trees",
  sail: "Shade sails", awning: "Awnings", remove_tree: "Tree removals", closure: "Closed blocks",
};

const sgn = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;

export default function WhatIfPanel(p: Props) {
  const { meta, draft, res } = p;
  const wi = meta.whatif;
  const [saved, setSaved] = useState<SavedPlan[]>([]);
  const [name, setName] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [sbs, setSbs] = useState<SideBySide[] | null>(null);
  const [sbsBusy, setSbsBusy] = useState(false);

  const loadSaved = () => get<SavedPlan[]>("/api/whatif/plans", false).then(setSaved).catch(() => setSaved([]));
  useEffect(() => { loadSaved(); }, []);
  useEffect(() => { setSbs(null); }, [p.scenario, p.minutes]);

  const costOf = (t: Tool) => {
    if (t === "tree") return wi.costs[`tree:${p.treeSize}`];
    const k = TOOL_INFO[t].cost;
    return k ? wi.costs[k] : null;
  };
  const growth = Math.min(1, 0.2 + (0.8 * Math.min(draft.years, wi.mature_years)) / wi.mature_years);
  const canopyNow = (s: TreeSize) => Math.max(1, wi.tree_sizes[s].r * growth);

  const save = async () => {
    if (!draft.items.length) return;
    await post("/api/whatif/plans", { name: name || `Plan ${saved.length + 1}`, items: draft.items, years: draft.years });
    setName("");
    loadSaved();
  };
  const compare = async () => {
    if (!sel.length) return;
    setSbsBusy(true);
    try {
      setSbs(await get<SideBySide[]>(`/api/whatif/side-by-side?ids=${sel.join(",")}&scenario=${p.scenario}&t=${p.minutes}`, false));
    } finally {
      setSbsBusy(false);
    }
  };
  const exportDraft = async () => {
    const r = await fetch("/api/whatif/export.csv", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: draft.items, years: draft.years, name: name || "Current draft" }),
    });
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: "lumen-whatif-draft.csv" });
    a.click();
    URL.revokeObjectURL(url);
  };

  const r = res?.result;
  return (
    <div className="whatif">
      <div className="wi-intro">
        <Sparkles size={16} />
        <p>Change one thing on the map and see what it does to every station → workplace walk. Base data is never modified.</p>
      </div>

      <div className="sec-h"><span>Tools</span><span className="est-badge">Model estimate</span></div>
      <div className="tools">
        {TOOLS.map((t) => {
          const I = TOOL_INFO[t].icon;
          const c = costOf(t);
          return (
            <button key={t} className={`tool ${p.tool === t ? "on" : ""} ${t === "erase" ? "erase" : ""}`} onClick={() => p.setTool(p.tool === t ? null : t)}>
              <I size={18} />
              <b>{TOOL_INFO[t].label}</b>
              <small>{c ? `${audRange(c[0], c[1])}${t === "closure" ? "/day" : ""}` : "click a change"}</small>
              {TOOL_INFO[t].quick && <span className="quick">≤ 12 mo</span>}
            </button>
          );
        })}
      </div>
      {p.tool === "tree" && (
        <div className="tree-size">
          <span>Size</span>
          <div className="seg">
            {(Object.keys(SIZE_LABEL) as TreeSize[]).map((s) => (
              <button key={s} className={p.treeSize === s ? "on" : ""} onClick={() => p.setTreeSize(s)}>
                {SIZE_LABEL[s]} · {wi.tree_sizes[s].r * 2} m
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="maturity card-s">
        <div className="mat-h">
          <Clock size={15} />
          <b>Trees at year {draft.years}</b>
          <span className={draft.years <= 1 ? "pill warn" : draft.years >= wi.mature_years ? "pill good" : "pill"}>
            {draft.years <= 1 ? "inside the 12-month window" : draft.years >= wi.mature_years ? "mature canopy" : "still growing"}
          </span>
        </div>
        <input type="range" min={1} max={20} step={1} value={draft.years}
          onChange={(e) => p.setDraft((d) => ({ ...d, years: Number(e.target.value) }))} />
        <div className="mat-marks"><span>1 yr</span><span>5</span><span>10</span><span>15 · mature</span><span>20</span></div>
        <p className="fine">
          A new {p.treeSize} tree shades a {(canopyNow(p.treeSize) * 2).toFixed(1)} m circle now, {wi.tree_sizes[p.treeSize].r * 2} m when mature.
          Sails and awnings give full shade from day one, so they fit the 12-month brief.
        </p>
      </div>

      {!draft.items.length && (
        <div className="empty">
          <TreeDeciduous size={28} />
          <p>Pick a tool, then click the map. Try planting three large trees along Cremorne St, or a shade sail outside Richmond Station.</p>
        </div>
      )}

      {draft.items.length > 0 && (
        <div className="changes">
          <div className="sec-h">
            <span>{draft.items.length} change{draft.items.length > 1 ? "s" : ""}</span>
            <span className="row-btns">
              <button className="txt-btn" disabled={!p.canUndo} onClick={p.undo}><Undo2 size={13} /> Undo</button>
              <button className="txt-btn danger" onClick={() => p.setDraft((d) => ({ ...d, items: [] }))}><Trash2 size={13} /> Clear</button>
            </span>
          </div>
          <div className="kind-chips">
            {Object.entries(res?.plan.cost.by_kind ?? {}).map(([k, v]) => (
              <span key={k} className="kchip">{v.n} × {KIND_LABEL[k] ?? k}</span>
            ))}
          </div>
        </div>
      )}

      {draft.items.length > 0 && r && (
        <div className={`results ${p.busy ? "stale" : ""}`}>
          <div className="res-h">
            <span>Before → after · {r.time}, {r.temp_c}°C</span>
            {p.busy ? <Loader2 size={14} className="spin" /> : <small>{r.trips_recomputed}/{r.trips_total} trips re-computed · {r.compute_ms} ms</small>}
          </div>
          {!r.sun_up && <p className="note"><Info size={14} /> The sun is down at {r.time}. Move the time slider to see shade effects.</p>}

          <div className="hero-delta">
            <div className="hd-main">
              <small><Sun size={13} /> Sun on usual walks</small>
              <div className="hd-val">
                <span className="b4">{r.usual.sun_min[0].toFixed(0)}</span>
                <ArrowRight size={16} />
                <span className="af">{r.usual.sun_min[1].toFixed(0)}</span>
                <em>min</em>
              </div>
              <div className={`hd-delta ${r.usual.sun_min_saved > 0.05 ? "good" : r.usual.sun_min_saved < -0.05 ? "bad" : ""}`}>
                {r.usual.sun_min_saved > 0 ? "−" : r.usual.sun_min_saved < 0 ? "+" : ""}{Math.abs(r.usual.sun_min_saved).toFixed(1)} min in the sun
              </div>
              <small className="hd-foot">summed over {r.trips_total} station → workplace walks, shortest route</small>
            </div>
            <div className="hd-side">
              <b>{r.trips_benefit}</b>
              <small>routes benefit</small>
              <div className="meter"><i style={{ width: `${Math.min(100, (100 * r.trips_benefit) / r.trips_total)}%` }} /></div>
              <small className="muted">of {r.trips_total}</small>
            </div>
          </div>

          <div className="delta-grid">
            <Delta label="Comfort Score" icon={Sparkles} a={r.precinct.comfort[0]} b={r.precinct.comfort[1]} unit="" d={1} />
            <Delta label="Paths with shaded side" icon={TreeDeciduous} a={100 * r.precinct.shaded_share[0]} b={100 * r.precinct.shaded_share[1]} unit="%" d={1} />
            <Delta label="Detour to stay cool" icon={Users} a={r.coolest.walk_min[0] - r.usual.walk_min[0]} b={r.coolest.walk_min[1] - r.usual.walk_min[1]} unit=" min" d={1} lowerIsBetter />
            <Delta label="Coolest routes: sun" icon={Sun} a={r.coolest.sun_min[0]} b={r.coolest.sun_min[1]} unit=" min" d={1} neutral />
          </div>
          {r.usual.trips_detoured > 0 && (
            <p className="note warn"><Construction size={14} /> Closures detour {r.usual.trips_detoured} usual walks by a median {r.usual.median_detour_min.toFixed(1)} min.
              {r.usual.unreachable > 0 && ` ${r.usual.unreachable} become unreachable.`}</p>
          )}
          {!r.heat_matters && r.sun_up && <p className="note"><Info size={14} /> Below 24°C Lumen doesn't route around the sun, so only sun minutes on usual walks change.</p>}

          <div className="cost card-s">
            <div className="cost-h"><Wallet size={16} /><b>Indicative cost</b><span className="cost-big">
              {r.cost.high > 0 ? audRange(r.cost.low, r.cost.high) : r.cost.closure_per_day ? `${audRange(...r.cost.closure_per_day)}/day` : "A$0"}
            </span></div>
            <ul className="cost-lines">
              {Object.entries(r.cost.by_kind).map(([k, v]) => (
                <li key={k}><span>{v.n} × {KIND_LABEL[k] ?? k}</span><span>{audRange(v.low, v.high)}{k === "closure" ? " /day" : ""}</span></li>
              ))}
            </ul>
            <div className="cost-kpis">
              <div><b>{r.cost.value?.aud_per_route_improved ? aud(r.cost.value.aud_per_route_improved) : "–"}</b><small>per route improved</small></div>
              <div><b>{r.usual.person_sun_min_saved.toLocaleString()}</b><small>person-min less sun, this walk*</small></div>
              <div><b>{r.cost.quick_win_mid ? aud(r.cost.quick_win_mid) : "A$0"}</b><small>deliverable in 12 months (sails, awnings)</small></div>
            </div>
            <p className="fine">{meta.whatif.cost_note} *If each of the 10,000 workers made this walk once at {fmtTime(r.minutes)}.</p>
          </div>

          {r.top.length > 0 && (
            <>
              <div className="sec-h"><span>Walks that change most</span></div>
              <ul className="top-trips">
                {r.top.map((t, i) => (
                  <li key={i}>
                    <div><b>{t.origin.replace(" Station", "").replace(" (tram)", "")}</b> → {t.destination}<small>{t.route}</small></div>
                    <span className={t.sun_min_after < t.sun_min_before ? "good" : "bad"}>
                      {t.sun_min_before.toFixed(1)} → {t.sun_min_after.toFixed(1)} min sun
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="map-key">
            <span><i className="k more" /> more shade</span><span><i className="k less" /> less shade</span>
            <span><i className="k closed" /> closed</span><span><i className="k newsh" /> new shadow</span>
          </div>
          <button className="btn ghost-btn" onClick={p.onShowRoutes}>See routes with this plan <ArrowRight size={14} /></button>
        </div>
      )}

      <div className="sec-h"><span>Save &amp; compare</span></div>
      <div className="save-row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this plan, e.g. Cremorne St canopy" />
        <button className="btn primary" disabled={!draft.items.length} onClick={save}><Save size={14} /> Save</button>
      </div>
      {draft.items.length > 0 && <button className="txt-btn" onClick={exportDraft}><Download size={13} /> Export this draft as CSV</button>}

      {saved.length > 0 && (
        <ul className="saved">
          {saved.map((s) => (
            <li key={s.id} className={sel.includes(s.id) ? "on" : ""}>
              <label>
                <input type="checkbox" checked={sel.includes(s.id)} onChange={(e) => setSel(e.target.checked ? [...sel, s.id] : sel.filter((x) => x !== s.id))} />
                <span><b>{s.name}</b><small>{s.items.length} changes · trees at yr {s.years}</small></span>
              </label>
              <button className="icon-only" title="Load onto the map" onClick={() => p.setDraft({ items: s.items, years: s.years })}><FolderOpen size={15} /></button>
              <button className="icon-only" title="Delete" onClick={() => del(`/api/whatif/plans/${s.id}`).then(loadSaved)}><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
      )}
      {saved.length > 0 && (
        <div className="row-btns">
          <button className="btn" disabled={!sel.length || sbsBusy} onClick={compare}>{sbsBusy ? <Loader2 size={14} className="spin" /> : null} Compare side by side</button>
          <a className={`btn ${sel.length ? "" : "disabled"}`} href={sel.length ? `/api/whatif/export.csv?ids=${sel.join(",")}` : undefined} download>
            <Download size={14} /> Council CSV
          </a>
        </div>
      )}
      {sbs && sbs.length > 0 && <SideBySideTable rows={sbs} />}
    </div>
  );
}

function Delta({ label, icon: I, a, b, unit, d, lowerIsBetter, neutral }: { label: string; icon: typeof Sun; a: number; b: number; unit: string; d: number; lowerIsBetter?: boolean; neutral?: boolean }) {
  const diff = b - a;
  // "neutral": a trade-off, e.g. shorter cool detours may keep a little more sun
  const good = !neutral && (lowerIsBetter ? diff < -0.05 : diff > 0.05);
  const bad = !neutral && (lowerIsBetter ? diff > 0.05 : diff < -0.05);
  return (
    <div className="delta">
      <small><I size={12} /> {label}</small>
      <div><span className="muted">{a.toFixed(d)}</span> → <b>{b.toFixed(d)}{unit}</b></div>
      <span className={`dchip ${good ? "good" : bad ? "bad" : ""}`}>{sgn(diff, d)}{unit}</span>
    </div>
  );
}

function SideBySideTable({ rows }: { rows: SideBySide[] }) {
  const R = rows.map((x) => x.result);
  const line = (label: string, f: (r: SideBySide) => string) => (
    <tr><th>{label}</th>{rows.map((r) => <td key={r.id}>{f(r)}</td>)}</tr>
  );
  const best = Math.max(...R.map((r) => r.usual.sun_min_saved));
  return (
    <div className="sbs">
      <div className="sec-h"><span>Side by side · {R[0].time}, {R[0].temp_c}°C</span><span className="est-badge">Model estimate</span></div>
      <div className="sbs-scroll">
        <table>
          <thead><tr><th />{rows.map((r) => <th key={r.id}>{r.name}</th>)}</tr></thead>
          <tbody>
            {line("Changes", (r) => `${r.plan.n_items} · yr ${r.plan.years}`)}
            {line("Cost", (r) => audRange(r.result.cost.low, r.result.cost.high))}
            <tr><th>Sun saved, usual walks</th>{rows.map((r) => <td key={r.id} className={r.result.usual.sun_min_saved === best && best > 0 ? "best" : ""}>{r.result.usual.sun_min_saved.toFixed(1)} min</td>)}</tr>
            {line("Routes that benefit", (r) => `${r.result.trips_benefit} / ${r.result.trips_total}`)}
            {line("Comfort Score", (r) => `${r.result.precinct.comfort[0]} → ${r.result.precinct.comfort[1]}`)}
            {line("Shaded paths", (r) => `${(100 * r.result.precinct.shaded_share[1]).toFixed(1)}%`)}
            {line("A$ per route improved", (r) => (r.result.cost.value?.aud_per_route_improved ? aud(r.result.cost.value.aud_per_route_improved) : "–"))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

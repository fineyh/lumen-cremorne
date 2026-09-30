import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource, MapMouseEvent, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { LOS, LOS_COLORS, LOS_TEXT, MODE_COLORS, get, type MarkedStreet, type Meta, type Route, type State, type Tool } from "./api";

export type LayerToggles = {
  shadows: boolean;
  trees: boolean;
  network: "shade" | "crowd" | "comfort" | "off";
  buildings3d: boolean;
  nodes: boolean;
  poles: boolean;
};

export type EditClick = { lngLat: [number, number]; treeIndex?: number; itemIndex?: number };

type Props = {
  meta: Meta;
  state: State | null;
  shadows: GeoJSON.FeatureCollection | null;
  routes: Route[];
  selectedMode: string;
  toggles: LayerToggles;
  from: [number, number] | null;
  to: [number, number] | null;
  pickMode: "from" | "to" | null;
  onPick: (lngLat: [number, number]) => void;
  // what-if
  editTool: Tool | null;
  onEdit: (e: EditClick) => void;
  overlay: GeoJSON.FeatureCollection | null;
  newShadows: GeoJSON.FeatureCollection | null;
  changed: [number, number][];
  sidePad: number;
  // Ask Lumen: streets the answer names
  marked: MarkedStreet[];
};

maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const BASEMAP = "https://tiles.openfreemap.org/styles/positron";
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#eceee9" } }],
};

async function loadStyle(): Promise<StyleSpecification | string> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch(BASEMAP, { signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) return (await r.json()) as StyleSpecification;
  } catch {
    /* offline: draw on our own data only */
  }
  return FALLBACK_STYLE;
}

// metres -> pixels at Cremorne's latitude (512 px tiles: 4.24 px per metre at z18)
// (zoom must stay the top-level input, so a minimum size goes inside each stop)
const metres = (m: ExpressionSpecification | number, minPx = 0): ExpressionSpecification => [
  "interpolate", ["exponential", 2], ["zoom"], 13, ["max", minPx, ["*", m, 0.1325]], 20, ["max", minPx, ["*", m, 16.96]],
];

const shadeColor: ExpressionSpecification = [
  "interpolate", ["linear"], ["coalesce", ["feature-state", "shade"], 0],
  0, "#f59e0b", 0.35, "#f4c06a", 0.65, "#7aa7d6", 1, "#1e4e8c",
];
const crowdColor: ExpressionSpecification = [
  "match", ["coalesce", ["feature-state", "los"], 0],
  0, LOS_COLORS[0], 1, LOS_COLORS[1], 2, LOS_COLORS[2], 3, LOS_COLORS[3], 4, LOS_COLORS[4], 5, LOS_COLORS[5], "#999",
];
const comfortColor: ExpressionSpecification = [
  "interpolate", ["linear"], ["coalesce", ["feature-state", "comfort"], 100],
  40, "#e11d48", 60, "#f97316", 75, "#facc15", 90, "#34d399", 100, "#0d9488",
];
const shadeWidth: ExpressionSpecification = [
  "interpolate", ["linear"], ["zoom"], 14, ["case", ["get", "inside"], 1.4, 0.8], 17, ["case", ["get", "inside"], 4.5, 2],
];
const crowdWidth: ExpressionSpecification = [
  "interpolate", ["linear"], ["zoom"],
  14, ["+", 1, ["*", 0.8, ["coalesce", ["feature-state", "los"], 0]]],
  17, ["+", 2.5, ["*", 2, ["coalesce", ["feature-state", "los"], 0]]],
];
// halo colours sit apart from both the shade ramp and the LOS greens and reds
const MARK_COLORS: Record<MarkedStreet["tone"], string> = { busy: "#be123c", quiet: "#2563eb", hot: "#dc2626" };
const diffOpacity: ExpressionSpecification = ["case", [">", ["abs", ["coalesce", ["feature-state", "delta"], 0]], 0.01], 0.95, 0];
const diffColor: ExpressionSpecification = [
  "interpolate", ["linear"], ["coalesce", ["feature-state", "delta"], 0],
  -0.6, "#e11d48", -0.01, "#fb7185", 0.01, "#34d399", 0.6, "#047857",
];

export default function MapView(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const poleEls = useRef<HTMLDivElement[]>([]);
  const fromMarker = useRef<maplibregl.Marker | null>(null);
  const toMarker = useRef<maplibregl.Marker | null>(null);
  const prevChanged = useRef<number[]>([]);
  const networkFc = useRef<GeoJSON.FeatureCollection | null>(null);
  const markTags = useRef<maplibregl.Marker[]>([]);
  const propsRef = useRef(p);
  propsRef.current = p;

  // ------------------------------------------------------------------ init
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // fetch our layers in parallel with the basemap; don't wait for basemap tiles
      const layers = Promise.all([
        get<GeoJSON.FeatureCollection>("/api/layers/network"),
        get<GeoJSON.FeatureCollection>("/api/layers/buildings"),
        get<GeoJSON.FeatureCollection>("/api/layers/trees"),
      ]);
      const style = await loadStyle();
      if (cancelled || !el.current) return;
      const map = new maplibregl.Map({
        container: el.current,
        style,
        center: p.meta.center,
        zoom: 15.9,
        minZoom: 13,
        maxZoom: 19.5,
        attributionControl: false,
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
      map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "© OpenStreetMap contributors · City of Yarra open data" }), "bottom-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

      map.once("style.load", async () => {
        // our own building footprints replace the basemap's
        for (const l of map.getStyle().layers ?? []) {
          if (l.id.includes("building")) map.setLayoutProperty(l.id, "visibility", "none");
        }
        const [network, buildings, trees] = await layers;
        if (cancelled) return;
        networkFc.current = network;
        map.addSource("shadows", { type: "geojson", data: EMPTY });
        map.addSource("wi-shadows", { type: "geojson", data: EMPTY });
        map.addSource("network", { type: "geojson", data: network });
        map.addSource("buildings", { type: "geojson", data: buildings });
        map.addSource("trees", { type: "geojson", data: trees });
        map.addSource("routes", { type: "geojson", data: EMPTY });
        map.addSource("nodes", { type: "geojson", data: EMPTY });
        map.addSource("overlay", { type: "geojson", data: EMPTY });

        map.addLayer({ id: "shadows", type: "fill", source: "shadows", paint: { "fill-color": "#15294a", "fill-opacity": 0.3 } });
        map.addLayer({ id: "wi-shadows", type: "fill", source: "wi-shadows", paint: { "fill-color": "#065f46", "fill-opacity": 0.38 } });
        map.addLayer({
          id: "trees", type: "circle", source: "trees",
          paint: {
            "circle-color": "#3f8f4f", "circle-opacity": 0.32, "circle-stroke-width": 0,
            "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 14, ["*", ["get", "r"], 0.25], 18, ["*", ["get", "r"], 4]],
          },
        });
        // Ask Lumen: a halo under the streets an answer names, so the layer colour stays readable on top
        map.addLayer({
          id: "marked", type: "line", source: "network", filter: ["==", ["get", "id"], -1],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#000", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 7, 17, 18], "line-opacity": 0.5, "line-blur": 1 },
        });
        map.addLayer({
          id: "network", type: "line", source: "network",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": shadeColor, "line-width": shadeWidth, "line-opacity": ["case", ["get", "inside"], 0.95, 0.3] },
        });
        // what-if: segments whose shade changed (green = more shade, red = less)
        map.addLayer({
          id: "wi-diff-glow", type: "line", source: "network",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 5, 18, 14], "line-opacity": diffOpacity },
        });
        map.addLayer({
          id: "wi-diff", type: "line", source: "network",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": diffColor, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 2.5, 18, 8], "line-opacity": diffOpacity },
        });
        map.addLayer({
          id: "buildings-flat", type: "fill", source: "buildings",
          paint: { "fill-color": "#d9d6cf", "fill-outline-color": "#bcb7ad", "fill-opacity": 0.92 },
        });
        map.addLayer({
          id: "buildings-3d", type: "fill-extrusion", source: "buildings",
          layout: { visibility: "none" },
          paint: { "fill-extrusion-color": "#e2ded6", "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 0.88 },
        });
        // what-if interventions
        map.addLayer({
          id: "wi-closure", type: "line", source: "overlay", filter: ["==", ["get", "kind"], "closure"],
          layout: { "line-cap": "butt" },
          paint: { "line-color": "#e11d48", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 3, 18, 9], "line-dasharray": [1.2, 0.8] },
        });
        map.addLayer({
          id: "wi-canopy", type: "fill", source: "overlay", filter: ["in", ["get", "kind"], ["literal", ["sail", "awning"]]],
          paint: { "fill-color": "#fde68a", "fill-opacity": 0.9, "fill-outline-color": "#b45309" },
        });
        map.addLayer({
          id: "wi-tree-mature", type: "circle", source: "overlay", filter: ["==", ["get", "kind"], "tree"],
          paint: { "circle-radius": metres(["get", "r_mature"]), "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#059669", "circle-stroke-width": 1.2, "circle-stroke-opacity": 0.7 },
        });
        map.addLayer({
          id: "wi-tree", type: "circle", source: "overlay", filter: ["==", ["get", "kind"], "tree"],
          paint: { "circle-radius": metres(["get", "r"]), "circle-color": "#10b981", "circle-opacity": 0.75, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 },
        });
        map.addLayer({
          id: "wi-removed", type: "circle", source: "overlay", filter: ["==", ["get", "kind"], "remove_tree"],
          paint: { "circle-radius": metres(["get", "r"], 6), "circle-color": "rgba(225,29,72,0.15)", "circle-stroke-color": "#e11d48", "circle-stroke-width": 2 },
        });
        map.addLayer({
          id: "routes-casing", type: "line", source: "routes",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": ["case", ["get", "selected"], 11, 7], "line-opacity": ["case", ["get", "selected"], 0.95, 0.6] },
        });
        map.addLayer({
          id: "routes", type: "line", source: "routes",
          layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["case", ["get", "selected"], 10, 0] },
          paint: {
            "line-color": ["get", "color"],
            "line-width": ["case", ["get", "selected"], 6.5, 3.5],
            "line-opacity": ["case", ["get", "selected"], 1, 0.55],
            "line-dasharray": ["case", ["get", "selected"], ["literal", [1, 0]], ["literal", [1.5, 1.2]]],
          },
        });
        map.addLayer({
          id: "nodes", type: "circle", source: "nodes",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 5, 17, 9],
            "circle-color": ["get", "color"],
            "circle-stroke-color": "#0b1324", "circle-stroke-width": 2,
          },
        });

        // council smart poles (locations only: their data isn't published)
        const { sensors, items } = propsRef.current.meta.poles;
        poleEls.current = items.map((pole) => {
          const d = document.createElement("div");
          d.className = "pole-marker";
          d.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 15V3.5a2 2 0 0 1 2-2h3.5M11.5 1.5v3"/><path d="M4 15h4"/></svg>`;
          const pop = new maplibregl.Popup({ closeButton: false, className: "edge-pop", offset: 14 }).setHTML(
            `<b>${pole.landmark}</b><div class="pp-row"><span>${pole.address}</span><span>Yarra smart pole</span></div>` +
              `<div class="pp-row"><span>${sensors.slice(0, 2).join(" · ")}</span></div>` +
              `<div class="pp-note">Council sensor · data not published</div>`,
          );
          d.addEventListener("mouseenter", () => pop.setLngLat([pole.lon, pole.lat]).addTo(map));
          d.addEventListener("mouseleave", () => pop.remove());
          new maplibregl.Marker({ element: d }).setLngLat([pole.lon, pole.lat]).addTo(map);
          return d;
        });

        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "edge-pop", offset: 10 });
        map.on("mousemove", "network", (e) => {
          const f = e.features?.[0];
          const st = propsRef.current.state;
          if (!f || !st || propsRef.current.editTool) return;
          map.getCanvas().style.cursor = propsRef.current.pickMode ? "crosshair" : "pointer";
          const i = f.properties.id as number;
          const los = st.edges.los[i];
          const shade = st.sun.up ? `${Math.round(st.edges.shade[i] * 100)}% shaded` : "sun down";
          const delta = propsRef.current.changed.find((c) => c[0] === i);
          popup
            .setLngLat(e.lngLat)
            .setHTML(
              `<b>${f.properties.name}</b><div class="pp-row"><span>${shade}</span><span style="color:${LOS_COLORS[los]}">LOS ${LOS[los]} · ${LOS_TEXT[los].toLowerCase()}</span></div>` +
                `<div class="pp-row"><span>Comfort ${st.edges.comfort?.[i] ?? "–"}/100</span><span>${st.edges.per_m[i]} ppl/min/m</span></div>` +
                (delta ? `<div class="pp-delta ${delta[1] > 0 ? "up" : "down"}">What-if: ${delta[1] > 0 ? "+" : ""}${Math.round(delta[1] * 100)} pts shade</div>` : ""),
            )
            .addTo(map);
        });
        map.on("mouseleave", "network", () => {
          map.getCanvas().style.cursor = cursorFor();
          popup.remove();
        });
        map.on("click", (e) => onClick(map, e));
        ready.current = true;
        applyAll();
      });
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      ready.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cursorFor() {
    const { pickMode, editTool } = propsRef.current;
    if (editTool === "erase" || editTool === "remove_tree") return "pointer";
    return pickMode || editTool ? "crosshair" : "";
  }

  function onClick(map: maplibregl.Map, e: MapMouseEvent) {
    const { pickMode, editTool, onPick, onEdit } = propsRef.current;
    const ll: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    if (pickMode) return onPick(ll);
    if (!editTool) return;
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]];
    if (editTool === "erase") {
      const f = map.queryRenderedFeatures(box, { layers: ["wi-tree", "wi-canopy", "wi-removed", "wi-closure"] })[0];
      if (f) onEdit({ lngLat: ll, itemIndex: f.properties.i as number });
      return;
    }
    if (editTool === "remove_tree") {
      const fs = map.queryRenderedFeatures(box, { layers: ["trees"] });
      if (!fs.length) return;
      // nearest canopy centre to the click
      const best = fs.reduce((a, f) => {
        const c = (f.geometry as GeoJSON.Point).coordinates;
        const d = (c[0] - ll[0]) ** 2 + (c[1] - ll[1]) ** 2;
        return d < a.d ? { d, i: f.properties.i as number } : a;
      }, { d: Infinity, i: -1 });
      if (best.i >= 0) onEdit({ lngLat: ll, treeIndex: best.i });
      return;
    }
    onEdit({ lngLat: ll });
  }

  // ------------------------------------------------------------------ updates
  function applyEdges() {
    const map = mapRef.current;
    const st = propsRef.current.state;
    if (!map || !ready.current || !st) return;
    const { shade, los, comfort } = st.edges;
    for (let i = 0; i < shade.length; i++) {
      map.setFeatureState({ source: "network", id: i }, { shade: st.sun.up ? shade[i] : 1, los: los[i], comfort: comfort?.[i] ?? 100 });
    }
  }

  function applyDiff() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    for (const i of prevChanged.current) map.setFeatureState({ source: "network", id: i }, { delta: 0 });
    const ch = propsRef.current.changed;
    for (const [i, d] of ch) map.setFeatureState({ source: "network", id: i }, { delta: d });
    prevChanged.current = ch.map((c) => c[0]);
  }

  function applyToggles() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const t = propsRef.current.toggles;
    const vis = (id: string, on: boolean) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("shadows", t.shadows);
    vis("wi-shadows", t.shadows);
    vis("trees", t.trees);
    vis("nodes", t.nodes);
    vis("network", t.network !== "off");
    const color = t.network === "crowd" ? crowdColor : t.network === "comfort" ? comfortColor : shadeColor;
    map.setPaintProperty("network", "line-color", color);
    map.setPaintProperty("network", "line-width", t.network === "crowd" ? crowdWidth : shadeWidth);
    vis("buildings-3d", t.buildings3d);
    vis("buildings-flat", !t.buildings3d);
    for (const d of poleEls.current) d.style.display = t.poles ? "" : "none";
  }

  function applyShadows() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    (map.getSource("shadows") as GeoJSONSource).setData(propsRef.current.shadows ?? EMPTY);
  }

  function applyOverlay() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    (map.getSource("overlay") as GeoJSONSource).setData(propsRef.current.overlay ?? EMPTY);
    (map.getSource("wi-shadows") as GeoJSONSource).setData(propsRef.current.newShadows ?? EMPTY);
  }

  function applyRoutes() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const { routes, selectedMode } = propsRef.current;
    const order = [...routes].sort((a, b) => (a.mode === selectedMode ? 1 : 0) - (b.mode === selectedMode ? 1 : 0));
    (map.getSource("routes") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: order.map((r) => ({
        type: "Feature",
        properties: { mode: r.mode, color: MODE_COLORS[r.mode], selected: r.mode === selectedMode },
        geometry: r.geometry,
      })),
    });
  }

  function applyNodes() {
    const map = mapRef.current;
    const st = propsRef.current.state;
    if (!map || !ready.current || !st) return;
    (map.getSource("nodes") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: st.nodes
        .map((n) => ({
          type: "Feature",
          properties: { id: n.id, color: LOS_COLORS[LOS.indexOf(n.los)] },
          geometry: { type: "Point", coordinates: [n.lon, n.lat] },
        })),
    });
  }

  function applyEndpoints() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const { from, to } = propsRef.current;
    const mk = (ref: React.MutableRefObject<maplibregl.Marker | null>, pos: [number, number] | null, cls: string, label: string) => {
      if (!pos) {
        ref.current?.remove();
        ref.current = null;
        return;
      }
      if (!ref.current) {
        const d = document.createElement("div");
        d.className = `endpoint ${cls}`;
        d.textContent = label;
        ref.current = new maplibregl.Marker({ element: d }).setLngLat(pos).addTo(map);
      } else ref.current.setLngLat(pos);
    };
    mk(fromMarker, from, "from", "A");
    mk(toMarker, to, "to", "B");
  }

  // frame the trip whenever its endpoints change (not when only the time changes)
  const framedFor = useRef("");
  function fitRoutes() {
    const map = mapRef.current;
    const routes = propsRef.current.routes;
    const cs = routes[0]?.geometry.coordinates ?? [];
    const key = `${cs[0]}|${cs[cs.length - 1]}`;
    if (!map || !ready.current || !cs.length || framedFor.current === key) return;
    framedFor.current = key;
    const b = new maplibregl.LngLatBounds();
    for (const route of routes) for (const c of route.geometry.coordinates) b.extend(c);
    map.fitBounds(b, { padding: { top: 110, bottom: 190, left: propsRef.current.sidePad + 40, right: 120 }, maxZoom: 17, duration: 900 });
  }

  function applyMarked() {
    const map = mapRef.current;
    const fc = networkFc.current;
    if (!map || !ready.current || !fc) return;
    for (const m of markTags.current) m.remove();
    markTags.current = [];
    const marked = propsRef.current.marked;
    if (!marked.length) {
      map.setFilter("marked", ["==", ["get", "id"], -1]);
      return;
    }
    const names = marked.map((m) => m.name);
    map.setFilter("marked", ["all", ["get", "inside"], ["in", ["get", "name"], ["literal", names]]]);
    // (built at runtime, so TypeScript can't see the match has at least one label/value pair)
    const color = ["match", ["get", "name"], ...marked.flatMap((m) => [m.name, MARK_COLORS[m.tone]]), "#000"] as unknown as ExpressionSpecification;
    map.setPaintProperty("marked", "line-color", color);

    // name tag at the middle of each street's longest piece, and frame them all
    const b = new maplibregl.LngLatBounds();
    for (const m of marked) {
      let best: number[][] | null = null;
      let bestLen = 0;
      for (const f of fc.features) {
        if (f.properties?.name !== m.name || !f.properties?.inside) continue;
        const cs = (f.geometry as GeoJSON.LineString).coordinates;
        for (const c of cs) b.extend(c as [number, number]);
        let len = 0;
        for (let i = 1; i < cs.length; i++) len += Math.hypot(cs[i][0] - cs[i - 1][0], cs[i][1] - cs[i - 1][1]);
        if (len > bestLen) { bestLen = len; best = cs; }
      }
      if (!best) continue;
      const d = document.createElement("div");
      d.className = `street-tag ${m.tone}`;
      d.textContent = m.name;
      markTags.current.push(new maplibregl.Marker({ element: d }).setLngLat(best[Math.floor(best.length / 2)] as [number, number]).addTo(map));
    }
    if (!b.isEmpty()) {
      map.fitBounds(b, { padding: { top: 140, bottom: 190, left: propsRef.current.sidePad + 60, right: 140 }, maxZoom: 16.8, duration: 900 });
    }
  }

  function applyAll() {
    applyToggles();
    applyEdges();
    applyDiff();
    applyShadows();
    applyOverlay();
    applyRoutes();
    applyNodes();
    applyEndpoints();
    fitRoutes();
    applyMarked();
  }

  useEffect(applyEdges, [p.state]);
  useEffect(applyNodes, [p.state]);
  useEffect(applyShadows, [p.shadows]);
  useEffect(applyOverlay, [p.overlay, p.newShadows]);
  useEffect(applyDiff, [p.changed]);
  useEffect(applyRoutes, [p.routes, p.selectedMode]);
  useEffect(applyEndpoints, [p.from, p.to]);
  useEffect(applyMarked, [p.marked]);

  useEffect(fitRoutes, [p.routes]);
  useEffect(() => {
    applyToggles();
    const map = mapRef.current;
    if (map && ready.current) map.easeTo({ pitch: p.toggles.buildings3d ? 55 : 0, bearing: p.toggles.buildings3d ? -20 : 0, duration: 800 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.toggles]);
  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = cursorFor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.pickMode, p.editTool]);

  return <div ref={el} className="map" />;
}

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { LOS, LOS_COLORS, LOS_TEXT, MODE_COLORS, get, type Meta, type Route, type State } from "./api";

export type LayerToggles = {
  shadows: boolean;
  trees: boolean;
  network: "shade" | "crowd" | "off";
  buildings3d: boolean;
  nodes: boolean;
};

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
  liveCount: number;
  livePerMin: number;
  liveOnline: boolean;
  liveFlash: number;
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

const shadeColor: ExpressionSpecification = [
  "interpolate", ["linear"], ["coalesce", ["feature-state", "shade"], 0],
  0, "#f39c12", 0.35, "#e7b65c", 0.65, "#7ea6c9", 1, "#2f5f8f",
];
const crowdColor: ExpressionSpecification = [
  "match", ["coalesce", ["feature-state", "los"], 0],
  0, LOS_COLORS[0], 1, LOS_COLORS[1], 2, LOS_COLORS[2], 3, LOS_COLORS[3], 4, LOS_COLORS[4], 5, LOS_COLORS[5], "#999",
];
const shadeWidth: ExpressionSpecification = [
  "interpolate", ["linear"], ["zoom"], 14, ["case", ["get", "inside"], 1.4, 0.8], 17, ["case", ["get", "inside"], 4.5, 2],
];
const crowdWidth: ExpressionSpecification = [
  "interpolate", ["linear"], ["zoom"],
  14, ["+", 1, ["*", 0.8, ["coalesce", ["feature-state", "los"], 0]]],
  17, ["+", 2.5, ["*", 2, ["coalesce", ["feature-state", "los"], 0]]],
];

export default function MapView(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const liveMarker = useRef<maplibregl.Marker | null>(null);
  const liveEl = useRef<HTMLDivElement | null>(null);
  const fromMarker = useRef<maplibregl.Marker | null>(null);
  const toMarker = useRef<maplibregl.Marker | null>(null);
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
        maxZoom: 19,
        attributionControl: { compact: true, customAttribution: "© OpenStreetMap contributors · City of Yarra open data" },
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

      map.once("style.load", async () => {
        // our own building footprints replace the basemap's
        for (const l of map.getStyle().layers ?? []) {
          if (l.id.includes("building")) map.setLayoutProperty(l.id, "visibility", "none");
        }
        const [network, buildings, trees] = await layers;
        if (cancelled) return;
        map.addSource("shadows", { type: "geojson", data: EMPTY });
        map.addSource("network", { type: "geojson", data: network });
        map.addSource("buildings", { type: "geojson", data: buildings });
        map.addSource("trees", { type: "geojson", data: trees });
        map.addSource("routes", { type: "geojson", data: EMPTY });
        map.addSource("nodes", { type: "geojson", data: EMPTY });

        map.addLayer({ id: "shadows", type: "fill", source: "shadows", paint: { "fill-color": "#1b3354", "fill-opacity": 0.34 } });
        map.addLayer({
          id: "trees", type: "circle", source: "trees",
          paint: {
            "circle-color": "#3f8f4f", "circle-opacity": 0.35, "circle-stroke-width": 0,
            "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 14, ["*", ["get", "r"], 0.25], 18, ["*", ["get", "r"], 4]],
          },
        });
        map.addLayer({
          id: "network", type: "line", source: "network",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": shadeColor, "line-width": shadeWidth, "line-opacity": ["case", ["get", "inside"], 0.95, 0.3] },
        });
        map.addLayer({
          id: "buildings-flat", type: "fill", source: "buildings",
          paint: { "fill-color": "#d5d2cb", "fill-outline-color": "#b9b4aa", "fill-opacity": 0.9 },
        });
        map.addLayer({
          id: "buildings-3d", type: "fill-extrusion", source: "buildings",
          layout: { visibility: "none" },
          paint: { "fill-extrusion-color": "#dcd8d0", "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 0.85 },
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
            "circle-stroke-color": "#1d2b3a", "circle-stroke-width": 2,
          },
        });

        // live node marker (HTML so it can pulse)
        const live = propsRef.current.meta.nodes.find((n) => n.live);
        if (live) {
          const d = document.createElement("div");
          d.className = "live-marker";
          d.innerHTML = `<div class="ring"></div><div class="dot"></div><div class="lbl"><b>0</b><span>LIVE</span></div>`;
          liveEl.current = d;
          liveMarker.current = new maplibregl.Marker({ element: d }).setLngLat([live.lon, live.lat]).addTo(map);
        }

        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "edge-pop", offset: 8 });
        map.on("mousemove", "network", (e) => {
          const f = e.features?.[0];
          const st = propsRef.current.state;
          if (!f || !st) return;
          map.getCanvas().style.cursor = propsRef.current.pickMode ? "crosshair" : "pointer";
          const i = f.properties.id as number;
          const los = st.edges.los[i];
          const shade = st.sun.up ? `${Math.round(st.edges.shade[i] * 100)}% shaded` : "sun down";
          popup
            .setLngLat(e.lngLat)
            .setHTML(
              `<b>${f.properties.name}</b><br/>${shade} · <span style="color:${LOS_COLORS[los]}">LOS ${LOS[los]}</span> ${LOS_TEXT[los].toLowerCase()}<br/><small>${st.edges.per_m[i]} people/min per metre of footpath</small>`,
            )
            .addTo(map);
        });
        map.on("mouseleave", "network", () => {
          map.getCanvas().style.cursor = propsRef.current.pickMode ? "crosshair" : "";
          popup.remove();
        });
        map.on("click", (e) => {
          const pm = propsRef.current.pickMode;
          if (pm) propsRef.current.onPick([e.lngLat.lng, e.lngLat.lat]);
        });
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

  // ------------------------------------------------------------------ updates
  function applyEdges() {
    const map = mapRef.current;
    const st = propsRef.current.state;
    if (!map || !ready.current || !st) return;
    const { shade, los } = st.edges;
    for (let i = 0; i < shade.length; i++) {
      map.setFeatureState({ source: "network", id: i }, { shade: st.sun.up ? shade[i] : 1, los: los[i] });
    }
  }

  function applyToggles() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const t = propsRef.current.toggles;
    const vis = (id: string, on: boolean) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("shadows", t.shadows);
    vis("trees", t.trees);
    vis("nodes", t.nodes);
    vis("network", t.network !== "off");
    if (t.network === "crowd") {
      map.setPaintProperty("network", "line-color", crowdColor);
      map.setPaintProperty("network", "line-width", crowdWidth);
    } else {
      map.setPaintProperty("network", "line-color", shadeColor);
      map.setPaintProperty("network", "line-width", shadeWidth);
    }
    vis("buildings-3d", t.buildings3d);
    vis("buildings-flat", !t.buildings3d);
    if (liveEl.current) liveEl.current.style.display = t.nodes ? "" : "none";
  }

  function applyShadows() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    (map.getSource("shadows") as GeoJSONSource).setData(propsRef.current.shadows ?? EMPTY);
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
        .filter((n) => !n.live)
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
    map.fitBounds(b, { padding: { top: 90, bottom: 190, left: 280, right: 260 }, maxZoom: 17, duration: 900 });
  }

  function applyAll() {
    applyToggles();
    applyEdges();
    applyShadows();
    applyRoutes();
    applyNodes();
    applyEndpoints();
    fitRoutes();
    applyLive();
  }

  useEffect(applyEdges, [p.state]);
  useEffect(applyNodes, [p.state]);
  useEffect(applyShadows, [p.shadows]);
  useEffect(applyRoutes, [p.routes, p.selectedMode]);
  useEffect(applyEndpoints, [p.from, p.to]);

  useEffect(fitRoutes, [p.routes]);
  useEffect(() => {
    applyToggles();
    const map = mapRef.current;
    if (map && ready.current) map.easeTo({ pitch: p.toggles.buildings3d ? 55 : 0, bearing: p.toggles.buildings3d ? -20 : 0, duration: 800 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.toggles]);
  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = p.pickMode ? "crosshair" : "";
  }, [p.pickMode]);

  function applyLive() {
    const d = liveEl.current;
    const { liveCount, liveOnline, liveFlash } = propsRef.current;
    if (!d) return;
    const b = d.querySelector(".lbl b");
    if (b) b.textContent = String(liveCount);
    d.classList.toggle("offline", !liveOnline);
    d.classList.remove("flash");
    void d.offsetWidth; // restart the ripple animation
    if (liveFlash) d.classList.add("flash");
  }
  useEffect(applyLive, [p.liveCount, p.liveFlash, p.liveOnline]);

  return <div ref={el} className="map" />;
}

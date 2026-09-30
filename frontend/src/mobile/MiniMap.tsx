import { useEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

const FALLBACK: StyleSpecification = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#eef0ea" } }] };
let styleP: Promise<StyleSpecification | string> | null = null;
function style() {
  styleP ??= fetch("https://tiles.openfreemap.org/styles/positron", { signal: AbortSignal.timeout(3500) })
    .then((r) => (r.ok ? (r.json() as Promise<StyleSpecification>) : FALLBACK))
    .catch(() => FALLBACK);
  return styleP;
}

type Line = { coords: [number, number][]; color: string; dashed?: boolean; muted?: boolean; width?: number };
/** A labelled marker (text, or an icon). When pins are given they replace the default A/B route ends. */
export type Pin = { coord: [number, number]; label: string; icon?: ReactNode; cls: string; title?: string; color?: string; onClick?: () => void };

/** A small, light map: route lines and their endpoints. Muted lines sit underneath and can be tapped.
 *  With `focus` the map glides to those points instead of framing everything. `marks` are extra markers
 *  along the way (steps, raised kerbs) that leave the route ends as they are. */
export default function MiniMap({ lines, height = 190, onPick, pins, marks, focus }: {
  lines: Line[]; height?: number; onPick?: (i: number) => void; pins?: Pin[]; marks?: Pin[]; focus?: [number, number][];
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false); // isStyleLoaded() stays false until tiles arrive, so track the style ourselves
  const drawn = useRef(0);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const pinMarkers = useRef<{ marker: maplibregl.Marker; root?: Root }[]>([]);
  const shape = JSON.stringify(lines.map((l) => [l.coords[0], l.coords[l.coords.length - 1], l.coords.length]));
  const look = JSON.stringify(lines.map((l) => [l.color, !!l.muted, !!l.dashed, l.width]));
  const focusKey = JSON.stringify(focus ?? null);
  const pinKey = JSON.stringify([pins, marks].map((ps) => ps?.map((p) => [p.coord, p.label, p.cls, p.color]) ?? null));

  useEffect(() => {
    let dead = false;
    style().then((st) => {
      if (dead || !el.current) return;
      const m = new maplibregl.Map({ container: el.current, style: st, center: [144.9942, -37.8282], zoom: 15, attributionControl: false, dragRotate: false, pitchWithRotate: false });
      m.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "© OSM" }));
      map.current = m;
      m.once("style.load", () => {
        for (const l of m.getStyle().layers ?? []) if (l.id.includes("building")) m.setLayoutProperty(l.id, "visibility", "none");
        el.current?.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
        ready.current = true;
        draw(true);
        drawPins();
      });
      m.on("click", (e) => {
        if (!pickRef.current) return;
        const box: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - 12, e.point.y - 12], [e.point.x + 12, e.point.y + 12]];
        const layers = linesRef.current.map((_, i) => `r${i}-hit`).filter((id) => m.getLayer(id));
        const hits = m.queryRenderedFeatures(box, { layers }).map((f) => Number(f.layer.id.slice(1, -4)));
        // on a shared stretch prefer a route that isn't already the highlighted one
        const i = hits.find((k) => linesRef.current[k]?.muted) ?? hits[0];
        if (i !== undefined) pickRef.current(i);
      });
    });
    return () => {
      dead = true;
      ready.current = false;
      drawn.current = 0;
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draw(fit: boolean) {
    const m = map.current;
    const lines = linesRef.current;
    if (!m || !ready.current || (!lines.length && !pinsRef.current?.length)) return;
    for (let i = lines.length; i < drawn.current; i++) {
      for (const id of [`r${i}`, `r${i}-c`, `r${i}-hit`]) if (m.getLayer(id)) m.removeLayer(id);
      m.removeSource(`r${i}`);
    }
    drawn.current = lines.length;
    const ease = { duration: 250, delay: 0 };
    lines.forEach((l, i) => {
      const id = `r${i}`;
      const data: GeoJSON.Feature = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l.coords } };
      const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
      else {
        m.addSource(id, { type: "geojson", data });
        const layout = { "line-cap": "round", "line-join": "round" } as const;
        m.addLayer({ id: `${id}-c`, type: "line", source: id, layout, paint: { "line-color": "#fff", "line-width": 9, "line-width-transition": ease, "line-opacity-transition": ease } });
        m.addLayer({ id, type: "line", source: id, layout, paint: { "line-color": l.color, "line-width": 5, "line-width-transition": ease, "line-opacity-transition": ease } });
        m.addLayer({ id: `${id}-hit`, type: "line", source: id, layout, paint: { "line-color": "#000", "line-width": 22, "line-opacity": 0 } });
      }
      m.setPaintProperty(`${id}-c`, "line-width", l.width ? l.width + 4.5 : l.muted ? 7 : 10);
      m.setPaintProperty(`${id}-c`, "line-opacity", l.muted ? 0.7 : 1);
      m.setPaintProperty(id, "line-color", l.color);
      m.setPaintProperty(id, "line-width", l.width ?? (l.muted ? 3.5 : 5.5));
      m.setPaintProperty(id, "line-opacity", l.muted ? 0.7 : l.dashed ? 0.6 : 1);
      m.setPaintProperty(id, "line-dasharray", l.dashed ? [1.5, 1.5] : [1, 0]);
    });
    // highlighted lines on top, muted ones underneath
    const order = lines.map((l, i) => [i, l.muted ? 0 : 1]).sort((x, y) => x[1] - y[1]).map((x) => x[0]);
    for (const i of order) for (const id of [`r${i}-c`, `r${i}`, `r${i}-hit`]) m.moveLayer(id);
    m.getCanvas().style.cursor = pickRef.current ? "pointer" : "";
    if (!fit) return;
    frame();
    el.current?.querySelectorAll(".mm-end").forEach((x) => x.remove());
    if (pinsRef.current || !lines.length) return;
    const main = (lines.find((l) => !l.muted) ?? lines[lines.length - 1]).coords;
    for (const [c, cls, t] of [[main[0], "a", "A"], [main[main.length - 1], "b", "B"]] as const) {
      const d = document.createElement("div");
      d.className = `mm-end ${cls}`;
      d.textContent = t;
      new maplibregl.Marker({ element: d }).setLngLat(c).addTo(m);
    }
  }
  function frame() {
    const m = map.current;
    if (!m || !ready.current) return;
    const f = focusRef.current?.length ? focusRef.current : null;
    const all = f ?? [...linesRef.current.flatMap((l) => l.coords), ...(pinsRef.current ?? []).map((p) => p.coord)];
    if (!all.length) return;
    const b = all.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
    m.fitBounds(b, f ? { padding: 56, maxZoom: 18, duration: 600 } : { padding: 36, maxZoom: 17, duration: 0 });
  }
  function drawPins() {
    const m = map.current;
    if (!m || !ready.current) return;
    for (const p of pinMarkers.current) {
      p.marker.remove();
      const root = p.root;
      if (root) queueMicrotask(() => root.unmount()); // not while React is rendering
    }
    pinMarkers.current = [];
    for (const p of [...(pinsRef.current ?? []), ...(marksRef.current ?? [])]) {
      const d = document.createElement("div");
      d.className = `mm-pin ${p.cls}`;
      let root: Root | undefined;
      if (p.icon) {
        root = createRoot(d);
        root.render(p.icon);
      } else d.textContent = p.label;
      if (p.color) d.style.setProperty("--c", p.color);
      if (p.title) d.title = p.title;
      if (p.onClick) {
        const go = p.onClick;
        d.setAttribute("role", "button");
        d.addEventListener("click", (e) => { e.stopPropagation(); go(); });
      }
      pinMarkers.current.push({ marker: new maplibregl.Marker({ element: d }).setLngLat(p.coord).addTo(m), root });
    }
  }
  useEffect(() => draw(true), [shape]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { drawPins(); draw(true); }, [pinKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => draw(false), [look]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => frame(), [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="mini-map" style={{ height }} />;
}

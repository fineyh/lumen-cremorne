import { useEffect, useRef } from "react";
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

type Line = { coords: [number, number][]; color: string; dashed?: boolean };

/** A small, light map: one or two route lines and their endpoints. */
export default function MiniMap({ lines, height = 190 }: { lines: Line[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false); // isStyleLoaded() stays false until tiles arrive, so track the style ourselves
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const key = JSON.stringify(lines.map((l) => [l.coords[0], l.coords[l.coords.length - 1], l.coords.length]));

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
        draw();
      });
    });
    return () => {
      dead = true;
      ready.current = false;
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draw() {
    const m = map.current;
    const lines = linesRef.current;
    if (!m || !ready.current || !lines.length) return;
    lines.forEach((l, i) => {
      const id = `r${i}`;
      const data: GeoJSON.Feature = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l.coords } };
      const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
      else {
        m.addSource(id, { type: "geojson", data });
        m.addLayer({ id: `${id}-c`, type: "line", source: id, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#fff", "line-width": 9 } });
        m.addLayer({
          id, type: "line", source: id, layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": l.color, "line-width": 5, ...(l.dashed ? { "line-dasharray": [1.5, 1.5], "line-opacity": 0.6 } : {}) },
        });
      }
    });
    const all = lines.flatMap((l) => l.coords);
    const b = all.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
    m.fitBounds(b, { padding: 36, maxZoom: 17, duration: 0 });
    el.current?.querySelectorAll(".mm-end").forEach((x) => x.remove());
    const main = lines[lines.length - 1].coords;
    for (const [c, cls, t] of [[main[0], "a", "A"], [main[main.length - 1], "b", "B"]] as const) {
      const d = document.createElement("div");
      d.className = `mm-end ${cls}`;
      d.textContent = t;
      new maplibregl.Marker({ element: d }).setLngLat(c).addTo(m);
    }
  }
  useEffect(draw, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="mini-map" style={{ height }} />;
}

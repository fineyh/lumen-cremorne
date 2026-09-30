/** Map badges for stops and step-free access features, drawn as SVG so they work offline (no glyph server). */

// lucide glyphs (24 px grid, stroke icons)
const G = {
  wheelchair: `<circle cx="16" cy="4" r="1"/><path d="m18 19 1-7-6 1"/><path d="m5 8 3-3 5.5 3-2.36 3.5"/><path d="M4.24 14.5a5 5 0 0 0 6.88 6"/><path d="M13.76 17.5a5 5 0 0 0-6.88-6"/>`,
  train: `<path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/><path d="m9 15-1-1"/><path d="m15 15 1-1"/><path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/><path d="m8 19-2 3"/><path d="m16 19 2 3"/>`,
  tram: `<rect width="16" height="16" x="4" y="3" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/><path d="m8 19-2 3"/><path d="m18 22-2-3"/><path d="M8 15h.01"/><path d="M16 15h.01"/>`,
  bus: `<path d="M4 6 2 7"/><path d="M10 6h4"/><path d="m22 7-2-1"/><rect width="16" height="16" x="4" y="3" rx="2"/><path d="M4 11h16"/><path d="M8 15h.01"/><path d="M16 15h.01"/><path d="M6 19v2"/><path d="M18 21v-2"/>`,
  walker: `<circle cx="12" cy="5" r="1"/><path d="m9 20 3-6 3 6"/><path d="m6 8 6 2 6-2"/><path d="M12 10v4"/>`,
  stairs: `<path d="M3 20h5v-5h5v-5h5V5h3"/>`,
  ramp: `<path d="M3 18h6l6-8h6"/>`,
  kerb: `<path d="M3 17h8v-7h10"/><path d="m5 7 4 4m0-4-4 4"/>`,
  lift: `<rect x="5" y="3" width="14" height="18" rx="2"/><path d="m9 10 3-3 3 3"/><path d="m9 14 3 3 3-3"/>`,
} as const;
export type Glyph = keyof typeof G;

/** An inline <svg> glyph for HTML markers and popups. */
export const glyph = (g: Glyph, size = 14, stroke = 2.2) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${G[g]}</svg>`;

type Badge = { shape: "circle" | "square"; bg: string; fg: string; ring: string; glyph?: Glyph; text?: string; size: number };

// Symbol-layer icons for the access layer, by feature kind (see backend/lumen/access.py)
export const ACCESS_BADGES: Record<string, Badge> = {
  parking: { shape: "square", bg: "#1d4ed8", fg: "#fff", ring: "#fff", glyph: "wheelchair", size: 22 },
  toilet: { shape: "circle", bg: "#fff", fg: "#1d4ed8", ring: "#1d4ed8", text: "WC", size: 22 },
  lift: { shape: "square", bg: "#1d4ed8", fg: "#fff", ring: "#fff", glyph: "lift", size: 22 },
  steps: { shape: "square", bg: "#d97706", fg: "#fff", ring: "#fff", glyph: "stairs", size: 20 },
  kerb_raised: { shape: "circle", bg: "#dc2626", fg: "#fff", ring: "#fff", glyph: "kerb", size: 18 },
  signal: { shape: "circle", bg: "#334155", fg: "#fff", ring: "#fff", glyph: "walker", size: 17 },
  kerb: { shape: "circle", bg: "#fff", fg: "#15803d", ring: "#15803d", glyph: "ramp", size: 14 },
  "venue-yes": { shape: "circle", bg: "#fff", fg: "#15803d", ring: "#15803d", glyph: "wheelchair", size: 17 },
  "venue-limited": { shape: "circle", bg: "#fff", fg: "#b45309", ring: "#d97706", glyph: "wheelchair", size: 17 },
  "venue-no": { shape: "circle", bg: "#fff", fg: "#94a3b8", ring: "#cbd5e1", glyph: "wheelchair", size: 15 },
};

/** Legend rows, in the order people scan for them. */
export const ACCESS_LEGEND: { key: string; label: string }[] = [
  { key: "parking", label: "Accessible parking" },
  { key: "toilet", label: "Toilets" },
  { key: "signal", label: "Signalised crossing" },
  { key: "kerb", label: "Kerb ramp" },
  { key: "steps", label: "Steps" },
  { key: "venue-yes", label: "Wheelchair-friendly place" },
];

export function badgeSvg(b: Badge, scale = 2): string {
  const s = b.size;
  const r = b.shape === "circle" ? s / 2 : s * 0.26;
  const pad = 1.25;
  const inner = s - 2 * pad;
  const gl = inner * 0.62;
  const off = (s - gl) / 2;
  const content = b.glyph
    ? `<g transform="translate(${off} ${off}) scale(${gl / 24})" fill="none" stroke="${b.fg}" stroke-width="${b.size < 16 ? 3.2 : 2.6}" stroke-linecap="round" stroke-linejoin="round">${G[b.glyph]}</g>`
    : `<text x="${s / 2}" y="${s / 2}" dy="0.36em" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="${s * 0.4}" fill="${b.fg}">${b.text}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s * scale}" height="${s * scale}" viewBox="0 0 ${s} ${s}">` +
    `<rect x="${pad / 2}" y="${pad / 2}" width="${s - pad}" height="${s - pad}" rx="${r}" fill="${b.ring}"/>` +
    `<rect x="${pad * 1.1}" y="${pad * 1.1}" width="${s - pad * 2.2}" height="${s - pad * 2.2}" rx="${Math.max(0, r - pad * 0.6)}" fill="${b.bg}"/>` +
    content + `</svg>`;
}

export const badgeUrl = (key: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgeSvg(ACCESS_BADGES[key]))}`;

export function loadBadge(key: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = badgeUrl(key);
  return img.decode().then(() => img);
}

// PTV network colours
export const STOP_COLORS = { train: "#0072ce", tram: "#5fa01c", bus: "#f07800" } as const;

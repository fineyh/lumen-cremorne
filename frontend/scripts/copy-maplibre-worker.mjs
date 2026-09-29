// MapLibre 6 ships its worker as an ES module that imports a shared chunk by relative path,
// so both files are served as-is from /maplibre/ instead of going through the bundler.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("public/maplibre", { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(`node_modules/maplibre-gl/dist/${f}`, `public/maplibre/${f}`);
}

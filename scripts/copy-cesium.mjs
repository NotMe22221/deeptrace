// Copies the prebuilt CesiumJS distribution into public/cesium so it can be served
// statically (Workers, Assets, Widgets CSS, ThirdParty). Cesium is loaded at runtime
// from /cesium/Cesium.js instead of being bundled, which keeps builds fast and avoids
// bundler-specific worker issues.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = dirname(dirname(new URL(import.meta.url).pathname));
let cesiumPkgDir;
try {
  cesiumPkgDir = dirname(require.resolve("cesium/package.json"));
} catch {
  console.warn("[copy-cesium] cesium package not installed yet; skipping");
  process.exit(0);
}
const version = JSON.parse(readFileSync(join(cesiumPkgDir, "package.json"), "utf8")).version;
const src = join(cesiumPkgDir, "Build", "Cesium");
const dest = join(root, "public", "cesium");
const stamp = join(dest, ".version");
if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) {
  console.log(`[copy-cesium] public/cesium already at ${version}`);
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
writeFileSync(stamp, version);
console.log(`[copy-cesium] copied Cesium ${version} -> public/cesium`);

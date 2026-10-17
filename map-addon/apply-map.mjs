// Adds the Pantry Map panel to the team's frontend without replacing their App.tsx.
// Usage (from the food-fit folder):  node map-addon/apply-map.mjs [path-to-frontend]
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(process.argv[2] ?? path.join(here, "..", "frontend"));
const pkgPath = path.join(frontend, "package.json");
const appPath = path.join(frontend, "src", "App.tsx");
const mapDest = path.join(frontend, "src", "PantryMap.tsx");

const fail = (msg) => { console.error(`\nStopped: ${msg}`); process.exit(1); };

if (!fs.existsSync(pkgPath)) fail(`no package.json in ${frontend}. Pass the frontend folder: node map-addon/apply-map.mjs path\\to\\frontend`);
if (!fs.existsSync(appPath)) fail(`no src/App.tsx in ${frontend}.`);

// 1. Pick the react-leaflet version that matches the frontend's React
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const reactRange = pkg.dependencies?.react ?? "";
const reactMajor = parseInt(reactRange.replace(/[^\d.]/g, "").split(".")[0], 10);
if (!reactMajor) fail("could not find React in the frontend's package.json dependencies.");
const rl = reactMajor >= 19 ? "5" : "4";
console.log(`React ${reactMajor} found, using react-leaflet@${rl}`);

// 2. Pick the map component that matches the dashboard's styling, then copy it
const raw = fs.readFileSync(appPath, "utf8");
const retro = raw.includes("retro-panel");
const variant = retro ? "PantryMap.retro.tsx" : "PantryMap.tsx";
const anchors = retro
  ? ["{/* TOP ROW */}", "{/* SUMMARY METRICS */}"]
  : ["{/* Main content */}"];
fs.copyFileSync(path.join(here, variant), mapDest);
console.log(`Copied src/PantryMap.tsx (${retro ? "retro dashboard style" : "Tailwind card style"})`);

// 3. Add the two lines to App.tsx (only if they aren't there already)
const crlf = raw.includes("\r\n");
let lines = raw.replace(/\r\n/g, "\n").split("\n");

if (lines.some((l) => l.includes("PantryMap"))) {
  console.log("App.tsx already uses PantryMap, leaving it alone.");
} else {
  // last import statement (handles multi-line imports, with or without semicolons)
  let lastImportEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^import[\s{*]/.test(lines[i])) continue;
    let j = i;
    while (j < lines.length && !/(from\s*)?["'][^"']+["'];?\s*$/.test(lines[j])) j++;
    lastImportEnd = j;
    i = j;
  }
  const anchor = anchors.map((a) => lines.findIndex((l) => l.includes(a))).find((i) => i >= 0) ?? -1; // first anchor that exists wins
  if (lastImportEnd < 0 || anchor < 0) {
    console.log(
      "\nCould not find the right spot in App.tsx automatically (the layout has changed).\n" +
      "Add these two lines by hand:\n" +
      '  1. At the top, with the other imports:   import PantryMap from "./PantryMap";\n' +
      "  2. Inside the page layout, where you want the map:   <PantryMap />\n"
    );
  } else {
    const indent = lines[anchor].match(/^\s*/)[0];
    lines.splice(anchor, 0, `${indent}{/* Map */}`, `${indent}<PantryMap />`, "");
    lines.splice(lastImportEnd + 1, 0, 'import PantryMap from "./PantryMap";');
    fs.writeFileSync(appPath, lines.join(crlf ? "\r\n" : "\n"));
    console.log("Updated src/App.tsx (import + <PantryMap /> above the dashboard panels)");
  }
}

// 4. Install the map libraries
console.log("\nInstalling map libraries...");
execSync(`npm install leaflet react-leaflet@${rl}`, { cwd: frontend, stdio: "inherit" });
execSync("npm install -D @types/leaflet", { cwd: frontend, stdio: "inherit" });

console.log("\nDone. Start the backend, then run:  cd frontend && npm run dev");

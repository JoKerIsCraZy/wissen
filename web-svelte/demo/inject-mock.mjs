/* ============================================================================
   inject-mock.mjs — Demo-Build-Nachbearbeitung
   ----------------------------------------------------------------------------
   Läuft NACH `vite build` (Demo-Modus). Schritte:
     1. kopiert den gebauten SPA-Output (SRC) nach DEST (site/public/desktop-demo),
     2. legt desktop-mock.js daneben,
     3. injiziert <script src="{BASE}/desktop-mock.js"></script> als erstes
        Element im <head> jeder .html — also VOR dem deferred SvelteKit-Modul,
        damit Token/fetch/EventSource gepatcht sind, bevor die App bootet.

   Env-Overrides (mit sinnvollen Defaults für den GitHub-Pages-Build):
     BASE_PATH  → URL-Base, z.B. /wissen/desktop-demo (default)
     BUILD_OUT  → Build-Output-Verzeichnis relativ zu web-svelte/ (default: dist)
     DEMO_DEST  → Zielverzeichnis (default: ../site/public/desktop-demo)
   ============================================================================ */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url)); // web-svelte/demo
const webSvelteDir = resolve(scriptDir, '..'); // web-svelte
const repoRoot = resolve(webSvelteDir, '..');

const BASE = process.env.BASE_PATH ?? '/wissen/desktop-demo';
const buildOut = process.env.BUILD_OUT ?? 'dist';
const SRC = resolve(webSvelteDir, buildOut);
const DEST = process.env.DEMO_DEST
  ? resolve(process.env.DEMO_DEST)
  : resolve(repoRoot, 'site', 'public', 'desktop-demo');

const mockSrc = join(scriptDir, 'desktop-mock.js');
const baseClean = BASE.replace(/\/$/, '');
const injectTag = `<script src="${baseClean}/desktop-mock.js"></script>`;

if (!existsSync(SRC)) {
  console.error(`[inject-mock] Build-Output nicht gefunden: ${SRC}\n` +
    `  Zuerst bauen, z.B.:  BASE_PATH=${BASE} BUILD_OUT=${buildOut} npm run build`);
  process.exit(1);
}

// 1) frisches DEST.
if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
cpSync(SRC, DEST, { recursive: true });

// 2) Mock daneben legen.
cpSync(mockSrc, join(DEST, 'desktop-mock.js'));

// 2b) Geteilte /assets (Logo, Icons, Favicons) mitkopieren. Die SPA referenziert
//     sie base-bewusst als {base}/assets/* (siehe Rail.svelte, app.html). In der
//     Self-Host-Produktion liefert der Express-Server /assets aus web/assets;
//     auf GitHub Pages gibt es keinen Server, daher müssen die Dateien im
//     statischen Output unter {base}/assets/ liegen.
const assetsSrc = resolve(repoRoot, 'web', 'assets');
if (existsSync(assetsSrc)) {
  cpSync(assetsSrc, join(DEST, 'assets'), { recursive: true });
} else {
  console.warn(`[inject-mock] WARN: web/assets nicht gefunden (${assetsSrc}) — Logo/Icons fehlen in der Demo.`);
}

// 3) In jede .html injizieren (rekursiv).
function htmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

let injected = 0;
for (const file of htmlFiles(DEST)) {
  let html = readFileSync(file, 'utf8');
  if (html.includes('desktop-mock.js')) continue; // idempotent
  if (!html.includes('<head>')) continue;
  html = html.replace('<head>', `<head>\n\t\t${injectTag}`);
  writeFileSync(file, html);
  injected++;
}

console.log(`[inject-mock] OK → ${DEST}`);
console.log(`[inject-mock] Mock-Tag in ${injected} HTML-Datei(en) injiziert (base="${baseClean}").`);

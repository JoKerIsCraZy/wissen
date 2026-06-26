import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// ── Build-Modi ───────────────────────────────────────────────────────────
// Standard (Self-Host): kein Env → Output ../dist, Root-Base '', SW aktiv.
// Demo (GitHub Pages):  BASE_PATH=/wissen/desktop-demo BUILD_OUT=dist gesetzt
//   → SPA wird unter einem Sub-Pfad gehostet und vom Mock-API-Layer ohne
//   Backend betrieben (siehe demo/desktop-mock.js). Der Service-Worker wird
//   im Demo-Build NICHT registriert (würde mit dem Docs-Site-SW/Caching auf
//   github.io kollidieren).
const base = process.env.BASE_PATH ?? '';
const outDir = process.env.BUILD_OUT ?? '../dist';
const isDemoBuild = Boolean(process.env.BASE_PATH);

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // Use vitePreprocess so <script lang="ts"> works out of the box.
  preprocess: vitePreprocess(),

  kit: {
    // Static SPA build: every route falls back to index.html for the
    // client-side router. Output goes to ../web/v2 so Express can serve it
    // alongside the legacy frontend at web/ and web/mobile/.
    // Build output goes to ./dist at project root. Legacy /mobile/ + /assets/
    // + /floorplans/ stay in web/. Express serves dist/ first (SPA at root),
    // then falls through to web/ for legacy paths.
    adapter: adapter({
      pages: outDir,
      assets: outDir,
      fallback: 'index.html',
      precompress: false,
      strict: false
    }),

    // V2 is now the default frontend at site root '/'. Legacy V1
    // (web/index.html + app.js + style.css) was removed; web/mobile/
    // legacy PWA stays at /mobile/. Assets resolve under '/' directly.
    // base ist im Demo-Build der GitHub-Pages-Sub-Pfad (z.B. /wissen/desktop-demo).
    paths: {
      base
    },

    // Demo-Build: SW-Auto-Registration aus (siehe Build-Modi-Block oben).
    serviceWorker: {
      register: !isDemoBuild
    }

    // CSP-Hinweis (siehe src/server.js helmet-Block):
    // adapter-static prerendert index.html zur Build-Zeit, deshalb wird hier
    // KEIN kit.csp gesetzt — eine 'auto'/'nonce'-Mode würde zur Build-Zeit ein
    // statisches Nonce einbacken, das der Express-Helmet-Header nicht kennt.
    // Pfad zu nonce-basiertem CSP siehe TODO in src/server.js (Migration auf
    // csp.mode='hash' oder adapter-node).
  }
};

export default config;

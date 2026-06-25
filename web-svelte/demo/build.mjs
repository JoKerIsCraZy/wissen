/* ============================================================================
   build.mjs — plattformunabhängiger Demo-Build-Treiber
   ----------------------------------------------------------------------------
   Setzt die Demo-Env (BASE_PATH/BUILD_OUT) in process.env — funktioniert so
   auf Windows (cmd) UND POSIX gleichermassen, ohne Shell-Env-Prefix — baut die
   SPA und ruft danach die Inject-/Copy-Nachbearbeitung auf.

   Override via Env möglich (z.B. für einen anderen Pages-Base oder ein anderes
   Zielverzeichnis):  BASE_PATH, BUILD_OUT, DEMO_DEST.
   ============================================================================ */
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url)); // web-svelte/demo
const webSvelteDir = resolve(scriptDir, '..');

process.env.BASE_PATH = process.env.BASE_PATH ?? '/wissen/desktop-demo';
process.env.BUILD_OUT = process.env.BUILD_OUT ?? 'dist';

console.log(`[build-demo] vite build (BASE_PATH=${process.env.BASE_PATH}, BUILD_OUT=${process.env.BUILD_OUT})`);
execSync('vite build', { stdio: 'inherit', cwd: webSvelteDir, env: process.env });

// inject-mock.mjs führt seine Logik beim Import aus (liest dieselbe Env).
await import('./inject-mock.mjs');

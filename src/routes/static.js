'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// Mounts static-files + SPA-fallback. Called LAST, after API routes and auth.
//
// Layout:
//   dist/          → SvelteKit SPA build (from web-svelte/), served at '/'
//   web/mobile/    → legacy mobile PWA, served at '/mobile/'
//   web/assets/    → shared icons, logos
//   web/floorplans/ → legacy raumview helpers (data.js + raumview.* used by
//                     /mobile/ PWA and the standalone editors)
module.exports = function mountStatic(app) {
  const ROOT = process.cwd();
  const DIST_DIR = path.join(ROOT, 'dist');
  const WEB_DIR = path.join(ROOT, 'web');

  function setStaticHeaders(res, filePath) {
    // SvelteKit content-hashed Assets: Dateiname enthält den Content-Hash
    // (z.B. /_app/immutable/chunks/abc123.js), darf also für immer gecacht
    // werden. Browser revalidiert nur wenn sich der Dateiname ändert.
    // Plattform-agnostisch: Windows liefert Backslashes, Linux Forward-Slashes.
    if (filePath.includes('/_app/immutable/') || filePath.includes('\\_app\\immutable\\')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return;
    }
    if (filePath.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    } else if (filePath.endsWith('sw.js') || filePath.endsWith('service-worker.js')) {
      // Service-Worker NIE cachen, sonst sieht der Browser SW-Updates nicht.
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }

  // 1) SvelteKit SPA build — index.html, _app/, service-worker.js, etc.
  //    Served at site root '/' (paths.base = '' in web-svelte/vite.config.ts).
  if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR, { setHeaders: setStaticHeaders }));
  }

  // 2) Legacy assets — /assets/, /mobile/*, /floorplans/* fall through here.
  if (fs.existsSync(WEB_DIR)) {
    app.use(express.static(WEB_DIR, { setHeaders: setStaticHeaders }));
  }

  // 3) SPA-Fallback for navigation requests:
  //    /mobile or /mobile/* → legacy mobile PWA
  //    everything else      → SvelteKit SPA index.html
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api/')) return next();
    const isMobile = req.path === '/mobile' || req.path.startsWith('/mobile/');
    const indexPath = isMobile
      ? path.join(WEB_DIR, 'mobile', 'index.html')
      : path.join(DIST_DIR, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    next();
  });
};

'use strict';

// JSON-Body-Parser für alle API-Routen. Kern ist `inflate: false`:
// body-parser 2.x entpackt sonst Request-Bodies mit Content-Encoding br, gzip
// oder deflate automatisch über node:zlib — und der Parser hängt in server.js
// global VOR Healthcheck und Auth. Damit erreichte jeder, der den Port sieht,
// ohne Token den Brotli-Decoder von Node (Node2Shell, CVE-2026-111497:
// Out-of-bounds-Write, gefixt erst in Node 22.23.4 / 24.22.1 / 26.12.1).
// Das Body-Limit schützt dabei nicht, es zählt erst die entpackten Bytes.
//
// Mit inflate:false antwortet body-parser bei jedem Encoding ausser identity
// mit 415, bevor zlib angefasst wird — unabhängig von der Node-Version.
// Kein WISSen-Client schickt komprimierte Bodies (SPA, Push-Subscriptions;
// der Telegram-Bot pollt statt Webhook), es geht also nichts verloren.

const express = require('express');

function jsonBody(limit) {
  return express.json({ limit, inflate: false });
}

module.exports = { jsonBody };

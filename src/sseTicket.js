'use strict';

const crypto = require('node:crypto');

// =============================================================
// SSE-Tickets — kurzlebige Einmal-Credentials für /api/events
// =============================================================
//
// PROBLEM
//
// `EventSource` kann im Browser keine Custom-Header setzen, deshalb wurde der
// API-Token bisher als `/api/events?token=<token>` in der URL mitgegeben.
// Query-Strings landen aber vollständig in Reverse-Proxy-Access-Logs
// (nginx/Caddy/Traefik loggen die Request-URI per Default), in Log-Shipping-
// Pipelines, in APM-Traces und in Backups davon. Der API-Token ist statisch,
// läuft nie ab und autorisiert JEDE /api-Route (inkl. PATCH /api/settings und
// POST /api/db/reset) — ein einziger geleakter Logeintrag ist damit
// Vollzugriff auf Dauer. Da der SSE-Client mit Backoff endlos reconnected,
// wurde der Token nicht einmal, sondern fortlaufend nachgeloggt.
//
// LÖSUNG
//
// Der Client holt sich per authentifiziertem `POST /api/events/ticket`
// (Token im Authorization-Header, landet also in keinem Log) ein Ticket und
// hängt NUR dieses an die EventSource-URL. Ein Ticket ist:
//
//   - kurzlebig  (TTL_MS, 30s) — ein geleakter Logeintrag ist nach Sekunden wertlos
//   - einmalig   (consume() löscht es) — Replay aus einem Log ist unmöglich
//   - eng        (autorisiert ausschliesslich /api/events, keine andere Route)
//
// Damit ist das, was in den Logs landet, kein Credential mehr, sondern ein
// bereits verbrauchter Zufallswert.
//
// EventSource reconnected nach einem 401 selbst nicht erfolgreich weiter
// (readyState CLOSED) — die Clients fangen das ab und holen vor jedem
// Reconnect ein frisches Ticket. Einmal-Tickets sind deshalb kompatibel mit
// dem bestehenden Backoff-Reconnect und kosten nur einen billigen POST.

const TTL_MS = 30 * 1000;

// Obergrenze gegen Speicher-Wachstum: Ein authentifizierter Client könnte
// sonst durch wiederholtes Ticket-Ziehen unbegrenzt Map-Einträge anlegen.
// 500 offene Tickets sind weit über allem, was legitime Reconnects erzeugen
// (SSE_MAX_CLIENTS liegt bei 20), und laufen ohnehin nach 30s aus.
const MAX_TICKETS = 500;

/** @type {Map<string, number>} ticket → expiresAt (epoch ms) */
const tickets = new Map();

// Abgelaufene Einträge entfernen. Wird bei jedem issue() aufgerufen, damit die
// Map auch ohne Timer nicht wächst; ein zusätzlicher Interval-Sweep ist nicht
// nötig, weil ohne issue() auch nichts hinzukommt.
function _sweep(now) {
  for (const [t, exp] of tickets) {
    if (exp <= now) tickets.delete(t);
  }
}

/**
 * Erzeugt ein neues Einmal-Ticket.
 * @returns {{ ticket: string, expiresInMs: number }}
 */
function issue() {
  const now = Date.now();
  _sweep(now);

  // Falls der Sweep nicht genug freiräumt (viele frische Tickets), das
  // älteste opfern statt unbegrenzt zu wachsen. Map iteriert in
  // Insertion-Order, der erste Eintrag ist also der älteste.
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next().value;
    if (oldest === undefined) break;
    tickets.delete(oldest);
  }

  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, now + TTL_MS);
  return { ticket, expiresInMs: TTL_MS };
}

/**
 * Prüft und verbraucht ein Ticket. Ein Ticket ist genau einmal gültig.
 * @param {unknown} ticket
 * @returns {boolean} true wenn das Ticket gültig war (und jetzt verbraucht ist)
 */
function consume(ticket) {
  if (typeof ticket !== 'string' || !ticket) return false;
  const exp = tickets.get(ticket);
  if (exp === undefined) return false;
  // Immer löschen — auch im abgelaufenen Fall, damit ein toter Eintrag nicht
  // bis zum nächsten Sweep liegen bleibt.
  tickets.delete(ticket);
  return exp > Date.now();
}

// Nur für Tests: deterministischer Reset zwischen Cases.
function _reset() {
  tickets.clear();
}

module.exports = { issue, consume, TTL_MS, MAX_TICKETS, _reset };

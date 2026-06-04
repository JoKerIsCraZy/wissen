'use strict';

const db = require('../db');
const state = require('./state');
const { tg, truncate } = require('./telegram');
const {
  escapeHtml,
  isoToday,
  dayLabel,
  nextWeekRange,
  formatDateTime,
  formatNoteColor,
  formatNote,
  extractModulNummer,
  calcWeightedAvg,
  formatPruefungenBlock,
  formatTag,
  estimateDayBytes,
  PHASE_LABELS_DE,
  elapsedSec,
  MONTHS_DE
} = require('./format');
const {
  mainMenu,
  notenNav,
  durchschnittNav,
  stundenplanNav,
  simpleNav,
  okMenuKb
} = require('./keyboards');

// Defensive Error-Formatierung für User-facing Telegram-Messages.
// Newlines verbergen sonst potenzielle Stacktrace-Multiliner und das
// 500-char-Cap verhindert dass eine pathologische Library-Error-Message
// die ganze Telegram-Nachricht sprengt.
function safeErrMsg(e) {
  const raw = String((e && e.message) || e || '');
  return raw.replace(/\n+/g, ' ').slice(0, 500);
}

// ---------- Screens ----------
async function screenMenu() {
  const database = db.getInstance();
  const stats = db.getStats(database);

  let text = '🎓 <b>Tocco WISS</b>\n\n';
  text += '📊 <b>' + stats.notenCount + '</b> Noten · <b>' + stats.notenWithGradeCount + '</b> benotet\n';
  if (stats.avgNote != null) text += '🎯 Ø: <b>' + stats.avgNote + '</b>\n';
  text += '📆 <b>' + stats.stundenplanUpcoming + '</b> kommende Events\n\n';
  text += '<i>Wähle eine Option:</i>';
  return { text, keyboard: mainMenu() };
}

async function screenNoten() {
  const database = db.getInstance();
  const rows = db.getNoten(database, { hasNote: true, sortBy: 'fach' });
  const stats = db.getStats(database);

  const graded = rows.filter(r => r.note != null);
  if (!graded.length) {
    return { text: '📚 Noch keine benoteten Einträge.', keyboard: notenNav() };
  }

  const groups = {};
  for (const r of graded) {
    const key = r.semester || 'Andere';
    (groups[key] = groups[key] || []).push(r);
  }
  const semOrder = Object.keys(groups).sort((a, b) => {
    if (a.startsWith('S') && b.startsWith('S')) return a.localeCompare(b);
    if (a.startsWith('S')) return -1;
    if (b.startsWith('S')) return 1;
    return a.localeCompare(b);
  });

  let text = '📚 <b>Alle Noten</b>  <i>(' + graded.length + ' benotet)</i>\n';
  text += '<i>Tippe auf eine Modul-Nummer unten für ZP/LB-Details.</i>\n';
  for (const sem of semOrder) {
    const avgSem = stats.avgBySemester && stats.avgBySemester[sem];
    text += '\n━━━ <b>' + escapeHtml(sem) + '</b>';
    if (avgSem != null) text += '  ·  Ø <b>' + avgSem + '</b>';
    text += ' ━━━\n\n';

    groups[sem].sort((a, b) => (b.note || 0) - (a.note || 0));
    for (const r of groups[sem]) {
      const mod = extractModulNummer(r);
      const prefix = mod ? '<code>' + escapeHtml(mod) + '</code>  ' : '';
      text += formatNoteColor(r.note) + '  <b>' + formatNote(r.note) + '</b>  ' + prefix + escapeHtml(r.fach_name) + '\n';
    }
  }

  text += '\n━━━━━━━━━━━━━━━━━━\n';
  text += '🎯 Ø gesamt: <b>' + (stats.avgNote != null ? stats.avgNote : '—') + '</b>';

  // Detail-Buttons: ein Knopf pro Modul mit der Modul-Nummer als Beschriftung.
  // 4 pro Reihe, Telegram limitiert max 100 Buttons / 4096 chars Text.
  const detailRows = [];
  const PER_ROW = 4;
  for (let i = 0; i < graded.length; i += PER_ROW) {
    detailRows.push(graded.slice(i, i + PER_ROW).map(r => ({
      text: extractModulNummer(r) || r.kuerzel_id,
      callback_data: 'modul_' + r.kuerzel_id
    })));
  }

  const keyboard = {
    inline_keyboard: [
      ...detailRows,
      [
        { text: '🎯 Durchschnitt', callback_data: 'durchschnitt' },
        { text: '🔄 Aktualisieren', callback_data: 'noten' }
      ],
      [{ text: '⬅️ Menü', callback_data: 'menu' }]
    ]
  };

  return { text, keyboard };
}

// Modul-Detail: Tocco-Modulnote prominent, dann ZP/LB-Liste mit Gewichten.
// Aufgerufen via callback_data="modul_<kuerzel_id>" aus screenNoten.
async function screenModulDetail(kuerzelId) {
  if (!kuerzelId || !/^[A-Za-z0-9_-]+$/.test(kuerzelId) || kuerzelId.length > 128) {
    return { text: '⚠️ Ungültige Modul-ID.', keyboard: simpleNav() };
  }
  const database = db.getInstance();
  const modul = db.getNotenRow(database, kuerzelId);
  const pruefungen = db.getPruefungen(database, kuerzelId);

  if (!modul) {
    return { text: '📚 <b>Modul nicht gefunden</b>', keyboard: simpleNav() };
  }

  const mod = extractModulNummer(modul);
  const sem = modul.semester ? '  <i>' + escapeHtml(modul.semester) + '</i>' : '';
  let text = '📚 ';
  if (mod) text += '<code>' + escapeHtml(mod) + '</code>  ';
  text += '<b>' + escapeHtml(modul.fach_name || modul.kuerzel_id) + '</b>' + sem + '\n\n';

  if (modul.note != null) {
    text += '🎯 <b>Modulnote (Tocco):</b> ' + formatNoteColor(modul.note)
         + ' <b>' + Number(modul.note).toFixed(3) + '</b>\n';
    // Berechnete Note nur dazuschreiben wenn sie matcht (Tocco hat Vorrang;
    // bei Diskrepanz wäre der berechnete Wert verwirrend).
    const calc = calcWeightedAvg(pruefungen);
    if (calc != null && Math.abs(calc - modul.note) < 0.05) {
      text += '   <i>(eigene Berechnung stimmt: ' + calc.toFixed(3) + ')</i>\n';
    }
    text += '\n';
  } else {
    text += '<i>Noch keine Modulnote.</i>\n\n';
  }

  if (pruefungen.length) {
    text += '<b>Prüfungen</b>\n';
    text += formatPruefungenBlock(pruefungen) + '\n';
    if (modul.detail_scraped_at) {
      const d = new Date(modul.detail_scraped_at);
      if (!isNaN(d.getTime())) {
        text += '\n<i>aktualisiert ' + formatDateTime(modul.detail_scraped_at) + '</i>';
      }
    }
  } else {
    text += '<i>Keine Prüfungs-Details vorhanden.</i>\n';
    if (modul.detail_id) {
      text += '<i>(Beim nächsten Scrape werden sie versucht zu laden.)</i>';
    } else {
      text += '<i>(Keine Detail-ID — Modul hat keine aufrufbare Detail-Seite.)</i>';
    }
  }

  return {
    text,
    keyboard: {
      inline_keyboard: [
        [{ text: '📚 Alle Noten', callback_data: 'noten' }, { text: '⬅️ Menü', callback_data: 'menu' }]
      ]
    }
  };
}

async function screenDurchschnitt() {
  const database = db.getInstance();
  const stats = db.getStats(database);

  let text = '🎯 <b>Notendurchschnitt</b>\n\n';
  text += 'Ø gesamt: <b>' + (stats.avgNote != null ? stats.avgNote : '—') + '</b>\n';
  if (stats.avgBySemester && Object.keys(stats.avgBySemester).length) {
    const entries = Object.entries(stats.avgBySemester).sort(([a], [b]) => a.localeCompare(b));
    for (const [sem, v] of entries) {
      text += 'Ø ' + sem + ': <b>' + v + '</b>\n';
    }
  }
  text += '\n<i>' + stats.notenWithGradeCount + ' von ' + stats.notenCount + ' Modulen benotet</i>';
  return { text, keyboard: durchschnittNav() };
}

async function screenHeute() {
  const today = isoToday(0);
  const database = db.getInstance();
  const rows = db.getStundenplan(database, { from: today, to: today });
  return { text: formatTag('Heute · ' + dayLabel(today), rows), keyboard: stundenplanNav('heute') };
}

async function screenMorgen() {
  const tomorrow = isoToday(1);
  const database = db.getInstance();
  const rows = db.getStundenplan(database, { from: tomorrow, to: tomorrow });
  return { text: formatTag('Morgen · ' + dayLabel(tomorrow), rows), keyboard: stundenplanNav('morgen') };
}

async function screenWoche() {
  const { from, to } = nextWeekRange();
  const database = db.getInstance();
  const rows = db.getStundenplan(database, { from, to });

  if (!rows.length) {
    return {
      text: '📅 <b>Nächste Woche</b>\n<i>' + from + ' bis ' + to + '</i>\n\nKeine Termine. 🎉',
      keyboard: stundenplanNav('woche')
    };
  }

  const byDate = {};
  for (const r of rows) (byDate[r.datum_iso] = byDate[r.datum_iso] || []).push(r);

  let text = '📅 <b>Nächste Woche</b>\n<i>' + from + ' bis ' + to + '</i>\n\n';
  // Reihenfolge: weiter weg oben, näher am heute unten.
  // Eine Woche passt komplett in Telegram-Limit, daher kein Tages-Limit nötig.
  for (const date of Object.keys(byDate).sort().reverse()) {
    text += '━━━━━━━━━━━━━━━━━━\n';
    text += '<b>' + dayLabel(date) + '</b>\n\n';
    for (const r of byDate[date]) {
      text += '🕐 ' + r.zeit_von + '–' + r.zeit_bis + '  <b>' + escapeHtml(r.veranstaltung) + '</b>\n';
      const bits = [];
      if (r.raum) bits.push('🏫 ' + r.raum);
      if (r.dozent) bits.push('👤 ' + r.dozent);
      if (bits.length) text += '   ' + escapeHtml(bits.join('  ·  ')) + '\n';
      text += '\n';
    }
  }
  return { text: text.trim(), keyboard: stundenplanNav('woche') };
}

async function screenStundenplan() {
  const today = isoToday(0);
  const database = db.getInstance();
  const rows = db.getStundenplan(database, { from: today, limit: 200 });

  if (!rows.length) {
    return {
      text: '📋 <b>Stundenplan</b>\n\nKeine kommenden Termine. 🎉',
      keyboard: stundenplanNav('stundenplan')
    };
  }

  const byDate = {};
  for (const r of rows) (byDate[r.datum_iso] = byDate[r.datum_iso] || []).push(r);

  // Bis zu ~1 Monat zeigen. Smart-Truncate: chronologisch füllen bis Byte-
  // Budget erreicht — fernste Tage werden weggelassen statt heute.
  const allDates = Object.keys(byDate).sort();
  const MAX_DAYS = 31;
  const BUDGET_BYTES = 3500;

  let estimated = 200; // header overhead
  const visibleDates = [];
  for (const date of allDates) {
    if (visibleDates.length >= MAX_DAYS) break;
    const cost = estimateDayBytes(date, byDate[date]);
    if (estimated + cost > BUDGET_BYTES) break;
    visibleDates.push(date);
    estimated += cost;
  }
  const truncatedDays = allDates.length - visibleDates.length;
  // Reverse: weiter weg oben, heute unten.
  const dates = visibleDates.slice().reverse();

  const visibleCount = visibleDates.reduce((sum, d) => sum + byDate[d].length, 0);
  let text = '📋 <b>Stundenplan</b>  <i>(' + visibleCount + ' Termine, ' + visibleDates.length + ' Tage';
  if (truncatedDays > 0) text += ' · +' + truncatedDays + ' weitere — siehe „Alle"';
  text += ')</i>\n';
  for (const date of dates) {
    text += '\n━━ <b>' + escapeHtml(dayLabel(date)) + '</b> ━━\n';
    for (const r of byDate[date]) {
      text += '\n🕐 <b>' + r.zeit_von + '–' + r.zeit_bis + '</b>  ' + escapeHtml(r.veranstaltung) + '\n';
      const bits = [];
      if (r.raum) bits.push('🏫 ' + r.raum);
      if (r.dozent) bits.push('👤 ' + r.dozent);
      if (bits.length) text += '   <i>' + escapeHtml(bits.join('  ·  ')) + '</i>\n';
    }
  }

  return { text: text.trim(), keyboard: stundenplanNav('stundenplan') };
}

// Stundenplan „Alle": gruppiert ALLE kommenden Termine nach Monat.
// Returnt structure mit messages[] (eine Telegram-Message pro Monat).
// Reihenfolge je Message: Tage absteigend (wie /stundenplan).
function buildMonthlyStundenplan() {
  const today = isoToday(0);
  const database = db.getInstance();
  const rows = db.getStundenplan(database, { from: today, limit: 1000 });

  if (!rows.length) return { messages: [], totalEvents: 0, totalMonths: 0 };

  // Gruppieren nach yyyy-MM
  const byMonth = new Map();
  for (const r of rows) {
    const m = (r.datum_iso || '').match(/^(\d{4})-(\d{2})/);
    if (!m) continue;
    const monthKey = m[1] + '-' + m[2];
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey).push(r);
  }

  const monthKeys = [...byMonth.keys()].sort();
  const messages = [];

  for (const mk of monthKeys) {
    const events = byMonth.get(mk);
    const [yyyy, mm] = mk.split('-');
    const monthLabel = MONTHS_DE[parseInt(mm, 10) - 1] + ' ' + yyyy;

    // Pro Monat: nach Tag gruppieren, Tage rückwärts (weit weg oben)
    const byDay = {};
    for (const r of events) (byDay[r.datum_iso] = byDay[r.datum_iso] || []).push(r);
    const dayKeys = Object.keys(byDay).sort().reverse();

    let text = '📋 <b>' + escapeHtml(monthLabel) + '</b>  <i>(' + events.length + ' Termine)</i>\n';

    // Falls ein Monat zu groß für eine Telegram-Message wird, splitten.
    // Wir bauen erst alles zusammen und checken am Ende.
    let block = '';
    for (const date of dayKeys) {
      block += '\n━━ <b>' + escapeHtml(dayLabel(date)) + '</b> ━━\n';
      for (const r of byDay[date]) {
        block += '\n🕐 <b>' + r.zeit_von + '–' + r.zeit_bis + '</b>  ' + escapeHtml(r.veranstaltung) + '\n';
        const bits = [];
        if (r.raum) bits.push('🏫 ' + r.raum);
        if (r.dozent) bits.push('👤 ' + r.dozent);
        if (bits.length) block += '   <i>' + escapeHtml(bits.join('  ·  ')) + '</i>\n';
      }
    }
    text += block;

    // Falls trotzdem zu groß: splitten in Hälften (selten — Monat hat
    // typisch <30 Tage × 5 Lektionen = 150 Termine, das passt).
    if (Buffer.byteLength(text, 'utf8') > 3800) {
      // Greedy split in 2 Teile, naiv: erste Hälfte der Tage, zweite Hälfte
      const half = Math.ceil(dayKeys.length / 2);
      const part1Dates = dayKeys.slice(0, half);
      const part2Dates = dayKeys.slice(half);
      messages.push(buildMonthMessage(monthLabel + ' (Teil 1)', part1Dates, byDay));
      messages.push(buildMonthMessage(monthLabel + ' (Teil 2)', part2Dates, byDay));
    } else {
      messages.push(text);
    }
  }

  return { messages, totalEvents: rows.length, totalMonths: monthKeys.length };
}

function buildMonthMessage(label, dayKeys, byDay) {
  const totalEvents = dayKeys.reduce((s, d) => s + byDay[d].length, 0);
  let text = '📋 <b>' + escapeHtml(label) + '</b>  <i>(' + totalEvents + ' Termine)</i>\n';
  for (const date of dayKeys) {
    text += '\n━━ <b>' + escapeHtml(dayLabel(date)) + '</b> ━━\n';
    for (const r of byDay[date]) {
      text += '\n🕐 <b>' + r.zeit_von + '–' + r.zeit_bis + '</b>  ' + escapeHtml(r.veranstaltung) + '\n';
      const bits = [];
      if (r.raum) bits.push('🏫 ' + r.raum);
      if (r.dozent) bits.push('👤 ' + r.dozent);
      if (bits.length) text += '   <i>' + escapeHtml(bits.join('  ·  ')) + '</i>\n';
    }
  }
  return text;
}

// Sendet alle Monatsblöcke als separate Telegram-Messages und parkt die IDs
// in state.multiMessageIds — beim nächsten "Menü" o.ä. werden sie gelöscht.
// Editiert die Trigger-Message (callback-source) zur kompakten Übersicht.
async function sendStundenplanAlle(chatId, triggerMessageId) {
  // Erst alte Multi-Messages löschen (falls existent)
  await purgeMultiMessages(chatId);

  const { messages, totalEvents, totalMonths } = buildMonthlyStundenplan();

  // Trigger-Message wird zur Übersicht
  const overviewKb = stundenplanNav('stundenplan_alle');
  let overviewText;
  if (!messages.length) {
    overviewText = '📋 <b>Stundenplan — Alle</b>\n\nKeine kommenden Termine. 🎉';
    try {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: triggerMessageId,
        text: truncate(overviewText),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: overviewKb
      });
    } catch (_) { /* ignore */ }
    return;
  }

  overviewText = '📋 <b>Stundenplan — Alle</b>\n\n'
              + '<b>' + totalEvents + '</b> Termine in <b>' + totalMonths + '</b> Monaten\n'
              + '<i>Pro Monat eine Nachricht — werden gelöscht beim Wechsel zurück.</i>';
  try {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: triggerMessageId,
      text: truncate(overviewText),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: overviewKb
    });
  } catch (_) { /* ignore */ }

  // Sende eine Message pro Monatsblock (älteste oben, neueste unten — Telegram
  // zeigt neue Messages unten, also chronologisch wie wir's wollen).
  // 50ms-Throttle zwischen Messages, damit Telegram bei >5 Monaten nicht
  // mit "Too Many Requests: retry after N" antwortet (group-limit ~1 msg/sec
  // ist konservativ, ~20 msg/sec ist realistisches Cap).
  const newIds = [];
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 50));
    try {
      const sent = await tg('sendMessage', {
        chat_id: chatId,
        text: truncate(messages[i]),
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      if (sent && sent.message_id) newIds.push(sent.message_id);
    } catch (e) {
      state.logger?.log('Telegram sendStundenplanAlle: ' + safeErrMsg(e), 'warn');
    }
  }
  state.multiMessageIds = newIds;
}

// Löscht alle bisher gesendeten Multi-Messages (best-effort).
// allSettled + await sorgt dafür, dass ein direkt nachfolgender send() nicht
// mit dem Delete-Storm parallelisiert läuft — sonst kann Telegram die
// Reihenfolge umdrehen und die neue Menu-Message gleich wieder mit-löschen.
async function purgeMultiMessages(chatId) {
  if (!state.multiMessageIds || !state.multiMessageIds.length) return;
  const ids = state.multiMessageIds.slice();
  state.multiMessageIds = [];
  await Promise.allSettled(
    ids.map(mid => tg('deleteMessage', { chat_id: chatId, message_id: mid }))
  );
}

async function screenStatus() {
  const s = state.getStatus ? state.getStatus() : null;
  const database = db.getInstance();
  const stats = db.getStats(database);

  let text = '📟 <b>Server-Status</b>\n\n';
  if (s) {
    // Live-Tracking während eines Scrapes
    if (s.running) {
      const phase = s.currentPhase || 'starting';
      const phaseLabel = PHASE_LABELS_DE[phase] || phase;
      const elapsed = elapsedSec(s.phaseStartedAt);
      text += '🔄 <b>Scrape läuft</b>\n';
      text += '   Phase: <b>' + escapeHtml(phaseLabel) + '</b>';
      if (elapsed != null) text += '  <i>(' + elapsed + 's)</i>';
      text += '\n';
    } else if (s.lastError) {
      text += '⚠️ <b>Letzter Run mit Fehler</b>\n';
    } else {
      text += '💤 <b>Idle</b>\n';
    }

    text += '\n<b>Zeitplan</b>\n';
    text += '· Letzter Run: <b>' + escapeHtml(formatDateTime(s.lastRun)) + '</b>\n';
    text += '· Nächster Run: <b>'
         + escapeHtml(s.nextRun ? formatDateTime(s.nextRun) : (s.enabled ? '(berechnend)' : 'manuell'))
         + '</b>\n';
    text += '· Auto-Run: <b>' + (s.enabled ? `ein (${s.intervalMinutes} Min)` : 'aus') + '</b>\n';

    // Voll-Detail-Refresh: täglich am letzten Lauf des Tages + Sa-03:00-Backstop
    text += '\n<b>Detail-Check</b>  <i>(täglich, letzter Lauf · Sa 03:00 Backstop)</i>\n';
    text += '· Letzter Backstop: <b>'
         + escapeHtml(s.lastWeeklyDetailAt ? formatDateTime(s.lastWeeklyDetailAt) : 'noch nie')
         + '</b>\n';
    text += '· Nächster Backstop: <b>'
         + escapeHtml(s.nextWeeklyRun ? formatDateTime(s.nextWeeklyRun) : '–')
         + '</b>\n';

    // Letzter Lauf-Summary
    const ls = s.lastStats;
    if (ls && !s.running) {
      text += '\n<b>Letzter Lauf</b>\n';
      const n = ls.noten || {};
      const sp = ls.stundenplan || {};
      const det = ls.detail || {};
      text += '· Noten: <b>' + (n.inserted || 0) + '</b> neu, <b>' + (n.changed || 0) + '</b> geändert\n';
      text += '· Stundenplan: <b>' + (sp.inserted || 0) + '</b> neu';
      if (ls.pruned) text += ', <b>' + ls.pruned + '</b> vergangen entfernt';
      text += '\n';
      if (det.modulesScraped) {
        text += '· Details: <b>' + det.modulesScraped + '</b> Modul(e), <b>' + (det.totalEntries || 0) + '</b> Prüfung(en)';
        if (det.errors) text += ' <i>(' + det.errors + ' Fehler)</i>';
        text += '\n';
      }
    }

    if (s.lastError) {
      text += '\n⚠️ <b>Letzter Fehler:</b>\n<code>' + escapeHtml(safeErrMsg(s.lastError)) + '</code>\n';
    }
  } else {
    text += '<i>Status-Info nicht verfügbar.</i>\n';
  }
  text += '\n📊 <b>DB</b>: ' + stats.notenCount + ' Noten · ' + stats.notenWithGradeCount + ' benotet · ' + stats.stundenplanUpcoming + ' Events';

  // Aktualisieren-Button + Menü zurück
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Aktualisieren', callback_data: 'status' },
        { text: '⬅️ Menü', callback_data: 'menu' }
      ]
    ]
  };
  return { text, keyboard };
}

// Baut den Live-Status-Text für die /scrape-Message basierend auf state.
// running=true → Phase + Sekunden seit Phasen-Start.
// running=false → finale Zusammenfassung (oder Fehler).
function buildScrapeLiveText(s) {
  if (!s) return '🔄 <b>Scrape gestartet</b>';
  if (s.running) {
    const phase = s.currentPhase || 'starting';
    const phaseLabel = PHASE_LABELS_DE[phase] || phase;
    const elapsed = elapsedSec(s.phaseStartedAt);
    let text = '🔄 <b>Scrape läuft…</b>\n\n';
    text += '<b>Phase:</b> ' + escapeHtml(phaseLabel);
    if (elapsed != null) text += '  <i>(' + elapsed + 's)</i>';
    return text;
  }
  // Fertig
  if (s.lastError) {
    return '❌ <b>Scrape-Fehler</b>\n<code>' + escapeHtml(safeErrMsg(s.lastError)) + '</code>';
  }
  let text = '✅ <b>Scrape fertig</b>\n\n';
  if (s.lastRun) text += '<i>' + escapeHtml(formatDateTime(s.lastRun)) + '</i>\n\n';
  const ls = s.lastStats;
  if (ls) {
    const n = ls.noten || {};
    const sp = ls.stundenplan || {};
    const det = ls.detail || {};
    text += '· Noten: <b>' + (n.inserted || 0) + '</b> neu, <b>' + (n.changed || 0) + '</b> geändert\n';
    text += '· Stundenplan: <b>' + (sp.inserted || 0) + '</b> neu';
    if (ls.pruned) text += ', <b>' + ls.pruned + '</b> vergangen entfernt';
    text += '\n';
    if (det.modulesScraped) {
      text += '· Details: <b>' + det.modulesScraped + '</b> Modul(e), <b>' + (det.totalEntries || 0) + '</b> Prüfung(en)';
      if (det.errors) text += ' <i>(' + det.errors + ' Fehler)</i>';
      text += '\n';
    }
  }
  return text.trim();
}

// Stoppt den Live-Polling-Timer für die /scrape-Message.
function stopScrapePoll() {
  if (state.scrapePollTimer) {
    clearTimeout(state.scrapePollTimer);
    state.scrapePollTimer = null;
  }
  state.scrapeMessage = null;
}

// Startet das Live-Polling auf einer bestimmten Message. Editiert sie alle
// 2.5s mit dem aktuellen Status, bis state.running false wird — dann ein
// finaler Edit mit Summary, danach stop.
//
// Rekursives `setTimeout` statt `setInterval`: bei langsamen Telegram-Calls
// (>2.5s) überlappen sich Interval-Ticks und schicken parallel `editMessageText`.
// Mit recursive-setTimeout wird der nächste Tick erst geplant, NACHDEM der
// vorherige `tick()` abgeschlossen ist — saubere Serialisierung.
function startScrapePoll(chatId, messageId) {
  // Falls schon läuft (z.B. doppelter /scrape), alten Timer stoppen
  stopScrapePoll();
  state.scrapeMessage = { chatId, messageId };

  let lastText = null;
  let stoppedAfterDone = false;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    // Sicherheit: User hat zur Menü navigiert → Message gehört nicht mehr uns
    if (!state.scrapeMessage || state.scrapeMessage.messageId !== messageId) {
      stopped = true;
      stopScrapePoll();
      return;
    }
    const s = state.getStatus ? state.getStatus() : null;
    const text = buildScrapeLiveText(s);

    // Nur editieren wenn sich was geändert hat — spart Telegram-API-Calls
    if (text !== lastText) {
      try {
        await tg('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: truncate(text),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: okMenuKb()
        });
        lastText = text;
      } catch (e) {
        // Message wurde gelöscht oder ist zu alt → Polling stoppen
        if (/message.*not found|message can't be edited/i.test(e.message || '')) {
          stopped = true;
          stopScrapePoll();
          return;
        }
        // Andere Fehler (z.B. 429) → einfach ignorieren, beim nächsten Tick neu versuchen
      }
    }

    // Wenn Scrape fertig: einmal noch updaten (mit Summary), dann stop
    if (s && !s.running) {
      if (stoppedAfterDone) {
        stopped = true;
        stopScrapePoll();
        return;
      }
      stoppedAfterDone = true; // nächster Tick stoppt
    }

    // Nächsten Tick erst NACH Abschluss dieses planen — verhindert das
    // setInterval-Overlap-Problem bei langsamen Telegram-Calls.
    if (!stopped) {
      state.scrapePollTimer = setTimeout(() => { tick().catch(() => {}); }, 2500);
    }
  };

  // Erster Tick sofort
  tick().catch(() => {});
}

async function screenScrape() {
  if (!state.triggerScrape) {
    return { text: '⚠️ Scrape-Trigger nicht verfügbar.', keyboard: simpleNav() };
  }
  try {
    const r = await state.triggerScrape();
    if (r && r.triggered === false) {
      // Bereits aktiv → trotzdem Live-Tracking auf existierende Session
      // (das wird nach Render gestartet via showScrapeProgressFor)
      return {
        text: '⏳ <b>Bereits ein Scrape aktiv</b>'
            + (r.reason ? '\n<i>' + escapeHtml(r.reason) + '</i>' : ''),
        keyboard: okMenuKb(),
        startLivePoll: true
      };
    }
    return {
      text: '🔄 <b>Scrape gestartet</b>',
      keyboard: okMenuKb(),
      startLivePoll: true
    };
  } catch (e) {
    return {
      text: '❌ <b>Fehler</b>\n<code>' + escapeHtml(safeErrMsg(e)) + '</code>',
      keyboard: okMenuKb()
    };
  }
}

const SCREENS = {
  menu: screenMenu,
  noten: screenNoten,
  durchschnitt: screenDurchschnitt,
  heute: screenHeute,
  morgen: screenMorgen,
  woche: screenWoche,
  stundenplan: screenStundenplan,
  status: screenStatus,
  scrape: screenScrape
};

module.exports = {
  SCREENS,
  screenMenu,
  screenNoten,
  screenModulDetail,
  screenDurchschnitt,
  screenHeute,
  screenMorgen,
  screenWoche,
  screenStundenplan,
  screenStatus,
  screenScrape,
  buildMonthlyStundenplan,
  buildMonthMessage,
  sendStundenplanAlle,
  purgeMultiMessages,
  buildScrapeLiveText,
  stopScrapePoll,
  startScrapePoll
};

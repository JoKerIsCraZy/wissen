'use strict';

const state = require('./state');
const { sendPush } = require('./telegram');
const {
  escapeHtml,
  dayLabel,
  formatNoteColor,
  extractModulNummer,
  formatPruefungenBlock
} = require('./format');

async function notify(text, opts = {}) {
  if (!state.running || !state.allowedUserId || !state.token) return;
  try {
    await sendPush(state.allowedUserId, text, opts.keyboard);
  } catch (e) {
    state.logger?.log('Telegram notify failed: ' + e.message, 'warn');
  }
}

/**
 * Detaillierte Push-Nachricht bei Noten-Änderungen.
 * changes: Array von { type, kuerzel_id, fach_name, semester, prev_note, new_note }
 * stats:   optional, getStats-Ergebnis für Ø-Anzeige
 * pruefungenByKuerzel: optional, { kuerzel_id: [pruefungen...] } — zeigt LB/ZP-Liste
 * pruefungenChangesByKuerzel: optional, { kuerzel_id: [{ pruefung_typ, pruefung_nr,
 *   bezeichnung, gewicht, prev_bewertung, new_bewertung }, ...] } — zeigt
 *   "ZP1: 4.0 → 4.5"-Diff direkt unter der Modul-Note. Quelle: ps.changedEntries
 *   aus savePruefungen.
 */
async function notifyGradeChanges(changes, stats, pruefungenByKuerzel, pruefungenChangesByKuerzel) {
  if (!state.running || !state.allowedUserId || !state.token) return;
  if (!changes || !changes.length) return;

  const news = changes.filter(c => c.type === 'new');
  const upd = changes.filter(c => c.type === 'changed');

  let text;
  if (changes.length === 1) {
    const c = changes[0];
    text = c.type === 'new'
      ? '🎉 <b>Neue Note!</b>\n\n'
      : '📝 <b>Note aktualisiert</b>\n\n';
  } else {
    const parts = [];
    if (news.length) parts.push(news.length + ' neue');
    if (upd.length) parts.push(upd.length + ' geändert');
    text = '🔔 <b>Noten-Update</b>  <i>(' + parts.join(', ') + ')</i>\n\n';
  }

  // Neue Noten zuerst, dann Änderungen — je sortiert nach Note absteigend
  const sections = [
    { list: news, label: news.length && changes.length > 1 ? '🎉 <b>Neu</b>' : null },
    { list: upd,  label: upd.length && changes.length > 1 ? '📝 <b>Geändert</b>' : null }
  ];

  for (const sec of sections) {
    if (!sec.list.length) continue;
    if (sec.label) text += sec.label + '\n';
    sec.list.sort((a, b) => (b.new_note || 0) - (a.new_note || 0));
    for (const c of sec.list) {
      const sem = c.semester ? '  <i>' + escapeHtml(c.semester) + '</i>' : '';
      const mod = extractModulNummer(c);
      const modPrefix = mod ? '<code>' + escapeHtml(mod) + '</code> ' : '';
      text += '📚 ' + modPrefix + '<b>' + escapeHtml(c.fach_name) + '</b>' + sem + '\n';
      if (c.type === 'new') {
        text += '   ' + formatNoteColor(c.new_note) + ' <b>' + c.new_note.toFixed(1) + '</b>\n';
      } else {
        const prevColor = formatNoteColor(c.prev_note);
        const newColor = formatNoteColor(c.new_note);
        const prevStr = c.prev_note != null ? c.prev_note.toFixed(1) : '—';
        const newStr = c.new_note != null ? c.new_note.toFixed(1) : '—';
        const arrow = c.prev_note != null && c.new_note != null
          ? (c.new_note > c.prev_note ? ' 📈' : c.new_note < c.prev_note ? ' 📉' : '')
          : '';
        text += '   ' + prevColor + ' ' + prevStr + '  →  ' + newColor + ' <b>' + newStr + '</b>' + arrow + '\n';
      }
      // ZP/LB-Wert-Änderungen die diesen Modul-Schnitt-Wechsel verursacht
      // haben — als kleiner Diff-Block direkt unter der Modul-Note. Sortiert
      // ZP > LB > OTHER, dann nr.
      const pc = pruefungenChangesByKuerzel && c.kuerzel_id
        ? pruefungenChangesByKuerzel[c.kuerzel_id] : null;
      if (pc && pc.length) {
        const sorted = [...pc].sort((a, b) => {
          const order = { ZP: 0, LB: 1, OTHER: 2 };
          const oa = order[a.pruefung_typ] != null ? order[a.pruefung_typ] : 9;
          const ob = order[b.pruefung_typ] != null ? order[b.pruefung_typ] : 9;
          if (oa !== ob) return oa - ob;
          return (a.pruefung_nr || 0) - (b.pruefung_nr || 0);
        });
        for (const p of sorted) {
          const label = p.pruefung_typ === 'OTHER'
            ? (p.bezeichnung || ('Prüfung ' + (p.pruefung_nr || '')))
            : (p.pruefung_typ + ' ' + (p.pruefung_nr || ''));
          const prevColor = formatNoteColor(p.prev_bewertung);
          const newColor = formatNoteColor(p.new_bewertung);
          const prevStr = p.prev_bewertung != null ? Number(p.prev_bewertung).toFixed(1) : '—';
          const newStr = p.new_bewertung != null ? Number(p.new_bewertung).toFixed(1) : '—';
          const arrow = p.prev_bewertung != null && p.new_bewertung != null
            ? (p.new_bewertung > p.prev_bewertung ? ' 📈' : p.new_bewertung < p.prev_bewertung ? ' 📉' : '')
            : '';
          text += '   ↳ <code>' + escapeHtml(label) + '</code>  '
            + prevColor + ' ' + prevStr + '  →  ' + newColor + ' <b>' + newStr + '</b>' + arrow + '\n';
        }
      }
      // Detail-Prüfungen für dieses Modul (falls vom Aufrufer bereitgestellt)
      const ps = pruefungenByKuerzel && c.kuerzel_id ? pruefungenByKuerzel[c.kuerzel_id] : null;
      if (ps && ps.length) {
        text += formatPruefungenBlock(ps) + '\n';
      }
      text += '\n';
    }
  }

  text += '━━━━━━━━━━━━━━━━━━\n';
  if (stats && stats.avgNote != null) {
    text += '🎯 Ø gesamt: <b>' + stats.avgNote + '</b>';
    if (stats.avgBySemester && Object.keys(stats.avgBySemester).length) {
      const parts = Object.entries(stats.avgBySemester)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([s, v]) => `${s}: <b>${v}</b>`);
      text += '  ·  ' + parts.join(' · ');
    }
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📚 Alle Noten', callback_data: 'noten' },
        { text: '📟 Menü', callback_data: 'menu' }
      ]
    ]
  };

  try {
    await sendPush(state.allowedUserId, text, keyboard);
  } catch (e) {
    state.logger?.log('Telegram notifyGradeChanges failed: ' + e.message, 'warn');
  }
}

/**
 * Push-Nachricht bei Raumwechsel / Online-Switch.
 * changes: Array von { datum_iso, zeit_von, zeit_bis, veranstaltung, dozent,
 *                       prev_raum, new_raum, wentOnline, wentOffline }
 */
async function notifyRoomChanges(changes) {
  if (!state.running || !state.allowedUserId || !state.token) return;
  if (!changes || !changes.length) return;

  // Gruppierung: "went online" separat herausheben (auffälligste Änderung)
  const online = changes.filter(c => c.wentOnline);
  const offline = changes.filter(c => c.wentOffline);
  const rest = changes.filter(c => !c.wentOnline && !c.wentOffline);

  let text;
  if (changes.length === 1) {
    const c = changes[0];
    if (c.wentOnline) text = '🌐 <b>Lektion wechselt auf ONLINE</b>\n\n';
    else if (c.wentOffline) text = '🏫 <b>Lektion wechselt zu Präsenz</b>\n\n';
    else text = '📍 <b>Raumwechsel</b>\n\n';
  } else {
    const parts = [];
    if (online.length) parts.push(online.length + ' online');
    if (offline.length) parts.push(offline.length + ' präsenz');
    if (rest.length) parts.push(rest.length + ' raumwechsel');
    text = '📍 <b>' + changes.length + ' Lektionen geändert</b>  <i>(' + parts.join(', ') + ')</i>\n\n';
  }

  const sections = [
    { list: online,  icon: '🌐', label: online.length && changes.length > 1 ? '🌐 <b>Jetzt online</b>' : null },
    { list: offline, icon: '🏫', label: offline.length && changes.length > 1 ? '🏫 <b>Jetzt Präsenz</b>' : null },
    { list: rest,    icon: '📍', label: rest.length && changes.length > 1 ? '📍 <b>Raumwechsel</b>' : null }
  ];

  for (const sec of sections) {
    if (!sec.list.length) continue;
    if (sec.label) text += sec.label + '\n\n';
    sec.list.sort((a, b) => (a.datum_iso + a.zeit_von).localeCompare(b.datum_iso + b.zeit_von));
    for (const c of sec.list) {
      const datum = dayLabel(c.datum_iso);
      text += '<b>' + escapeHtml(datum) + '</b>\n';
      text += '🕐 ' + c.zeit_von + '–' + c.zeit_bis + '\n';
      text += '📚 ' + escapeHtml(c.veranstaltung) + '\n';
      text += '🏫 <s>' + escapeHtml(c.prev_raum) + '</s> → <b>' + escapeHtml(c.new_raum) + '</b>\n';
      if (c.dozent) text += '👤 ' + escapeHtml(c.dozent) + '\n';
      text += '\n';
    }
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '☀️ Heute', callback_data: 'heute' },
        { text: '🌅 Morgen', callback_data: 'morgen' },
        { text: '📆 Woche', callback_data: 'woche' }
      ]
    ]
  };

  try {
    await sendPush(state.allowedUserId, text.trim(), keyboard);
  } catch (e) {
    state.logger?.log('Telegram notifyRoomChanges failed: ' + e.message, 'warn');
  }
}

/**
 * Detail-Refresh-Bericht — Push wird ausgelöst wenn der Voll-Detail-Scrape
 * neue (benotete) ZP/LB-Einträge entdeckt hat, OHNE dass sich die Modulnote
 * geändert hätte (Edge-Case ZP=5.5 + LB=5.5). Läuft beim täglichen Voll-
 * Refresh (letzter Lauf des Tages) sowie beim Sa-Backstop.
 *
 * report: Array von { kuerzel_id, kuerzel_code, fach_name, semester, added: [...] }
 *   added = Array von { pruefung_typ, pruefung_nr, bezeichnung, gewicht, bewertung }
 * Leeres Report-Array → kein Push.
 */
async function notifyWeeklyDetailReport(report) {
  if (!state.running || !state.allowedUserId || !state.token) return;
  if (!Array.isArray(report) || !report.length) return;

  const totalAdded = report.reduce((sum, r) => sum + (r.added ? r.added.length : 0), 0);
  if (!totalAdded) return;

  let text = '🔍 <b>Detail-Check</b>  <i>(' + totalAdded + ' neue Prüfung'
           + (totalAdded === 1 ? '' : 'en') + ')</i>\n\n';
  text += '<i>Diese ZP/LB sind seit dem letzten Check dazugekommen — die Modulnote selbst hat sich aber nicht geändert.</i>\n\n';

  for (const m of report) {
    if (!m.added || !m.added.length) continue;
    const sem = m.semester ? '  <i>' + escapeHtml(m.semester) + '</i>' : '';
    const mod = extractModulNummer(m);
    const modPrefix = mod ? '<code>' + escapeHtml(mod) + '</code> ' : '';
    text += '📚 ' + modPrefix + '<b>' + escapeHtml(m.fach_name || m.kuerzel_id) + '</b>' + sem + '\n';

    // Sortierung: ZP vor LB vor OTHER, dann nach nr
    const sorted = [...m.added].sort((a, b) => {
      const order = { ZP: 0, LB: 1, OTHER: 2 };
      const oa = order[a.pruefung_typ] != null ? order[a.pruefung_typ] : 9;
      const ob = order[b.pruefung_typ] != null ? order[b.pruefung_typ] : 9;
      if (oa !== ob) return oa - ob;
      return (a.pruefung_nr || 0) - (b.pruefung_nr || 0);
    });

    for (const p of sorted) {
      const note = p.bewertung != null ? Number(p.bewertung).toFixed(1) : '—';
      const color = formatNoteColor(p.bewertung);
      const label = p.pruefung_typ === 'OTHER'
        ? (p.bezeichnung || ('Prüfung ' + (p.pruefung_nr || '')))
        : (p.pruefung_typ + ' ' + (p.pruefung_nr || ''));
      const gewicht = p.gewicht ? ' <i>' + escapeHtml(p.gewicht) + '</i>' : '';
      text += '   ' + color + ' <code>' + escapeHtml(label) + '</code>' + gewicht + '  <b>' + note + '</b>\n';
    }
    text += '\n';
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📚 Alle Noten', callback_data: 'noten' },
        { text: '📟 Menü', callback_data: 'menu' }
      ]
    ]
  };

  try {
    await sendPush(state.allowedUserId, text.trim(), keyboard);
  } catch (e) {
    state.logger?.log('Telegram notifyWeeklyDetailReport failed: ' + e.message, 'warn');
  }
}

/**
 * Standalone-Push wenn ZP/LB-Werte sich geändert haben, der Modul-Schnitt
 * sich aber NICHT geändert hat (Edge-Case: Tocco-Rundung verschluckt den
 * Diff, oder mehrere Prüfungen heben sich gegenseitig auf). Wird nur für
 * Module aufgerufen, die NICHT bereits in einem gradeChanges-Push sind.
 *
 * report: Array von { kuerzel_id, kuerzel_code, fach_name, semester,
 *   changed: [{ pruefung_typ, pruefung_nr, bezeichnung, gewicht, gewicht_pct,
 *               prev_bewertung, new_bewertung }, ...] }
 */
async function notifyPruefungenChanges(report) {
  if (!state.running || !state.allowedUserId || !state.token) return;
  if (!Array.isArray(report) || !report.length) return;

  const totalChanged = report.reduce((s, r) => s + (r.changed ? r.changed.length : 0), 0);
  if (!totalChanged) return;

  let text = '✏️ <b>Prüfung'
    + (totalChanged === 1 ? '' : 'en')
    + ' aktualisiert</b>  <i>(' + totalChanged + ')</i>\n\n';
  text += '<i>Eine ZP/LB-Bewertung wurde geändert, der Modul-Schnitt bleibt aber gerundet identisch.</i>\n\n';

  for (const m of report) {
    if (!m.changed || !m.changed.length) continue;
    const sem = m.semester ? '  <i>' + escapeHtml(m.semester) + '</i>' : '';
    const mod = extractModulNummer(m);
    const modPrefix = mod ? '<code>' + escapeHtml(mod) + '</code> ' : '';
    text += '📚 ' + modPrefix + '<b>' + escapeHtml(m.fach_name || m.kuerzel_id) + '</b>' + sem + '\n';

    const sorted = [...m.changed].sort((a, b) => {
      const order = { ZP: 0, LB: 1, OTHER: 2 };
      const oa = order[a.pruefung_typ] != null ? order[a.pruefung_typ] : 9;
      const ob = order[b.pruefung_typ] != null ? order[b.pruefung_typ] : 9;
      if (oa !== ob) return oa - ob;
      return (a.pruefung_nr || 0) - (b.pruefung_nr || 0);
    });
    for (const p of sorted) {
      const label = p.pruefung_typ === 'OTHER'
        ? (p.bezeichnung || ('Prüfung ' + (p.pruefung_nr || '')))
        : (p.pruefung_typ + ' ' + (p.pruefung_nr || ''));
      const prevColor = formatNoteColor(p.prev_bewertung);
      const newColor = formatNoteColor(p.new_bewertung);
      const prevStr = p.prev_bewertung != null ? Number(p.prev_bewertung).toFixed(1) : '—';
      const newStr = p.new_bewertung != null ? Number(p.new_bewertung).toFixed(1) : '—';
      const gewicht = p.gewicht ? ' <i>' + escapeHtml(p.gewicht) + '</i>' : '';
      const arrow = p.prev_bewertung != null && p.new_bewertung != null
        ? (p.new_bewertung > p.prev_bewertung ? ' 📈' : p.new_bewertung < p.prev_bewertung ? ' 📉' : '')
        : '';
      text += '   <code>' + escapeHtml(label) + '</code>' + gewicht + '  '
        + prevColor + ' ' + prevStr + '  →  ' + newColor + ' <b>' + newStr + '</b>' + arrow + '\n';
    }
    text += '\n';
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📚 Alle Noten', callback_data: 'noten' },
        { text: '📟 Menü', callback_data: 'menu' }
      ]
    ]
  };

  try {
    await sendPush(state.allowedUserId, text.trim(), keyboard);
  } catch (e) {
    state.logger?.log('Telegram notifyPruefungenChanges failed: ' + e.message, 'warn');
  }
}

/**
 * Push-Nachricht bei neuer/geänderter Absenz (Nicht-Teilnahme). Pusht NIE bei
 * Teilgenommen/Offen — der Aufrufer (runScrapeCycle) übergibt nur newAbwesend-
 * Einträge (siehe saveLektionen-Vertrag §9). Text ist nach Kategorie
 * differenziert:
 *   abwesend_unentschuldigt → "⚠️ … UNENTSCHULDIGT abwesend"
 *   abwesend_prozent        → "🚫 … <status_raw>" (z.B. "Abwesend 50%")
 *   abwesend_entschuldigt   → "ℹ️ … abwesend (entschuldigt)" (pusht i.d.R. nicht)
 *   Status-Wechsel          → "… Status geändert: <neu>"
 *
 * report: Array von { kuerzel_code, bezeichnung, lektionen: newAbwesend[] }
 *   newAbwesend = { termin_iso, termin_raw, zeit_von, zeit_bis, status_cat,
 *                   statusChanged? }
 * Leeres Report-Array oder 0 Lektionen → kein Push.
 */
async function notifyNeueAbsenzen(report) {
  if (!state.running || !state.allowedUserId || !state.token) return;
  if (!Array.isArray(report) || !report.length) return;

  const totalLektionen = report.reduce((s, r) => s + (r.lektionen ? r.lektionen.length : 0), 0);
  if (!totalLektionen) return;

  let text = '🚫 <b>Neue Absenz'
    + (totalLektionen === 1 ? '' : 'en')
    + '</b>  <i>(' + totalLektionen + ')</i>\n\n';

  for (const m of report) {
    if (!m.lektionen || !m.lektionen.length) continue;
    const mod = extractModulNummer(m);
    const modPrefix = mod ? '<code>' + escapeHtml(mod) + '</code> ' : '';
    text += '📚 ' + modPrefix + '<b>' + escapeHtml(m.bezeichnung || m.kuerzel_code || 'Modul') + '</b>\n';

    // Sortierung: chronologisch nach Termin (termin_iso + zeit_von).
    const sorted = [...m.lektionen].sort((a, b) =>
      ((a.termin_iso || '') + (a.zeit_von || '')).localeCompare((b.termin_iso || '') + (b.zeit_von || '')));

    for (const l of sorted) {
      const termin = escapeHtml(l.termin_raw || l.termin_iso || '');
      if (l.statusChanged) {
        let label;
        if (l.status_cat === 'abwesend_unentschuldigt') label = 'unentschuldigt';
        else if (l.status_cat === 'abwesend_prozent') label = escapeHtml(l.status_raw || 'abwesend');
        else if (l.status_cat === 'abwesend_entschuldigt') label = 'entschuldigt';
        else label = escapeHtml(String(l.status_cat || ''));
        text += '   🔄 ' + termin + ' — Status geändert: <b>' + label + '</b>\n';
      } else if (l.status_cat === 'abwesend_unentschuldigt') {
        text += '   ⚠️ ' + termin + ' — <b>UNENTSCHULDIGT</b> abwesend\n';
      } else if (l.status_cat === 'abwesend_prozent') {
        text += '   🚫 ' + termin + ' — <b>' + escapeHtml(l.status_raw || 'Abwesend') + '</b>\n';
      } else {
        text += '   ℹ️ ' + termin + ' — abwesend (entschuldigt)\n';
      }
    }
    text += '\n';
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📟 Menü', callback_data: 'menu' }
      ]
    ]
  };

  try {
    await sendPush(state.allowedUserId, text.trim(), keyboard);
  } catch (e) {
    state.logger?.log('Telegram notifyNeueAbsenzen failed: ' + e.message, 'warn');
  }
}

module.exports = {
  notify,
  notifyGradeChanges,
  notifyRoomChanges,
  notifyWeeklyDetailReport,
  notifyPruefungenChanges,
  notifyNeueAbsenzen
};

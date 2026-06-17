'use strict';

const state = require('./state');
const { tg, showScreen, editMessage, send } = require('./telegram');
const { escapeHtml } = require('./format');
const {
  SCREENS,
  screenModulDetail,
  sendStundenplanAlle,
  purgeMultiMessages,
  stopScrapePoll,
  startScrapePoll
} = require('./screens');

// Defensive Error-Formatierung — gleiches Pattern wie in screens.js,
// hier als lokale Kopie statt Cross-Module-Import (screens.js exportiert
// safeErrMsg nicht öffentlich, und Duplikation ist hier billiger als
// noch ein Cycle zwischen den Modulen).
function safeErrMsg(e) {
  const raw = String((e && e.message) || e || '');
  return raw.replace(/\n+/g, ' ').slice(0, 500);
}

// Slash-Command → Screen-Mapping (für Power-User)
const CMD_MAP = {
  '/start': 'menu',
  '/menu': 'menu',
  '/help': 'menu',
  '/noten': 'noten',
  '/durchschnitt': 'durchschnitt',
  '/heute': 'heute',
  '/morgen': 'morgen',
  '/woche': 'woche',
  '/stundenplan': 'stundenplan',
  '/abfrage': 'scrape',  // kanonisch — mappt auf denselben Screen wie /scrape
  '/scrape': 'scrape',   // alter Alias, bleibt aktiv
  '/status': 'status'
};

// ---------- Update-Handler ----------
async function handleMessage(msg) {
  if (!msg.text) return;
  const raw = msg.text.trim().split(/\s+/)[0].toLowerCase();
  const cmd = raw.split('@')[0];
  const screenName = CMD_MAP[cmd] || 'menu';

  // Wenn User auf einen anderen Command als /scrape wechselt → laufendes
  // Live-Polling stoppen, sonst würde der Polling-Timer das neue Screen
  // überschreiben.
  if (screenName !== 'scrape') stopScrapePoll();

  // Outer try/catch: wenn das Screen-Building oder showScreen wirft,
  // bekommt der User trotzdem ein Feedback (sonst sieht er nur eine
  // ungelöschte Command-Message). Die Cleanup-Schritte (purgeMulti +
  // Command-Löschung) müssen trotzdem laufen, daher in finally.
  try {
    // Multi-Messages aufräumen sobald der User irgendeinen Slash-Command tippt
    // (kein Bedarf, die monatlichen Stundenplan-Posts noch im Chat zu lassen).
    if (state.multiMessageIds && state.multiMessageIds.length) {
      await purgeMultiMessages(msg.chat.id);
    }

    const screen = await SCREENS[screenName]();

    // Eine einzige Menu-Nachricht: editiere die letzte, sonst neu
    await showScreen(msg.chat.id, screen);

    // /scrape → Polling auf der gerade gerenderten Message starten
    if (screen.startLivePoll && state.lastMenuMessageId) {
      startScrapePoll(msg.chat.id, state.lastMenuMessageId);
    }
  } catch (e) {
    state.logger?.log('Message handler error: ' + safeErrMsg(e), 'error');
    // Best-effort User-Feedback. send() läuft selbst durch die Menü-Mutex-
    // Kette und wird die Error-Message als neues Menü darstellen.
    try {
      await send(msg.chat.id, '❌ <code>' + escapeHtml(safeErrMsg(e)) + '</code>');
    } catch (_) { /* nichts mehr zu tun */ }
  } finally {
    // User-Command-Message löschen um Chat sauber zu halten (best-effort)
    tg('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
  }
}

async function handleCallback(cb) {
  // Spinner sofort wegnehmen
  tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});

  if (!cb.message) return;
  const chatId = cb.message.chat.id;

  // Wenn der User von einer aktiven Scrape-Live-Message wegnavigiert,
  // Polling stoppen — sonst würde der Timer das Menü überschreiben.
  if (state.scrapeMessage && cb.message.message_id === state.scrapeMessage.messageId) {
    stopScrapePoll();
  }

  // Dismiss: Push-Message löschen
  if (cb.data === 'dismiss') {
    try {
      await tg('deleteMessage', { chat_id: chatId, message_id: cb.message.message_id });
    } catch (_) { /* best-effort */ }
    return;
  }

  // Spezial-Handler: Stundenplan „Alle" — sendet mehrere Messages
  if (cb.data === 'stundenplan_alle') {
    try {
      await sendStundenplanAlle(chatId, cb.message.message_id);
      state.lastMenuMessageId = cb.message.message_id;
    } catch (e) {
      state.logger?.log('Callback handler error (stundenplan_alle): ' + (e.message || e), 'error');
    }
    return;
  }

  // Bei JEDEM anderen Callback: zuerst die Multi-Messages bereinigen
  // (z.B. User klickt „Menü" oder „Heute" aus einer Multi-Message-Übersicht).
  if (state.multiMessageIds && state.multiMessageIds.length) {
    await purgeMultiMessages(chatId);
  }

  // Statische Screens
  let screenPromise;
  if (SCREENS[cb.data]) {
    screenPromise = SCREENS[cb.data]();
  } else if (cb.data && cb.data.startsWith('modul_')) {
    // Dynamischer Modul-Detail-Screen, callback_data = 'modul_<kuerzel_id>'
    const kuerzelId = cb.data.slice('modul_'.length);
    screenPromise = screenModulDetail(kuerzelId);
  } else {
    return; // unbekanntes callback ignorieren
  }

  try {
    const screen = await screenPromise;
    await editMessage(chatId, cb.message.message_id, screen.text, screen.keyboard);
    // Das Callback-Message IST jetzt das aktuelle Menü
    state.lastMenuMessageId = cb.message.message_id;
    // Wenn der Screen Live-Polling will (z.B. nach /scrape), starte den Timer
    // auf der Message die wir gerade editiert haben.
    if (screen.startLivePoll) {
      startScrapePoll(chatId, cb.message.message_id);
    }
  } catch (e) {
    state.logger?.log('Callback handler error: ' + safeErrMsg(e), 'error');
    await tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: '❌ ' + safeErrMsg(e),
      show_alert: true
    }).catch(() => {});
  }
}

async function handleUpdate(update) {
  // Whitelist-Check für die zwei erlaubten Update-Typen.
  //
  // Bewusst KEIN Default-Fallback für unbekannte Update-Typen (channel_post,
  // business_message, my_chat_member, poll_answer, chat_join_request, ...).
  // Wir whitelisten in `getUpdates` schon via `allowed_updates`, aber falls
  // Telegram einen neuen Typ pusht, wird er hier silent ignoriert statt
  // gegen einen ungeprüften `from`-Lookup zu laufen.
  //
  // `edited_message` wird bewusst NICHT verarbeitet: ein nachträglich
  // editierter alter Befehl würde sonst als frischer Command re-executen
  // (z.B. /scrape). Der Bot führt kein Chat-Protokoll — es gibt keinen
  // legitimen Use-Case für Edit-Re-Execution.
  const from = (update.message?.from) || (update.callback_query?.from);
  if (!from || from.id !== state.allowedUserId) {
    state.logger?.log(`📱 Abgelehnt: User ${from?.id} (${from?.username || 'no username'})`, 'warn');
    return;
  }

  if (update.callback_query) return handleCallback(update.callback_query);
  if (update.message) return handleMessage(update.message);
  // Unknown update type → silent drop (siehe Whitelist-Kommentar oben).
}

// ---------- Poll Loop ----------
async function pollLoop() {
  let backoff = 1000;
  while (state.running) {
    try {
      const updates = await tg('getUpdates', { offset: state.offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      backoff = 1000;
      for (const u of updates) {
        try {
          await handleUpdate(u);
        } catch (e) {
          state.logger?.log('Update handler: ' + safeErrMsg(e), 'error');
        }
        // Offset wird ERST NACH erfolgreichem Handling vorgeschoben — bei Crash
        // zwischen den Schritten re-deliver't Telegram das Update beim nächsten Poll.
        // Ausserdem: serielle Verarbeitung eliminiert die State-Mutation-Races
        // (lastMenuMessageId, multiMessageIds, scrapeMessage) zwischen parallelen
        // Callbacks. Bei Single-User-Bot ist die Throughput-Einbuße null —
        // typische Update-Rate ist <1/sec.
        state.offset = u.update_id + 1;
      }
    } catch (e) {
      if (!state.running) return;
      state.logger?.log('Bot poll error: ' + safeErrMsg(e) + ' (retry in ' + Math.round(backoff / 1000) + 's)', 'warn');
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

module.exports = { handleMessage, handleCallback, handleUpdate, pollLoop, CMD_MAP };

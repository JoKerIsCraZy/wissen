/**
 * Telegram-Bot für Tocco WISS — Menu-basierte Navigation via Inline-Buttons.
 *
 * Whitelist-basiert: nur eine definierte User-ID darf interagieren.
 * Zero Dependencies — nutzt native fetch + long-polling.
 *
 * Hauptmenü erreichbar via /start oder /menu.
 * Slash-Commands funktionieren weiterhin als Shortcuts.
 */

'use strict';

const state = require('./state');
const { tg } = require('./telegram');
const { pollLoop } = require('./handlers');
const { stopScrapePoll } = require('./screens');
const {
  notify,
  notifyGradeChanges,
  notifyRoomChanges,
  notifyWeeklyDetailReport,
  notifyPruefungenChanges,
  notifyNeueAbsenzen
} = require('./notify');

// Aktuelle Poll-Loop-Promise — wird von start() befüllt, von stop() awaited.
// Verhindert Race-Conditions wenn settings-reconfig den Bot mit neuem Token
// neu startet, während die alte Long-Poll-getUpdates-Anfrage noch 30s läuft.
let pollPromise = null;

// ---------- Public API ----------
async function start(cfg) {
  if (!cfg.token) throw new Error('telegramToken fehlt');
  if (!cfg.allowedUserId) throw new Error('telegramAllowedUserId fehlt');
  if (state.running) return;

  state.token = cfg.token;
  state.allowedUserId = Number(cfg.allowedUserId);
  state.logger = cfg.logger || null;
  state.triggerScrape = cfg.triggerScrape || null;
  state.getStatus = cfg.getStatus || null;
  state.running = true;

  try {
    const me = await tg('getMe');
    state.logger?.log(`📱 Telegram-Bot @${me.username} online, Whitelist: ${state.allowedUserId}`, 'info');
    // Set Command-Menü im Telegram-Client ("/" zeigt Liste).
    // Fire-and-forget (keine await) damit ein langsamer setMyCommands-Call
    // den Bot-Start nicht blockiert. Errors werden geloggt statt verschluckt
    // — bisher hatte `.catch(() => {})` z.B. invalidate-Token-Fehler komplett
    // unsichtbar gemacht.
    tg('setMyCommands', {
      commands: [
        { command: 'menu', description: 'Hauptmenü öffnen' },
        { command: 'noten', description: 'Alle Noten + Durchschnitt' },
        { command: 'durchschnitt', description: 'Nur Durchschnitt' },
        { command: 'heute', description: 'Stundenplan heute' },
        { command: 'morgen', description: 'Stundenplan morgen' },
        { command: 'woche', description: 'Nächste Woche' },
        { command: 'stundenplan', description: 'Alle kommenden Lektionen' },
        { command: 'abfrage', description: 'Manuelle Abfrage' },
        { command: 'scrape', description: 'Manuelle Abfrage (Alias)' },
        { command: 'status', description: 'Server-Status' }
      ]
    }).catch(e => {
      state.logger?.log('setMyCommands failed: ' + (e && e.message ? e.message : e), 'warn');
    });
  } catch (e) {
    state.running = false;
    throw new Error('Telegram-Token ungültig: ' + (e.message || e), { cause: e });
  }

  // pollLoop ist async — Promise erfassen, damit stop() sie awaiten kann.
  // Errors aus der Schleife werden intern geloggt; hier .catch() um unhandled
  // rejections zu vermeiden, falls je etwas Unerwartetes hochsprudelt.
  pollPromise = pollLoop().catch(e => {
    state.logger?.log('Bot poll loop ended unexpectedly: ' + (e.message || e), 'error');
  });
}

function stop() {
  if (!state.running) return pollPromise || Promise.resolve();
  state.running = false;
  state.logger?.log('📱 Telegram-Bot gestoppt', 'info');
  // Erst den Scrape-Live-Poll-Timer killen — sonst läuft der setTimeout
  // ggf. weiter nachdem der Bot gestoppt wurde und schickt editMessageText
  // mit dem alten Token (resp. wirft, weil token=null).
  stopScrapePoll();
  // State-Reset: lastMenuMessageId / multiMessageIds / pendingMenuOp / offset
  // gehören zur abgelaufenen Session. Wenn der Bot mit einem neuen Token
  // wieder gestartet wird (z.B. nach Settings-Reconfig), darf keine ID aus
  // dem alten Run in die neue Loop durchsickern.
  state.reset();
  const pending = pollPromise || Promise.resolve();
  // Reset für den nächsten start() — pollPromise gehört zur abgelaufenen
  // Loop und sollte nicht von einer späteren stop()-Runde nochmals awaited
  // werden.
  pollPromise = null;
  return pending;
}

module.exports = {
  start,
  stop,
  notify,
  notifyGradeChanges,
  notifyRoomChanges,
  notifyWeeklyDetailReport,
  notifyPruefungenChanges,
  notifyNeueAbsenzen
};

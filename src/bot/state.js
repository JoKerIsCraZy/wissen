'use strict';

const state = {
  token: null,
  allowedUserId: null,
  // Chat, in dem der Bot ueberhaupt antworten darf. Default ist der private
  // Chat des Whitelist-Users (dessen Chat-ID identisch mit seiner User-ID ist).
  //
  // Ohne diese Schranke war NUR der Absender autorisiert, nie das Ziel: der Bot
  // hat jede Antwort an `msg.chat.id` aus dem Update geschickt. Wurde der
  // Whitelist-User in eine fremde Gruppe eingeladen, in der auch der Bot ist,
  // rendert ein einziger Befehl von ihm dort Noten, Durchschnitt, Stundenplan
  // und Absenzen fuer alle Gruppenmitglieder — und erlaubt jedem in der Gruppe,
  // per Inline-Button weiterzunavigieren und Abfragen auszuloesen.
  //
  // Via Setting telegramAllowedChatId ueberschreibbar, falls jemand den Bot
  // bewusst in einer bestimmten Gruppe betreiben will.
  allowedChatId: null,
  offset: 0,
  running: false,
  logger: null,
  triggerScrape: null,
  getStatus: null,
  lastMenuMessageId: null,  // Nur EIN Menü-Message, wird editiert statt dupliziert
  // Live-Tracking eines manuell getriggerten Scrapes — die /scrape-Message wird
  // alle 2.5s aktualisiert, bis state.running false wird.
  scrapePollTimer: null,
  scrapeMessage: null,      // { chatId, messageId } — die Message die wir editieren
  // Multi-Message-Screens (z.B. Stundenplan „Alle" mit pro-Monat-Message).
  // IDs werden hier geparkt damit beim Wechsel ins Menü alle gelöscht werden.
  multiMessageIds: [],
  // Menü-Mutex: serialisiert alle Operationen, die `lastMenuMessageId` mutieren
  // (send() + editMessage()). Verhindert Race zwischen Menu-Update (z.B. callback
  // editiert Menü) und einem parallelen send() (z.B. notify*). `notify*` selbst
  // braucht die Kette NICHT, weil `sendPush()` `lastMenuMessageId` nicht anfasst.
  pendingMenuOp: null
};

// Reset für bot.stop() — verhindert dass IDs aus altem Token-Run beim
// erneuten start(newToken) durchsickern (lastMenuMessageId, multiMessageIds,
// scrapeMessage, scrapePollTimer, pendingMenuOp).
function reset() {
  state.offset = 0;
  state.lastMenuMessageId = null;
  state.multiMessageIds = [];
  state.scrapeMessage = null;
  state.scrapePollTimer = null;
  state.pendingMenuOp = null;
}

state.reset = reset;

module.exports = state;

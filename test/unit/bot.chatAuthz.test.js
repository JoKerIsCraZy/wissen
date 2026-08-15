'use strict';

// Regression: der Bot autorisierte nur den ABSENDER (from.id), nie das ZIEL.
// Jede Antwort ging an `chat.id` aus dem Update — ein von aussen
// beeinflussbarer Wert.
//
// Angriff: Angreifer erstellt eine Gruppe, laedt den Whitelist-User ein
// (Telegrams Default erlaubt jedem, andere hinzuzufuegen) und den Bot dazu.
// Tippt der User dort irgendeinen Befehl, rendert der Bot Noten, Durchschnitt,
// Stundenplan und Absenzen in die Gruppe — sichtbar fuer alle Mitglieder. Ueber
// die Inline-Buttons kann anschliessend jeder in der Gruppe weiternavigieren
// und Abfragen ausloesen.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../../src/bot/state');
const handlers = require('../../src/bot/handlers');

const USER_ID = 12345;
const PRIVATE_CHAT = USER_ID;      // privater Chat: chat.id === user.id
const FREMDE_GRUPPE = -1001234567890;

// handleMessage/handleCallback ueber die echten Screens laufen zu lassen wuerde
// DB und Telegram-API brauchen. Uns interessiert genau eine Frage: kommt ein
// Update ueberhaupt bis zur Verarbeitung durch? Deshalb zaehlen wir die
// Aufrufe der beiden Einstiegspunkte.
let calls;

beforeEach(() => {
  calls = [];
  state.allowedUserId = USER_ID;
  state.allowedChatId = PRIVATE_CHAT;
  state.logger = { log: () => {} };
  state.multiMessageIds = [];
  state.lastMenuMessageId = null;
});

function msgUpdate(chatId, fromId = USER_ID) {
  return {
    update_id: 1,
    message: {
      message_id: 99,
      text: '/noten',
      from: { id: fromId, username: 'test' },
      chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' }
    }
  };
}

function cbUpdate(chatId, fromId = USER_ID) {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb1',
      data: 'noten',
      from: { id: fromId, username: 'test' },
      message: { message_id: 100, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' } }
    }
  };
}

// handleUpdate ruft handleMessage/handleCallback. Beide sind im selben Modul
// definiert, deshalb kann der Test sie nicht ersetzen — stattdessen pruefen
// wir das beobachtbare Verhalten: eine abgelehnte Nachricht darf keinen
// Telegram-Call ausloesen. Dazu reicht es, dass handleUpdate zurueckkehrt,
// ohne dass ein Netzwerkzugriff passiert. Wir instrumentieren global.fetch,
// das die Telegram-Schicht nutzt.
function withFetchSpy(fn) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    // Minimal-Antwort, damit tg() nicht wirft, falls doch etwas durchkommt.
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  return Promise.resolve(fn()).finally(() => { global.fetch = orig; });
}

test('Nachricht aus einer fremden Gruppe wird verworfen', async () => {
  await withFetchSpy(async () => {
    await handlers.handleUpdate(msgUpdate(FREMDE_GRUPPE));
  });
  assert.deepStrictEqual(
    calls, [],
    'aus einer fremden Gruppe darf KEIN Telegram-Call erfolgen (sonst landen Noten dort)'
  );
});

test('Callback aus einer fremden Gruppe wird verworfen', async () => {
  await withFetchSpy(async () => {
    await handlers.handleUpdate(cbUpdate(FREMDE_GRUPPE));
  });
  assert.deepStrictEqual(
    calls, [],
    'Inline-Buttons duerfen in fremden Chats nicht bedienbar sein'
  );
});

test('fremder Absender bleibt abgelehnt, auch im erlaubten Chat', async () => {
  await withFetchSpy(async () => {
    await handlers.handleUpdate(msgUpdate(PRIVATE_CHAT, 999));
  });
  assert.deepStrictEqual(calls, [], 'der Absender-Check muss weiter greifen');
});

test('Update ohne Chat-Angabe wird verworfen (kein undefined-Durchrutscher)', async () => {
  await withFetchSpy(async () => {
    await handlers.handleUpdate({
      update_id: 3,
      message: { message_id: 1, text: '/noten', from: { id: USER_ID } }
    });
  });
  assert.deepStrictEqual(calls, [], 'fehlendes chat.id darf nicht als erlaubt gelten');
});

test('bewusst konfigurierter Gruppen-Chat wird akzeptiert', async () => {
  // Wer telegramAllowedChatId setzt, will den Bot dort betreiben — dann muss
  // die Gruppe funktionieren und der private Chat gesperrt sein.
  state.allowedChatId = FREMDE_GRUPPE;
  await withFetchSpy(async () => {
    await handlers.handleUpdate(msgUpdate(FREMDE_GRUPPE));
  });
  assert.ok(calls.length > 0, 'der explizit erlaubte Chat muss durchkommen');
});

test('nach Umkonfiguration ist der private Chat nicht mehr automatisch erlaubt', async () => {
  state.allowedChatId = FREMDE_GRUPPE;
  await withFetchSpy(async () => {
    await handlers.handleUpdate(msgUpdate(PRIVATE_CHAT));
  });
  assert.deepStrictEqual(calls, [], 'allowedChatId ist exklusiv, nicht additiv');
});

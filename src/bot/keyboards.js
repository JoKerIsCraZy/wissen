'use strict';

// ---------- Keyboards ----------
function mainMenu() {
  return {
    inline_keyboard: [
      [
        { text: '📚 Noten', callback_data: 'noten' },
        { text: '🎯 Durchschnitt', callback_data: 'durchschnitt' }
      ],
      [
        { text: '☀️ Heute', callback_data: 'heute' },
        { text: '🌅 Morgen', callback_data: 'morgen' }
      ],
      [
        { text: '📆 Nächste Woche', callback_data: 'woche' },
        { text: '📋 Stundenplan', callback_data: 'stundenplan' }
      ],
      [
        { text: '🔄 Abfrage', callback_data: 'scrape' },
        { text: '📟 Status', callback_data: 'status' }
      ]
    ]
  };
}

function notenNav() {
  return {
    inline_keyboard: [
      [
        { text: '🎯 Durchschnitt', callback_data: 'durchschnitt' },
        { text: '🔄 Aktualisieren', callback_data: 'noten' }
      ],
      [{ text: '⬅️ Menü', callback_data: 'menu' }]
    ]
  };
}

function durchschnittNav() {
  return {
    inline_keyboard: [
      [
        { text: '📚 Alle Noten', callback_data: 'noten' },
        { text: '🔄 Aktualisieren', callback_data: 'durchschnitt' }
      ],
      [{ text: '⬅️ Menü', callback_data: 'menu' }]
    ]
  };
}

function stundenplanNav(current) {
  const all = [
    { text: '☀️ Heute', data: 'heute' },
    { text: '🌅 Morgen', data: 'morgen' },
    { text: '📆 Woche', data: 'woche' },
    { text: '📋 Monat', data: 'stundenplan' },
    { text: '📚 Alle', data: 'stundenplan_alle' }
  ];
  const others = all.filter(x => x.data !== current).map(x => ({ text: x.text, callback_data: x.data }));
  // In 2 Zeilen aufteilen damit's auf Mobile nicht zu eng wird
  const row1 = others.slice(0, Math.ceil(others.length / 2));
  const row2 = others.slice(Math.ceil(others.length / 2));
  const rows = [row1];
  if (row2.length) rows.push(row2);
  rows.push([
    { text: '🔄 Aktualisieren', callback_data: current },
    { text: '⬅️ Menü', callback_data: 'menu' }
  ]);
  return { inline_keyboard: rows };
}

function simpleNav() {
  return {
    inline_keyboard: [
      [{ text: '⬅️ Menü', callback_data: 'menu' }]
    ]
  };
}

// OK-Button schließt zum Menü.
function okMenuKb() {
  return {
    inline_keyboard: [
      [{ text: '✓ OK', callback_data: 'menu' }]
    ]
  };
}

module.exports = { mainMenu, notenNav, durchschnittNav, stundenplanNav, simpleNav, okMenuKb };

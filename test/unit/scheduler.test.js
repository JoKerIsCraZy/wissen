'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hmToMinutes,
  isWithinInterval,
  nextWindowStart,
  computeNextRun,
  isLastScheduledRunOfDay,
  nextWeeklyDetailRun
} = require('../../src/scheduler');

// Helper: build a Date for a specific weekday/hour/minute in local TZ.
// dayOfWeek: 0=Sun ... 6=Sat. Uses a known anchor week (2026-05-10 is Sun).
function localDate(dayOfWeek, hh, mm, ss = 0) {
  // 2026-05-10 = Sunday in any normal calendar.
  const anchor = new Date(2026, 4, 10, 0, 0, 0, 0);
  const d = new Date(anchor);
  d.setDate(anchor.getDate() + dayOfWeek);
  d.setHours(hh, mm, ss, 0);
  return d;
}

// ---------- hmToMinutes ----------

test('hmToMinutes: "08:30" → 510', () => {
  assert.equal(hmToMinutes('08:30'), 510);
});

test('hmToMinutes: "00:00" → 0', () => {
  assert.equal(hmToMinutes('00:00'), 0);
});

test('hmToMinutes: empty string → 0', () => {
  assert.equal(hmToMinutes(''), 0);
});

test('hmToMinutes: garbage string → 0', () => {
  assert.equal(hmToMinutes('invalid'), 0);
});

test('hmToMinutes: "23:59" → 1439', () => {
  assert.equal(hmToMinutes('23:59'), 1439);
});

// ---------- isWithinInterval ----------

test('isWithinInterval: weekday match inside hour range', () => {
  const wed = localDate(3, 10, 0); // Wednesday 10:00
  assert.equal(isWithinInterval(wed, [1, 2, 3, 4, 5], '08:00', '18:00'), true);
});

test('isWithinInterval: weekday excluded', () => {
  const sat = localDate(6, 10, 0); // Saturday 10:00
  assert.equal(isWithinInterval(sat, [1, 2, 3, 4, 5], '08:00', '18:00'), false);
});

test('isWithinInterval: hour outside range', () => {
  const wed = localDate(3, 20, 0); // Wednesday 20:00
  assert.equal(isWithinInterval(wed, [1, 2, 3, 4, 5], '08:00', '18:00'), false);
});

test('isWithinInterval: midnight-wrap window (22:00–06:00) at 23:00 OK', () => {
  const wed = localDate(3, 23, 0);
  assert.equal(isWithinInterval(wed, [], '22:00', '06:00'), true);
});

test('isWithinInterval: midnight-wrap window (22:00–06:00) at 05:00 OK', () => {
  const wed = localDate(3, 5, 0);
  assert.equal(isWithinInterval(wed, [], '22:00', '06:00'), true);
});

test('isWithinInterval: midnight-wrap window (22:00–06:00) at 12:00 outside', () => {
  const wed = localDate(3, 12, 0);
  assert.equal(isWithinInterval(wed, [], '22:00', '06:00'), false);
});

test('isWithinInterval: empty days array → no day restriction', () => {
  const sat = localDate(6, 10, 0);
  assert.equal(isWithinInterval(sat, [], '08:00', '18:00'), true);
});

test('isWithinInterval: no from/to → always inside', () => {
  const sat = localDate(6, 3, 0);
  assert.equal(isWithinInterval(sat, [], '', ''), true);
});

// ---------- nextWindowStart ----------

test('nextWindowStart: rolls to tomorrow at 08:00 when today excluded', () => {
  // Sunday → next allowed day is Monday at 08:00
  const sun = localDate(0, 15, 0);
  const next = nextWindowStart(sun, [1, 2, 3, 4, 5], '08:00');
  assert.ok(next instanceof Date);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 8);
  assert.equal(next.getMinutes(), 0);
});

test('nextWindowStart: same day if today allowed and after window start', () => {
  // Wednesday 06:00 → next allowed window is Wednesday 08:00
  // (because cand > fromDate so today 08:00 qualifies).
  const wed = localDate(3, 6, 0);
  const next = nextWindowStart(wed, [1, 2, 3, 4, 5], '08:00');
  assert.equal(next.getDay(), 3);
  assert.equal(next.getHours(), 8);
});

// ---------- computeNextRun (interval) ----------

test('computeNextRun interval: inside window → now + N min', () => {
  const wed = localDate(3, 10, 0); // Wednesday 10:00
  const s = {
    scheduleMode: 'interval',
    intervalMinutes: 30,
    intervalTimeFrom: '08:00',
    intervalTimeTo: '18:00',
    scheduleDays: [1, 2, 3, 4, 5]
  };
  const next = computeNextRun(s, wed);
  // Expect 10:30 same day
  assert.equal(next.getDay(), 3);
  assert.equal(next.getHours(), 10);
  assert.equal(next.getMinutes(), 30);
});

test('computeNextRun interval: outside window → jumps to nextWindowStart', () => {
  const wed = localDate(3, 19, 0); // Wednesday 19:00 — outside 08–18
  const s = {
    scheduleMode: 'interval',
    intervalMinutes: 30,
    intervalTimeFrom: '08:00',
    intervalTimeTo: '18:00',
    scheduleDays: [1, 2, 3, 4, 5]
  };
  const next = computeNextRun(s, wed);
  // Naive next is 19:30 → outside; should jump to Thursday 08:00.
  assert.equal(next.getDay(), 4);
  assert.equal(next.getHours(), 8);
  assert.equal(next.getMinutes(), 0);
});

test('computeNextRun interval: midnight-wrap window (22:00–06:00) at 23:30 stays inside', () => {
  const wed = localDate(3, 23, 30);
  const s = {
    scheduleMode: 'interval',
    intervalMinutes: 30,
    intervalTimeFrom: '22:00',
    intervalTimeTo: '06:00',
    scheduleDays: []
  };
  const next = computeNextRun(s, wed);
  // 23:30 + 30min = 00:00 next day, which is inside the 22→06 wrap window.
  assert.ok(next.getTime() > wed.getTime());
  assert.equal(next.getHours(), 0);
});

// ---------- computeNextRun (weekly) ----------

test('computeNextRun weekly: picks earliest day×time slot in the future', () => {
  // Wednesday 10:00 → today's 14:00 slot is the earliest future slot.
  const wed = localDate(3, 10, 0);
  const s = {
    scheduleMode: 'weekly',
    scheduleDays: [1, 3, 5],
    scheduleTimes: ['08:00', '14:00']
  };
  const next = computeNextRun(s, wed);
  assert.equal(next.getDay(), 3);
  assert.equal(next.getHours(), 14);
});

test('computeNextRun weekly: today exhausted → rolls to next allowed day', () => {
  // Wednesday 15:00 → 08:00 and 14:00 already past; next slot is Friday 08:00.
  const wed = localDate(3, 15, 0);
  const s = {
    scheduleMode: 'weekly',
    scheduleDays: [1, 3, 5],
    scheduleTimes: ['08:00', '14:00']
  };
  const next = computeNextRun(s, wed);
  assert.equal(next.getDay(), 5);
  assert.equal(next.getHours(), 8);
});

test('computeNextRun weekly: empty days → null', () => {
  const wed = localDate(3, 10, 0);
  const s = { scheduleMode: 'weekly', scheduleDays: [], scheduleTimes: ['08:00'] };
  assert.equal(computeNextRun(s, wed), null);
});

test('computeNextRun weekly: empty times → null', () => {
  const wed = localDate(3, 10, 0);
  const s = { scheduleMode: 'weekly', scheduleDays: [1, 2, 3], scheduleTimes: [] };
  assert.equal(computeNextRun(s, wed), null);
});

// ---------- nextWeeklyDetailRun ----------

test('nextWeeklyDetailRun: Saturday before 03:00 → today 03:00', () => {
  const satEarly = localDate(6, 2, 30);
  const next = nextWeeklyDetailRun(satEarly);
  assert.equal(next.getDay(), 6);
  assert.equal(next.getHours(), 3);
  assert.equal(next.getMinutes(), 0);
  // Same calendar day.
  assert.equal(next.getDate(), satEarly.getDate());
});

test('nextWeeklyDetailRun: Saturday after 03:00 → next Saturday 03:00', () => {
  const satLate = localDate(6, 10, 0);
  const next = nextWeeklyDetailRun(satLate);
  assert.equal(next.getDay(), 6);
  assert.equal(next.getHours(), 3);
  // 7 days later.
  assert.equal(next.getTime() - satLate.getTime() > 6 * 24 * 3600 * 1000, true);
});

test('nextWeeklyDetailRun: Tuesday → next Saturday 03:00', () => {
  const tue = localDate(2, 10, 0);
  const next = nextWeeklyDetailRun(tue);
  assert.equal(next.getDay(), 6);
  assert.equal(next.getHours(), 3);
});

// ---------- isLastScheduledRunOfDay (gate für Absenz-Detail-Pass) ----------

test('isLastScheduledRunOfDay weekly: früher Slot ist NICHT der letzte', () => {
  // Mi 08:00, Slots 08:00+16:00 → nächster Lauf Mi 16:00 (selber Tag).
  const s = { scheduleMode: 'weekly', scheduleDays: [1, 2, 3, 4, 5], scheduleTimes: ['08:00', '16:00'] };
  assert.equal(isLastScheduledRunOfDay(s, localDate(3, 8, 0)), false);
});

test('isLastScheduledRunOfDay weekly: letzter Slot des Tages → true', () => {
  // Mi 16:00 → nächster Lauf Do 08:00 (anderer Tag).
  const s = { scheduleMode: 'weekly', scheduleDays: [1, 2, 3, 4, 5], scheduleTimes: ['08:00', '16:00'] };
  assert.equal(isLastScheduledRunOfDay(s, localDate(3, 16, 0)), true);
});

test('isLastScheduledRunOfDay weekly: einziger Slot des Tages → true', () => {
  const s = { scheduleMode: 'weekly', scheduleDays: [3], scheduleTimes: ['09:00'] };
  assert.equal(isLastScheduledRunOfDay(s, localDate(3, 9, 0)), true);
});

test('isLastScheduledRunOfDay interval: mitten im Fenster → false', () => {
  // Mi 20:00, Intervall 60min, Fenster 08–22 → nächster Lauf 21:00 (selber Tag).
  const s = {
    scheduleMode: 'interval', intervalMinutes: 60,
    intervalTimeFrom: '08:00', intervalTimeTo: '22:00', scheduleDays: [1, 2, 3, 4, 5]
  };
  assert.equal(isLastScheduledRunOfDay(s, localDate(3, 20, 0)), false);
});

test('isLastScheduledRunOfDay interval: letzter Lauf vor Fensterende → true', () => {
  // Mi 21:30 → +60min = 22:30 (ausserhalb 22:00) → nächster Lauf Do 08:00.
  const s = {
    scheduleMode: 'interval', intervalMinutes: 60,
    intervalTimeFrom: '08:00', intervalTimeTo: '22:00', scheduleDays: [1, 2, 3, 4, 5]
  };
  assert.equal(isLastScheduledRunOfDay(s, localDate(3, 21, 30)), true);
});

test('isLastScheduledRunOfDay: kein gültiger Folgelauf (leere Tage) → true', () => {
  const s = { scheduleMode: 'weekly', scheduleDays: [], scheduleTimes: ['08:00'] };
  assert.equal(isLastScheduledRunOfDay(s, localDate(3, 8, 0)), true);
});

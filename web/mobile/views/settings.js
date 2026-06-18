/* ============================================================
   WISSen — View: Settings
   Settings-form (Anmeldung, Automatik, Browser, Push, Telegram, URLs,
   Token). Push-API helpers live in views/push.js; the live Scrape-
   Status card that's embedded above the form lives in views/scrape.js.

   Depends on globals from mobile.js shell:
     - titleEl, main, apiFetch, loadingShell, errorShell, toast
     - getToken, setToken, clearToken, showLogin
     - registerServiceWorker
   And on view-globals from sibling view files:
     - renderScrapeCard (views/scrape.js)
     - refreshDiag, refreshPushStatus, enablePush, disablePush (views/push.js)
   ============================================================ */
'use strict';

/* ============================================================
   View entry-point
   ============================================================ */
async function renderSettings() {
  titleEl.textContent = 'Einstellungen';
  loadingShell();
  try {
    const s = await apiFetch('/api/settings');
    drawSettings(s);
  } catch (e) {
    if (e.silent) return;
    errorShell(e.message || 'Fehler beim Laden der Einstellungen');
  }
}
// Local working copy of the schedule arrays (mutated by chips / time list).
let settingsState = null;

function drawSettings(s) {
  main.replaceChildren();
  settingsState = {
    scheduleMode: (s && s.scheduleMode === 'weekly') ? 'weekly' : 'interval',
    scheduleDays: Array.isArray(s && s.scheduleDays) ? s.scheduleDays.slice() : [1, 2, 3, 4, 5],
    scheduleTimes: Array.isArray(s && s.scheduleTimes) ? s.scheduleTimes.slice() : ['08:00']
  };

  const form = document.createElement('form');
  form.className = 'm-form';
  form.id = 'settingsForm';

  // Scrape-Card ganz oben — separat von den Fieldsets damit sie immer
  // sofort sichtbar ist und die Settings-Form drumherum animiert.
  const scrapeWrap = document.createElement('div');
  scrapeWrap.id = 'scrapeCard';
  renderScrapeCard(scrapeWrap);
  form.append(scrapeWrap);

  form.append(
    fsetAnmeldung(s),
    fsetAutomatik(s),
    fsetBrowser(s),
    fsetPush(),
    fsetTelegram(s),
    fsetUrls(s),
    fsetToken(),
    fsetVersion()
  );

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'm-btn m-btn--primary m-btn--block';
  submit.innerHTML =
    '<span class="m-btn__spinner" aria-hidden="true"></span>' +
    '<span class="m-btn__label">Speichern</span>';
  form.append(submit);

  const back = document.createElement('a');
  back.href = '/';
  back.className = 'm-btn m-btn--block m-btn--gap';
  back.textContent = '← Zurück zum Dashboard';
  form.append(back);

  // Save handler — shows loading spinner inline so the button itself
  // tells the user the request is in flight (no toast lag).
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = collectSettingsPayload(form);
    submit.disabled = true;
    submit.classList.add('is-loading');
    try {
      await apiFetch('/api/settings', { method: 'PATCH', body: payload });
      toast('Gespeichert');
    } catch (e) {
      if (!e.silent) toast(e.message || 'Speichern fehlgeschlagen', 'err');
    } finally {
      submit.disabled = false;
      submit.classList.remove('is-loading');
    }
  });

  main.append(form);
  applyScheduleModeVisibility(form);
}

function fsetAnmeldung(s) {
  const fs = makeFieldset('Anmeldung');
  fs.append(
    field('Microsoft-E-Mail', input('msEmail', 'email', s && s.msEmail)),
    field('Passwort', input('msPassword', 'password', '', '••• (unverändert)'),
          'Leer lassen, um das gespeicherte Passwort zu behalten.'),
    field('User-PK', input('userPk', 'text', s && s.userPk),
          'Primärschlüssel des eingeloggten Tocco-Benutzers.')
  );
  return fs;
}

function fsetAutomatik(s) {
  const fs = makeFieldset('Automatik');
  fs.append(toggle('autoRun', 'Auto-Run aktivieren', s && s.autoRun));

  // Mode-switch (interval | weekly)
  const modeWrap = document.createElement('div');
  modeWrap.className = 'm-field';
  const modeLab = document.createElement('span'); modeLab.textContent = 'Modus';
  const modeSwitch = document.createElement('div');
  modeSwitch.className = 'm-modeswitch';
  ['interval', 'weekly'].forEach((mode) => {
    const lab = document.createElement('label');
    lab.className = 'm-modeswitch__opt';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'scheduleMode'; radio.value = mode;
    radio.checked = settingsState.scheduleMode === mode;
    radio.addEventListener('change', () => {
      settingsState.scheduleMode = mode;
      applyScheduleModeVisibility(document.getElementById('settingsForm'));
    });
    const span = document.createElement('span');
    span.textContent = mode === 'interval' ? '⏱ Intervall' : '📅 Wochenplan';
    lab.append(radio, span);
    modeSwitch.append(lab);
  });
  modeWrap.append(modeLab, modeSwitch);
  fs.append(modeWrap);

  // Wochentage (always visible — both modes use them)
  const daysWrap = document.createElement('div');
  daysWrap.className = 'm-field';
  const daysLab = document.createElement('span'); daysLab.textContent = 'Wochentage';
  const chips = document.createElement('div');
  chips.className = 'm-daychips';
  const dayMap = [
    [1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'],
    [5, 'Fr'], [6, 'Sa'], [0, 'So']
  ];
  dayMap.forEach(([num, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'm-daychip';
    b.dataset.day = String(num);
    b.textContent = label;
    if (settingsState.scheduleDays.includes(num)) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => {
      const idx = settingsState.scheduleDays.indexOf(num);
      if (idx >= 0) settingsState.scheduleDays.splice(idx, 1);
      else settingsState.scheduleDays.push(num);
      settingsState.scheduleDays.sort((a, b) => a - b);
      b.setAttribute('aria-pressed', String(idx < 0));
    });
    chips.append(b);
  });
  daysWrap.append(daysLab, chips);
  fs.append(daysWrap);

  // ----- Interval-mode panel -----
  const ivWrap = document.createElement('div');
  ivWrap.dataset.modePanel = 'interval';
  ivWrap.className = 'm-mode-panel';

  const slField = document.createElement('div');
  slField.className = 'm-field';
  const slHead = document.createElement('span');
  const minutes = (s && Number.isFinite(s.intervalMinutes)) ? s.intervalMinutes : 60;
  slHead.innerHTML = 'Intervall: <strong id="ivLabel">' + minutes + '</strong> Min.';
  const slider = document.createElement('input');
  slider.type = 'range'; slider.name = 'intervalMinutes';
  slider.min = '5'; slider.max = '1440'; slider.step = '5';
  slider.value = String(minutes);
  slider.className = 'm-range';
  // aria-valuetext gibt Screenreadern eine sprechende Form ("60 Minuten")
  // statt nur den nackten Zahlenwert — Pflicht für sinnvolle Range-Slider
  // (WCAG 4.1.2). Initialwert hier, Live-Update im input-Handler unten.
  slider.setAttribute('aria-valuetext', minutes + ' Minuten');
  slider.addEventListener('input', () => {
    const lab = document.getElementById('ivLabel');
    if (lab) lab.textContent = slider.value;
    // Mitlaufender aria-valuetext: ohne dieses Update würde der Screenreader
    // beim Ziehen den alten Wert ansagen oder gar nichts.
    slider.setAttribute('aria-valuetext', slider.value + ' Minuten');
  });
  const scale = document.createElement('div');
  scale.className = 'm-rangescale';
  scale.innerHTML = '<span>5</span><span>360</span><span>720</span><span>1440</span>';
  slField.append(slHead, slider, scale);
  ivWrap.append(slField);

  const tfWrap = document.createElement('div');
  tfWrap.className = 'm-field';
  const tfLab = document.createElement('span'); tfLab.textContent = 'Zeitfenster';
  const tfRow = document.createElement('div');
  tfRow.className = 'm-timerange';
  const tFrom = document.createElement('input');
  tFrom.type = 'time'; tFrom.name = 'intervalTimeFrom';
  tFrom.value = (s && s.intervalTimeFrom) || '08:00';
  // aria-label nötig, weil das visuelle "Zeitfenster"-Label und der "bis"-
  // Separator beide Inputs gemeinsam beschriften, aber programmatisch keinem
  // Input zugeordnet sind. Screenreader brauchen pro Input einen eigenen Namen.
  tFrom.setAttribute('aria-label', 'Aktiv ab');
  const tBis = document.createElement('span');
  tBis.className = 'm-timerange__sep'; tBis.textContent = 'bis';
  const tTo = document.createElement('input');
  tTo.type = 'time'; tTo.name = 'intervalTimeTo';
  tTo.value = (s && s.intervalTimeTo) || '20:00';
  tTo.setAttribute('aria-label', 'Aktiv bis');
  tfRow.append(tFrom, tBis, tTo);
  tfWrap.append(tfLab, tfRow);
  ivWrap.append(tfWrap);

  fs.append(ivWrap);

  // ----- Weekly-mode panel -----
  const wkWrap = document.createElement('div');
  wkWrap.dataset.modePanel = 'weekly';
  wkWrap.className = 'm-mode-panel';

  const tlWrap = document.createElement('div');
  tlWrap.className = 'm-field';
  const tlLab = document.createElement('span'); tlLab.textContent = 'Uhrzeiten';
  const tlList = document.createElement('div');
  tlList.id = 'scheduleTimes';
  tlList.className = 'm-timelist';
  redrawTimeList(tlList);
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'm-btn m-btn--block m-btn--gap';
  addBtn.textContent = '+ Zeit hinzufügen';
  addBtn.addEventListener('click', () => {
    settingsState.scheduleTimes.push('12:00');
    redrawTimeList(tlList);
  });
  tlWrap.append(tlLab, tlList, addBtn);
  wkWrap.append(tlWrap);

  fs.append(wkWrap);

  return fs;
}

function redrawTimeList(container) {
  container.replaceChildren();
  if (!settingsState.scheduleTimes.length) {
    const e = document.createElement('div');
    e.className = 'm-field__hint';
    e.textContent = 'Noch keine Zeit hinterlegt — füge eine hinzu.';
    container.append(e);
    return;
  }
  settingsState.scheduleTimes.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'm-timelist__row';
    const inp = document.createElement('input');
    inp.type = 'time'; inp.value = t;
    inp.addEventListener('change', () => { settingsState.scheduleTimes[i] = inp.value; });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'm-timelist__del';
    del.setAttribute('aria-label', 'Zeit entfernen');
    del.innerHTML = '&times;';
    del.addEventListener('click', () => {
      settingsState.scheduleTimes.splice(i, 1);
      redrawTimeList(container);
    });
    row.append(inp, del);
    container.append(row);
  });
}

function applyScheduleModeVisibility(form) {
  if (!form) return;
  form.querySelectorAll('[data-mode-panel]').forEach((el) => {
    // Toggle via `hidden` attribute instead of inline display:none — keeps
    // styling in CSS (with `[hidden]` reset in base.css) and survives a
    // future re-theme without grepping JS for inline display values.
    el.hidden = el.dataset.modePanel !== settingsState.scheduleMode;
  });
}

function fsetBrowser(s) {
  const fs = makeFieldset('Browser');
  fs.append(toggle('headless', 'Headless ausführen', s && s.headless));
  const slowMo = input('slowMo', 'number', (s && s.slowMo != null) ? s.slowMo : 0);
  slowMo.min = '0'; slowMo.max = '5000'; slowMo.step = '50';
  fs.append(field('slowMo (ms)', slowMo));
  return fs;
}

function fsetPush() {
  const fs = makeFieldset('Benachrichtigungen');

  // Diagnose-Block: Service-Worker + PWA + API-Status auf einen Blick.
  // Styling lives in the .m-push-diag class (views.css).
  const diag = document.createElement('div');
  diag.id = 'pushDiag';
  diag.className = 'm-push-diag';
  diag.textContent = 'Lade Diagnose…';
  fs.append(diag);

  // Manueller Re-Register Button — exposed um SW-Fehler sichtbar zu machen
  const swBtn = document.createElement('button');
  swBtn.type = 'button';
  swBtn.className = 'm-btn m-btn--block';
  swBtn.textContent = 'Service-Worker (re-)registrieren';
  swBtn.addEventListener('click', async () => {
    swBtn.disabled = true;
    diag.textContent = 'Registriere…';
    const reg = await registerServiceWorker();
    if (reg) {
      try { await navigator.serviceWorker.ready; } catch (_) {}
      toast('Service-Worker registriert');
    } else {
      toast('Registrierung fehlgeschlagen — siehe Diagnose', 'err');
    }
    await refreshDiag();
    swBtn.disabled = false;
  });
  fs.append(swBtn);

  // Status-Zeile (wird dynamisch upgedatet)
  const status = document.createElement('div');
  status.id = 'pushStatus';
  status.className = 'm-push-status';
  status.textContent = '–';
  fs.append(status);

  // Toggle "Push aktivieren"
  const toggleWrap = document.createElement('label');
  toggleWrap.className = 'm-toggle';
  const span = document.createElement('span');
  span.className = 'm-toggle__label';
  span.textContent = 'Push aktivieren';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.id = 'pushToggle'; cb.hidden = true;
  const sw = document.createElement('span');
  sw.className = 'm-switch';
  toggleWrap.append(span, cb, sw);
  fs.append(toggleWrap);

  cb.addEventListener('change', async () => {
    if (cb.checked) {
      const ok = await enablePush();
      cb.checked = ok;
      refreshPushStatus();
    } else {
      await disablePush();
      refreshPushStatus();
    }
  });

  // Test-Button
  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'm-btn m-btn--block';
  testBtn.textContent = 'Test-Benachrichtigung senden';
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    try {
      const r = await apiFetch('/api/push/test', { method: 'POST', body: {} });
      toast('Push gesendet (' + (r.sent || 0) + ' Geräte)');
    } catch (e) {
      if (!e.silent) toast(e.message || 'Push-Test fehlgeschlagen', 'err');
    } finally {
      testBtn.disabled = false;
    }
  });
  fs.append(testBtn);

  const hint = document.createElement('small');
  hint.className = 'm-field__hint';
  hint.innerHTML = 'Auf iOS: PWA muss zuerst über „Zum Home-Bildschirm" installiert sein, ' +
                   'sonst sind Push-Benachrichtigungen nicht möglich.';
  fs.append(hint);

  // Async-Hydrate: Permission + Subscription-State checken
  setTimeout(() => { refreshPushStatus(); refreshDiag(); }, 50);

  return fs;
}

function fsetTelegram(s) {
  const fs = makeFieldset('Telegram-Bot');
  fs.append(toggle('telegramEnabled', 'Bot aktivieren', s && s.telegramEnabled));
  fs.append(field('Bot-Token', input('telegramToken', 'password', '', '••• (unverändert)'),
                  'Von @BotFather. Leer lassen, um den gespeicherten Token zu behalten.'));
  const uid = input('telegramAllowedUserId', 'number', s && s.telegramAllowedUserId);
  uid.min = '1';
  fs.append(field('Deine User-ID', uid, 'Hol dir die ID via @userinfobot.'));
  return fs;
}

function fsetUrls(s) {
  const fs = makeFieldset('Erweitert — URLs (env-only, read-only)');
  const baseUrl = input('baseUrl', 'url', s && s.baseUrl); baseUrl.disabled = true;
  const notenUrl = input('notenUrl', 'url', s && s.notenUrl); notenUrl.disabled = true;
  const splUrl = input('stundenplanUrl', 'url', s && s.stundenplanUrl); splUrl.disabled = true;
  fs.append(
    field('Base-URL', baseUrl),
    field('Noten-URL', notenUrl),
    field('Stundenplan-URL', splUrl)
  );
  return fs;
}

function fsetToken() {
  const fs = makeFieldset('API-Token');
  const inp = document.createElement('input');
  inp.type = 'password';
  inp.id = 'currentToken';
  inp.autocomplete = 'off';
  inp.value = getToken();
  fs.append(field('Aktueller Token (lokal)', inp,
                  'Wird nur in diesem Browser gespeichert.'));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button'; saveBtn.className = 'm-btn m-btn--block';
  saveBtn.textContent = 'Token aktualisieren';
  saveBtn.addEventListener('click', () => {
    const v = inp.value.trim();
    if (!v) { toast('Token darf nicht leer sein', 'err'); return; }
    setToken(v);
    toast('Token gespeichert');
  });

  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button'; logoutBtn.className = 'm-btn m-btn--block m-btn--danger';
  logoutBtn.textContent = 'Abmelden';
  logoutBtn.addEventListener('click', () => {
    clearToken();
    showLogin('Abgemeldet — Token erneut eingeben');
  });

  fs.append(saveBtn, logoutBtn);
  return fs;
}

function fsetVersion() {
  const fs = makeFieldset('Über');

  // Docker / Server-Version aus /api/version.
  const dockerRow = document.createElement('div');
  dockerRow.className = 'm-version-row';
  dockerRow.innerHTML =
    '<span class="m-version-row__label">Docker-Image</span>' +
    '<strong class="m-version-row__value" id="versionDocker">…</strong>';
  fs.append(dockerRow);

  // SW-Code-Version (tm-NN) — vom Server geliefert, autoritativ. Das ist
  // die VERSION-Konstante aus web/mobile/sw.js auf dem aktuell laufenden
  // Server. Wird IMMER angezeigt, auch wenn der Browser keinen SW
  // registriert hat (z.B. weil über plain-HTTP gesurft).
  const swCodeRow = document.createElement('div');
  swCodeRow.className = 'm-version-row';
  swCodeRow.innerHTML =
    '<span class="m-version-row__label">SW-Version (Code)</span>' +
    '<strong class="m-version-row__value" id="versionSwCode">…</strong>';
  fs.append(swCodeRow);

  // SW-Cache-Key (tm-NN) — was der lokale Service-Worker gerade gecached
  // hat. Auf plain-HTTP gibt's keinen SW → zeigt "kein Cache". Auf HTTPS/
  // installierter PWA zeigt es die installierte Generation; weicht der
  // Wert vom SW-Code ab kann der User wissen dass ein Update aussteht.
  const pwaRow = document.createElement('div');
  pwaRow.className = 'm-version-row';
  pwaRow.innerHTML =
    '<span class="m-version-row__label">SW-Cache (lokal)</span>' +
    '<strong class="m-version-row__value" id="versionPwa">…</strong>';
  fs.append(pwaRow);

  // GitHub-Link. rel="noopener noreferrer" verhindert window.opener-
  // Abuse + Referrer-Leak. target="_blank" damit der User nicht aus
  // der PWA wegnavigiert wird wenn sie als Standalone installiert ist.
  const ghRow = document.createElement('div');
  ghRow.className = 'm-version-row';
  const ghLabel = document.createElement('span');
  ghLabel.className = 'm-version-row__label';
  ghLabel.textContent = 'GitHub';
  const ghLink = document.createElement('a');
  ghLink.className = 'm-version-row__value m-version-row__link';
  ghLink.href = 'https://github.com/JoKerIsCraZy/wissen';
  ghLink.target = '_blank';
  ghLink.rel = 'noopener noreferrer';
  ghLink.innerHTML =
    'JoKerIsCraZy/wissen ' +
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
    'style="vertical-align: -1px; margin-left: 2px;">' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
    '<polyline points="15 3 21 3 21 9"/>' +
    '<line x1="10" y1="14" x2="21" y2="3"/>' +
    '</svg>';
  ghRow.append(ghLabel, ghLink);
  fs.append(ghRow);

  // "Update prüfen"-Button — triggert reg.update() (Browser checkt aktiv
  // ob neue sw.js auf dem Server liegt) und re-render der Versionen.
  const updateBtn = document.createElement('button');
  updateBtn.type = 'button';
  updateBtn.className = 'm-btn m-btn--block';
  updateBtn.textContent = 'Auf Update prüfen';
  updateBtn.addEventListener('click', async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Prüfe …';
    try {
      if (typeof window.checkForSwUpdate === 'function') {
        window.checkForSwUpdate();
      }
      await new Promise((r) => setTimeout(r, 800));
      await hydrateVersionPanel();
      toast('Update-Check durchgeführt');
    } finally {
      updateBtn.disabled = false;
      updateBtn.textContent = 'Auf Update prüfen';
    }
  });
  fs.append(updateBtn);

  // Async-Hydrate beim Render + bei "Update prüfen"-Click
  hydrateVersionPanel();

  return fs;
}

async function hydrateVersionPanel() {
  let serverSwVersion = null;
  // Docker / package.json + SW-Code-Version (beide vom /api/version-Endpoint)
  try {
    const data = await apiFetch('/api/version');
    serverSwVersion = data.swVersion || null;
    const dEl = document.getElementById('versionDocker');
    if (dEl) dEl.textContent = 'v' + (data.version || 'unknown');
    const swEl = document.getElementById('versionSwCode');
    if (swEl) swEl.textContent = serverSwVersion || 'unknown';
  } catch (e) {
    if (!e.silent) {
      const dEl = document.getElementById('versionDocker');
      if (dEl) dEl.textContent = 'unbekannt';
      const swEl = document.getElementById('versionSwCode');
      if (swEl) swEl.textContent = 'unbekannt';
    }
  }

  // SW-Cache-Key — was lokal im Browser installiert ist
  const cacheEl = document.getElementById('versionPwa');
  if (!cacheEl) return;
  if (!('caches' in window)) {
    cacheEl.textContent = 'nicht unterstützt';
    return;
  }
  try {
    const keys = await caches.keys();
    const swKey = keys.find((k) => k.indexOf('wn-shell-') === 0);
    const cacheVersion = swKey ? swKey.replace('wn-shell-', '') : null;
    if (!cacheVersion) {
      cacheEl.textContent = 'kein Cache';
      cacheEl.classList.remove('m-version-row__value--stale');
    } else if (serverSwVersion && cacheVersion !== serverSwVersion) {
      cacheEl.textContent = cacheVersion + ' ⚠ Update pending';
      cacheEl.classList.add('m-version-row__value--stale');
    } else {
      cacheEl.textContent = cacheVersion;
      cacheEl.classList.remove('m-version-row__value--stale');
    }
  } catch (_) {
    cacheEl.textContent = 'fehler';
  }
}

function collectSettingsPayload(form) {
  const fd = new FormData(form);
  const out = {};
  // Strings (only send if non-empty / explicitly changed)
  const email = (fd.get('msEmail') || '').toString().trim();
  if (email) out.msEmail = email;
  const userPk = (fd.get('userPk') || '').toString().trim();
  if (userPk) out.userPk = userPk;
  const pw = (fd.get('msPassword') || '').toString();
  if (pw) out.msPassword = pw;

  // Toggles
  out.autoRun  = !!form.querySelector('[name="autoRun"]').checked;
  out.headless = !!form.querySelector('[name="headless"]').checked;

  // Schedule
  out.scheduleMode = settingsState.scheduleMode;
  out.scheduleDays = settingsState.scheduleDays.slice();
  out.scheduleTimes = settingsState.scheduleTimes.slice();
  const iv = parseInt(fd.get('intervalMinutes'), 10);
  if (Number.isFinite(iv) && iv > 0) out.intervalMinutes = iv;
  const tFrom = (fd.get('intervalTimeFrom') || '').toString();
  const tTo   = (fd.get('intervalTimeTo')   || '').toString();
  if (tFrom) out.intervalTimeFrom = tFrom;
  if (tTo)   out.intervalTimeTo   = tTo;

  // Browser slowMo
  const sm = parseInt(fd.get('slowMo'), 10);
  if (Number.isFinite(sm) && sm >= 0) out.slowMo = sm;

  // Telegram
  out.telegramEnabled = !!form.querySelector('[name="telegramEnabled"]').checked;
  const tToken = (fd.get('telegramToken') || '').toString();
  if (tToken) out.telegramToken = tToken;
  const tUid = parseInt(fd.get('telegramAllowedUserId'), 10);
  if (Number.isFinite(tUid) && tUid > 0) out.telegramAllowedUserId = tUid;

  return out;
}

/* ---- Settings UI helpers ---- */
function makeFieldset(legend) {
  const fs = document.createElement('fieldset');
  fs.className = 'm-fieldset';
  const lg = document.createElement('legend');
  lg.textContent = legend;
  fs.append(lg);
  return fs;
}
function field(labelText, control, hint) {
  const wrap = document.createElement('label');
  wrap.className = 'm-field';
  const lab = document.createElement('span');
  lab.textContent = labelText;
  wrap.append(lab, control);
  if (hint) {
    const h = document.createElement('small');
    h.className = 'm-field__hint';
    h.textContent = hint;
    wrap.append(h);
  }
  return wrap;
}
function input(name, type, value, placeholder) {
  const el = document.createElement('input');
  el.name = name;
  el.type = type;
  if (value != null && value !== '') el.value = String(value);
  if (placeholder) el.placeholder = placeholder;
  if (type === 'password') el.autocomplete = 'new-password';
  return el;
}
function toggle(name, labelText, checked) {
  const wrap = document.createElement('label');
  wrap.className = 'm-toggle';
  const span = document.createElement('span');
  span.className = 'm-toggle__label';
  span.textContent = labelText;
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.name = name; cb.hidden = true;
  if (checked) cb.checked = true;
  const sw = document.createElement('span');
  sw.className = 'm-switch';
  wrap.append(span, cb, sw);
  return wrap;
}

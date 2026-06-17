<script lang="ts">
  /**
   * /settings — Section-style Settings.
   *
   * Sections: Anmeldung, Automatik, Telegram, Erweitert.
   * Save via Speichern-Button oder Cmd/Ctrl+Enter aus jedem Eingabefeld.
   * DB-Reset: 2-stage confirm (kein native confirm()).
   *
   * Auf Server-Seite filtert filterUiPatch() Credentials weg, wenn
   * ALLOW_UI_CREDENTIALS=false ist. URLs/port sind nicht patchable.
   */

  import { onMount } from 'svelte';
  import {
    getSettings,
    updateSettings,
    clearStundenplan,
    resetDb
  } from '$lib/api/endpoints';
  import { pushToast } from '$lib/stores/toast.svelte';
  import type {
    SettingsView,
    SettingsPatch,
    ScheduleMode
  } from '$lib/api/types';

  let current = $state<SettingsView | null>(null);
  let patch = $state<SettingsPatch>({});
  let loading = $state(true);
  let saving = $state(false);

  // DB-Reset (2-stage confirm) — persistent until user confirms or explicitly
  // cancels. Auto-revert is hostile and SR-invisible, so we keep state until
  // the user makes a decision.
  let dbResetState = $state<'idle' | 'confirming' | 'busy'>('idle');
  let fullDbResetState = $state<'idle' | 'confirming' | 'busy'>('idle');
  // Persistente Inline-Fehler pro Danger-Aktion. Ein Toast ist transient — bei
  // einer destruktiven Aktion muss der Fehler an der Zeile stehen bleiben, bis
  // der naechste Versuch laeuft (sonst bleibt unklar, ob die DB weg ist).
  let dbResetError = $state<string | null>(null);
  let fullDbResetError = $state<string | null>(null);
  // Der volle Nuke braucht eine bewusste zweite Bestaetigung (Checkbox), damit
  // er sich von der Zwei-Tap-Geste des leichten Resets unterscheidet — Reibung
  // proportional zum Blast-Radius (loescht ALLE gescrapten Daten).
  let fullDbResetArmed = $state(false);

  // Mirror "live" form values; bind:value writes through a setter helper that
  // updates `patch` only when the value actually differs from `current`.
  let formMsEmail = $state('');
  let formMsPassword = $state('');
  let formUserPk = $state('');
  let formAutoRun = $state(false);
  let formManualScrapeFullDetails = $state(false);
  let formScheduleMode = $state<ScheduleMode>('interval');
  let formScheduleDays = $state<number[]>([]);
  let formIntervalMinutes = $state(60);
  let formIntervalTimeFrom = $state('08:00');
  let formIntervalTimeTo = $state('20:00');
  let formScheduleTimes = $state<string[]>([]);
  let formTelegramEnabled = $state(false);
  let formTelegramToken = $state('');
  let formTelegramAllowedUserId = $state('');
  let formBaseUrl = $state('');
  let formSlowMo = $state(0);
  let formPort = $state(0);
  let formHeadless = $state(true);

  // Telegram section open state — opened on first hydrate if enabled or token
  // is set; otherwise stays closed. User can toggle freely afterward.
  let telegramOpen = $state(false);
  // Erweitert nutzt dasselbe Collapse-Muster wie Telegram (eine Disclosure-
  // Sprache statt nativem <details> + Chevron), Default zu.
  let advancedOpen = $state(false);

  // Tracks ob Settings-View urspruenglich UI-Credentials erlaubte.
  const allowUiCreds = $derived(current?.allowUiCredentials !== false);

  async function load(): Promise<void> {
    loading = true;
    try {
      const view = await getSettings();
      hydrate(view);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unbekannter Fehler';
      pushToast('error', `Settings laden fehlgeschlagen: ${msg}`);
    } finally {
      loading = false;
    }
  }

  function hydrate(view: SettingsView): void {
    const isFirstLoad = current === null;
    current = view;
    patch = {};
    formMsEmail = view.msEmail ?? '';
    formMsPassword = '';
    formUserPk = view.userPk ?? '';
    formAutoRun = !!view.autoRun;
    formManualScrapeFullDetails = !!view.manualScrapeFullDetails;
    formScheduleMode = view.scheduleMode === 'weekly' ? 'weekly' : 'interval';
    formScheduleDays = Array.isArray(view.scheduleDays) ? [...view.scheduleDays] : [];
    formIntervalMinutes = view.intervalMinutes || 60;
    formIntervalTimeFrom = view.intervalTimeFrom || '08:00';
    formIntervalTimeTo = view.intervalTimeTo || '20:00';
    formScheduleTimes = Array.isArray(view.scheduleTimes) ? [...view.scheduleTimes] : [];
    formTelegramEnabled = !!view.telegramEnabled;
    formTelegramToken = '';
    formTelegramAllowedUserId =
      view.telegramAllowedUserId != null ? String(view.telegramAllowedUserId) : '';
    formBaseUrl = view.baseUrl ?? '';
    formSlowMo = view.slowMo ?? 0;
    formPort = view.port ?? 0;
    formHeadless = !!view.headless;
    // Open Telegram section only on initial load — never collapse/auto-open
    // again on subsequent saves so user's manual collapse stays sticky.
    if (isFirstLoad && (view.telegramEnabled || view.telegramTokenSet)) {
      telegramOpen = true;
    }
  }

  /** Build PATCH payload from form state vs current. Empty secrets dropped. */
  function buildPatch(): SettingsPatch {
    if (!current) return {};
    const p: SettingsPatch = {};

    // Always-patchable
    if (formAutoRun !== current.autoRun) p.autoRun = formAutoRun;
    if (formManualScrapeFullDetails !== current.manualScrapeFullDetails) {
      p.manualScrapeFullDetails = formManualScrapeFullDetails;
    }
    if (formScheduleMode !== current.scheduleMode) p.scheduleMode = formScheduleMode;
    if (!arraysEqualNum(formScheduleDays, current.scheduleDays)) {
      p.scheduleDays = [...formScheduleDays].sort((a, b) => a - b);
    }
    if (formIntervalMinutes !== current.intervalMinutes) {
      p.intervalMinutes = clampInterval(formIntervalMinutes);
    }
    if (formIntervalTimeFrom !== current.intervalTimeFrom) p.intervalTimeFrom = formIntervalTimeFrom;
    if (formIntervalTimeTo !== current.intervalTimeTo) p.intervalTimeTo = formIntervalTimeTo;
    if (!arraysEqualStr(formScheduleTimes, current.scheduleTimes)) {
      p.scheduleTimes = formScheduleTimes
        .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
        .map(padTime);
    }
    if (formTelegramEnabled !== current.telegramEnabled) p.telegramEnabled = formTelegramEnabled;
    const tgUid = formTelegramAllowedUserId.trim() === '' ? null : Number(formTelegramAllowedUserId);
    if (tgUid !== current.telegramAllowedUserId) p.telegramAllowedUserId = tgUid;
    if (formHeadless !== current.headless) p.headless = formHeadless;
    if (formSlowMo !== current.slowMo) p.slowMo = Number(formSlowMo) || 0;

    // Credential-only Felder
    if (allowUiCreds) {
      if (formMsEmail.trim() !== (current.msEmail ?? '')) p.msEmail = formMsEmail.trim();
      if (formUserPk.trim() !== (current.userPk ?? '')) p.userPk = formUserPk.trim();
      if (formMsPassword.length > 0) p.msPassword = formMsPassword;
      if (formTelegramToken.length > 0) p.telegramToken = formTelegramToken;
    }

    return p;
  }

  function clampInterval(n: number): number {
    if (!Number.isFinite(n)) return 60;
    return Math.min(1440, Math.max(5, Math.round(n)));
  }

  function padTime(t: string): string {
    const [hh, mm] = t.split(':');
    return hh.padStart(2, '0') + ':' + (mm || '00').padStart(2, '0');
  }

  function arraysEqualNum(a: number[], b: number[] | undefined): boolean {
    if (!b) return a.length === 0;
    if (a.length !== b.length) return false;
    const sa = [...a].sort((x, y) => x - y);
    const sb = [...b].sort((x, y) => x - y);
    return sa.every((v, i) => v === sb[i]);
  }

  function arraysEqualStr(a: string[], b: string[] | undefined): boolean {
    if (!b) return a.length === 0;
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }

  async function save(): Promise<void> {
    if (saving || !current) return;
    const built = buildPatch();
    if (Object.keys(built).length === 0) {
      pushToast('info', 'Keine Änderungen.');
      return;
    }
    saving = true;
    try {
      const res = await updateSettings(built);
      hydrate(res.settings);
      const msg = res.rescheduled ? '✓ Gespeichert · Automatik neu geplant' : '✓ Gespeichert';
      pushToast('success', msg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unbekannter Fehler';
      pushToast('error', `Fehler: ${msg}`);
    } finally {
      saving = false;
    }
  }

  // Cmd/Ctrl+Enter speichert. Hot path on every keystroke — keep the early
  // exits cheapest-first (key + modifier) so non-shortcut keys cost ~nothing.
  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (loading || !current) return;
    const target = e.target as Element | null;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      e.preventDefault();
      void save();
    }
  }

  // ----- Day chips -----
  const DAY_CHIPS: ReadonlyArray<{ value: number; label: string }> = [
    { value: 1, label: 'Mo' },
    { value: 2, label: 'Di' },
    { value: 3, label: 'Mi' },
    { value: 4, label: 'Do' },
    { value: 5, label: 'Fr' },
    { value: 6, label: 'Sa' },
    { value: 0, label: 'So' }
  ];

  /**
   * WAI-ARIA APG: switch role must respond to Space. Enter is wired by the
   * default button click, but Space scrolls the page on a generic button —
   * so we intercept it and toggle the bound state via the supplied setter.
   */
  function onToggleKeydown(e: KeyboardEvent, setter: () => void): void {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      setter();
    }
  }

  function toggleDay(d: number): void {
    if (formScheduleDays.includes(d)) {
      formScheduleDays = formScheduleDays.filter((x) => x !== d);
    } else {
      formScheduleDays = [...formScheduleDays, d];
    }
  }

  // ----- Schedule times -----
  function addScheduleTime(): void {
    formScheduleTimes = [...formScheduleTimes, '08:00'];
  }
  function removeScheduleTime(idx: number): void {
    formScheduleTimes = formScheduleTimes.filter((_, i) => i !== idx);
  }
  function updateScheduleTime(idx: number, value: string): void {
    formScheduleTimes = formScheduleTimes.map((t, i) => (i === idx ? value : t));
  }

  // ----- Interval label -----
  // Recomputes only when formIntervalMinutes changes (slider drag); pure fn,
  // tiny allocation — kept inline.
  const intervalLabel = $derived(
    formIntervalMinutes < 60
      ? `alle ${formIntervalMinutes} min`
      : Number.isInteger(formIntervalMinutes / 60)
        ? `alle ${formIntervalMinutes / 60} h`
        : `alle ${(formIntervalMinutes / 60).toFixed(2)} h`
  );

  // ----- DB Reset (2-stage confirm) -----
  // No auto-revert: confirming state persists until the user either confirms
  // or explicitly cancels via the paired Abbrechen button.
  async function onDbReset(): Promise<void> {
    if (dbResetState === 'busy') return;
    if (dbResetState === 'idle') {
      dbResetError = null;
      dbResetState = 'confirming';
      return;
    }
    if (dbResetState === 'confirming') {
      dbResetState = 'busy';
      try {
        const res = await clearStundenplan();
        const n = typeof res.deleted === 'number' ? res.deleted : 0;
        dbResetError = null;
        pushToast(
          'success',
          `✓ Stundenplan zurückgesetzt · ${n} Eintrag${n === 1 ? '' : 'e'} gelöscht`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unbekannter Fehler';
        dbResetError = `Reset fehlgeschlagen: ${msg}`;
        pushToast('error', `Fehler: ${msg}`);
      } finally {
        dbResetState = 'idle';
      }
    }
  }

  function cancelDbReset(): void {
    if (dbResetState === 'confirming') dbResetState = 'idle';
  }

  // ----- Voller DB-Reset (alle gescrapten Daten; Push-Abos + Settings bleiben) -----
  // Gleiches 2-Stufen-Confirm-Muster wie der Stundenplan-Reset. Nach Erfolg ein
  // 'wissen:scrape'-Event feuern, damit offene Views (Noten/Plan/Absenzen) leer
  // nachladen, statt veraltete Daten zu zeigen.
  async function onFullDbReset(): Promise<void> {
    if (fullDbResetState === 'busy') return;
    if (fullDbResetState === 'idle') {
      fullDbResetError = null;
      fullDbResetArmed = false;
      fullDbResetState = 'confirming';
      return;
    }
    if (fullDbResetState === 'confirming') {
      // Safety-Gate: ohne gesetzte Checkbox passiert nichts (der Button ist
      // ohnehin disabled, das hier ist die zweite Verteidigungslinie).
      if (!fullDbResetArmed) return;
      fullDbResetState = 'busy';
      try {
        const res = await resetDb();
        const n = typeof res.total === 'number' ? res.total : 0;
        fullDbResetError = null;
        pushToast(
          'success',
          `✓ Datenbank zurückgesetzt · ${n} Zeile${n === 1 ? '' : 'n'} gelöscht · jetzt neu abfragen`
        );
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('wissen:scrape'));
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unbekannter Fehler';
        fullDbResetError = `Reset fehlgeschlagen: ${msg}`;
        pushToast('error', `Fehler: ${msg}`);
      } finally {
        fullDbResetState = 'idle';
        fullDbResetArmed = false;
      }
    }
  }

  function cancelFullDbReset(): void {
    if (fullDbResetState === 'confirming') {
      fullDbResetState = 'idle';
      fullDbResetArmed = false;
    }
  }

  // ----- Mount -----
  onMount(() => {
    void load();
  });
</script>

<svelte:head>
  <title>Einstellungen · WISSen</title>
</svelte:head>

<svelte:window onkeydown={onWindowKeydown} />

<div class="route__head">
  <h1 class="route__title">Einstellungen</h1>
  <span class="route__subtitle mono">⌘+Enter zum Speichern</span>
</div>

{#if loading}
  <div class="loading mono">lädt…</div>
{:else if current}
  <!-- ============ Anmeldung ============ -->
  <section class="sec">
    <header class="sec__head">
      <h2 class="sec__title">Anmeldung</h2>
      <span class="sec__hint">Microsoft-Konto, mit dem Tocco geöffnet wird.</span>
    </header>

    <div class="rows">
      <div class="row">
        <label for="msEmail">MS-Email</label>
        <input
          id="msEmail"
          type="email"
          autocomplete="off"
          placeholder="name@schule.ch"
          bind:value={formMsEmail}
          disabled={!allowUiCreds}
        />
        {#if !allowUiCreds}
          <p class="hint">Wert nur via .env änderbar.</p>
        {/if}
      </div>

      <div class="row">
        <label for="msPassword">MS-Passwort</label>
        <input
          id="msPassword"
          type="password"
          autocomplete="new-password"
          placeholder={current.passwordSet ? '••• (gesetzt, unverändert)' : 'Passwort setzen'}
          bind:value={formMsPassword}
          disabled={!allowUiCreds}
        />
        <p class="hint">Wird nie zurückgegeben, nur einmal speichern.</p>
      </div>

      <div class="row">
        <label for="userPk">Tocco User-PK</label>
        <input
          id="userPk"
          type="text"
          autocomplete="off"
          placeholder="z.B. 48391"
          bind:value={formUserPk}
          disabled={!allowUiCreds}
        />
        <p class="hint">
          Primärschlüssel deines Tocco-Benutzers. Steht in der URL nach dem Login als ?key=… (Network-Tab).
        </p>
      </div>
    </div>
  </section>

  <!-- ============ Automatik ============ -->
  <section class="sec">
    <header class="sec__head">
      <h2 class="sec__title">Automatik</h2>
      <span class="sec__hint">Auto-Run pollt nach Plan, sonst nur manuell.</span>
    </header>

    <div class="rows">
      <div class="row row--inline">
        <div class="row__main">
          <label for="autoRun">Auto-Run aktivieren</label>
          <p class="hint">Startet Abfrage nach Zeitplan.</p>
        </div>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={formAutoRun}
          aria-label="Auto-Run aktivieren"
          onclick={() => (formAutoRun = !formAutoRun)}
          onkeydown={(e) => onToggleKeydown(e, () => (formAutoRun = !formAutoRun))}
          id="autoRun"
        >
          <span class="toggle__track" class:toggle__track--on={formAutoRun}>
            <span class="toggle__thumb" class:toggle__thumb--on={formAutoRun}></span>
          </span>
        </button>
      </div>

      <div class="row row--inline">
        <div class="row__main">
          <label for="manualScrapeFullDetails">Manuell: alle Moduldetails</label>
          <p class="hint">
            Manuelle Abfrage zieht die Details aller Module neu, statt nur
            geänderter. Auto-Run bleibt unverändert.
          </p>
        </div>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={formManualScrapeFullDetails}
          aria-label="Manuelle Abfrage: alle Moduldetails mitziehen"
          onclick={() => (formManualScrapeFullDetails = !formManualScrapeFullDetails)}
          onkeydown={(e) =>
            onToggleKeydown(e, () => (formManualScrapeFullDetails = !formManualScrapeFullDetails))}
          id="manualScrapeFullDetails"
        >
          <span
            class="toggle__track"
            class:toggle__track--on={formManualScrapeFullDetails}
          >
            <span
              class="toggle__thumb"
              class:toggle__thumb--on={formManualScrapeFullDetails}
            ></span>
          </span>
        </button>
      </div>

      <div class="row">
        <fieldset class="row__fieldset">
          <legend class="row__label">Modus</legend>
          <div class="mode-switch" role="radiogroup" aria-label="Scheduler-Modus">
            <label class="mode-opt">
              <input
                type="radio"
                name="scheduleMode"
                value="interval"
                checked={formScheduleMode === 'interval'}
                onchange={() => (formScheduleMode = 'interval')}
              />
              <span>Intervall</span>
            </label>
            <label class="mode-opt">
              <input
                type="radio"
                name="scheduleMode"
                value="weekly"
                checked={formScheduleMode === 'weekly'}
                onchange={() => (formScheduleMode = 'weekly')}
              />
              <span>Wochenplan</span>
            </label>
          </div>
        </fieldset>
      </div>

      <!-- Wochentage gelten in BEIDEN Modi (siehe src/settings.js: "beide
           Modi: 0=So .. 6=Sa"). Im Intervall-Modus engt das die Tage ein,
           an denen der Auto-Run überhaupt feuert; im Wochenplan-Modus
           definiert es zusammen mit den Uhrzeiten das Schedule-Grid. -->
      <div class="row">
        <fieldset class="row__fieldset">
          <legend class="row__label">Wochentage</legend>
          <div class="day-chips" role="group" aria-label="Wochentage">
            {#each DAY_CHIPS as chip (chip.value)}
              <button
                type="button"
                class="day-chip"
                class:day-chip--on={formScheduleDays.includes(chip.value)}
                aria-pressed={formScheduleDays.includes(chip.value)}
                onclick={() => toggleDay(chip.value)}
              >
                {chip.label}
              </button>
            {/each}
          </div>
        </fieldset>
      </div>

      {#if formScheduleMode === 'interval'}
        <div class="row">
          <label for="intervalMinutes">Intervall</label>
          <div class="slider-wrap">
            <input
              id="intervalMinutes"
              type="range"
              min="5"
              max="1440"
              step="5"
              bind:value={formIntervalMinutes}
            />
            <span class="slider-label mono">{intervalLabel}</span>
          </div>
        </div>

        <div class="row">
          <span class="row__label">Zeitfenster</span>
          <div class="time-pair">
            <input type="time" bind:value={formIntervalTimeFrom} aria-label="von" />
            <span class="time-pair__sep mono">bis</span>
            <input type="time" bind:value={formIntervalTimeTo} aria-label="bis" />
          </div>
          <p class="hint">Ausserhalb pausiert Auto-Run.</p>
        </div>
      {:else}
        <div class="row">
          <span class="row__label">Uhrzeiten</span>
          <div class="time-list">
            {#each formScheduleTimes as t, i (i)}
              <div class="time-row">
                <input
                  type="time"
                  value={t}
                  oninput={(e) => updateScheduleTime(i, (e.currentTarget as HTMLInputElement).value)}
                  aria-label="Uhrzeit {i + 1}"
                />
                <button
                  type="button"
                  class="time-remove"
                  aria-label="Uhrzeit entfernen"
                  onclick={() => removeScheduleTime(i)}
                >
                  ×
                </button>
              </div>
            {/each}
            <button type="button" class="time-add" onclick={addScheduleTime}>
              + Uhrzeit hinzufügen
            </button>
          </div>
        </div>
      {/if}
    </div>
  </section>

  <!-- ============ Telegram ============ -->
  <section class="sec">
    <button
      type="button"
      class="sec__head sec__head--clickable sec__head--btn"
      aria-expanded={telegramOpen}
      aria-controls="telegram-section"
      onclick={() => (telegramOpen = !telegramOpen)}
    >
      <h2 class="sec__title">
        <svg
          class="sec__chevron"
          class:sec__chevron--open={telegramOpen}
          viewBox="0 0 24 24"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        Telegram
      </h2>
      <span class="sec__hint">
        {current.telegramTokenSet ? 'Token gesetzt' : 'Optional'}
        {current.telegramEnabled ? ' · aktiv' : ''}
      </span>
    </button>

    {#if telegramOpen}
      <div id="telegram-section" class="rows">
        <div class="row row--inline">
          <div class="row__main">
            <label for="tgEnabled">Bot aktivieren</label>
            <p class="hint">Erwartet Token + erlaubte User-ID.</p>
          </div>
          <button
            type="button"
            class="toggle"
            role="switch"
            aria-checked={formTelegramEnabled}
            aria-label="Telegram-Bot aktivieren"
            onclick={() => (formTelegramEnabled = !formTelegramEnabled)}
            onkeydown={(e) => onToggleKeydown(e, () => (formTelegramEnabled = !formTelegramEnabled))}
            id="tgEnabled"
          >
            <span class="toggle__track" class:toggle__track--on={formTelegramEnabled}>
              <span class="toggle__thumb" class:toggle__thumb--on={formTelegramEnabled}></span>
            </span>
          </button>
        </div>

        <div class="row">
          <label for="tgToken">Bot-Token</label>
          <input
            id="tgToken"
            type="password"
            autocomplete="off"
            placeholder={current.telegramTokenSet ? '••• (gesetzt, unverändert)' : '123456:ABC-DEF...'}
            bind:value={formTelegramToken}
            disabled={!allowUiCreds}
          />
          <p class="hint">
            1. Bei @BotFather → /newbot → Anweisungen folgen.
            2. Token kopieren.
            3. Hier einfügen.
          </p>
        </div>

        <div class="row">
          <label for="tgUid">Erlaubte User-ID</label>
          <input
            id="tgUid"
            type="number"
            min="1"
            placeholder="123456789"
            bind:value={formTelegramAllowedUserId}
          />
          <p class="hint">Eigene User-ID via @userinfobot herausfinden.</p>
        </div>
      </div>
    {/if}
  </section>

  <!-- ============ Erweitert ============ -->
  <section class="sec">
    <button
      type="button"
      class="sec__head sec__head--clickable sec__head--btn"
      aria-expanded={advancedOpen}
      aria-controls="advanced-section"
      onclick={() => (advancedOpen = !advancedOpen)}
    >
      <h2 class="sec__title">
        <svg
          class="sec__chevron"
          class:sec__chevron--open={advancedOpen}
          viewBox="0 0 24 24"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        Erweitert
      </h2>
      <span class="sec__hint">Browser- und Server-Internas.</span>
    </button>

    {#if advancedOpen}
      <div id="advanced-section" class="rows">
        <div class="row">
          <label for="baseUrl">Base-URL</label>
          <input id="baseUrl" type="url" value={formBaseUrl} disabled />
          <p class="hint">URLs sind via .env festgelegt.</p>
        </div>

        <div class="row">
          <label for="slowMo">slowMo (ms)</label>
          <input id="slowMo" type="number" min="0" max="2000" step="50" bind:value={formSlowMo} />
          <p class="hint">Verzögerung pro Browser-Aktion. 0 = aus.</p>
        </div>

        <div class="row">
          <label for="port">Port</label>
          <input id="port" type="number" value={formPort} disabled />
          <p class="hint">Server-Port wird via .env gesetzt.</p>
        </div>

        <div class="row row--inline">
          <div class="row__main">
            <label for="headless">Headless</label>
            <p class="hint">Browser ohne sichtbares Fenster starten.</p>
          </div>
          <button
            type="button"
            class="toggle"
            role="switch"
            aria-checked={formHeadless}
            aria-label="Headless-Modus"
            onclick={() => (formHeadless = !formHeadless)}
            onkeydown={(e) => onToggleKeydown(e, () => (formHeadless = !formHeadless))}
            id="headless"
          >
            <span class="toggle__track" class:toggle__track--on={formHeadless}>
              <span class="toggle__thumb" class:toggle__thumb--on={formHeadless}></span>
            </span>
          </button>
        </div>
      </div>
    {/if}
  </section>

  <!-- ============ Danger zone ============ -->
  <section class="sec sec--danger">
    <header class="sec__head">
      <h2 class="sec__title">Datenbank</h2>
      <span class="sec__hint">Daten werden bei der nächsten Abfrage neu geladen. Push-Abos &amp; Einstellungen bleiben erhalten.</span>
    </header>

    <div class="rows">
      <!-- Leichter Reset: nur Stundenplan. 2-Stufen-Confirm + Inline-Fehler. -->
      <div class="row">
        <div class="db-reset" aria-live="polite">
          <button
            type="button"
            class="btn-danger"
            class:btn-danger--confirming={dbResetState === 'confirming'}
            disabled={dbResetState === 'busy'}
            onclick={() => void onDbReset()}
          >
            {#if dbResetState === 'idle'}
              Stundenplan zurücksetzen
            {:else if dbResetState === 'confirming'}
              Wirklich löschen?
            {:else}
              Lösche…
            {/if}
          </button>
          {#if dbResetState === 'confirming'}
            <button type="button" class="btn-cancel" onclick={cancelDbReset}>Abbrechen</button>
          {/if}
        </div>
        {#if dbResetError}
          <p class="db-reset__error" role="alert">{dbResetError}</p>
        {/if}
      </div>

      <!-- Schwerere Aktion: leert ALLE gescrapten Daten. Zusaetzliche Reibung —
           der Confirm-Button bleibt disabled, bis die Checkbox bewusst gesetzt
           wurde (Reibung proportional zum Blast-Radius). -->
      <div class="row">
        <div class="db-reset" aria-live="polite">
          <button
            type="button"
            class="btn-danger btn-danger--nuke"
            class:btn-danger--confirming={fullDbResetState === 'confirming'}
            disabled={fullDbResetState === 'busy' ||
              (fullDbResetState === 'confirming' && !fullDbResetArmed)}
            onclick={() => void onFullDbReset()}
          >
            {#if fullDbResetState === 'idle'}
              🧨 Gesamte Datenbank zurücksetzen
            {:else if fullDbResetState === 'confirming'}
              Endgültig löschen
            {:else}
              Lösche alles…
            {/if}
          </button>
          {#if fullDbResetState === 'confirming'}
            <button type="button" class="btn-cancel" onclick={cancelFullDbReset}>Abbrechen</button>
          {/if}
        </div>
        {#if fullDbResetState === 'confirming'}
          <label class="nuke-confirm">
            <input type="checkbox" bind:checked={fullDbResetArmed} />
            <span>Ja, Noten, Prüfungen, Stundenplan &amp; Absenzen unwiderruflich löschen.</span>
          </label>
        {:else}
          <span class="db-reset__note">
            Löscht alle abgerufenen Daten. Push-Abos &amp; Einstellungen bleiben. Danach einmal abfragen.
          </span>
        {/if}
        {#if fullDbResetError}
          <p class="db-reset__error" role="alert">{fullDbResetError}</p>
        {/if}
      </div>
    </div>
  </section>

  <!-- ============ Save bar ============ -->
  <div class="save-bar" aria-live="polite">
    <span class="save-bar__hint mono">⌘+Enter zum Speichern</span>
    <button
      type="button"
      class="btn-save"
      disabled={saving || loading}
      aria-busy={saving}
      onclick={() => void save()}
    >
      {saving ? 'Speichere…' : 'Speichern'}
    </button>
  </div>
{/if}

<style>
  .route__head { display: flex; align-items: baseline; gap: 14px; margin-bottom: 22px; }
  .route__title { font-size: 22px; font-weight: 700; margin: 0; color: var(--text); letter-spacing: -0.01em; }
  .route__subtitle { color: var(--text-mute); font-size: 12px; }
  .loading { color: var(--text-dim); font-size: 13px; padding: 24px 0; }

  /* ===== Section list (NOT card-grid) ===== */
  .sec { padding: 0 0 24px 0; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
  .sec:last-of-type { border-bottom: none; }
  .sec__head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
  .sec__head--clickable { cursor: pointer; user-select: none; border-radius: var(--r-sm); padding: 4px 0; }
  .sec__head--clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* When the head is rendered as a <button> for a11y (collapse triggers), kill
   * the default button chrome and stretch to full row width so click target
   * matches the visual header. */
  .sec__head--btn {
    appearance: none;
    background: transparent;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    width: 100%;
  }
  .sec__title {
    margin: 0; font-size: 12px; font-weight: 600;
    letter-spacing: 0.10em; text-transform: uppercase; color: var(--text-mute);
    display: inline-flex; align-items: baseline; gap: 8px;
  }
  .sec__chevron {
    color: var(--text-dim);
    flex-shrink: 0;
    /* ease-expo (statt --ease) fuer einen snappigeren, bewussteren Reveal. */
    transition: transform var(--t-fast) var(--ease-expo);
  }
  .sec__chevron--open { transform: rotate(90deg); }
  .sec__hint { font-size: 12px; color: var(--text-dim); max-width: 60ch; }

  /* ===== Rows ===== */
  .rows { display: flex; flex-direction: column; gap: 14px; }
  .row { display: flex; flex-direction: column; gap: 6px; }
  .row label,
  .row__label { font-size: 12px; color: var(--text-mute); font-weight: 500; }
  .row--inline { flex-direction: row; align-items: center; justify-content: space-between; gap: 14px; }
  .row__main { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
  .row__main label { font-size: 13px; color: var(--text); font-weight: 500; }

  /* Fieldset reset for grouped controls (Modus radios, Wochentage chips).
   * Native fieldset adds a border, padding, and a min-width: min-content rule
   * that breaks flex shrink — strip them all and let row layout drive sizing. */
  .row__fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  @media (max-width: 480px) {
    .row--inline { flex-direction: column; align-items: flex-start; }
  }

  /* ===== Inputs ===== */
  .row input[type='text'],
  .row input[type='email'],
  .row input[type='password'],
  .row input[type='url'],
  .row input[type='number'],
  .row input[type='time'] {
    background: var(--surface-2); border: 1px solid var(--border-soft);
    border-radius: var(--r-md); padding: 9px 12px; color: var(--text);
    font-size: 13px; width: 100%; color-scheme: dark;
    transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
  }
  .row input:focus {
    outline: 0; border-color: var(--accent-border); background: var(--surface);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .row input:disabled { opacity: 0.6; cursor: not-allowed; }
  .hint { color: var(--text-dim); font-size: 12px; margin: 2px 0 0 0; line-height: 1.5; max-width: 64ch; }

  /* ===== Toggle ===== */
  .toggle { display: inline-flex; align-items: center; background: none; border: none; padding: 4px; cursor: pointer; flex-shrink: 0; border-radius: 999px; }
  .toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 999px;
  }
  .toggle__track {
    width: 36px; height: 20px; background: var(--surface-3);
    border: 1px solid var(--border); border-radius: 999px; position: relative;
    transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  .toggle__track--on { background: var(--accent-soft); border-color: var(--accent-border); }
  .toggle__thumb {
    position: absolute; top: 1px; left: 1px; width: 16px; height: 16px;
    background: transparent; border: 1.5px solid var(--text-mute); border-radius: 50%;
    transition: transform var(--t-fast) var(--ease), background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  .toggle__thumb--on { background: var(--accent); border-color: var(--accent); transform: translateX(16px); }

  /* ===== Mode switch ===== */
  .mode-switch {
    display: inline-flex; background: var(--surface-2);
    border: 1px solid var(--border-soft); border-radius: var(--r-md);
    padding: 3px; align-self: flex-start;
  }
  .mode-opt { position: relative; cursor: pointer; user-select: none; }
  .mode-opt input[type='radio'] { position: absolute; opacity: 0; pointer-events: none; }
  .mode-opt span {
    display: inline-block; padding: 5px 12px; border-radius: 6px;
    font-size: 13px; color: var(--text-mute);
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
  }
  .mode-opt input:checked + span { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
  .mode-opt input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ===== Slider ===== */
  .slider-wrap { display: flex; align-items: center; gap: 14px; }
  .slider-wrap input[type='range'] { flex: 1; accent-color: var(--accent); }
  .slider-label { font-size: 12px; color: var(--text); font-weight: 600; min-width: 96px; text-align: right; }

  /* ===== Time pair / chips / list ===== */
  .time-pair { display: flex; gap: 8px; align-items: center; }
  .time-pair input { flex: 1; }
  .time-pair__sep { color: var(--text-dim); font-size: 12px; }
  .day-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .day-chip {
    background: var(--surface-2); color: var(--text-mute);
    border: 1px solid var(--border-soft); padding: 5px 11px;
    border-radius: var(--r-md); font-size: 13px; cursor: pointer;
    font-family: var(--font-mono); letter-spacing: 0.02em;
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .day-chip:hover { background: var(--surface-3); }
  }
  .day-chip--on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
  .time-list { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .time-row { display: flex; gap: 8px; align-items: center; }
  .time-row input { width: 110px; }
  .time-remove {
    background: var(--surface-2); color: var(--text-mute);
    border: 1px solid var(--border-soft); width: 28px; height: 28px;
    border-radius: var(--r-sm); font-size: 14px; line-height: 1; cursor: pointer;
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .time-remove:hover { background: var(--surface-3); color: var(--danger); }
  }
  .time-add {
    background: transparent; color: var(--text-mute);
    border: 1px dashed var(--border); border-radius: var(--r-sm);
    padding: 6px 12px; font-size: 12px; cursor: pointer;
    transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .time-add:hover { color: var(--accent); border-color: var(--accent-border); }
  }

  /* ===== Danger ===== */
  .sec--danger { border-bottom: none; }
  .db-reset { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .btn-danger {
    background: var(--surface-2); color: var(--danger);
    /* Danger-Identitaet schon im Ruhezustand ueber einen ZARTEN getoenten Rahmen
       (statt knallrotem Fill) — restraint. */
    border: 1px solid var(--danger-border); border-radius: var(--r-md);
    padding: 8px 14px; font-size: 13px; font-weight: 600;
    cursor: pointer; align-self: flex-start;
    /* transform in der Transition fuer Press-Feedback (Emil). Nie `all`. */
    transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
                transform var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .btn-danger:hover { background: var(--danger-soft); border-color: var(--danger-border-strong); }
  }
  .btn-danger:active { transform: scale(0.97); }
  .btn-danger:disabled { opacity: 0.6; cursor: not-allowed; }
  /* "Nuke" = die schwerere Aktion (alles loeschen): staerkerer Danger-Rahmen im
     Ruhezustand, damit sie sich vom leichteren Stundenplan-Reset abhebt. */
  .btn-danger--nuke { border-color: var(--danger-border-strong); }
  /* Confirm = solider Danger-Fill ("ein Klick vom Loeschen"). Kurzer Text haelt
     den Button kompakt statt ihn zum Balken aufzublasen. :hover hier explizit
     solide, damit der normale Hover-Tint nicht gewinnt. */
  .btn-danger--confirming,
  .btn-danger--confirming:hover {
    background: var(--danger); color: var(--accent-ink); border-color: var(--danger);
  }
  .db-reset__note { font-size: 12px; color: var(--text-dim); max-width: 64ch; line-height: 1.5; }
  /* Persistenter Inline-Fehler an der Danger-Zeile (bleibt bis zum naechsten
     Versuch stehen, anders als der transiente Toast). */
  .db-reset__error {
    font-size: 12px; color: var(--danger); font-weight: 500;
    margin: 0; max-width: 64ch; line-height: 1.5;
  }
  /* Nuke-Bestaetigung: bewusste Checkbox, die den Confirm-Button erst scharf
     stellt — Reibung proportional zum Blast-Radius, voll tastatur-/SR-faehig. */
  .nuke-confirm {
    display: flex; align-items: flex-start; gap: 8px;
    font-size: 12px; color: var(--text-mute); line-height: 1.45;
    max-width: 64ch; cursor: pointer; user-select: none;
  }
  .nuke-confirm input { accent-color: var(--danger); margin: 1px 0 0 0; flex-shrink: 0; cursor: pointer; }
  .btn-cancel {
    background: transparent; color: var(--text-mute);
    border: 1px solid var(--border-soft); border-radius: var(--r-md);
    padding: 8px 14px; font-size: 13px; font-weight: 500;
    cursor: pointer;
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .btn-cancel:hover { background: var(--surface-3); color: var(--text); border-color: var(--border-strong); }
  }

  /* ===== Save bar =====
   * Sticky to the viewport bottom so the Speichern action stays in reach on
   * long forms. z-index stays low (10) so app-level Topbar/overlays win. */
  .save-bar {
    display: flex; align-items: center; justify-content: flex-end;
    gap: 14px; margin-top: 8px;
    border-top: 1px solid var(--border);
    position: sticky; bottom: 0; z-index: 10;
    background: var(--surface);
    /* Full-Bleed bis an die .main-Kanten (Rail links, Scrollbar rechts).
       .main__inner ist auf 1600px begrenzt + zentriert (margin:0 auto). Die
       Save-Bar als sticky Kind erbt diese Breite und reicht sonst NICHT bis zum
       Side-Menu — auf breiten Screens bleibt der Zentrier-Gutter sichtbar. Der
       Breakout zieht Hintergrund + Top-Border an die .main-Kanten; das
       Gegen-Padding haelt Hinweis + Button buendig mit den Formularfeldern.
       --rail-w ist mobil bereits 0px → eine Formel deckt Desktop UND Mobile.
       .main hat overflow-x:clip, das den Bleed pixelgenau abschneidet. */
    margin-inline: calc(50% - 50vw + var(--rail-w) / 2);
    padding: 14px calc(50vw - 50% - var(--rail-w) / 2);
  }
  .save-bar__hint { margin-right: auto; font-size: 12px; color: var(--text-dim); letter-spacing: 0.04em; }
  .btn-save {
    background: var(--accent); color: var(--accent-ink); border: none;
    border-radius: var(--r-md); padding: 9px 18px; font-size: 13px;
    font-weight: 600; letter-spacing: 0.02em; cursor: pointer;
    transition: transform var(--t-fast) var(--ease), opacity var(--t-fast) var(--ease);
  }
  /* Press-down only (scale 0.97). Kein hover-Lift — der war marketing-haft und
     out-of-register fuer diese zurueckhaltende Produkt-Oberflaeche. */
  .btn-save:active:not(:disabled) { transform: scale(0.97); }
  .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (prefers-reduced-motion: reduce) {
    .toggle__track, .toggle__thumb, .mode-opt span, .day-chip,
    .btn-danger, .btn-cancel, .btn-save, .row input, .time-add, .time-remove,
    .sec__chevron {
      transition: none;
    }
    .btn-save:active:not(:disabled) { transform: none; }
  }
</style>

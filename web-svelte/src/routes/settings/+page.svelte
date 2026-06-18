<script lang="ts">
  /**
   * /settings — Card-basierte Settings im Mobile-Look, auf Desktop-Breite
   * als Bento-Grid arrangiert.
   *
   * Oben: prominente "Abfrage"-Status-Card (Live-Pill + Progress/Fehler),
   * gespeist aus dem globalen `live`-Store (SSE in +layout). Der Abfrage-
   * Trigger liegt im Header (Topbar), daher hier bewusst kein eigener CTA.
   * Darunter gruppierte Karten: Anmeldung, Automatik, Telegram, Erweitert,
   * Datenbank. Save via Speichern-Button oder Cmd/Ctrl+Enter aus jedem Feld.
   * DB-Reset: 2-stufiges Confirm (kein natives confirm()).
   *
   * Server-seitig filtert filterUiPatch() Credentials weg, wenn
   * ALLOW_UI_CREDENTIALS=false ist. URLs/Port sind nicht patchable.
   */

  import { onMount } from 'svelte';
  import {
    getSettings,
    updateSettings,
    clearStundenplan,
    resetDb
  } from '$lib/api/endpoints';
  import { live } from '$lib/stores/live.svelte';
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

  // Telegram section open state — defaults to closed; user opens it on demand.
  let telegramOpen = $state(false);
  // Erweitert nutzt dasselbe Collapse-Muster wie Telegram (eine Disclosure-
  // Sprache statt nativem <details> + Chevron), Default zu.
  let advancedOpen = $state(false);

  // Tracks ob Settings-View urspruenglich UI-Credentials erlaubte.
  const allowUiCreds = $derived(current?.allowUiCredentials !== false);

  // ----- Live "Abfrage"-Status (aus dem globalen SSE-Store) -----
  const scrapeRunning = $derived(live.kind === 'running' || !!live.raw?.running);
  const scrapeError = $derived(
    !scrapeRunning && (live.kind === 'error' || !!live.raw?.lastError)
  );
  const pillLabel = $derived(
    scrapeRunning ? 'läuft…' : scrapeError ? 'Fehler' : 'bereit'
  );

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
    current = view;
    patch = {};
    formMsEmail = view.msEmail ?? '';
    formMsPassword = '';
    formUserPk = view.userPk ?? '';
    formAutoRun = !!view.autoRun;
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
  }

  /** Build PATCH payload from form state vs current. Empty secrets dropped. */
  function buildPatch(): SettingsPatch {
    if (!current) return {};
    const p: SettingsPatch = {};

    // Always-patchable
    if (formAutoRun !== current.autoRun) p.autoRun = formAutoRun;
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
  <div class="settings-grid">
    <!-- ============ Abfrage-Status (full-bleed, prominent) ============ -->
    <section class="card card--scrape card--span" aria-label="Abfrage-Status">
      <div class="scrape__top">
        <span
          class="scrape__pill"
          class:scrape__pill--running={scrapeRunning}
          class:scrape__pill--error={scrapeError}
        >
          <span class="scrape__dot"></span>
          {pillLabel}
        </span>
        <span class="scrape__lastrun mono">
          {scrapeRunning ? live.label : `Letzter Lauf · ${live.lastrun}`}
        </span>
      </div>


      {#if scrapeRunning}
        <div class="scrape__bar">
          <div class="scrape__bar-fill"></div>
        </div>
        <p class="scrape__caption">{live.label}</p>
      {:else if scrapeError && live.raw?.lastError}
        <p class="scrape__error" role="alert">{String(live.raw.lastError).slice(0, 200)}</p>
      {/if}
    </section>

    <!-- ============ Anmeldung ============ -->
    <section class="card">
      <header class="card__head">
        <h2 class="card__title">Anmeldung</h2>
        <span class="card__hint">Microsoft-Konto, mit dem Tocco geöffnet wird.</span>
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

    <!-- ============ Automatik (spans wider — most content) ============ -->
    <section class="card card--span">
      <header class="card__head">
        <h2 class="card__title">Automatik</h2>
        <span class="card__hint">Auto-Run pollt nach Plan, sonst nur manuell.</span>
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

        <div class="auto-grid">
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
                  <span>⏱ Intervall</span>
                </label>
                <label class="mode-opt">
                  <input
                    type="radio"
                    name="scheduleMode"
                    value="weekly"
                    checked={formScheduleMode === 'weekly'}
                    onchange={() => (formScheduleMode = 'weekly')}
                  />
                  <span>📅 Wochenplan</span>
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
    <section class="card">
      <button
        type="button"
        class="card__head card__head--btn"
        aria-expanded={telegramOpen}
        aria-controls="telegram-section"
        onclick={() => (telegramOpen = !telegramOpen)}
      >
        <h2 class="card__title">
          <svg
            class="card__chevron"
            class:card__chevron--open={telegramOpen}
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
        <span class="card__hint">
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
    <section class="card">
      <button
        type="button"
        class="card__head card__head--btn"
        aria-expanded={advancedOpen}
        aria-controls="advanced-section"
        onclick={() => (advancedOpen = !advancedOpen)}
      >
        <h2 class="card__title">
          <svg
            class="card__chevron"
            class:card__chevron--open={advancedOpen}
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
        <span class="card__hint">Browser- und Server-Internas.</span>
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

    <!-- ============ Danger zone (full-bleed) ============ -->
    <section class="card card--danger card--span">
      <header class="card__head">
        <h2 class="card__title">Datenbank</h2>
        <span class="card__hint">Daten werden bei der nächsten Abfrage neu geladen. Push-Abos &amp; Einstellungen bleiben erhalten.</span>
      </header>

      <div class="danger-grid">
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
          <span class="db-reset__note">Nur den Stundenplan leeren — Noten, Prüfungen &amp; Absenzen bleiben.</span>
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
  </div>

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

  /* ===== Bento grid =====
   * Card-based wie das Mobile-Vorbild, aber auf Desktop als 2-Spalten-Grid
   * arrangiert (statt 1-Spalten-Handy-Ansicht). Karten mit .card--span
   * (Abfrage, Automatik, Datenbank) ziehen über beide Spalten. Unter
   * 900px kollabiert das Grid auf eine Spalte. */
  .settings-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    align-items: start;
    margin-bottom: 8px;
  }
  .card--span { grid-column: 1 / -1; }

  @media (max-width: 900px) {
    .settings-grid { grid-template-columns: minmax(0, 1fr); }
  }

  /* ===== Card (Mobile .m-fieldset Sprache) ===== */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-inline-size: 0;
  }
  .card--danger { border-color: var(--danger-border); }

  /* ===== Card head (Mobile <legend>-Sprache: uppercase, bordered) ===== */
  .card__head {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-soft);
  }
  /* Collapse-Trigger als <button> für a11y — Button-Chrome killen, Layout
   * matcht den statischen Header. */
  .card__head--btn {
    appearance: none;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    color: inherit;
    font: inherit;
    text-align: left;
    width: 100%;
    cursor: pointer;
    user-select: none;
    border-radius: var(--r-sm) var(--r-sm) 0 0;
  }
  .card__head--btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .card__title {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-mute);
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .card__chevron {
    color: var(--text-dim);
    flex-shrink: 0;
    transition: transform var(--t-fast) var(--ease-expo);
  }
  .card__chevron--open { transform: rotate(90deg); }
  .card__hint { font-size: 12px; color: var(--text-dim); max-width: 60ch; line-height: 1.5; }

  /* ===== Rows ===== */
  .rows { display: flex; flex-direction: column; gap: 14px; }
  .row { display: flex; flex-direction: column; gap: 6px; }
  .row label,
  .row__label { font-size: 13px; color: var(--text-mute); font-weight: 500; }
  .row--inline { flex-direction: row; align-items: center; justify-content: space-between; gap: 14px; }
  .row__main { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
  .row__main label { font-size: 14px; color: var(--text); font-weight: 500; }

  /* Modus + Wochentage nebeneinander, wenn Platz da ist (Automatik-Card ist
   * full-width). Auf schmaleren Breiten gestapelt. */
  .auto-grid {
    display: grid;
    grid-template-columns: minmax(180px, 280px) 1fr;
    gap: 14px 24px;
    align-items: start;
  }
  @media (max-width: 620px) {
    .auto-grid { grid-template-columns: minmax(0, 1fr); }
  }

  /* Fieldset reset for grouped controls (Modus radios, Wochentage chips). */
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

  /* ===== Inputs (Mobile .m-field input Sprache) ===== */
  .row input[type='text'],
  .row input[type='email'],
  .row input[type='password'],
  .row input[type='url'],
  .row input[type='number'],
  .row input[type='time'] {
    background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: var(--r-md); padding: 11px 12px; color: var(--text);
    font-size: 14px; width: 100%; color-scheme: dark;
    appearance: none; -webkit-appearance: none;
    transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
  }
  .row input[type='time'] { font-variant-numeric: tabular-nums; }
  .row input:focus-visible {
    outline: 0; border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .row input:disabled { opacity: 0.6; cursor: not-allowed; }
  .hint { color: var(--text-dim); font-size: 12px; margin: 2px 0 0 0; line-height: 1.5; max-width: 64ch; }

  /* ===== Toggle (Mobile .m-switch Maße: 44×26 Track) ===== */
  .toggle { display: inline-flex; align-items: center; background: none; border: none; padding: 0; cursor: pointer; flex-shrink: 0; border-radius: 999px; }
  .toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 999px; }
  .toggle__track {
    width: 44px; height: 26px; background: var(--surface-3);
    border: 1px solid var(--border); border-radius: 999px; position: relative;
    transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  .toggle__track--on { background: var(--accent); border-color: var(--accent); }
  .toggle__thumb {
    position: absolute; top: 2px; left: 2px; width: 20px; height: 20px;
    background: var(--text-mute); border-radius: 50%;
    transition: transform var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
  }
  .toggle__thumb--on { background: var(--accent-ink); transform: translateX(18px); }

  /* ===== Mode switch (Mobile .m-modeswitch: 2-Spalten-Grid mit soft-tint) ===== */
  .mode-switch {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
    background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: var(--r-md); padding: 4px;
  }
  .mode-opt { position: relative; display: block; text-align: center; cursor: pointer; user-select: none; }
  .mode-opt input[type='radio'] { position: absolute; opacity: 0; pointer-events: none; }
  .mode-opt span {
    display: block; padding: 9px 8px; border-radius: calc(var(--r-md) - 2px);
    font-size: 13px; font-weight: 500; color: var(--text-mute);
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
  }
  .mode-opt input:checked + span {
    background: var(--accent-soft); color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent-border);
  }
  .mode-opt input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ===== Slider (Mobile .m-range Sprache) ===== */
  .slider-wrap { display: flex; align-items: center; gap: 14px; }
  .slider-wrap input[type='range'] { flex: 1; accent-color: var(--accent); }
  .slider-label { font-size: 12px; color: var(--text); font-weight: 600; min-width: 96px; text-align: right; }

  /* ===== Time pair / chips / list ===== */
  .time-pair { display: flex; gap: 10px; align-items: center; }
  .time-pair input { flex: 1; }
  .time-pair__sep { color: var(--text-dim); font-size: 13px; }
  /* Day-Chips als 7-Spalten-Grid wie im Mobile (.m-daychips) — gleichmäßig
   * verteilt statt frei umbrechend. */
  .day-chips { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
  .day-chip {
    background: var(--bg-elev); color: var(--text-mute);
    border: 1px solid var(--border); padding: 10px 0;
    border-radius: var(--r-md); font-size: 12px; cursor: pointer;
    font-weight: 600; letter-spacing: 0.04em; text-align: center;
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .day-chip:hover { background: var(--surface-2); border-color: var(--border-strong); }
  }
  .day-chip--on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-border); }
  .time-list { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .time-row { display: flex; gap: 8px; align-items: center; }
  .time-row input { width: 130px; }
  .time-remove {
    background: var(--surface-2); color: var(--danger);
    border: 1px solid var(--border-soft); width: 36px; height: 36px;
    border-radius: 999px; font-size: 20px; line-height: 1; cursor: pointer; flex-shrink: 0;
    transition: background var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .time-remove:hover { background: var(--surface-3); }
  }
  .time-add {
    background: transparent; color: var(--text-mute);
    border: 1px dashed var(--border); border-radius: var(--r-md);
    padding: 8px 14px; font-size: 13px; cursor: pointer; font-weight: 500;
    transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .time-add:hover { color: var(--accent); border-color: var(--accent-border); }
  }

  /* ============================================================
     Abfrage-Status-Card (Mobile .m-scrape Sprache)
     ============================================================ */
  .card--scrape {
    background: linear-gradient(180deg, var(--surface), var(--bg-elev));
    gap: 14px;
  }
  .scrape__top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .scrape__pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 12px; border-radius: 999px;
    background: var(--surface-2); border: 1px solid var(--border);
    font-size: 13px; font-weight: 500; letter-spacing: 0.02em; color: var(--text-mute);
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  .scrape__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-dim); position: relative; }
  .scrape__pill--running { color: var(--accent); border-color: var(--accent-border); background: var(--accent-soft); }
  .scrape__pill--running .scrape__dot { background: var(--accent); }
  .scrape__pill--running .scrape__dot::after {
    content: ''; position: absolute; inset: 0; border-radius: 50%;
    background: var(--accent); transform-origin: center;
    animation: scrape-pulse 1.6s var(--ease) infinite; pointer-events: none;
  }
  .scrape__pill--error { color: var(--danger); border-color: var(--danger-border); background: var(--danger-soft); }
  .scrape__pill--error .scrape__dot { background: var(--danger); }
  @keyframes scrape-pulse {
    0%   { transform: scale(1);   opacity: 0.55; }
    70%  { transform: scale(2.6); opacity: 0;    }
    100% { transform: scale(2.6); opacity: 0;    }
  }
  .scrape__lastrun { font-size: 12px; color: var(--text-dim); }
  .scrape__bar { position: relative; height: 6px; background: var(--surface-3); border-radius: 999px; overflow: hidden; }
  .scrape__bar-fill {
    position: absolute; inset: 0; border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), var(--success));
    transform-origin: left;
    animation: scrape-indeterminate 1.4s var(--ease) infinite;
  }
  /* Indeterminate sweep — der Desktop-Status-Store liefert keine Phase-Steps
   * wie die Mobile-Card; ein laufender Sweep signalisiert "in Arbeit" ohne
   * falschen Fortschritts-Prozentsatz vorzutäuschen. */
  @keyframes scrape-indeterminate {
    0%   { transform: translateX(-100%) scaleX(0.4); }
    50%  { transform: translateX(0%)   scaleX(0.6); }
    100% { transform: translateX(100%) scaleX(0.4); }
  }
  .scrape__caption { font-size: 12px; color: var(--text-mute); margin: 0; }
  .scrape__error {
    font-size: 12px; color: var(--danger);
    background: var(--danger-soft); border: 1px solid var(--danger-border);
    border-radius: var(--r-md); padding: 8px 10px; margin: 0;
  }

  /* ===== Danger ===== */
  .danger-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 24px; }
  @media (max-width: 700px) { .danger-grid { grid-template-columns: minmax(0, 1fr); } }
  .db-reset { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .btn-danger {
    background: var(--surface-2); color: var(--danger);
    /* Danger-Identitaet schon im Ruhezustand ueber einen ZARTEN getoenten Rahmen
       (statt knallrotem Fill) — restraint. */
    border: 1px solid var(--danger-border); border-radius: var(--r-md);
    padding: 9px 14px; font-size: 13px; font-weight: 600;
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
  /* Confirm = solider Danger-Fill ("ein Klick vom Loeschen"). */
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
    padding: 9px 14px; font-size: 13px; font-weight: 500;
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
    gap: 14px; margin-top: 16px;
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
    border-radius: var(--r-md); padding: 10px 20px; font-size: 14px;
    font-weight: 600; letter-spacing: 0.02em; cursor: pointer;
    box-shadow: var(--shadow-sm);
    transition: transform var(--t-fast) var(--ease), opacity var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .btn-save:hover:not(:disabled) { background: var(--accent-hover); }
  }
  /* Press-down only (scale 0.98). Kein hover-Lift — der war marketing-haft und
     out-of-register fuer diese zurueckhaltende Produkt-Oberflaeche. */
  .btn-save:active:not(:disabled) { transform: scale(0.98); }
  .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (prefers-reduced-motion: reduce) {
    .toggle__track, .toggle__thumb, .mode-opt span, .day-chip,
    .btn-danger, .btn-cancel, .btn-save, .row input, .time-add, .time-remove,
    .card__chevron {
      transition: none;
    }
    .btn-save:active:not(:disabled) { transform: none; }
    .scrape__pill--running .scrape__dot::after,
    .scrape__bar-fill { animation: none; }
  }
</style>

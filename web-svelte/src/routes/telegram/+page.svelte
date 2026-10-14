<script lang="ts">
	import { onMount } from 'svelte';
	import { getSettings, updateSettings } from '#lib/api/endpoints.js';
	import type { SettingsPatch, SettingsView } from '#lib/api/types.js';
	import { pushToast } from '#lib/stores/toast.svelte.js';
	import { isApiHttpError } from '#lib/api/client.js';

	type TgState =
		| 'loading'
		| 'connected'
		| 'unconfigured'
		| 'token-only'
		| 'userid-only'
		| 'disabled';

	let view = $state<SettingsView | null>(null);
	let loading = $state<boolean>(true);
	let saving = $state<boolean>(false);
	let loadError = $state<string | null>(null);

	// Form state — mirrors view + buffered token field for editing.
	let enabled = $state<boolean>(false);
	let token = $state<string>(''); // empty = keep existing
	let userIdInput = $state<string>(''); // string for the input; empty -> null
	let showToken = $state<boolean>(false);

	const tokenIsSet = $derived<boolean>(view?.telegramTokenSet ?? false);
	const userIdSet = $derived<boolean>(view?.telegramAllowedUserId != null);

	const tgState = $derived<TgState>(
		loading
			? 'loading'
			: tokenIsSet && userIdSet && (view?.telegramEnabled ?? false)
				? 'connected'
				: tokenIsSet && !userIdSet
					? 'token-only'
					: !tokenIsSet && userIdSet
						? 'userid-only'
						: tokenIsSet && userIdSet && !(view?.telegramEnabled ?? false)
							? 'disabled'
							: 'unconfigured'
	);

	type StatusKind = 'success' | 'info' | 'warn';

	const STATUS_INFO: Record<TgState, { label: string; sub: string; kind: StatusKind }> = {
		loading: {
			label: 'Lade …',
			sub: 'Status wird abgefragt …',
			kind: 'info'
		},
		connected: {
			label: 'Verbunden',
			sub: 'Bot läuft. Neue Noten und Raumwechsel werden an Telegram gesendet.',
			kind: 'success'
		},
		unconfigured: {
			label: 'Nicht konfiguriert',
			sub: 'Token + User-ID eintragen, dann aktivieren.',
			kind: 'info'
		},
		'token-only': {
			label: 'Token gesetzt aber UserID fehlt',
			sub: 'Bot-Token ist gespeichert. User-ID ergänzen, um den Bot zu starten.',
			kind: 'warn'
		},
		'userid-only': {
			label: 'UserID gesetzt aber Token fehlt',
			sub: 'User-ID ist gespeichert. Bot-Token ergänzen, um zu verbinden.',
			kind: 'warn'
		},
		disabled: {
			label: 'Konfiguriert aber deaktiviert',
			sub: 'Bot-Daten sind hinterlegt, aktiviere ihn oben um Nachrichten zu senden.',
			kind: 'warn'
		}
	};

	const statusLabel = $derived(STATUS_INFO[tgState].label);
	const statusSub = $derived(STATUS_INFO[tgState].sub);
	const statusKind = $derived<StatusKind>(STATUS_INFO[tgState].kind);

	// Toggle ist nur aktivierbar, wenn Token UND User-ID vorhanden sind
	// (entweder schon gespeichert oder gerade im Form gesetzt).
	const hasToken = $derived(tokenIsSet || token.trim() !== '');
	const hasUserId = $derived(userIdSet || userIdInput.trim() !== '');
	const canEnableBot = $derived(hasToken && hasUserId);

	onMount(() => {
		void load();
	});

	async function load(): Promise<void> {
		loading = true;
		loadError = null;
		try {
			const v = await getSettings();
			view = v;
			enabled = v.telegramEnabled;
			userIdInput =
				v.telegramAllowedUserId != null ? String(v.telegramAllowedUserId) : '';
			// token field stays empty — never echo secrets back to the form.
			token = '';
		} catch (e) {
			loadError = errorMessage(e);
			pushToast('error', `Konnte Settings nicht laden: ${loadError}`);
		} finally {
			loading = false;
		}
	}

	function errorMessage(e: unknown): string {
		if (isApiHttpError(e)) {
			if (typeof e.body === 'object' && e.body && 'error' in e.body) {
				const msg = (e.body as { error?: unknown }).error;
				if (typeof msg === 'string') return msg;
			}
			return `HTTP ${e.status}`;
		}
		if (e instanceof Error) return e.message;
		return 'Unbekannter Fehler';
	}

	function parseUserId(): { ok: true; value: number | null } | { ok: false; msg: string } {
		const raw = userIdInput.trim();
		if (raw === '') return { ok: true, value: null };
		if (!/^\d+$/.test(raw)) {
			return { ok: false, msg: 'User-ID muss eine ganze Zahl sein' };
		}
		const n = Number(raw);
		if (!Number.isFinite(n) || n <= 0) {
			return { ok: false, msg: 'User-ID muss > 0 sein' };
		}
		return { ok: true, value: n };
	}

	function toggleShowToken(): void {
		showToken = !showToken;
	}

	function handleTokenWrapBlur(e: FocusEvent & { currentTarget: HTMLElement }): void {
		// focusout fires when focus leaves the wrap; relatedTarget = next focused
		// element. Stays open while user tabs between input and the eye button.
		const next = e.relatedTarget as Node | null;
		if (!next || !e.currentTarget.contains(next)) {
			showToken = false;
		}
	}

	function retryLoad(): void {
		void load();
	}

	async function save(event?: SubmitEvent): Promise<void> {
		event?.preventDefault();
		if (saving) return;

		const parsed = parseUserId();
		if (!parsed.ok) {
			pushToast('warn', parsed.msg);
			return;
		}

		const patch: SettingsPatch = {
			telegramEnabled: enabled,
			telegramAllowedUserId: parsed.value
		};
		const trimmedToken = token.trim();
		if (trimmedToken !== '') {
			patch.telegramToken = trimmedToken;
		}

		saving = true;
		try {
			const r = await updateSettings(patch);
			view = r.settings;
			enabled = r.settings.telegramEnabled;
			userIdInput =
				r.settings.telegramAllowedUserId != null
					? String(r.settings.telegramAllowedUserId)
					: '';
			token = '';
			showToken = false;

			if (r.botRestarted) {
				pushToast('success', 'Bot neu verbunden.');
			} else {
				pushToast('success', 'Telegram-Einstellungen gespeichert.');
			}
		} catch (e) {
			pushToast('error', `Speichern fehlgeschlagen: ${errorMessage(e)}`);
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>WISSen – Telegram-Bot</title>
</svelte:head>

<section class="route">
	<header class="route__head">
		<h1 class="route__title">Telegram-Bot</h1>
		<span class="route__subtitle mono">Push, ohne Browser zu öffnen</span>
	</header>

	<div class="status status--{statusKind}">
		<span class="status__dot" aria-hidden="true"></span>
		<div class="status__main">
			<div
				class="status__label"
				aria-live={tgState === 'loading' ? 'off' : 'polite'}
			>{statusLabel}</div>
			<div class="status__sub">{statusSub}</div>
		</div>
	</div>

	{#if loadError && !view}
		<div class="error">
			Fehler beim Laden: {loadError}
			<button type="button" class="btn btn--ghost btn--sm" onclick={retryLoad}>
				Erneut versuchen
			</button>
		</div>
	{/if}

	<div class="guide">
		<div class="guide__kicker">Setup</div>
		<ol class="guide__list">
			<li>
				<span class="guide__num">1</span>
				<span>
					Öffne Telegram → Suche
					<a class="guide__link" href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a>
					→ <code>/newbot</code> → Anweisungen folgen.
				</span>
			</li>
			<li>
				<span class="guide__num">2</span>
				<span>Bot-Token kopieren → unten im Token-Feld einfügen.</span>
			</li>
			<li>
				<span class="guide__num">3</span>
				<span>
					Eigene User-ID via
					<a class="guide__link" href="https://t.me/userinfobot" target="_blank" rel="noopener noreferrer">@userinfobot</a>
					rausfinden → einfügen.
				</span>
			</li>
			<li>
				<span class="guide__num">4</span>
				<span>Speichern → Status oben sollte "Verbunden" zeigen.</span>
			</li>
		</ol>
	</div>

	<form class="card" autocomplete="off" onsubmit={save}>
		<div class="toggle-row">
			<div class="toggle-row__main">
				<span class="toggle-row__title">Bot aktivieren</span>
				<span class="toggle-row__hint">
					{#if !canEnableBot && !loading}
						Token und User-ID erforderlich, bevor der Bot starten kann.
					{:else}
						Wenn aus, werden keine Telegram-Nachrichten gesendet (auch wenn Token gesetzt ist).
					{/if}
				</span>
			</div>
			<label class="toggle">
				<input
					type="checkbox"
					role="switch"
					aria-label="Bot aktivieren"
					bind:checked={enabled}
					disabled={loading || saving || !canEnableBot}
				/>
				<span class="toggle__track" aria-hidden="true"><span class="toggle__thumb"></span></span>
			</label>
		</div>

		<div class="field-grid">
			<div class="field field--full">
				<label for="tgToken">Bot-Token</label>
				<div
					class="input-wrap"
					onfocusout={handleTokenWrapBlur}
					role="presentation"
				>
					<input
						id="tgToken"
						type={showToken ? 'text' : 'password'}
						placeholder={tokenIsSet ? '••• gespeichert (leer lassen zum Behalten)' : '123456:ABC-DEF...'}
						autocomplete="off"
						spellcheck="false"
						data-1p-ignore
						data-lpignore="true"
						aria-describedby="tgTokenHint"
						disabled={loading || saving}
						bind:value={token}
					/>
					<button
						type="button"
						class="input-eye"
						aria-label={showToken ? 'Token verstecken' : 'Token zeigen'}
						onclick={toggleShowToken}
						disabled={loading || saving}
					>
						{showToken ? 'verbergen' : 'zeigen'}
					</button>
				</div>
				<p class="field__hint" id="tgTokenHint">
					Vom
					<a class="guide__link" href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a>.
					{tokenIsSet ? 'Bereits gespeichert. Leer lassen, um den aktuellen Wert zu behalten.' : 'Wird verschlüsselt im Server gespeichert.'}
				</p>
			</div>

			<div class="field field--full">
				<label for="tgUid">Erlaubte User-ID</label>
				<input
					id="tgUid"
					type="text"
					inputmode="numeric"
					pattern="[0-9]*"
					placeholder="123456789"
					autocomplete="off"
					disabled={loading || saving}
					bind:value={userIdInput}
				/>
				<p class="field__hint">Nur diese ID darf den Bot benutzen.</p>
			</div>
		</div>

		<div class="actions">
			<button
				type="submit"
				class="btn btn--primary"
				disabled={loading || saving}
			>
				{saving ? 'Speichere …' : 'Speichern'}
			</button>
		</div>
	</form>
</section>

<style>
	.route {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.route__head {
		display: flex;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
	}

	.route__title {
		margin: 0;
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
	}

	.route__subtitle {
		font-size: 12px;
		color: var(--text-dim);
		letter-spacing: 0.02em;
	}

	.status {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 14px 16px;
		background: var(--surface);
		border: 1px solid var(--border-soft);
		border-radius: var(--r-md);
	}

	.status__dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--text-dim);
	}

	.status--success .status__dot {
		background: var(--success);
		box-shadow: 0 0 0 4px var(--success-soft);
	}
	.status--warn .status__dot {
		background: var(--warning);
		box-shadow: 0 0 0 4px var(--warning-soft-strong);
	}
	.status--info .status__dot {
		background: var(--text-dim);
	}

	.status__main {
		flex: 1;
		min-width: 0;
	}

	.status__label {
		font-size: 14px;
		color: var(--text);
		font-weight: 500;
	}

	.status__sub {
		font-size: 12px;
		color: var(--text-mute);
		margin-top: 3px;
		line-height: 1.5;
	}

	.error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 14px;
		background: var(--danger-soft);
		border: 1px solid var(--danger-border);
		border-radius: var(--r-md);
		font-size: 13px;
		color: var(--danger);
	}

	.guide {
		background: var(--surface);
		border: 1px solid var(--border-soft);
		border-radius: var(--r-md);
		padding: 16px 18px;
	}

	.guide__kicker {
		font-size: 11px;
		color: var(--accent);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		font-weight: 600;
		margin-bottom: 10px;
	}

	.guide__list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.guide__list li {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		font-size: 13px;
		color: var(--text-mute);
		line-height: 1.55;
	}

	.guide__num {
		flex-shrink: 0;
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--accent-soft);
		border: 1px solid var(--accent-border);
		color: var(--accent);
		font-size: 11.5px;
		font-weight: 600;
		font-family: var(--font-mono);
		margin-top: 1px;
	}

	/* Bot-Username-Links (@BotFather, @userinfobot) — accent-color für die
	 * "Single-Voice"-Akzent-Regel, Underline mit dezentem offset für
	 * Linear/Raycast-Tool-Look (kein Web-1.0-Underline). Hover deepent die
	 * Underline durch border statt durch text-decoration-Wechsel — sonst
	 * springt das Layout um 1px wenn der Browser die Underline anders
	 * platziert. Auch in .field__hint nutzbar (gleiche Klasse). */
	.guide__link {
		color: var(--accent);
		font-weight: 600;
		text-decoration: underline;
		text-decoration-color: var(--accent-border);
		text-underline-offset: 2px;
		text-decoration-thickness: 1px;
		transition: text-decoration-color var(--t-fast) var(--ease);
	}
	@media (hover: hover) and (pointer: fine) {
		.guide__link:hover {
			text-decoration-color: var(--accent);
		}
	}

	.guide__list code {
		font-family: var(--font-mono);
		font-size: 11.5px;
		background: var(--surface-2);
		padding: 1px 6px;
		border-radius: 3px;
		color: var(--text);
	}

	.card {
		background: var(--surface);
		border: 1px solid var(--border-soft);
		border-radius: var(--r-md);
		padding: 16px 18px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		padding: 12px 14px;
		background: var(--surface-2);
		border: 1px solid var(--border-soft);
		border-radius: var(--r-md);
	}

	.toggle-row__main {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.toggle-row__title {
		font-size: 13px;
		color: var(--text);
		font-weight: 500;
	}

	.toggle-row__hint {
		font-size: 11.5px;
		color: var(--text-dim);
		line-height: 1.5;
	}

	.toggle {
		position: relative;
		display: inline-flex;
		align-items: center;
		cursor: pointer;
		flex-shrink: 0;
	}

	/* Visually-hidden but still focusable + clickable so the native checkbox
	   drives semantics (role/checked/disabled). The visual track sits next
	   to it and reflects state via :checked + :focus-visible. */
	.toggle input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		margin: 0;
		cursor: pointer;
	}

	.toggle__track {
		width: 36px;
		height: 20px;
		background: var(--surface-3);
		border: 1px solid var(--border);
		border-radius: 999px;
		position: relative;
		transition:
			background var(--t-fast) var(--ease),
			border-color var(--t-fast) var(--ease);
	}

	.toggle__thumb {
		position: absolute;
		top: 1px;
		left: 1px;
		width: 16px;
		height: 16px;
		background: var(--text-mute);
		border-radius: 50%;
	}

	@media (prefers-reduced-motion: no-preference) {
		.toggle__thumb {
			transition:
				transform var(--t-fast) var(--ease),
				background var(--t-fast) var(--ease);
		}
	}

	.toggle input:checked + .toggle__track {
		background: var(--accent-soft);
		border-color: var(--accent-border);
	}

	.toggle input:checked + .toggle__track .toggle__thumb {
		background: var(--accent);
		transform: translateX(16px);
	}

	.toggle input:focus-visible + .toggle__track {
		box-shadow: 0 0 0 3px var(--accent-soft);
		border-color: var(--accent);
	}

	.toggle input:disabled {
		cursor: not-allowed;
	}

	.toggle input:disabled + .toggle__track {
		opacity: 0.55;
	}

	.field-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 14px;
	}

	@media (max-width: 720px) {
		.field-grid {
			grid-template-columns: 1fr;
		}
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.field--full {
		grid-column: 1 / -1;
	}

	.field label {
		font-size: 12px;
		color: var(--text-mute);
		font-weight: 500;
	}

	.field input[type='text'],
	.field input[type='password'] {
		width: 100%;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		padding: 9px 12px;
		color: var(--text);
		font: inherit;
		font-size: 13.5px;
		transition:
			border-color var(--t-fast) var(--ease),
			background var(--t-fast) var(--ease);
		color-scheme: dark;
	}

	.field input:focus-visible {
		outline: none;
		border-color: var(--accent);
		background: var(--surface);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}

	.field input::placeholder {
		color: var(--text-dim);
	}

	.field input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.field__hint {
		color: var(--text-dim);
		font-size: 11.5px;
		margin: 0;
		line-height: 1.5;
	}

	.input-wrap {
		position: relative;
		display: flex;
		align-items: stretch;
	}

	.input-wrap input {
		flex: 1;
		padding-right: 86px;
	}

	.input-eye {
		position: absolute;
		right: 4px;
		top: 4px;
		bottom: 4px;
		padding: 0 10px;
		background: var(--surface-3);
		border: 1px solid var(--border-soft);
		border-radius: var(--r-sm);
		color: var(--text-mute);
		font-size: 11.5px;
		font-family: var(--font-mono);
		cursor: pointer;
		transition:
			background var(--t-fast) var(--ease),
			color var(--t-fast) var(--ease);
	}

	@media (hover: hover) and (pointer: fine) {
		.input-eye:hover:not(:disabled) {
			background: var(--surface);
			color: var(--text);
		}
	}

	.input-eye:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-soft);
		color: var(--text);
	}

	.input-eye:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding-top: 14px;
		border-top: 1px solid var(--border-soft);
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 8px 16px;
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		border: 1px solid transparent;
		border-radius: var(--r-md);
		cursor: pointer;
		transition:
			background var(--t-fast) var(--ease),
			border-color var(--t-fast) var(--ease),
			color var(--t-fast) var(--ease);
	}

	@media (prefers-reduced-motion: no-preference) {
		.btn {
			transition:
				background var(--t-fast) var(--ease),
				border-color var(--t-fast) var(--ease),
				color var(--t-fast) var(--ease),
				transform var(--t-fast) var(--ease);
		}
		.btn:active:not(:disabled) {
			transform: scale(0.97);
		}
	}

	.btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px var(--accent-soft);
		border-color: var(--accent);
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.btn--primary {
		background: var(--accent);
		color: var(--accent-ink);
		border-color: var(--accent);
		font-weight: 600;
	}

	@media (hover: hover) and (pointer: fine) {
		.btn--primary:hover:not(:disabled) {
			filter: brightness(1.06);
		}
	}

	.btn--ghost {
		background: var(--surface-2);
		color: var(--text-mute);
		border-color: var(--border-soft);
	}

	@media (hover: hover) and (pointer: fine) {
		.btn--ghost:hover:not(:disabled) {
			background: var(--surface-3);
			color: var(--text);
			border-color: var(--border);
		}
	}

	.btn--sm {
		padding: 4px 10px;
		font-size: 12px;
	}
</style>

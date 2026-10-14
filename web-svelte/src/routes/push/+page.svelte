<script lang="ts">
	import { onMount } from 'svelte';
	import {
		getVapidKey,
		registerPush,
		unregisterPush,
		sendTestPush
	} from '#lib/api/endpoints.js';
	import { pushToast } from '#lib/stores/toast.svelte.js';

	type PushState =
		| 'unsupported'
		| 'denied'
		| 'subscribed'
		| 'unsubscribed'
		| 'loading';

	let supported = $state<boolean>(false);
	let permission = $state<NotificationPermission | 'unsupported'>('default');
	let subscribed = $state<boolean>(false);
	let busy = $state<boolean>(false);
	let initialized = $state<boolean>(false);
	let endpointPrefix = $state<string | null>(null);
	let swScope = $state<string | null>(null);
	let userAgentShort = $state<string>('');
	let lastTest = $state<{ at: number; sent: number } | null>(null);
	let nowTick = $state<number>(Date.now());

	const endpointDisplay = $derived<string>(
		endpointPrefix
			? endpointPrefix.length > 40
				? endpointPrefix.slice(0, 40) + '…'
				: endpointPrefix
			: '—'
	);

	const lastTestAgo = $derived.by<string>(() => {
		if (!lastTest) return '—';
		const secs = Math.max(0, Math.round((nowTick - lastTest.at) / 1000));
		if (secs < 60) return `vor ${secs}s`;
		const mins = Math.floor(secs / 60);
		if (mins < 60) return `vor ${mins}m`;
		const hrs = Math.floor(mins / 60);
		return `vor ${hrs}h`;
	});

	const pushState = $derived<PushState>(
		!initialized
			? 'loading'
			: !supported
				? 'unsupported'
				: permission === 'denied'
					? 'denied'
					: subscribed
						? 'subscribed'
						: 'unsubscribed'
	);

	const statusLabel = $derived(
		pushState === 'subscribed'
			? 'Aktiviert'
			: pushState === 'unsupported'
				? 'Nicht unterstützt'
				: pushState === 'denied'
					? 'Berechtigung verweigert'
					: pushState === 'loading'
						? 'Lade …'
						: 'Deaktiviert'
	);

	const statusSub = $derived(
		pushState === 'subscribed'
			? 'Push-Benachrichtigungen sind aktiv. Test mit dem Button rechts.'
			: pushState === 'unsupported'
				? 'Dein Browser unterstützt keine Web-Push-API. iOS Safari nur als installierte PWA.'
				: pushState === 'denied'
					? 'Push wurde im Browser blockiert. In den Site-Settings wieder erlauben.'
					: pushState === 'loading'
						? 'Status wird abgefragt …'
						: 'Klicke auf Aktivieren, um Notes-Updates und Raumwechsel direkt zu erhalten.'
	);

	const statusKind = $derived<'success' | 'info' | 'warn' | 'danger'>(
		pushState === 'subscribed'
			? 'success'
			: pushState === 'unsupported'
				? 'warn'
				: pushState === 'denied'
					? 'danger'
					: 'info'
	);

	const canSubscribe = $derived(
		pushState === 'unsubscribed' && !busy
	);
	const canManage = $derived(pushState === 'subscribed' && !busy);

	onMount(() => {
		if (typeof navigator !== 'undefined') {
			const ua = navigator.userAgent || '';
			userAgentShort = ua.length > 90 ? ua.slice(0, 90) + '…' : ua;
		}
		void detectState();
		// Tick once per second so "vor Xs" updates while the user looks at it.
		const id = window.setInterval(() => {
			nowTick = Date.now();
		}, 1000);
		return () => {
			window.clearInterval(id);
		};
	});

	async function detectState(): Promise<void> {
		const isSupported =
			typeof window !== 'undefined' &&
			'serviceWorker' in navigator &&
			'PushManager' in window &&
			'Notification' in window;
		if (!isSupported) {
			// Single batched commit for the unsupported branch.
			supported = false;
			permission = 'unsupported';
			initialized = true;
			return;
		}
		// Resolve async state first, then commit once at the end so we get one
		// reactive render instead of toggling supported -> permission -> subscribed -> initialized.
		const nextPermission = Notification.permission;
		let nextSubscribed = false;
		let nextEndpoint: string | null = null;
		let nextScope: string | null = null;
		try {
			const reg = await navigator.serviceWorker.getRegistration();
			if (reg) {
				nextScope = reg.scope ?? null;
				const sub = await reg.pushManager.getSubscription();
				nextSubscribed = !!sub;
				if (sub) nextEndpoint = sub.endpoint;
			}
		} catch {
			nextSubscribed = false;
		}
		supported = true;
		permission = nextPermission;
		subscribed = nextSubscribed;
		endpointPrefix = nextEndpoint;
		swScope = nextScope;
		initialized = true;
	}

	function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
		const padding = '='.repeat((4 - (base64.length % 4)) % 4);
		const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
		const raw = atob(b64);
		// Allocate a fresh ArrayBuffer-backed view; no extra .slice() copy needed.
		const buf = new ArrayBuffer(raw.length);
		const out = new Uint8Array(buf);
		for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
		return out;
	}

	function errorMessage(e: unknown): string {
		if (e instanceof Error) return e.message;
		return 'Unbekannter Fehler';
	}

	async function subscribe(): Promise<void> {
		if (busy || !supported) return;
		busy = true;
		try {
			const perm = await Notification.requestPermission();
			if (perm !== 'granted') {
				// Commit permission once on the rejection path.
				permission = perm;
				pushToast('warn', 'Berechtigung verweigert');
				return;
			}
			const reg = await navigator.serviceWorker.ready;
			const { publicKey } = await getVapidKey();
			const sub = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(publicKey)
			});
			await registerPush(sub.toJSON());
			// Single batched commit so we don't render once for permission and again for subscribed.
			permission = perm;
			subscribed = true;
			endpointPrefix = sub.endpoint;
			swScope = reg.scope ?? swScope;
			pushToast('success', '✓ Push aktiviert');
		} catch (e) {
			pushToast('error', `Fehler: ${errorMessage(e)}`);
		} finally {
			busy = false;
		}
	}

	async function unsubscribe(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const reg = await navigator.serviceWorker.ready;
			const sub = await reg.pushManager.getSubscription();
			if (sub) {
				try {
					await unregisterPush(sub.endpoint);
				} catch {
					/* server might already be gone; still unsubscribe locally */
				}
				await sub.unsubscribe();
			}
			subscribed = false;
			endpointPrefix = null;
			pushToast('info', 'Push deaktiviert');
		} catch (e) {
			pushToast('error', `Fehler: ${errorMessage(e)}`);
		} finally {
			busy = false;
		}
	}

	async function testPush(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const r = await sendTestPush();
			lastTest = { at: Date.now(), sent: r.sent };
			if (r.sent === 0) {
				pushToast('warn', 'Test gesendet, aber kein aktiver Empfänger.');
			} else {
				pushToast('success', `Test-Push gesendet (${r.sent}).`);
			}
		} catch (e) {
			pushToast('error', `Fehler: ${errorMessage(e)}`);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>WISSen – Web Push</title>
</svelte:head>

<section class="route">
	<header class="route__head">
		<h1 class="route__title">Web Push</h1>
		<span class="route__subtitle mono">Browser-Benachrichtigungen</span>
	</header>

	<div class="status status--{statusKind}">
		<span class="status__dot" aria-hidden="true"></span>
		<div class="status__main" role="status" aria-live="polite">
			<div class="status__label">{statusLabel}</div>
			<div class="status__sub">{statusSub}</div>
		</div>
		<div class="status__actions">
			{#if canSubscribe}
				<button
					type="button"
					class="btn btn--primary"
					disabled={busy}
					aria-busy={busy}
					onclick={subscribe}
				>
					{busy ? 'Aktiviere …' : 'Aktivieren'}
				</button>
			{/if}
			{#if canManage}
				<button
					type="button"
					class="btn btn--ghost"
					disabled={busy}
					aria-busy={busy}
					onclick={testPush}
				>
					Test-Push senden
				</button>
				<button
					type="button"
					class="btn btn--ghost btn--danger"
					disabled={busy}
					aria-busy={busy}
					onclick={unsubscribe}
				>
					Deaktivieren
				</button>
			{/if}
		</div>
	</div>

	{#if pushState === 'denied'}
		<div class="recover" role="note">
			<div class="recover__title">Erlaubnis blockiert</div>
			<p class="recover__text">
				Push-Benachrichtigungen wurden für diese Seite verweigert. Aktivieren geht
				erst wieder, wenn die Berechtigung in den Browser-Einstellungen freigegeben
				ist.
			</p>
			<ul class="recover__steps">
				<li>
					<strong>Chrome / Edge / Brave:</strong> Klick aufs Schloss-Symbol links in
					der Adresszeile → „Mitteilungen“ → „Zulassen“.
				</li>
				<li>
					<strong>Firefox:</strong> Schloss-Symbol → „Berechtigungen“ → „Mitteilungen
					empfangen“ aktivieren.
				</li>
				<li>
					<strong>Safari (macOS):</strong> Safari → Einstellungen → Websites →
					Mitteilungen → diese Site auf „Erlauben“ stellen.
				</li>
				<li>
					<strong>Safari (iOS):</strong> Nur als zum Home-Bildschirm hinzugefügte PWA
					möglich. Dort: Einstellungen → Mitteilungen → WISSen → erlauben.
				</li>
			</ul>
			<p class="recover__hint">
				Nach der Freigabe diese Seite neu laden, dann erscheint „Aktivieren“ wieder.
			</p>
		</div>
	{/if}

	<div class="help">
		<div class="help__kicker">Wann nützlich</div>
		<p class="help__text">
			Push-Benachrichtigungen kommen wenn neue Noten reinkommen oder ein Raumwechsel
			passiert. Funktioniert nur wenn der Browser die App auch im Hintergrund hält
			(PWA installiert empfohlen).
		</p>
		<ul class="help__bullets">
			<li>iOS: Funktioniert nur als zum Home-Bildschirm hinzugefügte PWA.</li>
			<li>Subscription läuft pro Gerät. Auf jedem Browser einmal aktivieren.</li>
			<li>Bei Konflikten: Deaktivieren und neu aktivieren.</li>
		</ul>
	</div>

	<details class="diag mono">
		<summary class="diag__summary">Diagnose</summary>
		<dl class="diag__list">
			<dt>permission</dt>
			<dd>{permission}</dd>
			<dt>subscribed</dt>
			<dd>{subscribed ? 'true' : 'false'}</dd>
			<dt>endpoint</dt>
			<dd>{endpointDisplay}</dd>
			<dt>sw-scope</dt>
			<dd>{swScope ?? '—'}</dd>
			<dt>userAgent</dt>
			<dd class="diag__ua">{userAgentShort || '—'}</dd>
			<dt>letzter test</dt>
			<dd>
				{#if lastTest}
					{lastTestAgo}, sent={lastTest.sent}
				{:else}
					—
				{/if}
			</dd>
		</dl>
	</details>
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
	.status--info .status__dot {
		background: var(--text-dim);
	}
	.status--warn .status__dot {
		background: var(--warning);
		box-shadow: 0 0 0 4px var(--warning-soft-strong);
	}
	.status--danger .status__dot {
		background: var(--danger);
		box-shadow: 0 0 0 4px var(--danger-soft-strong);
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

	.status__actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 40px;
		padding: 7px 14px;
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		border: 1px solid transparent;
		border-radius: var(--r-md);
		cursor: pointer;
		transition:
			background var(--t-fast) var(--ease),
			border-color var(--t-fast) var(--ease),
			color var(--t-fast) var(--ease),
			transform var(--t-fast) var(--ease);
	}
	.btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.btn:active:not(:disabled) {
		transform: scale(0.97);
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

	.btn--ghost {
		background: var(--surface-2);
		color: var(--text-mute);
		border-color: var(--border-soft);
	}

	@media (hover: hover) and (pointer: fine) {
		.btn--primary:hover:not(:disabled) {
			filter: brightness(1.06);
		}
		.btn--ghost:hover:not(:disabled) {
			background: var(--surface-3);
			color: var(--text);
			border-color: var(--border);
		}
		.btn--danger:hover:not(:disabled) {
			color: var(--danger);
			border-color: var(--danger);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.btn {
			transition: none;
		}
		.btn:active:not(:disabled) {
			transform: none;
		}
	}

	.help {
		background: var(--surface);
		border: 1px solid var(--border-soft);
		border-radius: var(--r-md);
		padding: 16px 18px;
	}

	.help__kicker {
		font-size: 11px;
		color: var(--accent);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		margin-bottom: 8px;
		font-weight: 600;
	}

	.help__text {
		margin: 0 0 10px;
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-mute);
	}

	.help__bullets {
		margin: 8px 0 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.help__bullets li {
		font-size: 12.5px;
		color: var(--text-dim);
		line-height: 1.55;
		padding-left: 14px;
		position: relative;
	}

	.help__bullets li::before {
		content: '';
		position: absolute;
		left: 0;
		top: 8px;
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--text-dim);
	}

	.recover {
		background: var(--surface);
		border: 1px solid var(--danger-soft-strong, var(--border-soft));
		border-left: 3px solid var(--danger);
		border-radius: var(--r-md);
		padding: 14px 16px;
	}

	.recover__title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		margin-bottom: 6px;
	}

	.recover__text {
		margin: 0 0 10px;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-mute);
	}

	.recover__steps {
		margin: 0 0 10px;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.recover__steps li {
		font-size: 12.5px;
		color: var(--text-dim);
		line-height: 1.55;
		padding-left: 14px;
		position: relative;
	}

	.recover__steps li::before {
		content: '';
		position: absolute;
		left: 0;
		top: 8px;
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--text-dim);
	}

	.recover__steps strong {
		color: var(--text);
		font-weight: 600;
	}

	.recover__hint {
		margin: 0;
		font-size: 12px;
		color: var(--text-dim);
		font-style: italic;
	}

	.diag {
		background: var(--surface);
		border: 1px solid var(--border-soft);
		border-radius: var(--r-md);
		padding: 0;
		font-size: 12px;
		color: var(--text-mute);
	}

	.diag__summary {
		cursor: pointer;
		padding: 10px 14px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--text-dim);
		font-weight: 600;
		user-select: none;
		list-style: none;
	}

	.diag__summary::-webkit-details-marker {
		display: none;
	}

	.diag__summary::before {
		content: '▸ ';
		display: inline-block;
		transition: transform var(--t-fast) var(--ease);
		color: var(--text-dim);
	}

	.diag[open] .diag__summary::before {
		transform: rotate(90deg);
	}

	.diag__summary:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		border-radius: var(--r-md);
	}

	.diag__list {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 14px;
		margin: 0;
		padding: 4px 14px 14px;
	}

	.diag__list dt {
		color: var(--text-dim);
		text-transform: lowercase;
		letter-spacing: 0.02em;
	}

	.diag__list dd {
		margin: 0;
		color: var(--text);
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.diag__ua {
		font-size: 11.5px;
		color: var(--text-mute);
	}

	@media (prefers-reduced-motion: reduce) {
		.diag__summary::before {
			transition: none;
		}
	}

	@media (max-width: 640px) {
		.status {
			flex-wrap: wrap;
		}
		.status__actions {
			width: 100%;
			justify-content: flex-start;
		}
		.btn {
			min-height: 44px;
		}
		.diag__list {
			grid-template-columns: 1fr;
			gap: 2px 0;
		}
		.diag__list dt {
			margin-top: 6px;
		}
	}
</style>

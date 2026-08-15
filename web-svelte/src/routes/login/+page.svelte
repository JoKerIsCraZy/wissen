<script lang="ts">
	import { clearToken, setToken } from '$lib/auth';

	// Wer den Login-Screen sieht, ist per Definition abgemeldet. Ein hier noch
	// vorhandener Token wäre eine gültige Sitzung, die nur nicht angezeigt wird
	// — genau der Zustand, der "Abmelden" wirkungslos gemacht hat. Deshalb wird
	// beim Betreten der Seite bedingungslos aufgeräumt, unabhängig davon, über
	// welchen Weg der Nutzer hergekommen ist (Logout-Button, Direktaufruf,
	// Redirect vom Layout-Guard).
	clearToken();

	let token = $state('');
	let error = $state<string | null>(null);
	let loading = $state(false);

	// Memoized so the submit-button's disabled state only re-evaluates when
	// the input actually changes (vs. recomputing trim() per render pass).
	const trimmedToken = $derived(token.trim());
	const canSubmit = $derived(!loading && trimmedToken.length > 0);

	async function attemptLogin(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const candidate = trimmedToken;
		if (!candidate) {
			error = 'Bitte Token eingeben.';
			return;
		}
		if (loading) return;

		loading = true;
		error = null;
		try {
			const res = await fetch('/api/status', {
				credentials: 'same-origin',
				headers: { Authorization: `Bearer ${candidate}` }
			});
			if (res.status === 401) {
				error = 'Token ungültig — prüfe deinen API-Token (data/.api-token auf dem Server).';
				return;
			}
			if (res.status === 429) {
				const retryAfter = res.headers.get('Retry-After');
				const wait = retryAfter ? ` Erneut versuchen in ${retryAfter}s.` : '';
				error = `Zu viele Anmeldeversuche.${wait}`;
				return;
			}
			if (!res.ok) {
				error = `Server-Fehler (${res.status}) — bitte später erneut versuchen.`;
				return;
			}
			setToken(candidate);
			// Defer the SvelteKit navigation runtime (`goto` + `base`) off the
			// initial login bundle — they are only needed AFTER a successful
			// auth round-trip, so they have no business in the cold-load path.
			// `base` resolves to "/v2" in this project (or "" in dev).
			const [{ goto }, { base }] = await Promise.all([
				import('$app/navigation'),
				import('$app/paths')
			]);
			await goto(`${base}/`);
		} catch {
			error = 'Server nicht erreichbar — prüfe Netzwerk oder Server-Status.';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>WISSen – Anmelden</title>
</svelte:head>

<form class="login-card" onsubmit={attemptLogin}>
	<div class="login-card__brand">
		<span class="login-card__mark" aria-hidden="true">W</span>
		<h1 class="login-card__title">WISSen</h1>
	</div>
	<p class="login-card__lead">Authentifizierung erforderlich</p>

	<div class="field">
		<label class="field__label" for="login-token">API-Token</label>
		<input
			id="login-token"
			name="token"
			type="password"
			class="field__input"
			autocomplete="current-password"
			spellcheck="false"
			required
			disabled={loading}
			placeholder="Bearer token from data/.api-token"
			bind:value={token}
		/>
		<small class="field__hint">
			Token findest du in <code>data/.api-token</code> oder in den Server-Logs beim Start.
		</small>
	</div>

	<p class="login-card__error" aria-live="polite" data-empty={error === null ? 'true' : 'false'}>
		{error ?? ''}
	</p>

	<button type="submit" class="btn btn--primary" disabled={!canSubmit}>
		{loading ? 'Prüfe…' : 'Anmelden'}
	</button>
</form>

<style>
	.login-card {
		width: 100%;
		max-width: 420px;
		display: flex;
		flex-direction: column;
		gap: 16px;

		background: var(--surface);
		border: 1px solid var(--border-soft);
		border-radius: var(--r-lg);
		padding: 28px 28px 24px;
		box-shadow: var(--shadow-md);
	}

	.login-card__brand {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.login-card__mark {
		display: inline-grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: var(--r-md);
		background: var(--accent);
		color: var(--accent-ink);
		font-weight: 700;
		font-size: 18px;
		letter-spacing: -0.02em;
	}

	.login-card__title {
		margin: 0;
		font-size: 20px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
	}

	.login-card__lead {
		margin: 0;
		color: var(--text-mute);
		font-size: 14px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.field__label {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-mute);
	}

	.field__input {
		width: 100%;
		padding: 10px 12px;
		font: inherit;
		font-size: 14px;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		outline: none;
		transition:
			border-color var(--t) var(--ease),
			background-color var(--t) var(--ease),
			box-shadow var(--t) var(--ease);
	}

	.field__input::placeholder {
		color: var(--text-dim);
	}

	@media (hover: hover) and (pointer: fine) {
		.field__input:hover:not(:disabled) {
			background: var(--surface-3);
		}
	}

	.field__input:focus-visible {
		border-color: var(--accent);
		background: var(--surface-2);
		box-shadow: 0 0 0 3px var(--accent-soft-strong);
	}

	.field__input:disabled {
		color: var(--text-dim);
		background: var(--surface-2);
		border-color: var(--border-soft);
		cursor: not-allowed;
	}

	.field__input:disabled::placeholder {
		color: var(--text-dim);
	}

	.field__hint {
		font-size: 12px;
		color: var(--text-dim);
	}

	.field__hint code {
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--text-mute);
	}

	.login-card__error {
		margin: 0;
		padding: 8px 12px;
		font-size: 13px;
		color: var(--danger);
		background: var(--danger-soft);
		border: 1px solid var(--danger-border);
		border-radius: var(--r-md);
	}

	.login-card__error[data-empty='true'] {
		display: none;
	}

	.btn {
		appearance: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		padding: 10px 14px;
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.005em;
		border: 1px solid transparent;
		border-radius: var(--r-md);
		cursor: pointer;
		transition:
			background-color var(--t-fast) var(--ease),
			border-color var(--t-fast) var(--ease),
			color var(--t-fast) var(--ease),
			transform var(--t-fast) var(--ease);
	}

	.btn--primary {
		background: var(--accent);
		color: var(--accent-ink);
		border-color: var(--accent);
	}

	@media (hover: hover) and (pointer: fine) {
		.btn--primary:hover:not(:disabled) {
			background: var(--accent-hover);
			border-color: var(--accent-hover);
		}
	}

	.btn--primary:active:not(:disabled) {
		transform: translateY(1px);
	}

	.btn--primary:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.btn:disabled {
		color: var(--text-dim);
		background: var(--surface-2);
		border-color: var(--border-soft);
		cursor: not-allowed;
	}

	@media (prefers-reduced-motion: reduce) {
		.field__input,
		.btn--primary {
			transition: none;
		}
		.btn--primary:active:not(:disabled) {
			transform: none;
		}
	}
</style>

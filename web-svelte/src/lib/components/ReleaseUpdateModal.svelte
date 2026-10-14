<!--
  ReleaseUpdateModal — Update-Available Hinweis-Modal

  Pollt /api/version beim Mount. Wenn updateAvailable === true UND der
  jeweilige Release-Tag nicht schon einmal dismissed wurde (localStorage),
  zeigt das Modal:
    - Aktuelle vs. neue Version
    - Release-Name + (optional) Body-Excerpt
    - Action: "Auf GitHub ansehen" (external link)
    - Action: "Schliessen" → markiert Tag als dismissed → kein Re-Show

  Max 1× pro Release-Tag — sobald der Server eine NEUE Version meldet
  (= neuerer Tag) wird das Modal wieder gezeigt.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { getVersion, type VersionResponse } from '#lib/api/endpoints.js';

	let data = $state<VersionResponse | null>(null);
	let visible = $state(false);
	let dismissing = $state(false);

	const STORAGE_KEY = 'wissen.dismissedReleaseTag';

	function getDismissedTag(): string | null {
		try {
			return localStorage.getItem(STORAGE_KEY);
		} catch {
			return null;
		}
	}

	function setDismissedTag(tag: string) {
		try {
			localStorage.setItem(STORAGE_KEY, tag);
		} catch {
			/* localStorage off / quota — show again next time, acceptable */
		}
	}

	function close() {
		if (!data?.upstream?.tag) return;
		dismissing = true;
		setDismissedTag(data.upstream.tag);
		// kurze Exit-Animation matched dem CSS-Transition (220ms)
		setTimeout(() => {
			visible = false;
			dismissing = false;
		}, 220);
	}

	function onBackdropClick(ev: MouseEvent) {
		if (ev.target === ev.currentTarget) close();
	}

	function onKey(ev: KeyboardEvent) {
		if (ev.key === 'Escape') close();
	}

	onMount(async () => {
		try {
			const v = await getVersion();
			if (!v.updateAvailable || !v.upstream?.tag) return;
			if (getDismissedTag() === v.upstream.tag) return;
			data = v;
			// Nächster Frame: visible auf true für ein-frame-CSS-Animation
			requestAnimationFrame(() => {
				visible = true;
			});
		} catch {
			/* silent — kein Modal bei API-Fehler */
		}
	});

	function formatPublished(iso: string | null): string {
		if (!iso) return '';
		try {
			return new Date(iso).toLocaleDateString('de-CH', {
				day: '2-digit',
				month: '2-digit',
				year: 'numeric'
			});
		} catch {
			return '';
		}
	}
</script>

<svelte:window onkeydown={onKey} />

{#if data?.upstream && visible}
	<div
		class="release-modal-backdrop"
		class:is-closing={dismissing}
		onclick={onBackdropClick}
		role="presentation"
	>
		<div
			class="release-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="release-modal-title"
		>
			<header class="release-modal__head">
				<div class="release-modal__icon" aria-hidden="true">
					<svg
						viewBox="0 0 24 24"
						width="22"
						height="22"
						fill="none"
						stroke="currentColor"
						stroke-width="2.2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
				</div>
				<h2 id="release-modal-title" class="release-modal__title">
					Neue Version verfügbar
				</h2>
				<button
					type="button"
					class="release-modal__close"
					aria-label="Schliessen"
					onclick={close}
				>
					<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</header>

			<div class="release-modal__body">
				<div class="release-modal__versions">
					<div class="release-modal__version-row">
						<span class="release-modal__label">Installiert</span>
						<strong class="release-modal__value">v{data.version}</strong>
					</div>
					<div class="release-modal__version-row release-modal__version-row--new">
						<span class="release-modal__label">Neueste</span>
						<strong class="release-modal__value">{data.upstream.tag}</strong>
					</div>
				</div>

				{#if data.upstream.name && data.upstream.name !== data.upstream.tag}
					<p class="release-modal__release-name">
						{data.upstream.name}
					</p>
				{/if}

				{#if data.upstream.publishedAt}
					<p class="release-modal__published">
						Veröffentlicht am {formatPublished(data.upstream.publishedAt)}
					</p>
				{/if}

				{#if data.upstream.bodyHtml || data.upstream.body}
					<div class="release-modal__notes">
						<div class="release-modal__notes-label">Release-Notes</div>
						{#if data.upstream.bodyHtml}
							<!-- bodyHtml ist serverseitig via marked schon gerendert.
							     Source = unser eigenes GitHub-Repo (trusted). -->
							<div class="release-modal__notes-body release-modal__notes-body--rendered">
								{@html data.upstream.bodyHtml}
							</div>
						{:else}
							<pre class="release-modal__notes-body release-modal__notes-body--raw">{data.upstream.body}</pre>
						{/if}
					</div>
				{/if}
			</div>

			<footer class="release-modal__foot">
				<a
					class="release-modal__btn release-modal__btn--primary"
					href={data.upstream.url}
					target="_blank"
					rel="noopener noreferrer"
				>
					Auf GitHub ansehen
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-left: 4px;">
						<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
						<polyline points="15 3 21 3 21 9" />
						<line x1="10" y1="14" x2="21" y2="3" />
					</svg>
				</a>
				<button
					type="button"
					class="release-modal__btn release-modal__btn--ghost"
					onclick={close}
				>
					Später
				</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.release-modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 300;
		background: rgba(0, 0, 0, 0.55);
		display: grid;
		place-items: center;
		padding: 20px;
		animation: backdrop-in 200ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	.release-modal-backdrop.is-closing {
		animation: backdrop-out 220ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
		pointer-events: none;
	}

	.release-modal {
		width: min(480px, 100%);
		max-height: 80vh;
		display: flex;
		flex-direction: column;
		background: linear-gradient(180deg, var(--surface), var(--surface-2));
		border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
		border-radius: 16px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
		overflow: hidden;
		animation: modal-in 280ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	.is-closing .release-modal {
		animation: modal-out 220ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
	}

	.release-modal__head {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 12px;
		padding: 16px 16px 12px;
		border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.06));
	}
	.release-modal__icon {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: color-mix(in oklab, var(--accent, #6ea8fe) 18%, transparent);
		color: var(--accent, #6ea8fe);
	}
	.release-modal__title {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--text, #e7ebf3);
		letter-spacing: -0.01em;
	}
	.release-modal__close {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border-radius: 999px;
		color: var(--text-mute, #9aa3b5);
		background: transparent;
		border: 0;
		cursor: pointer;
		transition: background 150ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	.release-modal__close:hover {
		background: var(--surface-3, #262b36);
		color: var(--text, #e7ebf3);
	}

	.release-modal__body {
		padding: 16px;
		overflow-y: auto;
		flex: 1 1 auto;
		min-height: 0;
	}

	.release-modal__versions {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 14px;
		background: var(--surface-2, #20242d);
		border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
		border-radius: 10px;
	}
	.release-modal__version-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: 13px;
	}
	.release-modal__label {
		color: var(--text-mute, #9aa3b5);
	}
	.release-modal__value {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 600;
		color: var(--text, #e7ebf3);
	}
	.release-modal__version-row--new .release-modal__value {
		color: var(--accent, #6ea8fe);
	}

	.release-modal__release-name {
		margin: 16px 0 4px;
		font-size: 14px;
		font-weight: 600;
		color: var(--text, #e7ebf3);
	}
	.release-modal__published {
		margin: 0 0 12px;
		font-size: 12px;
		color: var(--text-mute, #9aa3b5);
	}

	.release-modal__notes {
		margin-top: 16px;
	}
	.release-modal__notes-label {
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-mute, #9aa3b5);
		margin-bottom: 6px;
		font-weight: 700;
	}
	.release-modal__notes-body {
		font-size: 13px;
		line-height: 1.55;
		color: var(--text, #e7ebf3);
		background: var(--surface-3, #262b36);
		padding: 12px 14px;
		border-radius: 8px;
		max-height: 240px;
		overflow-y: auto;
		word-break: break-word;
		margin: 0;
	}
	.release-modal__notes-body--raw {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
		white-space: pre-wrap;
	}
	/* Rendered Markdown (marked output) — typografisch sauber. */
	.release-modal__notes-body--rendered :global(> :first-child) { margin-top: 0; }
	.release-modal__notes-body--rendered :global(> :last-child)  { margin-bottom: 0; }
	.release-modal__notes-body--rendered :global(h1),
	.release-modal__notes-body--rendered :global(h2),
	.release-modal__notes-body--rendered :global(h3),
	.release-modal__notes-body--rendered :global(h4) {
		margin: 14px 0 6px;
		line-height: 1.25;
		color: var(--text, #e7ebf3);
		font-weight: 700;
	}
	.release-modal__notes-body--rendered :global(h1) { font-size: 16px; }
	.release-modal__notes-body--rendered :global(h2) { font-size: 15px; }
	.release-modal__notes-body--rendered :global(h3) { font-size: 14px; }
	.release-modal__notes-body--rendered :global(h4) {
		font-size: 13px;
		color: var(--text-mute, #9aa3b5);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.release-modal__notes-body--rendered :global(p) { margin: 6px 0; }
	.release-modal__notes-body--rendered :global(ul),
	.release-modal__notes-body--rendered :global(ol) {
		margin: 6px 0;
		padding-left: 22px;
	}
	.release-modal__notes-body--rendered :global(li) { margin: 2px 0; }
	.release-modal__notes-body--rendered :global(li > p) { margin: 0; }
	.release-modal__notes-body--rendered :global(a) {
		color: var(--accent, #6ea8fe);
		text-decoration: none;
		border-bottom: 1px solid color-mix(in oklab, var(--accent, #6ea8fe) 35%, transparent);
	}
	.release-modal__notes-body--rendered :global(a:hover) {
		border-bottom-color: var(--accent, #6ea8fe);
	}
	.release-modal__notes-body--rendered :global(code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9em;
		background: color-mix(in oklab, var(--accent, #6ea8fe) 12%, transparent);
		padding: 1px 5px;
		border-radius: 4px;
	}
	.release-modal__notes-body--rendered :global(pre) {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
		line-height: 1.5;
		background: var(--surface-2, #20242d);
		border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
		padding: 10px 12px;
		border-radius: 6px;
		overflow-x: auto;
		margin: 8px 0;
	}
	.release-modal__notes-body--rendered :global(pre code) {
		background: transparent;
		padding: 0;
		font-size: inherit;
	}
	.release-modal__notes-body--rendered :global(blockquote) {
		margin: 8px 0;
		padding: 4px 12px;
		border-left: 3px solid var(--border, rgba(255, 255, 255, 0.1));
		color: var(--text-mute, #9aa3b5);
	}
	.release-modal__notes-body--rendered :global(hr) {
		border: 0;
		border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
		margin: 12px 0;
	}
	.release-modal__notes-body--rendered :global(strong) {
		font-weight: 700;
		color: var(--text, #e7ebf3);
	}
	.release-modal__notes-body--rendered :global(em) { font-style: italic; }
	.release-modal__notes-body--rendered :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: 6px;
	}

	.release-modal__foot {
		display: flex;
		gap: 8px;
		padding: 12px 16px 16px;
		justify-content: flex-end;
		border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
	}
	.release-modal__btn {
		padding: 10px 16px;
		border-radius: 8px;
		font-size: 14px;
		font-weight: 600;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px solid transparent;
		cursor: pointer;
		transition: background 150ms cubic-bezier(0.2, 0.7, 0.2, 1), border-color 150ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	.release-modal__btn--primary {
		background: var(--accent, #6ea8fe);
		color: var(--accent-ink, #0b1220);
	}
	.release-modal__btn--primary:hover {
		background: var(--accent-hover, #82b4ff);
	}
	.release-modal__btn--ghost {
		background: transparent;
		border-color: var(--border, rgba(255, 255, 255, 0.1));
		color: var(--text-mute, #9aa3b5);
	}
	.release-modal__btn--ghost:hover {
		border-color: var(--border, rgba(255, 255, 255, 0.2));
		color: var(--text, #e7ebf3);
	}

	@keyframes backdrop-in {
		from { opacity: 0; }
		to { opacity: 1; }
	}
	@keyframes backdrop-out {
		from { opacity: 1; }
		to { opacity: 0; }
	}
	@keyframes modal-in {
		from { opacity: 0; transform: translateY(8px) scale(0.97); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}
	@keyframes modal-out {
		from { opacity: 1; transform: translateY(0) scale(1); }
		to { opacity: 0; transform: translateY(8px) scale(0.97); }
	}

	@media (prefers-reduced-motion: reduce) {
		.release-modal-backdrop,
		.release-modal-backdrop.is-closing,
		.release-modal,
		.is-closing .release-modal {
			animation: none;
		}
	}
</style>

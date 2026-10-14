<script lang="ts">
	// Minimal shell for the /login route. Bypasses the main app layout
	// (rail + topbar) so the login screen reads as a stand-alone surface.
	// Tokens are pulled from #lib/tokens.css (owned by B1) — the same
	// stylesheet the main shell uses, so the login screen and the rest
	// of the app stay in lockstep.
	import '#lib/tokens.css';

	let { children } = $props();
</script>

<div class="login-bg">
	{@render children()}
</div>

<style>
	.login-bg {
		min-height: 100dvh;
		width: 100%;
		display: grid;
		place-items: center;
		padding: 24px;

		/* Mirror the prototype's body background so the login screen
		   already feels like part of WISSen. */
		background:
			radial-gradient(1200px 600px at 85% -20%, rgba(110, 168, 254, 0.10), transparent 60%),
			radial-gradient(900px 500px at -10% 10%, rgba(76, 201, 160, 0.06), transparent 60%),
			var(--bg, #0f1115);
		background-attachment: fixed;

		color: var(--text, #e7ebf3);
		font-family:
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Roboto,
			'Helvetica Neue',
			Arial,
			sans-serif;
	}

	:global(body) {
		margin: 0;
	}
</style>

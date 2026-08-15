import { browser } from '$app/environment';

/**
 * localStorage key for the API bearer token.
 *
 * Intentionally identical to the legacy frontend (web/app.js) so a user
 * already authenticated against WISSen v1 stays authenticated when
 * landing on v2 and vice versa.
 */
const STORAGE_TOKEN = 'wissen.authToken';

/**
 * Returns the persisted bearer token, or null when no token is stored
 * or when running outside a browser (SSR/load-time).
 */
export function getToken(): string | null {
	if (!browser) return null;
	try {
		const value = localStorage.getItem(STORAGE_TOKEN);
		return value && value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

/**
 * Persists the bearer token in localStorage. No-op outside the browser.
 * Quota / privacy-mode failures are swallowed silently — the user will
 * simply have to log in again on the next visit.
 */
export function setToken(token: string): void {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_TOKEN, token);
	} catch {
		/* ignore quota / disabled storage */
	}
}

/**
 * Removes the persisted bearer token. No-op outside the browser.
 */
export function clearToken(): void {
	if (!browser) return;
	try {
		localStorage.removeItem(STORAGE_TOKEN);
	} catch {
		/* ignore */
	}
}

/**
 * Convenience predicate: true when a non-empty token is currently stored.
 */
export function hasToken(): boolean {
	return getToken() !== null;
}

/**
 * Logs the user out: removes the persisted bearer token and navigates to the
 * login screen.
 *
 * This is the ONLY correct way to log out — call it from every "Abmelden"
 * entry point rather than navigating to /login directly.
 *
 * Background: the three logout controls (Rail, MobileTabBar, CommandPalette)
 * used to only `goto('/login')` without clearing anything. The token stayed in
 * localStorage, and since `+layout.ts` gates purely on `hasToken()`, the
 * "logged out" user was still fully authenticated — pressing Back or
 * re-entering the app URL restored access to Noten, Absenzen, Settings and
 * the destructive endpoints. On a shared machine the next person simply
 * continued the session. Worse, the value left behind is the server's master
 * API token (static, never rotated), so it could also be lifted out of
 * devtools and replayed against /api/* indefinitely.
 *
 * `replaceState` keeps the pre-logout page out of the history stack, so the
 * Back button cannot navigate back into it. `invalidateAll` re-runs the load
 * functions so no already-fetched data is left rendered behind the login card.
 */
export async function logout(basePath: string, goto: GotoFn): Promise<void> {
	clearToken();
	await goto(`${basePath}/login`, { replaceState: true, invalidateAll: true });
}

/**
 * Signature of SvelteKit's `goto`, narrowed to what `logout()` uses. Passed in
 * by the caller so this module stays free of `$app/navigation` — that import
 * pulls in the router and would make `auth.ts` awkward to use from
 * non-component code.
 */
type GotoFn = (
	url: string,
	opts?: { replaceState?: boolean; invalidateAll?: boolean }
) => Promise<void>;

import { redirect } from '@sveltejs/kit';
import { browser } from '$app/env';
import { resolve } from '$app/paths';
import { hasToken } from '#lib/auth.js';
import type { LayoutLoad } from './$types';

// SPA mode: token lives in localStorage, only readable in the browser.
export const ssr = false;
export const prerender = false;

/**
 * Auth guard for every route. Allows the /login route through
 * unauthenticated; redirects every other route to /login when no token
 * is present.
 *
 * `redirect()` does not auto-prefix the configured `paths.base`, so the
 * target goes through `resolve()` from `$app/paths`. With
 * `base = "/wissen/desktop-demo"` it becomes "/wissen/desktop-demo/login".
 */
export const load: LayoutLoad = async ({ url }) => {
	// During SSR (build / pre-render) we have no localStorage, so just
	// return — the client-side load runs again with the real environment.
	if (!browser) return {};

	const path = url.pathname;
	const loginPath = resolve('/login');
	const isLoginRoute = path === loginPath || path.startsWith(`${loginPath}/`);
	if (isLoginRoute) return {};

	if (!hasToken()) {
		throw redirect(302, loginPath);
	}

	return {};
};

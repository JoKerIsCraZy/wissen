/**
 * Derive the current route id from SvelteKit's page state. The id matches
 * the Rail nav id ('now', 'stundenplan', ...). Used by Rail and
 * CommandPalette to highlight the active surface.
 *
 * Note: this module exposes a helper, not a $state store, because the
 * source of truth is SvelteKit's $app/state. Components call
 * `getRouteId(page.url.pathname)` directly to keep things reactive.
 */

import { base } from '$app/paths';

export type RouteId =
  | 'now'
  | 'stundenplan'
  | 'noten'
  | 'absenzen'
  | 'stats'
  | 'settings'
  | 'push'
  | 'telegram'
  | 'login'
  | 'unknown';

export function getRouteId(pathname: string): RouteId {
  // Strip the configured base ('/v2') and any trailing slash.
  let p = pathname;
  if (base && p.startsWith(base)) p = p.slice(base.length);
  if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);
  if (p === '' || p === '/') return 'now';

  const seg = p.split('/').filter(Boolean)[0] ?? '';
  switch (seg) {
    case 'stundenplan':
    case 'noten':
    case 'absenzen':
    case 'stats':
    case 'settings':
    case 'push':
    case 'telegram':
    case 'login':
      return seg;
    default:
      return 'unknown';
  }
}

// =============================================================
// API fetch wrapper
//
// Thin layer around fetch() that:
//   - prefixes /api
//   - injects the Bearer token from $lib/auth (B3 owns getToken)
//   - parses JSON responses
//   - throws ApiHttpError with status + body for non-2xx
//
// Environment-agnostic — no $app/* imports — so it can be unit-tested
// against a mock fetch.
// =============================================================

import { clearToken, getToken } from '$lib/auth';
import type { ApiErrorBody } from './types';

const BASE = '/api';

/**
 * Thrown by `api()` for every non-2xx response. `body` holds the parsed JSON
 * envelope when the server returned `application/json`, otherwise the raw
 * text. Use `isApiHttpError()` (or `instanceof`) to narrow.
 */
export class ApiHttpError extends Error {
	public readonly status: number;
	public readonly body: ApiErrorBody | string | null;

	constructor(status: number, body: ApiErrorBody | string | null) {
		const msg = typeof body === 'object' && body && typeof body.error === 'string'
			? `API ${status}: ${body.error}`
			: `API ${status}`;
		super(msg);
		this.name = 'ApiHttpError';
		this.status = status;
		this.body = body;
	}
}

export function isApiHttpError(err: unknown): err is ApiHttpError {
	return err instanceof ApiHttpError;
}

interface ApiInit extends Omit<RequestInit, 'body'> {
	/** Either a JSON-serializable object or a pre-built BodyInit. */
	body?: unknown;
	/** Disable the automatic Bearer token injection (rare — exposed for tests). */
	noAuth?: boolean;
	/** AbortSignal — re-exposed so callers don't need to spell out RequestInit. */
	signal?: AbortSignal;
}

/**
 * Generic typed API call. `T` is the response shape.
 *
 *   const status = await api<ApiStatus>('/status');
 *   await api('/scrape', { method: 'POST' });
 */
export async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
	// `signal` wird hier explizit gezogen, damit es in `rest` und dadurch im
	// `fetch()`-Call unten landet. Routen die per AbortController auf Navigation
	// abbrechen wollen, übergeben `init.signal` an die Endpoint-Wrapper.
	const { body, noAuth, headers: rawHeaders, signal, ...rest } = init;
	const headers = new Headers(rawHeaders);

	// Auto-attach auth header unless explicitly disabled.
	if (!noAuth) {
		const token = getToken();
		if (token) headers.set('Authorization', `Bearer ${token}`);
	}

	// JSON body shortcut: pass any plain object/array and we'll stringify it.
	let payload: BodyInit | null | undefined;
	if (body == null) {
		payload = undefined;
	} else if (
		typeof body === 'string' ||
		body instanceof FormData ||
		body instanceof Blob ||
		body instanceof ArrayBuffer ||
		body instanceof URLSearchParams ||
		// ReadableStream may not exist in every TS lib target — guard via typeof.
		(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
	) {
		payload = body as BodyInit;
	} else {
		// JSON path — set Content-Type only when we control the body.
		if (!headers.has('Content-Type')) {
			headers.set('Content-Type', 'application/json');
		}
		payload = JSON.stringify(body);
	}

	const url = path.startsWith('/') ? `${BASE}${path}` : `${BASE}/${path}`;
	const res = await fetch(url, { ...rest, headers, body: payload, signal });

	if (!res.ok) {
		// Ein 401 heisst: der gespeicherte Token wird vom Server nicht (mehr)
		// akzeptiert — etwa weil der Operator data/.api-token rotiert hat.
		// Ihn liegen zu lassen bringt nichts und hält den Layout-Guard
		// (`hasToken()`) in dem Glauben, die Sitzung sei gültig, sodass der
		// Nutzer in einer Schleife aus fehlschlagenden Requests landet statt
		// auf dem Login-Screen.
		if (res.status === 401) clearToken();

		let parsed: ApiErrorBody | string | null = null;
		const ct = res.headers.get('content-type') ?? '';
		try {
			parsed = ct.includes('application/json')
				? ((await res.json()) as ApiErrorBody)
				: await res.text();
		} catch {
			parsed = null;
		}
		throw new ApiHttpError(res.status, parsed);
	}

	// 204 No Content — return undefined cast to T (caller's contract).
	if (res.status === 204) return undefined as T;

	const ct = res.headers.get('content-type') ?? '';
	if (!ct.includes('application/json')) {
		// Endpoints in this app are JSON-only; if a route ever returns
		// text/html (e.g. an auth redirect from a misconfigured proxy), fall
		// back to text rather than throwing on parse.
		return (await res.text()) as unknown as T;
	}

	return (await res.json()) as T;
}

/**
 * Build a query string from a record of primitives. Skips null/undefined.
 * Returns '' (empty) when there's nothing to append, or '?k=v&...' otherwise.
 */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
	const usp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v == null) continue;
		usp.append(k, String(v));
	}
	const s = usp.toString();
	return s ? `?${s}` : '';
}

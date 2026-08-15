// =============================================================
// Server-Sent Events client
//
// Wraps EventSource for /api/events. Auth happens via ?token=… in the URL
// because the EventSource constructor cannot set custom headers (browser
// limitation — there is no withCredentials/header API on the standard
// EventSource).
//
// Features:
//   - typed `on(eventType, handler)` returning an unsubscribe function
//   - automatic reconnect with exponential backoff on `error`
//   - explicit `.close()` so callers in `onDestroy()` can shut it down
//
// Event types currently emitted by the server (src/sse.js + runScrape.js):
//   - 'status'       → ApiStatus (initial push + on every state transition)
//   - 'log'          → LogEntry  (every logger.log call)
//   - 'abfrage_done' → ScrapeDonePayload (kanonisch seit Phase 6A; der Server
//                      feuert zusätzlich das alte 'scrape_done' — wir lauschen
//                      bewusst nur auf EIN Event, sonst doppelter Refetch)
//
// The default `message` channel is also forwarded so callers using the
// generic `onmessage` semantics still work.
// =============================================================

import { getToken } from '$lib/auth';
import type { ApiStatus, LogEntry, ScrapeDonePayload } from './types';

/** Map of event-name → payload type for type-safe `on(...)`. */
export interface SseEventMap {
	status: ApiStatus;
	log: LogEntry;
	abfrage_done: ScrapeDonePayload;
	/** Default channel — payload type is unknown until inspected. */
	message: unknown;
}

export type SseEventName = keyof SseEventMap | (string & {});

export type SseHandler<T> = (data: T) => void;

export type SseStateHandler = (state: SseConnectionState) => void;

export type SseConnectionState = 'connecting' | 'open' | 'closed' | 'reconnecting';

export interface SseClient {
	/**
	 * Subscribe to a specific SSE event. Returns an unsubscribe function.
	 * Use the typed overload (e.g. `on('status', fn)`) to get type-safe
	 * payloads, or pass any string for unknown events.
	 */
	on<K extends keyof SseEventMap>(event: K, handler: SseHandler<SseEventMap[K]>): () => void;
	on<T = unknown>(event: string, handler: SseHandler<T>): () => void;
	/** Subscribe to connection-state transitions. */
	onState(handler: SseStateHandler): () => void;
	/** Current connection state. */
	readonly state: SseConnectionState;
	/** Permanently close the connection — disables reconnect. */
	close(): void;
}

interface SseClientOptions {
	/** Initial reconnect delay in ms. Doubles up to maxReconnectDelay. */
	initialReconnectDelay?: number;
	/** Cap for exponential backoff. */
	maxReconnectDelay?: number;
	/**
	 * Token override (defaults to `getToken()`). Useful for tests; production
	 * calls should leave this unset.
	 */
	token?: string | null;
}

const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30_000;

/**
 * Open an SSE connection to /api/events. Always returns a working client
 * even if EventSource is unavailable in the current environment (in which
 * case state stays 'closed' and handlers never fire).
 */
export function connectEvents(opts: SseClientOptions = {}): SseClient {
	const initialDelay = opts.initialReconnectDelay ?? DEFAULT_INITIAL_DELAY;
	const maxDelay = opts.maxReconnectDelay ?? DEFAULT_MAX_DELAY;

	type HandlerSet = Set<SseHandler<unknown>>;
	const handlers = new Map<string, HandlerSet>();
	const stateHandlers = new Set<SseStateHandler>();
	// Per-EventSource cleanup callbacks — repopulated on every reconnect so
	// addEventListener calls don't leak across instances.
	let attached: Array<() => void> = [];

	let es: EventSource | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let currentDelay = initialDelay;
	let manuallyClosed = false;
	let state: SseConnectionState = 'connecting';

	function setState(next: SseConnectionState) {
		if (state === next) return;
		state = next;
		for (const h of stateHandlers) {
			try { h(state); } catch { /* isolated */ }
		}
	}

	/**
	 * Holt ein kurzlebiges Einmal-Ticket für den SSE-Stream.
	 *
	 * Früher wurde stattdessen der API-Token selbst als `?token=` an die
	 * EventSource-URL gehängt. Query-Strings landen vollständig in
	 * Reverse-Proxy-Access-Logs; da der Token statisch ist, nie abläuft und
	 * jede /api-Route autorisiert, war ein einziger Logeintrag Vollzugriff auf
	 * Dauer — und der Backoff-Reconnect unten hat ihn fortlaufend nachgeloggt.
	 *
	 * Jetzt reist der Token im Authorization-Header (landet in keinem Log) und
	 * nur das Ticket in der URL. Ein Ticket ist einmalig und nach 30s wertlos.
	 *
	 * Der Token wird bewusst erst hier gelesen, damit eine Rotation zwischen
	 * zwei Reconnects automatisch greift.
	 */
	async function fetchTicket(): Promise<string | null> {
		const tok = opts.token !== undefined ? opts.token : getToken();
		if (!tok) return null;
		try {
			const res = await fetch('/api/events/ticket', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { Authorization: `Bearer ${tok}` }
			});
			if (!res.ok) return null;
			const data: unknown = await res.json();
			const ticket = (data as { ticket?: unknown } | null)?.ticket;
			return typeof ticket === 'string' && ticket.length > 0 ? ticket : null;
		} catch {
			// Netzwerkfehler — der Backoff-Reconnect versucht es erneut.
			return null;
		}
	}

	function dispatch(eventName: string, raw: string) {
		const set = handlers.get(eventName);
		if (!set || set.size === 0) return;
		let parsed: unknown;
		try {
			parsed = raw === '' ? null : JSON.parse(raw);
		} catch {
			// Non-JSON SSE payloads are unusual for this app — surface the raw
			// string so callers can choose what to do.
			parsed = raw;
		}
		for (const h of set) {
			try { h(parsed); } catch { /* isolated */ }
		}
	}

	function attachHandlersTo(target: EventSource) {
		// Generic message channel.
		const onMessage = (evt: MessageEvent) => dispatch('message', evt.data);
		target.addEventListener('message', onMessage);
		attached.push(() => target.removeEventListener('message', onMessage));

		// Named events. We attach for each currently registered event name;
		// on() also calls attachNamedEvent for new names that arrive after
		// open.
		for (const name of handlers.keys()) {
			if (name === 'message') continue;
			attachNamedEvent(target, name);
		}
	}

	function attachNamedEvent(target: EventSource, name: string) {
		const listener = (evt: MessageEvent) => dispatch(name, evt.data);
		target.addEventListener(name, listener as EventListener);
		attached.push(() =>
			target.removeEventListener(name, listener as EventListener)
		);
	}

	function clearAttached() {
		for (const off of attached) {
			try { off(); } catch { /* ignore */ }
		}
		attached = [];
	}

	function open() {
		if (manuallyClosed) return;
		if (typeof EventSource === 'undefined') {
			setState('closed');
			return;
		}
		setState(es ? 'reconnecting' : 'connecting');
		// Der Ticket-Abruf ist asynchron; der Rest des Aufbaus läuft in
		// openWithTicket() weiter. Fehler dort landen im Backoff-Reconnect.
		void openWithTicket();
	}

	async function openWithTicket() {
		const ticket = await fetchTicket();

		// Zwischen Ticket-Abruf und Verbindungsaufbau kann close() gelaufen
		// sein — dann darf hier keine neue EventSource mehr entstehen.
		if (manuallyClosed) return;

		if (!ticket) {
			// Kein Token, 401 oder Netzwerkfehler. Backoff greift; sobald wieder
			// ein gültiger Token vorliegt, klappt der nächste Versuch.
			scheduleReconnect();
			return;
		}

		try {
			es = new EventSource(`/api/events?ticket=${encodeURIComponent(ticket)}`);
		} catch {
			scheduleReconnect();
			return;
		}

		attachHandlersTo(es);

		es.onopen = () => {
			currentDelay = initialDelay; // reset backoff on successful open
			setState('open');
		};

		es.onerror = () => {
			// EventSource auto-reconnects on transient network errors, but if
			// the server closed the stream (readyState=CLOSED) we have to
			// re-instantiate.
			if (manuallyClosed) return;
			if (es && es.readyState === EventSource.CLOSED) {
				teardown();
				scheduleReconnect();
			} else {
				setState('reconnecting');
			}
		};
	}

	function teardown() {
		clearAttached();
		if (es) {
			try { es.close(); } catch { /* ignore */ }
			es = null;
		}
	}

	function scheduleReconnect() {
		if (manuallyClosed) return;
		setState('reconnecting');
		if (reconnectTimer) clearTimeout(reconnectTimer);
		const delay = currentDelay;
		currentDelay = Math.min(currentDelay * 2, maxDelay);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			open();
		}, delay);
	}

	const client: SseClient = {
		on(event: string, handler: SseHandler<unknown>) {
			let set = handlers.get(event);
			if (!set) {
				set = new Set();
				handlers.set(event, set);
				// If the underlying EventSource is already open, hook up the
				// new event name on the fly so we don't miss subsequent
				// dispatches.
				if (es && event !== 'message') {
					attachNamedEvent(es, event);
				}
			}
			set.add(handler);
			return () => {
				const s = handlers.get(event);
				if (!s) return;
				s.delete(handler);
				if (s.size === 0) handlers.delete(event);
			};
		},

		onState(handler: SseStateHandler) {
			stateHandlers.add(handler);
			return () => {
				stateHandlers.delete(handler);
			};
		},

		get state() {
			return state;
		},

		close() {
			manuallyClosed = true;
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			teardown();
			setState('closed');
		}
	};

	open();
	return client;
}

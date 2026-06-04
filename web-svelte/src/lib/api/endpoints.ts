// =============================================================
// Typed endpoint wrappers
//
// One function per real Express route in src/routes/*.js. No fabricated
// endpoints. Each wrapper returns a Promise<T> with T pulled from
// ./types.ts.
// =============================================================

import { api, qs } from './client';
import type {
	AbsenzenLektionenResponse,
	AbsenzenResponse,
	ApiStatus,
	DbResetResponse,
	LogsResponse,
	NotenHistoryResponse,
	NotenQuery,
	NotenResponse,
	PruefungenResponse,
	PushSubscribeResponse,
	PushTestResponse,
	PushUnsubscribeResponse,
	ScrapeTriggerResponse,
	SeenKind,
	SeenResponse,
	SettingsPatch,
	SettingsPatchResponse,
	SettingsView,
	StatsResponse,
	StundenplanClearResponse,
	StundenplanQuery,
	StundenplanResponse,
	VapidKeyResponse
} from './types';

// ---------- Status ----------

/** GET /api/status */
export const getStatus = (init?: { signal?: AbortSignal }) =>
	api<ApiStatus>('/status', init);

// ---------- Version ----------

export interface VersionResponse {
	version: string;
	swVersion: string;
	node: string;
	uptimeMs: number;
	upstream: {
		tag: string;
		version: string | null;
		name: string;
		url: string;
		publishedAt: string | null;
		body: string | null;
		bodyHtml: string | null;
	} | null;
	updateAvailable: boolean;
}

/** GET /api/version */
export const getVersion = (init?: { signal?: AbortSignal }) =>
	api<VersionResponse>('/version', init);

// ---------- Noten ----------

/** GET /api/noten */
export const getNoten = (params: NotenQuery = {}, init?: { signal?: AbortSignal }) =>
	api<NotenResponse>(
		`/noten${qs({
			semester: params.semester,
			sortBy: params.sortBy,
			hasNote: params.hasNote
		})}`,
		init
	);

/** GET /api/history/:kuerzelId */
export const getNotenHistory = (
	kuerzelId: string,
	init?: { signal?: AbortSignal }
) =>
	api<NotenHistoryResponse>(
		`/history/${encodeURIComponent(kuerzelId)}`,
		init
	);

/** GET /api/noten/:kuerzelId/pruefungen */
export const getPruefungen = (
	kuerzelId: string,
	init?: { signal?: AbortSignal }
) =>
	api<PruefungenResponse>(
		`/noten/${encodeURIComponent(kuerzelId)}/pruefungen`,
		init
	);

/** POST /api/seen — mark fresh-flagged items as seen. */
export const markSeen = (kind: SeenKind, ids: Array<string | number>) =>
	api<SeenResponse>('/seen', {
		method: 'POST',
		body: { kind, ids }
	});

/** POST /api/dismiss — hart entfernen aus der "Letzte Änderung"-Liste.
 *  Setzt change_pending=0; Eintrag verschwindet sofort, nicht erst nach 24h.
 *  Aufruf-Modi:
 *    dismissChanges({ all: true })                — alles dismissen
 *    dismissChanges({ kind: 'noten' })            — alle Noten-Frischen dismissen
 *    dismissChanges({ kind: 'noten', ids: [...] })— spezifische Items dismissen
 */
export interface DismissBody {
	all?: boolean;
	kind?: SeenKind;
	ids?: Array<string | number>;
}
export interface DismissResponse {
	ok: boolean;
	dismissed: { noten: number; stundenplan: number };
}
export const dismissChanges = (body: DismissBody) =>
	api<DismissResponse>('/dismiss', {
		method: 'POST',
		body
	});

// ---------- Absenzen ----------

/** GET /api/absenzen */
export const getAbsenzen = (init?: { signal?: AbortSignal }) =>
	api<AbsenzenResponse>('/absenzen', init);

/** GET /api/absenzen/:code/termine — Tagesliste pro Modul (kuerzel_code). */
export const getAbsenzenLektionen = (
	code: string,
	init?: { signal?: AbortSignal }
) =>
	api<AbsenzenLektionenResponse>(
		`/absenzen/${encodeURIComponent(code)}/termine`,
		init
	);

// ---------- Stundenplan ----------

/** GET /api/stundenplan */
export const getStundenplan = (
	params: StundenplanQuery = {},
	init?: { signal?: AbortSignal }
) =>
	api<StundenplanResponse>(
		`/stundenplan${qs({
			limit: params.limit,
			from: params.from,
			to: params.to
		})}`,
		init
	);

/** POST /api/stundenplan/clear — destructive: deletes ALL Stundenplan rows. */
export const clearStundenplan = () =>
	api<StundenplanClearResponse>('/stundenplan/clear', { method: 'POST' });

/** POST /api/db/reset — destructive: deletes ALL scraped data (Noten/Pruefungen/
 *  Stundenplan/Absenzen). Keeps push subscriptions + settings. */
export const resetDb = () =>
	api<DbResetResponse>('/db/reset', { method: 'POST' });

// ---------- Stats ----------

/** GET /api/stats */
export const getStats = (init?: { signal?: AbortSignal }) =>
	api<StatsResponse>('/stats', init);

// ---------- Scrape ----------

/**
 * POST /api/scrape — kicks off a scrape cycle. Server returns a JSON
 * envelope even on 429 (cooldown), but the fetch wrapper throws
 * ApiHttpError for non-2xx — wrap in try/catch and inspect `err.body`.
 */
export const triggerScrape = () =>
	api<ScrapeTriggerResponse>('/scrape', { method: 'POST' });

// ---------- Settings ----------

/** GET /api/settings */
export const getSettings = (init?: { signal?: AbortSignal }) =>
	api<SettingsView>('/settings', init);

/** PATCH /api/settings */
export const updateSettings = (patch: SettingsPatch) =>
	api<SettingsPatchResponse>('/settings', {
		method: 'PATCH',
		body: patch
	});

// ---------- Push (Web-Push) ----------

/** GET /api/push/vapid-key */
export const getVapidKey = (init?: { signal?: AbortSignal }) =>
	api<VapidKeyResponse>('/push/vapid-key', init);

/** POST /api/push/subscribe */
export const registerPush = (subscription: PushSubscriptionJSON) =>
	api<PushSubscribeResponse>('/push/subscribe', {
		method: 'POST',
		body: { subscription }
	});

/** DELETE /api/push/subscribe */
export const unregisterPush = (endpoint: string) =>
	api<PushUnsubscribeResponse>('/push/subscribe', {
		method: 'DELETE',
		body: { endpoint }
	});

/** POST /api/push/test */
export const sendTestPush = () =>
	api<PushTestResponse>('/push/test', { method: 'POST' });

// ---------- Logs ----------

/** GET /api/logs?limit=N (default server-side: 200) */
export const getLogs = (limit?: number, init?: { signal?: AbortSignal }) =>
	api<LogsResponse>(`/logs${qs({ limit })}`, init);

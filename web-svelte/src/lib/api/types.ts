// =============================================================
// API Type Definitions
//
// Maps the Express endpoints under /api/* to TypeScript shapes.
// Source of truth for what each endpoint returns/accepts. Refined by
// reading src/routes/*.js + src/db/*.js + src/sse.js.
// =============================================================

// ---------- Status / SSE ----------

/**
 * Phases emitted by runScrape via sse.setPhase(). The actual set is loose
 * (any string is technically possible), but these are the canonical values
 * used by the scraper today.
 */
/**
 * Seit dem Parallel-Fetch-Refactor emittiert der Scraper KEIN separates
 * 'stundenplan' mehr — Noten + Stundenplan laufen zusammen unter 'noten'.
 * Die ältere `modulnoten` / `pruefungen` / `detail` / `finalize` sind
 * defensive Fallbacks für historische / hypothetische Phase-Strings;
 * `(string & {})` lässt den Union offen, falls neue Phasen dazukommen.
 */
export type ScrapePhase =
	| 'starting'
	| 'browser'
	| 'login'
	| 'noten'
	| 'modulnoten'
	| 'pruefungen'
	| 'noten_details'
	| 'detail'
	| 'saving'
	| 'finalize'
	| (string & {});

/**
 * Topbar/Live status badge state. In einem geteilten .ts-Modul statt im
 * Topbar.svelte <script module>, weil Sveltes ambient *.svelte-Typing nur den
 * Default-(Komponenten)-Export exponiert — ein `import type { StatusKind }`
 * aus der .svelte schlägt sonst mit TS2614 fehl (z.B. in live.svelte.ts).
 */
export type StatusKind = 'idle' | 'running' | 'error';

/**
 * Shape of `state.lastStats` set by runScrape. The scraper merges results
 * from multiple stages so several keys may be absent depending on what ran.
 */
export interface ScrapeStats {
	noten?: {
		inserted: number;
		updated: number;
		changed: number;
		gradeChanges: GradeChange[];
	};
	stundenplan?: {
		inserted: number;
		updated: number;
		roomChanges: RoomChange[];
	};
	pruefungen?: {
		inserted: number;
		updated: number;
		deleted: number;
	};
	durationMs?: number;
	[k: string]: unknown;
}

export interface GradeChange {
	type: 'new' | 'changed';
	kuerzel_id: string;
	kuerzel_code: string;
	fach_name: string;
	semester: string;
	prev_note: number | null;
	new_note: number | null;
}

export interface RoomChange {
	datum_iso: string;
	zeit_von: string;
	zeit_bis: string;
	veranstaltung: string;
	dozent: string;
	prev_raum: string;
	new_raum: string;
	wentOnline: boolean;
	wentOffline: boolean;
}

/**
 * Shape returned by GET /api/status — see sse.statusPayload(). Same payload
 * is also pushed as the initial SSE `status` event and on every state
 * transition.
 */
export interface ApiStatus {
	running: boolean;
	lastRun: string | null; // ISO datetime
	nextRun: string | null;
	lastError: string | null;
	enabled: boolean;
	intervalMinutes: number;
	serverTime: string; // ISO datetime
	currentPhase: ScrapePhase | null;
	phaseStartedAt: string | null;
}

// ---------- Logs ----------

export type LogLevel = 'info' | 'warn' | 'error' | 'progress';

export interface LogEntry {
	ts: string; // ISO datetime
	level: LogLevel;
	message: string;
}

/** GET /api/logs?limit=N */
export interface LogsResponse {
	logs: LogEntry[];
}

// ---------- Noten ----------

export interface NotenRow {
	id: number;
	kuerzel_id: string;
	fach_code: string;
	fach_name: string;
	kuerzel_full: string;
	kuerzel_code: string;
	semester: string; // e.g. 'S1', 'S2', ...
	typ: string;
	note: number | null;
	note_raw: string;
	fetched_at: string; // SQLite CURRENT_TIMESTAMP — UTC string
	/** 1 if change_pending and seen <24h ago (or never seen). 0 otherwise. */
	isFresh: 0 | 1;
	/** Letzter distinkter Note-Wert vor `note`, aus noten_history.
	 *  null wenn noch nie geändert (initialer Eintrag). */
	prev_note: number | null;
	/** ISO-Zeit wann der jetzige note-Wert erfasst wurde. */
	note_recorded_at: string | null;
}

export type NotenSortBy = 'note' | 'fetched' | 'fach';

export interface NotenQuery {
	semester?: string; // matches /^S[0-9]{1,2}$/
	sortBy?: NotenSortBy;
	hasNote?: boolean;
}

/** GET /api/noten */
export interface NotenResponse {
	rows: NotenRow[];
	count: number;
	avg: number | null;
	bySemester: Record<string, number>;
	fetchedAt: string | null;
}

export interface NotenHistoryRow {
	id: number;
	kuerzel_id: string;
	fach_name: string;
	note: number | null;
	note_raw: string;
	recorded_at: string;
}

/** GET /api/history/:kuerzelId */
export interface NotenHistoryResponse {
	rows: NotenHistoryRow[];
}

export type PruefungTyp = 'ZP' | 'LB' | 'OTHER' | (string & {});

export interface PruefungRow {
	id: number;
	kuerzel_id: string;
	pruefung_typ: PruefungTyp;
	pruefung_nr: number;
	bezeichnung: string | null;
	gewicht: string | null;
	gewicht_pct: number | null;
	bewertung: number | null;
	bewertung_raw: string | null;
	fetched_at: string;
	/** Letzter distinkter Wert vor `bewertung`, aus pruefungen_history.
	 *  null wenn keine Wert-Änderung jemals erfasst wurde. */
	prev_bewertung: number | null;
	/** ISO-Zeit wann der jetzige bewertung-Wert erfasst wurde. */
	bewertung_recorded_at: string | null;
}

/** GET /api/noten/:kuerzelId/pruefungen */
export interface PruefungenResponse {
	rows: PruefungRow[];
	modulNote: number | null;
	modulNoteRaw: string | null;
	detailId: string | null;
	fachName: string | null;
	fachCode: string | null;
	kuerzelCode: string | null;
	kuerzelFull: string | null;
	semester: string | null;
	typ: string | null;
}

/** POST /api/seen */
export type SeenKind = 'noten' | 'stundenplan' | 'absenzen';

export interface SeenRequest {
	kind: SeenKind;
	/** kuerzel_id strings for 'noten'; numeric ids (or strings) for 'stundenplan'. Max 200 per call. */
	ids: Array<string | number>;
}

export interface SeenResponse {
	ok: true;
	updated: number;
}

// ---------- Stundenplan ----------

export interface StundenplanRow {
	id: number;
	datum_iso: string; // YYYY-MM-DD
	zeit_von: string; // HH:MM
	zeit_bis: string; // HH:MM
	raum: string;
	dozent: string;
	klasse: string;
	veranstaltung: string;
	fetched_at: string;
	isFresh: 0 | 1;
}

export interface StundenplanQuery {
	limit?: number;
	from?: string; // YYYY-MM-DD
	to?: string; // YYYY-MM-DD
}

/** GET /api/stundenplan */
export interface StundenplanResponse {
	rows: StundenplanRow[];
	count: number;
	fetchedAt: string | null;
}

/** POST /api/stundenplan/clear */
export interface StundenplanClearResponse {
	deleted: number;
}

// ---------- Absenzen ----------

/**
 * Eine Modul-Zeile der Absenzen-Übersicht (GET /api/absenzen → rows[]).
 * `kuerzel_code` (Text) ist der Join-Key zur Tagesliste; Absenzen zeigen
 * keine numerische ID, daher wird der Kurzbezeichnungs-Code als Schlüssel
 * verwendet (auch für /seen + /dismiss).
 */
export interface AbsenzModulRow {
	id: number;
	kuerzel_code: string;
	typ: string | null;
	bezeichnung: string | null;
	semester: string | null;
	soll: number | null;
	besucht: number | null;
	/** soll - besucht (nicht <0 geclampt). */
	absenzen: number | null;
	/** Minimal-Anwesenheit in % (nullable). */
	minimal_pct: number | null;
	/** Berechnet besucht/soll*100, null bei soll=0. */
	anwesenheit_pct: number | null;
	/** Vom Badge gescrapter Wert (Rundungs-Abgleich). */
	anwesenheit_pct_scraped: number | null;
	fetched_at: string; // SQLite CURRENT_TIMESTAMP — UTC string
	/** 1 wenn change_pending und seen <24h (oder nie gesehen). 0 sonst. */
	isFresh: 0 | 1;
	/** 1 wenn eine Tagesliste (detail) vorhanden ist, 0 sonst. */
	hasDetail?: 0 | 1;
}

/**
 * Normalisierte Status-Kategorie einer Lektion (§3 der Spec — fix).
 * `status_raw` trägt zusätzlich den Roh-String für die Anzeige.
 */
export type AbsenzStatus =
	| 'teilgenommen'
	| 'offen'
	| 'abwesend_entschuldigt'
	| 'abwesend_unentschuldigt'
	| 'unbekannt'
	| (string & {});

/** Eine Lektion der Tagesliste (GET /api/absenzen/:code/termine → rows[]). */
export interface AbsenzLektionRow {
	id: number;
	kuerzel_code: string;
	termin_iso: string | null; // YYYY-MM-DD
	zeit_von: string | null; // HH:MM
	zeit_bis: string | null; // HH:MM
	termin_raw: string | null;
	lektionen_soll: number | null;
	lektionen_ist: number | null;
	anwesenheit_pct: number | null;
	/** Normalisierte Kategorie. */
	status: AbsenzStatus;
	/** Roh-String aus dem Scrape, für die Anzeige. */
	status_raw: string | null;
	fetched_at: string;
	isFresh: 0 | 1;
}

export interface AbsenzenStats {
	/** Ø Ist-Anwesenheit über alle Module mit Wert (%). */
	avgAnwesenheit: number | null;
	/** Anzahl Module unter ihrer Minimal-Anwesenheit. */
	unterMinimum: number;
	/** Summe der Abwesenheiten (soll - besucht) über alle Module. */
	abwesendGesamt: number;
}

/** GET /api/absenzen */
export interface AbsenzenResponse {
	rows: AbsenzModulRow[];
	count: number;
	stats: AbsenzenStats;
	fetchedAt: string | null;
}

/** GET /api/absenzen/:code/termine */
export interface AbsenzenLektionenResponse {
	modul: AbsenzModulRow;
	rows: AbsenzLektionRow[];
}

// ---------- Stats ----------

export interface StatsNextEvent {
	datum_iso: string;
	zeit_von: string;
	veranstaltung: string;
	raum: string;
}

/** GET /api/stats */
export interface StatsResponse {
	notenCount: number;
	notenWithGradeCount: number;
	avgNote: number | null;
	avgBySemester: Record<string, number>;
	stundenplanUpcoming: number;
	lastFetchedNoten: string | null;
	lastFetchedStundenplan: string | null;
	nextEvent: StatsNextEvent | null;
	changedRecent: number;
}

// ---------- Scrape ----------

/** POST /api/scrape — triggers a manual scrape cycle. */
export interface ScrapeTriggerResponse {
	triggered: boolean;
	/** 'already_running' | 'cooldown' | undefined when triggered=true */
	reason?: string;
	/** Only present when reason='cooldown'. Server returns 429 in that case. */
	retryInSec?: number;
}

// ---------- Settings ----------

export type ScheduleMode = 'interval' | 'weekly';

/**
 * Full Settings object as accepted by .save() / coerce(). The PATCH endpoint
 * filters this through the UI allowlist before persisting — see
 * ALLOWED_UI_KEYS in src/settings.js.
 */
export interface SettingsBase {
	msEmail: string;
	msPassword: string;
	userPk: string;
	baseUrl: string;
	notenUrl: string;
	stundenplanUrl: string;
	scheduleMode: ScheduleMode;
	/** 0 (Sun) .. 6 (Sat) */
	scheduleDays: number[];
	intervalMinutes: number;
	intervalTimeFrom: string; // HH:MM
	intervalTimeTo: string; // HH:MM
	scheduleTimes: string[]; // ['HH:MM', ...]
	autoRun: boolean;
	/** Manual scrape pulls ALL module details (like the weekly full refresh). */
	manualScrapeFullDetails: boolean;
	headless: boolean;
	slowMo: number;
	port: number;
	telegramEnabled: boolean;
	telegramToken: string;
	telegramAllowedUserId: number | null;
}

/**
 * GET /api/settings — secrets are NEVER returned. The server replies with a
 * masked view (see runScrape.maskSettings) plus indicator booleans like
 * `passwordSet` so the UI can show "•••• gesetzt" without ever holding the
 * actual secret.
 */
export interface SettingsView {
	autoRun: boolean;
	intervalMinutes: number;
	intervalTimeFrom: string;
	intervalTimeTo: string;
	scheduleMode: ScheduleMode;
	scheduleDays: number[];
	scheduleTimes: string[];
	manualScrapeFullDetails: boolean;
	headless: boolean;
	slowMo: number;
	port: number;
	telegramEnabled: boolean;
	telegramAllowedUserId: number | null;
	baseUrl: string;
	notenUrl: string;
	stundenplanUrl: string;
	urlsLocked: true;
	emailSet: boolean;
	passwordSet: boolean;
	telegramTokenSet: boolean;
	allowUiCredentials: boolean;
	/** May be present when `allowUiCredentials` is true. Otherwise omitted. */
	msEmail?: string;
	userPk?: string;
}

/**
 * PATCH /api/settings — body. The server's filterUiPatch silently drops
 * URL/port keys and (when ALLOW_UI_CREDENTIALS=false) credential keys.
 * Empty-string secrets are also dropped so a blank form field never
 * overwrites a stored password/token.
 */
export interface SettingsPatch {
	autoRun?: boolean;
	intervalMinutes?: number;
	intervalTimeFrom?: string;
	intervalTimeTo?: string;
	scheduleMode?: ScheduleMode;
	scheduleDays?: number[];
	scheduleTimes?: string[];
	manualScrapeFullDetails?: boolean;
	headless?: boolean;
	slowMo?: number;
	telegramEnabled?: boolean;
	telegramAllowedUserId?: number | null;
	// Credential keys — only honored when ALLOW_UI_CREDENTIALS=true on the server.
	msEmail?: string;
	msPassword?: string;
	telegramToken?: string;
	userPk?: string;
}

/** PATCH /api/settings response. */
export interface SettingsPatchResponse {
	settings: SettingsView;
	rescheduled: boolean;
	botRestarted: boolean;
}

// ---------- Push (Web-Push / VAPID) ----------

/** GET /api/push/vapid-key */
export interface VapidKeyResponse {
	publicKey: string;
}

/**
 * POST /api/push/subscribe — body. Wraps the standard PushSubscriptionJSON
 * (browser PushManager.subscribe(...).toJSON()) in `{ subscription }`.
 */
export interface PushSubscribeRequest {
	subscription: PushSubscriptionJSON;
}

export interface PushSubscribeResponse {
	ok: true;
	total: number;
}

/** DELETE /api/push/subscribe — body. */
export interface PushUnsubscribeRequest {
	endpoint: string;
}

export interface PushUnsubscribeResponse {
	ok: true;
	removed: number;
}

/** POST /api/push/test */
export interface PushTestResponse {
	ok: true;
	sent: number;
	removed: number;
	errors: number;
}

// ---------- SSE Events ----------

/**
 * Event types emitted on /api/events. Keep in sync with src/sse.js +
 * src/runScrape.js.
 */
export type SseEventType = 'status' | 'log' | 'scrape_done' | (string & {});

export interface ScrapeDonePayload {
	ok: boolean;
	error: string | null;
	stats: ScrapeStats | null;
	finishedAt: string;
}

/**
 * Discriminated union of SSE payloads — `event` matches the SSE `event:`
 * line, `data` is the parsed JSON body.
 */
export type SseEvent =
	| { event: 'status'; data: ApiStatus }
	| { event: 'log'; data: LogEntry }
	| { event: 'scrape_done'; data: ScrapeDonePayload }
	| { event: string; data: unknown };

// ---------- Errors ----------

/**
 * Error envelope from src/shared/apiError.js — `{ error, status }`.
 * Some endpoints additionally include extra fields (e.g. retryInSec on
 * cooldown), so the type is open-ended.
 */
export interface ApiErrorBody {
	error: string;
	status?: number;
	[k: string]: unknown;
}

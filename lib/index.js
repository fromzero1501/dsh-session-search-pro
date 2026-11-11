/**
 * dsh-session-search-pro
 *
 * 一个替换官方 @deepseek-ai/dsh-session-query-sqlite 的 ctx.sessionQuery 后端。
 *
 * 和官方实现的差别只有四条，但这四条决定了中文能不能用：
 *
 * 1. 只索引 user/message。 用户找的是「我自己说过的话」，assistant 回复、
 *    工具调用、todo 都不进索引 —— 索引体积小一个数量级，LIKE 兜底也快。
 * 2. FTS5 用 trigram 分词。 官方用 unicode61，连续汉字被当成一个 token，
 *    中文查询 0 命中且不报错。trigram 对 >=3 字符的中文有效，<3 字符走 LIKE。
 * 3. 坏会话永久跳过。 官方对单个会话的读取错误无容错，一个损坏的 jsonl
 *    会让整轮索引失败，宿主吞错后静默回落为标题过滤。
 * 4. 不要求磁盘快照稳定。 官方要求读前读后的 persistence 快照完全一致才写库，
 *    而当前正在对话的会话每几秒就追加一次 —— 快照永远不一致，4 次重试后
 *    整轮抛 SESSION_QUERY_PERSISTENCE_FAILED。这里改成「本轮变动的会话下次再来」。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import SessionQueryEngine, {
	SessionQueryError,
	SessionSearchCursor,
	extractSessionEventText,
	readColdSessionLog
} from "@deepseek-ai/dsh-session-query";
import {
	APPLICATION_ID,
	CREATE_STATEMENTS,
	DELETE_DOC,
	DELETE_DOC_INDEX,
	DROP_STATEMENTS,
	INSERT_DOC,
	INSERT_DOC_INDEX,
	INSERT_SESSION,
	SCHEMA_VERSION,
	SELECT_CANDIDATES_LIKE,
	SELECT_CANDIDATES_MATCH,
	SELECT_KNOWN_SESSIONS,
	SELECT_META,
	SELECT_SESSION_HEADER,
	SELECT_SESSION_LIKE,
	SELECT_SESSION_MATCH,
	SELECT_SESSION_ROWIDS,
	UPSERT_META,
	ftsPhrase,
	likePattern,
	makeSnippet
} from "./sql.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_SNIPPET_CHARS = 240;
const QUERY_MAX_CODE_UNITS = 500;
const INDEX_CONCURRENCY = 8;
/** 一次查询从 FTS/LIKE 里取多少条候选文档来聚合成会话。 */
const CANDIDATE_DOCUMENTS = 800;
const USER_MESSAGE_TYPE = "user/message";
const SURFACE = "current";

//#region helpers

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal) {
	if (signal?.aborted === true) {
		const error = new Error("session search aborted");
		error.name = "AbortError";
		throw error;
	}
}

function codepointLength(value) {
	let count = 0;
	for (const _ of value) count += 1;
	return count;
}

/** 少于 3 个码点时必须走 LIKE：trigram 索引里没有 1–2 字符的 token。 */
function needsLiteralSearch(query) {
	return codepointLength(query) < 3;
}

function normalizeQuery(value) {
	if (typeof value !== "string") {
		throw new SessionQueryError("session search query must be a string", "SESSION_QUERY_INVALID_REQUEST");
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new SessionQueryError("session search query must not be empty", "SESSION_QUERY_INVALID_REQUEST");
	}
	if (trimmed.length > QUERY_MAX_CODE_UNITS) return trimmed.slice(0, QUERY_MAX_CODE_UNITS);
	return trimmed;
}

function normalizeLimit(value, config) {
	const fallback = Number.isSafeInteger(config.defaultLimit) && config.defaultLimit > 0 ? config.defaultLimit : DEFAULT_LIMIT;
	const ceiling = Number.isSafeInteger(config.maxLimit) && config.maxLimit > 0 ? config.maxLimit : MAX_LIMIT;
	if (value === void 0) return Math.min(fallback, ceiling);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new SessionQueryError("session search limit must be a positive integer", "SESSION_QUERY_INVALID_REQUEST");
	}
	return Math.min(value, ceiling);
}

function normalizeSessionRequest(request, config) {
	if (request === void 0 || request === null || typeof request !== "object") {
		throw new SessionQueryError("session search request must be an object", "SESSION_QUERY_INVALID_REQUEST");
	}
	const query = normalizeQuery(request.query);
	const limit = normalizeLimit(request.limit, config);
	const cursor = request.cursor === void 0 ? void 0 : String(request.cursor);
	return {
		query,
		limit,
		cursor,
		fingerprint: `sessions:${query}:${limit}`
	};
}

function normalizeEventRequest(request, config) {
	if (request === void 0 || request === null || typeof request !== "object") {
		throw new SessionQueryError("session search request must be an object", "SESSION_QUERY_INVALID_REQUEST");
	}
	if (typeof request.sessionId !== "string" || request.sessionId.length === 0) {
		throw new SessionQueryError("event search requires a sessionId", "SESSION_QUERY_INVALID_REQUEST");
	}
	const query = normalizeQuery(request.query);
	const limit = normalizeLimit(request.limit, config);
	const cursor = request.cursor === void 0 ? void 0 : String(request.cursor);
	return {
		sessionId: request.sessionId,
		query,
		limit,
		cursor,
		fingerprint: `events:${request.sessionId}:${query}:${limit}`
	};
}

function encodeCursor(payload) {
	return SessionSearchCursor(Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"));
}

function decodeCursor(cursor, instance, scope, fingerprint) {
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
	} catch {
		throw new SessionQueryError("invalid session search cursor", "SESSION_QUERY_INVALID_CURSOR");
	}
	if (parsed === null || typeof parsed !== "object" || parsed.version !== 1 || parsed.instance !== instance || parsed.scope !== scope || parsed.fingerprint !== fingerprint || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) {
		throw new SessionQueryError("invalid session search cursor", "SESSION_QUERY_INVALID_CURSOR");
	}
	return parsed.offset;
}

function defaultDatabasePath() {
	const home = process.env.DSH_HOME ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "dsh-desktop", "harness");
	return join(home, "cache", "session-search-pro.db");
}

function logPathOf(databasePath) {
	const path = databasePath.length > 0 ? databasePath : defaultDatabasePath();
	return join(dirname(path), "session-search-pro.log");
}

//#endregion

var ProSessionQueryEngine = class extends SessionQueryEngine {
	static Config = z.object({
		path: z.string().default(""),
		openAt: z.string().default("first-search"),
		defaultLimit: z.number().default(DEFAULT_LIMIT),
		maxLimit: z.number().default(MAX_LIMIT),
		snippetChars: z.number().default(DEFAULT_SNIPPET_CHARS)
	});

	_db = null;
	_opening = void 0;
	_tail = Promise.resolve();
	_generation = "0";
	_instance = randomUUID();
	_liveCache = void 0;
	_logFailure = false;
	_persistenceBinding = { identity: Symbol() };
	_optionalPersistenceFiber;

	constructor(ctx, config = {}) {
		const resolved = {
			...config,
			path: typeof config.path === "string" ? config.path : "",
			openAt: typeof config.openAt === "string" ? config.openAt : "first-search",
			defaultLimit: Number.isSafeInteger(config.defaultLimit) ? config.defaultLimit : DEFAULT_LIMIT,
			maxLimit: Number.isSafeInteger(config.maxLimit) ? config.maxLimit : MAX_LIMIT,
			snippetChars: Number.isSafeInteger(config.snippetChars) ? config.snippetChars : DEFAULT_SNIPPET_CHARS
		};
		super(ctx, resolved);
		this.config = resolved;
		this._logFailure = process.env.DSH_SESSION_SEARCH_DEBUG === "1";
		// sessionPersistence 在部署里是可选服务，只能走 inject 绑定；
		// 直接 ctx.get 拿不到，会让索引静默变成 0 行。
		this._optionalPersistenceFiber = ctx.inject(["sessionPersistence"], (childCtx) => {
			const binding = { identity: Symbol(), service: childCtx.sessionPersistence };
			this._persistenceBinding = binding;
			childCtx.effect(() => () => {
				if (this._persistenceBinding !== binding) return;
				this._persistenceBinding = { identity: Symbol() };
			}, "sessionSearchPro.persistenceBinding");
		});
		ctx.effect(() => () => this._optionalPersistenceFiber.dispose(), "sessionSearchPro.optionalPersistence");
		ctx.effect(() => async () => this.close(), "sessionSearchPro.close");
		this._log(
			"boot",
			`persistenceVisibleAtBoot=${ctx.get("sessionPersistence") !== void 0} injectAvailable=${typeof ctx.inject === "function"} openAt=${this.config.openAt}`
		);
	}

	/** 当前可用的持久化服务；可选服务尚未就绪时为 undefined。 */
	_persistence() {
		return this._persistenceBinding.service;
	}

	async [Service.init]() {
		if (this.config.openAt === "never") return;
		if (this.config.openAt === "startup") {
			await this._ensureReady(void 0);
			await this._reconcile(void 0);
			return;
		}
		// first-search：不在启动路径上等，但也不等到用户第一次搜索才动手。
		// 首次全量索引要几十秒，挂在搜索上会让第一次搜索像卡死；后台先跑，
		// 用户真去搜时要是还没跑完，`_reconcile` 会让它等同一份 future。
		this._warmup = (async () => {
			await this._ensureReady(void 0);
			await this._reconcile(void 0);
		})().catch((error) => {
			this._log("warmFailed", errorMessage(error));
		});
	}

	close() {
		const db = this._db;
		this._db = null;
		if (db === null) return;
		try {
			db.close();
		} catch {}
	}

	//#region public API

	async searchSessions(request, exec) {
		const normalized = normalizeSessionRequest(request, this.config);
		const signal = exec?.signal;
		return this._serialized(signal, async () => {
			this._assertSearchEnabled();
			await this._ensureReady(signal);
			await this._reconcileForSearch(signal);
			throwIfAborted(signal);
			const offset = normalized.cursor === void 0 ? 0 : decodeCursor(normalized.cursor, this._instance, "sessions", normalized.fingerprint);
			const items = await this._querySessions(normalized, offset);
			const hasMore = items.length > normalized.limit;
			return {
				items: items.slice(0, normalized.limit),
				...(hasMore ? {
					nextCursor: encodeCursor({
						version: 1,
						instance: this._instance,
						scope: "sessions",
						fingerprint: normalized.fingerprint,
						offset: offset + normalized.limit
					})
				} : {})
			};
		});
	}

	async searchEvents(request, exec) {
		const normalized = normalizeEventRequest(request, this.config);
		const signal = exec?.signal;
		return this._serialized(signal, async () => {
			this._assertSearchEnabled();
			await this._ensureReady(signal);
			await this._reconcileForSearch(signal);
			throwIfAborted(signal);
			const header = this._headerOf(normalized.sessionId);
			if (header === void 0) {
				throw new SessionQueryError(`session "${normalized.sessionId}" is not in the search index`, "SESSION_QUERY_SESSION_NOT_FOUND");
			}
			const offset = normalized.cursor === void 0 ? 0 : decodeCursor(normalized.cursor, this._instance, "events", normalized.fingerprint);
			const rows = this._queryDocumentsInSession(normalized.sessionId, normalized.query, normalized.limit + 1, offset);
			const hasMore = rows.length > normalized.limit;
			return {
				session: header,
				items: rows.slice(0, normalized.limit).map((row) => this._eventHit(row, normalized.query)),
				...(hasMore ? {
					nextCursor: encodeCursor({
						version: 1,
						instance: this._instance,
						scope: "events",
						fingerprint: normalized.fingerprint,
						offset: offset + normalized.limit
					})
				} : {})
			};
		});
	}

	//#endregion

	//#region storage

	_assertSearchEnabled() {
		if (this.config.openAt === "never") {
			throw new SessionQueryError("session content search is disabled", "SESSION_QUERY_SEARCH_DISABLED");
		}
	}

	async _ensureReady(signal) {
		if (this._db !== null) return;
		if (this._opening !== void 0) return this._opening;
		const opening = (async () => {
			throwIfAborted(signal);
			const path = this.config.path.length > 0 ? this.config.path : defaultDatabasePath();
			await mkdir(dirname(path), { recursive: true });
			const db = new DatabaseSync(path);
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA synchronous = NORMAL");
			db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
			const current = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
			if (current !== SCHEMA_VERSION) {
				for (const statement of DROP_STATEMENTS) db.exec(statement);
			}
			for (const statement of CREATE_STATEMENTS) db.exec(statement);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			db.prepare("INSERT INTO meta (key, value) VALUES ('generation', '0') ON CONFLICT(key) DO NOTHING").run();
			this._generation = db.prepare(SELECT_META).get("generation")?.value ?? "0";
			this._db = db;
		})();
		this._opening = opening;
		try {
			await opening;
		} finally {
			this._opening = void 0;
		}
	}

	/** 只串行执行，不排队重试：一次慢查询不会堆积成雪崩。 */
	_serialized(signal, run) {
		const step = async () => {
			throwIfAborted(signal);
			return run();
		};
		const next = this._tail.then(step, step);
		this._tail = next.then(() => {}, () => {});
		return next;
	}

	//#endregion

	//#region indexing

	/**
	 * 增量对账是**全局唯一**的：后台预热和用户搜索可能同时触发，
	 * 两个 `BEGIN` 撞在一起会抛 "cannot start a transaction within a transaction"。
	 * 所以同一时刻只跑一遍，后来者等它跑完即可。
	 */
	async _reconcile(signal) {
		const inFlight = this._reconcileInFlight;
		if (inFlight !== void 0) {
			await inFlight;
			return;
		}
		const run = this._reconcileOnce(signal);
		this._reconcileInFlight = run;
		try {
			await run;
		} finally {
			if (this._reconcileInFlight === run) this._reconcileInFlight = void 0;
		}
	}

	/**
	 * 搜索用的对账入口。
	 *
	 * 首次（库里还是空的）必须等索引建完，否则用户第一次搜索只会看到空结果。
	 * 之后就不能再等了：会话一多，增量重读被写过的文件也要好几秒，
	 * 用户每打一个字都卡一遍等于不可用。改成「用现有索引立刻答，改动丢后台」。
	 */
	async _reconcileForSearch(signal) {
		if (this._generation === "0") {
			await this._reconcile(signal);
			return;
		}
		if (this._reconcileInFlight === void 0) {
			this._reconcile(void 0).catch((error) => this._log("bgReconcileFailed", errorMessage(error)));
		}
		throwIfAborted(signal);
	}

	/** 增量对账：只读 revision 变了的会话，单轮变动过的留到下一轮。 */
	async _reconcileOnce(signal) {
		if (this._db === null) return;
		const persistence = this._persistence();
		if (persistence === void 0 || persistence === null) {
			// 曾经踩过：sessionPersistence 是可选的，绑不上时静默 0 行，很难查。
			this._log("noPersistence", "sessionPersistence is not bound; index will stay empty");
			return;
		}
		throwIfAborted(signal);
		let snapshots;
		try {
			snapshots = await persistence.list(signal === void 0 ? void 0 : { signal });
		} catch (error) {
			this._log("listFailed", errorMessage(error));
			return;
		}
		const known = new Map();
		for (const row of this._db.prepare(SELECT_KNOWN_SESSIONS).all()) {
			known.set(row.id, { revision: row.revision, status: Number(row.status) });
		}
		const pending = [];
		for (const snapshot of snapshots) {
			const id = snapshot?.header?.id;
			if (typeof id !== "string") continue;
			const indexed = known.get(id);
			if (indexed === void 0) {
				pending.push(snapshot);
				continue;
			}
			// 读不动的会话（descriptor 版本不支持、日志损坏）永久跳过：
			// 它们往往还在被继续写，revision 每次都会变，重试只会白烧时间。
			if (indexed.status === 0) continue;
			if (indexed.revision === snapshot.revision) continue;
			pending.push(snapshot);
		}
		if (pending.length === 0) return;
		const started = Date.now();
		const collected = [];
		let cursor = 0;
		const lane = async () => {
			for (;;) {
				const index = cursor;
				cursor += 1;
				if (index >= pending.length) return;
				throwIfAborted(signal);
				const snapshot = pending[index];
				try {
					const read = await readColdSessionLog(persistence, snapshot.header.id, signal);
					collected.push({
						snapshot,
						status: 1,
						documents: this._documentsOf(read.events)
					});
				} catch (error) {
					collected.push({ snapshot, status: 0, documents: [] });
					this._log("skipSession", `${snapshot.header.id} ${errorMessage(error)}`);
				}
			}
		};
		const lanes = Math.max(1, Math.min(INDEX_CONCURRENCY, pending.length));
		await Promise.all(Array.from({ length: lanes }, () => lane()));
		throwIfAborted(signal);
		if (collected.length === 0) return;
		this._db.exec("BEGIN");
		try {
			for (const item of collected) this._writeSession(item);
			this._db.exec("COMMIT");
		} catch (error) {
			try {
				this._db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
		this._bumpGeneration();
		this._log("reconcile", `sessions=${collected.length} skipped=${collected.filter((item) => item.status === 0).length} elapsed=${Date.now() - started}ms`);
	}

	/** 只保留用户发言 —— 这是本插件和官方实现的核心差异。 */
	_documentsOf(events) {
		const documents = [];
		for (const event of events) {
			if (event?.type !== USER_MESSAGE_TYPE) continue;
			const text = extractSessionEventText(event);
			if (typeof text !== "string") continue;
			if (text.trim().length === 0) continue;
			documents.push({
				seq: event.seq,
				time: typeof event.time === "number" ? event.time : 0,
				text
			});
		}
		return documents;
	}

	_writeSession({ snapshot, status, documents }) {
		const id = snapshot.header.id;
		const stale = this._db.prepare(SELECT_SESSION_ROWIDS).all(id);
		if (stale.length > 0) {
			const drop = this._db.prepare(DELETE_DOC);
			for (const row of stale) drop.run(row.rowid);
			this._db.prepare(DELETE_DOC_INDEX).run(id);
		}
		const insert = this._db.prepare(INSERT_DOC);
		const insertIndex = this._db.prepare(INSERT_DOC_INDEX);
		for (const document of documents) {
			const result = insert.run(document.text, id, document.seq, document.time, codepointLength(document.text));
			insertIndex.run(Number(result.lastInsertRowid), id);
		}
		this._db.prepare(INSERT_SESSION).run(id, snapshot.revision, JSON.stringify(snapshot.header), status, documents.length, Date.now());
	}

	_bumpGeneration() {
		const current = Number.parseInt(String(this._generation ?? "0"), 10);
		const next = String((Number.isFinite(current) ? current : 0) + 1);
		this._db.prepare(UPSERT_META).run("generation", next);
		this._generation = next;
	}

	//#endregion

	//#region querying

	async _querySessions(normalized, offset) {
		const documents = this._queryDocuments(normalized.query, CANDIDATE_DOCUMENTS);
		if (documents.length === 0) return [];
		const groups = new Map();
		for (const document of documents) {
			const existing = groups.get(document.session_id);
			if (existing === void 0) {
				groups.set(document.session_id, { sessionId: document.session_id, count: 1, best: document, latest: document.time ?? 0 });
				continue;
			}
			existing.count += 1;
			if ((document.time ?? 0) > existing.latest) existing.latest = document.time ?? 0;
		}
		const ordered = [...groups.values()].sort((a, b) => b.count - a.count || b.latest - a.latest);
		const window = ordered.slice(offset, offset + normalized.limit + 1);
		const hits = [];
		for (const group of window) {
			const hit = this._sessionHit(group, normalized.query);
			if (hit !== void 0) hits.push(hit);
		}
		if (window.length > normalized.limit) {
			return hits.slice(0, normalized.limit);
		}
		return hits;
	}

	_queryDocuments(query, limit) {
		if (this._db === null) return [];
		if (needsLiteralSearch(query)) {
			return this._db.prepare(SELECT_CANDIDATES_LIKE).all(likePattern(query), limit);
		}
		return this._db.prepare(SELECT_CANDIDATES_MATCH).all(ftsPhrase(query), limit);
	}

	_queryDocumentsInSession(sessionId, query, limit, offset) {
		if (this._db === null) return [];
		if (needsLiteralSearch(query)) {
			return this._db.prepare(SELECT_SESSION_LIKE).all(sessionId, likePattern(query), limit, offset);
		}
		return this._db.prepare(SELECT_SESSION_MATCH).all(ftsPhrase(query), sessionId, limit, offset);
	}

	_headerOf(sessionId) {
		if (this._db === null) return void 0;
		const row = this._db.prepare(SELECT_SESSION_HEADER).get(sessionId);
		if (row === void 0) return void 0;
		try {
			return JSON.parse(row.header_json);
		} catch {
			return void 0;
		}
	}

	_sessionHit(group, query) {
		const header = this._headerOf(group.sessionId);
		if (header === void 0) return void 0;
		return {
			header,
			live: this._liveIds().has(group.sessionId),
			persisted: true,
			bestMatch: {
				sessionId: group.sessionId,
				seq: SessionSeq(group.best.seq),
				type: USER_MESSAGE_TYPE,
				time: group.best.time ?? 0,
				surface: SURFACE,
				snippet: makeSnippet(group.best.text, query, this.config.snippetChars)
			}
		};
	}

	_eventHit(row, query) {
		return {
			sessionId: row.session_id,
			seq: SessionSeq(row.seq),
			type: USER_MESSAGE_TYPE,
			time: row.time ?? 0,
			surface: SURFACE,
			snippet: makeSnippet(row.text, query, this.config.snippetChars)
		};
	}

	/** 侧栏用 live 标记决定是否显示"运行中"小圆点；两秒缓存够用。 */
	_liveIds() {
		const now = Date.now();
		if (this._liveCache !== void 0 && now - this._liveCache.at < 2000) return this._liveCache.ids;
		const ids = new Set();
		try {
			const sessions = this.ctx.get("sessions");
			const list = typeof sessions?.list === "function" ? sessions.list() : [];
			for (const item of list ?? []) {
				const id = item?.header?.id ?? item?.id;
				if (typeof id === "string") ids.add(id);
			}
		} catch {}
		this._liveCache = { at: now, ids };
		return ids;
	}

	//#endregion

	_log(tag, detail) {
		try {
			const path = logPathOf(this.config.path);
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `[${new Date().toISOString()}] [${tag}] ${detail}\n`);
		} catch {}
	}
};

export { ProSessionQueryEngine };
export default ProSessionQueryEngine;

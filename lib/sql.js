/**
 * 索引库的 SQL 与查询参数构造。
 *
 * 单独拆出来是为了让 test/probe.mjs 能直接 import 同一份 SQL 做离线验证，
 * 而不是在探针里复制一遍（副本测绿了不代表线上那份是对的）。
 */

export const SCHEMA_VERSION = 1;

/** "DSSP" —— 挡住指向其它库的 user_version，避免误删别人的表。 */
export const APPLICATION_ID = 0x44535350;

/** 建表顺序：meta → indexed_sessions → docs_index → docs(fts5)。 */
export const CREATE_STATEMENTS = [
	"CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS indexed_sessions (id TEXT PRIMARY KEY, revision TEXT NOT NULL, header_json TEXT NOT NULL, status INTEGER NOT NULL, doc_count INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
	"CREATE TABLE IF NOT EXISTS docs_index (rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL)",
	"CREATE INDEX IF NOT EXISTS docs_index_session ON docs_index (session_id)",
	// trigram：连续汉字能被 3 字窗口命中；unicode61 会把整段汉字当一个 token。
	"CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(text, session_id UNINDEXED, seq UNINDEXED, time UNINDEXED, codepoint_length UNINDEXED, tokenize = 'trigram')"
];

/** schema 变了就整库重建 —— 派生索引，删了只会慢一次。 */
export const DROP_STATEMENTS = [
	"DROP TABLE IF EXISTS docs",
	"DROP TABLE IF EXISTS docs_index",
	"DROP TABLE IF EXISTS indexed_sessions",
	"DROP TABLE IF EXISTS meta"
];

export const INSERT_DOC = "INSERT INTO docs (text, session_id, seq, time, codepoint_length) VALUES (?, ?, ?, ?, ?)";

export const INSERT_DOC_INDEX = "INSERT INTO docs_index (rowid, session_id) VALUES (?, ?)";

export const INSERT_SESSION = `INSERT INTO indexed_sessions (id, revision, header_json, status, doc_count, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	revision = excluded.revision,
	header_json = excluded.header_json,
	status = excluded.status,
	doc_count = excluded.doc_count,
	updated_at = excluded.updated_at`;

export const SELECT_SESSION_ROWIDS = "SELECT rowid FROM docs_index WHERE session_id = ?";

export const DELETE_DOC = "DELETE FROM docs WHERE rowid = ?";

export const DELETE_DOC_INDEX = "DELETE FROM docs_index WHERE session_id = ?";

export const SELECT_KNOWN_SESSIONS = "SELECT id, revision FROM indexed_sessions";

export const SELECT_SESSION_HEADER = "SELECT header_json FROM indexed_sessions WHERE id = ?";

export const UPSERT_META = "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

export const SELECT_META = "SELECT value FROM meta WHERE key = ?";

/** 跨会话：按相关度取候选文档，会话聚合在 JS 里做。 */
export const SELECT_CANDIDATES_MATCH = `SELECT session_id, seq, time, text, bm25(docs) AS score
FROM docs
WHERE docs MATCH ?
ORDER BY score ASC, time DESC
LIMIT ?`;

export const SELECT_CANDIDATES_LIKE = `SELECT session_id, seq, time, text
FROM docs
WHERE text LIKE ? ESCAPE '\\'
ORDER BY time DESC
LIMIT ?`;

/** 单会话内分页。 */
export const SELECT_SESSION_MATCH = `SELECT session_id, seq, time, text, bm25(docs) AS score
FROM docs
WHERE docs MATCH ? AND session_id = ?
ORDER BY score ASC, seq ASC
LIMIT ? OFFSET ?`;

export const SELECT_SESSION_LIKE = `SELECT session_id, seq, time, text
FROM docs
WHERE session_id = ? AND text LIKE ? ESCAPE '\\'
ORDER BY seq ASC
LIMIT ? OFFSET ?`;

/** FTS5 phrase：内部双引号翻倍，用户写的引号/AND/OR/* 都只当字面量。 */
export function ftsPhrase(query) {
	return `"${query.split("\"").join("\"\"")}"`;
}

/** 命中位置附近的窗口，前后用 … 表示被截断。 */
export function makeSnippet(text, query, maxChars) {
	const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 240;
	if (text.length <= limit) return text;
	const index = text.toLowerCase().indexOf(query.toLowerCase());
	if (index < 0) return `${text.slice(0, limit)}…`;
	const lead = Math.floor(limit / 3);
	let start = Math.max(0, index - lead);
	let end = Math.min(text.length, start + limit);
	start = Math.max(0, end - limit);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** LIKE 模式：转义 `\` `%` `_`，前后包通配。 */
export function likePattern(query) {
	let escaped = "";
	for (const char of query) {
		if (char === "\\" || char === "%" || char === "_") escaped += "\\";
		escaped += char;
	}
	return `%${escaped}%`;
}

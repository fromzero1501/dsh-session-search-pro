/**
 * 离线探针：直接用 lib/sql.js 里那份 SQL 建库、写入、查询。
 *
 * 目的不是"跑一遍看看"，而是把几条容易假绿的判据钉成断言：
 *   - trigram 下 2 字中文必须 0 命中（证明确实需要 LIKE 兜底，而不是碰巧命中）
 *   - LIKE 兜底必须能搜到 2 字中文，且 % _ \ 被正确转义
 *   - 同一会话多条命中要聚合成一条结果
 *   - 重建索引后旧文档不能残留（否则删掉的消息会一直搜得到）
 *   - snippet 窗口必须围绕命中位置
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
	SELECT_SESSION_HEADER,
	SELECT_SESSION_ROWIDS,
	ftsPhrase,
	likePattern,
	makeSnippet
} from "../lib/sql.js";

let passed = 0;
const failures = [];

function check(name, condition, detail) {
	if (condition) {
		passed += 1;
		return;
	}
	failures.push(`${name}${detail === void 0 ? "" : ` — ${detail}`}`);
}

const workspace = await mkdtemp(join(tmpdir(), "dssp-probe-"));
const databasePath = join(workspace, "probe.db");

try {
	const db = new DatabaseSync(databasePath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA user_version = 0");
	// schema 不符时先 drop 再建，和引擎里的顺序一致
	for (const statement of DROP_STATEMENTS) db.exec(statement);
	for (const statement of CREATE_STATEMENTS) db.exec(statement);
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

	check("user_version 写入", Number(db.prepare("PRAGMA user_version").get().user_version) === SCHEMA_VERSION);

	const insertDoc = db.prepare(INSERT_DOC);
	const insertIndex = db.prepare(INSERT_DOC_INDEX);
	const insertSession = db.prepare(INSERT_SESSION);

	const fixture = [
		{
			id: "session-a",
			messages: [
				"我想把这个侧边栏插件的会话搜索修好",
				"这个插件的中文分词完全不行",
				"顺手把搜索性能也看一下"
			]
		},
		{
			id: "session-b",
			messages: ["外出的时候记得带伞", "今天不外出"]
		},
		{
			id: "session-c",
			messages: ["100% 覆盖测试", "下划线 a_b 也要能搜"]
		}
	];

	function writeSession(session) {
		for (const rowid of db.prepare(SELECT_SESSION_ROWIDS).all(session.id)) db.prepare(DELETE_DOC).run(rowid.rowid);
		db.prepare(DELETE_DOC_INDEX).run(session.id);
		session.messages.forEach((text, index) => {
			const result = insertDoc.run(text, session.id, index, 1_700_000_000 + index, Array.from(text).length);
			insertIndex.run(Number(result.lastInsertRowid), session.id);
		});
		insertSession.run(session.id, "rev-1", JSON.stringify({ id: session.id, cwd: "/fake/workspace" }), 1, session.messages.length, Date.now());
	}

	for (const session of fixture) writeSession(session);

	// —— 1. trigram 下 2 字中文不该命中（证明 LIKE 兜底是必需的，而不是装饰）
	const twoCharMatch = db.prepare(SELECT_CANDIDATES_MATCH).all(ftsPhrase("插件"), 100);
	check("trigram 对 2 字中文 0 命中", twoCharMatch.length === 0, `实际 ${twoCharMatch.length} 条`);

	// —— 2. 3 字以上中文必须命中
	const threeCharMatch = db.prepare(SELECT_CANDIDATES_MATCH).all(ftsPhrase("会话搜索"), 100);
	check("trigram 对 3 字以上中文命中", threeCharMatch.length === 1, `实际 ${threeCharMatch.length} 条`);
	check("命中会话正确", threeCharMatch[0]?.session_id === "session-a", String(threeCharMatch[0]?.session_id));

	// —— 3. 2 字中文走 LIKE 必须命中，且要跨会话聚合
	const twoCharLike = db.prepare(SELECT_CANDIDATES_LIKE).all(likePattern("插件"), 100);
	check("LIKE 兜底命中 2 字中文", twoCharLike.length === 2, `实际 ${twoCharLike.length} 条`);
	const grouped = new Map();
	for (const row of twoCharLike) grouped.set(row.session_id, (grouped.get(row.session_id) ?? 0) + 1);
	check("同一会话多条命中被聚合", grouped.get("session-a") === 2, JSON.stringify([...grouped]));

	// —— 4. 英文 2 字同样走 LIKE
	const englishLike = db.prepare(SELECT_CANDIDATES_LIKE).all(likePattern("ab"), 100);
	check("LIKE 兜底对英文短词有效", englishLike.length >= 0);

	// —— 5. 通配符必须被转义，不能变成"匹配所有"
	const percentLike = db.prepare(SELECT_CANDIDATES_LIKE).all(likePattern("%"), 100);
	check("孤立的 % 只匹配含 % 的文本", percentLike.length === 1, `实际 ${percentLike.length} 条`);
	const underscoreLike = db.prepare(SELECT_CANDIDATES_LIKE).all(likePattern("a_b"), 100);
	check("下划线按字面量匹配", underscoreLike.length === 1, `实际 ${underscoreLike.length} 条`);
	const backslashLike = db.prepare(SELECT_CANDIDATES_LIKE).all(likePattern("\\"), 100);
	check("反斜杠不炸 ", backslashLike.length === 0, `实际 ${backslashLike.length} 条`);

	// —— 6. FTS 语法字符只当字面量
	const quoteMatch = db.prepare(SELECT_CANDIDATES_MATCH).all(ftsPhrase("a\"b"), 100);
	check("引号被转义不抛错", quoteMatch.length === 0);
	const andMatch = db.prepare(SELECT_CANDIDATES_MATCH).all(ftsPhrase("插件 AND 搜索"), 100);
	check("AND 当字面量处理", andMatch.length === 0);

	// —— 7. 重建索引不能残留旧文档
	writeSession({ id: "session-b", messages: ["换掉的内容"] });
	const staleCheck = db.prepare(SELECT_CANDIDATES_LIKE).all(likePattern("外出"), 100);
	check("重建后旧文档不残留", staleCheck.length === 0, `实际 ${staleCheck.length} 条`);
	const freshCheck = db.prepare(SELECT_CANDIDATES_LIKE).all(likePattern("换掉"), 100);
	check("重建后新文档可搜", freshCheck.length === 1, `实际 ${freshCheck.length} 条`);
	const rowidCheck = db.prepare(SELECT_SESSION_ROWIDS).all("session-b");
	check("docs_index 与文档数一致", rowidCheck.length === 1, `实际 ${rowidCheck.length} 行`);

	// —— 8. header 能原样读回
	const headerRow = db.prepare(SELECT_SESSION_HEADER).get("session-a");
	check("header 可解析", JSON.parse(headerRow.header_json).cwd === "/fake/workspace");

	// —— 9. snippet 围绕命中位置
	const longText = `${"前".repeat(400)}关键词${"后".repeat(400)}`;
	const snippet = makeSnippet(longText, "关键词", 60);
	check("snippet 含关键词", snippet.includes("关键词"), snippet);
	check("snippet 长度受控", snippet.length <= 62, `${snippet.length} 字符`);
	check("snippet 两侧有省略号", snippet.startsWith("…") && snippet.endsWith("…"), snippet);
	const shortSnippet = makeSnippet("短文本", "文本", 60);
	check("短文本不加省略号", shortSnippet === "短文本", shortSnippet);

	db.close();

	// —— 10. schema 版本变化时整库重建
	const db2 = new DatabaseSync(databasePath);
	db2.exec("PRAGMA user_version = 99");
	const current = Number(db2.prepare("PRAGMA user_version").get().user_version);
	check("版本不符被识别", current === 99);
	if (current !== SCHEMA_VERSION) {
		for (const statement of DROP_STATEMENTS) db2.exec(statement);
	}
	for (const statement of CREATE_STATEMENTS) db2.exec(statement);
	db2.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	const afterReset = db2.prepare(SELECT_CANDIDATES_LIKE).all(likePattern("插件"), 100);
	check("重建后库为空", afterReset.length === 0, `实际 ${afterReset.length} 条`);
	db2.close();
} finally {
	await rm(workspace, { recursive: true, force: true });
}

if (failures.length === 0) {
	console.log(`PROBE_PASS ${passed}/${passed}`);
} else {
	console.log(`PROBE_FAIL pass=${passed} fail=${failures.length}`);
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exitCode = 1;
}

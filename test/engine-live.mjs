/**
 * 真语料联调：拿宿主的真实 sessions 目录做一次完整索引 + 查询。
 *
 * 这一层比 probe.mjs 重，但能证明"插件 apply → 引擎 → 真实 persistence → 真实
 * 多帧 zstd 日志"整条链路接得上。必须用 Electron 的 node 模式跑（宿主包在
 * app.asar 内）：
 *
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "<...>\DeepSeek Harness.exe" test/engine-live.mjs [查询词]
 */
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importHostPackage } from "../lib/host.js";
import * as plugin from "../lib/index.js";

const SESSIONS_ROOT = "C:\\Users\\Administrator\\AppData\\Roaming\\dsh-desktop\\harness\\sessions";
const QUERY = process.argv[2] ?? "插件";

const checks = [];
function check(name, condition, detail) {
	checks.push({ name, ok: Boolean(condition), detail });
}

const cordis = await importHostPackage("@deepseek-ai/cordis");
const jsonl = await importHostPackage("@deepseek-ai/dsh-session-persistence-jsonl");

const workspace = await mkdtemp(join(tmpdir(), "dssp-live-"));
// 给了 SSP_LIVE_DB 就复用那份库：第一次跑建索引，第二次跑验增量与缓存。
const databasePath = process.env.SSP_LIVE_DB ?? join(workspace, "live.db");

try {
	check("sessions 目录存在", existsSync(SESSIONS_ROOT), SESSIONS_ROOT);
	const ctx = new cordis.Context();
	ctx.provide("sessions");
	ctx.set("sessions", { list: () => [], get: () => void 0 });
	ctx.plugin({ name: "live-persistence", apply: jsonl.apply, Config: jsonl.Config }, { root: SESSIONS_ROOT });
	await new Promise((resolve) => setTimeout(resolve, 200));
	await plugin.apply(ctx, { path: databasePath, openAt: "first-search" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	const engine = ctx.get("sessionQuery");
	check("sessionQuery 已注册", engine !== void 0);
	if (engine === void 0) throw new Error("sessionQuery was not registered");

	const startedAt = Date.now();
	const first = await engine.searchSessions({ query: QUERY, limit: 5 });
	const firstMs = Date.now() - startedAt;
	console.log(`首次搜索 ${firstMs} ms，命中 ${first.items.length} 条（hasMore=${first.nextCursor !== void 0}）`);
	// inject 回调是异步的，apply 之后同步读到的一定是 undefined，搜索跑完才有定论
	check("persistence 已绑定", engine._persistence() !== void 0);

	const db = new DatabaseSync(databasePath, { readOnly: true });
	const sessions = db.prepare("SELECT COUNT(*) c FROM indexed_sessions").get().c;
	const docs = db.prepare("SELECT COUNT(*) c FROM docs").get().c;
	const skipped = db.prepare("SELECT COUNT(*) c FROM indexed_sessions WHERE status = 0").get().c;
	db.close();
	console.log(`索引：会话 ${sessions} 个、文档 ${docs} 条、跳过 ${skipped} 个`);

	check("索引写入了会话", sessions > 0, `实际 ${sessions}`);
	check("索引写入了文档", docs > 0, `实际 ${docs}`);
	check("搜索有命中", first.items.length > 0, `实际 ${first.items.length} 条`);
	check("命中项有 header", typeof first.items[0]?.header?.id === "string");
	check("命中项有 snippet", typeof first.items[0]?.bestMatch?.snippet === "string" && first.items[0].bestMatch.snippet.length > 0);
	check("命中项带高亮标记或包含查询词", first.items.length === 0 || first.items.some((item) => item.bestMatch.snippet.includes(QUERY)));

	const secondStartedAt = Date.now();
	const second = await engine.searchSessions({ query: QUERY, limit: 5 });
	const secondMs = Date.now() - secondStartedAt;
	console.log(`二次搜索 ${secondMs} ms`);
	check("二次搜索命中一致", second.items.length === first.items.length, `${first.items.length} vs ${second.items.length}`);
	check("二次搜索明显更快", secondMs < Math.max(600, firstMs / 2), `${firstMs} → ${secondMs}`);

	if (first.nextCursor !== void 0) {
		const page2 = await engine.searchSessions({ query: QUERY, limit: 5, cursor: first.nextCursor });
		check("翻页可用", Array.isArray(page2.items));
	}

	engine.close();

	const logPath = join(workspace, "session-search-pro.log");
	if (existsSync(logPath)) {
		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		console.log(`--- 日志 ${lines.length} 行，尾部 20 行 ---`);
		for (const line of lines.slice(-20)) console.log(line);
	}
} finally {
	await rm(workspace, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok || item.detail === void 0 ? "" : ` — ${item.detail}`}`);
console.log(failed.length === 0 ? `LIVE_PASS ${checks.length}/${checks.length}` : `LIVE_FAIL pass=${checks.length - failed.length} fail=${failed.length}`);
if (failed.length > 0) process.exitCode = 1;

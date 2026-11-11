/**
 * 引擎冒烟：确认插件能被宿主加载（import 解析、构造、Config 归一、无依赖时不炸）。
 *
 * 这里不伪造 persistence，所以搜不到东西 —— 验的是"能不能起来"。
 * 服务是否挂到 ctx.sessionQuery 由 cordis 在宿主里调 ctx.plugin 时决定，
 * 裸 new 一个 root Context 观测不到，故不在本探针断言。
 * 真实索引行为由宿主重启后的验收探针负责。
 */
import { Context } from "@deepseek-ai/cordis";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../lib/index.js";

const checks = [];
function check(name, condition, detail) {
	checks.push({ name, ok: Boolean(condition), detail });
}

const ctx = new Context();
let engine;
let error;
try {
	engine = new Engine(ctx, { path: "", openAt: "first-search" });
} catch (cause) {
	error = cause;
}

check("引擎可构造", error === void 0, error?.message);
check("服务已注册到 sessionQuery", ctx.get("sessionQuery") !== void 0);
check("继承 SessionQueryEngine", typeof engine?.searchSessions === "function" && typeof engine?.searchEvents === "function");
check("父类方法可用", typeof engine?.listSessions === "function" && typeof engine?.readSession === "function");
check("继承自基类", engine instanceof (await import("@deepseek-ai/dsh-session-query")).default);
check("Config 归一：path", engine?.config?.path === "");
check("Config 归一：openAt", engine?.config?.openAt === "first-search");
check("Config 归一：limits", engine?.config?.defaultLimit === 20 && engine?.config?.maxLimit === 100);
check("Config 归一：snippetChars", engine?.config?.snippetChars === 240);
check("可选 persistence 未就绪时不抛错", engine?._persistence() === void 0);
check("没有 persistence 时搜索返回空而不是抛错", await (async () => {
	// 必须用临时库：默认库会落到真实 harness 目录，那里可能早有索引，
	// 断言「空结果」就会因为读到别人的索引而假红。
	const isolated = new Engine(new Context(), { path: join(mkdtempSync(join(tmpdir(), "ssp-smoke-")), "a.db"), openAt: "first-search" });
	try {
		const result = await isolated.searchSessions({ query: "冒烟" });
		return Array.isArray(result?.items) && result.items.length === 0;
	} catch (cause) {
		return `抛错: ${cause?.code ?? ""} ${cause?.message ?? cause}`;
	} finally {
		isolated.close();
	}
})() === true);
check("searchEvents 缺 sessionId 时抛参数错误", await (async () => {
	try {
		await engine.searchEvents({ query: "冒烟" });
		return false;
	} catch (cause) {
		return typeof cause?.code === "string";
	}
})() === true);
check("openAt=never 时拒绝搜索", await (async () => {
	// 同一 ctx 只能注册一个 sessionQuery，故另起一个 Context
	const other = new Engine(new Context(), { path: "", openAt: "never" });
	try {
		await other.searchSessions({ query: "冒烟" });
		return false;
	} catch (cause) {
		return cause?.code === "SESSION_QUERY_SEARCH_DISABLED";
	}
})() === true);
check("关闭不抛错", (() => {
	try {
		engine.close();
		return true;
	} catch {
		return false;
	}
})());

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok || item.detail === void 0 ? "" : ` — ${item.detail}`}`);
console.log(failed.length === 0 ? `ENGINE_PASS ${checks.length}/${checks.length}` : `ENGINE_FAIL pass=${checks.length - failed.length} fail=${failed.length}`);
if (failed.length > 0) process.exitCode = 1;

/**
 * 引擎冒烟：确认插件能被宿主加载（宿主包运行时解析、apply 挂载、Config 归一、
 * 无 persistence 时不炸、openAt 语义正确）。
 *
 * 必须用 Electron 的 node 模式跑（宿主包在 app.asar 内，普通 node 读不了）：
 *
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "<...>\DeepSeek Harness.exe" test/engine-smoke.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importHostPackage } from "../lib/host.js";
import * as plugin from "../lib/index.js";

const checks = [];
function check(name, condition, detail) {
	checks.push({ name, ok: Boolean(condition), detail });
}

const cordis = await importHostPackage("@deepseek-ai/cordis");
const queryModule = await importHostPackage("@deepseek-ai/dsh-session-query");

/** 起一个最小宿主：假 sessions 服务 + apply 插件，返回 ctx 与注册上来的服务。 */
async function mount(config) {
	const ctx = new cordis.Context();
	ctx.provide("sessions");
	ctx.set("sessions", { list: () => [], get: () => void 0 });
	await plugin.apply(ctx, config);
	await new Promise((resolve) => setTimeout(resolve, 400));
	return { ctx, service: ctx.get("sessionQuery") };
}

const main = await mount({ path: join(mkdtempSync(join(tmpdir(), "ssp-smoke-")), "a.db"), openAt: "first-search" });
const engine = main.service;

check("服务已注册到 sessionQuery", engine !== void 0);
check("继承 SessionQueryEngine", engine instanceof queryModule.SessionQueryEngine || engine instanceof queryModule.default);
check("搜索方法可用", typeof engine?.searchSessions === "function" && typeof engine?.searchEvents === "function");
check("父类方法可用", typeof engine?.listSessions === "function" && typeof engine?.readSession === "function");
check("Config 归一：openAt", engine?.config?.openAt === "first-search");
check("Config 归一：limits", engine?.config?.defaultLimit === 20 && engine?.config?.maxLimit === 100);
check("Config 归一：snippetChars", engine?.config?.snippetChars === 240);
check("可选 persistence 未就绪时不抛错", engine?._persistence() === void 0);
check("没有 persistence 时搜索返回空而不是抛错", await (async () => {
	try {
		const result = await engine.searchSessions({ query: "冒烟" });
		return Array.isArray(result?.items) && result.items.length === 0;
	} catch (cause) {
		return `抛错: ${cause?.code ?? ""} ${cause?.message ?? cause}`;
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

// 同一 ctx 只能注册一个 sessionQuery，openAt=never 另起一套
const never = await mount({ path: "", openAt: "never" });
check("openAt=never 时拒绝搜索", await (async () => {
	try {
		await never.service.searchSessions({ query: "冒烟" });
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
for (const item of checks) {
	console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok || item.detail === void 0 ? "" : ` — ${item.detail}`}`);
}
console.log(failed.length === 0 ? `ENGINE_PASS ${checks.length}/${checks.length}` : `ENGINE_FAIL pass=${checks.length - failed.length} fail=${failed.length}`);
if (failed.length > 0) process.exitCode = 1;

/**
 * apply 冒烟：验证「宿主包运行时解析 + 动态定义子类 + ctx.plugin」这条链路能
 * 真正把 sessionQuery 服务注册上。必须用 Electron 的 node 模式跑（普通 node
 * 读不了 app.asar）：
 *
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "<...>\DeepSeek Harness.exe" test/apply-smoke.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importHostPackage, resolveHostEntry } from "../lib/host.js";

const results = [];
function check(label, ok, detail = "") {
	results.push({ label, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  ${detail}`}`);
}

const resolvedQuery = resolveHostEntry("@deepseek-ai/dsh-session-query");
check("能定位宿主 dsh-session-query", resolvedQuery !== void 0, resolvedQuery ?? "");

const cordis = await importHostPackage("@deepseek-ai/cordis");
const ctx = new cordis.Context();
// 插件声明了 inject=["sessions"]，cordis 会等这个服务就绪才 apply；真实宿主里
// 由 dsh-session 提供，这里给一个最小替身，否则插件永远不启动。
ctx.provide("sessions");
ctx.set("sessions", { list: () => [], get: () => void 0 });
const plugin = await import("../lib/index.js");
check("插件模块可加载（无静态宿主 import）", typeof plugin.apply === "function");
check("声明 inject=sessions", Array.isArray(plugin.inject) && plugin.inject.includes("sessions"));

const databasePath = join(mkdtempSync(join(tmpdir(), "ssp-apply-")), "a.db");
await plugin.apply(ctx, { path: databasePath, openAt: "first-search", defaultLimit: 20, maxLimit: 100, snippetChars: 240 });
await new Promise((resolve) => setTimeout(resolve, 500));

const service = ctx.get("sessionQuery");
check("sessionQuery 已注册", service !== void 0);
check("注册的是自己的引擎", service !== void 0 && typeof service.searchSessions === "function");
if (service !== void 0) {
	check("基类方法可用（listSessions）", typeof service.listSessions === "function");
	check("基类方法可用（observeSession）", typeof service.observeSession === "function");
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\nAPPLY_${failed.length === 0 ? "PASS" : "FAIL"} pass=${results.length - failed.length} fail=${failed.length}`);
process.exitCode = failed.length === 0 ? 0 : 1;

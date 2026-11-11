/**
 * 在宿主运行时里定位并加载 `@deepseek-ai/*` 包。
 *
 * 为什么需要这一层：DSH 0.2.x 把应用打进了 `resources/app.asar`，宿主包位于
 * `app.asar/dsh/node_modules/@deepseek-ai/*`。插件目录里的 `node_modules` 不再
 * 提供这些包（升级前是 junction，升级后消失），所以插件入口里任何
 * `import ... from "@deepseek-ai/dsh-session-query"` 都会在加载期抛
 * ERR_MODULE_NOT_FOUND —— 插件静默不加载，ctx.sessionQuery 无人提供。
 *
 * 普通 node 无法读 asar（fs 没有 asar 补丁），但宿主主进程里的 `node:fs` 是
 * Electron 打过补丁的，可以直接读 asar 内的 package.json，再按 exports/main
 * 拼出 file URL 动态 import。用同一个 file URL import，会命中宿主自己那份
 * ESM 实例缓存，从而与宿主共用同一个 cordis / Service，服务注册才生效。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function moduleSearchRoots() {
	const roots = [];
	const resourcesPath = process.resourcesPath;
	if (typeof resourcesPath === "string" && resourcesPath.length > 0) {
		roots.push(join(resourcesPath, "app.asar", "dsh", "node_modules"));
		roots.push(join(resourcesPath, "app.asar.unpacked", "dsh", "node_modules"));
		roots.push(join(resourcesPath, "app", "dsh", "node_modules"));
	}
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 10; depth += 1) {
		roots.push(join(dir, "node_modules"));
		const parent = dirname(dir);
		if (parent === dir || parent.endsWith(`${sep}`)) break;
		dir = parent;
	}
	return [...new Set(roots)];
}

function packageDirectory(name, roots) {
	for (const root of roots) {
		const candidate = join(root, ...name.split("/"));
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
	return void 0;
}

function pickCondition(value) {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return void 0;
	for (const key of ["import", "module", "node", "default"]) {
		if (key in value) {
			const picked = pickCondition(value[key]);
			if (picked !== void 0) return picked;
		}
	}
	return void 0;
}

function entryPointOf(directory) {
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const exportsField = manifest.exports;
	if (exportsField !== void 0) {
		const root = typeof exportsField === "object" && exportsField !== null && "." in exportsField ? exportsField["."] : exportsField;
		const picked = pickCondition(root);
		if (picked !== void 0) return join(directory, picked);
	}
	if (typeof manifest.main === "string") return join(directory, manifest.main);
	return join(directory, "index.js");
}

/** 解析包入口的绝对路径；找不到返回 undefined。 */
export function resolveHostEntry(name) {
	const directory = packageDirectory(name, moduleSearchRoots());
	return directory === void 0 ? void 0 : entryPointOf(directory);
}

/** 动态 import 一个宿主包；路径解析失败时抛错（调用方负责记录）。 */
export async function importHostPackage(name) {
	const entry = resolveHostEntry(name);
	if (entry === void 0) {
		throw new Error(`cannot locate ${name}; searched ${moduleSearchRoots().join(" ; ")}`);
	}
	return import(pathToFileURL(entry).href);
}

/** 一次性加载本插件依赖的全部宿主模块。 */
export async function loadHostModules() {
	const [cordis, schemastery, session, query] = await Promise.all([
		importHostPackage("@deepseek-ai/cordis"),
		importHostPackage("@deepseek-ai/schemastery"),
		importHostPackage("@deepseek-ai/dsh-session"),
		importHostPackage("@deepseek-ai/dsh-session-query")
	]);
	const Service = cordis.Service;
	const z = schemastery.default ?? schemastery.z ?? schemastery;
	const engineBase = query.SessionQueryEngine ?? query.default;
	if (typeof Service !== "function") throw new Error("@deepseek-ai/cordis does not export Service");
	if (typeof engineBase !== "function") throw new Error("@deepseek-ai/dsh-session-query does not export SessionQueryEngine");
	if (typeof z !== "function" && typeof z?.object !== "function") throw new Error("@deepseek-ai/schemastery does not export z");
	return { Service, z, SessionSeq: session.SessionSeq, engineBase, query };
}

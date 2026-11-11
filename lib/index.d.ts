import type { Context } from "@deepseek-ai/cordis";

/**
 * 索引库路径、打开时机与分页/snippet 上限。
 *
 * 注意：插件不再默认导出 class。宿主包（`@deepseek-ai/*`）在 DSH 0.2.x 之后只存在于
 * `resources/app.asar` 内，只能在 `apply()` 里运行时解析，所以入口是 cordis 的
 * apply 形态（见 `lib/host.js`）。
 */
export interface Config {
	/**
	 * 索引库文件路径；空串落到 `<DSH_HOME>/cache/session-search-pro.db`。
	 *
	 * 必须是**派生物**，绝不能指向 `sessions/` 里的任何位置 —— 删掉它会重建，
	 * 不影响任何会话数据。同一个路径只能被一个进程中的一个实例打开。
	 */
	path?: string;
	/** `startup` 启动即建索引（拖慢启动）；`first-search` 启动后台预热；`never` 关闭内容检索。 */
	openAt?: "startup" | "first-search" | "never";
	/** 单页默认条数，默认 20。 */
	defaultLimit?: number;
	/** 单页上限，默认 100。 */
	maxLimit?: number;
	/** snippet 摘要窗口字符数，默认 240。 */
	snippetChars?: number;
}

/** 插件名，供 cordis 展示。 */
export declare const name: string;

/** 等 `sessions` 服务就绪再 apply。 */
export declare const inject: string[];

/**
 * 插件入口：加载宿主模块 → 就地定义 `ProSessionQueryEngine` 子类 → `ctx.plugin`。
 *
 * 与官方 `dsh-session-query-sqlite` 的差异：只索引 `user/message`、FTS5 用
 * `trigram` 分词（<3 字符走 `LIKE` 兜底）、坏会话标记 `status=0` 永久跳过、
 * 不要求磁盘快照在读前读后一致（对话进行中也能搜）。
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;

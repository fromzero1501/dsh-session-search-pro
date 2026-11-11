import type { Context } from "@deepseek-ai/cordis";
import type SessionQueryEngine from "@deepseek-ai/dsh-session-query";

/** 索引库路径、打开时机与分页/snippet 上限。 */
export interface Config {
	/**
	 * 索引库文件路径。
	 *
	 * 必须是**派生物**，绝不能指向 `sessions/` 里的任何位置 —— 删掉它会重建，
	 * 不影响任何会话数据。同一个路径只能被一个进程中的一个实例打开。
	 */
	path?: string;
	/** `startup` 启动即建索引（拖慢启动）；`first-search` 首次搜索时建；`never` 关闭内容检索。 */
	openAt?: "startup" | "first-search" | "never";
	/** 单页默认条数。 */
	defaultLimit?: number;
	/** 单页上限。 */
	maxLimit?: number;
	/** snippet 摘要窗口字符数。 */
	snippetChars?: number;
}

/**
 * 顶掉 `@deepseek-ai/dsh-session-query-sqlite` 的 `sessionQuery` 后端。
 *
 * 只实现 `searchSessions` 与 `searchEvents`；`listSessions`、`readSession`、
 * `readSurface`、`traceSession` 等 12 个方法由基类 `SessionQueryEngine` 提供。
 *
 * 与官方实现的差异：只索引 `user/message`、FTS5 用 `trigram` 分词（<3 字符走
 * `LIKE` 兜底）、坏会话标记 `status=0` 永久跳过、不要求磁盘快照在读前读后一致。
 */
declare class ProSessionQueryEngine extends SessionQueryEngine {
	constructor(ctx: Context, config?: Config);
	/** 幂等关闭索引库；重复调用是安全的。 */
	close(): Promise<void>;
}

export { ProSessionQueryEngine };
export default ProSessionQueryEngine;

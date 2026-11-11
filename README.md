# dsh-session-search-pro

给 DeepSeek Harness（DSH）侧边栏搜索换上**能搜中文**的后端：用你自己说过的话，检索**全部会话**（跨所有工作区）。

它顶掉官方的 `@deepseek-ai/dsh-session-query-sqlite`，接管 `ctx.sessionQuery` 服务。侧边栏搜索框、Command+K、结果跳转、snippet 高亮全部沿用官方实现，**不需要改 UI**。

## 它解决什么

官方的会话全文检索默认关闭，打开之后还有四个坑，中文用户基本踩满：

| 问题 | 官方行为 | 本插件 |
|---|---|---|
| 中文分词 | FTS5 `tokenize='unicode61'` 把一整段连续汉字当一个 token，搜「插件」「搜索」**0 命中且不报错** | `trigram`，≥3 字符命中；<3 字符自动走 `LIKE` 兜底 |
| 索引内容 | `user/message`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`turn/end` 全收 | **只收 `user/message`** —— 你要找的是自己说过的话，索引体积小一个数量级 |
| 单个坏会话 | 读取错误无容错，一个损坏的 jsonl 让整轮索引失败，宿主吞错后静默回落为「只搜标题」 | 该会话标 `status=0` 永久跳过，其余照常索引 |
| 磁盘快照稳定 | 要求读前读后快照完全一致才写库；当前正在对话的会话每几秒追加一次，**4 次重试耗尽即抛 `SESSION_QUERY_PERSISTENCE_FAILED`** | 本轮变动过的会话留到下一轮，不整轮重试 —— 对话进行中也能搜 |

## 安装

plugin 目录需要放进 profile 的 `node_modules`，并在 profile 清单里登记两次（依赖 + bundle）。

```bash
# 1. 放进 profile（Windows 用 junction，避免复制）
mklink /J "%APPDATA%\dsh-desktop\harness\profiles\desktop\node_modules\dsh-session-search-pro" "<本仓库绝对路径>"
```

`profiles\desktop\package.json` 两处：

```jsonc
{
  "dependencies": {
    "dsh-session-search-pro": "link:<本仓库绝对路径，正斜杠>"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* ...原有条目..., */ "dsh-session-search-pro" ]  // 放最后，保证 patch 最后应用
    }
  }
}
```

放最后的原因：`cordis.patch.yml` 要覆盖前面 bundle 已经插进树里的 `session-query-sqlite` 条目，patch 层是**按顺序后者胜**。

重启 DSH 生效。

## 配置

`cordis.patch.yml` 已经配好默认值：

```yaml
- id: session-query-sqlite
  disabled: true

- insert:
    - id: session-search-pro
      name: 'dsh-session-search-pro'
      config:
        path: !!js dshHomePath('cache/session-search-pro.db')
        openAt: first-search
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `path` | `dshHomePath('cache/session-search-pro.db')` | 索引库路径。**不要**指向 `sessions/` 目录里面的任何位置 |
| `openAt` | `first-search` | `startup` 启动即建索引（会拖慢启动）／`first-search` 首次搜索时建／`never` 关闭 |
| `defaultLimit` | `20` | 单页条数 |
| `maxLimit` | `100` | 单页上限 |
| `snippetChars` | `240` | 摘要窗口字符数 |

## 性能基线

真实语料（656 个会话、21,450 条用户消息、宿主日志合计 418 MB）：

- **首次索引 60–90 秒**（一次性，之后复用索引）
- 二次搜索 **0.6–17 秒**（取决于残留会话的增量对账量）
- ≥3 字符中文 → FTS5 `MATCH`，亚毫秒
- 2 字符中文 → `LIKE '%…%'` 扫 2 万条文档，100–200 毫秒

首次索引慢是因为要解压全部会话并做 `Session.create` 重放校验。这是必要成本：不重放就存在把损坏日志当正常内容索引进去的风险。

## 已知限制

- 只能搜**用户发言**。想连 assistant 回复一起搜，把 `lib/index.js` 里 `_documentsOf` 的 `event?.type !== USER_MESSAGE_TYPE` 判据去掉。
- `trigram` 对 2 字符以下的中文只能靠 `LIKE`，文档量再涨一个数量级会变慢。
- 索引是派生物：删掉 `cache/session-search-pro.db` 会重建，不影响任何会话数据。
- 只在 Windows + DSH 0.2.x 上验证过。

## 卸载

```bash
# 1. profile package.json 里删掉 dependencies 与 bundles 里的 dsh-session-search-pro
# 2. 删掉 junction
rmdir "%APPDATA%\dsh-desktop\harness\profiles\desktop\node_modules\dsh-session-search-pro"
```

删掉后官方 `session-query-sqlite` 会用回 base 默认的 `openAt: never`（即侧栏只搜标题）。

## 宿主升级到 asar 打包之后（0.2.x）

从某版开始，DSH 把应用打进 `resources/app.asar`，宿主包位于
`app.asar/dsh/node_modules/@deepseek-ai/*`，**插件目录的 node_modules 里不再有这些包**
（升级前它们是指向宿主的 junction，升级后消失）。此时插件入口里任何
`import ... from "@deepseek-ai/dsh-session-query"` 都会在加载期抛
`ERR_MODULE_NOT_FOUND`，插件静默不加载；而本插件的 patch 又用 `disabled: true`
关掉了官方 `session-query-sqlite`，于是 `sessionQuery` 无人提供 →
`sessionController` 报 service-unavailable → **新建会话直接失败**。

解决方式是 `lib/host.js`：在运行时按
`process.resourcesPath/app.asar/dsh/node_modules`（再回退 `app.asar.unpacked`、
`app`、逐级 `node_modules`）定位包，读它的 `package.json` 取 `exports`/`main`，
再用 `import(pathToFileURL(entry))` 动态加载。宿主主进程的 `node:fs` 带 asar 补丁，
所以能读 asar 内的文件；用同一个 file URL import 会命中宿主的 ESM 缓存，
拿到的是**同一份** cordis / `Service`，`sessionQuery` 注册才生效。

因此插件入口不是默认导出 class，而是：

```js
export const inject = ["sessions"];
export async function apply(ctx, config) { /* 动态加载宿主 → 定义子类 → ctx.plugin */ }
```

### 如果升级后又起不来

1. 看 `<db 目录>/session-search-pro.log`，最后一行的 `[applyFailed]` 会写清是哪个包没定位到。
2. 紧急恢复会话功能：删掉本包 `cordis.patch.yml` 里
   `- id: session-query-sqlite` / `disabled: true` 两行，官方引擎即恢复
   （代价：中文内容搜索回到 0 命中，侧栏只搜标题）。

## 自测

宿主包现在只在 asar 里，`apply-*` 与 `engine-*` 三个探针必须用 Electron 的 node 模式跑
（普通 `node` 读不了 asar）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "<安装目录>\DeepSeek Harness.exe" test/apply-smoke.mjs   # 宿主包定位 + apply 挂载（7 条）
& "<安装目录>\DeepSeek Harness.exe" test/engine-smoke.mjs  # 服务注册、Config 归一、disabled 语义（12 条）
& "<安装目录>\DeepSeek Harness.exe" test/engine-live.mjs   # 真语料：索引 657 个会话并查询（慢）
```

`node test/probe.mjs` 只依赖 `lib/sql.js`，普通 node 即可（22 条判据）。

## License

MIT

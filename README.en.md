# dsh-session-search-pro

A drop-in replacement for DeepSeek Harness's `@deepseek-ai/dsh-session-query-sqlite` that makes the sidebar search **work with Chinese**, across **all sessions in all workspaces**.

It takes over `ctx.sessionQuery`. The search box, `Command+K`, result navigation and snippet highlighting all stay official — no UI change required.

## Why

DSH's full-text session search is opt-in, and even when enabled it has four problems that hit CJK users hardest:

| Problem | Official | This plugin |
|---|---|---|
| Tokenizer | FTS5 `tokenize='unicode61'` treats a run of Han characters as one token, so `插件` / `搜索` return **0 hits with no error** | `trigram` for ≥3 chars, `LIKE` fallback below that |
| Indexed content | `user/message`, `assistant/message`, `tool/call`, `tool/result`, `todo/write`, `turn/end` | **`user/message` only** — you search what *you* said |
| One corrupt session | No per-session fault tolerance: a single broken jsonl fails the whole indexing round, the host swallows it and silently degrades to title-only search | Marked `status=0` and skipped forever; the rest index fine |
| Snapshot stability | Requires the persistence snapshot to be identical before and after reading; the session you are actively chatting in appends every few seconds, so **4 retries exhaust and it throws `SESSION_QUERY_PERSISTENCE_FAILED`** | Sessions that changed mid-round are deferred to the next round — search works mid-conversation |

## Install

```bash
mklink /J "%APPDATA%\dsh-desktop\harness\profiles\desktop\node_modules\dsh-session-search-pro" "<absolute path to this repo>"
```

Then in `profiles\desktop\package.json`:

```jsonc
{
  "dependencies": { "dsh-session-search-pro": "link:<absolute path, forward slashes>" },
  "dsh": { "profile": { "bundles": [ /* ..., */ "dsh-session-search-pro" ] } }
}
```

Keep it **last** in `bundles`: patch layers apply in order and later wins, which is how the bundled patch disables `session-query-sqlite`.

Restart DSH.

## Config

| Key | Default | Meaning |
|---|---|---|
| `path` | `dshHomePath('cache/session-search-pro.db')` | Index location. Never inside `sessions/` |
| `openAt` | `first-search` | `startup` / `first-search` / `never` |
| `defaultLimit` | `20` | Page size |
| `maxLimit` | `100` | Page cap |
| `snippetChars` | `240` | Snippet window |

## Performance baseline

Real corpus of 656 sessions / 21,450 user messages / 418 MB of logs:

- first index **60–90 s** (one-off; reused afterwards)
- subsequent search **0.6–17 s** depending on incremental reconciliation
- ≥3 CJK chars → FTS5 `MATCH`, sub-millisecond
- 2 CJK chars → `LIKE '%…%'` over 21k docs, 100–200 ms

The first index is slow because every session is decompressed and replay-validated via `Session.create`. Skipping that would risk indexing corrupt logs as genuine content.

## Uninstall

Remove the entry from `dependencies` and `bundles`, delete the junction. The official backend falls back to `openAt: never` (title-only search).

## License

MIT

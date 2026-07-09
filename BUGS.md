# Bug Triage

> **Archived snapshot** — one-time security/bug audit dated 2026-06-05; every item below is fixed. Not an active todo list. Current project status lives in `PROJECT.md` (local, gitignored).

Date: 2026-06-05

Scope: bug triage and fixes for public-build safety, OpenAI-compatible provider behavior, attachments, and runtime hardening.

## Verification

- `npm run build` passes.
- `scripts/audit-public.cjs` passes.
- `cargo check --manifest-path src-tauri/Cargo.toml` passes.
- OpenAI proxy regression passes for image conversion, `Read.pages` sanitization, and `reasoning_effort` fallback retry.
- `git ls-files` did not show tracked `AGENTS.md`, `client/dist`, `.claude/`, `.env`, local private route/components, or `*.local.js`/`*.local.jsx` files.
- `.gitignore` ignores `AGENTS.md`, `.claude/`, `client/dist/`, `*.local.js`, and `*.local.jsx`.

## Bugs

| Status | Priority | Bug | Fix |
| --- | --- | --- | --- |
| Fixed | P1 | WebSocket handshake did not validate `Origin`. | `server/index.js` now shares the HTTP Origin allow-list with WS handshakes. |
| Fixed | P1 | Session metadata/messages endpoints did not validate `projectHash` and `sessionId`. | `server/routes/sessions.js` now applies the same `safeId` guard used by sibling routes. |
| Fixed | P1 | OpenAI-compatible proxy passed provider-incompatible tool args through. | `server/services/openai-proxy.js` now sanitizes invalid `Read.pages` before returning tool calls to Claude CLI. |
| Fixed | P2 | Reasoning effort selector disappeared for OpenAI-compatible providers. | The selector now remains visible; the proxy maps effort to `reasoning_effort` and retries without it when an upstream rejects the parameter. |
| Fixed | P2 | Tauri only checked that port 6677 was open. | `src-tauri/src/lib.rs` now checks `/api/health` for the Claude GUI fingerprint before opening the webview. |
| Fixed | P2 | Windows URL opener used `cmd /c start`. | `server/routes/open-url.js` and update installer opening now use `explorer.exe` without shell parsing. |
| Fixed | P2 | File-change restore could not handle newly written untracked files. | `server/routes/file-changes.js` can delete untracked files only when the client explicitly confirms that path. |
| Fixed | P3 | OpenAI-compatible proxy dropped image blocks silently. | `server/services/openai-proxy.js` now converts Anthropic image blocks to OpenAI `image_url` parts. |
| Fixed | P3 | Update download had no size cap and overwrote same-name files. | `server/routes/download-update.js` now caps downloads, streams with a byte limiter, and auto-renames same-name files. |
| Fixed | P3 | GUI upload accepted only images/text. | `server/routes/upload.js` and `ChatInput.jsx` now accept PDF and common office files; prompts reference attachments with `@path`. |

## Notes

- Current public-build flow appears aligned with the requirement that GitHub releases should not include local private integrations/UI.
- `server/routes/*.local.js` and `client/src/components/*.local.jsx` are local-only by convention and ignored by git.

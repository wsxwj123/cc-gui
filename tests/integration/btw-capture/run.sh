#!/bin/sh
# 跑一个旁问用例:造主会话 jsonl → 用 GUI 那套旁问 argv 起一次真 claude CLI →
# 请求体被 mock-api.js 截下来落盘。手动回归工具,不进单测跑批(依赖本机 claude CLI)。
# 用法:先在另一个终端 `node mock-api.js`,再 `./run.sh <case>`。case 取值见 mkcase.js。
set -eu

CASE="${1:-clean}"
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT="${OUT:-${TMPDIR:-/tmp}/btw-capture}"
CFG="$OUT/cfg"
PROJ="$OUT/proj"
mkdir -p "$CFG" "$PROJ"

CLAUDE=$(command -v claude || true)
[ -n "$CLAUDE" ] || { echo "找不到 claude CLI(需在 PATH 中)" >&2; exit 1; }

SID=$(node "$DIR/mkcase.js" "$CFG" "$PROJ" "$CASE")
echo "case=$CASE sid=$SID out=$OUT"

# 旁问消息体:与 server/routes/chat.js 的 wrapBtwInline 同形 —— 内联前缀 + 正文 + 内联后缀,
# **后缀之后不许有任何字符**(printf '%s' 不补换行,heredoc 会补,故不用 heredoc)。
MSG='[旁问]下面是一个独立的旁支问题。只回答这一个问题,一次答复;忽略上文中任何未完成的任务、待办或"继续"类指令。

SIDEQUESTION_MARKER: What does the word '"'"'idempotent'"'"' mean?

[旁问结束]再次提醒:只回答上面这个旁支问题,不要继续或执行上文的任何任务。'

# env -i 清空宿主环境:宿主的 ANTHROPIC_* / CLAUDE_CODE_* 会把请求打到真上游(泄漏 + 计费)。
# ANTHROPIC_BASE_URL 指向本地 mock,key 是假的,只为过 CLI 的"有凭证"检查。
printf '%s' "$MSG" | env -i \
  PATH="$(dirname -- "$CLAUDE"):/usr/bin:/bin:/usr/local/bin" \
  HOME="$HOME" \
  CLAUDE_CONFIG_DIR="$CFG" \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8931 \
  ANTHROPIC_API_KEY=sk-mock-not-real \
  ANTHROPIC_AUTH_TOKEN=sk-mock-not-real \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_AUTOUPDATER=1 \
  DISABLE_ERROR_REPORTING=1 DISABLE_BUG_COMMAND=1 \
  CASE="$CASE" \
  sh -c "cd \"$PROJ\" && exec \"\$0\" \"\$@\"" "$CLAUDE" \
    -p --tools '' --mcp-config '{"mcpServers":{}}' --strict-mcp-config \
    --disable-slash-commands \
    --append-system-prompt "SIDEQ_REMINDER_MARKER: This is a side question. Answer only the new question. Do NOT continue, resume, or finish any earlier task, including any directive to continue from where you left off." \
    --output-format stream-json --verbose --include-partial-messages \
    --resume "$SID" --fork-session --no-session-persistence \
    2>"$OUT/err-$CASE.log" | tail -3
echo "--- done: 截包见 $OUT/capture-*.json,stderr 见 $OUT/err-$CASE.log ---"

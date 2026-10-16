// r151c:改写 <数据根>/fakebin/claude 垫片(run.sh 在一期 fixtures.mjs 建好 HOME 与一期垫片之后调用本文件)。
// 与一期垫片的区别只有两处:
//   1) 真 CLI 车道(工作目录 ws/real-*):一期遇到 settings 里有模型接口设置就拒绝;二期"换 provider"的用例要在 settings.json
//      里写模型接口,所以放宽为"出现的 *_BASE_URL 必须都指向本地假接口"(仍拒绝 apiKeyHelper / CLAUDE_CODE_USE_*),
//      其余照旧:清掉进程环境里的 provider 变量,默认把模型请求打到本地假接口的 real 车道。
//   2) 两条车道都先 unset NODE_OPTIONS(时钟平移只给一次性实例的服务进程,不传给 CLI)。
// 假 CLI 仍是一期的 helpers/fake-claude.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakebinDir, realCliPath } from '../../r151b-xsession-p1/helpers/fixtures.mjs';

const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'r151b-xsession-p1', 'helpers', 'fake-claude.mjs');

export function writeShimP2() {
  const mock = process.env.R151B_MOCK_BASE || 'http://127.0.0.1:0';
  const real = realCliPath() || '/nonexistent/claude';
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const sh = `#!/bin/sh
# r151c claude 垫片(shim-p2.mjs 生成)。ws/real-* → 真 CLI(模型请求只到本地假接口);其它 → 一期假 claude。
unset NODE_OPTIONS
MOCK=${q(mock)}
ok_text() {
  printf '%s' "$1" | grep -qE 'apiKeyHelper|CLAUDE_CODE_USE_' && return 1
  for u in $(printf '%s' "$1" | grep -oE '"[A-Z_]*BASE_URL[A-Z_]*"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*:[[:space:]]*"([^"]*)"$/\\1/'); do
    case "$u" in "$MOCK"|"$MOCK"/*) ;; *) return 1 ;; esac
  done
  return 0
}
here="$(pwd -P)"
case "$here" in
  */ws/real-*)
    REAL=${q(real)}
    [ -x "$REAL" ] || { echo "[r151c shim] 本机没有真 claude CLI" >&2; exit 98; }
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--settings" ]; then
        v="$a"; [ -f "$v" ] && v="$(cat "$v")"
        ok_text "$v" || { echo "[r151c shim] 拒绝:--settings 带了非本地的模型接口设置" >&2; exit 97; }
      fi
      case "$a" in --settings=*) echo "[r151c shim] 拒绝:--settings= 形式无法检查" >&2; exit 97;; esac
      prev="$a"
    done
    if [ -f "$HOME/.claude/settings.json" ]; then
      ok_text "$(cat "$HOME/.claude/settings.json")" || { echo "[r151c shim] 拒绝:settings.json 带了非本地的模型接口设置" >&2; exit 97; }
    fi
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY HTTPS_PROXY HTTP_PROXY https_proxy http_proxy ALL_PROXY all_proxy
    export CLAUDE_CONFIG_DIR="$HOME/.claude" ANTHROPIC_BASE_URL=${q(`${mock}/lane/real`)} ANTHROPIC_AUTH_TOKEN=dummy-r151c-real \\
      CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 DISABLE_ERROR_REPORTING=1 NO_PROXY='*'
    exec "$REAL" "$@";;
esac
exec ${q(process.execPath)} ${q(fake)} "$@"
`;
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, sh);
  fs.chmodSync(shim, 0o755);
  return shim;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`[r151c] 二期垫片就绪:${writeShimP2()};真 CLI:${realCliPath() || '无'}`);
}

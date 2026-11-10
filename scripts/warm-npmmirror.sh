#!/usr/bin/env bash
# scripts/warm-npmmirror.sh —— 发版 CI(.github/workflows/tauri.yml 的 publish-npm 任务,「Warm npmmirror」步骤)用:
# 等官方源上每个包的新版本生效后,再让国内镜像(npmmirror)同步,并盯到镜像追平。
#
# 为什么不是「发布完立刻催一下」:大分包在官方源上要 10–60 分钟才可见(0.2.454:darwin 晚 10 分钟、win32 晚 55 分钟;
# 0.2.458:两个都晚整整 60 分钟)。发布后立刻催同步,镜像只拿到当时已可见的主包,两个平台分包缺失,走镜像装 npm 渠道的
# 用户会报「没找到当前平台的安装包」(0.2.458 就这样漏了,事后手动补同步才追平)。
#
# 做法:每 POLL 秒一轮,对 npm-packages.json 里的每个包:
#   1. 镜像上已有该版本 → 这个包完成;
#   2. 否则官方源上有该版本才催(PUT /-/package/<包>/syncs);官方源还没有就不催(催了也拿不到);
#   3. 催成功之后 RESYNC 秒镜像还没追上,再催一次(同步任务可能失败 / 排队);催的请求失败(超时 / 连不上 / 响应不是成功体)
#      不算催过,下一轮重试。
#   所有包都追平 → 退出 0;超过 MAX_WAIT 仍有缺的 → 打印缺哪些、退出 1(调用方步骤带 continue-on-error,不会弄红任务)。
#
# 判据:包页面(packument)的 versions 表里有这个版本号的键(`"x.y.z":{`)才算「有」;dist-tags / time / 依赖表里出现同样的
# 版本号字符串不算。包页面请求失败(超时 / 404 / 5xx)一律按「还没有」处理,下一轮再看。
#
# 用法:bash scripts/warm-npmmirror.sh [npm-packages.json]
#   默认读 ./npm-packages.json(由「Assemble npm packages」步骤生成:{ "version": "x.y.z", "packages": [{ "name": "@scope/pkg", ... }] })。
# 环境变量(都有默认值;单测里会改):
#   NPMMIRROR_REGISTRY     镜像根地址,默认 https://registry.npmmirror.com
#   NPM_OFFICIAL_REGISTRY  官方源根地址,默认 https://registry.npmjs.org
#   WARM_MAX_WAIT_S        总等待上限(秒),默认 7200(2 小时;观测到的最长延迟是 60 分钟)。须小于工作流步骤的 timeout-minutes。
#   WARM_POLL_S            每轮间隔(秒),默认 60
#   WARM_RESYNC_S          同一个包两次催同步的最小间隔(秒),默认 300
#
# 只依赖 bash(3.2 起,开发机 macOS 自带的也能跑)、curl、node(读 json)、date、sleep;不装任何东西、不写盘。

set -u

MIRROR="${NPMMIRROR_REGISTRY:-https://registry.npmmirror.com}"
OFFICIAL="${NPM_OFFICIAL_REGISTRY:-https://registry.npmjs.org}"
MAX_WAIT="${WARM_MAX_WAIT_S:-7200}"
POLL="${WARM_POLL_S:-60}"
RESYNC="${WARM_RESYNC_S:-300}"
JSON_FILE="${1:-npm-packages.json}"

if [ ! -f "$JSON_FILE" ]; then
  echo "找不到 $JSON_FILE(应由「Assemble npm packages」步骤生成)" >&2
  exit 2
fi

VER=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.version||""))' "$JSON_FILE" 2>/dev/null) || VER=""
NAMES=()
while IFS= read -r line; do
  if [ -n "$line" ]; then NAMES+=("$line"); fi
done < <(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const p of (j.packages||[]))console.log(p.name)' "$JSON_FILE" 2>/dev/null)
COUNT=${#NAMES[@]}
if [ -z "$VER" ] || [ "$COUNT" -eq 0 ]; then
  echo "$JSON_FILE 里没有版本号或包列表,没有可预热的包" >&2
  exit 2
fi

# 每个包的状态(下标与 NAMES 对齐)
i=0
while [ "$i" -lt "$COUNT" ]; do
  MIRROR_OK[$i]=0   # 1 = 镜像上已有该版本(完成)
  UP_OK[$i]=0       # 1 = 官方源上已有该版本(可以催了)
  SYNC_AT[$i]=0     # 上一次「催成功」的时间(epoch 秒);0 = 还没催成功过
  i=$((i + 1))
done

# $1 = 源的根地址  $2 = 包名(@scope%2fname)  $3 = 版本号 → 包页面的 versions 表里有该版本则返回 0
has_version() {
  local body
  body=$(curl -sS --fail --max-time 30 -H 'Cache-Control: no-cache' "$1/$2" 2>/dev/null) || return 1
  case "$body" in
    *"\"$3\":{"* | *"\"$3\": {"*) return 0 ;;
  esac
  return 1
}

# $1 = 包名(@scope%2Fname)→ 请求镜像同步。成功 = curl 正常返回且响应体含 "ok":true
# (镜像真实返回形如 {"ok":true,"id":"…","type":"sync_package","state":"waiting"});超时 / 连不上 / HTTP 5xx / 代理返回的错误页
# 都不含它,一律按失败处理(不记成「催过」,下一轮重试)。注意不能只看 curl 退出码:没加 --fail 时 HTTP 502 的退出码也是 0
# (真实网络实测:本机代理对连不上的地址回 502、空响应体)。响应体(前 200 个字符)照常打到日志里。
request_sync() {
  local body
  body=$(curl -sS --max-time 30 -X PUT "$MIRROR/-/package/$1/syncs") || return 1
  if [ -n "$body" ]; then echo "    ${body:0:200}"; fi
  case "$body" in
    *'"ok":true'*) return 0 ;;
  esac
  return 1
}

START=$(date +%s)
DEADLINE=$((START + MAX_WAIT))
echo "镜像预热:$COUNT 个包 @ $VER。先等官方源上可见再催镜像同步(官方源上大分包要 10–60 分钟才可见)。"
echo "  每 ${POLL} 秒查一轮;同一个包催成功后 ${RESYNC} 秒还没追上才再催;总上限 ${MAX_WAIT} 秒。"

while :; do
  NOW=$(date +%s)
  mirror_n=0
  up_n=0
  i=0
  while [ "$i" -lt "$COUNT" ]; do
    name="${NAMES[$i]}"
    if [ "${MIRROR_OK[$i]}" = 1 ]; then
      :
    elif has_version "$MIRROR" "${name/\//%2f}" "$VER"; then
      MIRROR_OK[$i]=1
      UP_OK[$i]=1
      echo "  ✓ 镜像已有 $name@$VER"
    elif [ "${UP_OK[$i]}" = 1 ] || has_version "$OFFICIAL" "${name/\//%2f}" "$VER"; then
      UP_OK[$i]=1
      last="${SYNC_AT[$i]}"
      if [ "$last" -eq 0 ] || [ $((NOW - last)) -ge "$RESYNC" ]; then
        echo "  → 官方源已有 $name@$VER,请求镜像同步"
        if request_sync "${name/\//%2F}"; then
          SYNC_AT[$i]=$NOW
        else
          echo "    同步请求失败(超时 / 连不上 / 响应里没有 \"ok\":true),下一轮重试"
        fi
      fi
    fi
    if [ "${MIRROR_OK[$i]}" = 1 ]; then mirror_n=$((mirror_n + 1)); fi
    if [ "${UP_OK[$i]}" = 1 ]; then up_n=$((up_n + 1)); fi
    i=$((i + 1))
  done

  echo "[已等 $(((NOW - START) / 60)) 分钟] 官方源已有 $up_n/$COUNT,镜像已有 $mirror_n/$COUNT"
  if [ "$mirror_n" -eq "$COUNT" ]; then
    echo "镜像已追平:$COUNT 个包都有 $VER"
    exit 0
  fi

  NOW=$(date +%s)
  if [ "$NOW" -ge "$DEADLINE" ]; then
    missing=""
    i=0
    while [ "$i" -lt "$COUNT" ]; do
      if [ "${MIRROR_OK[$i]}" != 1 ]; then
        if [ "${UP_OK[$i]}" = 1 ]; then note="官方源已有,镜像没追上"; else note="官方源上还没有"; fi
        missing="$missing\n  - ${NAMES[$i]}($note)"
      fi
      i=$((i + 1))
    done
    printf '镜像预热超时(已等 %s 分钟),这些包在镜像上还没有 %s:%b\n' "$(((NOW - START) / 60))" "$VER" "$missing"
    echo "包已经发布成功,镜像迟早会同步;要手动补同步:PUT $MIRROR/-/package/<包名,其中的 / 写成 %2F>/syncs"
    exit 1
  fi
  sleep "$POLL"
done

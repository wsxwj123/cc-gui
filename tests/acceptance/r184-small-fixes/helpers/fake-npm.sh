#!/bin/bash
# 假 npm(测试夹具):不联网、只写 FAKE_NPM_DEFAULT_PREFIX / --prefix 指向的目录和 FAKE_NPM_LOG。
# 环境变量:
#   FAKE_NPM_MODE            strict | legacy | broken
#   FAKE_NPM_DEFAULT_PREFIX  默认前缀目录
#   FAKE_NPM_LOG             调用日志(每次调用追加一行完整参数)
printf '%s\n' "$*" >> "${FAKE_NPM_LOG:?FAKE_NPM_LOG 未设置}"
default_prefix="${FAKE_NPM_DEFAULT_PREFIX:?FAKE_NPM_DEFAULT_PREFIX 未设置}"
mode="${FAKE_NPM_MODE:-strict}"
pkg_name="@anthropic-ai/claude-code"

case "$1" in
  prefix)
    if [ "$2" = "-g" ]; then
      echo "$default_prefix"
      exit 0
    fi
    ;;
  config)
    if [ "$2" = "get" ] && [ "$3" = "prefix" ]; then
      echo "$default_prefix"
      exit 0
    fi
    # config set 只记日志,不真的改任何配置
    exit 0
    ;;
  install|i)
    shift
    prefix="$default_prefix"
    allow=""
    pkg=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -g) ;;
        --prefix) prefix="$2"; shift ;;
        --prefix=*) prefix="${1#--prefix=}" ;;
        --allow-scripts=*) allow="${1#--allow-scripts=}" ;;
        -*) ;;
        *) pkg="$1" ;;
      esac
      shift
    done
    case "$pkg" in
      "$pkg_name"|"$pkg_name"@*) ;;
      *) echo "fake-npm: 未知包说明符: $pkg" >&2; exit 2 ;;
    esac
    usable=0
    case "$mode" in
      strict)
        case ",$allow," in
          *",$pkg_name,"*) usable=1 ;;
        esac
        ;;
      legacy) usable=1 ;;
      broken) usable=0 ;;
      *) echo "fake-npm: 未知模式: $mode" >&2; exit 2 ;;
    esac
    dir="$prefix/lib/node_modules/$pkg_name/bin"
    if ! mkdir -p "$dir" "$prefix/bin"; then
      echo "npm error code EACCES" >&2
      exit 243
    fi
    if [ "$usable" = "1" ]; then
      cat > "$dir/claude.exe" <<'EOF'
#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "9.9.9 (Claude Code)"
fi
exit 0
EOF
    else
      cat > "$dir/claude.exe" <<'EOF'
#!/bin/sh
echo "Error: claude native binary not installed." >&2
exit 1
EOF
    fi
    chmod 755 "$dir/claude.exe"
    ln -sf "../lib/node_modules/$pkg_name/bin/claude.exe" "$prefix/bin/claude"
    exit 0
    ;;
esac
exit 0

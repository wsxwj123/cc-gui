# r142-wincu —— Windows computer use 的平台分派验收

**这个套件验什么**:Windows 补齐方案(PLAN-r142)里"按平台分支"的那一层 ——
路由字段、能力表、UI 文案与按钮、运行时目录命名。
**验不了什么**:Windows API 的真实行为(SendInput / UIA / DPI / UIPI)。那部分只能真机,
清单在 `.devflow/TEST-PLAN-r142.md` 的「Windows 真机验证清单」。

## 怎么做到的(重要,别误读)

隔离实例是用 `node --import helpers/win-preload.mjs server/index.js` 起的:
预加载把 `process.platform` / `os.platform()` 改成目标平台,并把家目录指到夹具目录。
**产品代码一行都没改**(方案 §6.1 也把 `CCGUI_CU_PLATFORM` 这个产品钩子去掉了)。
所以本套件的结论只对"分派逻辑"有效,不能读成"Windows 上验过了"。

## 跑法

```sh
cd tests/acceptance/r142-wincu
./run-isolated.sh --platform win32                 # HTTP:W-01..W-06(6 passed)
./run-isolated.sh --platform win32 --no-venv -g W-06   # 单独验「准备环境」(W-06 自带清运行时前置,两种配置都能跑)
./run-isolated.sh --platform win32 --no-venv --ui -g 'U-0[1-4]'   # UI:U-01..U-04
./run-isolated.sh --platform darwin -g W-D         # macOS 反向守卫 W-D01..W-D03
./run-isolated.sh --platform darwin --ui -g U-05   # mac UI 一字不改
./run-isolated.sh --platform linux --ui -g U-06    # 不支持平台的占位卡
```

> UI 那几遍建议带 `--no-venv`:U-03 要的是"缓存说 UIA 不可用"的确定态,而**运行时已就绪 + 缓存缺失**
> 时产品会发起异步补偿探测(§2.5②),会和 U-03 写的缓存抢;空运行时下没有这个竞争。

**端口**:本套件用 **7200-7299**。6700-6999 归另一个代理的 r140 套件(2026-10-01 起在跑),
不抢;用户实例 6677 / 6689 硬拒。杀进程只按记录下来的 pid。

## 用例与"修前红不红"

| ID | 测什么 | 修前 |
|---|---|---|
| W-01 | Windows 上 `supported=true`(卡片不再被 `MCPPanel.jsx:35` 隐藏) | 红 |
| W-02 | 顶层 `appIdKind`/`inputMode`/`uiaReady` 齐备,且没塞进 `capabilities` | 红 |
| W-03 | win32 能力表:foreground 三件套在、unsupported 带 reason、无 mac 借口 | 红 |
| W-04 | win32 doctor:`accessibility=not-applicable`、有 dpi/integrity/uia、不误报 CU_PERMISSION_REQUIRED | 红 |
| W-05 | `not-applicable` 只出现在 doctor,**不许进 capabilities** | 绿(边界守卫;现在两边都没有) |
| W-06 | `POST /prepare` → runtimeReady/uiaReady/inputMode 三连 | 红 |
| W-D01 | darwin 能力表逐字节不变 | 绿 |
| W-D02 | darwin 的 `/status` 不带 win32 专属字段 | 绿 |
| W-D03 | darwin 的 doctor 判据**不许**被放宽(仍 CU_PERMISSION_REQUIRED) | 绿 |
| U-01 | 卡片必须存在(任何平台都不许整张消失) | 红 |
| U-02 | win32 副标题按 inputMode 写实话 | 红 |
| U-03 | win32 降级提示条:消息投递档说清"浏览器类大概率无效" | 红 |
| U-04 | win32 且运行时未就绪 → 「准备环境」按钮 + 真打 POST /prepare | 红 |
| U-05 | mac 副标题逐字不变、**没有**准备按钮、没有提示条 | 绿 |
| U-06 | 不支持的平台显示"当前平台…不支持"占位(linux 那遍) | 红 |

## 需要的 DOM 锚点(目前产品里没有,属接口要求)

- `data-testid="cu-card-subtitle"` —— 桌面操控卡的第二行副标题(§4.2 按 inputMode 改写的那句)。
- `data-testid="cu-mode-note"` —— 降级提示条(黄/红/灰那一档)。

其余定位一律用公开文案与 role(卡片标题「桌面操控(computer use)」、按钮「准备环境」、
占位「当前平台…不支持」),与既有验收套件同规矩。

## 状态(2026-10-02 实测)

| 跑法 | 结果 |
|---|---|
| `--platform win32 -g 'W-0'` | **6 passed**(W-01..W-06) |
| `--platform win32 --no-venv -g W-06` | **1 passed**(单独验「准备环境」) |
| `--platform darwin -g W-D` | **3 passed**(W-D01..W-D03) |
| `--platform win32 --no-venv --ui -g 'U-0[1-4]'` | **4 passed**(U-01..U-04) |
| `--platform darwin --ui -g U-05` | **1 passed** |
| `--platform linux --ui -g U-06` | **1 passed** |

U 组六条按平台分三遍跑(每条的适用平台写在用例标题里)——这是设计,不是跳过。

## 2026-10-02 修掉的三个夹具缺陷(裁判实测认定)

1. **只造 Windows 布局** ⇒ darwin 那遍 `runtimeReady` 恒 false、W-D03 报 `CU_RUNTIME_UNAVAILABLE`。
   现在 `prepare-home.mjs` 按 `CGUI_TEST_PLATFORM` 造对应布局,目录名/解释器相对路径/戳文件名/依赖戳
   **全部从产品纯函数取**(`venvDirFor/venvPyFor/stampFileFor/pyDepsFor/depsStampFor`),产品改名自动跟随。
2. **`-m venv` 把 `.mjs` 拷成 `Scripts/python.exe`** ⇒ `ERR_UNKNOWN_FILE_EXTENSION`,W-06 走不通。
   现在写 `#!/bin/sh` 壳脚本(按平台决定 `Scripts/python.exe` 还是 `bin/python3`)。
3. **伪 win32 下 PATH 被 `expandClaudePath()` 用 `;` 重拼**,夹具 `bin` 被粘掉、本机 `~/.pyenv/shims/python`
   反被选中(建出 `venv-win/bin/python3.10`)。现在 `run-isolated.sh` 在 PATH 最前放一个 decoy 挡这一刀。

另外补了两处:桩日志(`CU_STUB_LOG`)接进隔离实例(报文可自证)、runner 传 `CGUI_TEST_HOME`
(U-03 改成只写夹具家目录 —— 旧写法会写到操作者真实的 `~/.claude-gui`)。

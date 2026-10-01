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
./run-isolated.sh --platform win32                 # HTTP:W-01..W-06
./run-isolated.sh --platform win32 --no-venv       # 加 POST /prepare(W-06 需要空运行时)
./run-isolated.sh --platform win32 --ui            # 加 UI:U-01..U-04
./run-isolated.sh --platform darwin -g W-D         # macOS 反向守卫 W-D01..W-D03
./run-isolated.sh --platform darwin --ui -g U-05   # mac UI 一字不改
./run-isolated.sh --platform linux -g U-06         # 不支持平台的占位卡
```

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

## 状态

**代码已写,尚未执行**(2026-10-01:另一个代理在 `fix/r140-crosstalk` 上跑 Playwright,
占用 6700-6999;本套件虽然用 7200-7299,但按本轮任务约束"需要起 GUI 实例的用例先只写不跑")。
第一次跑之前请先确认:①产品侧已经落地 §3.1 A-3 / §4.2 的改动;②webkit 浏览器已安装
(`npx playwright install webkit`);③U-03 会改夹具的 uia 缓存,建议单独一遍跑。

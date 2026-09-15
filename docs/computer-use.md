# 桌面操控 computer use（功能 C）

让 cc-gui 里的会话获得截图、鼠标、键盘、窗口信息能力。实现为**自带 MCP server**（零依赖 Node 脚本 + Python 执行层），注册进 Claude Code 的 MCP 配置，第三方模型（DeepSeek/GLM/MiMo 等）即可用，不依赖 claude.ai 官方认证。

## 安装与卸载

- **工具（MCP）面板 → 「桌面操控(computer use)」卡片 → 安装**。注册名 `ccgui-computer-use`（`computer-use` 是 Claude Code 保留名，注册会被拒）。
- 卸载同卡片；Python 运行时（`~/.claude-gui/cu-runtime`）保留，重装秒生效。
- 已注册的会话**下条消息自动生效**（cc-gui 的 MCP 换代戳机制），无需重启。

## 首次运行

1. 首次调用任一工具时自动建 Python venv 并装依赖（mss / pyautogui / pyobjc 三框架，约 1-3 分钟，主源失败自动切清华镜像）。
2. **系统权限**（首次会弹，按提示授权）：
   - 屏幕录制 —— 截图用（`doctor` 用 CGPreflightScreenCaptureAccess 查 TCC，不拿一张抽样图当结论）
   - 辅助功能 —— 窗口读取与定向输入用
   - 授权对象是 CC-GUI（或启动它的终端）。装完在卡片点「环境自检」，四项全 ok 即就绪。
3. **按应用授权**（隐私边界，见下节）：默认**一个应用都没授权**，`window_list` 会返回 0 个窗口。

## 授权模型（按应用 + 主屏范围）

> **当前授权入口**：图形界面尚未提供授权面板（卡片上只有安装/卸载/环境自检），按应用与主屏截图授权只能用下面的 HTTP 接口 `POST /api/computer-use/grants` 完成。下面的「面板勾选」一律指**设计意图**，界面上还没有这个入口。

| 授权 | 作用 | 未授权的后果 |
|---|---|---|
| 按应用（bundleId） | 该应用进入 `window_list`；可以作为 target 被点击/输入 | 后续该应用的动作 `CU_APP_NOT_ALLOWED`；其他窗口连标题都不返回 |
| 主屏全部可见内容（screenScope） | 允许主屏截图返回像素、允许 `cursor_position` 报屏幕坐标 | 主屏截图 `CU_SCREEN_SCOPE_REQUIRED` 且**零像素**；光标只报已授权窗口内的局部坐标 |

按应用授权**不隐含**全屏授权；授权只覆盖普通桌面访问，不涉及锁屏、安装或其他应用。

```sh
# 授权的 HTTP 面(当前唯一入口:图形界面尚未提供授权面板;curl 手工完成即可)
curl -s localhost:6677/api/computer-use/status          # 能力/锁屏状态/运行时
curl -s -X POST localhost:6677/api/computer-use/doctor -d '{}'   # 屏幕读取/辅助功能/运行时/各应用授权
curl -s localhost:6677/api/computer-use/grants          # 当前授权
curl -s -X POST localhost:6677/api/computer-use/grants \
  -H 'content-type: application/json' \
  -d '{"bundleId":"com.apple.TextEdit","name":"文本编辑","granted":true}'   # 启用
curl -s -X POST localhost:6677/api/computer-use/grants \
  -H 'content-type: application/json' -d '{"bundleId":"com.apple.TextEdit","granted":false}'  # 撤销(立即生效)
curl -s -X POST localhost:6677/api/computer-use/grants \
  -H 'content-type: application/json' -d '{"screenScope":true}'  # 允许主屏全部可见内容(false 即撤销)
```

授权落在 `~/.claude-gui/cu-runtime/grants.json`（GUI 后端与 MCP 进程共用同一份；文件按登录用户家目录解析，`$HOME` 不同的启动方式不会各读各的）。**恢复/吊销一次`GET status`就会反映**；MCP 每次动作前重读，所以撤销对正在跑的会话立即生效，已投递动作报 unknown。

## 工具清单（模型可见）

| 工具 | 干扰级别 | 说明 |
|---|---|---|
| `screenshot` | 零干扰 | 主屏截图（需 screenScope），返回图像 + `snapshotId/imgW/imgH/logicalBounds/displayId` |
| `window_list` | 零干扰 | 只列**已授权应用**的窗口（id/pid/bundleId/标题/bounds/displayId） |
| `cursor_position` | 零干扰 | 有 screenScope 报屏幕坐标；否则只报已授权窗口内的局部坐标 |
| `doctor` | 零干扰 | 屏幕读取/辅助功能/运行时/各应用授权分别报状态 |
| `action_status` | 零干扰 | 查某个 `actionId` 的终态与已有回执 |
| `left_click` / `double_click` / `right_click` | **默认零干扰** | 后台定向投递到 `target` 窗口（不动光标不抢前台）；找窗口失败就是失败，**不退化全局** |
| `drag` / `scroll` | **默认零干扰** | 同上，按 pid 定向投递 |
| `type` | **默认零干扰** | 直接写入 `target` 窗口的文本元素并用读回原文验证；读不回 → `unknown` |
| `key` | **默认零干扰** | 按 pid 定向按键（文字/方向键/回车/Tab/退格等），以目标光标/选择/文本状态验证 |

**副作用工具必填**：`actionId`（1–64 位字母/数字/_/-，调用方生成）、`target:{bundleId,pid,windowId}`（来自 `window_list` 的已授权窗口）、`snapshotId`（坐标类）、`foreground`（只有显式 `true` 才允许全局事件）。同 `actionId` 同参数重试返回已有回执，不重新投递；异参 `CU_ACTION_CONFLICT`。

**坐标契约**：所有坐标 = 最近一次 `screenshot` 返回图像的像素坐标（左上 (0,0)），服务端按截图时记录的尺寸映射回屏幕逻辑坐标。合法性按**原图整数**先判（`0≤x<imgW`、`0≤y<imgH`，负/小数/非有限/越界都拒绝），换算一律服务端做。

**错误码**（都在 `structuredContent.code`）：`CU_INVALID_ARGUMENT`、`CU_INVALID_COORDINATE`、`CU_SCREENSHOT_REQUIRED`、`CU_STALE_SNAPSHOT`、`CU_APP_NOT_ALLOWED`、`CU_TARGET_NOT_FOUND`、`CU_TARGET_LOOKUP_FAILED`、`CU_PERMISSION_REQUIRED`、`CU_DISPATCH_FAILED`、`CU_BACKGROUND_UNSUPPORTED`、`CU_TARGET_CHANGED`、`CU_SCREEN_SCOPE_REQUIRED`、`CU_INSTANCE_CHANGED`、`CU_ACTION_CONFLICT`、`CU_ACTION_NOT_FOUND`、`CU_ACTION_EXPIRED`、`CU_UNSUPPORTED_KEY`、`CU_BUSY`、`CU_TIMEOUT`。成功回执含 `ok/actionId/method(target=background|foreground)/target/verification`；`verification` 为 `not-applicable/dispatched/verified/unknown`，**unknown 一律不写"成功完成"**。

## 【不抢前台】的工作规则（写给模型，也是排错依据）

1. 截图/窗口/光标/doctor 完全被动。
2. 所有动作先解析 `target` 当前是否仍是已授权窗口，再定向投递；找不到窗口 = `CU_TARGET_NOT_FOUND`，**不做任何全局回退**。
3. 严禁用 AppleScript/shell 激活窗口来"绕路抢前台"；只有用户明确要求前台操作时才 `foreground:true`（且要求目标就是当面前台应用，否则 `CU_TARGET_CHANGED`）。
4. `type`/`key` 带 `target` 时写的是目标窗口，不是"当前焦点窗口"——不会打进用户正在编辑的应用。
5. macOS 的"虚拟鼠标"（如 Codex 沙箱那类）在本机场景不存在——Codex 控制的是它自己的 VM 桌面；本机等价物就是按 pid 定向投递。

## 已知边界（别当成 bug）

| 边界 | 原因 | 现状 |
|---|---|---|
| 后台目标的 **cmd-组合键**（如 `cmd+a`）不生效 | macOS 的菜单快捷键只对**活动应用**生效；事件投递与 AX 菜单项触发都试过,后台无效 | 工具会投递并如实报 `verification=unknown`，不谎称成功 |
| 后台目标不会自动落盘 | 系统设置「关闭文稿时询问保留更改」(NSCloseAlwaysConfirmsChanges=1) 会关掉文稿自动保存；后台应用收不到"存储"命令 | 文本确实写进目标文稿，但文件要等用户/应用自己保存 |
| 按应用/窗口截图 | 未在真机验证过保真路径 | `capabilities.screenshotTarget=unverified`，请求带 target 的截图明确拒绝，不拿前台别的应用画面顶替 |
| 锁屏（R19） | 需要已验证的授权组件接口，当前无公开可复用入口 | `status.lockscreen.state` 只会是 `disabled`/`unverified`，不代表已支持 |
| 停止操控 / 用户接管 | 需要图形界面的入口，尚未提供 | 契约里的 `CU_INTERRUPTED` 路径暂不可达，`actionId` 登记表可查历史 |
| 执行中撤权 | 界面上按动作粒度取消是设计意图，该入口尚未提供 | 撤销后**下一个**动作立即 `CU_APP_NOT_ALLOWED`；已投递动作不回滚 |

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `claude mcp list` 显示 Failed to connect | node 路径失效（升级后路径变了） | 面板卸载→重装（会取当前 node 绝对路径） |
| 截图报 `CU_SCREEN_SCOPE_REQUIRED` | 没有授权主屏全部可见内容 | `POST /api/computer-use/grants {"screenScope":true}`（当前只能走接口，图形界面没有该入口），这是独立于按应用授权的边界 |
| window_list 空 / 动作报 `CU_APP_NOT_ALLOWED` | 目标应用没授权 | `POST /api/computer-use/grants {"bundleId":"…","granted":true}`（当前只能走接口，图形界面没有该入口） |
| 动作报 `CU_STALE_SNAPSHOT` | 截图被更新覆盖/来自别的会话 | 重新 `screenshot` 再操作 |
| 点击无反应 | 无辅助功能权限，或该 App 不吃后台事件 | 自检看 accessibility；确有必要再 `foreground:true`（会打断用户） |
| 工具报 `CU_SCREENSHOT_REQUIRED` | 坐标工具前没截图 | 先 screenshot |
| 坐标点偏 | 窗口移动/切换空间后用了旧截图 | 重新 screenshot 再算坐标 |
| 首次调用卡 1-3 分钟 | 在建 venv 装依赖 | 等一次即可，之后秒回 |
| `computer-use` 名字注册失败 | 保留名 | 用面板安装（自动叫 `ccgui-computer-use`） |

## 文件与实现

- `server/computer-use/mcp-server.js` — MCP stdio server（零依赖手写 JSON-RPC：错误码 `-32700/-32600/-32601/-32602`、实例身份、动作登记表、快照表、授权与坐标判定、回执信封）
- `server/computer-use/cu_helper.py` — 执行层子命令 CLI（stdout 只出 JSON；AX 定向读写 + 事件定向投递 + 截图 + 权限自检）
- `server/computer-use/cu-common.js` — Runtime 目录解析、授权存储、能力/锁屏状态（GUI 后端与 MCP 共用）
- `server/routes/computer-use.js` — GUI 的 status/doctor/grants 端点
- `client/src/components/MCPPanel.jsx` — 安装卡（注册复用通用 `/api/mcp`）
- 运行时：`~/.claude-gui/cu-runtime/`（venv + SHA256 戳 + `grants.json` + `shots/`，每实例最多留 5 个已完成图片文件）
- 单测：`tests/unit/check-cu-{mapping,keys,shots,protocol,actions}.mjs`（node 直跑，失败非零退出）

## Windows 支持状态

v1 仅 macOS；`status.supported=false`，不伪造桌面支持。Windows 需另写 helper（截图 `mss` 通用；输入换 `pywin32`/`SendInput`；窗口信息换 `pywin32`；cmd 形态 spawn 参照 `remote-control.js:162-170`），接口已按子命令 CLI 对齐，替换 `cu_helper_windows.py` + mcp-server 平台分支即可。

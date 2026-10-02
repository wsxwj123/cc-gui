# 桌面操控 computer use（功能 C）

让 cc-gui 里的会话获得截图、鼠标、键盘、窗口信息能力。实现为**自带 MCP server**（零依赖 Node 脚本 + Python 执行层），注册进 Claude Code 的 MCP 配置，第三方模型（DeepSeek/GLM/MiMo 等）即可用，不依赖 claude.ai 官方认证。

## 安装与卸载

- **工具（MCP）面板 → 「桌面操控(computer use)」卡片 → 安装**。注册名 `ccgui-computer-use`（`computer-use` 是 Claude Code 保留名，注册会被拒）。
- 卸载同卡片；Python 运行时（`~/.claude-gui/cu-runtime`）保留，重装秒生效。
- 已注册的会话**下条消息自动生效**（cc-gui 的 MCP 换代戳机制），无需重启。

## 首次运行

1. 首次调用任一工具时自动建 Python venv 并装依赖（约 1-3 分钟，主源失败自动切清华镜像）。依赖按平台给：
   - macOS：`mss` / `pyautogui` / `pyobjc-framework-{Cocoa,Quartz,ApplicationServices}`，运行时目录 `~/.claude-gui/cu-runtime/venv`；
   - Windows：`mss` / `Pillow` / `comtypes>=1.4.0`，运行时目录 `~/.claude-gui/cu-runtime/venv-win`（解释器 `venv-win\Scripts\python.exe`）。
     Windows 上卡片会多一个「准备环境」按钮（用户主动准备入口：建运行时 + 跑一次 UIA 可用性探测），macOS 保持"首次调用时自动准备"不变。**两个平台都不装 pywin32**（Windows 侧用 `ctypes` + `comtypes`）。
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

**错误码**（都在 `structuredContent.code`）：`CU_INVALID_ARGUMENT`、`CU_INVALID_COORDINATE`、`CU_SCREENSHOT_REQUIRED`、`CU_STALE_SNAPSHOT`、`CU_APP_NOT_ALLOWED`、`CU_TARGET_NOT_FOUND`、`CU_TARGET_LOOKUP_FAILED`、`CU_PERMISSION_REQUIRED`、`CU_DISPATCH_FAILED`、`CU_BACKGROUND_UNSUPPORTED`、`CU_TARGET_CHANGED`、`CU_SCREEN_SCOPE_REQUIRED`、`CU_INSTANCE_CHANGED`、`CU_ACTION_CONFLICT`、`CU_ACTION_NOT_FOUND`、`CU_ACTION_EXPIRED`、`CU_UNSUPPORTED_KEY`、`CU_BUSY`、`CU_TIMEOUT`，以及 Windows 阶梯新增的三个：`CU_INPUT_UNSUPPORTED`（后台输入通道不可用/执行层缺失，零投递）、`CU_UIA_BLOCKED`（UI Automation 元素或 pattern 不可达，可降级到消息投递）、`CU_UIPI_BLOCKED`（目标进程完整性级别更高，`SendInput` 被 UIPI 拦截）。
成功回执含 `ok/actionId/method/target/verification`；`method` 取值：`capture`（截图）、`passive`（被动查询）、`query`（action_status）、`background`/`foreground`（macOS 的定向/全局投递）、`uia`（Windows UI Automation 元素级）、`post-message`（Windows 消息投递）。`verification` 为 `not-applicable/dispatched/verified/unknown`，**unknown 一律不写"成功完成"**；Windows 的消息投递回执另带 `effect:{observed:'changed'|'unchanged', diffRatio}`，它只是**弱证据**。

## 【不抢前台】的工作规则（写给模型，也是排错依据）

1. 截图/窗口/光标/doctor 完全被动。
2. 所有动作先解析 `target` 当前是否仍是已授权窗口，再定向投递；找不到窗口 = `CU_TARGET_NOT_FOUND`，**不做任何全局回退**。
3. 严禁用 AppleScript/shell 激活窗口来"绕路抢前台"；只有用户明确要求前台操作时才 `foreground:true`（且要求目标就是当面前台应用，否则 `CU_TARGET_CHANGED`）。
4. `type`/`key` 带 `target` 时写的是目标窗口，不是"当前焦点窗口"——不会打进用户正在编辑的应用。
5. macOS 的"虚拟鼠标"（如 Codex 沙箱那类）在本机场景不存在——Codex 控制的是它自己的 VM 桌面；本机等价物就是按 pid 定向投递。
6. **Windows 上没有 `CGEventPostToPid` 的等价物**，后台是**阶梯**：`--method uia`（UI Automation 元素级：`InvokePattern` 点按钮、`ValuePattern` 直写文本值并读回校验、`ScrollPattern` 滚动，不抢前台、不动光标）→ 只有拿到**明确的 COM 失败信号**时才降级到消息投递（`PostMessage` 直投 HWND；只对传统 Win32 控件有效，Chromium/UWP/Java/自绘界面基本无效，**且没有可靠的失败信号**）。两条都不通 → `CU_BACKGROUND_UNSUPPORTED` + 可行动指引（**用新的 actionId 重试并显式 `foreground:true`**），**绝不自动改成全局点击**。
7. Windows 上消息投递**永远不判硬失败**：截图 diff 在窗口被遮挡/最小化/在别的虚拟桌面时双向误判，所以 `unchanged` 也回成功回执 + `verification:unknown`，文案明说"无法据此判定投递失败"。
8. `foreground:true` 在 Windows 上 = `SendInput` 全局投递（会移动真实光标，通常也会把目标窗口切到前台）；`SendInput` 返回值少于请求数会被判成 `CU_UIPI_BLOCKED`/`CU_DISPATCH_FAILED`（返回数相等只证明"入了队列"，不证明目标消费了它）。

### ⚠️ Windows 的一条放宽：前台核验可能拿不到（与 macOS 不同）

**为什么放宽**：macOS 的显式前台动作要求"目标必须就是当前前台应用"（`frontmost.pid === target.pid`），否则 `CU_TARGET_CHANGED` —— 这个判据能成立，是因为 mac 助手一定能报出前台窗口。Windows 没有这个保证：`GetForegroundWindow` 在**安全桌面、UWP/沙箱边界、部分权限受限场景**下拿不到，或返回的目标进程信息查不全。此时若照抄 mac 的严格判据，用户**已经显式同意**的全局投递会永远失败，而且失败原因是"核验不了"而不是"目标不对"。

**放宽成什么**：Windows 上拿到前台窗口就照旧严格比对（pid 不符 → `CU_TARGET_CHANGED`，一次都不放宽）；**拿不到时不再拦**，按用户的显式同意执行全局投递。macOS 侧一字未改。

**用户会看到什么（回执按事实分叉，不许把没核验的当结论）**：

| 情况 | 回执里的那一句 |
|---|---|
| 拿到了前台窗口并匹配 | `已核验:目标就是当前前台窗口` |
| 拿不到前台窗口（放宽生效） | `未能核验目标是否为当前前台(全局投递已按你的显式同意执行)` |

两种情况下回执都只陈述"做了什么"（移动了真实光标、在 (x,y) 投递了点击/输入/按键），不再写"目标窗口被切到前台"这种**没核验过的确定性结论**；拿不到前台时也**不会**冒充"已影响用户前台"。要确认效果，请按回执提示重新截图观察。

**与 macOS 的差异一览**：判据（严格比对 vs 拿不到时放行）＋ 回执措辞（用户前台被影响 vs 已核验/未能核验）都不同，这是平台能力差异（`GetForegroundWindow` 的可靠性）倒逼的，不是"Windows 少做了一层校验"。

## 已知边界（别当成 bug）

| 边界 | 原因 | 现状 |
|---|---|---|
| 后台目标的 **cmd-组合键**（如 `cmd+a`）不生效 | macOS 的菜单快捷键只对**活动应用**生效；事件投递与 AX 菜单项触发都试过,后台无效 | 工具会投递并如实报 `verification=unknown`，不谎称成功 |
| 后台目标不会自动落盘 | 系统设置「关闭文稿时询问保留更改」(NSCloseAlwaysConfirmsChanges=1) 会关掉文稿自动保存；后台应用收不到"存储"命令 | 文本确实写进目标文稿，但文件要等用户/应用自己保存 |
| 按应用/窗口截图 | 未在真机验证过保真路径 | `capabilities.screenshotTarget=unverified`，请求带 target 的截图明确拒绝，不拿前台别的应用画面顶替 |
| 锁屏（R19） | 需要已验证的授权组件接口，当前无公开可复用入口 | `status.lockscreen.state` 只会是 `disabled`/`unverified`，不代表已支持 |
| 停止操控 / 用户接管 | 需要图形界面的入口，尚未提供 | 契约里的 `CU_INTERRUPTED` 路径暂不可达，`actionId` 登记表可查历史 |
| 执行中撤权 | 界面上按动作粒度取消是设计意图，该入口尚未提供 | 撤销后**下一个**动作立即 `CU_APP_NOT_ALLOWED`；已投递动作不回滚 |
| Windows 后台覆盖不到 Chromium/Electron 的一部分界面 | 渲染器默认不打 accessibility 树；UIA 客户端接入会触发按需开启但**有延迟** | `capabilities.backgroundClick/Type.coverage='partial'`；首次可能失败，**重试一次**通常就好；`--force-renderer-accessibility=off` 或企业策略禁用时拿不到 |
| Windows 后台覆盖不到 Java/自绘界面/安全桌面 | 没有元素树（Java 需 Java Access Bridge；UAC/锁屏是独立桌面） | 明确报 `CU_BACKGROUND_UNSUPPORTED`，**不会**偷偷改成全局点击 |
| Windows 上没有 `comtypes`（装不上/`comtypes.gen` 不可写） | UIA 接口靠它运行时生成 | 自动降级：点击/输入仍可用，但只走消息投递（`coverage='narrow'`、`inputMode='background-message-only'`）；自检里 `uia` 一项会报不可用 |
| Windows 后台按键读不回、组合键只能走消息投递 | UIA 没有"投递按键"的 pattern | `key` 的 `verification` 恒为 `unknown`（不声称按下了）；组合键对浏览器类应用大概率无效 |
| Windows 上打字/点击后系统里可能残留按住的键（超时/强杀） | `SIGTERM` 在 Windows 上是硬杀，helper 来不及自己补发抬起 | 四层释放：①一次 `SendInput` 打包 down…up（不产生按住窗口）②常驻 watcher（父进程一死就补抬；**启动时也会收尾上一轮残留**）③helper 侧 30s 硬上限 ④超时与**非超时异常退出**（EDR 杀 python.exe）时补抬；拖拽中途失败会保留 hold 凭据交给 ②/③ 补抬 |
| Windows 释放时"抬错对象"（把别人的拖拽松开） | `~/.claude-gui/cu-runtime` 是**同一用户共享**的：同机可能同时跑着另一个 cc-gui 会话，它的 helper 正拖拽时会在同一个目录里留下 `hold-<pid>.json`（`keys` 里有 `MOUSE_LEFT`） | 三条收尾路径（超时 / 关停 / watcher 的启动与 EOF）**都按属主 pid 过滤**，只收"属主已不在（或凭据超期）"的那些；`release-hold` 只在**给了 `--keys` 时抬这些键**（不给才退回"ctrl/shift/alt/win + 左右键"的兜底）；没有孤儿凭据时**一次 `release-hold` 都不发**。<br>两条实现约束（`0.2.412` delta 审查 D-2）：①`deadPids` 的语义是"**调用方确定已死亡的 pid**"（我刚 SIGKILL 的、刚触发 exit 的），**绝不能**塞"目录里所有凭据的属主"（那会让过滤退化成 no-op）；②关停路径必须在 `killAllHelpers()` **之前**快照 `activeHelpers`（那个函数会 `clear()`）。<br>**属主还活着的孤儿 helper 不归这三条路管**：helper 的层 3（`_start_guard` 持有父进程的 `SYNCHRONIZE` 句柄）在父进程死后 200ms 内自己补发抬起并退出 —— 这条是已实现的保证，不是"窗口小"。 |
| Windows：`venv` 缺失时启动收尾只清凭据、不补抬 | 补抬要走 venv 里的 Python；运行时还没建好就没有执行层可用 | watcher 启动时若 `VENV_PY`/helper 不存在：**删掉**孤儿凭据（清掉幽灵状态）但不发 `release-hold` —— 这是"尽力而为"的边界，不是"删了等于抬了"。首次「准备环境」完成后才有补抬能力 |
| 依赖 Python **3.9+**（两个平台都是） | `findPython3` 会解析 `--version`，非 3.9+ 的候选直接跳过（Windows 上 `py` 可能挑到 2.7，macOS 上旧 `python3` 同理） | macOS 3.8 及以下：从"能跑"变成明确报错「找不到 Python（需要 3.9+）」（mac 侧的 pyobjc 依赖本来也要求较新的解释器）；Windows 会继续试下一个候选 |
| Windows 上 `delete` 是退格不是 Delete 键 | 契约里 `delete` 是 `backspace` 的别名（与 macOS 一致，两端同义） | 想按标着 Delete 的那个键，用 `vk_delete` 或 `del`（`VK_DELETE` 0x2E）；工具描述里已写明 |
| 手填的 exe 路径大小写/斜杠与内核路径不同 | 同一台机器上 `c:/windows/system32/notepad.exe` 与 `C:\Windows\System32\notepad.exe` 是同一个文件 | 授权查表、窗口匹配、`cursor` 的授权过滤都做**归一化**（分隔符统一 + 大小写不敏感）；`/app-info` 还会把路径换回内核里的真实大小写 |

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
| 首次调用卡 1-3 分钟 | 在建 venv 装依赖 | 等一次即可，之后秒回（Windows 可先点卡片上的「准备环境」） |
| Windows：点击/输入报 `CU_BACKGROUND_UNSUPPORTED` | 目标没有 UIA 元素，也投不进窗口消息（自绘界面/Java/安全桌面） | 这是**设计内**的明确失败；确有必要时用**新的 actionId** 重试并显式 `foreground:true`（会移动真实光标、把目标切到前台） |
| Windows：点击/输入报 `CU_UIPI_BLOCKED` | 目标以管理员身份运行，完整性级别更高 | 用管理员身份重试，或换一个同级别的目标；前置自检的 `integrityLevel` 会报本进程级别 |
| Windows：Chrome/Edge 第一次后台失败、第二次成功 | 渲染器的 accessibility 树是按需开启的，生效有延迟 | 重试一次即可（**这是已知边界，不是 bug**） |
| Windows：`inputMode` 停在 `none`、提示"点击与输入尚未提供" | 还没建立 UIA 可用性结论（缓存缺失） | 点卡片上的「准备环境」（或「环境自检」）跑一次探测；结论出来前本仓不声明输入可用 |
| Windows：报"helper 输出不可解析" | 中文控制台的 cp936 把 JSON 编坏了 | 已修（helper 侧 `sys.stdout.reconfigure(encoding="utf-8")` + spawn 注入 `PYTHONIOENCODING=utf-8`）；仍复现请附自检输出 |
| Windows：安装/自检/截图时闪黑框 | 每次 helper spawn 都开控制台窗口 | 已修（8 处 spawn 全部 `windowsHide: true`：`findPython3` 探测、建 venv/pip、`runHelper`、`releaseHeldKeys`、watcher、watcher 的 `release-hold`、路由侧两处）；仍闪框请报是哪一步 |
| `computer-use` 名字注册失败 | 保留名 | 用面板安装（自动叫 `ccgui-computer-use`） |

## 文件与实现

- `server/computer-use/mcp-server.js` — MCP stdio server（零依赖手写 JSON-RPC：错误码 `-32700/-32600/-32601/-32602`、实例身份、动作登记表、快照表、授权与坐标判定、回执信封）
- `server/computer-use/cu_helper.py` — macOS 执行层子命令 CLI（stdout 只出 JSON；AX 定向读写 + 事件定向投递 + 截图 + 权限自检）
- `server/computer-use/cu_helper_windows.py` — Windows 执行层（同一套子命令名；`mss`+Pillow 截图、`ctypes` 枚举窗口/DPI/完整性级别、UIA 元素级操作 + `PostMessage` 消息投递 + `SendInput` 全局投递、hold/release-hold）
- `server/computer-use/cu-hold-watcher.js` — Windows 按键释放的常驻守护（父进程一死就从管道 EOF 醒来，读 hold 文件补发抬起）
- `server/computer-use/cu-common.js` — Runtime 目录解析（按平台）、依赖表/解释器候选、授权存储、能力/锁屏状态、UIA 可用性缓存（GUI 后端与 MCP 共用）
- `server/routes/computer-use.js` — GUI 的 status/doctor/prepare/grants/apps/app-info 端点
- `client/src/components/MCPPanel.jsx` — 安装卡（注册复用通用 `/api/mcp`）；`CuGrants.jsx` — 按应用授权区块（文案按 `appIdKind` 切）
- 运行时：`~/.claude-gui/cu-runtime/`（`grants.json` + `shots/` + 依赖戳；Windows 另有 `uia-capability.json` 缓存 UIA 可用性结论、`hold-<pid>.json` 记录"正按住的键"）
  - macOS：`venv/`（`bin/python3`）+ `venv.stamp`；Windows：`venv-win/`（`Scripts\python.exe`）+ `venv-win.stamp`。两套布局按平台各取一套，互不影响。
- 单测：`tests/unit/check-cu-{mapping,keys,shots,protocol,actions}.mjs`（node 直跑，失败非零退出）；Windows 平台分派另有 `check-cu-{capabilities-platform,platform-dispatch,uia-cache,win-tool-desc,helper-contract,no-silent-global,win-hold-release}.mjs`（本机 mac 上用"伪 win32"跑 Node 侧，Windows API 层只能真机验）

## Windows 支持状态

**已提供**（与 macOS 同一套工具名与契约，`status.supported=true`）：

| 能力 | Windows 实现 | 与 macOS 的差别 |
|---|---|---|
| 截图 / 窗口列表 / 光标 / 自检 | `mss` + Pillow；`EnumWindows` + `QueryFullProcessImageNameW`；`GetCursorPos` + `WindowFromPoint` | 有 DPI 感知（`SetProcessDpiAwarenessContext`，150% 缩放下坐标才对）、完整性级别、UIA 三项自检；没有 TCC 权限模型（自检里辅助功能恒 `not-applicable`） |
| 应用身份 | **exe 绝对路径**（`/status.appIdKind='exePath'`） | macOS 是 bundleId；授权、`window_list`、`app-info` 的字段名沿用 `bundleId`，值换成了路径 |
| 后台点击/输入 | UIA 元素级 → `PostMessage` 消息投递（阶梯） | macOS 是 `CGEventPostToPid` + AX 直写，覆盖率高；Windows 只做到**部分覆盖**（见"已知边界"），拿不到元素时**明确报错**而不是偷偷抢前台 |
| 后台按键 | 消息投递（组合键没有 UIA pattern） | 读不回目标文本 ⇒ `verification` 恒 `unknown` |
| 前台（显式 `foreground:true`） | `SendInput`，多显示器负坐标按虚拟屏原点归一化 | 同 macOS 的"只在显式同意后才走"，只是机制换成全屏注入 |
| 按键释放 | 四层保证（一批投递 / 常驻 watcher / helper 30s 上限 / 关停与超时先杀后释放） | macOS 靠可捕获的 `SIGTERM` + `up_on_abort`；Windows 的 `SIGTERM` 是硬杀，所以另做了一套 |
| 锁屏 / 按应用窗口截图 | 未提供 | 与 macOS 一样：`unverified`/`disabled`，不伪造 |

**没做的**：Java/自绘界面/安全桌面（UAC、锁屏）覆盖不到；UWP/WinUI 的跨进程边界可能需要 `UIAccess` 清单；Windows 上的"后台"不是 macOS 那种真后台直投，而是"元素级优先 + 消息投递兜底"的降级链。

**EDR / 杀软（企业环境必读）**：本功能会做三件在安全软件视野里很显眼的事 —— ①建 venv 并联网 pip 安装（首次）；②持续抓屏；③注入键鼠输入（全局 `SendInput` 尤其像键盘记录器）。我们**不做任何绕过手段**：不隐藏进程、不注入 DLL、不改系统设置。企业机器上可能遇到 `python.exe` 被隔离、`SendInput` 被拦（回执会报 `CU_UIPI_BLOCKED`/`CU_DISPATCH_FAILED`）、或静默无效果。遇到拦截请让 IT 加白名单，而不是绕过；自检里的 `integrity_level` 与回执的稳定错误码就是给这件事定位用的（`integrity_level` 拿不到真实级别时自检报 `unverified`，不写 `available`）。

## Windows 的三个坐标/范围口径（真机验收时按这节核对）

| 口径 | 定义 | 为什么 |
|---|---|---|
| **坐标系** | Windows 侧**全程物理像素**：`window_list` 的 `bounds`、截图的 `pixel`/`logical`/`bounds`、以及所有输入坐标都在同一个空间 | 进程在启动时设了 DPI 感知（`SetProcessDpiAwarenessContext`），此时 `GetSystemMetrics`/`GetWindowRect`/`mss` 拿到的都是物理像素。macOS 才有"逻辑点 vs 像素"两套（输入 API 用点），Windows 不需要除以缩放 —— 除了会让 `bounds` 比真实值小 1/scale、模型按 `bounds` 中心点算就会偏 |
| **`logical` 字段** | = 被捕获区域在**输入坐标系**里的尺寸（Windows 上就等于物理像素尺寸；mac 上是逻辑点） | 字段名沿用跨平台契约；Node 侧 `mapPoint` 用它把「图片像素」折算回「输入坐标」—— 两边不同坐标系时折算就会错 |
| **取屏范围** | 截图只含**主屏**（`SM_CXSCREEN`/`SM_CYSCREEN`，原点 (0,0)）；`displayId` 恒为 `1`（主屏的合成 id） | 用户被问的是「允许**主屏**全部可见内容」。旧实现抓 `monitors[0]`（全显示器拼接虚拟屏）会把副屏像素也交给模型，属于同意范围被实现放大 |
| **`scale` 字段** | 只作**报告**用（`doctor.scale` / 截图回执）；不参与任何坐标折算 | 保留它是为了让自检能核对系统缩放，而不是当作坐标系换算因子 |

Windows 的窗口尺寸验收（150% 缩放机器）：截一张图，量某个窗口在图片里占的像素高，应当等于 `window_list` 里该窗口的 `bounds.h`（±1）。

**平台分派点（为什么这些门不是"能力被关掉"，W-C5 三问已逐条答过）**：

| 分派点 | ①是平台门吗 | ②有替代实现吗 | ③用户被告知了吗 |
|---|---|---|---|
| `mcp-server.js` 的 `HELPER`（`cu_helper.py` / `cu_helper_windows.py`） | 是（按平台选执行层文件） | 两个平台**各有完整执行层**，不是"关掉一侧" | 本文档 + 面板文案 |
| `ACTIVE_PY_DEPS`（pyobjc 表 / mss+Pillow+comtypes 表） | 是（依赖表按平台） | 见上：Windows 侧是一份**能装能跑**的完整依赖表 | 本文档「首次运行」 |
| `if (!IS_WIN) return …`：`releaseHeldKeys` / `startHoldWatcher` / `probeUia` / `platformFields` | 是（这四处是"Windows 专属机制"的门） | macOS 有**自己的等价实现**：可捕获的 `SIGTERM` + `up_on_abort` 补发抬起（不需要 watcher）、AX 定向投递（不需要 UIA）、`/status` 按契约不带 `inputMode/uiaReady`（W-D02 反向守卫锁死） | 本文档「Windows 支持状态」+「已知边界」 |
| `capabilityReport` 的三张 win32 表 / `inputMode` 五态 | 不是门，是**声明**：`available/unsupported/unverified` 逐项带 reason | 覆盖不到的场景都有明确降级路径（UIA → 消息投递 → `CU_BACKGROUND_UNSUPPORTED`） | 面板副标题 + 降级提示条 + 本文档 |
| 不支持的平台（linux 等） | 是（`supported:false`） | 没有实现，也没有替代实现 | **UI 占位卡直说"当前平台(linux)不支持：…"**（不再静默消失）+ 本文档；接口同时回 `reason` |

> 本表的用途是留痕：`platform-compat-review` 的 W-C5 规则会把上面这些 `!IS_WIN` 门卫与平台常量报成 must/hint 命中 —— 命中不等于缺陷，按三问核对后**有意保留**在这里，改动前请重跑一次全树 scan 并更新本表。

**真机验证**：Windows API 层（`SendInput` 结构体布局、UIA 覆盖率、DPI/UIPI、cp936、EDR 反应）**在本仓的 CI 上零覆盖**（CI 不跑任何单测/真机脚本），必须按 `.devflow/TEST-PLAN-r142.md` §5 的 A/B 两组清单在真机上跑一遍。

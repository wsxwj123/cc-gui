; NSIS 安装器钩子:装完检测 Node.js,缺失则提示并打开官方下载页。
; Claude GUI 后台 server 跑在 node 上,没 node 启动会失败(运行时另有原生报错框兜底)。
; 注意:安装器是提权进程,PATH 与登录用户不同 —— per-user / nvm 装的 node 可能在这里
; 检测不到(误报),所以文案声明"若已装可忽略",且不替代运行时检测。检测顺序:
; 标准安装目录 node.exe → where node(走系统 PATH)。
; $0 用 Push/Pop 平衡保存,避免污染 Tauri 安装器模板的寄存器。

; 装前钩子:先杀残留进程树,再让 NSIS 覆盖写文件。
; 根因:GUI 点关闭=最小化到托盘(托盘式设计,后端常驻),后端 node 的 cwd =
; <安装目录>\resources\_up_;Windows 不能覆盖被活进程占用 cwd 的目录,残留 node 会让
; NSIS 覆盖安装报"无法 write"。锁源是 node(cwd 在安装目录),Claude GUI.exe 只是症状。
; 原则:杀不到 = 没残留,属正常;任何一步失败都不 abort 安装(不 IfErrors/不 Abort)。
!macro NSIS_HOOK_PREINSTALL
  Push $0

  ; 1) 主杀:按 image 名整树杀。productName="Claude GUI" 且未设 mainBinaryName,主程序即
  ;    "Claude GUI.exe";/T 连带子进程(GUI→node→claude→MCP)。image 名带空格必须加引号。
  nsExec::Exec 'taskkill /F /T /IM "Claude GUI.exe"'
  Pop $0

  ; 2) 孤儿兜底:若 Tauri 的 NSIS 模板在本钩子之前已强杀主进程(不带 /T),node 会成孤儿、
  ;    /IM 已找不到 → 按命令行含【本次安装目录 + server\index.js】精确定位再杀。两步都做、
  ;    幂等无害,不依赖钩子执行顺序的假设。用 Get-CimInstance(wmic 在 Win11 24H2 已移除,
  ;    与仓库既有约定一致)。转义说明:$$_ 是 NSIS 转义后的 PowerShell $_;$INSTDIR 由 NSIS
  ;    展开成真实安装路径(-like 里反斜杠为字面量);CommandLine 可能为 null,先判空防炸。
  ;    默认安装路径不含 [ ] 等 -like 通配符,故直接内插;非默认路径含通配符是极端情形,不处理。
  nsExec::Exec `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $$_.CommandLine -and $$_.CommandLine -like '*$INSTDIR*server*index.js*' } | ForEach-Object { taskkill /F /T /PID $$_.ProcessId }"`
  Pop $0

  ; 3) 进程退出到文件句柄真正释放有延迟,等一拍再让 NSIS 开始写文件。
  Sleep 500

  Pop $0
!macroend

; 本机手工验证(Windows 真机):
;   1) 装旧版 Claude GUI 并启动,开一个会话(拉起后端 node、可能拉起 claude.exe),点关闭(最小化到托盘)。
;   2) 直接运行新版 setup.exe 覆盖安装 → 应不再报"无法 write"。
;   3) 装完在 PowerShell 跑 `Get-CimInstance Win32_Process | ?{ $_.CommandLine -like '*server*index.js*' }`,
;      应无旧安装目录的残留 node;`Get-Process 'Claude GUI' -ErrorAction SilentlyContinue` 应为空。

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  ; 安装器是【提权进程】,PATH 是管理员的,`where node` 看不到当前登录用户 PATH 里的
  ; node(用户报:安装时说没装、装完运行时又检测到)。所以先按固定位逐个查——与运行时
  ; lib.rs 的 windows_node_candidates 同一份清单,覆盖 per-user / nvm / scoop / volta。
  ; 1) 官方安装器(所有用户)
  IfFileExists "$PROGRAMFILES64\nodejs\node.exe" cgui_node_ok 0
  IfFileExists "$PROGRAMFILES32\nodejs\node.exe" cgui_node_ok 0
  ; 1b) 官方安装器「仅为我安装」→ per-user 目录(提权 where node 的最大盲区,最常见)
  IfFileExists "$LOCALAPPDATA\Programs\nodejs\node.exe" cgui_node_ok 0
  ; 1c) volta / scoop 常见真身位
  IfFileExists "$LOCALAPPDATA\Volta\bin\node.exe" cgui_node_ok 0
  IfFileExists "$PROFILE\scoop\apps\nodejs\current\node.exe" cgui_node_ok 0
  IfFileExists "$PROFILE\scoop\apps\nodejs-lts\current\node.exe" cgui_node_ok 0
  ; 2) where node(系统 PATH);nsExec::Exec 只压退出码,不留输出在栈上
  nsExec::Exec 'cmd /c where node'
  Pop $0
  StrCmp $0 "0" cgui_node_ok cgui_node_missing

  cgui_node_missing:
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
      "Claude GUI 需要 Node.js 才能运行,但未检测到。$\r$\n$\r$\n点「确定」打开 Node.js 官方下载页,安装后再启动 Claude GUI。$\r$\n$\r$\n(若你确信已安装:可能是为当前用户/版本管理器安装,安装器检测不到,可忽略——重启电脑后启动即可。)" \
      IDOK cgui_open_node IDCANCEL cgui_node_ok
    cgui_open_node:
      ExecShell "open" "https://nodejs.org/en/download"

  cgui_node_ok:
  Pop $0
!macroend

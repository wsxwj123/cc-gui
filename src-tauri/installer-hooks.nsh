; NSIS 安装器钩子:装完检测 Node.js,缺失则提示并打开官方下载页。
; Claude GUI 后台 server 跑在 node 上,没 node 启动会失败(运行时另有原生报错框兜底)。
; 注意:安装器是提权进程,PATH 与登录用户不同 —— per-user / nvm 装的 node 可能在这里
; 检测不到(误报),所以文案声明"若已装可忽略",且不替代运行时检测。检测顺序:
; 标准安装目录 node.exe → where node(走系统 PATH)。
; $0 用 Push/Pop 平衡保存,避免污染 Tauri 安装器模板的寄存器。

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

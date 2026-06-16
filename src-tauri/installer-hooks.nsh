; NSIS 安装器钩子:装完检测 Node.js,缺失则提示并打开官方下载页。
; Claude GUI 后台 server 跑在 node 上,没 node 启动会失败(运行时另有原生报错框兜底)。
; 注意:安装器是提权进程,PATH 与登录用户不同 —— per-user / nvm 装的 node 可能在这里
; 检测不到(误报),所以文案声明"若已装可忽略",且不替代运行时检测。检测顺序:
; 标准安装目录 node.exe → where node(走系统 PATH)。
; $0 用 Push/Pop 平衡保存,避免污染 Tauri 安装器模板的寄存器。

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  ; 1) 标准安装目录(官方安装器默认写这里,最常见)
  IfFileExists "$PROGRAMFILES64\nodejs\node.exe" cgui_node_ok 0
  IfFileExists "$PROGRAMFILES32\nodejs\node.exe" cgui_node_ok 0
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

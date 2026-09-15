// 代码块 → 内置终端 的运行请求总线。
// CodeBlock ▶ 按钮只调 requestTerminalRun();确认门(首次必弹 + 本次会话记住)收在
// 这里,未来任何"送命令进终端"的入口(如工具卡片)复用同一道门,不会有人绕过确认。

import { confirmDialog } from './confirmDialog.jsx';

// 本次页面会话内已确认过(勾了"记住"或点了允许)——模块级变量,刷新即重置,
// 与"本次会话记住"的语义一致(重开 app 重新问)。
let allowedThisSession = false;

// 仅命令语言:console/terminal/commandline 块几乎都是"提示符+命令+输出"的记录,
// 整块粘进真实 shell 会把长得像命令的输出行也执行掉(脚枪),不放进白名单。
const RUNNABLE_LANG_RE = /^(bash|sh|shell|zsh|powershell|pwsh|cmd)$/i;
export function isRunnableLang(lang) {
  return RUNNABLE_LANG_RE.test(String(lang || ''));
}

// TerminalPanel 挂载时机晚于点击(面板未开时先开面板),待执行命令先落这里。
// 单槽 + 时间戳:面板 live 时由事件监听直接取走;超过 60s 未被消费视为陈旧请求
// 丢弃 —— 否则几小时前的旧命令会在用户某次手动重连时毫无预期地打进 shell。
let pending = null; // { command, at }
export function takePendingTerminalCommand() {
  const p = pending;
  pending = null;
  if (p && Date.now() - p.at > 60_000) return null;
  return p?.command ?? null;
}

export async function requestTerminalRun(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (!allowedThisSession) {
    const lineCount = cmd.split('\n').length;
    // 确认框必须摊开**完整**命令(合同:确认框显示将执行的完整命令)。原来超过 1200 字符
    // 会掐头去尾成"…(中间略)…",用户核对的是摘要却以为核对了全文 —— 危险方向。
    // 长文由 confirmDialog 的正文滚动区承载,不截断。
    const r = await confirmDialog(
      `将在内置终端中执行以下命令(真实执行,共 ${lineCount} 行 / ${cmd.length} 字符,请检查全部内容):\n\n${cmd}`,
      {
        confirmText: '运行',
        checkbox: { label: '本次会话记住,不再询问' },
      },
    );
    const confirmed = typeof r === 'object' ? r.confirmed : r;
    if (!confirmed) return false;
    if (typeof r === 'object' && r.checked) allowedThisSession = true;
  }
  pending = { command: cmd, at: Date.now() };
  window.dispatchEvent(new CustomEvent('cgui-run-in-terminal'));
  return true;
}

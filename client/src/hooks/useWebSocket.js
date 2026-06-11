import { useEffect, useRef } from 'react';
import { useStore } from '../stores/sessionStore.js';

// G3:危险命令启发式 —— 删除类 + 网络/装包 + sudo。命中即强制弹窗,不被任何自动放行豁免。
// 与 server/hooks/permission-bridge.js 的 DANGEROUS_BASH 保持一致(两端各一份,改一处记得同步)。
const DANGEROUS_BASH = /\brm\s+-[a-z]*[rf]|\bgit\s+clean\s+-[a-z]*f|\bgit\s+push\b[^\n]*(--force|\s-f\b)|\bgit\s+reset\s+--hard\b|\bdrop\s+(table|database)\b|\btruncate\b|\bmkfs\b|\bdd\s+if=[^\n]*of=\/dev|[|]\s*(sudo\s+)?(ba)?sh\b|\bnpm\s+(i|install|add)\b|\bpnpm\s+(i|install|add)\b|\byarn\s+(add|install)\b|\bpip[23]?\s+install\b|\bbrew\s+install\b|\bsudo\b/i;
function isDangerousCommand(req) {
  if (req?.toolName !== 'Bash') return false;
  return DANGEROUS_BASH.test(String(req?.toolInput?.command || ''));
}

export function useWebSocket() {
  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const setCurrentModel = useStore((s) => s.setCurrentModel);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current);
          reconnectRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          switch (data.type) {
            case 'model':
              setCurrentModel(data.model);
              break;
            case 'provider-change':
              // ~/.claude/settings.json changed (e.g. `cc switch`). Tell any
              // component that cares to refetch — handled via a window event so
              // we don't have to thread refetch callbacks through state.
              // W3①:server 带 provider 指纹时,与上次比较 —— 指纹真的变了(终端
              // cc switch 等 GUI 之外的切换)才清模型钉选 + 推进 providerEpoch,
              // 与 GUI 内切换的失效语义对齐;首次见到指纹只记录不清(避免误伤)。
              try {
                const fp = data.providerFp;
                if (fp) {
                  const prev = localStorage.getItem('cgui-provider-fp');
                  if (prev && prev !== fp) useStore.getState().clearModelOverrides?.();
                  localStorage.setItem('cgui-provider-fp', fp);
                }
              } catch {}
              window.dispatchEvent(new CustomEvent('cgui:provider-change'));
              break;
            case 'file-change':
              // When a .jsonl session log changes/appears under ~/.claude/projects/,
              // tell the sidebar to silent-refresh the project's session list.
              // This is what makes a newly-spawned session appear in history
              // immediately (instead of waiting for the post-chat setTimeout).
              // 兼容 Windows 反斜杠路径(chokidar 在 Windows 上发回 `\projects\`),
              // 此前只检查 `/projects/` → Windows 端新会话出现后侧栏列表不刷新。
              if (typeof data.path === 'string'
                  && (data.path.includes('/projects/') || data.path.includes('\\projects\\'))
                  && data.path.endsWith('.jsonl')) {
                window.dispatchEvent(new CustomEvent('cgui:sessions-changed', { detail: { path: data.path } }));
              }
              break;
            case 'permission:request': {
              const req = data.request;
              // 诊断 Bug1(授权后工具仍不执行 / 不弹窗):打印每次收到的请求 + 命中分支。
              // 服务端 hook 实测正常 POST,可疑点在客户端这一段。下次复现时打开
              // 控制台过滤 [cgui-perm] 即可看出走的是哪条分支。
              try {
                console.log('[cgui-perm] WS request', {
                  id: req?.id, tool: req?.toolName, sid: req?.sessionId,
                  cwd: req?.cwd,
                });
              } catch {}
              // Mid-stream permission-mode override: even though chat.js
              // spawned the CLI with a fixed mode, the user can flip the
              // dropdown mid-stream and we honor it client-side. Order:
              //   1. bypassPermissions → auto-allow EVERYTHING immediately
              //   2. acceptEdits + tool in read-class list → auto-allow
              //   3. per-session "永远允许 X" whitelist → auto-allow
              //   4. otherwise → render popup
              // Use the mode of the SESSION THIS REQUEST belongs to — NOT the
              // global/active mirror. Otherwise a request for session B gets
              // auto-allowed because session A happens to be in bypass/accept
              // (the "授权串号" bug). Falls back to 'default' (prompt) when the
              // session has no stored mode.
              const mode = useStore.getState().getPermissionModeFor(req.sessionId);
              // U5:CLI 以 --permission-mode plan 固定 spawn,整个回合锁在规划模式;
              // 用户中途切出 plan 后,旧实现仍渲染规划卡片 → "一直给我规划卡片"。
              // 现在:已切出 plan 时收到 ExitPlanMode,直接 deny 收尾本回合,提示模型
              // 结束规划(进程级模式无法中途改变,新模式从下一条消息开始生效)。
              if (req.toolName === 'ExitPlanMode' && mode !== 'plan') {
                console.log('[cgui-perm] auto-finish: ExitPlanMode while mode=' + mode, req.id);
                fetch(`/api/permissions/respond/${req.id}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    decision: 'deny',
                    reason: '用户已切出规划模式（当前 ' + mode + '）。请勿继续规划或再次调用 ExitPlanMode，直接简要总结并结束本回合；用户将以新模式重新发起请求。',
                  }),
                }).catch(() => {});
                break;
              }
              const READ_CLASS = ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'NotebookRead', 'Skill'];
              const PLAN_WRITE_CLASS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
              // G3:危险命令(删除/网络装包/sudo)在 default / acceptEdits 下、或已"永远允许 Bash"
              // 时,也强制弹窗确认 —— 跳过下面的自动放行分支。但【放任模式】例外:用户明确要求
              // 放任就是无脑放行一切(含 rm/install),所以放任下不拦。
              if (isDangerousCommand(req) && mode !== 'bypassPermissions') {
                console.log('[cgui-perm] → force prompt (dangerous)', req.id, req.toolName);
                useStore.getState().addPendingPermission(req);
                break;
              }
              // 放任模式排除 AskUserQuestion:它必须弹 GUI picker 让用户选,
              // 否则被 auto-allow → CLI headless 无法运行该工具 → AI 退化成正
              // 文提问(用户报告的"放任下 ask 不弹窗")。与服务端 hook 的
              // CGUI_BYPASS_ALL_EXCEPT_ASK 语义对齐。
              if (mode === 'bypassPermissions' && req.toolName !== 'AskUserQuestion') {
                console.log('[cgui-perm] auto-allow: bypass', req.id);
                fetch(`/api/permissions/respond/${req.id}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ decision: 'allow' }),
                }).catch(() => {});
                break;
              }
              if (mode === 'plan' && PLAN_WRITE_CLASS.includes(req.toolName)) {
                // 规划模式放行计划类文档(.md/.txt/.rst 或名含 plan/todo/计划),只拦源
                // 代码文件(#4)。与服务端 permission-bridge 的 isPlanClassPath 对齐。
                const ti = req.toolInput || {};
                const fp = String(ti.file_path || ti.path || ti.notebook_path || '').toLowerCase();
                const base = fp.split(/[\\/]/).pop() || '';
                const planClass = /\.(md|markdown|txt|rst|mdx)$/.test(fp) || /(plan|todo|notes?|draft|计划|待办)/.test(base);
                if (!planClass) {
                  console.log('[cgui-perm] deny: plan write', req.id, req.toolName);
                  fetch(`/api/permissions/respond/${req.id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      decision: 'deny',
                      reason: '当前是规划模式：禁止修改源文件。可写计划类文档(.md/.txt 或名含 plan/todo)，或用 ExitPlanMode 提交计划供用户审批。',
                    }),
                  }).catch(() => {});
                  break;
                }
                // 计划类文档 → 不在此拦截,继续往下(默认弹窗/或其他模式处理)
              }
              if (mode === 'plan' && READ_CLASS.includes(req.toolName)) {
                console.log('[cgui-perm] auto-allow: plan+readClass', req.id, req.toolName);
                fetch(`/api/permissions/respond/${req.id}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ decision: 'allow' }),
                }).catch(() => {});
                break;
              }
              if (mode === 'acceptEdits' && READ_CLASS.includes(req.toolName)) {
                console.log('[cgui-perm] auto-allow: acceptEdits+readClass', req.id, req.toolName);
                fetch(`/api/permissions/respond/${req.id}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ decision: 'allow' }),
                }).catch(() => {});
                break;
              }
              const wl = JSON.parse(localStorage.getItem(`cgui-perm-wl-${req.sessionId || 'none'}`) || '[]');
              if (wl.includes(req.toolName)) {
                console.log('[cgui-perm] auto-allow: whitelist', req.id, req.toolName);
                fetch(`/api/permissions/respond/${req.id}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ decision: 'allow' }),
                }).catch(() => {});
                break;
              }
              console.log('[cgui-perm] → render popup (mode=' + mode + ')', req.id, req.toolName);
              useStore.getState().addPendingPermission(req);
              break;
            }
            case 'permission:resolved':
              useStore.getState().removePendingPermission(data.id);
              break;
            case 'custom-titles':
              // Another device renamed a session. Adopt the server's full map
              // so titles converge live (no refresh needed).
              useStore.getState().applyRemoteTitles(data.titles || {});
              break;
            case 'auto-titles':
              // W4:AI 自动标题在任一端生成后,所有端实时收敛。
              useStore.getState().applyRemoteAutoTitles(data.titles || {});
              break;
            case 'turn-complete': {
              // T2: 非聚焦会话回合完成 → 顶部悬浮提醒(标题+摘要,5s,点击跳转)。
              // 由服务端广播驱动 —— 切走会话时前端的 SSE fetch 已被切会话 effect
              // abort,流闭包末尾的完成代码永远到不了,只能依赖服务端信号。
              const st = useStore.getState();
              const sid = data.sessionId;
              if (!sid) break;
              const focused = st.paneSessions[st.activeTabIndex]?.sessionId;
              if (sid === focused) break; // 正在看的会话,回复就在眼前,不打扰
              const sess = (Array.isArray(st.sessions) ? st.sessions : []).find((x) => x.sessionId === sid);
              st.pushCompletionToast({
                sessionId: sid,
                projectHash: data.projectHash || sess?.projectHash || null,
                session: sess || { sessionId: sid, projectHash: data.projectHash || null, draft: false },
                title: st.customTitles?.[sid] || st.autoTitles?.[sid] || sess?.firstPrompt?.slice(0, 24) || '会话',
                summary: data.summary || '',
                ts: Date.now(),
              });
              break;
            }
          }
        } catch {}
      };

      ws.onclose = () => {
        if (cancelled) return;
        reconnectRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        try { ws.close(); } catch {}
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect after unmount
        try { wsRef.current.close(); } catch {}
      }
    };
  }, [setCurrentModel]);

  return wsRef;
}

import { useEffect, useRef } from 'react';
import { useStore } from '../stores/sessionStore.js';

// G3:危险命令启发式 —— 删除类 + 网络/装包 + sudo。命中即强制弹窗,不被任何自动放行豁免。
// 【权威判定在服务端 server/routes/chat.js 的 DANGEROUS_BASH】(canUseTool 内强拦,
// 客户端离线/多设备状态异常也兜得住);这里保留一份仅用于把这类请求渲染成红色警示卡+
// 越过客户端自身的白名单/auto-allow。两处正则应保持同步。
const DANGEROUS_BASH = /\brm\s+-[a-z]*[rf]|\brm\s+--(recursive|force)|\bgit\s+clean\s+-[a-z]*f|\bgit\s+push\b[^\n]*(--force|\s-f\b)|\bgit\s+reset\s+--hard\b|\bgit\s+branch\s+-D\b|\bfind\b[^\n]*-delete\b|\bshred\b|\bdrop\s+(table|database)\b|\btruncate\b|\bmkfs\b|\bdd\s+if=[^\n]*of=\/dev|>\s*\/dev\/sd|[|]\s*(sudo\s+)?(ba)?sh\b|\bnpm\s+(i|install|add)\b|\bpnpm\s+(i|install|add)\b|\byarn\s+(add|install)\b|\bpip[23]?\s+install\b|\bbrew\s+install\b|\bsudo\b|\b(del|erase)\b[^\n]*\/[sq]|\brd\b[^\n]*\/s|\brmdir\b[^\n]*\/s|\bremove-item\b[^\n]*-(recurse|force)|\bformat\s+[a-z]:/i;
// 导出供 PermissionPrompt 复用(危险命令卡隐藏"始终允许"选项,与服务端 allowAlways:false 对齐)。
export function isDangerousCommand(req) {
  if (req?.toolName !== 'Bash') return false;
  return DANGEROUS_BASH.test(String(req?.toolInput?.command || ''));
}

// 正在提交/重试中的请求 id → { cancelled }。两个作用:
//   ① 同一 id 并发提交只跑一个(双实例/双击/对账重放都可能重复触发);
//   ② 对账补拉重放 handlePermissionRequest 时跳过 in-flight 的 id,防止
//      auto-allow 分支与用户已点的 deny 竞速双写。
const inFlightResponds = new Map();

// 共享提交器:把权限应答送达服务端为止。手机(Tailscale)半死 TCP 上一次性
// POST 会静默丢失 → CLI 永久挂起等应答、刷新后同一弹窗重现(死循环根因)。
// 单次 8s 短超时(快失败快重试,超时还会让浏览器废弃死掉的池连接,下次拿新
// TCP),失败后递增间隔无限重试。服务端 respond 幂等(alreadyResolved),重试
// 绝不会把同一应答写两次进 CLI。终止条件三选一:
//   送达成功(HTTP 2xx,含 alreadyResolved)/ 卡片已被他端解决(对账或
//   resolved 广播撤卡)/ cancelRespond 明确取消。
// 服务端 15min TTL 与进程退出 dropPendingForSession 都会让重试命中
// alreadyResolved 收敛,不存在永久重试。
export async function respondPermission(id, body) {
  if (inFlightResponds.has(id)) return false; // 同 id 并发提交只跑一个
  const flight = { cancelled: false };
  inFlightResponds.set(id, flight);
  // 提交发起时卡片是否在 store 里:auto-allow/deny 分支从不入卡,对它们
  // "卡片不存在"是常态,不能当"他端已解决"提前终止;只有本来有卡、后来
  // 被 resolved 广播/对账撤掉,才说明他端已解决。
  const hadCard = useStore.getState().pendingPermissions.some((p) => p.id === id);
  try {
    for (let attempt = 0; ; attempt++) {
      if (flight.cancelled) return false;
      try {
        const r = await fetch(`/api/permissions/respond/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8_000),
        });
        if (r.ok) return true; // 含 alreadyResolved —— 都算送达
      } catch { /* 半死连接/超时,落到重试 */ }
      // 1s/2s/4s/8s 封顶的递增间隔:连接刚抖一下时快速恢复,持续断开时不刷屏
      await new Promise((ok) => setTimeout(ok, Math.min(1_000 * 2 ** attempt, 8_000)));
      if (hadCard && !useStore.getState().pendingPermissions.some((p) => p.id === id)) {
        return true; // 卡片已被 permission:resolved / 对账撤掉 → 他端已解决
      }
    }
  } finally {
    inFlightResponds.delete(id);
  }
}

// 组件侧的明确取消(如未来加"取消提交"按钮):置位后当前重试循环在下个
// 检查点退出,卡片去留由调用方决定。
export function cancelRespond(id) {
  const f = inFlightResponds.get(id);
  if (f) f.cancelled = true;
}

// permission:request 的完整处理:危险命令强制弹红卡,白名单(用户显式授权)放行,其余弹卡。
// A1 裁决单点化:mode 相关的 auto-allow/deny(bypass/plan/acceptEdits/U5 切出 plan)已全部
// 上收服务端 —— canUseTool 广播前按真值 slot.guiMode 裁决过,能到达这里的请求都是服务端
// 认为"该问人"的;用户中途切档由 POST /chat/permission-mode 触发服务端对 pending 重裁。
// 客户端不再读本地 mode 抢答(多端 localStorage 缓存过期 → 后台端 auto-deny 互抢的根因)。
// 抽成模块级函数:WS 实时分支与【断线重连后的 pending 补拉】共用同一套逻辑。
function handlePermissionRequest(req) {
  if (!req || !req.id) return;
  // in-flight 守卫:该 id 正在提交/重试中(多为用户已点了 deny/allow,应答还
  // 没送达)。对账重放到这里若再走 auto-allow 分支,会和用户的决定竞速双写。
  if (inFlightResponds.has(req.id)) return;
  try {
    if (import.meta.env?.DEV) console.log('[cgui-perm] WS request', {
      id: req?.id, tool: req?.toolName, sid: req?.sessionId,
      cwd: req?.cwd,
    });
  } catch {}
  // G3:危险命令(删除/网络装包/sudo)强制弹红色警示卡,越过白名单。放任模式下
  // 服务端已直接放行、根本不会广播到这里 —— 无需再按 mode 豁免。
  if (isDangerousCommand(req)) {
    if (import.meta.env?.DEV) console.log('[cgui-perm] → force prompt (dangerous)', req.id, req.toolName);
    useStore.getState().addPendingPermission(req);
    return;
  }
  // 白名单("本会话永远允许 X")是用户显式授权,非 mode 分支,保留客户端放行。
  // draft(sessionId=null)不吃白名单:共享遗留键 cgui-perm-wl-none 会把
  // 任何 draft 的同名工具自动放行(串放行),对该键一律不生效。
  // 越界访问(blockedPath)不吃白名单 → 强制弹越界卡(沙箱边界不静默扩权)。
  let wl = [];
  try { wl = req.sessionId ? JSON.parse(localStorage.getItem(`cgui-perm-wl-${req.sessionId}`) || '[]') : []; } catch {}
  if (Array.isArray(wl) && wl.includes(req.toolName) && !req.blockedPath) {
    if (import.meta.env?.DEV) console.log('[cgui-perm] auto-allow: whitelist', req.id, req.toolName);
    respondPermission(req.id, { decision: 'allow' });
    return;
  }
  if (import.meta.env?.DEV) console.log('[cgui-perm] → render popup', req.id, req.toolName);
  useStore.getState().addPendingPermission(req);
}

// 以服务端 pending 表为唯一真相做【对账】:add 服务端有而本地没有的卡(修
// "广播丢失→卡片永不出现"),remove 服务端已不存在的卡(修"他端已解决但
// resolved 广播丢了→卡片残留")。旧实现是事件驱动的一次性补拉、失败即放弃、
// 只加不删 —— 页面常驻前台时 visibilitychange 永不触发,重连后的补拉又可能
// 骑在同一条半死 keep-alive 连接上超时,之后无任何机制再触发。现在挂在 25s
// 心跳 tick 上周期执行,单次失败静默等下一轮(每 25s 必有下一轮,这就是自愈
// 保证)。addPendingPermission 按 id 去重、respond 服务端幂等,重复对账安全。
// export 仅供 tests/unit 自检覆盖"in-flight 卡不被对账误删"场景,运行时无外部调用方。
export async function refetchPendingPermissions() {
  const fetchStart = Date.now();
  try {
    const r = await fetch('/api/permissions/pending', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const d = await r.json();
    const items = d.items || [];
    const serverIds = new Set(items.map((x) => x.id));
    // remove:本地有、服务端没有、且【入列早于本次拉取】→ 已在他端解决/被 drop。
    // A2:判据用 receivedAt(入列时的客户端时钟戳,store.addPendingPermission 打)
    // 与 fetchStart 同钟比较 —— 原 createdAt 是服务端时钟,跨机漂移时 GET 飞行
    // 窗口内刚广播的新卡也可能满足 createdAt<fetchStart 被误删。
    // in-flight 守卫(与下方 add 侧对称):提交中的卡不许被对账撤掉 —— 误删会让
    // respondPermission 的 hadCard 判据误判"他端已解决"而放弃在途应答 → CLI
    // 继续挂。送达后卡由调用方/resolved 广播撤。
    for (const p of useStore.getState().pendingPermissions) {
      if (!serverIds.has(p.id) && (p.receivedAt || 0) < fetchStart && !inFlightResponds.has(p.id)) {
        useStore.getState().removePendingPermission(p.id);
      }
    }
    // add:重放进完整分流逻辑(内部按 id 去重 + in-flight 守卫不重放提交中的卡)
    items.forEach(handlePermissionRequest);
  } catch { /* 网络暂不可用,下个心跳 tick 再对账 */ }
}

export function useWebSocket() {
  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  // 最近一次收到任何入站消息(含 pong)的时间。心跳据此判定"半死连接":
  // Tailscale/手机网络下 TCP 常名存实亡却不触发 onclose,旧实现永远不重连 →
  // 卡片推不到、点了也发不出(手机端"卡片不出来/没反应"的根因)。
  const lastMsgRef = useRef(Date.now());
  const setCurrentModel = useStore((s) => s.setCurrentModel);

  useEffect(() => {
    let cancelled = false;
    // 是否已成功连过一次:重连成功(非首连)才发 cgui:ws-reconnected 让各处对账,
    // 首连不发(组件挂载本来就全量拉取,再发一次是浪费)。
    let hadConnected = false;

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
        lastMsgRef.current = Date.now();
        // 重连成功即补拉断线期间错过的权限卡(首连时列表通常为空,幂等无害)。
        refetchPendingPermissions();
        // 断线期间的 file-change 等广播已永久丢失(Tailscale 半死连接常态)→ 重连
        // 即广播一次对账事件,SessionDetail/侧栏各自 silent refetch,与权限卡同构。
        if (hadConnected) window.dispatchEvent(new CustomEvent('cgui:ws-reconnected'));
        hadConnected = true;
      };

      ws.onmessage = (event) => {
        lastMsgRef.current = Date.now();
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
            case 'project-file-change':
              // 项目工作目录文件变动(server /api/files/watch 的递归 watcher,已 500ms
              // 聚合)。转成 window 事件让 FileExplorerPanel 刷新已展开目录。
              window.dispatchEvent(new CustomEvent('cgui:project-file-change', {
                detail: { root: data.root, paths: data.paths || [] },
              }));
              break;
            case 'permission:request':
              handlePermissionRequest(data.request);
              break;
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
            case 'context-1m':
              // 1M 上下文会话标记(服务端持久化)在任一端改动后全端收敛。
              useStore.getState().applyRemoteContext1m(data.sessions || {});
              break;
            case 'session-sync':
              // 审计批A2:会话级偏好(权限档/模型 pin/力度 pin)任一端改动后全端收敛。
              // 提交中的键不被覆盖(store 内 in-flight 记账),不打断用户手上操作。
              useStore.getState().applyRemoteSessionSync(data);
              break;
            case 'task-notification-bg':
              // 停止链路 #3:回合间(无活跃 SSE)到达的子代理权威终态通知,server 经全局
              // WS 兜底送达。App.jsx 顶层监听此事件按 tool_use_id 调 finalizeAgent(幂等,
              // 终态守卫防重;SSE 在线时通知走原 SSE 路径,server 不广播此类型)。
              window.dispatchEvent(new CustomEvent('cgui:task-notification-bg', { detail: data }));
              break;
            case 'background-tasks':
              // 批A:服务端按 CLI 的 background_tasks_changed(全量存活集快照)对完账后广播。
              // App.jsx 顶层监听:settled 的直接收尾,本会话不在集内的僵尸卡剪掉。纯 UI 收敛,
              // 不驱动任何停止动作。卡片可能属于已切走/已关的窗格,那些窗格没有 SSE 通道,
              // 所以必须走全局 WS 而不是流内事件。
              window.dispatchEvent(new CustomEvent('cgui:background-tasks', { detail: data }));
              break;
            case 'turn-complete': {
              // T2: 非聚焦会话回合完成 → 顶部悬浮提醒(标题+摘要,5s,点击跳转)。
              // 由服务端广播驱动 —— 切走会话时前端的 SSE fetch 已被切会话 effect
              // abort,流闭包末尾的完成代码永远到不了,只能依赖服务端信号。
              const st = useStore.getState();
              const sid = data.sessionId;
              if (!sid) break;
              // CM-3:任何回合完成都刷新侧栏会话列表 —— 新会话的首个回合在此被广播到**所有**
              // 连接的客户端(手机/电脑),于是另一端无需"退出再进项目"就能看到新会话。
              // 原来只靠文件 watcher 轮询(2.5s、大目录易漏/滞后),跨设备常不刷新(用户报告)。
              window.dispatchEvent(new CustomEvent('cgui:sessions-changed', { detail: { projectHash: data.projectHash || null } }));
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

    // 心跳探活:每 25s 发应用层 ping(服务端回 pong,onmessage 刷新 lastMsgRef)。
    // 到点检查距上次任何入站消息 >40s(≥1 个 ping 周期无回音)→ 判定半死连接,
    // 主动 close 触发既有 onclose 3s 重连。CONNECTING/CLOSED 状态不动。
    // A3 节流防误杀:窗口最小化 >5min 后浏览器把定时器节流到 ~60s+,tick 间连
    // ping 都没发过,"40s 无消息"必然成立 → 误杀健康连接。记录 lastTickAt,本次
    // tick 距上次实际间隔 >35s(被节流的实锤)则本轮跳过判死、仍照常 ping+对账;
    // 只有本轮间隔正常(说明 ping 确实按周期发过)且仍 >40s 无入站才判死。
    let lastTickAt = Date.now();
    const hb = setInterval(() => {
      if (cancelled) return;
      const tickGap = Date.now() - lastTickAt;
      lastTickAt = Date.now();
      // 每个心跳 tick 顺带对账 —— 不看 WS 死活:WS 看似活着(readyState=1)但
      // 半死时广播已经丢了,正是对账在兜底;WS 真死时重连间隙也不留盲区。
      refetchPendingPermissions();
      const ws = wsRef.current;
      if (!ws || ws.readyState !== 1) return;
      if (tickGap <= 35_000 && Date.now() - lastMsgRef.current > 40_000) { try { ws.close(); } catch {} return; }
      try { ws.send('{"type":"ping"}'); } catch {}
    }, 25_000);

    // 手机切回前台:后台期间 WS 多被系统冻结/掐死且无事件,interval 也被暂停。
    // 立即处置:已死 → 马上重连(不等 3s 定时器);还开着 → 发 ping 探活 + 补拉
    // 错过的权限卡(半死连接随后会被心跳判死重连)。
    const onVisible = () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === 2 || ws.readyState === 3) { // CLOSING/CLOSED/无
        // 判官建议1:先摘掉老 socket 的 onclose 再重连 —— 否则切前台时老 socket 的
        // onclose 事件可能在 connect() 之后补触发、再排一个 3s 重连定时器;弱网下新
        // 连接握手 >3s 时定时器先响 → 双连接(重复广播/toast)。摘掉后彻底无竞态。
        if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
        if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
        connect();
      } else if (ws.readyState === 1) {
        try { ws.send('{"type":"ping"}'); } catch {}
        refetchPendingPermissions();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(hb);
      document.removeEventListener('visibilitychange', onVisible);
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

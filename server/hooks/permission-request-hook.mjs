#!/usr/bin/env node
/**
 * PermissionRequest hook bridge —— 后台代理(`claude --bg`)的权限应答通道。
 *
 * 后台代理跑在 default 档时,授权请求没有 canUseTool 通道可走:CLI 只能把会话置为
 * status:"waiting" / waitingFor:"permission prompt" 并【永久等待】。挂上这个 hook 后,
 * 请求转给 GUI 的挂起式端点 /api/permissions/request,以权限卡的形式出现在界面上,
 * 用户点允许/拒绝,裁决原路返回,代理继续跑。
 *
 * 由 server/routes/agents.js 派发后台代理时经 `--settings` 挂上,不写用户的
 * ~/.claude/settings.json。纯 node,无第三方依赖(CLI 用系统 node 直接跑本文件)。
 *
 * 输入(stdin JSON):{ session_id, cwd, tool_name, tool_input, permission_mode, … }
 * 输出(stdout JSON):{ hookSpecificOutput: { hookEventName, decision } }
 *   decision = { behavior:'allow', updatedInput? } | { behavior:'deny', message? }
 *
 * fail-safe:GUI 不可达 / 超时 / 非 2xx / 响应不可解析 —— 一律 deny。后台代理无人
 * 值守,放行等于静默绕过整个权限体系;宁可拒绝一次让用户重派,不可默认放行。
 */

// 端口由派发方写进 hook 命令行(GUI 端口可能是 6677..6687 中的任意一个)。
const PORT = process.argv[2] || process.env.CGUI_PORT || '6677';
// 比 hook 自身的 timeout(派发时设 300s)略短:自己先超时才能吐出 deny;
// 被 hook timeout 杀掉则没有任何输出,代理退回 CLI 原生的"永久等待"。
const TIMEOUT_MS = Number(process.env.CGUI_HOOK_TIMEOUT_MS) || 295_000;

function emit(decision) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  }));
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const main = async () => {
  let input = {};
  try { input = JSON.parse(await readStdin()) || {}; } catch { input = {}; }

  // 连工具名都读不出来(stdin 不是 JSON / 形态变了)就别弹卡:那张卡会写着
  // "Claude 想使用 unknown",用户无从判断该不该批。同样是 fail-safe 方向 —— 拒绝。
  if (!input.tool_name) {
    emit({ behavior: 'deny', message: 'cc-gui 未能解析本次授权请求（缺少工具名），按拒绝处理。' });
    return;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/permissions/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolName: input.tool_name,
        toolInput: input.tool_input || {},
        sessionId: input.session_id || null,
        cwd: input.cwd || null,
        hookEvent: 'PermissionRequest',
        // 卡片要标出"这是后台代理的请求",否则用户会以为是当前会话发起的。
        bgAgent: true,
      }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      emit({ behavior: 'deny', message: `cc-gui 授权端点返回 ${r.status}，本次操作按拒绝处理。` });
      return;
    }
    let d = null;
    try { d = await r.json(); } catch { d = null; }
    if (d && d.decision === 'allow') {
      // updatedInput:用户在卡片里改过的工具入参,与 canUseTool 的 allow 形态一致。
      emit(d.updatedInput && typeof d.updatedInput === 'object'
        ? { behavior: 'allow', updatedInput: d.updatedInput }
        : { behavior: 'allow' });
      return;
    }
    if (!d) {
      emit({ behavior: 'deny', message: 'cc-gui 的授权响应无法解析，本次操作按拒绝处理。' });
      return;
    }
    emit({ behavior: 'deny', message: d.reason || '用户在 cc-gui 中拒绝了该操作。' });
  } catch (e) {
    const why = ctl.signal.aborted ? `等待授权超过 ${Math.round(TIMEOUT_MS / 1000)} 秒` : `无法连接 cc-gui (${e?.message || e})`;
    emit({ behavior: 'deny', message: `${why}，本次操作按拒绝处理。` });
  } finally {
    clearTimeout(timer);
  }
};

main();

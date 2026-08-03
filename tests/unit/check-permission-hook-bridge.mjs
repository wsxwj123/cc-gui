#!/usr/bin/env node
// 批L L1-b:后台代理的权限应答通道(PermissionRequest hook bridge)。
// 端到端真跑 server/hooks/permission-request-hook.mjs —— 起一个假 bridge(6702),
// 用真 stdin 喂 hook 输入,断言 stdout 的裁决形态。三条出路都要覆盖:
//   allow / deny / GUI 不可达(必须 fail-safe 拒绝,绝不 fail-open)。
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(root, 'server/hooks/permission-request-hook.mjs');
const PORT = 6702; // 测试专用端口,绝不碰 6677/6699

const HOOK_INPUT = {
  session_id: 'bg-sid-1',
  transcript_path: '/tmp/x.jsonl',
  cwd: '/tmp/proj',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Write',
  tool_input: { file_path: '/tmp/proj/a.txt', content: 'hi' },
};

// hook 脚本跑一遍:喂 stdin,收 stdout。
function runHook(port, { timeoutMs = 8000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [HOOK, String(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CGUI_HOOK_TIMEOUT_MS: '3000', ...env },
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('hook 未在预期时间内退出')); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ out, err, code }); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.stdin.end(JSON.stringify(HOOK_INPUT));
  });
}

// 假 bridge:记录收到的请求体,按 reply 回应(reply=null → 一直挂起不回)。
function startBridge(reply) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received.push({ url: req.url, body: (() => { try { return JSON.parse(body); } catch { return null; } })() });
      if (reply === null) return; // 挂起(模拟"等用户点击"),永不响应
      res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.json ?? {}));
    });
  });
  return new Promise((resolve, reject) => {
    // unref:6702 上若有别的东西在轮询,它挂起的连接会让 server.close() 迟迟不放手、
    // 测试进程永不退出。listen 失败必须 reject —— 否则端口被占时这个 Promise 永远不
    // resolve,测试表现为"卡住"而不是"失败",最难查。
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => { server.unref(); resolve({ server, received }); });
  });
}

// 关闭假 bridge:必须连带掐断已建立的连接。case ⑦ 故意不响应,连接会一直挂着 ——
// 只 close() 的话端口不会真正释放,下一个用例(或下一次运行)bind 就 EADDRINUSE。
function stopBridge(server) {
  try { server.closeAllConnections?.(); } catch {}
  server.close();
}

const decisionOf = (out) => {
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput?.hookEventName, 'PermissionRequest', 'hookEventName 必须是 PermissionRequest');
  return parsed.hookSpecificOutput.decision;
};

// ── ① allow:用户在界面点了允许 ─────────────────────────────────────────
{
  const { server, received } = await startBridge({ json: { decision: 'allow' } });
  const { out, code } = await runHook(PORT);
  stopBridge(server);
  assert.equal(code, 0, 'hook 必须以 0 退出(非 0 会被 CLI 当执行失败)');
  assert.deepEqual(decisionOf(out), { behavior: 'allow' });
  // 请求体要能被 GUI 的挂起式端点直接消费
  assert.equal(received.length, 1, '必须只 POST 一次');
  assert.equal(received[0].url, '/api/permissions/request');
  assert.deepEqual(received[0].body, {
    toolName: 'Write',
    toolInput: { file_path: '/tmp/proj/a.txt', content: 'hi' },
    sessionId: 'bg-sid-1',
    cwd: '/tmp/proj',
    hookEvent: 'PermissionRequest',
    bgAgent: true,
  }, 'hook 输入必须完整翻译成 bridge 请求体(bgAgent 标记决定卡片可见性)');
}

// ── ② allow + updatedInput:用户改过入参后允许 ───────────────────────────
{
  const upd = { file_path: '/tmp/proj/a.txt', content: 'edited' };
  const { server } = await startBridge({ json: { decision: 'allow', updatedInput: upd } });
  const { out } = await runHook(PORT);
  stopBridge(server);
  assert.deepEqual(decisionOf(out), { behavior: 'allow', updatedInput: upd }, '改过的入参要带回 CLI');
}

// ── ③ deny:用户拒绝,理由要带回去 ───────────────────────────────────────
{
  const { server } = await startBridge({ json: { decision: 'deny', reason: '不要动这个文件' } });
  const { out } = await runHook(PORT);
  stopBridge(server);
  const d = decisionOf(out);
  assert.equal(d.behavior, 'deny');
  assert.equal(d.message, '不要动这个文件');
}

// ── ④ fail-safe:GUI 不可达 → 必须 deny,绝不 fail-open ──────────────────
{
  // 没有任何东西监听 6702
  const { out, code } = await runHook(PORT);
  assert.equal(code, 0);
  const d = decisionOf(out);
  assert.equal(d.behavior, 'deny', 'GUI 不可达必须拒绝(放行=静默绕过整个权限体系)');
  assert.ok(/无法连接/.test(d.message), '拒绝理由要说清是连不上 GUI');
}

// ── ⑤ fail-safe:非 2xx → deny ─────────────────────────────────────────
{
  const { server } = await startBridge({ status: 403, json: { error: 'nope' } });
  const { out } = await runHook(PORT);
  stopBridge(server);
  const d = decisionOf(out);
  assert.equal(d.behavior, 'deny');
  assert.ok(/403/.test(d.message), '拒绝理由要带上状态码');
}

// ── ⑥ fail-safe:响应不是 JSON → deny ──────────────────────────────────
{
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('not json'); });
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  server.unref();
  const { out } = await runHook(PORT);
  stopBridge(server);
  assert.equal(decisionOf(out).behavior, 'deny', '响应不可解析同样按拒绝处理');
}

// ── ⑦ fail-safe:一直挂着不回(用户没应答)→ 自己超时后 deny ─────────────
// 真实配置里 hook timeout=300s、脚本自己 295s 先超时;这里用 CGUI_HOOK_TIMEOUT_MS=3s 压缩。
{
  const { server } = await startBridge(null);
  const t0 = Date.now();
  const { out } = await runHook(PORT, { timeoutMs: 12000 });
  stopBridge(server);
  const d = decisionOf(out);
  assert.equal(d.behavior, 'deny', '超时必须自己吐 deny —— 被 hook timeout 杀掉就没有任何输出');
  assert.ok(/等待授权超过/.test(d.message), '超时理由要说清是等太久');
  assert.ok(Date.now() - t0 >= 2500, '必须真的等满超时窗口,不能立刻放弃');
}

// ── ⑧ 派发侧接线守卫(agents.js 里的 hook 挂载与档位)─────────────────────
{
  const src = readFileSync(join(root, 'server/routes/agents.js'), 'utf8');
  assert.ok(/BG_PERMISSION_MODES = new Set\(\['default', 'acceptEdits', 'plan'\]\)/.test(src), '三档白名单');
  assert.ok(/BG_PERMISSION_MODES\.has\(permissionMode\) \? permissionMode : 'acceptEdits'/.test(src),
    '默认必须仍是 acceptEdits(不改变现有用户行为)');
  assert.ok(/if \(mode !== 'acceptEdits'\) \{/.test(src), 'acceptEdits 不挂 hook(既有默认档一个字不动)');
  assert.ok(/args\.push\('--settings', await writeBgHookSettings\(req\.socket\?\.localPort\)\)/.test(src),
    'hook 配置经 --settings 挂上,端口取服务端真实监听端口');
  assert.ok(/return res\.status\(500\)\.json\(\{ error: `无法写入授权 hook 配置/.test(src),
    '挂不上 hook 必须拒绝派发,不能降级成"永久等待"');
  assert.ok(/timeout: 300/.test(src), 'hook 阻塞窗口(用户应答时间)须显式设定');
  // matcher '*' = 所有工具(CLI 的匹配函数 matcher 缺省或 '*' 直接 true)。少了它容易被
  // 后人误以为只覆盖某几个工具。
  assert.ok(/PermissionRequest: \[\{ matcher: '\*', hooks: \[\{ type: 'command', command, timeout: 300 \}\] \}\]/.test(src),
    "hook 配置形态:PermissionRequest + matcher '*' → command");
  assert.ok(/for \(const sid of await bgSessionIdsFor\(id\)\) dropPendingForSession\(sid\)/.test(src),
    '停后台代理必须连带清它的权限卡(卡片是独立态,不随进程停止消失)');
  assert.ok(/checkSettingsMergeSentinel/.test(src), '--settings 合并语义须有哨兵');
  // 路径动态解析:打包后资源在 Contents/Resources/_up_/server/hooks/,不能硬编码
  assert.ok(/HOOK_SCRIPT = join\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', 'hooks'/.test(src),
    'hook 脚本路径必须由 import.meta.url 推导');
  const perm = readFileSync(join(root, 'server/routes/permissions.js'), 'utf8');
  assert.ok(/req\.body\?\.bgAgent === true \? \{ bgAgent: true \} : \{\}/.test(perm), 'bgAgent 标记要透传给前端');
  const prompt = readFileSync(join(root, 'client/src/components/PermissionPrompt.jsx'), 'utf8');
  // 单窗格分支 / 分屏分支各自都要接住(分屏还必须在 paneIsActive 门控之后,防每格弹一遍)
  const single = prompt.slice(prompt.indexOf('const mine = paneCount === 1'), prompt.indexOf(': all.filter((p) => {'));
  const split = prompt.slice(prompt.indexOf(': all.filter((p) => {'), prompt.indexOf('if (mine.length === 0) return null;'));
  assert.ok(/if \(p\.bgAgent\) return true;/.test(single), '单窗格:后台代理的卡片一律可见');
  assert.ok(split.indexOf('if (!paneIsActive) return false;') < split.indexOf('if (p.bgAgent) return true;'),
    '分屏:后台代理的卡片由活动窗格接住,必须排在 paneIsActive 门控之后');
  assert.ok(/{req\.bgAgent && \(/.test(prompt), '卡片必须标明来自后台代理');
}

console.log('✓ check-permission-hook-bridge: allow/deny/不可达/非2xx/坏响应/超时 六态 + 派发接线全过');

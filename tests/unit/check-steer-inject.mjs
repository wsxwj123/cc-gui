#!/usr/bin/env node
// Bug4 无打断引导注入(设计甲)+ Bug1 ⚡ 失效。
//
// 服务端:POST /api/chat/steer 按 sessionId 找【忙】slot 做 input.push —— CLI 在下一个
// 工具结果边界把它折叠进【同一回合】(实测 1 init / 1 result)。判据是复用块(chat.js:1107)
// 那一行【只把 s.idle 取反】:复用块要 idle(开新回合),注入要 !idle(并进在跑的回合)。
// 对 idle slot 绝不能 push —— 那会开一个前端不知道的新回合(SSE 已 done 关闭,输出无人接)。
//
// 客户端:发送门在"回合进行中"改走注入,失败(409/网络)一律回落既有入队路径;队列排空/
// 内部重发不注入;⚡ 从 interrupt+重发改成注入(Bug1 三种失效形态一并消失)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const { findBusySlot } = await import('../../server/routes/chat.js');

// ── 1) 忙 slot 判据(真 import)──────────────────────────────────────
const mkSlot = (o = {}) => ({
  sessionId: 'sid-1', idle: false, closing: false, pumpEnded: false, exitCode: null,
  input: { pushed: [], push(m) { this.pushed.push(m); } },
  ...o,
});

// (a) 正在跑的回合 → 命中,pid 一并返回
{
  const busy = mkSlot();
  const procs = new Map([['sdk-9', busy]]);
  const hit = findBusySlot(procs, 'sid-1');
  assert.ok(hit, '非 idle 的活 slot 必须命中');
  assert.equal(hit.pid, 'sdk-9', '返回 pid 供客户端记账');
  assert.equal(hit.slot, busy);
}

// (b) idle slot 一律拒绝 —— 承重点:对它 push = 开一个前端不知道的新回合
{
  const procs = new Map([['sdk-1', mkSlot({ idle: true })]]);
  assert.equal(findBusySlot(procs, 'sid-1'), null, 'idle slot 绝不可注入(回合已收尾)');
}

// (c) 其余存活条件与复用块逐字一致:closing / pumpEnded / exitCode / 会话不符 全拒
{
  assert.equal(findBusySlot(new Map([['p', mkSlot({ closing: true })]]), 'sid-1'), null, 'closing 中的 slot 不接受注入');
  assert.equal(findBusySlot(new Map([['p', mkSlot({ pumpEnded: true })]]), 'sid-1'), null, '泵已结束的 slot 不接受注入');
  assert.equal(findBusySlot(new Map([['p', mkSlot({ exitCode: 0 })]]), 'sid-1'), null, '已退出的 slot 不接受注入');
  assert.equal(findBusySlot(new Map([['p', mkSlot()]]), 'sid-OTHER'), null, '别的会话的 slot 不得被注入(串扰)');
  assert.equal(findBusySlot(new Map([['p', mkSlot({ input: null })]]), 'sid-1'), null, '没有 input 通道 → 无处可推');
  assert.equal(findBusySlot(new Map([['p', mkSlot()]]), ''), null, '无 sessionId → 不猜');
}

// (d) 复活守卫自洽:主 agent 在 4s 去抖 finalize 之后续跑 → chat.js 把 idle 翻回 false 并
//     置 revived。那正是"确实有回合在跑",此时必须可注入(判据用 idle 而非不回退的时刻字段)。
{
  const revived = mkSlot({ idle: true, finishedAt: Date.now() - 1000 });
  assert.equal(findBusySlot(new Map([['p', revived]]), 'sid-1'), null, '转 idle 期间不可注入');
  revived.idle = false; revived.revived = true; // ← chat.js:1561 复活守卫做的事
  assert.ok(findBusySlot(new Map([['p', revived]]), 'sid-1'), '复活(续跑)后必须重新可注入');
}

// (e) 多 slot:只挑本会话那个忙的
{
  const busy = mkSlot({ sessionId: 'sid-B' });
  const procs = new Map([
    ['p1', mkSlot({ sessionId: 'sid-A' })],
    ['p2', mkSlot({ sessionId: 'sid-B', idle: true })],
    ['p3', busy],
  ]);
  assert.equal(findBusySlot(procs, 'sid-B').slot, busy);
}

// ── 2) 路由接线:push 形状与复用块 :1149 逐字一致(外加 uuid)+ 409 语义 ────
const chat = read('server', 'routes', 'chat.js');
assert.ok(/router\.post\('\/chat\/steer'/.test(chat), '独立路由,不动 POST \/chat');
assert.ok(/const hit = findBusySlot\(activeProcesses, String\(sessionId\)\);\s*\n\s*if \(!hit\) return res\.status\(409\)\.json\(\{ error: 'no-active-turn' \}\);/.test(chat),
  '找不到忙 slot → 409 no-active-turn(客户端据此回落入队)');
assert.ok(/const msg = \{ type: 'user', message: \{ role: 'user', content: String\(content\) \} \};/.test(chat),
  'push 形状与复用块 :1149 逐字一致');
assert.ok(/if \(uuid\) msg\.uuid = String\(uuid\);/.test(chat),
  '带 uuid 才有 command_lifecycle 可用(角标数据源)');
assert.ok(/hit\.slot\.input\.push\(msg\);/.test(chat), '注入 = 对忙 slot 的 input.push');
// 红线未被碰:复用块仍只认 idle,tearingDown 段仍在
assert.ok(/if \(!s\.idle \|\| s\.closing \|\| s\.pumpEnded \|\| s\.exitCode !== null \|\| s\.sessionId !== sessionId\) continue;/.test(chat),
  'POST /chat 复用块的 idle 门一个字没动');
assert.ok(/lingering\.abort\?\.\abort\(\)/.test(chat), 'tearingDown 等待+强杀段原样保留');

// ── 3) 客户端:发送门分流 ─────────────────────────────────────────
const app = read('client', 'src', 'App.jsx');
assert.ok(/if \(!reattachPid && !opts\.forceSend && \(streamingRef\.current \|\| backgroundPidRef\.current\)\) \{/.test(app),
  '发送门:forceSend(回滚/重做的重发)直接绕门 = 有意打断替换');
assert.ok(/if \(!hiddenUserMessage && !_internalResend\s*\n\s*&& await steerCurrentTurnRef\.current\?\.\(prompt, \{ meta \}\)\) return;/.test(app),
  '回合进行中的用户手打消息先试注入');
assert.ok(/const _internalResend = !!\(opts\.fromQueue \|\| opts\.freshRetry \|\| opts\.signatureRetry \|\| opts\.autoRetry\);/.test(app),
  '队列排空与内部重发不注入(否则「入队」按钮失效 / 重发进了要被替换的回合)');
// 承重点:注入失败必须回落入队 —— 删掉这一行就是"消息凭空消失"
assert.ok(/&& await steerCurrentTurnRef[\s\S]{0,120}useStore\.getState\(\)\.enqueueMessage\(sessionQueueKey, \{ text: prompt/.test(app),
  '注入失败(409/网络)紧接着回落 enqueueMessage,消息绝不丢');
assert.ok(/if \(!r\.ok\) return false;/.test(app) && /\} catch \{ return false; \}/.test(app),
  'steerCurrentTurn:非 2xx 与异常都返回 false(交给调用方入队)');
assert.ok(/signal: AbortSignal\.timeout\(4000\)/.test(app), '注入请求有超时兜底,不裸等');
assert.ok(/if \(!sid\) return false; \/\/ draft/.test(app), 'draft(无真 sid)不注入 → 回落入队');

// 本地气泡必带 ownerKey(本仓铁律:凡新增 chatMessages 条目按归属门控渲染)
assert.ok(/uuid: 'chat-user-' \+ Date\.now\(\), type: 'user', ownerKey: sid,/.test(app),
  '注入的用户气泡必须带 ownerKey,否则注入后切走会串进别的会话');

// ── 4) command_lifecycle 角标(未在 sdk.d.ts 声明 → 宽松解析)+ 不永卡 ──
assert.ok(/if \(event\.type === 'command_lifecycle' && event\.command_uuid\) \{/.test(app),
  '宽松解析 command_lifecycle(SDK 类型里没有,只做存在性判断)');
assert.ok(/const merged = event\.state !== 'queued';/.test(app),
  "started/completed → 已并入;只有 queued 保持排队态");
assert.ok(/steerState: 'queued'/.test(app) && /steerState: null/.test(app),
  '角标兜底:10s 没等到事件就摘掉(第三方 provider 可能不发)');
assert.ok(/\}, 10_000\);/.test(app), '兜底定时器 10s');
assert.ok(/msg\.steerState === 'merged' \? '已并入当前回合' : '已排队 · 等待并入当前回合'/.test(app),
  '角标两态渲染');

// ── 5) ⚡ 改道:注入,不再 interrupt+重发(Bug1)──────────────────
assert.ok(!/acceleratingRef\.current = true/.test(app),
  '⚡ 不再 abort 本端流,故不再需要压制 finally 的排空');
assert.ok(!/const handleAccelerate = useCallback\(\(\) => \{[\s\S]{0,900}?POST[\s\S]{0,80}stop/.test(app),
  '⚡ 里的 interrupt+重发链已整段删除(不留死代码)');
assert.ok(/const handleAccelerate = useCallback\(async \(\) => \{[\s\S]{0,900}?steerCurrentTurnRef\.current\?\.\(head\.text/.test(app),
  '⚡ = 把队首消息注入当前回合');
assert.ok(/const idx = q\.findIndex\(\(m\) => m && !m\.hidden && m\.text\);/.test(app),
  '按下标取第一条可见排队消息(队首是隐藏项时不能用 shiftMessage,会删错条)');
assert.ok(/setProviderSwitchNotice\(\{ text: '当前没有可并入的回合/.test(app),
  '注入失败给客观提示,消息留在队列里(不静默吞)');
const chatInput = read('client', 'src', 'components', 'ChatInput.jsx');
assert.ok(/disabled=\{!canSteer\}/.test(chatInput), 'connecting 窗口(无活 slot)⚡ 置灰');
assert.ok(/canSteer = false/.test(chatInput), 'canSteer 默认 false:没传就按不可注入处理');
assert.ok(/⚡ 并入/.test(chatInput), '按钮文案与新语义一致(不再是"中断当前回复")');
assert.ok(/canSteer=\{!!\(liveChatPid \|\| backgroundPid\)\}/.test(app),
  '可注入 = 前台流已拿到 pid 或回合已转后台');

// ── 6) Bug8 回滚重复:forceSend + 等停止落地 + 与 handleStop 对称记账 ────
assert.ok(/const resendReplacing = useCallback\(\(text, opts = \{\}\) => \{/.test(app), '重发通道抽成一处');
assert.ok(/if \(Date\.now\(\) < deadline && \(streamingRef\.current \|\| backgroundPidRef\.current\)\) \{/.test(app),
  '发前轮询【两个】ref(v0.2.191 转后台漏判律),不是只看 streamingRef');
assert.ok(/const deadline = Date\.now\(\) \+ 4000;/.test(app), '轮询上限 4s,超时也发(不裸 await 控制调用)');
assert.ok(/handleSendRef\.current\?\.\(text, \{ \.\.\.opts, forceSend: true \}\);/.test(app),
  '重发带 forceSend 绕过入队门(旧行为:撞门变排队 = 队列里多一条一模一样的)');
assert.equal((app.match(/stoppedPidsRef\.current\.add\(String\(_r[bt]Pid\)\)/g) || []).length, 2,
  '回滚与工具重做两个入口都要记被杀 pid(与 handleStop:6660 对称)');
assert.equal((app.match(/const _r[bt]Pid = activeProcRef\.current \|\| backgroundPidRef\.current;/g) || []).length, 2,
  'pid 取法与 handleStop 逐字一致:前台流与转后台两种形态都要记');
// 两个重发入口都要立即清后台标记(state 下一帧才同步,重发 50ms 后落地 → ref 也要同步清)。
// 锚在 updateStreaming(false) 之前,与切会话 poll 里那处(其后是 lastSeenPidRef)区分开。
assert.equal((app.match(/backgroundPidRef\.current = null;[^\n]*\n\s*updateStreaming\(false\);/g) || []).length, 2,
  '回滚与工具重做两个入口都清 backgroundPid(state + ref)');
assert.ok(/resendReplacing\(\s*\n?\s*`<cgui-tool-retry/.test(app), 'handleRetryTool 同批改(否则同一个 bug 换个入口复现)');
assert.ok(/resendReplacing\(resendText\.prompt \|\| originalText, resendText\.options \|\| \{\}\);/.test(app),
  '编辑重发(handleRollback 的 resendText 分支)同一通道');

// ── 7) 附带发现2:旧流 finally 的三行加归属守卫 ───────────────────
assert.ok(/if \(isCurrentTurn\(\)\) \{\s*\n\s*updateStreaming\(false\);\s*\n\s*activeProcRef\.current = null;\s*\n\s*abortRef\.current = null;/.test(app),
  'connecting 窗口下迟到的旧 finally 不得把【新回合】的停止句柄清成 null(否则新回合停不掉)');

// ── 8) 队列排空三条路径的 fromQueue 标记 ─────────────────────────
assert.equal((app.match(/fromQueue: true \}\)/g) || []).length, 2,
  'finally 排空 + poll 排空两条 drain 都标 fromQueue(⚡ 已不走 handleSend)');

console.log('PASS check-steer-inject');

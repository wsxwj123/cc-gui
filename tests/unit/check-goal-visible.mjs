#!/usr/bin/env node
// 批K K3:/goal 在 GUI 里完全不可见("修了 loop 怎么没修 goal")。
// CLI 侧一切正常 —— 会话级 Stop 钩子照常拦停、不达成强制续跑;是外壳把全部信号吞了:
//   · goal_status attachment(唯一带条件/理由/轮数的记录)全仓零处理;
//   · "A session-scoped Stop hook is now active…" 是 isMeta,历史侧直接 skip;
//   · `Stop hook feedback:` 是纯文本 user 事件,实时侧的 user 分支只处理 tool_result 块。
// 实测(CLI 2.1.220 真机探针,stream-json 全量抓取):goal_status 只写 transcript,
// 一条都不进 stream;`Stop hook feedback:` 两边都有,但转写里是 isMeta(历史侧按既有
// 语义跳过),且两边 content 形态不同 —— 流里是 [{type:'text'}] 数组,转写里是纯字符串。
// 所以两条链路各修各的:历史侧放行 goal_status,实时侧按前缀渲染 feedback。
// 本文件用【真实形态】fixture 跑真 session-reader,不是构造的示意结构。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');

// ── 1. 历史侧:真 session-reader 跑真实形态 fixture ────────────────────
// HOME 必须在 import 之前改 —— session-reader 在模块作用域 join(homedir(), ...)。
const home = mkdtempSync(join(tmpdir(), 'cgui-goal-home-'));
process.env.HOME = home;
const HASH = 'test-project-hash';
const SID = 'goal-fixture-session';
mkdirSync(join(home, '.claude', 'projects', HASH), { recursive: true });

// 形态逐字取自 ~/.claude/projects 真机转写(claude 2.1.220):
//   /goal <cond>  → attachment{met:false, sentinel:true, condition}
//   钩子判未达成 → attachment{met:false, condition, reason}(无 sentinel)
//   达成         → attachment{met:true, condition, reason, iterations, durationMs, tokens}
//   /goal clear  → attachment{met:true, sentinel:true, condition}
const COND = '你已经用中文写出过"任务完成"四个字';
const GOAL_SET_STDOUT = `Goal set: ${COND}`;
const rec = (o) => JSON.stringify({ sessionId: SID, timestamp: '2026-08-03T09:21:06.292Z', ...o });
writeFileSync(join(home, '.claude', 'projects', HASH, `${SID}.jsonl`), [
  rec({ type: 'user', uuid: 'u1', message: { role: 'user', content: '帮我写点东西' } }),
  rec({ type: 'attachment', uuid: 'a1', attachment: { type: 'goal_status', met: false, sentinel: true, condition: COND } }),
  // /goal 的命令回显 + stdout:仍按既有语义隐藏(条件文本已由上面的 sentinel 记录带出,
  // 再放行一条就是同一件事画两行)。等价性在下方由断言钉死,不是口头声明。
  rec({ type: 'user', uuid: 'u2', message: { role: 'user', content: `<local-command-stdout>${GOAL_SET_STDOUT}</local-command-stdout>` } }),
  // 钩子挂上后 CLI 喂给模型的 isMeta 提示:仍旧不渲染(它是给模型看的指令,不是对话)。
  rec({ type: 'user', uuid: 'u3', isMeta: true, message: { role: 'user', content: `A session-scoped Stop hook is now active with condition: "${COND}".` } }),
  rec({ type: 'assistant', uuid: 'as1', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: '好的,开始。' }] } }),
  rec({ type: 'attachment', uuid: 'a2', attachment: { type: 'goal_status', met: false, condition: COND, reason: '还没写出这四个字' } }),
  rec({ type: 'assistant', uuid: 'as2', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: '任务完成。' }] } }),
  rec({ type: 'attachment', uuid: 'a3', attachment: { type: 'goal_status', met: true, condition: COND, reason: '最后一条消息含"任务完成"', iterations: 2, durationMs: 12053, tokens: 525 } }),
  // 与 goal 无关的 local-command-stdout:必须仍被过滤(别把整个回显闸门放开)
  rec({ type: 'user', uuid: 'u4', message: { role: 'user', content: '<local-command-stdout>Context low</local-command-stdout>' } }),
  // 第四形态 `/goal clear`:met:true+sentinel。少放这一条会让手动清除后徽章永久挂着。
  rec({ type: 'attachment', uuid: 'a4', attachment: { type: 'goal_status', met: true, sentinel: true, condition: COND } }),
].join('\n') + '\n');

const { getSessionMessages } = await import('../../server/services/session-reader.js');
const { messages } = await getSessionMessages(SID, HASH);
const goals = messages.filter((m) => m.type === 'goal');

assert.equal(goals.length, 4, 'goal_status 的四种形态都要进消息流(设置/未达成/达成/手动清除)');
assert.deepEqual(
  goals.map((g) => [g.met, g.sentinel]),
  [[false, true], [false, false], [true, false], [true, true]],
  'met/sentinel 必须如实透出 —— 前端靠这两位区分"刚设置/未达成/达成/手动清除"');
assert.equal(goals[0].condition, COND, '条件文本必须带出(徽章要显示它)');
assert.equal(goals[1].reason, '还没写出这四个字', '未达成的判定理由必须带出(这是强制续跑的原因)');
assert.equal(goals[2].iterations, 2, '达成记录的轮数必须带出');
// 缺省容错:CLI 只在"达成"记录里写 reason/iterations,另外三种没有。缺字段必须归一成
// ''/null 而不是 undefined 漏进渲染层(GoalNotice 的 detail/轮数括号靠这两个默认值判空)。
assert.equal(goals[0].reason, '', '缺 reason 归一为空串');
assert.equal(goals[0].iterations, null, '缺 iterations 归一为 null');

// 回显过滤语义没被破坏:任何 <local-command-stdout> 都不冒充用户气泡
const userTexts = messages.filter((m) => m.type === 'user').map((m) => m.text);
assert.ok(!userTexts.some((t) => /local-command-stdout/.test(t)), 'local-command-stdout 一律不渲染成用户气泡');
assert.ok(!userTexts.some((t) => /Stop hook is now active/.test(t)), 'isMeta 的钩子提示仍不渲染');
assert.deepEqual(userTexts, ['帮我写点东西'], '只有真实用户消息进流');

// 与 spec 的唯一出入:spec 要求把 `Goal set:` stdout 也放行成可见系统行。真机转写显示
// 它的载荷与紧邻的 sentinel 记录逐字相同,且消息流里只有 GoalNotice 一种渲染形态 ——
// 放行等于同一句话连画两行(用户气泡里的 `/goal X` 已是第三遍)。此断言把"等价"钉死:
// 哪天 CLI 改了 stdout 让它带上 sentinel 没有的信息,这里会红,届时再放行。
assert.equal(GOAL_SET_STDOUT.replace(/^Goal set:\s*/, ''), goals[0].condition,
  '`Goal set:` stdout 的载荷 = sentinel 记录的 condition,故不另开回显口子');
rmSync(home, { recursive: true, force: true });

// ── 2. 实时侧 + 渲染侧源码守卫 ─────────────────────────────────────────
assert.ok(/function GoalNotice\(\{ goal \}\)/.test(app), 'GoalNotice(消息流里的目标提示行)必须存在');
assert.equal(app.split('<GoalNotice goal={msg} />').length - 1, 2,
  '历史列表(MessageList)与流式列表两处都要渲染 goal,漏一处就是"翻回去看不见"');
assert.ok(/const activeGoal = useMemo\(/.test(app), '常驻条必须由 activeGoal 派生');
// r30:顶栏小徽章退役,常驻条(GoalBar)移到 ChatInput 的 composer 正上方 —— "目标进行中"
// 文案与 title 里的"最近判定"随之迁入 GoalBar,App.jsx 里不再直接渲染该行。
const chat = readFileSync(join(root, 'client/src/components/ChatInput.jsx'), 'utf8');
const goalBarSrc = readFileSync(join(root, 'client/src/components/GoalBar.jsx'), 'utf8');
assert.ok(/目标进行中：/.test(goalBarSrc), '常驻条要有"目标进行中"文案(从顶栏徽章迁入)');
assert.ok(/最近判定：/.test(goalBarSrc), '常驻条 title 要含"最近判定理由"(迁自顶栏徽章 title)');
assert.ok(/<GoalBar \/\>/.test(chat) || /<GoalBar[^>]+\/\>/.test(chat), 'ChatInput 要渲染常驻条 GoalBar');
assert.ok(/goal=\{effectiveGoal\}/.test(app), 'App 把 effectiveGoal(activeGoal+乐观态)作为 goal 传给 ChatInput');
assert.ok(!/<span className="truncate">目标进行中：\{activeGoal\.condition/.test(app),
  '顶栏原"目标进行中"小徽章已退役,不得残留');
assert.ok(/block\.type === 'text' && \/\^Stop hook feedback:\/\.test\(block\.text \|\| ''\)/.test(app),
  '实时侧必须【按前缀】识别 Stop hook feedback,不得放行任意纯文本 user 事件(会引入噪音)');

// ── 3. 复刻徽章状态机:达成/清除后不许残留 ────────────────────────────
// 下面是 activeGoal 的复刻实现。复刻件会漂移,所以先把 App.jsx 里的判据逐字锁住:
// 谁改了那一行,这里就红,必须同步改复刻件和用例,状态机不会悄悄失效。
assert.ok(
  app.includes("if (messages[i]?.type === 'goal') return messages[i].met ? null : messages[i];"),
  'activeGoal 的判据("最后一条 goal 的 met")必须与下方复刻件逐字一致');
{
  // 与 App.jsx 的 activeGoal 同一判据:取最后一条 goal,met 即无活动目标。
  const activeGoal = (msgs) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.type === 'goal') return msgs[i].met ? null : msgs[i];
    }
    return null;
  };
  const set = { type: 'goal', met: false, sentinel: true, condition: COND };
  const notYet = { type: 'goal', met: false, sentinel: false, condition: COND, reason: 'r' };
  const done = { type: 'goal', met: true, sentinel: false, condition: COND, reason: 'r', iterations: 2 };
  const cleared = { type: 'goal', met: true, sentinel: true, condition: COND };
  const turn = { type: 'turn' };
  assert.equal(activeGoal([turn]), null, '没设过目标 → 无徽章');
  assert.equal(activeGoal([set, turn])?.condition, COND, '设了目标 → 挂徽章');
  assert.equal(activeGoal([set, turn, notYet, turn])?.reason, 'r', '未达成(续跑中)→ 徽章仍在,带最近判定');
  assert.equal(activeGoal([set, turn, notYet, turn, done]), null, '达成 → 徽章立即消失,不残留');
  assert.equal(activeGoal([set, turn, cleared]), null, '/goal clear 手动清除(met:true+sentinel)→ 徽章消失');
  assert.equal(activeGoal([set, done, set])?.condition, COND, '同一会话再设新目标 → 徽章回来');
}

console.log('✓ check-goal-visible: goal_status 进流 + 回显过滤未破坏 + 徽章状态机全过');

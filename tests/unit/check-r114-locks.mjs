#!/usr/bin/env node
// r114 源码锁:INTERFACE-r114.md §E1(服务端)+ §E2(前端)逐条一个断言。
//
// 本文件是【黑盒验收测试】的锁那一半:只依据 INTERFACE §E 的"必须存在 / 必须不存在"
// 写正则,运行时才去读目标文件;写的时候没看实现。
//
// 为什么要锁:本轮真正危险的东西都不在功能测试的射程内 ——
//   ① perTaskStopAffordance 漏在条件分支里 = 某些路径静默回到"interrupt 杀光后台助手";
//   ② 核心停止时序被顺手改一行 = 停止语义整个塌掉,单测照样绿;
//   ③ 工作流文本(标签/结果/报错)交给 markdown 渲染器 = 助手输出能注入界面。
//
// 口径:源码锁一律在【去注释后】的文本上做,否则实现方写一行注释就能骗过锁。
// 逐字节锁用 `git show HEAD:<file>` 取基线,按 INTERFACE §C5 给的行区间截取参照文本,
// 再断言当前文件里仍原样包含它(行号会随新增代码平移,内容不许动)。
//
// Run: node tests/unit/check-r114-locks.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let PASS = 0;
let FAILS = 0;
const failed = [];
const tally = { RED: { pass: 0, fail: 0 }, GREEN: { pass: 0, fail: 0 } };
const TAG = { RED: '[修前应红]', GREEN: '[修前应绿]' };
function check(tag, name, fn) {
  const label = `${TAG[tag]} ${name}`;
  try {
    fn();
    PASS++; tally[tag].pass++;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    FAILS++; tally[tag].fail++;
    failed.push(label);
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${label}\n      ${msg}`);
  }
}
const red = (name, fn) => check('RED', name, fn);
const green = (name, fn) => check('GREEN', name, fn);

const read = (rel) => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; } };
const headOf = (rel) => {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return ''; }
};
// 只剥行首块注释/行注释与"前面不含引号或斜杠"的行尾注释:通吃式的块注释正则会被
// 源码里的正则字面量骗成注释起点,一口吃掉半个文件,锁就成了永远绿的空壳。
const stripComments = (s) => s
  .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*\n?/gm, '')
  .replace(/^[ \t]*\/\/[^\n]*\n?/gm, '')
  .replace(/^([^'"`/\n]*?)[ \t]+\/\/[^\n]*$/gm, '$1');
const count = (s, needle) => s.split(needle).length - 1;
const lines = (s, from, to) => s.split('\n').slice(from - 1, to).join('\n');

const CHAT = read('server/routes/chat.js');
const CHAT_C = stripComments(CHAT);
const AGENTS = read('server/routes/agents.js');
const AGENTS_C = stripComments(AGENTS);
const READER = stripComments(read('server/services/session-reader.js'));
const WFPROG = stripComments(read('server/utils/workflow-progress.js'));
const PKG = read('package.json');

// ══════════════════════════════════════════════════════════════════════════
// E1 服务端
// ══════════════════════════════════════════════════════════════════════════
console.log('\nE1 服务端源码锁(§E1)');

red('E1-1a package.json 的 SDK 版本 ≥ 0.3.261', () => {
  const m = /"@anthropic-ai\/claude-agent-sdk":\s*"\^?(\d+)\.(\d+)\.(\d+)"/.exec(PKG);
  assert.ok(m, 'package.json 里必须仍声明 @anthropic-ai/claude-agent-sdk');
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  assert.ok(maj > 0 || min > 3 || (min === 3 && pat >= 261),
    `SDK 版本 ${m[1]}.${m[2]}.${m[3]} < 0.3.261 —— perTaskStopAffordance 在旧版里不生效`);
});

red('E1-1b package.json 不得再留 ^0.3.191', () => {
  assert.equal(PKG.includes('^0.3.191'), false, '旧版本号还在 = 依赖没真升,停止语义仍是 fail-closed');
});

red('E1-2 perTaskStopAffordance: true 必须在 query() 的 options 字面量内', () => {
  const i = CHAT_C.indexOf('const options = {');
  assert.ok(i > 0, 'chat.js 必须仍有 SDK options 字面量');
  const j = CHAT_C.indexOf('q = query({', i);
  assert.ok(j > i, 'options 到 query({ 的构造区间定位失败,断言会失真');
  const seg = CHAT_C.slice(i, j);
  assert.ok(seg.length < 9000, `options 构造区间 ${seg.length} 字符,过大 = 定位失真`);
  assert.match(seg, /perTaskStopAffordance:\s*true/,
    '放在条件分支里 = 某些路径漏带 = 静默回到"interrupt 连后台助手一起杀"');
});

green('E1-3 chat.js 里 query({ 恰好 1 次(不得另开第二个 query 调用点)', () => {
  assert.equal(count(CHAT_C, 'query({'), 1,
    '第二个 query( 调用点意味着有一条链路不带 perTaskStopAffordance');
});

green('E1-4 perTaskStopAffordance 不得进 chatCompatKey', () => {
  const i = CHAT_C.indexOf('chatCompatKey');
  assert.ok(i > 0, 'chat.js 必须仍有 chatCompatKey');
  assert.equal(/perTaskStopAffordance/.test(CHAT_C.slice(i, i + 2000)), false,
    '恒定常量进兼容键 = 常驻 MCP 进程无谓重开');
});

green('E1-5a chat.js 消息泵仍是 const line = JSON.stringify(m); 逐字', () => {
  assert.ok(CHAT_C.includes('const line = JSON.stringify(m);'),
    '投影必须用新局部变量投递,不得改写原行的生成方式');
});

green('E1-5b 不得对 line 重新赋值(只许 const/let 声明,不许裸赋值)', () => {
  // 先摘掉所有声明式(chat.js 里另有一个读 stdout 缓冲的 const line),剩下的裸 line = 才是改写。
  const stripped = CHAT_C.replace(/\b(?:const|let|var)\s+line\s*=/g, '');
  assert.equal(/(?<![.\w])line\s*=\s*(?!=)/.test(stripped), false,
    '给 line 重新赋值 = 所有下游(落盘/回放/detach)都被投影后的内容污染');
});

red('E1-6a chat.js 必须 import projectWorkflowProgress', () => {
  assert.match(CHAT_C, /import[^;]*projectWorkflowProgress[^;]*from\s*['"][^'"]*workflow-progress\.js['"]/,
    '投影必须复用服务端唯一实现,不得在 chat.js 里另写一份白名单');
});

red('E1-6b projectWorkflowProgress 必须在 deliverLine( 之前被使用', () => {
  const u = CHAT_C.indexOf('projectWorkflowProgress(');
  const d = CHAT_C.indexOf('deliverLine(');
  assert.ok(u > 0, 'chat.js 里没有调用 projectWorkflowProgress(');
  assert.ok(d > 0, 'chat.js 里没有 deliverLine(');
  assert.ok(u < d, '投影必须发生在投递之前,否则前端拿到的还是带 promptPreview 的原表');
});

red('E1-7a workflow-progress-bg 广播必须与既有的"无监听兜底"同处一段', () => {
  const w = CHAT_C.indexOf('workflow-progress-bg');
  assert.ok(w > 0, 'chat.js 必须有 workflow-progress-bg 广播');
  const sib = CHAT_C.indexOf('task-notification-bg');
  assert.ok(sib > 0, 'chat.js 必须仍有 task-notification-bg(同款无监听兜底)');
  assert.ok(Math.abs(w - sib) < 4000,
    'workflow-progress-bg 离既有兜底太远 = 多半没落在"无 SSE 监听"分支里(SSE 在线时也广播 = 双发)');
});

red('E1-7b 工作流进度行不得进 earlyLines', () => {
  const w = CHAT_C.indexOf('workflow-progress-bg');
  assert.ok(w > 0, 'chat.js 必须有 workflow-progress-bg 广播');
  assert.equal(/earlyLines\.push/.test(CHAT_C.slice(Math.max(0, w - 600), w + 600)), false,
    '进度行进 earlyLines = 重连时把几十份历史进度表整包重放');
});

green('E1-8 chat.js 核心停止区间(HEAD:2228-2389)逐字节未改', () => {
  const head = headOf('server/routes/chat.js');
  assert.ok(head.length > 0, 'git show HEAD:server/routes/chat.js 取不到基线');
  const ref = lines(head, 2228, 2389);
  assert.ok(ref.length > 500, `基线区间只截到 ${ref.length} 字符,行号对不上`);
  assert.ok(CHAT.includes(ref),
    '/stop 与 /stop-task 全路径必须与 HEAD 逐字节相同(interrupt / 2s 窗 / abort / settled 判据一个字都不许动)');
});

red('E1-9a server/utils/workflow-progress.js 导出 A1.1–A1.6 全部符号', () => {
  assert.ok(WFPROG.length > 0, '新文件 server/utils/workflow-progress.js 还不存在');
  for (const sym of ['WF_RUN_ID', 'WF_MAX_SNAPSHOT_BYTES', 'projectWorkflowProgress', 'workflowSnapshotPath',
    'projectWorkflowSnapshot', 'parseWorkflowTranscriptDir', 'parseWorkflowLaunchText']) {
    assert.ok(new RegExp(`export\\s+(const|function)\\s+${sym}\\b`).test(WFPROG), `缺导出 ${sym}`);
  }
});

red('E1-9b workflow-progress.js 里不得出现任何写文件操作', () => {
  assert.ok(WFPROG.length > 0, '新文件 server/utils/workflow-progress.js 还不存在');
  assert.equal(/writeFile|appendFile|unlink|\brm\b|mkdir|rename|chmod/.test(WFPROG), false,
    '这是纯投影模块,出现写操作 = 读快照的路径上多了副作用');
});

red('E1-10a agents.js 必须注册 router.get(\'/workflow-run\'', () => {
  assert.match(AGENTS_C, /router\.get\(\s*['"]\/workflow-run['"]/);
});

red('E1-10b 三参正则校验必须在任何 fs 调用之前', () => {
  const i = AGENTS_C.search(/router\.get\(\s*['"]\/workflow-run['"]/);
  assert.ok(i > 0, '/workflow-run 端点还不存在');
  const seg = AGENTS_C.slice(i, i + 4000);
  const g = seg.search(/WF_RUN_ID|WF_SAFE_ID/);
  const fs = seg.search(/lstat|readFile|statSync|existsSync|access/);
  assert.ok(g >= 0, '端点里必须能看到 WF_RUN_ID / WF_SAFE_ID 校验');
  assert.ok(fs < 0 || g < fs, '脏参数必须在碰 fs 之前就被 400 挡掉');
});

red('E1-10c lstat 符号链接门必须在 readFile 之前', () => {
  const i = AGENTS_C.search(/router\.get\(\s*['"]\/workflow-run['"]/);
  assert.ok(i > 0, '/workflow-run 端点还不存在');
  const seg = AGENTS_C.slice(i, i + 4000);
  const l = seg.search(/lstat/);
  const r = seg.search(/readFile/);
  assert.ok(l >= 0, '端点里必须有 lstat(逐段查符号链接)');
  assert.ok(r < 0 || l < r, 'readFile 会跟随软链读到 ~/.claude.json —— lstat 门必须在前');
});

red('E1-10d /workflow-run 端点内不得出现写操作', () => {
  const i = AGENTS_C.search(/router\.get\(\s*['"]\/workflow-run['"]/);
  assert.ok(i > 0, '/workflow-run 端点还不存在');
  const seg = AGENTS_C.slice(i, i + 4000);
  assert.equal(/writeFile|appendFile|unlink|rmSync|mkdir|rename|chmod/.test(seg), false, '只读端点里出现了写操作');
});

red('E1-11 agents.js 必须 export const WF_SAFE_ID(供新模块复用同一把闸)', () => {
  assert.match(AGENTS_C, /export\s+const\s+WF_SAFE_ID/);
});

red('E1-12a session-reader.js 必须按 taskType === \'local_workflow\' 附 workflowRun', () => {
  assert.ok(READER.length > 0, 'server/services/session-reader.js 读不到');
  assert.match(READER, /taskType\s*===\s*['"]local_workflow['"]/);
  assert.match(READER, /workflowRun/);
});

red('E1-12b session-reader.js 不得把 transcriptDir / scriptPath 放进返回对象', () => {
  assert.ok(READER.length > 0, 'server/services/session-reader.js 读不到');
  assert.equal(/transcriptDir\s*:/.test(READER), false, 'transcriptDir 作为键出现 = 绝对路径透给前端');
  assert.equal(/scriptPath/.test(READER), false, 'scriptPath 一律不许出现在历史返回对象里');
});

green('E1-13 scripts/postinstall.cjs 与 HEAD 逐字节相同', () => {
  const head = headOf('scripts/postinstall.cjs');
  assert.ok(head.length > 0, 'git show HEAD:scripts/postinstall.cjs 取不到基线');
  assert.equal(read('scripts/postinstall.cjs'), head, '平台包处理逻辑本轮一个字都不动');
});

// ══════════════════════════════════════════════════════════════════════════
// E2 前端
// ══════════════════════════════════════════════════════════════════════════
console.log('\nE2 前端源码锁(§E2)');

const STREAM = stripComments(read('client/src/utils/streamStatus.js'));
const TURN = stripComments(read('client/src/components/TurnBubble.jsx'));
const APP = stripComments(read('client/src/App.jsx'));
const WS = stripComments(read('client/src/hooks/useWebSocket.js'));
const PRUNE = read('client/src/utils/levelPrune.js');
const CARD = stripComments(read('client/src/components/tools/WorkflowCard.jsx'));
const SUBV = stripComments(read('client/src/components/SubagentView.jsx'));
const PANEL = stripComments(read('client/src/components/AgentMonitorPanel.jsx'));
const VIEW = stripComments(read('client/src/utils/workflowView.js'));

red('E2-1 streamStatus.js 的 groupCoworkBlocks 必须把 Workflow 分成 kind:\'workflow\' 段', () => {
  assert.ok(STREAM.length > 0, 'streamStatus.js 读不到');
  const i = STREAM.indexOf('groupCoworkBlocks');
  assert.ok(i > 0, 'groupCoworkBlocks 必须还在');
  const seg = STREAM.slice(i);
  assert.match(seg, /tc\.name === 'Workflow'/, 'Workflow 必须单独识别(否则它会被当普通工具塞进 group 折叠区)');
  assert.match(seg, /kind:\s*'workflow'/);
});

red('E2-2a TurnBubble.jsx 两条渲染路径各一处 <WorkflowCard(共 2 处)', () => {
  assert.ok(TURN.length > 0, 'TurnBubble.jsx 读不到');
  assert.equal(count(TURN, '<WorkflowCard'), 2,
    '历史列表与流式列表必须对称:漏一处就是"有数据不显示"(与 denial/goal 同款对称要求)');
});

red('E2-2b Workflow 不得落进 bucket.push / hiddenTools++(那是"折叠到工具堆"的路径)', () => {
  assert.ok(TURN.length > 0, 'TurnBubble.jsx 读不到');
  const idx = [];
  let p = TURN.indexOf('Workflow');
  while (p >= 0) { idx.push(p); p = TURN.indexOf('Workflow', p + 1); }
  assert.ok(idx.length > 0, 'TurnBubble 里必须出现 Workflow 分支');
  for (const i of idx) {
    const seg = TURN.slice(i, i + 260);
    assert.equal(/bucket\.push|hiddenTools\+\+/.test(seg), false,
      'Workflow 卡片被折进工具堆 = 用户在聊天里看不到阶段视图');
  }
});

red('E2-3a App.jsx task_progress 分支必须有 Array.isArray(event.workflow_progress) 守卫', () => {
  const i = APP.indexOf("subtype === 'task_progress'");
  assert.ok(i > 0, 'App.jsx 必须仍有 task_progress 分支');
  assert.match(APP.slice(i, i + 1400), /Array\.isArray\(event\.workflow_progress\)/);
});

red('E2-3b App.jsx task_progress 分支必须有权威终态丢弃守卫 + optimisticStop 例外', () => {
  const i = APP.indexOf("subtype === 'task_progress'");
  assert.ok(i > 0, 'App.jsx 必须仍有 task_progress 分支');
  assert.match(APP.slice(i, i + 1400), /optimisticStop/,
    'B1-9 丢弃 + B1-9b 例外:少了例外,乐观停止后最后几个助手永远显示"未知"');
});

green('E2-3c App.jsx task_progress 分支不得给 workflow_progress 兜底 ?? [] / || []', () => {
  const i = APP.indexOf("subtype === 'task_progress'");
  assert.ok(i > 0, 'App.jsx 必须仍有 task_progress 分支');
  assert.equal(/workflow_progress[^]{0,80}(\?\?|\|\|)\s*\[\]/.test(APP.slice(i, i + 1400)), false,
    '缺表 ≠ 空表:兜底成 [] 会把已有进度清空');
});

red('E2-4a App.jsx 必须监听 cgui:workflow-progress-bg', () => {
  assert.match(APP, /window\.addEventListener\(\s*'cgui:workflow-progress-bg'/);
});

red('E2-4b 监听必须配对移除(否则切会话反复挂载 = 泄漏 + 重复处理)', () => {
  assert.match(APP, /window\.removeEventListener\(\s*'cgui:workflow-progress-bg'/);
});

red('E2-5a useWebSocket.js 必须转发 workflow-progress-bg', () => {
  assert.ok(WS.length > 0, 'useWebSocket.js 读不到');
  assert.match(WS, /case\s*'workflow-progress-bg':/);
});

red('E2-5b useWebSocket.js 必须派发 cgui:workflow-progress-bg 自定义事件', () => {
  assert.match(WS, /new CustomEvent\(\s*'cgui:workflow-progress-bg'/);
});

green('E2-6 levelPrune.js 的 workflow 豁免逐字未改', () => {
  assert.ok(PRUNE.includes('if (a.hydrated || a.workflow) continue;'),
    '这行没了 = 跨回合在后台跑的工作流卡片会被 level 剪成"已结束"');
});

red('E2-7a WorkflowCard.jsx 必须做归属校验(resolveOwnedAgent)', () => {
  assert.ok(CARD.length > 0, '新文件 client/src/components/tools/WorkflowCard.jsx 还不存在');
  assert.match(CARD, /resolveOwnedAgent/, 'fork 出来的分支共享 tool_use_id,不做归属校验就会串会话');
});

red('E2-7b WorkflowCard.jsx 的确认框必须走 confirmDialog(Tauri 里 window.confirm 是死的)', () => {
  assert.ok(CARD.length > 0, 'WorkflowCard.jsx 还不存在');
  assert.match(CARD, /confirmDialog/);
});

red('E2-7c WorkflowCard.jsx 必须 React.memo 包裹', () => {
  assert.ok(CARD.length > 0, 'WorkflowCard.jsx 还不存在');
  assert.match(CARD, /React\.memo|\bmemo\(/, '每 10s 一份进度表,不 memo 会把整条长会话重渲');
});

red('E2-7d WorkflowCard.jsx 不得出现 window.confirm / alert( / activeTabIndex', () => {
  assert.ok(CARD.length > 0, 'WorkflowCard.jsx 还不存在');
  assert.equal(/window\.confirm|(?<![.\w])alert\(/.test(CARD), false, 'Tauri WKWebView 里原生弹窗是哑的(点了没反应)');
  assert.equal(/activeTabIndex/.test(CARD), false, '卡片是 per-pane 多实例,读全局当前 tab = 分屏串扰');
});

red('E2-7e WorkflowCard.jsx 禁止 dangerouslySetInnerHTML(助手输出会进这张卡)', () => {
  assert.ok(CARD.length > 0, 'WorkflowCard.jsx 还不存在');
  assert.equal(/dangerouslySetInnerHTML/.test(CARD), false,
    'label / lastToolSummary / result 全是模型与外部工具产出的文本,交给 innerHTML = 注入');
});

red('E2-8a WorkflowCard.jsx 内层助手区必须有固定说明文案', () => {
  assert.ok(CARD.length > 0, 'WorkflowCard.jsx 还不存在');
  assert.match(CARD, /工作流内的单个助手无法单独停止/, '不写清楚,用户只会以为按钮丢了');
});

red('E2-8b 内层助手行分支里不得调用 stopSingleTask', () => {
  assert.ok(CARD.length > 0, 'WorkflowCard.jsx 还不存在');
  const i = CARD.indexOf('工作流内的单个助手无法单独停止');
  assert.ok(i > 0, '找不到内层助手说明文案,无法定位该区段');
  // 邻近启发:内层助手行那段(固定文案前后 400 字符)里不许出现停止调用。
  // 「停止整个工作流」按钮属于卡片头部,与这段文案隔着助手列表,正常写法碰不到。
  assert.equal(/stopSingleTask/.test(CARD.slice(Math.max(0, i - 400), i + 400)), false,
    '内层 agentId 不在 taskRegistry,拿它调只会静默落空并显示误导性的"任务表中已不存在"');
});

red('E2-9 SubagentView.jsx 停止按钮条件必须带 !agent?.wfInner', () => {
  assert.ok(SUBV.length > 0, 'SubagentView.jsx 读不到');
  assert.match(SUBV, /!agent\?\.wfInner/, '点开内层助手对话时,那里也不能出现停不掉的停止按钮');
});

red('E2-10a AgentMonitorPanel.jsx 的 AgentBucket 必须按 a.workflow 分流到 WorkflowCard', () => {
  assert.ok(PANEL.length > 0, 'AgentMonitorPanel.jsx 读不到');
  assert.match(PANEL, /a\.workflow \? <WorkflowCard/);
});

green('E2-10b AgentMonitorPanel.jsx 区块标题模板逐字不变', () => {
  assert.ok(PANEL.length > 0, 'AgentMonitorPanel.jsx 读不到');
  assert.match(PANEL, /title=\{`workflow 内层 agent \(\$\{wfShown\.length\}\)`\}/,
    '既有测试(check-monitor-buckets §4)锁着这行,改了两处一起红');
});

red('E2-10c S7 裸列表必须按 workflowId 逐个过滤,禁止全局式 wfProgress 判定', () => {
  assert.ok(PANEL.length > 0, 'AgentMonitorPanel.jsx 读不到');
  const idx = [];
  let p = PANEL.indexOf('wfProgress');
  while (p >= 0) { idx.push(p); p = PANEL.indexOf('wfProgress', p + 1); }
  assert.ok(idx.length > 0, '面板里必须出现 wfProgress(用它判断哪些内层 agent 已被分阶段视图接管)');
  for (const i of idx) {
    const seg = PANEL.slice(Math.max(0, i - 250), i + 250);
    assert.ok(/workflowId/.test(seg),
      '同会话里 A 有进度、B 没有时,全局条件会把 B 的裸列表一起藏掉');
  }
});

red('E2-11 新增前端文件的图标必须走 ./Icon.jsx,不得直接 import lucide-react', () => {
  assert.ok(CARD.length > 0, 'WorkflowCard.jsx 还不存在');
  assert.equal(/from ['"]lucide-react['"]/.test(CARD + VIEW), false,
    '项目图标统一走 Icon.jsx 间接层(check-icon-indirection 锁着同一条)');
});

green('E2-12 stopSingleTask 的乐观收尾与落空语义不变(不新增 action)', () => {
  // r114 锁的是【行为】:乐观 stopped、落空落终态 + settledBy:'gone'、不发假成功。
  // (R12 轮次按 INTERFACE 改了 stop-task 的请求字段 parentSessionId/parentPid —— 那是
  // 合同要求的字段改名,不是语义回归;这里改成对行为做断言,不再拿整文件逐字节卡死,
  // 否则任何一次合法的调用点/字段调整都会把这条锁撞红,锁就退化成噪音。)
  const st = stripComments(read('client/src/stores/sessionStore.js'));
  const at = st.indexOf('stopSingleTask: async');
  assert.ok(at > 0, 'sessionStore.js 里必须有 stopSingleTask');
  const body = st.slice(at, st.indexOf('\n  },', at));
  assert.ok(/status: 'stopped', finishedAt: Date\.now\(\), optimisticStop: true/.test(body),
    '非终态目标必须乐观标 stopped(第三方 provider 不发 task_notification 也要收敛)');
  assert.ok(/status: 'done', settledBy: 'gone'/.test(body),
    '无一命中必须落终态 + settledBy:gone,不得回滚成"工作中"造僵尸卡');
});

red('E2-13 workflowView.js 里不得有 parseWorkflowLaunchText 的前端副本', () => {
  assert.ok(VIEW.length > 0, '新文件 client/src/utils/workflowView.js 还不存在');
  assert.equal(/Task ID:|Transcript dir|parseWorkflowLaunchText/.test(VIEW), false,
    '正文解析只许留服务端一份(两份必然各自漂移,前端那份还会读到未经投影的正文)');
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r114-locks: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
console.log(`   [修前应红] ${tally.RED.pass + tally.RED.fail} 条(现在绿 ${tally.RED.pass} / 红 ${tally.RED.fail})`);
console.log(`   [修前应绿] ${tally.GREEN.pass + tally.GREEN.fail} 条(现在绿 ${tally.GREEN.pass} / 红 ${tally.GREEN.fail})`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
}
process.exit(FAILS ? 1 : 0);

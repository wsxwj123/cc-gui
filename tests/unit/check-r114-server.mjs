#!/usr/bin/env node
// r114 服务端验收测试:工作流进度投影 / 快照读取 / GET /api/workflow-run / 历史接线。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r114.md(§A、§G)写,
// 没看实现、没看 PLAN/RESEARCH/代码地图。夹具来自 .devflow/fixtures-r114/(真实 CLI 样本)。
//
// 设计要点:
//  * 【动态 import + 逐条 try/catch】:静态 import 一个还不存在的模块会在链接阶段整文件炸,
//    一条断言都跑不到;要的是"改前每条各自红",才看得出缺哪几件。
//  * 端点契约用【真服务】测:临时 HOME(在 /private/tmp/claude-501/ 下自建)+ 端口 6703–6709,
//    绝不碰 6677、绝不写 ~/.claude/**。跑完按 pid 杀。
//  * Windows 分支一律靠注入(home / join = path.win32.join)在 mac 上覆盖,不起真进程。
//  * 每条测试只测一件事,互不依赖,可任意顺序跑;每条标 [修前应红] / [修前应绿]。
//
// Run: node tests/unit/check-r114-server.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, truncateSync, chmodSync, closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path, { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = '/private/tmp/claude-501';
mkdirSync(SCRATCH, { recursive: true });
const TMP = mkdtempSync(join(SCRATCH, 'cgui-r114-srv-'));
const SANDBOX_HOME = join(TMP, 'home');
mkdirSync(SANDBOX_HOME, { recursive: true });
process.env.HOME = SANDBOX_HOME;            // 绝不读写真实 ~/.claude*
process.env.USERPROFILE = SANDBOX_HOME;

let PASS = 0;
let FAILS = 0;
const failed = [];
const tally = { RED: { pass: 0, fail: 0 }, GREEN: { pass: 0, fail: 0 } };
const TAG = { RED: '[修前应红]', GREEN: '[修前应绿]' };
async function check(tag, name, fn) {
  const label = `${TAG[tag]} ${name}`;
  try {
    await fn();
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

async function load(rel) {
  try { return await import(pathToFileURL(join(ROOT, rel)).href); }
  catch (e) { return { __err: e }; }
}
function need(mod, name) {
  if (!mod || mod.__err) throw new Error(`模块 server/utils/workflow-progress.js 未能导入:${(mod && mod.__err && mod.__err.message) || '未知'}`);
  const f = mod[name];
  if (typeof f !== 'function') throw new Error(`缺少导出 ${name}(当前 typeof=${typeof f})`);
  return f;
}
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/r114', name), 'utf8'));

const WP = await load('server/utils/workflow-progress.js');

// ══════════════════════════════════════════════════════════════════════════
// A1.1  WF_RUN_ID / WF_MAX_SNAPSHOT_BYTES —— 路径参数的唯一闸门
//   用户视角:前端把 runId 原样带上来;这条正则是"别人的软链/上级目录"进不来的第一道门。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nA1.1 runId 正则与快照大小上限(§A1.1)');

await red('A1.1-1 导出 WF_RUN_ID,且是正则', async () => {
  assert.ok(WP.WF_RUN_ID instanceof RegExp, `WF_RUN_ID 必须是正则(当前 ${Object.prototype.toString.call(WP.WF_RUN_ID)})`);
});

for (const ok of ['wf_6df34c4f-905', 'wf_5a05ea95-f8d', 'wf_631a4c46-1d3']) {
  await red(`A1.1-2 真实 runId 必须通过:${ok}`, async () => {
    assert.ok(WP.WF_RUN_ID instanceof RegExp, '缺少导出 WF_RUN_ID');
    assert.equal(WP.WF_RUN_ID.test(ok), true, `${ok} 被拒 → 真实工作流一律读不到快照`);
  });
}

for (const bad of ['', 'wf_', '..', 'wf_..', 'wf_a/b', 'wf_a\\b', 'wf_a.json', '../../etc/passwd',
  'wf_' + 'a'.repeat(65), 'WF_abc-1234', 'wf_ab']) {
  await red(`A1.1-3 必须拒绝:${JSON.stringify(bad)}`, async () => {
    assert.ok(WP.WF_RUN_ID instanceof RegExp, '缺少导出 WF_RUN_ID');
    assert.equal(WP.WF_RUN_ID.test(bad), false, `${JSON.stringify(bad)} 被放行 → 路径穿透/读到无关文件`);
  });
}

await red('A1.1-4 WF_MAX_SNAPSHOT_BYTES = 32MB', async () => {
  assert.equal(WP.WF_MAX_SNAPSHOT_BYTES, 32 * 1024 * 1024, '快照大小上限必须是 32MB(413 档的判据)');
});

// ══════════════════════════════════════════════════════════════════════════
// A1.2  projectWorkflowProgress —— 白名单投影
//   用户视角:进度表每 10s 一份、几十上百条,里面的 promptPreview 是整段提示词原文;
//   投影既是省流量,也是别把提示词原文往前端和日志里搬。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nA1.2 进度表白名单投影(§A1.2)');

const AGENT_WHITELIST = ['type', 'index', 'label', 'phaseIndex', 'phaseTitle', 'agentId', 'agentType', 'model',
  'state', 'error', 'skipped', 'blocked', 'cached', 'attempt', 'lastAttemptReason', 'queuedAt', 'startedAt',
  'durationMs', 'tokens', 'toolCalls', 'lastToolName', 'lastToolSummary', 'resultPreview'];

for (const [desc, input] of [['undefined', undefined], ['null', null], ['对象', { a: 1 }], ['字符串', '[]'], ['数字', 3]]) {
  await red(`A1.2-1 非数组入参(${desc})返回 null,绝不返回 []`, async () => {
    const f = need(WP, 'projectWorkflowProgress');
    const out = f(input);
    assert.equal(out, null, '返回 [] 会被调用方当成"空表"写进 store,把已有进度清空');
  });
}

await red('A1.2-2 空数组进 → 空数组出(不是 null)', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  assert.deepEqual(f([]), [], '空数组是合法的"当前没有条目",不能塌成 null');
});

await red('A1.2-3 返回新数组,不原地改入参', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const src = [{ type: 'workflow_phase', index: 1, title: 'Sleep' }];
  const out = f(src);
  assert.notEqual(out, src, '必须返回新数组');
  assert.deepEqual(src[0], { type: 'workflow_phase', index: 1, title: 'Sleep' }, '入参条目不得被就地改写');
});

await red('A1.2-4 夹具 progress-2 的数值例子:3 条进 2 条出', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const src = fixture('spike-wf-progress-2.json').workflow_progress.slice(0, 2)
    .concat([fixture('spike-wf-progress-2.json').workflow_progress[2], { type: 'workflow_log', message: 'x' }]);
  const out = f([src[2], { type: 'workflow_log', message: 'x' }, src[0]]);
  assert.equal(out.length, 2, 'workflow_log 整条丢弃');
  assert.deepEqual(out[0], {
    type: 'workflow_agent', index: 1, label: 'sleep:1', phaseIndex: 1, phaseTitle: 'Sleep',
    agentId: 'aaa8fb048d528745f', model: 'claude-sonnet-4-6', state: 'start',
    startedAt: 1788654540445, queuedAt: 1788654540444, attempt: 1,
  }, 'agent 条目投影后逐键必须等于契约给的输出(promptPreview / lastProgressAt 全没了)');
  assert.deepEqual(out[1], { type: 'workflow_phase', index: 1, title: 'Sleep' }, 'phase 只留 type/index/title');
});

await red('A1.2-5 phase 条目的多余键被丢弃', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const out = f([{ type: 'workflow_phase', index: 2, title: 'Report', detail: 'x', kind: 'y' }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['index', 'title', 'type'], 'phase 保留键只有 type/index/title');
});

await red('A1.2-6 白名单外的键一律不透传(promptPreview 等 6 个)', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const out = f([{
    type: 'workflow_agent', index: 1, label: 'a', promptPreview: '整段提示词', lastProgressAt: 1,
    isolation: 'x', fallbackModel: 'y', remoteSessionId: 'z', kind: 'w', 未来新增键: 1,
  }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['index', 'label', 'type'],
    '白名单外的键(含未来新增键)必须全部丢弃');
});

await red('A1.2-7 白名单里的键全部能透传(23 键都在)', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const full = {};
  for (const k of AGENT_WHITELIST) full[k] = k === 'type' ? 'workflow_agent' : 1;
  const out = f([full]);
  assert.deepEqual(Object.keys(out[0]).sort(), AGENT_WHITELIST.slice().sort(), '白名单键集合必须与契约一致');
});

await red('A1.2-8 值为 undefined 的键不写入结果', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const out = f([{ type: 'workflow_agent', index: 1, label: undefined, agentId: undefined }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['index', 'type'], 'undefined 的键必须整个不出现(不是 key:undefined)');
});

await red('A1.2-9 缺失的白名单键不补默认值(cached/skipped/durationMs 等不得凭空出现)', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const out = f([{ type: 'workflow_agent', index: 1, state: 'start' }]);
  for (const k of ['cached', 'skipped', 'blocked', 'error', 'durationMs', 'agentType', 'resultPreview', 'lastAttemptReason']) {
    assert.equal(k in out[0], false, `缺失的 ${k} 被补了默认值 → 前端会把"未知"误判成有值`);
  }
});

await red('A1.2-10 不认识的 type 整条丢弃且不报错', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  assert.deepEqual(f([{ type: 'workflow_log', message: 'x' }, { type: 'brand_new', a: 1 }]), []);
});

await red('A1.2-11 顺序原样保留,不排序不去重', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const out = f([
    { type: 'workflow_agent', index: 5, label: 'e' },
    { type: 'workflow_phase', index: 2, title: 'B' },
    { type: 'workflow_agent', index: 1, label: 'a' },
    { type: 'workflow_agent', index: 1, label: 'a' },
  ]);
  assert.deepEqual(out.map((e) => e.index), [5, 2, 1, 1], '顺序必须原样(排序/去重是前端分组的事)');
});

await red('A1.2-12 不截断:1000 条进 1000 条出', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const src = Array.from({ length: 1000 }, (_, i) => ({ type: 'workflow_agent', index: i + 1, label: 'a' + i }));
  assert.equal(f(src).length, 1000, '截断会让 1000 助手的工作流少显示助手');
});

await red('A1.2-13 脏条目(null / 字符串 / 数组)不抛异常', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const out = f([null, 'x', 42, [], { type: 'workflow_phase', index: 1, title: 'T' }]);
  assert.equal(Array.isArray(out), true, '脏条目必须被跳过而不是抛异常(消息泵里抛 = 整条流断掉)');
  assert.equal(out.length, 1, '只剩合法的那条');
});

await red('A1.2-14 125KB 真实形态样本投影后 ≤ 55%', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const base = fixture('spike-wf-progress-2.json').workflow_progress[2];
  const arr = [];
  let i = 0;
  // 73-agent 真实样本的 promptPreview 约 400 字符(见 §A1.2 实证注),按这个形态放大到 125KB
  const prompt = 'Use the Bash tool to run exactly: '.repeat(12).slice(0, 400);
  while (JSON.stringify(arr).length < 125 * 1024) {
    i += 1;
    arr.push({ ...base, index: i, label: 'agent:' + i, agentId: 'a' + String(i).padStart(16, '0'), promptPreview: prompt });
  }
  const before = JSON.stringify(arr).length;
  const after = JSON.stringify(f(arr)).length;
  assert.ok(after / before <= 0.55, `投影收益不足:${before} → ${after}(${(after / before * 100).toFixed(1)}%)`);
});

// ══════════════════════════════════════════════════════════════════════════
// A1.3  workflowSnapshotPath —— 拼路径前先过闸,且平台可注入
// ══════════════════════════════════════════════════════════════════════════
console.log('\nA1.3 快照路径拼装(§A1.3)');

const HASH = '-Users-x-repo';
const SID = 'c9d4926e-db12-4b39-ab8a-a123d972d341';
const RUN = 'wf_631a4c46-1d3';

await red('A1.3-1 合法三参 → path/root/segments 三件套', async () => {
  const f = need(WP, 'workflowSnapshotPath');
  const r = f(HASH, SID, RUN, { home: '/home/u', join: path.posix.join });
  assert.equal(r.root, '/home/u/.claude/projects/' + HASH + '/' + SID + '/workflows');
  assert.equal(r.path, r.root + '/' + RUN + '.json');
});

await red('A1.3-2 segments 是按序的四条待 lstat 路径', async () => {
  const f = need(WP, 'workflowSnapshotPath');
  const r = f(HASH, SID, RUN, { home: '/home/u', join: path.posix.join });
  assert.deepEqual(r.segments, [
    '/home/u/.claude/projects/' + HASH,
    '/home/u/.claude/projects/' + HASH + '/' + SID,
    '/home/u/.claude/projects/' + HASH + '/' + SID + '/workflows',
    '/home/u/.claude/projects/' + HASH + '/' + SID + '/workflows/' + RUN + '.json',
  ], 'segments 少一段 = 那一段换成软链就穿透了');
});

await red('A1.3-3 Windows 注入 → 反斜杠路径', async () => {
  const f = need(WP, 'workflowSnapshotPath');
  const r = f(HASH, SID, 'wf_x-abcd', { home: 'C:\\Users\\u', join: path.win32.join });
  assert.equal(r.path, `C:\\Users\\u\\.claude\\projects\\${HASH}\\${SID}\\workflows\\wf_x-abcd.json`,
    'Windows 上路径必须是反斜杠(混用会让 fs 找不到文件 → 历史工作流永远 404)');
});

for (const [desc, args] of [
  ['projectHash 含 ..', ['..', SID, RUN]],
  ['projectHash 含 /', ['a/b', SID, RUN]],
  ['sid 含 ..', [HASH, '..', RUN]],
  ['sid 含 \\', [HASH, 'a\\b', RUN]],
  ['runId 不过 WF_RUN_ID', [HASH, SID, 'wf_a.json']],
  ['runId 为空', [HASH, SID, '']],
  ['projectHash 为 undefined', [undefined, SID, RUN]],
  ['sid 为 null', [HASH, null, RUN]],
  ['runId 为数字', [HASH, SID, 42]],
]) {
  await red(`A1.3-4 不过校验(${desc})→ 返回 null 且不拼路径`, async () => {
    const f = need(WP, 'workflowSnapshotPath');
    assert.equal(f(args[0], args[1], args[2], { home: '/home/u', join: path.posix.join }), null,
      '任何一参不过校验就必须 null,拼出来再判等于把穿透路径交给了调用方');
  });
}

// ══════════════════════════════════════════════════════════════════════════
// A1.4  projectWorkflowSnapshot —— 磁盘快照投影(历史回看的数据来源)
// ══════════════════════════════════════════════════════════════════════════
console.log('\nA1.4 快照投影(§A1.4)');

await red('A1.4-1 非对象入参 → null', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  for (const v of [null, undefined, 'x', 42, []]) {
    // 数组也是"不是快照对象",但契约只说非对象 → null;数组按 typeof 是 object,
    // 这里只锁明确的非对象四种,数组交给端点的 422 兜底。
    if (Array.isArray(v)) continue;
    assert.equal(f(v), null, `${JSON.stringify(v)} 必须 → null`);
  }
});

await red('A1.4-2 夹具 snapshot-killed:status/agentCount/totalTokens 等数值逐个对', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  const out = f(fixture('snapshot-killed.json'));
  assert.equal(out.status, 'killed', 'killed 是实证存在的第三种终态');
  assert.equal(out.runId, 'wf_631a4c46-1d3');
  assert.equal(out.taskId, 'w1zi6gd0p');
  assert.equal(out.workflowName, 'spike-stop-wf');
  assert.equal(out.agentCount, 2);
  assert.equal(out.totalTokens, 52232);
  assert.equal(out.totalToolCalls, 2);
  assert.equal(out.durationMs, 28010);
  assert.equal(out.startTime, 1788654540438);
  assert.equal(out.source, 'snapshot');
});

await red('A1.4-3 夹具:result 为 null、resultTruncated 为 false', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  const out = f(fixture('snapshot-killed.json'));
  assert.equal(out.result, null, 'raw.result 是 null → 输出 null(不是 "null" 字符串)');
  assert.equal(out.resultTruncated, false);
});

await red('A1.4-4 夹具:phases 2 项(只有 title)、progress 4 条且已投影', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  const out = f(fixture('snapshot-killed.json'));
  assert.deepEqual(out.phases, [{ title: 'Sleep' }, { title: 'Report' }], 'phases 原样(实证无 index)');
  assert.equal(out.progress.length, 4, '2 phase + 2 agent');
  assert.equal('promptPreview' in out.progress[2], false, 'progress 必须是投影后的(提示词原文不外发)');
});

await red('A1.4-5 夹具:script / logs / scriptPath / defaultModel 一个都不透传', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  const out = f(fixture('snapshot-killed.json'));
  for (const k of ['script', 'logs', 'scriptPath', 'defaultModel', 'args', 'timestamp', 'workflowProgress']) {
    assert.equal(k in out, false, `${k} 被透传了 —— 脚本正文/绝对路径不该出现在响应里`);
  }
  const text = JSON.stringify(out);
  assert.equal(text.includes('/Users/dev/.claude/projects'), false, '响应里不得出现夹具里的绝对路径');
});

await red('A1.4-6 夹具:error 是异常堆栈,原样保留(未超 2000 不加省略号)', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  const out = f(fixture('snapshot-killed.json'));
  assert.equal(typeof out.error, 'string');
  assert.ok(out.error.startsWith('Error: Workflow aborted'), 'error 首行必须是原文');
  assert.equal(out.error.endsWith('…'), false, '短 error 不该加省略号');
});

await red('A1.4-7 超长 error 截到 maxErrorChars 并加 …', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  const out = f({ error: 'E'.repeat(5000) }, { maxErrorChars: 100 });
  assert.equal(out.error.length, 101, 'error 截到 100 字符 + 一个 …');
  assert.equal(out.error.endsWith('…'), true);
  assert.equal('errorTruncated' in out, false, '契约明确不加单独的 truncated 标志');
});

await red('A1.4-8 result 字符串超长 → 截断 + resultTruncated:true', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  const out = f({ result: 'R'.repeat(50) }, { maxResultChars: 10 });
  assert.equal(out.result, 'R'.repeat(10));
  assert.equal(out.resultTruncated, true);
});

await red('A1.4-9 result 是对象 → JSON.stringify 后输出', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  const out = f({ result: { rs: [1, 2] } });
  assert.equal(out.result, '{"rs":[1,2]}');
  assert.equal(out.resultTruncated, false);
});

await red('A1.4-10 缺 phases / workflowProgress → 两个键仍在且是数组', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  const out = f({ status: 'completed' });
  assert.deepEqual(out.phases, [], 'phases 恒出现');
  assert.deepEqual(out.progress, [], 'progress 恒出现(缺 workflowProgress 时是空数组)');
});

await red('A1.4-11 phases 不是数组 → []', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  assert.deepEqual(f({ phases: 'Sleep,Report' }).phases, []);
});

await red('A1.4-12 缺失源字段的键整个不出现(不写 undefined)', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  const out = f({ status: 'completed' });
  for (const k of ['runId', 'taskId', 'workflowName', 'summary', 'error', 'startTime', 'durationMs', 'agentCount', 'totalTokens', 'totalToolCalls']) {
    assert.equal(k in out, false, `${k} 源里没有就不该出现在结果里`);
  }
});

await red('A1.4-13 未知 status 原样透传(前端按未知处理)', async () => {
  const f = need(WP, 'projectWorkflowSnapshot');
  assert.equal(f({ status: 'paused' }).status, 'paused', '未来新增的 status 不得被吞成 undefined');
});

// ══════════════════════════════════════════════════════════════════════════
// A1.5  parseWorkflowTranscriptDir —— 从 transcriptDir 反推 hash/sid/runId
// ══════════════════════════════════════════════════════════════════════════
console.log('\nA1.5 transcriptDir 解析(§A1.5)');

const REAL_DIR = fixture('spike-wf-toolresult.json').tool_use_result.transcriptDir;

await red('A1.5-1 真实 transcriptDir → 三元组逐字对', async () => {
  const f = need(WP, 'parseWorkflowTranscriptDir');
  assert.deepEqual(f(REAL_DIR), {
    projectHash: '-private-tmp-claude-501--Users-dev-Desktop-claude-claude-gui-8ffbf5a0-56b4-4b4d-bc31-c7909ba3cfdc-scratchpad-spike-wf-cwd',
    sid: 'c9d4926e-db12-4b39-ab8a-a123d972d341',
    runId: 'wf_631a4c46-1d3',
  });
});

await red('A1.5-2 Windows 反斜杠路径同形可解(mac 上必须过)', async () => {
  const f = need(WP, 'parseWorkflowTranscriptDir');
  assert.deepEqual(f('C:\\Users\\u\\.claude\\projects\\-C--repo\\SID\\subagents\\workflows\\wf_a1b2c3d4-e5f'), {
    projectHash: '-C--repo', sid: 'SID', runId: 'wf_a1b2c3d4-e5f',
  });
});

await red('A1.5-3 取最后一个 projects 段(路径里出现两次也不错位)', async () => {
  const f = need(WP, 'parseWorkflowTranscriptDir');
  const r = f('/Users/x/projects/nested/.claude/projects/-h/SID/subagents/workflows/wf_abcd-1234');
  assert.deepEqual(r, { projectHash: '-h', sid: 'SID', runId: 'wf_abcd-1234' });
});

for (const [desc, input] of [
  ['非字符串 null', null],
  ['非字符串 对象', {}],
  ['空串', ''],
  ['没有 projects 段', '/Users/x/.claude/foo/-h/SID/subagents/workflows/wf_abcd-1234'],
  ['中间段名不对(agents 而非 subagents)', '/Users/x/.claude/projects/-h/SID/agents/workflows/wf_abcd-1234'],
  ['缺 workflows 段', '/Users/x/.claude/projects/-h/SID/subagents/wf_abcd-1234'],
  ['段数不足', '/Users/x/.claude/projects/-h'],
  ['末段不过 WF_RUN_ID', '/Users/x/.claude/projects/-h/SID/subagents/workflows/notarun'],
  ['hash 含 ..', '/Users/x/.claude/projects/../SID/subagents/workflows/wf_abcd-1234'],
]) {
  await red(`A1.5-4 形状不符(${desc})→ null 且不抛`, async () => {
    const f = need(WP, 'parseWorkflowTranscriptDir');
    assert.equal(f(input), null, '解析不出来只能 null;抛异常会把整条历史消息读挂');
  });
}

// ══════════════════════════════════════════════════════════════════════════
// A1.6  parseWorkflowLaunchText —— 老会话正文兜底(仅服务端)
// ══════════════════════════════════════════════════════════════════════════
console.log('\nA1.6 启动正文解析(§A1.6)');

const LAUNCH_TEXT = fixture('spike-wf-toolresult.json').block.content;

await red('A1.6-1 真实正文 → taskId/runId/transcriptDir 三项都对', async () => {
  const f = need(WP, 'parseWorkflowLaunchText');
  const r = f(LAUNCH_TEXT);
  assert.equal(r.taskId, 'w1zi6gd0p');
  assert.equal(r.runId, 'wf_631a4c46-1d3');
  assert.equal(r.transcriptDir, REAL_DIR, 'transcriptDir 必须取到整条路径(后面还要反推 hash/sid)');
});

await red('A1.6-2 Windows 反斜杠正文也能捞出 runId', async () => {
  const f = need(WP, 'parseWorkflowLaunchText');
  const text = 'Workflow launched in background. Task ID: abc123\n'
    + 'Transcript dir: C:\\Users\\u\\.claude\\projects\\-h\\SID\\subagents\\workflows\\wf_a1b2c3d4-e5f\n';
  const r = f(text);
  assert.equal(r.runId, 'wf_a1b2c3d4-e5f', 'runId 正则必须同时认 / 与 \\');
  assert.equal(r.taskId, 'abc123');
});

await red('A1.6-3 三项都没匹配到 → null(不返回全 null 的对象)', async () => {
  const f = need(WP, 'parseWorkflowLaunchText');
  assert.equal(f('Bash 执行完毕,退出码 0'), null);
});

await red('A1.6-4 只有 Task ID 时返回对象,另两项为 null', async () => {
  const f = need(WP, 'parseWorkflowLaunchText');
  const r = f('Workflow launched in background. Task ID: w1zi6gd0p');
  assert.deepEqual(r, { taskId: 'w1zi6gd0p', runId: null, transcriptDir: null });
});

for (const [desc, v] of [['null', null], ['undefined', undefined], ['数字', 42], ['对象', {}], ['空串', '']]) {
  await red(`A1.6-5 非字符串/空串(${desc})→ null 且不抛`, async () => {
    const f = need(WP, 'parseWorkflowLaunchText');
    assert.equal(f(v), null);
  });
}

await red('A1.6-6 runId 长度越界(65 字符)不被捞出来', async () => {
  const f = need(WP, 'parseWorkflowLaunchText');
  const r = f('Transcript dir: /a/workflows/wf_' + 'a'.repeat(65) + '\n');
  assert.equal(r === null || r.runId === null, true, '超长 runId 必须捞不出来(否则绕过 WF_RUN_ID 闸门)');
});

// ══════════════════════════════════════════════════════════════════════════
// A3  SSE / WS 事件形状(用纯函数复刻消息泵的改写口径)
// ══════════════════════════════════════════════════════════════════════════
console.log('\nA3 SSE/WS 投影事件形状(§A3)');

await red('A3-1 带表的 task_progress:只有 workflow_progress 被换,其余字段一字不动', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const ev = fixture('spike-wf-progress-2.json');
  const rewritten = { ...ev, workflow_progress: f(ev.workflow_progress) };
  const { workflow_progress: _a, ...restIn } = ev;
  const { workflow_progress: _b, ...restOut } = rewritten;
  assert.deepEqual(restOut, restIn, 'description/summary/usage/task_id/tool_use_id/uuid/session_id 必须原样');
  assert.equal(rewritten.workflow_progress.length, 4);
  assert.equal('promptPreview' in rewritten.workflow_progress[2], false);
});

await green('A3-2 不带表的 task_progress:守卫为假 → 不得凭空造出 workflow_progress', async () => {
  const ev = { type: 'system', subtype: 'task_progress', task_id: 't1', description: 'x' };
  const out = Array.isArray(ev.workflow_progress) ? { ...ev, workflow_progress: [] } : ev;
  assert.equal('workflow_progress' in out, false, '缺失 ≠ 空表:补 [] 会把前端已有的进度表清空');
});

await red('A3-3 双路(SSE+WS)同一份表各到一次 → 幂等', async () => {
  const f = need(WP, 'projectWorkflowProgress');
  const ev = fixture('spike-wf-progress-2.json');
  assert.deepEqual(f(ev.workflow_progress), f(ev.workflow_progress), '整表替换,两次结果必须相同');
});

// ══════════════════════════════════════════════════════════════════════════
// A2 / A4  真服务:GET /api/workflow-run 的七档错误契约 + 历史接线
//   端口只用 6703–6709;HOME 是 /private/tmp/claude-501 下自建的沙箱;绝不碰 6677。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nA2/A4 真服务端点契约(§A2、§A4)');

// ── 沙箱 HOME 布置 ───────────────────────────────────────────────────────
const EHASH = '-private-tmp-claude-501-r114-proj';
const ESID = 'c9d4926e-db12-4b39-ab8a-a123d972d341';
const ESID_NOWF = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';   // 没有 workflows 目录
const ESID_LINK = 'link-sid-0000-0000-0000-000000000000';   // 指向 ESID 的软链
const PROJ_DIR = join(SANDBOX_HOME, '.claude', 'projects', EHASH);
const WF_DIR = join(PROJ_DIR, ESID, 'workflows');
mkdirSync(WF_DIR, { recursive: true });
mkdirSync(join(PROJ_DIR, ESID_NOWF), { recursive: true });
mkdirSync(join(SANDBOX_HOME, '.claude-gui'), { recursive: true });

const SNAP_RAW = readFileSync(join(ROOT, 'tests/fixtures/r114/snapshot-killed.json'), 'utf8');
writeFileSync(join(WF_DIR, 'wf_good-0001.json'), SNAP_RAW);
writeFileSync(join(WF_DIR, 'wf_empty-0001.json'), '');
writeFileSync(join(WF_DIR, 'wf_bad-0001.json'), '{"runId": "wf_bad-0001", ');
writeFileSync(join(WF_DIR, 'wf_arr-0001.json'), '[1,2,3]');
mkdirSync(join(WF_DIR, 'wf_dir-0001.json'), { recursive: true });
// 33MB 稀疏文件(内容非法 JSON):卡 413 必须在 readFile+JSON.parse 之前
writeFileSync(join(WF_DIR, 'wf_big-0001.json'), '{');
truncateSync(join(WF_DIR, 'wf_big-0001.json'), 33 * 1024 * 1024);
// 越权目标:软链指过去时,字符串校验全过、readFile 会跟随链接读到它
writeFileSync(join(SANDBOX_HOME, 'secret.json'), JSON.stringify({ status: 'completed', summary: 'SECRET-LEAKED', apiKey: 'sk-topsecret' }));
symlinkSync(join(SANDBOX_HOME, 'secret.json'), join(WF_DIR, 'wf_link-0001.json'));
symlinkSync(join(SANDBOX_HOME, 'nope-does-not-exist.json'), join(WF_DIR, 'wf_dead-0001.json'));
symlinkSync(join(PROJ_DIR, ESID), join(PROJ_DIR, ESID_LINK));
const NOPERM = join(WF_DIR, 'wf_noperm-0001.json');
writeFileSync(NOPERM, SNAP_RAW);
try { chmodSync(NOPERM, 0o000); } catch {}
const CAN_TEST_EACCES = typeof process.getuid === 'function' && process.getuid() !== 0;

// ── A4 的历史会话 jsonl ──────────────────────────────────────────────────
const TR = fixture('spike-wf-toolresult.json');
const CWD = join(TMP, 'proj');
const jsonlRows = (toolName, block, toolUseResult) => {
  const rows = [
    { type: 'user', uuid: 'u1', sessionId: 'S', cwd: CWD, timestamp: '2026-09-06T00:00:00.000Z', message: { role: 'user', content: '跑个工作流' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'S', cwd: CWD, timestamp: '2026-09-06T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: block.tool_use_id, name: toolName, input: { script: 'x' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 'S', cwd: CWD, timestamp: '2026-09-06T00:00:02.000Z', ...(toolUseResult ? { toolUseResult } : {}), message: { role: 'user', content: [block] } },
  ];
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
};
const writeSession = (sid, text) => writeFileSync(join(PROJ_DIR, sid + '.jsonl'), text);
const SID_FULL = '11111111-1111-1111-1111-111111111111';   // toolUseResult 齐全
const SID_TEXT = '22222222-2222-2222-2222-222222222222';   // 无 toolUseResult,靠正文兜底
const SID_PLAIN = '33333333-3333-3333-3333-333333333333';  // 普通 Bash 结果
const SID_BADDIR = '44444444-4444-4444-4444-444444444444'; // transcriptDir 解析不出来
const SID_NOTWF = '55555555-5555-5555-5555-555555555555';  // taskType 不是 local_workflow
writeSession(SID_FULL, jsonlRows('Workflow', TR.block, TR.tool_use_result));
writeSession(SID_TEXT, jsonlRows('Workflow', TR.block, undefined));
writeSession(SID_PLAIN, jsonlRows('Bash', { tool_use_id: 'toolu_plain01', type: 'tool_result', content: '退出码 0', is_error: false }, undefined));
writeSession(SID_BADDIR, jsonlRows('Workflow', { tool_use_id: 'toolu_bad01', type: 'tool_result', content: '(正文里没有可解析的路径)', is_error: false },
  { ...TR.tool_use_result, transcriptDir: '/tmp/not-a-transcript-dir' }));
writeSession(SID_NOTWF, jsonlRows('Task', { tool_use_id: 'toolu_task01', type: 'tool_result', content: '子代理完成', is_error: false },
  { status: 'completed', taskId: 'tk1', taskType: 'local_agent', summary: 'x' }));

// ── 起服务 ───────────────────────────────────────────────────────────────
let PORT = 0;
let child = null;
const HTTP = async (p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(8000) });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { code: r.status, body };
};
async function boot() {
  for (const port of [6703, 6704, 6705, 6706, 6707, 6708, 6709]) {
    writeFileSync(join(SANDBOX_HOME, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1', port }));
    const c = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
      cwd: ROOT,
      env: { ...process.env, HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME, PORT: String(port), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    c.stdout.on('data', (d) => logs.push(String(d)));
    c.stderr.on('data', (d) => logs.push(String(d)));
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (c.exitCode !== null) break;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) { PORT = port; child = c; return { ok: true }; }
      } catch { /* 还没起来 */ }
    }
    try { c.kill('SIGKILL'); } catch {}
    if (port === 6709) return { ok: false, why: logs.join('').slice(-600) };
  }
  return { ok: false, why: '未知' };
}
const booted = await boot();
if (!booted.ok) {
  console.log(`  ! 服务未能在 6703–6709 起来,端点契约无法真验。原因尾巴:\n${booted.why}`);
  await red('A2-0 沙箱服务必须能在 6703–6709 起来(起不来则端点契约整块未验证)', async () => {
    assert.fail('服务未启动:' + booted.why);
  });
} else {
  console.log(`  · 沙箱服务已起:127.0.0.1:${PORT}(HOME=${SANDBOX_HOME})`);
  const q = (o) => '/api/workflow-run?' + new URLSearchParams(o).toString();

  // ── 200 正常路径 ──────────────────────────────────────────────────────
  await red('A2-1 合法三参 → 200,body 是快照投影 + 回显 projectHash/sid', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_good-0001' }));
    assert.equal(r.code, 200, `期望 200,实际 ${r.code}`);
    assert.equal(r.body.status, 'killed');
    assert.equal(r.body.projectHash, EHASH, '必须原样回显 projectHash');
    assert.equal(r.body.sid, ESID, '必须原样回显 sid');
    assert.equal(r.body.source, 'snapshot');
  });

  await red('A2-2 200 body 里 progress 已投影(4 条、无 promptPreview)', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_good-0001' }));
    assert.equal(r.body.progress.length, 4);
    assert.equal('promptPreview' in r.body.progress[2], false, '提示词原文不得随响应外发');
  });

  await red('A2-3 200 body 不含 script / logs / scriptPath / defaultModel', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_good-0001' }));
    assert.equal(r.code, 200, `期望 200,实际 ${r.code}`);
    const text = JSON.stringify(r.body);
    for (const k of ['"script"', '"logs"', '"scriptPath"', '"defaultModel"']) {
      assert.equal(text.includes(k), false, `${k} 出现在响应里`);
    }
  });

  // ── 400:参数档(零 fs) ───────────────────────────────────────────────
  for (const [desc, params] of [
    ['三参全缺', {}],
    ['缺 runId', { projectHash: EHASH, sid: ESID }],
    ['缺 sid', { projectHash: EHASH, runId: 'wf_good-0001' }],
    ['缺 projectHash', { sid: ESID, runId: 'wf_good-0001' }],
    ['runId 含 ..', { projectHash: EHASH, sid: ESID, runId: '..' }],
    ['runId 含 /', { projectHash: EHASH, sid: ESID, runId: 'wf_a/b' }],
    ['runId 含 \\', { projectHash: EHASH, sid: ESID, runId: 'wf_a\\b' }],
    ['runId 是纯点名', { projectHash: EHASH, sid: ESID, runId: 'wf_a.json' }],
    ['runId 超长', { projectHash: EHASH, sid: ESID, runId: 'wf_' + 'a'.repeat(65) }],
    ['sid 穿透', { projectHash: EHASH, sid: '../..', runId: 'wf_good-0001' }],
    ['projectHash 穿透', { projectHash: '../../..', sid: ESID, runId: 'wf_good-0001' }],
  ]) {
    await red(`A2-4 400 参数档(${desc})`, async () => {
      const r = await HTTP(q(params));
      assert.equal(r.code, 400, `期望 400,实际 ${r.code}`);
      assert.deepEqual(r.body, { error: 'bad_request' });
    });
  }

  await red('A2-5 400 必须在任何 fs 之前:项目根本不存在也照样 400', async () => {
    const r = await HTTP(q({ projectHash: 'no-such-project-hash', sid: 'no-such-sid', runId: 'wf_a.json' }));
    assert.equal(r.code, 400, '参数不合法优先于"找不到" —— 否则脏参数会先落到 fs 上');
  });

  // ── 400:符号链接门 ───────────────────────────────────────────────────
  await red('A2-6 400 符号链接:<runId>.json 是指向别处的软链', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_link-0001' }));
    assert.equal(r.code, 400, `期望 400,实际 ${r.code} —— 软链会把 ~/ 下任意 JSON 读出来`);
    assert.equal(JSON.stringify(r.body).includes('SECRET-LEAKED'), false, '软链目标内容被读出来了');
  });

  await red('A2-7 400 符号链接优先于 404:软链目标不存在时也是 400', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_dead-0001' }));
    assert.equal(r.code, 400, '判定次序错了:ENOENT 档跑在了符号链接门前面');
  });

  await red('A2-8 400 符号链接:<sid> 目录本身是软链', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID_LINK, runId: 'wf_good-0001' }));
    assert.equal(r.code, 400, `期望 400,实际 ${r.code} —— 中间段的软链同样能换掉整棵子树`);
  });

  // ── 404 / 413 / 422 / 500 ────────────────────────────────────────────
  await red('A2-9 404 快照文件不存在', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_missing-0001' }));
    assert.equal(r.code, 404, `期望 404,实际 ${r.code}`);
    assert.deepEqual(r.body, { error: 'not_found' });
  });

  await red('A2-10 404 workflows 目录不存在(该会话从没跑过工作流)', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID_NOWF, runId: 'wf_good-0001' }));
    assert.equal(r.code, 404, `期望 404,实际 ${r.code}`);
    assert.deepEqual(r.body, { error: 'not_found' }, '必须是本端点自己的 not_found,不能是 express 的默认 404');
  });

  await red('A2-11 404 目标是目录', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_dir-0001' }));
    assert.equal(r.code, 404, `期望 404,实际 ${r.code} —— 同名目录不能报成 500/422`);
    assert.deepEqual(r.body, { error: 'not_found' });
  });

  await red('A2-12 413 文件超 32MB(且必须先于 JSON.parse:该文件内容是坏 JSON)', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_big-0001' }));
    assert.equal(r.code, 413, `期望 413,实际 ${r.code} —— 报 422 说明先把 33MB 读进内存了`);
    assert.deepEqual(r.body, { error: 'too_large' });
  });

  await red('A2-13 422 文件 0 字节', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_empty-0001' }));
    assert.equal(r.code, 422, `期望 422,实际 ${r.code}`);
    assert.deepEqual(r.body, { error: 'corrupt' });
  });

  await red('A2-14 422 JSON 解析失败(写到一半的快照)', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_bad-0001' }));
    assert.equal(r.code, 422, `期望 422,实际 ${r.code}`);
  });

  await red('A2-15 422 解析出来不是对象(顶层是数组)', async () => {
    const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_arr-0001' }));
    assert.equal(r.code, 422, `期望 422,实际 ${r.code}`);
  });

  if (CAN_TEST_EACCES) {
    await red('A2-16 500 其它 fs 错误(EACCES)', async () => {
      const r = await HTTP(q({ projectHash: EHASH, sid: ESID, runId: 'wf_noperm-0001' }));
      assert.equal(r.code, 500, `期望 500,实际 ${r.code}`);
      assert.deepEqual(r.body, { error: 'unreadable' });
    });
  }

  await red('A2-17 错误 body 不回显路径(不含 HOME / hash / runId)', async () => {
    for (const params of [
      { projectHash: EHASH, sid: ESID, runId: 'wf_missing-0001' },
      { projectHash: EHASH, sid: ESID, runId: 'wf_a.json' },
      { projectHash: EHASH, sid: ESID, runId: 'wf_bad-0001' },
    ]) {
      const r = await HTTP(q(params));
      const text = JSON.stringify(r.body || {});
      assert.equal(text.includes(SANDBOX_HOME), false, '错误 body 泄露了本机路径');
      assert.equal(text.includes(EHASH), false, '错误 body 回显了 projectHash');
      assert.deepEqual(Object.keys(r.body || {}), ['error'], '错误 body 只许有 error 一个键');
    }
  });

  await green('A2-18 只读:一串请求打完,快照文件与目录内容一字未改', async () => {
    assert.equal(readFileSync(join(WF_DIR, 'wf_good-0001.json'), 'utf8'), SNAP_RAW, '端点写了快照文件');
    assert.equal(readFileSync(join(SANDBOX_HOME, 'secret.json'), 'utf8').includes('sk-topsecret'), true, '端点动了链接目标');
  });

  await green('A2-19 既有端点 /api/workflow-agents 行为不变(仍返回 {agents:[…]})', async () => {
    const r = await HTTP(`/api/workflow-agents?sessionId=${ESID}&projectHash=${EHASH}`);
    assert.equal(r.code, 200);
    assert.equal(Array.isArray(r.body.agents), true, '本轮服务端零改动,形状必须还是 {agents:[]}');
  });

  // ── A4:历史会话的 workflowRun 附着 ────────────────────────────────────
  const msgs = async (sid) => (await HTTP(`/api/sessions/${sid}/messages?projectHash=${EHASH}`)).body;
  const firstToolCall = (body) => (body.messages || []).flatMap((m) => m.toolCalls || [])[0];

  await green('A4-0 基线:普通 Bash 的 tool_result 形状照旧(toolUseId/content/isError)', async () => {
    const tc = firstToolCall(await msgs(SID_PLAIN));
    assert.equal(tc.result.toolUseId, 'toolu_plain01');
    assert.equal(tc.result.content, '退出码 0');
    assert.equal('workflowRun' in tc.result, false, '非工作流的 tool_result 不许多长出 workflowRun');
  });

  await red('A4-1 toolUseResult 齐全 → result.workflowRun 五个字段都对', async () => {
    const tc = firstToolCall(await msgs(SID_FULL));
    assert.deepEqual(tc.result.workflowRun, {
      taskId: 'w1zi6gd0p',
      runId: 'wf_631a4c46-1d3',
      workflowName: 'spike-stop-wf',
      projectHash: '-private-tmp-claude-501--Users-dev-Desktop-claude-claude-gui-8ffbf5a0-56b4-4b4d-bc31-c7909ba3cfdc-scratchpad-spike-wf-cwd',
      sid: 'c9d4926e-db12-4b39-ab8a-a123d972d341',
    }, 'workflowRun 的五个字段是前端拉快照的唯一依据');
  });

  await red('A4-2 workflowRun 里绝不出现 transcriptDir / scriptPath 绝对路径', async () => {
    const tc = firstToolCall(await msgs(SID_FULL));
    assert.deepEqual(Object.keys(tc.result.workflowRun).sort(),
      ['projectHash', 'runId', 'sid', 'taskId', 'workflowName'], 'workflowRun 只许有这五个键');
  });

  await red('A4-3 toolUseResult 缺失 → 从 tool_result 正文兜底补出 runId/taskId/hash/sid', async () => {
    const tc = firstToolCall(await msgs(SID_TEXT));
    assert.equal(tc.result.workflowRun.runId, 'wf_631a4c46-1d3', '老会话没有 toolUseResult,只能从正文捞');
    assert.equal(tc.result.workflowRun.taskId, 'w1zi6gd0p');
    assert.equal(tc.result.workflowRun.sid, 'c9d4926e-db12-4b39-ab8a-a123d972d341');
  });

  await red('A4-4 transcriptDir 解析不出来 → projectHash/sid 为 null,其余字段照给', async () => {
    const tc = firstToolCall(await msgs(SID_BADDIR));
    assert.equal(tc.result.workflowRun.runId, 'wf_631a4c46-1d3');
    assert.equal(tc.result.workflowRun.projectHash, null);
    assert.equal(tc.result.workflowRun.sid, null);
  });

  await green('A4-5 taskType 不是 local_workflow 且正文不匹配 → 不加 workflowRun 键', async () => {
    const tc = firstToolCall(await msgs(SID_NOTWF));
    assert.equal('workflowRun' in tc.result, false, '普通子代理的结果不得被当成工作流');
  });

  await green('A4-6 其余 tool_result 形状一字不变(仍有 toolUseId/content/isError)', async () => {
    const tc = firstToolCall(await msgs(SID_FULL));
    assert.equal(tc.result.toolUseId, 'toolu_01UMapHJXLDJddj3ZT5tCeJf');
    assert.equal(typeof tc.result.content, 'string');
    assert.equal(tc.result.isError, false);
  });
}

// ══════════════════════════════════════════════════════════════════════════
if (child) { try { child.kill('SIGKILL'); } catch {} }
console.log(`\n—— check-r114-server: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
console.log(`   [修前应红] ${tally.RED.pass + tally.RED.fail} 条(现在绿 ${tally.RED.pass} / 红 ${tally.RED.fail})`);
console.log(`   [修前应绿] ${tally.GREEN.pass + tally.GREEN.fail} 条(现在绿 ${tally.GREEN.pass} / 红 ${tally.GREEN.fail})`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
}
try { chmodSync(NOPERM, 0o644); } catch {}
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(FAILS ? 1 : 0);

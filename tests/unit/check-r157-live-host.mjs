#!/usr/bin/env node
// r157-live-line 白盒:状态行由工作组头行承载的唯一判定 + 子代理调用进工作组的新口径。
//
// 锁的事:
//   H1 isLiveLineHostedByGroup:聊天模式 / 停止中 / 压缩中 → false;最后一段不是 group(正文、工作流、技能)→ false;
//      最后一段是 group 且阶段为 tool(未返回的工具)或 thinking(最后是思考 / 工具结果都回了)→ true;空 blocks → false。
//   H2 liveLabelFromBlocks:pendingTool 取 blocks 里最后一个没结果的 toolCall,与 liveStatusLabel 同一套文字。
//   H3 groupCoworkBlocks:Task / Agent 进 group(不再产出 kind:'task');Workflow / Skill / 读 SKILL.md 仍独立成段;
//      stripSummary.steps 计入子代理调用。
//   H4 activeGroupKey 口径不变。
//
// 跑法:node tests/unit/check-r157-live-host.mjs
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const live = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'liveStatus.js')).href);
const ss = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'streamStatus.js')).href);
const { isLiveLineHostedByGroup: hosted, liveLabelFromBlocks: label } = live;

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); } catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
}

const txt = (content) => ({ type: 'text', content });
const think = (content) => ({ type: 'thinking', content });
const tool = (name, input = {}, result) => ({ type: 'tool_use', toolCall: { id: `${name}-${Math.random()}`, name, input, ...(result === undefined ? {} : { result }) } });
const done = { content: 'ok' };

console.log('H1 isLiveLineHostedByGroup');
t('空 blocks → false', () => assert.equal(hosted({ blocks: [] }), false));
t('非数组 blocks → false(不抛)', () => assert.equal(hosted({ blocks: null }), false));
t('未返回的工具在最后一组 → true', () => assert.equal(hosted({ blocks: [txt('a'), tool('Bash', { description: 'x' })] }), true));
t('最后一块是思考 → true', () => assert.equal(hosted({ blocks: [think('想一想')] }), true));
t('工具都回了、正文没来(thinking 阶段)→ true', () => assert.equal(hosted({ blocks: [think('想'), tool('Bash', { description: 'x' }, done)] }), true));
t('聊天模式 → false', () => assert.equal(hosted({ blocks: [tool('Bash', { description: 'x' })], chatMode: true }), false));
t('停止中 → false', () => assert.equal(hosted({ blocks: [tool('Bash', { description: 'x' })], stopping: true }), false));
t('压缩中 → false', () => assert.equal(hosted({ blocks: [tool('Bash', { description: 'x' }, done)], compacting: true }), false));
t('最后是正文 → false', () => assert.equal(hosted({ blocks: [tool('Bash', {}, done), txt('正文')] }), false));
t('最后是工作流 → false', () => assert.equal(hosted({ blocks: [tool('Bash', {}, done), tool('Workflow', { name: 'w' })] }), false));
t('最后是 Skill → false', () => assert.equal(hosted({ blocks: [think('想'), tool('Skill', { skill: 's' })] }), false));
t('最后是读 SKILL.md → false', () => assert.equal(hosted({ blocks: [think('想'), tool('Read', { file_path: '/a/skills/foo/SKILL.md' })] }), false));
t('最后是未返回的 Agent → true(Agent 在组里)', () => assert.equal(hosted({ blocks: [tool('Agent', { description: '子任务' })] }), true));

console.log('H2 liveLabelFromBlocks');
t('工具阶段文字 = 最后一个没结果的工具的 description', () => {
  const l = label({ blocks: [tool('Bash', { description: '甲' }), tool('Bash', { description: '乙' }, done)] });
  assert.deepEqual([l.phase, l.verb, l.object], ['tool', '', '甲']);
});
t('思考阶段 = 「思考 · 预览」', () => {
  const l = label({ blocks: [think('我在想一件事。')] });
  assert.deepEqual([l.phase, l.verb], ['thinking', '思考']);
});
t('stopping 优先', () => assert.equal(label({ blocks: [tool('Bash', { description: 'x' })], stopping: true }).phase, 'stopping'));
t('正文阶段', () => assert.equal(label({ blocks: [tool('Bash', {}, done), txt('t')] }).phase, 'text'));
t('与 liveStatusLabel 直接调用结果一致', () => {
  const blocks = [think('想'), tool('Grep', { pattern: 'foo' })];
  const direct = live.liveStatusLabel({ pendingTool: blocks[1].toolCall, pendingTitle: ss.latestToolTitles([blocks[1].toolCall]).liveTitle, ...ss.tailBlockInfo(blocks) });
  assert.deepEqual(label({ blocks }), direct);
});

console.log('H3 groupCoworkBlocks 新口径');
t('Task / Agent 进 group,不产出 task 段', () => {
  const segs = ss.groupCoworkBlocks([tool('Bash', { description: 'a' }), tool('Agent', { description: 'b' }), tool('Task', { description: 'c' })]);
  assert.deepEqual(segs.map((s) => s.kind), ['group']);
  assert.equal(segs[0].items.length, 3);
});
t('Workflow / Skill / 读 SKILL.md 仍独立成段', () => {
  const segs = ss.groupCoworkBlocks([tool('Bash'), tool('Workflow', { name: 'w' }), tool('Skill', { skill: 's' }), tool('Read', { file_path: '/x/skills/k/SKILL.md' }), tool('Agent', { description: 'd' })]);
  assert.deepEqual(segs.map((s) => s.kind), ['group', 'workflow', 'skill', 'skilldoc', 'group']);
});
t('stripSummary.steps 计入子代理调用', () => {
  const s = ss.stripSummary([think('想'), tool('Bash', {}, done), tool('Agent', { description: 'd' }, done), txt('t')]);
  assert.equal(s.steps, 3);
  assert.equal(s.doneTitle, 'd');
});
t('isFoldableSegment 仍只认 group', () => {
  assert.equal(ss.isFoldableSegment({ kind: 'group' }), true);
  for (const k of ['text', 'task', 'workflow', 'skill', 'skilldoc']) assert.equal(ss.isFoldableSegment({ kind: k }), false);
});

console.log('H4 activeGroupKey 不变');
t('流式且最后一段是 group → 该 key', () => {
  const segs = ss.groupCoworkBlocks([txt('a'), tool('Bash'), tool('Agent', { description: 'x' })]);
  assert.equal(ss.activeGroupKey(segs, true), 1);
});
t('非流式 → null', () => assert.equal(ss.activeGroupKey(ss.groupCoworkBlocks([tool('Bash')]), false), null));
t('最后一段是正文 → null', () => assert.equal(ss.activeGroupKey(ss.groupCoworkBlocks([tool('Bash'), txt('a')]), true), null));
t('空 → null', () => assert.equal(ss.activeGroupKey([], true), null));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

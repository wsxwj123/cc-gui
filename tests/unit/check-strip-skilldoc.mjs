#!/usr/bin/env node
// 条带折叠:skilldoc(读 skills/<name>/SKILL.md)段的**口径一致性**。
//
// 这只缺陷的形态:渲染侧把 SKILL.md 读取识别成 skilldoc 段(恒显不折),摘要侧却按
// 普通工具算进 group(可折)→ 屏幕上多出一行「思考与工具调用 · 1 步」,点开/收起
// 没有任何段藏起来或露出来(该轮没有 data-strip-item="group" 元素)。
//
// 判据(不依赖 React):
//   1. groupCoworkBlocks 只有**一种**调用形态 —— 无选项调用即渲染口径;
//   2. 读一次 SKILL.md 的轮:可折段数 = 0 且 stripSummary.steps = 0(= 不出现摘要行);
//   3. 任意形状的轮:「摘要说有几步」== 「同一份分组里可折段内的块数」(单一判据来源)。
//   4. 源码哨兵:TurnBubble 不得再长出第二份 getSkillDocReadName。
//
// 红的历史:改动前 groupCoworkBlocks(list)(无选项)把该 Read 归成 group → t2/t3 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripSummary, isFoldableSegment, groupCoworkBlocks, getSkillDocReadName } from '../../client/src/utils/streamStatus.js';

const think = (content) => ({ type: 'thinking', content });
const text = (content) => ({ type: 'text', content });
const tool = (name, input = {}, id = name) => ({ type: 'tool_use', toolCall: { id, name, input } });
// 产品刻意支持的形态:AI 直接用 Read 加载技能文档(不走 Skill 工具)
const skillDoc = (name = 'ponytail', id = 'sd1') => tool('Read', { file_path: `/Users/u/.claude/skills/${name}/SKILL.md` }, id);

const foldableItems = (segs) => segs
  .filter((s) => isFoldableSegment(s))
  .reduce((n, s) => n + s.items.length, 0);

// ── t1 识别本身:读取类工具命中,非读取类不命中(兼容 Windows 反斜杠与 mcp read_file)──
{
  assert.equal(getSkillDocReadName(skillDoc('ponytail').toolCall), 'ponytail', 'Read + skills/<name>/SKILL.md → 命中');
  assert.equal(getSkillDocReadName({ name: 'mcp__desktop-commander__read_file', input: { path: '/h/.claude/skills/task-flow/SKILL.md' } }),
    'task-flow', 'mcp read_file 命中');
  assert.equal(getSkillDocReadName({ name: 'Read', input: { file_path: 'C:\\Users\\u\\.claude\\skills\\dev-flow\\SKILL.md' } }),
    'dev-flow', 'Windows 反斜杠命中');
  assert.equal(getSkillDocReadName({ name: 'Edit', input: { file_path: '/h/.claude/skills/x/SKILL.md' } }), null, 'Edit 不算加载(是在开发技能)');
  assert.equal(getSkillDocReadName({ name: 'Read', input: { file_path: '/h/project/SKILL.md' } }), null, '路径不在 skills/<name>/ 下不算');
  assert.equal(getSkillDocReadName({ name: 'Read', input: {} }), null, '无路径不抛、不命中');
}

// ── t2 只读了 SKILL.md 的轮:零可折段、零步 → 不出现摘要行 ──
{
  const blocks = [skillDoc('ponytail'), text('技能读完了,按它的步骤走。')];
  const segs = groupCoworkBlocks(blocks);            // 渲染口径 = 唯一调用形态
  assert.deepEqual(segs.map((s) => s.kind), ['skilldoc', 'text'],
    '读 SKILL.md 必须成 skilldoc 段(不是 group)');
  assert.equal(segs.filter(isFoldableSegment).length, 0, 'skilldoc 段恒显不折 → 可折段数 0');

  const s = stripSummary(blocks, null);
  assert.equal(s.steps, 0, '恒显段里的块不计入步数(计进去就会出现"点了没反应"的摘要行)');
  assert.equal(s.steps > 0, segs.some(isFoldableSegment),
    '摘要行出现判据(steps>0)必须与"真的有可折段"一致');
}

// ── t3 单一判据来源:任意形状的轮,steps == 同一份分组里可折段内的块数 ──
{
  const shapes = [
    [skillDoc('a'), think('看完技能文档,先摸现场。'), tool('Bash', { command: 'ls' }), text('第一段正文。')],
    [think('想一下'), text('中间插话'), skillDoc('b', 'sd2'), tool('Grep', { pattern: 'x' }), text('收尾')],
    [skillDoc('c', 'sd3')],
    [skillDoc('d', 'sd4'), tool('Skill', { skill: 'ponytail' }, 'sk1'), text('读完并调了技能')],
    [think('只有思考'), think('再来一条')],
  ];
  for (const [i, blocks] of shapes.entries()) {
    const segs = groupCoworkBlocks(blocks);
    assert.equal(stripSummary(blocks, null).steps, foldableItems(segs),
      `形状 ${i}:摘要步数必须等于同一份分组里可折段内的块数`);
    assert.equal(stripSummary(blocks, null).steps > 0, segs.some(isFoldableSegment),
      `形状 ${i}:摘要行出现判据与可折段存在性一致`);
  }
}

// ── t4 源码哨兵:TurnBubble 不得再有第二份 skilldoc 识别 ──
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../client/src/components/TurnBubble.jsx'), 'utf8');
  assert.ok(!/function\s+getSkillDocReadName/.test(src),
    'TurnBubble 里不许再定义一份 getSkillDocReadName(两份实现会慢慢跑偏)');
  assert.ok(/getSkillDocReadName/.test(src), 'TurnBubble 仍要用它渲染 skilldoc 横幅');
  assert.ok(!/groupCoworkBlocks\([^)]*,\s*\{/.test(src),
    'groupCoworkBlocks 只允许无选项调用(带选项 = 又出现两套分组口径)');
}

console.log('check-strip-skilldoc: all passed');

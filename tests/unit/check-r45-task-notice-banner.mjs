#!/usr/bin/env node
// R45(前端侧):「后台任务通知」行改成与 skill 调用横幅(SkillCard)同构的居中横幅 + 默认收起。
// 锁三件事:①居中用的是 SkillCard 那套两侧分隔线(两边字面量必须一致,防止"你以为抄了、
// 其实是自己发明的居中");②默认收起(初值 false),信封原文只出现在展开分支里;③收起态
// 仍带状态——notice.status 必须在展开分支之前就绑好,不因折叠把"死活"藏起来。
// node 跑不了 JSX,沿用 check-r10-task-notice-ui.mjs 的读文件结构断言做法。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const SKILL = readFileSync(join(root, 'client/src/components/tools/SkillCard.jsx'), 'utf8');

const row = APP.match(/function TaskNoticeRow\(\{ notice \}\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(row, 'TaskNoticeRow 必须存在');

// ① 同构:居中靠【两侧分隔线 + 居中列】,class 字面量与 SkillCard 逐字一致。
assert.equal((row.match(/flex-1 h-px bg-canvas-deep\/70/g) || []).length, 2,
  '两侧分隔线各一条(居中横幅的左右翼)');
assert.match(row, /flex flex-col items-center min-w-0 max-w-\[70%\]/, '中间是居中列(与 SkillCard 同款)');
assert.match(SKILL, /flex-1 h-px bg-canvas-deep\/70/,
  'SkillCard 仍在用同一套分隔线:任一边改了而另一边没跟,就是两边漂移(同构是 R45 的契约)');

// ② 默认收起:初值 false;信封原文只出现在展开分支之后。
assert.match(row, /const \[expanded, setExpanded\] = useState\(false\)/, '默认收起(初值 false)');
const expandAt = row.indexOf('{expanded && (');
assert.ok(expandAt > -1, '有展开分支');
assert.ok(row.indexOf('{notice.text}') > expandAt, '信封原文只在展开分支内(DOM 里默认不铺原文)');
assert.ok(!/notice\.text[^\n]*\.slice\(/.test(row), '原文不截断:折叠只是视觉收起,展开即全文');

// ③ 收起态仍可辨死活:状态绑定落在展开分支【之前】(点击区的状态小字里就渲染)。
const statusAt = row.indexOf('notice.status');
assert.ok(statusAt > -1 && statusAt < expandAt, '状态在收起态就渲染 —— 折叠不是"看不见"');
assert.match(row, /data-cgui="task-notice"/, '皮肤锚点身份不变(skinAnchors 里的 task-notice)');
assert.match(row, /data-testid="task-notice"/, '可观察身份不变');

console.log('✓ check-r45-task-notice-banner: 后台任务通知居中同构 SkillCard、默认收起、状态在收起态可见');

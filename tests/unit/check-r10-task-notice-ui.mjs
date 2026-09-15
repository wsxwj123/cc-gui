#!/usr/bin/env node
// R10（前端侧）：task-notice 必须渲染成一行系统提示，不能落进 MessageBubble 的用户气泡
// （"你 / 已并入"就是从那来的），来源不可确认时必须标出来。
// R45 起呈现改为「默认收起、点一次展开」的居中横幅：所以本锁断言的是**两态各自的事实**——
// 收起态必须有身份与状态（一条通知绝不能被吞成空白/隐形），展开态必须逐字给出信封原文
// （不截断、不省略）。原「原文恒在 DOM 里」的写法在 R45 之后已不成立（原文只活在展开分支）。
// node 跑不了 JSX，沿用本仓既有做法（check-r09-message-lightbox.mjs）：读文件做结构断言。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');

// 两个渲染清单（历史 MessageList 与实时列表）都要认这个类型——漏一个就会掉进
// `<MessageBubble message={{ ...msg, role: msg.type }} />` 兜底分支，渲染形态随 type 漂移。
const branches = APP.match(/msg\.type === 'task-notice'\s*\n?\s*\?\s*<TaskNoticeRow notice=\{msg\} \/>/g) || [];
assert.equal(branches.length, 2, `两处消息清单都要渲染 task-notice（实得 ${branches.length} 处）`);

// 组件本体：系统提示身份 + 来源未确认标记 + 收得起也展得开，且不借用用户气泡的任何文案/入口。
const row = APP.match(/function TaskNoticeRow\(\{ notice \}\) \{[\s\S]*?\n\}/);
assert.ok(row, 'TaskNoticeRow 必须存在');
const src = row[0];
assert.match(src, /data-message-id=\{notice\.uuid \|\| undefined\}/, '通知提供 data-message-id（可观察身份，非秘密）');
assert.match(src, /data-testid="task-notice"/, '通知行有稳定的可观察身份');
assert.match(src, /notice\.confirmed === false &&[\s\S]{0,80}来源未确认/,
  '来源不可确认时必须显示"来源未确认"（不能静默丢用户内容）');
assert.match(src, /notice\.status/, '信封里的 status 透出（completed/failed/killed）');
assert.doesNotMatch(src, /已并入|【你】|>你</, '通知行不得出现"你 / 已并入"这类人工气泡身份');
assert.doesNotMatch(src, /CollapsibleUserText/, '不借用用户气泡的折叠控件（通知不是用户消息）');

// ── 收起态（R45 默认态）：必须有身份 + 状态，不能是一条没有内容的空白行 ──
assert.match(src, /const \[expanded, setExpanded\] = useState\(false\)/, 'R45：默认收起（挂载即收起，不做持久化记忆）');
assert.match(src, /后台任务通知/, '收起态带身份标题 —— 通知不许被吞成看不见的行');
assert.match(src, /statusText/, '收起态带状态摘要（运行中/已完成，取自信封，不编造）');
assert.match(src, /onClick=\{\(\) => setExpanded\(!expanded\)\}/, '点一次切换展开/收起（收起态点得开）');

// ── 展开态：信封原文一个字不删（R10 的"不许把用户内容藏掉"由这一条守住）──
const expandedBranch = src.match(/\{expanded && \(([\s\S]*?)\n\s*\)\}/);
assert.ok(expandedBranch, 'R45：展开分支 {expanded && ( … )} 必须存在');
assert.match(expandedBranch[1], /\{notice\.text\}/, '展开后原文逐字渲染（不截断、不省略）');
assert.match(expandedBranch[1], /whitespace-pre-wrap/, '展开后的原文保持原换行形态（不压成一行）');
assert.doesNotMatch(expandedBranch[1], /truncate|line-clamp/, '展开后的原文不得截断/省略');

// 收起态不得铺开信封原文（R45 的动机就是别占版面）——摘要是从原文里解出来的单行，不是全文。
const collapsedBranch = src.slice(0, src.indexOf('{expanded && ('));
assert.doesNotMatch(collapsedBranch, /\{notice\.text\}/, '收起态不出信封原文（只出身份与状态摘要）');

// 通知不参与人工消息的交互入口（回滚只对 user 角色开放,分叉只对非并入的人工消息开放）。
// R36 起并入消息也有回退入口(它在 jsonl 里有自己的记录锚点),所以回滚那道门只留 role 判据;
// 分叉仍旧排除 steered(它按"真·用户提问"找回合边界,attachment 行不是提问)。
assert.match(APP, /onRollback=\{msg\.type === 'user' \? onRollback : undefined\}/,
  '回滚入口只挂在 user 角色消息上(task-notice 等系统行不给)');
assert.match(APP, /onFork=\{msg\.type === 'user' && !msg\.steered \? onFork : undefined\}/,
  '分叉入口只挂在非并入的人工消息上');
assert.doesNotMatch(APP, /onRollback=\{msg\.type === 'user' && !msg\.steered/,
  'R36:回滚入口不得再被 steered 门掉');

console.log('✓ check-r10-task-notice-ui: 通知行系统提示身份、收起态有标题+状态、展开后原文逐字完整、来源未确认标记、不进用户气泡');

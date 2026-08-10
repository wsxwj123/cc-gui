#!/usr/bin/env node
// 第五轮 UI 两条(用户逐字需求):
//   ① 思考链与工具行一致 —— 默认折叠成一行,点击展开/收起(原来思考默认全展开、没折叠钮)。
//   ② AI 回复气泡高过所在窗格可视区时,气泡底部再补一个复制按钮;一屏看得全的短回复只留顶部那个。
// 判据是纯函数(真 import 测边界);渲染点是 JSX 不能真 import,用源码锁 + 变异验证。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shouldShowBottomCopy } from '../../client/src/utils/scroll.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'client/src/components/TurnBubble.jsx'), 'utf8');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

// ── 1. 底部复制判据:纯高度对比,不看滚动位置 ──────────────────────
assert.equal(shouldShowBottomCopy({ bubbleH: 900, viewH: 800 }), true, '气泡高过可视区 → 补底部复制');
assert.equal(shouldShowBottomCopy({ bubbleH: 801, viewH: 800 }), true, '略超一屏也算超(严格大于)');
assert.equal(shouldShowBottomCopy({ bubbleH: 800, viewH: 800 }), false, '刚好等高 = 一屏看得全 → 不补');
assert.equal(shouldShowBottomCopy({ bubbleH: 120, viewH: 800 }), false, '短回复不补');
// 容器/气泡没量到(未挂载、隐藏窗格、closest 落空)→ 无从判断,一律不显示,不能误判成 true
assert.equal(shouldShowBottomCopy({ bubbleH: 900, viewH: 0 }), false, '容器高 0 → 不判');
assert.equal(shouldShowBottomCopy({ bubbleH: 0, viewH: 800 }), false, '气泡高 0 → 不判');
assert.equal(shouldShowBottomCopy({ bubbleH: 900, viewH: undefined }), false, '缺参数 → 不判');
assert.equal(shouldShowBottomCopy({ bubbleH: NaN, viewH: 800 }), false, 'NaN → 不判');
// 单调性(ResizeObserver 不抖的前提):加了按钮气泡只会更高,判据不会翻回 false
{
  const BTN = 28;
  const bubbleH = 801, viewH = 800;
  assert.equal(shouldShowBottomCopy({ bubbleH, viewH }), true);
  assert.equal(shouldShowBottomCopy({ bubbleH: bubbleH + BTN, viewH }), true, '显示按钮后判据必须仍为 true,否则 RO 来回抖');
}

// ── 2. 思考折叠:默认收起,且两个渲染点都走同一个折叠组件 ────────────
assert.ok(/function ThinkingFold\(\{ content \}\)/.test(src),
  'ThinkingFold 必须自管展开态(只收 content),展开态留在父级会让展开一块重渲整棵子树');
{
  const body = src.slice(src.indexOf('function ThinkingFold('), src.indexOf('function ThinkingFold(') + 900);
  assert.ok(/const \[open, setOpen\] = useState\(false\)/.test(body), '思考块默认必须是折叠态(useState(false))');
  assert.ok(/setOpen\(\(v\) => !v\)/.test(body), '点击要能展开也能收起');
  assert.ok(/thinkingLabel\(text\)/.test(body), '折叠头显示首句摘要(流式时随内容更新)');
  assert.ok(/max-h-64 overflow-y-auto/.test(body), '展开态保留 max-h-64 内滚');
  // 白屏守卫:第三方 provider 的 thinking content 可能是对象,渲染前必须转字符串
  assert.ok(/typeof content === 'string' \? content : JSON\.stringify\(content\)/.test(body),
    '非字符串 thinking content 的白屏守卫不许丢');
}
// 两处渲染点(WorkGroup 组内 items 循环 + 聊天模式独立思考块)都用 ThinkingFold
assert.equal(count(src, '<ThinkingFold'), 2, '两个思考渲染点都必须走折叠组件');
assert.ok(/if \(b\.type === 'thinking'\) return <ThinkingFold/.test(src),
  'WorkGroup 组内思考必须折叠渲染(原来是裸 thinking-block div,默认全展开)');
assert.ok(/b\.type === 'thinking' && b\.content[\s\S]{0,120}<ThinkingFold key=/.test(src),
  '聊天模式思考块也走同一个折叠组件');
// 受控残留(父级持有展开态)必须清干净,否则又会打穿叶子隔离
assert.ok(!/openThinking/.test(src), 'CoworkBlocks 不该再持有 openThinking 展开态');
// 组内思考不得再有"总是可见"的裸文本块
assert.ok(!/thinking-block p-3/.test(src), 'WorkGroup 的常展开思考块必须删除');

// ── 3. 底部复制按钮接线 ────────────────────────────────────────
assert.ok(/const \[showBottomCopy, setShowBottomCopy\] = useState\(false\)/.test(src),
  '判定结果存叶子 state(默认不显示)');
assert.ok(/ref=\{bubbleRef\}/.test(src), '气泡根节点要挂 ref 供测量');
assert.ok(/closest\?\.\('\[data-chat-scroll\]'\)/.test(src),
  '要按 data-chat-scroll 找本窗格滚动容器(分屏下不能用 window)');
// 注意锚到元素本身:只搜字符串会被同名注释喂饱(变异验证时漏抓过)
assert.ok(/<div ref=\{setContainerRef\}[^>]*data-chat-scroll/.test(app),
  'App.jsx 的聊天滚动容器元素上必须带 data-chat-scroll');
{
  const eff = src.slice(src.indexOf('const bubbleRef'), src.indexOf('const bubbleRef') + 1100);
  assert.ok(/ro\.observe\(el\)/.test(eff) && /ro\.observe\(scroller\)/.test(eff),
    '气泡和容器都要观察:容器那份覆盖分屏切换/窗口缩放,免得另挂 resize 监听');
  assert.ok(/return \(\) => ro\.disconnect\(\)/.test(eff), '卸载必须断开观察器');
  assert.ok(/\}, \[\]\)/.test(eff), '观察器只挂一次(空依赖),不随流式每 token 重建');
  assert.ok(/prev === next \? prev : next/.test(eff), '只有判定翻转才 setState,流式每 token 不重渲');
}
// 底部按钮复用顶部同一个 CopyButton(含 execCommand 降级),不许自己写 clipboard
assert.ok(/\{showBottomCopy && <CopyButton text=\{fullText\} \/>\}/.test(src), '底部按钮必须复用 CopyButton');
assert.ok(!/navigator\.clipboard/.test(src), 'TurnBubble 不得自己调 clipboard API');

console.log('✓ check-bubble-copy-fold: 思考默认折叠 + 长回复底部复制判据');

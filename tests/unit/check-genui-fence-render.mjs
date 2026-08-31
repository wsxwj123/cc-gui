#!/usr/bin/env node
// r64 M4:围栏拦截 + 流式信号。锁三件事:
//   ① GenuiFence 的处理顺序与降级安全网(空体 → 字节上限 → 解析,任何一条走不通都留代码块);
//   ② 渲染侧可测锚在该在的分支上、不在不该在的分支上(INTERFACE §9.1「必须不存在」那半);
//   ③ isStreaming 是 props 透传,不是 DOM 探测,且三个 TurnBubble 调用点都接上了。
// GenuiFence.jsx / MarkdownRenderer.jsx 是 JSX,裸 node 加载不了(ERR_UNKNOWN_FILE_EXTENSION),
// 按仓内惯例(check-codeblock-extract / check-genui-host-primitives)走源码锁;
// 能真 import 的 .ts 依赖(上限表、失败描述)一律真跑,不写死数值。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GENUI_LIMITS } from '../../client/src/genui/upstream/guard.ts';
import { describeJsonFailure } from '../../client/src/genui/upstream/fence-repair.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const fence = read('client/src/components/GenuiFence.jsx');
const md = read('client/src/components/MarkdownRenderer.jsx');
const turn = read('client/src/components/TurnBubble.jsx');
const at = (hay, needle, what) => {
  const i = hay.indexOf(needle);
  assert.notEqual(i, -1, `找不到:${what}(${needle})`);
  return i;
};

// ── 1. 字节上限:值进 GENUI_LIMITS 同一张表(§5.3 补丁 0),按**字节**不按字符 ──────
{
  assert.equal(GENUI_LIMITS.maxFenceBytes, 128 * 1024, 'INTERFACE §1.3/§5.7:围栏原文上限 128KB');
  assert.ok(/fenceByteLength[\s\S]{0,120}new TextEncoder\(\)\.encode\(raw\)\.length/.test(fence),
    '必须量 UTF-8 字节;按 raw.length 算字符会让中文围栏放进三倍大的东西');
  assert.ok(fence.includes('GENUI_LIMITS.maxFenceBytes'),
    '上限要读 GENUI_LIMITS,不许在 GenuiFence 里另写一个字面量(散落 = 半年后改一个值要 grep 五个文件)');
}

// ── 2. 处理顺序是契约:空体 → 字节上限 → resolveGenuiSpec,不许重排 ───────────────
{
  const body = fence.slice(at(fence, 'export function classifyFence', 'classifyFence'));
  const iEmpty = at(body, "raw.trim() === ''", '空体守卫');
  const iBytes = at(body, 'maxFenceBytes', '字节上限门');
  const iResolve = at(body, 'resolveGenuiSpec(', '解析');
  assert.ok(iEmpty < iBytes && iBytes < iResolve,
    '顺序必须是 空体 → 字节上限 → 解析:空体不该产生状态条目,超大围栏不该进解析层'
    + '(流式每 chunk 两次 JSON.stringify,超大子树直接卡死主线程)');
}

// ── 3. 降级安全网:三条降级路都渲染 DegradedFence(原始代码块恒在)────────────────
{
  assert.ok(/data-testid="genui-source"[\s\S]{0,120}<CodeBlock/.test(fence),
    'genui-source 必须包着原始代码块(INTERFACE §5 总原则②:不让用户对着空白发呆)');
  for (const [kind, why] of [
    ["fence.kind === 'oversize'", '超大围栏'],
    ["fence.kind === 'empty'", '空围栏体'],
  ]) assert.ok(fence.includes(kind), `${why}要有自己的降级分支`);
  // 解析不出来的那条是兜底 return,必须也是 DegradedFence
  const branches = fence.match(/<DegradedFence/g) || [];
  assert.ok(branches.length >= 4,
    `超大/空体/流式半截/定稿失败 四条降级路各要一处 DegradedFence(实际 ${branches.length})`);
}

// ── 4. 可测锚:该在的在、不该在的不在(INTERFACE §9.1)─────────────────────────────
{
  // genui-block 只出现在 spec 分支,且在 ErrorBoundary **里面**:
  // 组件抛异常时整块换成灰卡,此刻"渲染成功的块"并不存在,块锚也就不该留在 DOM 里。
  const iBoundary = at(fence, '<ErrorBoundary', 'ErrorBoundary');
  const iBlock = at(fence, 'data-testid="genui-block"', 'genui-block 锚');
  assert.ok(iBoundary < iBlock, 'ErrorBoundary 必须在 genui-block 外层');
  assert.ok(fence.slice(iBlock, at(fence, "fence.kind === 'oversize'", '超大分支')).includes('<GenuiBlock'),
    'genui-block 锚只许挂在渲染成功那一支上');
  assert.equal((fence.match(/data-testid="genui-block"/g) || []).length, 1, 'genui-block 每围栏至多一处');
  assert.ok(read('client/src/genui/upstream/ErrorBoundary.tsx').includes('data-testid="genui-render-failed"'),
    'ErrorBoundary 的灰卡要挂 genui-render-failed');
}

// ── 5. 说明条文案:逐字对上 INTERFACE §5.1 / §5.7,且流式期不出现 ────────────────
{
  for (const frag of ['cgui-ui 围栏 JSON 解析失败', '围栏保持为代码块', '界面规格过大', '已按代码块显示']) {
    assert.ok(fence.includes(frag), `说明条文案缺片段:${frag}`);
  }
  // 流式期的半截 JSON 不是错误:先 return 掉,不走到红条那一行
  const iGuard = at(fence, 'if (!settled) return <DegradedFence', '流式期静默降级');
  assert.ok(iGuard < at(fence, 'describeJsonFailure(raw)', '红条'),
    '流式期必须在算红条之前就 return —— 用户还在看模型打字,不该弹错误(§5.1 第 1 行)');
  // describeJsonFailure 对"合法 JSON 但不是界面规格"返回 null,那一路同样要有话说
  assert.equal(describeJsonFailure('[1,2,3]'), null, '前提:合法 JSON 时它返回 null');
  assert.match(describeJsonFailure('{items:'), /字符 \d+ 附近/, '前提:语法错时它给出字符位置');
  assert.ok(/describeJsonFailure\(raw\) \?\? /.test(fence),
    '合法 JSON 但不是界面规格时 describeJsonFailure 为 null,必须有兜底文案,否则红条显示 "null"');
}

// ── 6. 空体守卫两处(§1.4.1):共用点治字面量 undefined,genui 侧治"空体不产生状态"──
{
  assert.ok(md.includes("children == null ? '' : String(children)"),
    'MarkdownRenderer 的 children 空值守卫:围栏开头 1-2 帧不得显示字面量 undefined');
  assert.ok(!/String\(children\)\.replace/.test(md.replace("children == null ? '' : String(children).replace(/\\n$/, '')", '')),
    '不许留下没走守卫的 String(children) 旧写法');
  assert.ok(/kind: 'empty'[\s\S]{0,80}\n/.test(fence) && fence.indexOf("kind: 'empty'") < fence.indexOf('resolveGenuiSpec('),
    '空体在解析之前就返回:不解析、不算指纹、不读写状态存储');
}

// ── 7. 语言标记:两个都认、大小写不敏感、只取第一个空白分隔词、行内不算 ───────────
{
  assert.ok(/GENUI_LANGS = new Set\(\['cgui-ui', 'dsh-ui'\]\)/.test(fence), '两个标记一行同时认(决策 3)');
  assert.ok(/\.trim\(\)\.split\(\/\\s\+\/\)\[0\]\.toLowerCase\(\)/.test(fence),
    'normGenuiLang 照 ArtifactPreview 的 normLang:取第一个空白分隔词 + 小写');
  const iGenui = at(md, 'isGenuiLang(lang)', 'genui 分支');
  assert.ok(md.slice(0, iGenui).includes('if (isBlock) {'),
    'genui 分支必须在 isBlock 里:行内 `cgui-ui` 只是普通行内代码,不触发渲染');
  assert.ok(iGenui < at(md, 'if (isPreviewable(lang))', 'isPreviewable 分支'),
    'genui 分支排在 isPreviewable 之前(html/svg/mermaid 的既有预览行为一字不变)');
}

// ── 8. 流式信号是 props 透传,不是 DOM 探测(PLAN §1.4)────────────────────────────
{
  assert.ok(/MarkdownRenderer\(\{ content, basePath, dockKeyPrefix, isStreaming = false \}\)/.test(md),
    'isStreaming 是 prop,默认 false = 已定稿');
  assert.ok(md.includes('renderCode({ ...props, dockKeyPrefix, isStreaming })'), 'useMemo 覆盖版要把它传下去');
  assert.ok(/\}\), \[basePath, dockKeyPrefix, isStreaming\]\)/.test(md),
    'isStreaming 必须进 useMemo deps,否则定稿后 code 组件还拿着旧的 true');
  assert.ok(md.includes('settled={!isStreaming}'), 'GenuiFence 收的是 settled = !isStreaming');
  for (const bad of ['closest(', 'data-streaming', 'querySelector']) {
    assert.ok(!fence.includes(bad) && !md.includes(bad),
      `不许用 DOM 探测判流式(${bad}):React 19 并发渲染下时序不可靠`);
  }
  // 三个调用点(CoworkBlocks 聊天/分组两条 + legacy 路径)
  assert.equal((turn.match(/isStreaming=\{isLive\}/g) || []).length, 2, 'CoworkBlocks 两处透传 isLive');
  assert.equal((turn.match(/isStreaming=\{isLiveStream\}/g) || []).length, 1, 'legacy 路径透传 isLiveStream');
  assert.equal((turn.match(/<MarkdownRenderer/g) || []).length, 3, 'TurnBubble 只有这三个调用点,新增了要一起接');
}

// ── 9. 定稿后关掉入场动画:CSS 走变量,宿主只设值,不碰 upstream 的 .tsx ─────────────
{
  const css = read('client/src/genui/upstream/GenuiBlock.module.css');
  assert.ok(/animation: var\(--genui-reveal, genuiReveal 0\.45s/.test(css),
    '.reveal 的 animation 要走 var(--genui-reveal, 上游原值),默认行为一字不变');
  assert.ok(/SETTLED_STYLE = \{ '--genui-reveal': 'none' \}/.test(fence) && fence.includes('settled ? SETTLED_STYLE'),
    '定稿时设 --genui-reveal: none —— 回合末连挂两次不重播两遍逐条渐显');
}

console.log('check-genui-fence-render: all passed');

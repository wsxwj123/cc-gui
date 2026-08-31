#!/usr/bin/env node
// r64:组件 props 的**接收端绑定**。守的是本仓惯犯形态 ——
// 「prop 写进了类型注解、函数体里也用了,但参数解构里没绑它」⟹ 引用即 ReferenceError
// ⟹ 整块组件不渲染。TS 类型注解只描述形状、不绑定名字;esbuild 不做类型检查;
// `.tsx` 又不进 eslint 的 no-undef 门(§2.0 的已知代价)—— 只有这里拦得住。
// (真踩过:TabsNode/AccordionNode 的 uiKey 只写进了类型,含 tabs/accordion 的围栏整块炸;
//  同族前科见 LEARNINGS cross-component-undefined-ref-whitescreen。)
//
// 判据取"声明了就必须绑":类型注解里的每个顶层 prop,解构里都要有同名。
// 不去扫函数体判断"用没用" —— 局部变量会重名(GenuiBlock 里 setUi 的形参就叫 uiKey,
// FileTreeNode 内层 renderNode 的形参就叫 depth),扫函数体只会误报。
// 多绑一个没用上的名字零代价,漏绑一个是生产事故,所以这条严格得起。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = [
  'client/src/genui/upstream/blocks/forms.tsx',
  'client/src/genui/upstream/blocks/charts.tsx',
  'client/src/genui/upstream/blocks/advanced.tsx',
  'client/src/genui/upstream/GenuiBlock.tsx',
];

/** `({ 解构 }: { 类型 })` → { pattern, type };不是这个形态返回 null。 */
function signatureOf(src, from) {
  const open = src.indexOf('({', from);
  if (open === -1) return null;
  const patEnd = src.indexOf('}', open);
  const bodyAt = src.indexOf(') {', patEnd);
  const colon = src.indexOf(':', patEnd);
  if (colon === -1 || colon > bodyAt) return null;      // 没有类型注解,跳过
  const typeOpen = src.indexOf('{', colon);
  if (typeOpen === -1 || typeOpen > bodyAt) return null;
  let depth = 0;
  let i = typeOpen;
  for (; i < src.length; i++) {                          // 花括号计数:prop 类型自身可能是对象
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return { pattern: src.slice(open + 1, patEnd + 1), type: src.slice(typeOpen + 1, i) };
}

/** 类型块里的**顶层** prop 名(嵌套对象里的字段不算)。 */
function topLevelProps(type) {
  const names = [];
  let depth = 0;
  for (const line of type.split('\n')) {
    const m = /^\s*(?:readonly\s+)?(\w+)\??\s*:/.exec(line);
    if (depth === 0 && m !== null) names.push(m[1]);
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  return names;
}

let checked = 0;
let components = 0;
for (const file of FILES) {
  const src = readFileSync(join(root, file), 'utf8');
  for (const head of src.matchAll(/^export (?:function|const) (\w+)/gm)) {
    const sig = signatureOf(src, head.index);
    if (sig === null) continue;
    components++;
    for (const prop of topLevelProps(sig.type)) {
      checked++;
      assert.ok(new RegExp(`\\b${prop}\\b`).test(sig.pattern),
        `${file} 的 ${head[1]}:类型注解里声明了 prop \`${prop}\`,`
        + `参数解构 \`${sig.pattern.replace(/\s+/g, ' ')}\` 里却没绑它。\n`
        + '  写进类型 ≠ 绑定名字 —— 函数体一引用就是 ReferenceError,整块组件不渲染;\n'
        + '  esbuild 不做类型检查、.tsx 不进 eslint no-undef 门,只有这条断言拦得住。');
    }
  }
}
assert.ok(components >= 10 && checked >= 30,
  `覆盖面不对:只切出 ${components} 个组件 / ${checked} 个 prop,签名解析大概率没对上`);

// 反向自证:切分与判定确实能抓住"类型有、解构没有"这一形态
{
  const fake = 'export function X({ node }: {\n  node: T\n  uiKey?: string | undefined\n}) {\n  return uiKey\n}\n';
  const sig = signatureOf(fake, 0);
  assert.deepEqual(topLevelProps(sig.type), ['node', 'uiKey'], '两个 prop 都要认出来');
  assert.ok(!/\buiKey\b/.test(sig.pattern), 'uiKey 确实没绑 —— 这正是要报红的形态');
}

console.log(`check-genui-prop-binding: all passed (${components} 个组件 / ${checked} 个 prop 全部绑定)`);

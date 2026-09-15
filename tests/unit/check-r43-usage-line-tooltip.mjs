#!/usr/bin/env node
// R43(2026-09-13,用户实报):轮末/消息用量行的 token 明细太技术化,且旧名让人误以为
// "我的上下文有 6 万 token"。契约(INTERFACE §H):
//   · 行内只留 输入/输出/金额;`缓存命中/缓存写入/本轮累计读取/整轮命中率` 进行容器 title;
//   · 悬停文案三行逐字(§H.2),「整轮命中率」名字与数值口径一字未改,分母 0 显示 —;
//   · 旧名在本批改完后不得再出现在 client/src 里(§H.3)。
// JSX 不能真 import → 源码锁:把 title 模板字符串抽出来**真求值**,按夹具复算逐字比对。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cacheHitPct, formatHitPct, formatHitPctOrDash } from '../../client/src/utils/cacheStats.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = {
  TurnBubble: readFileSync(join(root, 'client/src/components/TurnBubble.jsx'), 'utf8'),
  MessageBubble: readFileSync(join(root, 'client/src/components/MessageBubble.jsx'), 'utf8'),
};

// 行容器 = 金额的直接父容器;title 恒存在(无条件模板字符串,费用未知态/读写全 0 时同样非空)。
function extractTitle(src, name) {
  const at = src.indexOf('data-cgui="usage-line"');
  assert.ok(at > -1, `${name}: 行容器缺 data-cgui="usage-line" 锚点`);
  const titleAt = src.indexOf('title={`', at);
  assert.ok(titleAt > -1 && titleAt - at < 400, `${name}: 行容器 title 必须是无条件模板字符串`);
  const start = titleAt + 'title={`'.length;
  const end = src.indexOf('`}', start);
  assert.ok(end > -1, `${name}: title 模板未闭合`);
  return src.slice(start, end);
}

// 用夹具数字真求值(不是 grep 字面量):模板里的 ${…} 与组件里跑的是同一段代码。
// 求值输入是仓库自带源码文件(不是外部数据),与 check-r55-perm-sticky.mjs 同一手法。
function render(raw, vars) {
  const names = Object.keys(vars);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return \`${raw}\`;`)(...names.map((n) => vars[n]));
}

const FOOT = '（= 整轮 cache_read /（普通 input + cache_read + cache_creation），整轮所有 API 调用累计加权；切模型或进程冷启的那一轮偏低属正常。分母 0 显示 —）';
const cases = [
  ['BRIEF 实报那组', { input: 0, cacheRead: 34048, cacheWrite: 27517 },
    ['缓存命中 34,048 · 缓存写入 27,517', '本轮累计读取 61,565（= 输入 0 + 缓存命中 34,048 + 缓存写入 27,517；一轮里模型每次调用 API 都要重读整段上下文，累计读取量会大于单次上下文大小）', `整轮命中率 55.3%${FOOT}`]],
  ['缓存读写全 0(分母 0)', { input: 0, cacheRead: 0, cacheWrite: 0 },
    ['缓存命中 0 · 缓存写入 0', '本轮累计读取 0（= 输入 0 + 缓存命中 0 + 缓存写入 0；一轮里模型每次调用 API 都要重读整段上下文，累计读取量会大于单次上下文大小）', `整轮命中率 —${FOOT}`]],
  ['命中率 99.96%(不得显示 100.0%)', { input: 1, cacheRead: 2499, cacheWrite: 0 },
    ['缓存命中 2,499 · 缓存写入 0', '本轮累计读取 2,500（= 输入 1 + 缓存命中 2,499 + 缓存写入 0；一轮里模型每次调用 API 都要重读整段上下文，累计读取量会大于单次上下文大小）', `整轮命中率 99.96%${FOOT}`]],
];

for (const [name, src] of Object.entries(files)) {
  const raw = extractTitle(src, name);
  for (const [label, u, golden] of cases) {
    const denom = u.input + u.cacheRead + u.cacheWrite;
    const out = render(raw, {
      ...u,
      cacheHitPct, formatHitPct,
      turnDenominator: denom,
      turnHitPct: denom > 0 ? (u.cacheRead / denom) * 100 : 0,
      formatHitPctOrDash,
    });
    assert.deepEqual(out.split('\n'), golden, `${name} · ${label}: 悬停文案必须逐字等于 INTERFACE §H.2(实际 ${JSON.stringify(out)})`);
  }
  // 行内不得再出现这五项(黑名单按"可见文本"口径:去掉注释与悬停文案本身后再查)
  const visible = src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/title=\{`[\s\S]*?`\}/g, '');
  for (const word of ['缓存命中', '缓存写入', '整轮命中率', '实际输入', '本轮累计读取']) {
    assert.ok(!visible.includes(word), `${name}: 行内可见文本不得再出现「${word}」(必须只活在悬停文案里)`);
  }
  // 行内白名单:输入/输出仍在(金额由 check-r42-usage-source-tooltip.mjs 钉)
  assert.ok(visible.includes('输入 {input.toLocaleString()}'), `${name}: 行内容器仍要显示「输入 {n}」`);
  assert.ok(visible.includes('输出 {output.toLocaleString()}'), `${name}: 行内容器仍要显示「输出 {n}」`);
}

// 旧名全仓退场(§H.3):整个 client/src 不许再有这一串
{
  const { globSync } = await import('glob');
  const hits = globSync('client/src/**/*.{js,jsx}', { cwd: root }).filter((f) => readFileSync(join(root, f), 'utf8').includes('实际输入'));
  assert.deepEqual(hits, [], `旧名必须从 client/src 退场,命中: ${hits.join(', ')}`);
}

console.log('✓ check-r43-usage-line-tooltip: 悬停文案逐字 + 行内白/黑名单 + 旧名退场 全过');

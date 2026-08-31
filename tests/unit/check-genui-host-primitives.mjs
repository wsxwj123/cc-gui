#!/usr/bin/env node
// r64 M3:genui/host/primitives.jsx —— upstream/ 与宿主之间唯一的转手点,给上游
// advanced.tsx / fence-render.tsx 供四个宿主组件替身(PLAN §1.7、§2.2)。
// 纯函数(unifiedDiff)真 import 测行为;JSX 裸 node 加载不了,按仓内惯例走源码锁。
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { unifiedDiff } from '../../client/src/utils/unifiedDiff.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const HOST = 'client/src/genui/host/primitives.jsx';
const prim = read(HOST);

// ── 1. unifiedDiff:DiffBlock 拿它把 {path,oldText,newText} 拼成 DiffViewer 吃的文本 ──
{
  const d = unifiedDiff('/src/a.js', 'x\ny', 'x\nz').split('\n');
  assert.deepEqual(d.slice(0, 3), ['--- a/src/a.js', '+++ b/src/a.js', '@@'],
    '前两行必须是 ---/+++ 文件头(DiffViewer 只认前两行当文件头,再靠后就被染成增删行)');
  assert.deepEqual(d.slice(3), ['-x', '-y', '+x', '+z'], '旧文本整段 -、新文本整段 +');
  // 新建文件:genui 的 oldText 可以是 null,不能拼出一行孤零零的 `-`
  const add = unifiedDiff('a.js', null, 'hello').split('\n');
  assert.ok(!add.some((l) => l.startsWith('-') && !l.startsWith('---')), 'oldText 为 null 时不该有删除行');
  assert.ok(add.includes('+hello'), '新建文件的内容仍要作为新增行出现');
  // 删空文件的对称面
  assert.ok(unifiedDiff('a.js', 'bye', null).split('\n').includes('-bye'), 'newText 为 null 时旧内容仍要显示');
  // path 缺失(genui spec 里 path 是必填,但模型给空串照样要能渲染,不能拼出 `--- a/`)
  assert.ok(unifiedDiff('', 'a', 'b').startsWith('--- a/change'), 'path 为空回落到 label,不留空文件名');
  assert.ok(unifiedDiff('///x.js', 'a', 'b').startsWith('--- a/x.js'), '开头的斜杠要剥掉');
}

// ── 2. 四个替身:名字必须与上游 import 的完全一致(改名即静默 undefined) ──────────
const upstreamImports = [
  ['client/src/genui/upstream/blocks/advanced.tsx', ['CodeBlock', 'DiffBlock', 'JsonTree', 'writeClipboard']],
  ['client/src/genui/upstream/fence-render.tsx', ['CodeBlock']],
];
for (const [file, names] of upstreamImports) {
  const src = read(file);
  const line = src.split('\n').find((l) => /^\s*import\b/.test(l) && l.includes('host/primitives.jsx'));
  assert.ok(line, `${file} 必须从 host/primitives.jsx 取宿主件`);
  for (const n of names) {
    assert.ok(new RegExp(`\\b${n}\\b`).test(line), `${file} 引的是 ${n}`);
    assert.ok(new RegExp(`export (function|const) ${n}\\b|export \\{[^}]*\\b${n}\\b`).test(prim),
      `primitives.jsx 必须导出 ${n},名字对不上 = 运行时 undefined,React 会直接崩`);
  }
}

// ── 3. 各替身接的是方案点名的那个宿主实现 ────────────────────────────────────
assert.ok(/from '\.\.\/\.\.\/components\/CodeBlock\.jsx'/.test(prim),
  'CodeBlock 接抽出来的 components/CodeBlock.jsx(不是从 MarkdownRenderer 导出,那样会成环)');
assert.ok(/<DiffViewer diff=\{unifiedDiff\(/.test(prim), 'DiffBlock 走宿主 DiffViewer + unifiedDiff 适配');
assert.ok(/list\.map\(/.test(prim) && /<DiffViewer/.test(prim),
  '多个文件一个一个 DiffViewer(拼一起会让第二份起的文件头被染成增删行)');
assert.ok(/<CodeBlock lang="json"/.test(prim), 'json 节点按仓内惯例走代码块,不新造 JSON 树组件');
assert.ok(/export const writeClipboard = copyText/.test(prim),
  'clipboard 必须复用 utils/clipboard.js 的 copyText');
const primCode = prim.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // 去注释,只看真代码
assert.ok(!/navigator\.clipboard/.test(primCode),
  '不许直接用 navigator.clipboard:手机走明文 http 局域网时不是安全上下文,它是 undefined,复制会静默失效');

// ── 4. §2.0.1-2 目录规矩:upstream/ 下任何文件都不许直接 import components/ 或 utils/ ──
// 这条同时是断环的护栏:宿主件只能经 host/ 转手,upstream/ 自己伸手就又能兜回 MarkdownRenderer。
const specifiersOf = (src) => [...src.matchAll(/\bfrom\s+'(\.[^']+)'/g)].map((m) => m[1]);
const walkDir = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkDir(p, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(p);
  }
  return out;
};
for (const file of walkDir(join(root, 'client/src/genui/upstream'))) {
  for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
    const target = relative(join(root, 'client/src'), resolve(dirname(file), spec));
    assert.ok(!/^(components|utils|stores|hooks)\//.test(target),
      `${relative(root, file)} 直接 import 了 ${target} —— upstream/ 必须经 genui/host/ 拿宿主件(PLAN §2.0.1-2)`);
  }
}

// ── 5. 环真的断了:从 primitives.jsx 顺着本地 import 走,不能走回 MarkdownRenderer ──
// 这是抽 components/CodeBlock.jsx 的全部理由;走回去了 = M4 接上围栏后压缩产物会炸。
{
  const seen = new Set();
  const queue = [join(root, HOST)];
  const tryResolve = (p) => [p, `${p}.jsx`, `${p}.js`, `${p}.tsx`, `${p}.ts`, join(p, 'index.jsx'), join(p, 'index.js')]
    .find((c) => existsSync(c) && statSync(c).isFile());
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      const hit = tryResolve(resolve(dirname(file), spec));
      if (hit) queue.push(hit);
    }
  }
  const reached = [...seen].map((f) => relative(root, f));
  assert.ok(!reached.some((f) => f.endsWith('MarkdownRenderer.jsx')),
    `环没断:从 primitives.jsx 能走到 MarkdownRenderer.jsx(路径里有 ${reached.join(' , ')})`);
  assert.ok(reached.includes('client/src/components/CodeBlock.jsx'), '这条链应当确实经过抽出来的 CodeBlock.jsx');
}

console.log('✅ genui host 四个替身形态正确(名字对得上上游 / 各接既有宿主实现 / 无环 / 不许直连 navigator.clipboard)');

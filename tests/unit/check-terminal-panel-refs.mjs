#!/usr/bin/env node
// 终端面板(TerminalPanel.jsx)内部接线自测:JSX 进不了 node,只能读源码断言,所以每条都挑
// "改坏了必定断"的结构关系(两处真相是否同源、键是否按 id 分桶、错误码分流是否互斥),
// 不做字面复述。
//
// item1(阶段05 抽查 #1):activeIdRef 初值曾硬编码 't1',而标签 id 现在是 makeTabId() 生成的
// 高熵值、只有 goActive 会写这个 ref —— 面板已 live 时点代码块「运行」,onRun 读
// credsRef.get(activeIdRef.current) 取不到 generation,命令被 takePendingTerminalCommand()
// 取走后静默丢弃(FB-T24 只覆盖"面板未开"路径,覆盖不到这条)。
//
// 零网络、零配置、只读仓库文件。Run: node tests/unit/check-terminal-panel-refs.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const P = read('client/src/components/TerminalPanel.jsx');

let PASS = 0;
let FAILS = 0;
const failed = [];
function check(name, fn) {
  try {
    fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

console.log("\n[item1] activeIdRef 初值必须与 activeId 同源(硬编码 't1' 会与高熵标签 id 失步)");

const initExpr = (source, decl) => {
  const at = source.indexOf(decl);
  assert.ok(at > 0, `找不到 ${decl}`);
  const open = source.indexOf('(', at + decl.length);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i).trim();
    }
  }
  throw new Error(`${decl} 括号不闭合`);
};

check('activeIdRef 初值表达式与 useState(activeId) 初值逐字相同', () => {
  const stateInit = initExpr(P, 'const [activeId, setActiveId] = useState');
  const refInit = initExpr(P, 'const activeIdRef = useRef');
  assert.equal(refInit, stateInit,
    `activeIdRef 初值(${refInit})与 activeId 初值(${stateInit})不同源:事件回调读 ref,失步即取不到 generation`);
});

check('activeIdRef 的初始化排在 initialTabs() 之后(否则拿到 undefined)', () => {
  const tabsInit = P.indexOf('if (!initRef.current) initRef.current = initialTabs();');
  const refInit = P.indexOf('const activeIdRef = useRef(');
  assert.ok(tabsInit > 0, '找不到 initialTabs() 初始化分支');
  assert.ok(refInit > tabsInit, 'activeIdRef 在 initRef 赋值之前初始化,初值必为 undefined');
});

check('没有硬编码标签 id 的 ref 初值(t1/t2… 不是身份)', () => {
  assert.ok(!/useRef\(\s*['"]t\d*['"]\s*\)/.test(P), "出现 useRef('tN'):标签 id 是 makeTabId() 高熵值,硬编码值只在首个 goActive 之前短暂相等");
});

console.log('\n[item2] 未就绪键入必须按 tabId 分桶,退出后不回灌(全局单串会把 A 的输入送进 B 的 shell)');

const onData = (() => {
  const at = P.indexOf('term.onData(');
  const end = P.indexOf('term.onResize(', at);
  assert.ok(at > 0 && end > at, '找不到 term.onData 处理器');
  return P.slice(at, end);
})();

check('键入缓冲是 Map(pendingInputRef),不是全局字符串', () => {
  const init = initExpr(P, 'const pendingInputRef = useRef');
  assert.match(init, /new Map\(\)/, `pendingInputRef 必须是 Map(实为 ${init})——全局单串会把任意标签的键入送进下一个打开的 shell`);
  assert.ok(!/pendingInputRef\.current\s*\+=/.test(P), '出现字符串拼接式缓冲(= 全局单串)');
  assert.ok(!/pendingInputRef\.current\s*=\s*(['"]|$)/m.test(P), '出现整体覆盖/清空(= 全局单串)');
});

check('term-opened 只取本标签那一桶(m.id),不取别的标签的键入', () => {
  const at = P.indexOf("m.type === 'term-opened'");
  const end = P.indexOf("m.type === 'term-out'", at);
  assert.ok(at > 0 && end > at, '找不到 term-opened 分支');
  const branch = P.slice(at, end);
  assert.match(branch, /pendingInputRef\.current\.get\(m\.id\)/, 'term-opened 必须按 m.id 取缓冲');
  assert.match(branch, /pendingInputRef\.current\.delete\(m\.id\)/, '取走后必须删掉该桶,否则会重复落键入');
});

check('已退出标签的键入直接丢弃(不进缓冲,不会被打进「重新连接」后的新 shell)', () => {
  assert.match(onData, /exitedGensRef\.current\.has\(id\)/, 'term.onData 缺"已退出即丢弃"守卫(R03:退出后 shell 不再接受输入)');
  assert.match(onData, /pendingInputRef\.current\.set\(id,/, '未就绪键入必须按 id 入桶');
  const guard = onData.indexOf('exitedGensRef.current.has(id)');
  const buffered = onData.indexOf('pendingInputRef.current.set(id,');
  assert.ok(guard > 0 && buffered > guard, '丢弃守卫必须在入桶之前,否则退出后的键入仍会被攒下来');
});

console.log("\n[item3] TERM_TOKEN_REVOKED(分离期间自然退出)不得降级新建:服务端还留着只读退出记录");

const errBranch = (() => {
  const at = P.indexOf("m.type === 'term-error'");
  const end = P.indexOf('ws.onclose', at);
  assert.ok(at > 0 && end > at, '找不到 term-error 分支');
  return P.slice(at, end);
})();

check('降级新建的码表里不再含 TERM_TOKEN_REVOKED(它意味着"已退出且有记录")', () => {
  const m = errBranch.match(/if \(\[[^\]]*\]\.includes\(m\.code\)\s*&&\s*credsRef\.current\.has\(m\.id\)\)/);
  assert.ok(m, '找不到"凭据失效 → 降级新建"分支');
  assert.ok(!m[0].includes('TERM_TOKEN_REVOKED'),
    'TERM_TOKEN_REVOKED 混在降级新建里:新建会顶掉同 id 的只读退出记录,「重新连接」路径永远不可达');
});

check('TERM_TOKEN_REVOKED 走"退出态 + 记退出代际"分支,且不新建 shell', () => {
  const m = errBranch.match(/if \(m\.code === 'TERM_TOKEN_REVOKED'[\s\S]*?\n {10}\}/);
  assert.ok(m, '找不到 TERM_TOKEN_REVOKED 专用分支');
  assert.match(m[0], /exitedGensRef\.current\.set\(m\.id,/, '必须记住退出代际,「重新连接」才能发 term-restart');
  assert.match(m[0], /exited: true/, '必须把标签标成退出态(否则「重新连接」按钮不出现)');
  assert.ok(!/term-open/.test(m[0]), '该分支不得发 term-open:会用同 id 覆盖服务端只读退出记录');
});

check('退出记录的只读归属:重新连接走 term-restart(带已退出代际)', () => {
  assert.match(P, /type: 'term-restart', id, generation: exitedGen/, '「重新连接」必须发 term-restart 并带上已退出代际');
});

console.log(`\n—— check-terminal-panel-refs: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-terminal-panel-refs: 面板内部接线自洽');

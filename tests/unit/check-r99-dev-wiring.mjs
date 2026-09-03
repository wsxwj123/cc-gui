// r99 开发自测(App.jsx 接线):源码锁 + 计数锁 + 既有行为回归锁。
// 契约见 .devflow/INTERFACE-r99.md §4。零网络、零文件写入。
// 跑法:node tests/unit/check-r99-dev-wiring.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const A = readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
const count = (s, re) => (s.match(re) || []).length;

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try { fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); }
};

// ---- §4.2 必须出现 ----
t('4.2 import 纯函数模块', () => {
  assert.match(A, /from '\.\/utils\/contentRisk\.js'/);
  const line = A.split('\n').find((l) => l.includes("./utils/contentRisk.js"));
  for (const n of ['classifyUpstreamRefusal', 'lastUserIndex', 'locateRiskAnchor']) {
    assert.ok(line.includes(n), `import 缺 ${n}`);
  }
});
t('4.2 错误分支打标', () => {
  assert.match(A, /const risk = classifyUpstreamRefusal\(msg\)/);
  assert.match(A, /errorAction: 'content-risk'/);
  assert.match(A, /msg\.errorAction === 'content-risk'/);
});
t('4.2 三元链里 content-risk 排在 isAuthError 之前(M15)', () => {
  const i = A.indexOf("risk ? { errorAction: 'content-risk' }");
  const j = A.indexOf('isAuthError ?');
  assert.ok(i > 0 && j > 0 && i < j, `content-risk@${i} 必须排在 isAuthError@${j} 之前`);
});
t('4.2 两个新回调存在', () => {
  assert.match(A, /const runContentRiskRewind = useCallback/);
  assert.match(A, /const newSessionWithLastUser = useCallback/);
});
t('4.2 按钮文案逐字 + 提示文案关键词', () => {
  assert.match(A, /回退到上一条工具输出之前并重发/);
  assert.match(A, /回退到上一条消息之前并重新编辑/);
  assert.match(A, /新开会话/);
  assert.match(A, /内容审核/);
  assert.match(A, /每一轮/);
});
t('4.2 主动作走应用内确认框(danger)', () => {
  const blk = A.slice(A.indexOf('const runContentRiskRewind = useCallback'), A.indexOf('const newSessionWithLastUser = useCallback'));
  assert.match(blk, /await confirmDialog\(/);
  assert.match(blk, /\{ danger: true \}/);
});
t('4.2 主动作复用既有链路,不自写 fetch', () => {
  const blk = A.slice(A.indexOf('const runContentRiskRewind = useCallback'), A.indexOf('const newSessionWithLastUser = useCallback'));
  assert.match(blk, /handleRetryToolRef\.current\?\.\(/);
  assert.match(blk, /contentRisk: true/);
  assert.equal(count(blk, /fetch\(/g), 0, '新回调里不许自写 fetch');
});
t('4.2 退化路径复用既有「重新编辑」', () => {
  assert.match(A, /handleRollbackRef\.current\?\.\([^)]*\{ mode: 'edit' \}/);
});
t('4.2 新开会话三件套带 targetKey(M17)', () => {
  const blk = A.slice(A.indexOf('const newSessionWithLastUser = useCallback'), A.indexOf('const contentRiskAnchor = useMemo'));
  assert.match(blk, /newDraftId\(\)/);
  assert.match(blk, /queueKeyFor\(\{ projectHash/);
  assert.match(blk, /cgui:composer-fill/);
  assert.match(blk, /detail: \{ text: carry, targetKey \}/);
});
t('4.2 两个新回调不装 window 监听、不写全局单值(每窗格隔离)', () => {
  const blk = A.slice(A.indexOf('const runContentRiskRewind = useCallback'), A.indexOf('const contentRiskAnchor = useMemo'));
  assert.equal(count(blk, /window\.addEventListener/g), 0);
});
t('4.2 主动作块内不出现压缩(M11)', () => {
  const blk = A.slice(A.indexOf('const runContentRiskRewind = useCallback'), A.indexOf('const newSessionWithLastUser = useCallback'));
  assert.equal(count(blk, /summarize-after|summarize-before|compact-segment/g), 0);
});
t('4.2 全文件无原生弹窗调用(M14;Tauri 禁用 window.confirm/alert)', () => {
  assert.equal(count(A, /window\.confirm\(/g), 0);
  assert.equal(count(A, /window\.alert\(/g), 0);
  assert.equal(count(A, /(?<![.\w])alert\(/g), 0);
});

// ---- §4.3 计数锁 ----
const COUNTS = [
  ['errorAction', 6], ['trim-before-tool', 1], ['compact-segment', 2],
  ['cgui:composer-fill', 5], ['newDraftId()', 9], ['handleRetryTool', 8],
];
for (const [tok, want] of COUNTS) {
  t(`4.3 计数锁 ${tok} === ${want}`, () => {
    const n = A.split(tok).length - 1;
    assert.equal(n, want);
  });
}
t('4.3 confirmDialog 60~61', () => {
  const n = A.split('confirmDialog').length - 1;
  assert.ok(n >= 60 && n <= 61, `实际 ${n}`);
});
// 注:INTERFACE §4.2 写「window.confirm 0 次」,但改前基线就有 1 次(2973 行的注释
// "不用 window.confirm")。这里锁「调用点 0 次 + 注释仍在」,口径比字面锁更准。
t('4.3 window.confirm 仅存注释一处(基线既有,非本轮引入)', () => {
  assert.equal(count(A, /window\.confirm/g), 1);
  assert.equal(count(A, /window\.confirm\(/g), 0);
});

// ---- §4.4 既有行为回归锁 ----
t('4.4 「工具重做」原文案与隐藏重发逐字仍在(M18)', () => {
  assert.match(A, /请重新执行 \$\{toolCall\.name\} 工具调用/);
  assert.match(A, /<cgui-tool-retry tool=/);
  assert.match(A, /hiddenUserMessage: true/);
});
t('4.4 handleRetryTool 第三参有默认值(既有两个调用点零改动)', () => {
  assert.match(A, /const handleRetryTool = useCallback\(\(turn, toolCall, opts = \{\}\) =>/);
  assert.match(A, /const stableRetryTool = useCallback\(\(turn, toolCall\) => handleRetryToolRef\.current\?\.\(turn, toolCall\), \[\]\)/);
});
t('4.4 乐观截断仍在', () => {
  assert.ok(count(A, /_retryTrimToolId/g) >= 2);
  assert.match(A, /setRetryActiveUuid\(turn\.uuid\)/);
});
t('4.4 停流三件套逐字仍在', () => {
  assert.match(A, /stoppedPidsRef\.current\.add\(String\(_rtPid\)\)/);
  assert.match(A, /hard: true/);
  assert.match(A, /backgroundPidRef\.current = null/);
});
t('4.4 既有两个 errorAction 块逐字仍在', () => {
  assert.match(A, /msg\.errorAction === 'provider' && !mobileChrome/);
  assert.match(A, /msg\.errorAction === 'repair-official' && selectedSession\?\.sessionId/);
});
t('4.4 错误分支其它自愈判据逐字不变', () => {
  assert.match(A, /usage credits required for 1m context/);
  assert.match(A, /invalid signature in thinking/);
  assert.match(A, /No conversation found/);
  assert.match(A, /payload too large/);
});
t('4.4 handleRollback 签名逐字不变', () => {
  assert.match(A, /const handleRollback = useCallback\(async \(msg, \{ mode, resendText = null, softFiles = false \} = \{\}\) =>/);
});

// ---- TDZ 守卫(memory: cross-component-undefined-ref-whitescreen) ----
t('新回调声明在其引用的 ref 声明之后(防 TDZ 白屏)', () => {
  assert.ok(A.indexOf('const handleRetryToolRef = useRef') < A.indexOf('const runContentRiskRewind = useCallback'));
  assert.ok(A.indexOf('const handleRollbackRef = useRef') < A.indexOf('const runContentRiskRewind = useCallback'));
});
t('渲染块引用的三个标识符都在同一组件内先声明', () => {
  for (const id of ['runContentRiskRewind', 'newSessionWithLastUser', 'contentRiskAnchor']) {
    assert.ok(A.indexOf(`const ${id} = `) < A.indexOf(`{contentRiskAnchor ? '回退到上一条工具输出之前并重发'`) || id !== 'contentRiskAnchor');
    assert.ok(A.indexOf(`const ${id} = `) > 0, `${id} 未声明`);
  }
});

console.log(`\n[check-r99-dev-wiring] ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }

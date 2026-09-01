#!/usr/bin/env node
// r69:导出功能的**接线审计**。
//
// 为什么是源码锁而不是行为测试:接线点在 render-node.tsx / ExportToolbar.jsx,
// 裸 node 加载不了 .tsx/.jsx(ERR_UNKNOWN_FILE_EXTENSION,与语法无关),
// 走仓内既有惯例(check-genui-fence-render / check-codeblock-extract 同款)。
// 行为面由纯逻辑测(check-genui-export-data)与浏览器真机验证覆盖。
//
// 锁三件事:
//   ① 工具条只包**可导出的六类**,而且包与不包的判据是 export-data 那一个函数
//      —— 判据散成两份(比如这里再写一遍 type 列表)就一定会漂。
//   ② 包装不能破坏 `el === null` 那条既有判据(ActionFeedback 靠它决定要不要挂徽章)。
//   ③ **零外发**:导出四个模块不许沾 action/send 面,唯一允许的网络端点是落盘用的
//      /api/export-file。导出是纯本地动作,任何一个字节流进对话都是越界。
//
// 变异哨兵(改坏 → 本测必红):
//   A. render-node.tsx 去掉 `isExportable(node) &&` 门 → ① 红。
//   B. ExportToolbar.jsx 加一行 `import { sendAction } from '../upstream/action-send.ts'` → ③ 红。
//   C. export-save.js 把落盘端点改成 /api/chat → ③ 的端点白名单红。
// Run: node tests/unit/check-genui-export-wiring.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isExportable } from '../../client/src/genui/host/export-data.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL -', name, '::', e.message); } };

const EXPORT_MODULES = [
  'client/src/genui/host/export-data.js',
  'client/src/genui/host/export-image.js',
  'client/src/genui/host/export-save.js',
  'client/src/genui/host/ExportToolbar.jsx',
];

/* ---------------- ① 接线点唯一,判据唯一 ---------------- */

const renderNode = read('client/src/genui/upstream/blocks/render-node.tsx');

t('render-node 从 export-data 取判据(不另写一份类型列表)', () => {
  assert.match(renderNode, /import \{ isExportable \} from '\.\.\/\.\.\/host\/export-data\.js'/);
  assert.match(renderNode, /import \{ GenuiExportFrame \} from '\.\.\/\.\.\/host\/ExportToolbar\.jsx'/);
});
t('工具条只在 isExportable 为真时包一层', () => {
  assert.match(renderNode, /isExportable\(node\)\s*\n?\s*\?\s*<GenuiExportFrame/);
});
t('接线点唯一:GenuiExportFrame 全仓只在 render-node 里被使用', () => {
  const users = ['client/src/genui/upstream/blocks/advanced.tsx', 'client/src/genui/upstream/blocks/charts.tsx',
    'client/src/genui/upstream/blocks/basic.tsx', 'client/src/genui/upstream/blocks/forms.tsx',
    'client/src/genui/upstream/GenuiBlock.tsx', 'client/src/genui/upstream/fence-render.tsx',
    'client/src/genui/upstream/EChartNode.tsx']
    .filter((p) => read(p).includes('GenuiExportFrame'));
  assert.deepEqual(users, [], `不该出现第二个包装点:${users.join(', ')}`);
});

/* ---------------- ② 不破坏 el === null 判据 ---------------- */

t('包装前先判 inner !== null(空节点不能被包成非空元素)', () => {
  assert.match(renderNode, /inner\s*!==\s*null\s*&&\s*isExportable\(node\)/);
});
t('ActionFeedback 那条 el === null 判据还在', () => {
  assert.match(renderNode, /if \(el === null \|\| onAction === undefined/);
});

/* ---------------- ③ 零外发 ---------------- */

// import 面:逐模块拆出所有 import 源,和禁列表对撞。
const importSources = (src) => [...src.matchAll(/(?:^|\n)\s*import[^;\n]*?from\s*'([^']+)'/g)].map((m) => m[1])
  .concat([...src.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));

const FORBIDDEN = ['action-context', 'action-send', 'action-fold', 'action-guard', 'action-debounce', 'interaction-store'];
for (const p of EXPORT_MODULES) {
  const src = read(p);
  t(`${p}:import 面不含 action/send`, () => {
    const bad = importSources(src).filter((s) => FORBIDDEN.some((f) => s.includes(f)));
    assert.deepEqual(bad, [], `导出模块不许依赖发送面:${bad.join(', ')}`);
  });
  t(`${p}:源码不出现发送动作`, () => {
    for (const banned of ['onAction', 'enqueue', 'buildActionText', 'assertSendable', 'queueKey']) {
      assert.ok(!new RegExp(`\\b${banned}\\b`).test(src), `出现了发送面标识:${banned}`);
    }
  });
}

t('导出模块只碰一个网络端点:/api/export-file', () => {
  const urls = EXPORT_MODULES.flatMap((p) => [...read(p).matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(urls)], ['/api/export-file'], `实得 ${JSON.stringify(urls)}`);
});
t('PNG 的 base64 解码不走 fetch(连"像在发请求"都不要)', () => {
  const img = read('client/src/genui/host/export-image.js');
  assert.ok(img.includes('atob('), '应当手工解码 base64');
  assert.ok(!/fetch\(/.test(img), 'export-image 不该出现 fetch');
});

/* ---------------- 工具条形态 ---------------- */

const toolbar = read('client/src/genui/host/ExportToolbar.jsx');
for (const tid of ['genui-export-toolbar', 'genui-export-copy', 'genui-export-csv', 'genui-export-png']) {
  t(`工具条挂了稳定锚 ${tid}`, () => assert.ok(toolbar.includes(`"${tid}"`), `缺 data-testid ${tid}`));
}
t('CSV / PNG 按钮按 plan 出现,不是恒显', () => {
  assert.match(toolbar, /\{plan\.csv &&/);
  assert.match(toolbar, /\{plan\.png &&/);
});
t('窄屏常显(<768px 没有 hover,不常显就永远点不到)', () => {
  assert.ok(toolbar.includes('max-md:opacity-100'), '缺窄屏常显规则');
  assert.ok(toolbar.includes('max-md:pointer-events-auto'), '窄屏可见但不可点等于没有');
});
t('文案是客观陈述(逐字锁四条)', () => {
  for (const s of ['复制数据', '复制源码', '下载 CSV', '导出 PNG']) {
    assert.ok(toolbar.includes(s) || read('client/src/genui/host/export-data.js').includes(s), `缺文案:${s}`);
  }
});

/* ---------------- 判据自洽:六类进、其余不进 ---------------- */

for (const type of ['chart', 'echart', 'plot', 'table', 'mermaid', 'diagram']) {
  t(`${type} 进工具条`, () => assert.equal(isExportable(sample(type)), true));
}
function sample(type) {
  return {
    chart: { type: 'chart', data: [] },
    echart: { type: 'echart', preset: 'bar', data: [] },
    plot: { type: 'plot', series: [] },
    table: { type: 'table', columns: ['A'], rows: [] },
    mermaid: { type: 'mermaid', code: 'graph TD;A-->B' },
    diagram: { type: 'diagram', kind: 'flow', nodes: [] },
  }[type];
}

/* ---------------- 后端端点门禁 ---------------- */

const sessions = read('server/routes/sessions.js');
t('/api/export-file 扩展名白名单恰好 png/csv/json', () => {
  const m = /const EXPORT_EXTS = \[([^\]]+)\]/.exec(sessions);
  assert.ok(m !== null, '找不到 EXPORT_EXTS');
  assert.deepEqual(m[1].match(/'[^']+'/g), ["'png'", "'csv'", "'json'"]);
});
t('/api/export-file 与 /api/export-session 用同一套路径门禁', () => {
  const seg = sessions.slice(sessions.indexOf("router.post('/export-file'"));
  assert.ok(seg.includes('isLocalReq(req)'), '缺本机判据');
  assert.ok(seg.includes('resolveUnderHome'), '局域网侧缺 $HOME 门禁');
  assert.ok(seg.includes("s === '.' || s === '..'"), '缺路径穿透拒绝');
});

console.log(`\n[check-genui-export-wiring] pass ${pass} / fail ${fail}`);
process.exit(fail ? 1 : 0);

// r99 开发自测(纯函数):client/src/utils/contentRisk.js 的识别与锚点定位。
// 契约见 .devflow/INTERFACE-r99.md §1。零网络、零文件写入。
// 跑法:node tests/unit/check-r99-dev-pure.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'client/src/utils/contentRisk.js');

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try { fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); }
};

// 动态 import:改前文件不存在 / 缺导出时,静态 import 会在链接阶段整体抛,看不出缺哪几件。
let M = null;
let importErr = null;
try { M = await import(path.join(ROOT, 'client/src/utils/contentRisk.js')); }
catch (e) { importErr = e; }

t('R1 模块可被 node 直接 import', () => {
  assert.equal(importErr, null, String(importErr && importErr.message));
});

if (M) {
  const { classifyUpstreamRefusal, lastUserIndex, locateRiskAnchor, RISK_CONTINUE_PROMPT } = M;

  t('四个导出齐全', () => {
    assert.equal(typeof classifyUpstreamRefusal, 'function');
    assert.equal(typeof lastUserIndex, 'function');
    assert.equal(typeof locateRiskAnchor, 'function');
    assert.equal(typeof RISK_CONTINUE_PROMPT, 'string');
  });

  // ---- §1.1 classifyUpstreamRefusal 正例 ----
  const POS = [
    'API Error: 400 Content Exists Risk',
    'Content Exists Risk',
    'content exists risk',
    'CONTENT EXISTS RISK',
    'API Error: 400 {"error":{"message":"Content Exists Risk","type":"invalid_request_error"}}',
    'API Error: 429 Content  Exists\tRisk',
  ];
  for (const s of POS) {
    t(`正例命中 ${JSON.stringify(s).slice(0, 46)}`, () => {
      assert.deepEqual(classifyUpstreamRefusal(s), { kind: 'content-risk', vendor: 'deepseek' });
    });
  }

  // ---- §1.1 反例 ----
  const NEG = [
    ['', '空串'], [null, 'null'], [undefined, 'undefined'], [0, '数字 0'],
    [{}, '对象'], [[], '数组'],
    ['API Error: 400 Bad Request', '普通 400'],
    ['API Error: 429 Too Many Requests', '限流'],
    ['API Error: 401 Unauthorized', '鉴权'],
    ['API Error: 400 prompt is too long: 131072 tokens > 65536 maximum', '超窗'],
    ['API Error: 400 messages.5.content.0: text content blocks must be non-empty', '空内容块'],
    ['400 Invalid signature in thinking block', '签名'],
    ['No conversation found with session ID: abc', '会话失效'],
    ['The content of this risk assessment exists in the report', '三词不成短语'],
    ['系统检测到输入或生成内容可能包含不安全或敏感内容', 'GLM 疑似(未证实,必须不命中)'],
    ['The request was rejected because it was considered high risk', 'Kimi 疑似(未证实)'],
    ['DataInspectionFailed', '通义疑似(未证实)'],
    ['content_filter', 'Azure 疑似(未证实)'],
  ];
  for (const [v, label] of NEG) {
    t(`反例不命中:${label}`, () => { assert.equal(classifyUpstreamRefusal(v), null); });
  }

  // ---- §1.2 lastUserIndex ----
  const U = (uuid, text) => ({ type: 'user', uuid, text, timestamp: '2026-09-03T00:00:00.000Z' });
  const TC = (id, name, input, result) => ({ id, name, input, result, category: 'x' });
  const T = (uuid, toolCalls) => ({ type: 'turn', uuid, text: [], thinking: [], toolCalls, blocks: [] });

  t('lastUserIndex 非数组/空 → -1', () => {
    for (const v of [null, undefined, 'x', {}, []]) assert.equal(lastUserIndex(v), -1);
  });
  t('lastUserIndex 只有 turn → -1', () => {
    assert.equal(lastUserIndex([T('t1', []), T('t2', [])]), -1);
  });
  t('lastUserIndex 取最后一条(不是第一条)', () => {
    assert.equal(lastUserIndex([U('u1', 'a'), T('t1', []), U('u2', 'b'), T('t2', [])]), 2);
  });
  t('lastUserIndex 跳过 null / 非对象项', () => {
    assert.equal(lastUserIndex([U('u1', 'a'), null, 7, 'x']), 0);
  });
  t('lastUserIndex 跳过纯空白 text', () => {
    assert.equal(lastUserIndex([U('u1', 'a'), U('u2', ''), U('u3', '   \n ')]), 0);
  });
  t('lastUserIndex 跳过非字符串 text', () => {
    assert.equal(lastUserIndex([U('u1', 'a'), U('u2', undefined), U('u3', ['x'])]), 0);
  });
  t('lastUserIndex 跳过 compact/goal/denial', () => {
    assert.equal(lastUserIndex([U('u1', 'a'), { type: 'compact' }, { type: 'goal', text: 'g' }, { type: 'denial', text: 'd' }]), 0);
  });

  // ---- §1.3 locateRiskAnchor ----
  const base = [
    U('u1', '读一下配置'),
    T('t1', [TC('toolA', 'Read', { file_path: '/a' }, 'ok-a'),
             TC('toolB', 'Bash', { command: "sed -n '355,412p' clash.yaml" }, '节点名…')]),
  ];

  t('locateRiskAnchor 非数组/空 → null', () => {
    for (const v of [null, undefined, 'x', []]) assert.equal(locateRiskAnchor(v), null);
  });
  t('locateRiskAnchor 只有用户消息 → null', () => {
    assert.equal(locateRiskAnchor([U('u1', 'a'), U('u2', 'b')]), null);
  });
  t('locateRiskAnchor toolCalls 为空/缺失/非数组 → null', () => {
    assert.equal(locateRiskAnchor([U('u1', 'a'), T('t1', [])]), null);
    assert.equal(locateRiskAnchor([U('u1', 'a'), { type: 'turn', uuid: 't1' }]), null);
    assert.equal(locateRiskAnchor([U('u1', 'a'), { type: 'turn', uuid: 't1', toolCalls: 'nope' }]), null);
  });
  t('locateRiskAnchor 全部 result==null(悬挂工具) → null', () => {
    assert.equal(locateRiskAnchor([U('u1', 'a'), T('t1', [TC('x', 'Bash', {}, null)])]), null);
  });
  t('locateRiskAnchor base → toolB / turnIndex 1 / carryText 空', () => {
    const a = locateRiskAnchor(base);
    assert.equal(a.turnIndex, 1);
    assert.equal(a.turnUuid, 't1');
    assert.equal(a.toolUseId, 'toolB');
    assert.equal(a.toolName, 'Bash');
    assert.equal(a.carryText, '');
    assert.deepEqual(a.toolInput, { command: "sed -n '355,412p' clash.yaml" });
  });
  t('locateRiskAnchor 跳过悬挂工具,退到 toolA', () => {
    const m = [base[0], T('t1', [TC('toolA', 'Read', { file_path: '/a' }, 'ok-a'), TC('toolB', 'Bash', {}, null)])];
    assert.equal(locateRiskAnchor(m).toolUseId, 'toolA');
  });
  t('locateRiskAnchor 空 toolCalls 的后续 turn 不作锚点', () => {
    assert.equal(locateRiskAnchor([...base, T('t2', [])]).turnUuid, 't1');
  });
  t('locateRiskAnchor 锚点在最后 → carryText 为空', () => {
    const a = locateRiskAnchor([...base, U('u2', '再看看'), T('t2', [TC('toolC', 'Read', {}, 'ok')])]);
    assert.equal(a.turnUuid, 't2');
    assert.equal(a.toolUseId, 'toolC');
    assert.equal(a.carryText, '');
  });
  t('locateRiskAnchor 锚点之后有两条用户消息 → 捞最后一条', () => {
    const a = locateRiskAnchor([...base, U('u2', '继续'), U('u3', '还是不行')]);
    assert.equal(a.turnUuid, 't1');
    assert.equal(a.toolUseId, 'toolB');
    assert.equal(a.carryText, '还是不行');
  });
  t('locateRiskAnchor 锚点之后一条用户消息', () => {
    assert.equal(locateRiskAnchor([...base, U('u2', '继续')]).carryText, '继续');
  });
  t('locateRiskAnchor toolCall 缺 id / 缺 name 不作锚点', () => {
    assert.equal(locateRiskAnchor([U('u1', 'a'), T('t1', [{ name: 'Bash', input: {}, result: 'r' }])]), null);
    assert.equal(locateRiskAnchor([U('u1', 'a'), T('t1', [{ id: 'x', input: {}, result: 'r' }])]), null);
  });
  t('locateRiskAnchor 同 turn 多个有 result 的工具取最后一个', () => {
    assert.equal(locateRiskAnchor(base).toolUseId, 'toolB');
  });
  t('不变式:turnIndex 指向的消息 uuid === turnUuid,carryText 恒为字符串', () => {
    for (const m of [base, [...base, U('u2', '继续')], [...base, T('t2', [TC('c', 'Read', {}, 'ok')])]]) {
      const a = locateRiskAnchor(m);
      assert.equal(m[a.turnIndex].uuid, a.turnUuid);
      assert.equal(typeof a.carryText, 'string');
    }
  });

  // ---- §1.4 RISK_CONTINUE_PROMPT ----
  t('续跑指令:长度 > 20 且禁止复读污染源', () => {
    assert.ok(RISK_CONTINUE_PROMPT.length > 20);
    assert.match(RISK_CONTINUE_PROMPT, /不要重新执行/);
    assert.match(RISK_CONTINUE_PROMPT, /不要重新读取/);
    assert.doesNotMatch(RISK_CONTINUE_PROMPT, /请重新执行/);
  });
}

// ---- §4.1 源码锁 ----
let C = '';
try { C = readFileSync(SRC, 'utf8'); } catch {}
const count = (s, re) => (s.match(re) || []).length;

t('4.1 四个 export 逐字在源码里', () => {
  assert.match(C, /export function classifyUpstreamRefusal/);
  assert.match(C, /export function lastUserIndex/);
  assert.match(C, /export function locateRiskAnchor/);
  assert.match(C, /export const RISK_CONTINUE_PROMPT/);
});
t('4.1 形态表是数组,且只收录一个 vendor', () => {
  assert.match(C, /REFUSAL_PATTERNS\s*=\s*\[/);
  assert.equal(count(C, /vendor:/g), 1);
});
t('4.1 正则语义正确', () => {
  assert.ok(/content[^\n]*exists[^\n]*risk/i.test(C));
});
t('4.1 零依赖:无 import / 无浏览器全局', () => {
  assert.equal(count(C, /^import /gm), 0);
  for (const g of [/\bwindow\b/g, /\bdocument\b/g, /\bfetch\b/g, /\blocalStorage\b/g]) {
    assert.equal(count(C, g), 0, String(g));
  }
});
t('4.1 未证实文案一条都不许进代码', () => {
  assert.doesNotMatch(C, /1301|content_filter|DataInspectionFailed|high risk/);
});

console.log(`\n[check-r99-dev-pure] ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }

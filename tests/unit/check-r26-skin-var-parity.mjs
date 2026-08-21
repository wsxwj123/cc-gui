#!/usr/bin/env node
// r26-D11【单测】:FOUC 缓存重放补值文法校验——客户端 validateSkinVarClient 与服务端
// validateSkinVar 纯函数部分同口径(跨文件矩阵钉死),bootReplaySkin 重放不再旁路文法闸。
//   ① parity 矩阵:42 白名单 token × {合法值, url(x), var(, red;, }, \, /*, @, 超长,
//     非字符串, 空串} 两侧 {ok/reason} 全等(旁路哨兵);
//   ② bootReplay 哨兵:缓存 manifest 含 url(javascript:alert(1)) 值 → 该变量不进
//     appliedVars、不上 style;同 manifest 的合法变量照常应用(不误伤)。
// Run: node tests/unit/check-r26-skin-var-parity.mjs
import assert from 'node:assert/strict';

// ── 最小 DOM/localStorage shim(style 带记录) ──
const styleMap = new Map();
const de = {
  attrs: { 'data-theme': 'light' },
  getAttributeNames() { return Object.keys(this.attrs); },
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
  setAttribute(k, v) { this.attrs[k] = String(v); },
  removeAttribute(k) { delete this.attrs[k]; },
  style: {
    setProperty(k, v) { styleMap.set(k, v); },
    removeProperty(k) { styleMap.delete(k); },
  },
};
globalThis.document = {
  head: { children: [], appendChild(n) { this.children.push(n); } },
  documentElement: de,
  createElement(tag) { return { tagName: tag, attrs: {}, setAttribute() {}, remove() {} }; },
  querySelectorAll() { return []; },
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const lsMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: (k) => lsMap.delete(k),
};

const {
  SKIN_TOKENS_CLIENT, validateSkinVarClient, expandSkin, bootReplaySkin, getSkinState, clearSkinDom,
} = await import('../../client/src/utils/skins.js');
const { SKIN_TOKENS, validateSkinVar } = await import('../../server/utils/skin-validate.js');

// ① parity 矩阵:全量 token × 值形态,两侧判定逐字全等
{
  assert.equal(SKIN_TOKENS_CLIENT.length, 42, '① 夹具:白名单 42 token(哨兵锚)');
  const validFor = (t) => {
    if (t.startsWith('--color-') || t.startsWith('--glass-')) return '#aabbcc';
    if (t.startsWith('--radius-')) return '9px';
    if (t.startsWith('--shadow-')) return '0 1px 2px #000000';
    if (t.startsWith('--backdrop-')) return 'blur(8px)';
    return 'x';
  };
  const valueCases = (t) => [
    validFor(t),                       // 合法值
    'url(x)',                          // 黑名单:url(
    'var(--x)',                        // 黑名单:var(
    'red;',                            // 黑名单:;
    'red}',                            // 黑名单:}
    'a\\b',                            // 黑名单:反斜杠
    '/*x*/',                           // 黑名单:/*
    '@media',                          // 黑名单:@
    'url(javascript:alert(1))',        // 注入形态(PLAN 点名)
    `${validFor(t)} `.repeat(40),      // 超长
    123,                               // 非字符串
    '',                                // 空串
    ' #AABBCC ',                       // 首尾空白(合法,两侧同 trim 口径)
  ];
  let compared = 0;
  for (const t of SKIN_TOKENS) {
    for (const v of valueCases(t)) {
      const server = validateSkinVar(t, v);
      const client = validateSkinVarClient(t, v);
      assert.deepEqual(client, server,
        `① parity:${t} × ${JSON.stringify(typeof v === 'string' ? v.slice(0, 30) : v)} 两侧判定必须全等`);
      compared++;
    }
  }
  assert.ok(compared >= 42 * 10, `① 矩阵规模(实际 ${compared})`);
}

// ② bootReplay 哨兵:篡改缓存的注入值被挡,合法值照常
{
  clearSkinDom();
  styleMap.clear();
  const id = 'cached-skin-t1';
  const manifest = {
    format: 'cgui-skin/1', name: 'cached', tier: 1,
    light: { vars: { '--color-accent': 'url(javascript:alert(1))', '--color-ink': '#222222' } },
  };
  lsMap.set('cgui-skin-id', id);
  lsMap.set('cgui-skin-cache', JSON.stringify({ id, manifest }));
  bootReplaySkin();
  assert.equal(getSkinState().appliedVars.includes('--color-accent'), false,
    '② url(javascript:…) 注入值不进 appliedVars(修前旁路文法闸直接 setProperty)');
  assert.equal(styleMap.has('--color-accent'), false, '② 注入值不上 style');
  assert.equal(styleMap.get('--color-ink'), '#222222', '② 同 manifest 合法变量照常应用(不误伤)');
  // expandSkin 直验:同一 manifest 展开结果也不含注入值
  const ex = expandSkin(manifest, 'light');
  assert.ok(!('--color-accent' in ex.vars), '② expandSkin 展开层同样挡注入');
  assert.equal(ex.vars['--color-ink'], '#222222', '② expandSkin 合法变量保留');
  clearSkinDom();
}

console.log('PASS check-r26-skin-var-parity');

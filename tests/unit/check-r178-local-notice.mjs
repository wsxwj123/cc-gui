#!/usr/bin/env node
// r178:本地提示(报错块 / 空回复提示 / 花费上限)不再被「整轮已存盘 → 整清」清掉。
// 纯函数白盒(client/src/utils/localNotice.js)+ App.jsx 源码文本锁。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  isLocalNotice, isLocalOnlyEntry, LOCAL_NOTICE_KINDS,
} from '../../client/src/utils/localNotice.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(path.join(here, '../../client/src/App.jsx'), 'utf8');

let n = 0;
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { console.error(`FAIL ${name}`); throw e; }
};

// ── isLocalNotice ──
t('三种标记都认', () => {
  assert.deepEqual(LOCAL_NOTICE_KINDS, ['error', 'empty', 'budget']);
  for (const k of LOCAL_NOTICE_KINDS) assert.equal(isLocalNotice({ type: 'turn', localNotice: k }), true);
});
t('回合但无标记 → 否', () => assert.equal(isLocalNotice({ type: 'turn', text: ['❌ x'] }), false));
t('未知标记 → 否', () => assert.equal(isLocalNotice({ type: 'turn', localNotice: 'other' }), false));
t('非回合类带标记 → 否', () => assert.equal(isLocalNotice({ type: 'user', localNotice: 'error' }), false));
t('空值 → 否', () => { assert.equal(isLocalNotice(null), false); assert.equal(isLocalNotice(undefined), false); });

// ── isLocalOnlyEntry ──
t('旁问 / 自动拒绝 / 模式提示 → 是', () => {
  for (const type of ['btw', 'denial', 'mode-mismatch']) assert.equal(isLocalOnlyEntry({ type }), true);
});
t('本地提示 → 是', () => assert.equal(isLocalOnlyEntry({ type: 'turn', localNotice: 'empty' }), true));
t('普通回合 / 用户消息 → 否', () => {
  assert.equal(isLocalOnlyEntry({ type: 'turn' }), false);
  assert.equal(isLocalOnlyEntry({ type: 'user', text: 'hi' }), false);
});
t('空值 → 否', () => assert.equal(isLocalOnlyEntry(null), false));

// ── App.jsx 源码文本锁 ──
const count = (re) => (APP.match(re) || []).length;
t('从 localNotice.js 引入 isLocalOnlyEntry', () => {
  assert.match(APP, /import \{[^}]*\bisLocalOnlyEntry\b[^}]*\} from '\.\/utils\/localNotice\.js';/);
});
t('三处整清都调用 isLocalOnlyEntry,旧的三连类型判断不再出现', () => {
  // (b) 发送收尾「整轮已存盘」
  assert.match(APP, /const localOnly = \(m\) => isLocalOnlyEntry\(m\) \|\| keepLivePeer\(m, getLocalMessages\(\)\);/);
  // (c) 文件监听回调 / (d) 兜底去重 effect
  assert.match(APP, /if \(lastUser && known\.has\(lastUser\)\) return prev\.filter\(\(m\) => isLocalOnlyEntry\(m\) \|\| keepLivePeer\(m, persisted\) \|\| \(m\.interrupted && !known\.has\(m\)\)\);/);
  assert.match(APP, /if \(lastUser && known\.has\(lastUser\)\) return prev\.filter\(\(m\) => isLocalOnlyEntry\(m\) \|\| keepLivePeer\(m, messages\) \|\| \(m\.interrupted && !known\.has\(m\)\)\);/);
  assert.equal(count(/m\.type === 'btw' \|\| m\.type === 'denial' \|\| m\.type === 'mode-mismatch'/g), 0);
});
t('(a) 空 / 报错回合那一支原样保留回合类条目', () => {
  assert.match(APP, /prev\.filter\(\(m\) => m\.type === 'turn' \|\| !known\.has\(m\) \|\| keepLivePeer\(m, hist\)\)/);
});
t('四个打标点都带标记', () => {
  assert.match(APP, /uuid: 'chat-budget-' \+ Date\.now\(\),\s*type: 'turn',\s*localNotice: 'budget',/);
  assert.match(APP, /uuid: 'chat-empty-' \+ Date\.now\(\),\s*type: 'turn',\s*localNotice: 'empty',/);
  const errs = APP.match(/uuid: 'chat-error-' \+ Date\.now\(\),\s*type: 'turn',\s*localNotice: 'error',/g) || [];
  assert.equal(errs.length, 2);
  assert.equal(count(/uuid: 'chat-error-' \+ Date\.now\(\)/g), 2, 'chat-error 打标点应恰好两处');
});
t('本地提示条目不带 srcUuids / roundStartTs', () => {
  for (const re of [/uuid: 'chat-budget-'/, /uuid: 'chat-empty-'/, /uuid: 'chat-error-'/g]) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    for (const m of APP.matchAll(new RegExp(re.source, flags))) {
      // 取到该对象字面量结束(第一个 "}]" 或 "},\n" 之前的 1200 字内找)
      const seg = APP.slice(m.index, m.index + 1200);
      const end = seg.search(/\n\s*\}\]\);|\n\s*\},\s*\]\);/);
      const body = end > 0 ? seg.slice(0, end) : seg;
      assert.ok(!/srcUuids|roundStartTs/.test(body), `${re.source} 不应带 srcUuids / roundStartTs`);
    }
  }
});

console.log(`check-r178-local-notice: ${n} passed`);

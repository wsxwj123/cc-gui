#!/usr/bin/env node
// r26-I2(client 侧,契约 C-I2):hiddenProjects 无 WS 广播 → 入 store + reducer 收敛。
// (服务端 broadcast 由 PKG-5 发;本包负责 store.hiddenProjects + useWebSocket 分支
//  + Home 改读 store 替掉局部 useState。)
// ①store:applyHiddenProjects 值形钉死(数组过滤非字符串;非数组 → 空表);
// ②源码哨兵:useWebSocket 有 'hidden-projects' 分支调 applyHiddenProjects(data.hidden);
//   Home 读 store.hiddenProjects,不再持有局部 useState 的 hiddenHashes;
// ③回归:readHiddenHashes 响应解析语义不变(utils/home.js,既有测试覆盖)。
// Run: node tests/unit/check-r26-hidden-projects-store.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();

// ① store 行为
assert.deepEqual(st().hiddenProjects, [], 'I2: 初始空表');
st().applyHiddenProjects(['h1', 'h2']);
assert.deepEqual(st().hiddenProjects, ['h1', 'h2'], 'I2: 广播收敛入位');
st().applyHiddenProjects(['h3', 123, '', null]); // 脏数据过滤
assert.deepEqual(st().hiddenProjects, ['h3'], 'I2: 非字符串/空串过滤(全量替换语义)');
st().applyHiddenProjects(undefined);
assert.deepEqual(st().hiddenProjects, [], 'I2: 非数组 → 空表(不崩)');
st().applyHiddenProjects([]); // 他端清空隐藏 → 本端也清(删除传播)
assert.deepEqual(st().hiddenProjects, [], 'I2: 全量替换——他端取消隐藏本端同步');

// ② 源码哨兵
const ws = readFileSync(new URL('../../client/src/hooks/useWebSocket.js', import.meta.url), 'utf8');
assert.match(ws, /case 'hidden-projects':/, 'I2: useWebSocket 必须有 hidden-projects 分支');
assert.match(ws, /applyHiddenProjects\(data\.hidden\)/, 'I2: 分支必须调 applyHiddenProjects(data.hidden)(契约键名)');

const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const homeStart = app.indexOf('function HomeState(');
const home = app.slice(homeStart, app.indexOf('function EmptyState', homeStart));
assert.match(home, /useStore\(\(s\) => s\.hiddenProjects\)/, 'I2: Home 必须读 store.hiddenProjects');
assert.doesNotMatch(home, /useState\(\(\) => new Set\(\)\)/, 'I2: Home 局部 useState 的 hiddenHashes 已退役');
assert.match(home, /applyHiddenProjects\(Array\.isArray\(d\?\.hidden\)/, 'I2: Home 挂载拉 GET 水合 store(不私有)');
assert.match(home, /new Set\(hiddenProjectsList\)/, 'I2: hiddenHashes 由 store 派生');

console.log('PASS check-r26-hidden-projects-store');

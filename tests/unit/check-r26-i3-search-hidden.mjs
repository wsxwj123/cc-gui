#!/usr/bin/env node
// r26-I3 单测:/api/search 过滤 hiddenProjects。
// 哨兵(实际验证过红):删掉 projectDirs 过滤里的 !hidden.has(e.name) → t1 红。
// 红线:样本 /tmp 自建(tmp HOME),端口只用 6703,跑完杀干净。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// search.js 顶层固化 PROJECTS_DIR/PREFS_PATH(homedir),必须先隔离 HOME 再 import
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r26-i3-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const HASH_VIS = '-tmp-visible-proj';
const HASH_HID = '-tmp-hidden-proj';
const NEEDLE = 'r26i3needle-xqz';

for (const h of [HASH_VIS, HASH_HID]) {
  const dir = join(TMP_HOME, '.claude', 'projects', h);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sess-1.jsonl'), JSON.stringify({
    type: 'user', timestamp: '2026-08-10T00:00:00Z',
    message: { content: `包含 ${NEEDLE} 的一行` },
  }) + '\n');
}
mkdirSync(join(TMP_HOME, '.claude-gui'), { recursive: true });
writeFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), JSON.stringify({ hiddenProjects: [HASH_HID] }));

const express = (await import('express')).default;
const searchRouter = (await import('../../server/routes/search.js')).default;

const app = express();
app.use('/api', searchRouter);

let server = null;
let failure = null;
try {
  server = await new Promise((resolve, reject) => {
    const s = app.listen(6703, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  const get = async () => (await fetch(`http://127.0.0.1:6703/api/search?q=${NEEDLE}`)).json();

  // t1 过滤哨兵:隐藏项目的命中不进结果,可见项目的在
  const d1 = await get();
  const hashes1 = (d1.hits || []).map((h) => h.projectHash);
  assert.ok(hashes1.includes(HASH_VIS), `t1: 可见项目命中应在(实际 ${JSON.stringify(hashes1)})`);
  assert.ok(!hashes1.includes(HASH_HID), `t1: 隐藏项目的会话不许被搜到(实际 ${JSON.stringify(hashes1)})`);

  // t2 hidden 为空 → 不过滤(两侧都出)
  writeFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), JSON.stringify({ hiddenProjects: [] }));
  const d2 = await get();
  const hashes2 = (d2.hits || []).map((h) => h.projectHash);
  assert.ok(hashes2.includes(HASH_VIS) && hashes2.includes(HASH_HID), `t2: 空 hidden 不过滤(实际 ${JSON.stringify(hashes2)})`);

  // t3 prefs.json 缺失/损坏 → 回落不过滤,不 500
  rmSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), { force: true });
  const d3 = await get();
  assert.ok(Array.isArray(d3.hits), 't3: prefs 缺失不炸,照常返回');
  assert.ok(d3.hits.length === 2, `t3: 回落=不过滤(实际 ${d3.hits.length} 条)`);
} catch (e) {
  failure = e;
} finally {
  if (server) {
    try { server.closeAllConnections?.(); } catch {}
    await new Promise((r) => server.close(r));
  }
  rmSync(TMP_HOME, { recursive: true, force: true });
}
if (failure) throw failure;

console.log('check-r26-i3-search-hidden: all passed');

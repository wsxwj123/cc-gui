#!/usr/bin/env node
// r49a-③【单测】:draft→session 恢复索引的 projectHash 两侧口径。
// 根因(与 r31 /context 409 同一个坑):写侧 chat.js 直接拿 slot.cwd 原串编码,读侧
// sessions 路由拿的是磁盘真实目录名。Windows 上 canonicalCwd 会把路径小写化、盘符/
// 大小写又随来源漂移 —— 两边恒不等 = 附件恢复索引永远命中不了,outbox 只进不出。
// 修:写侧同 trustedContextMeta 走 canonicalCwd 再编码;读侧双侧 toLowerCase 比较。
// 顺带:outbox 补 64 条上限(绑定真失效时不至于把 localStorage 撑爆)。
// 修前红:t1(大小写不同不命中)、t2(源码哨兵)、t3(第 65 条不淘汰)。
// 变异:读侧去掉任一侧 toLowerCase → t1 红;stage 去掉 slice → t3 红。
// Run: node tests/unit/check-r49-draft-binding-case.mjs
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraftSessionBindingsStore } from '../../server/services/draft-session-bindings.js';
import {
  createAttachmentSidecarOutbox, ATTACHMENT_SIDECAR_OUTBOX_MAX,
} from '../../client/src/utils/attachments.js';
import { canonicalCwd } from '../../server/utils/safe-path.js';

// ── t1 读侧:写入是 canonicalCwd 派生(win32 小写),读取来自磁盘真实目录名(保留大小写)──
{
  const home = await mkdtemp(join(tmpdir(), 'cgui-r49-binding-'));
  const store = createDraftSessionBindingsStore({
    file: join(home, 'draft-session-bindings.json'),
    now: () => 1234,
    makeTempId: () => 'tmp',
  });
  const sessionId = '44444444-4444-4444-4444-444444444444';
  // 服务端写入形态:canonicalCwd('C:\Users\Admin\Desktop\MyProj', 'win32') 已小写化
  const written = canonicalCwd('C:\\Users\\Admin\\Desktop\\MyProj', 'win32').replace(/[^A-Za-z0-9]/g, '-');
  assert.equal(written, 'c--users-admin-desktop-myproj', 't1 夹具:写侧口径确为小写(盘符冒号+分隔符各一个 -)');
  await store.record({ draftId: 'd-case', sessionId, projectHash: written });

  // 客户端/路由形态:来自 ~/.claude/projects 下的真实目录名,大小写按当初 cwd 原样保留
  const fromDisk = 'C--Users-Admin-Desktop-MyProj';
  const merged = await store.mergeIntoSessions([{ sessionId, firstPrompt: 'x' }], fromDisk);
  assert.equal(merged[0].draftId, 'd-case', 't1: 大小写不同的同一项目仍命中(修前 undefined)');

  // 反方向同样要成立:旧版本(未归一)写下的索引保留了大小写,读侧可能是小写形态。
  // 两侧各归一一次,少任何一侧都会漏。
  await store.record({ draftId: 'd-legacy', sessionId, projectHash: 'C--Users-Admin-Desktop-MyProj' });
  const legacy = await store.mergeIntoSessions([{ sessionId, firstPrompt: 'x' }], written);
  assert.equal(legacy[0].draftId, 'd-legacy', 't1: 索引侧带大写、读侧小写也命中');

  // 反向钉:不同项目不得被大小写归一"归"到一起。
  const other = await store.mergeIntoSessions([{ sessionId, firstPrompt: 'x' }], '-work-other');
  assert.equal(other[0].draftId, undefined, 't1: 归一不放宽,别的项目仍不命中');
}

// ── t2 写侧哨兵:chat.js 记录绑定时必须先 canonicalCwd(与 trustedContextMeta 同口径)──
{
  const src = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  const start = src.indexOf('await recordDraftSessionBinding({');
  assert.notEqual(start, -1, 't2 夹具:找到写入调用点');
  const call = src.slice(start, src.indexOf('});', start));
  assert.match(call, /projectHash: canonicalCwd\(slot\.cwd \|\| ''\)\.replace\(\/\[\^A-Za-z0-9\]\/g, '-'\)/,
    't2: 写侧 projectHash 由 canonicalCwd 派生(修前是 slot.cwd 原串)');
}

// ── t3 outbox 条数上限:绑定失效时只进不出会把 localStorage 撑爆 ──
{
  class MemoryStorage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
  }
  assert.equal(ATTACHMENT_SIDECAR_OUTBOX_MAX, 64, 't3: 上限常量');
  const outbox = createAttachmentSidecarOutbox({ storage: new MemoryStorage(), makeId: ({ payload }) => payload.text });
  const total = ATTACHMENT_SIDECAR_OUTBOX_MAX + 6;
  for (let i = 0; i < total; i++) {
    await outbox.stage({
      ownerKey: `draft--p-d${i}`,
      payload: { text: `m${i}`, displayText: `m${i}`, attachments: [{ kind: 'image', name: 'a.png', path: '/tmp/a.png', bytes: 9 }] },
    });
  }
  const kept = outbox.read();
  assert.equal(kept.length, ATTACHMENT_SIDECAR_OUTBOX_MAX, 't3: 超限后条数封顶(修前 70 条)');
  assert.equal(kept[0].id, `m${total - ATTACHMENT_SIDECAR_OUTBOX_MAX}`, 't3: 淘汰的是最旧的(FIFO)');
  assert.equal(kept[kept.length - 1].id, `m${total - 1}`, 't3: 最新一条必留');
}

console.log('✓ check-r49-draft-binding-case: 绑定 hash 两侧同口径 + outbox 上限');

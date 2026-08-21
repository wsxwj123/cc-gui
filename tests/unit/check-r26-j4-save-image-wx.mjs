#!/usr/bin/env node
// r26-J4【单测】:saveImage flag:'wx' 原子创建,撞名加后缀重试。
// 修前:existsSync 预检 + writeFile 两步,并发同 tick 同名 → 双方预检都过、后写覆盖先写。
// 哨兵:①同 tick 并发 8 次同名保存 → 8 个文件俱在、内容各自完整(并发撞名双存活);
// ②已有文件不被覆盖(内容不变);③-EEXIST 以外的错误(目录不存在)原样上抛不吞;
// ④撞名 100 次后放弃(上限哨兵);⑤路由级回归由 check-image-gen t6 顺带覆盖。
// 样本 /tmp 自建。
// Run: node tests/unit/check-r26-j4-save-image-wx.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'cgui-j4-'));
// 隔离 HOME(image.js 链路 import settings.js,真实 HOME 一个字节不碰)
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-j4-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
const { saveImage } = await import('../../server/routes/image.js');

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
let failure = null;
try {
  // ① 同 tick 并发 8 次同名 → 8 个文件俱在
  {
    const bufs = Array.from({ length: 8 }, (_, i) => Buffer.from(`img-${i}`));
    const paths = await Promise.all(bufs.map((b) => saveImage(DIR, 'same.png', b)));
    assert.equal(new Set(paths).size, 8, 'J4: 并发同名 8 次 → 8 个不同路径');
    const files = readdirSync(DIR).filter((f) => f.startsWith('same'));
    assert.equal(files.length, 8, 'J4: 8 个文件俱在(并发撞名双存活)');
    const bodies = files.map((f) => readFileSync(join(DIR, f), 'utf8')).sort();
    assert.deepEqual(bodies, bufs.map((b) => b.toString()).sort(), 'J4: 每份内容完整,无覆盖无串写');
    n += 3;
  }
  // ② 已有文件内容不变(覆盖哨兵)
  {
    writeFileSync(join(DIR, 'keep.png'), 'ORIGINAL');
    const p = await saveImage(DIR, 'keep.png', Buffer.from('NEW'));
    assert.equal(readFileSync(join(DIR, 'keep.png'), 'utf8'), 'ORIGINAL', 'J4: 原文件不被覆盖');
    assert.equal(readFileSync(p, 'utf8'), 'NEW', 'J4: 新内容落到带后缀的文件');
    n += 2;
  }
  // ③ 非 EEXIST 错误原样上抛(目录不存在 → ENOENT,不能被重试逻辑吞掉)
  {
    await assert.rejects(
      () => saveImage(join(DIR, 'no-such-dir'), 'x.png', Buffer.from('x')),
      (e) => e.code === 'ENOENT',
      'J4: ENOENT 原样上抛(路由层靠 code 做错误分类,吞了就全是 EEXIST)',
    );
    n += 1;
  }
  // ④ 撞名 100 次后放弃:预置 base 与 -1..-100 共 101 个同名 → 抛错且不再多写
  {
    const sub = mkdtempSync(join(tmpdir(), 'cgui-j4-full-'));
    writeFileSync(join(sub, 'f.png'), '0');
    for (let i = 1; i <= 100; i++) writeFileSync(join(sub, `f-${i}.png`), '0');
    const before = readdirSync(sub).length;
    await assert.rejects(
      () => saveImage(sub, 'f.png', Buffer.from('x')),
      /同名文件过多/,
      'J4: 撞名超 100 次放弃(不无限重试)',
    );
    assert.equal(readdirSync(sub).length, before, 'J4: 放弃时不产生新文件');
    rmSync(sub, { recursive: true, force: true });
    n += 2;
  }
} catch (e) {
  failure = e;
} finally {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(TMP_HOME, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`PASS check-r26-j4-save-image-wx (${n} assertions)`);

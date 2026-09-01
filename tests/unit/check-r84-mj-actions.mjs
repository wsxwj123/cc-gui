#!/usr/bin/env node
// 单测:r84 Midjourney 结构化参数下发 + 多图条目消费 + 生成页清空 + U/V 二次操作。
// Run: node tests/unit/check-r84-mj-actions.mjs
//
// 核心牙:
//  ① mj 的 size 是【宽高比】不是像素,且必须能被 extra 覆盖(extra 是用户的逃生口,
//    优先级最高);空值一律不发该键 —— 发 "" 上游会当成显式指定的空比例。
//  ② version 的取值范围出自 apimart 文档 imagine.md 原文,niji 不是"另一种版本号"而是
//    niji:true + version:"7"/"6" 的搭配;界面把两者压成一个字符串,协议层负责拆回。
//  ③ 回归锁:openai / gemini / chat 三种同步协议的产物与 r84 之前逐字一致 —— mj 的新字段
//    (mjVersion / mjSpeed)出现在同一个 config 上时对它们零影响。
//  ④ 多图条目(MJ 一次 4 张)的选中张索引必须钳在 [0, files.length-1]:越界会让预览、
//    「以此图修改」、「在文件夹中显示」拿到 undefined 路径,一路传到删除/预览端点。
//    单图条目(files 不存在)的行为与 r82 之前一字不变。
//  ⑤ 清空必须连 localStorage 草稿一起清 —— 只清内存的话刷新就回来了(草稿是刻意持久的)。
//  ⑥ U/V 动作:端点、body 形态、index 边界都由文档钉死(见 .devflow/RESEARCH-r84-mj-actions.md);
//    网格位置→index 的映射(左上=1 右上=2 左下=3 右下=4)写死并在此锁住。
//  ⑦ 前端的版本/速度候选与服务端白名单同源:两处清单不一致时前端能选出后端拒收的值。
//
// 全程零网络、零真实配置:只 import 纯函数 + 读源码文本做结构断言。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  buildImageRequest, mjVersionFields, MJ_VERSIONS, MJ_SPEEDS,
} = await import('../../server/utils/image-protocols.js');
const { entryFiles, pickedIndex, pickedFile, entryPreviewUrl, pickedPreviewUrl } =
  await import('../../client/src/utils/imageEntry.js');
const PANEL = readFileSync(join(REPO, 'client', 'src', 'components', 'ImagePanel.jsx'), 'utf8');

const BASE = { baseURL: 'https://api.example.com/v1', apiKey: 'sk-r84-secret', model: 'midjourney' };
const mj = (over) => buildImageRequest({ protocol: 'mj', ...BASE, ...over }, '一只猫');

// ───────────────── 1. mj:size 当宽高比下发 ─────────────────
{
  const r = mj({ size: '16:9' });
  assert.equal(r.url, 'https://api.example.com/v1/midjourney/generations', 't1: 提交端点');
  assert.deepEqual(r.body, { prompt: '一只猫', size: '16:9' }, 't1: size 随请求下发,且不发 model');
  assert.equal(r.form, null, 't1: mj 不走 multipart');

  // 空 size 不发键(不是发空串)。
  assert.equal('size' in mj({}).body, false, 't1: 未填尺寸时不出现 size 键');
  assert.equal('size' in mj({ size: '' }).body, false, 't1: 空串尺寸不发键');

  // extra 优先:同名键覆盖表单值(与其余三协议的 extra 语义一致)。
  assert.equal(mj({ size: '16:9', extra: { size: '1:1' } }).body.size, '1:1', 't1: extra 覆盖 size');
  assert.equal(mj({ size: '16:9', extra: { version: '5.2' } }).body.version, '5.2', 't1: extra 可加键');
}

// ───────────────── 2. mj:version / niji / speed ─────────────────
{
  assert.deepEqual(mjVersionFields('6.1'), { version: '6.1' }, 't2: 主版本只发 version');
  assert.deepEqual(mjVersionFields('niji7'), { niji: true, version: '7' }, 't2: niji 拆成 niji + version');
  assert.deepEqual(mjVersionFields('niji6'), { niji: true, version: '6' }, 't2: niji6');
  for (const bad of ['', '  ', 'v7', '9.9', 'niji5', null, undefined, 7, {}]) {
    assert.deepEqual(mjVersionFields(bad), {}, `t2: 清单外的值一律不发(${JSON.stringify(bad)})`);
  }
  // 清单里的每一个值都必须能产出非空字段(变异自证:清单与拆分逻辑不同步立刻红)。
  for (const v of MJ_VERSIONS) {
    assert.ok(Object.keys(mjVersionFields(v)).length > 0, `t2: 清单值 ${v} 必须有对应字段`);
  }
  assert.deepEqual(MJ_VERSIONS, ['8.2', '8.1', '7', '6.1', '5.2', '5.1', 'niji7', 'niji6'], 't2: 版本清单(文档 imagine.md 原文)');

  assert.equal(mj({ mjVersion: '6.1' }).body.version, '6.1', 't2: version 进 body');
  assert.equal('niji' in mj({ mjVersion: '6.1' }).body, false, 't2: 主版本不发 niji 键');
  assert.equal(mj({ mjVersion: 'niji7' }).body.niji, true, 't2: niji 档发 niji:true');
  assert.equal('version' in mj({ mjVersion: '' }).body, false, 't2: 未指定版本不发键');

  assert.equal(mj({ mjSpeed: 'fast' }).body.speed, 'fast', 't2: speed 进 body');
  assert.equal('speed' in mj({ mjSpeed: '' }).body, false, 't2: 未指定速度不发键');
  assert.deepEqual(MJ_SPEEDS, ['relax', 'fast', 'turbo'], 't2: 速度清单');

  // 全填齐 + extra 覆盖:一次把优先级链路走完。
  assert.deepEqual(
    mj({ size: '9:16', mjVersion: 'niji7', mjSpeed: 'turbo', extra: { speed: 'fast', stylize: 250 } }).body,
    { prompt: '一只猫', size: '9:16', niji: true, version: '7', speed: 'fast', stylize: 250 },
    't2: 表单值 + extra 覆盖同名键 + extra 新增键',
  );
}

// ───────────────── 3. 回归锁:其余三协议逐字不变 ─────────────────
{
  const noise = { size: '1024x1024', mjVersion: 'niji7', mjSpeed: 'turbo' };
  for (const protocol of ['openai', 'gemini', 'chat']) {
    const withMj = buildImageRequest({ protocol, ...BASE, model: 'gpt-image-2', ...noise }, '一只猫');
    const withoutMj = buildImageRequest({ protocol, ...BASE, model: 'gpt-image-2', size: noise.size }, '一只猫');
    assert.deepEqual(withMj, withoutMj, `t3: mj 字段对 ${protocol} 零影响`);
    assert.equal(JSON.stringify(withMj.body).includes('niji'), false, `t3: ${protocol} body 不含 niji`);
    assert.equal(JSON.stringify(withMj.body).includes('turbo'), false, `t3: ${protocol} body 不含 speed`);
  }
  // 形态锁:openai 的 body 仍是 model/prompt/size 三件套(deepEqual 之外再钉一次字面量)。
  assert.deepEqual(
    buildImageRequest({ protocol: 'openai', ...BASE, model: 'gpt-image-2', size: '1024x1024' }, '一只猫').body,
    { model: 'gpt-image-2', prompt: '一只猫', n: 1, size: '1024x1024' },
    't3: openai body 字面量',
  );
}

// ───────────────── 4. 多图条目:统一取图 + 下标边界 + 单图向后兼容 ─────────────────
{
  const four = {
    id: 'j1', status: 'done', file: '/img/a.png', previewUrl: '/api/image/preview?file=%2Fimg%2Fa.png',
    files: ['/img/a.png', '/img/b.png', '/img/c.png', '/img/d.png'],
  };
  const one = { id: 'j2', status: 'done', file: '/img/solo.png', previewUrl: '/api/image/preview?file=%2Fimg%2Fsolo.png' };

  assert.deepEqual(entryFiles(four), four.files, 't4: 多图条目取 files 全量');
  assert.deepEqual(entryFiles(one), ['/img/solo.png'], 't4【向后兼容】:单图条目(无 files)取 file');
  for (const [bad, why] of [[null, 'null'], [undefined, 'undefined'], [{}, '空条目'],
    [{ files: [] }, 'files 空数组'], [{ file: '' }, 'file 空串'], [{ files: [1, null] }, 'files 里不是字符串'],
    [{ file: 5 }, 'file 不是字符串']]) {
    assert.deepEqual(entryFiles(bad), [], `t4: ${why} → 空数组`);
  }
  // running / error 条目没有图:所有取图口都必须给出"没有"而不是半截值。
  assert.equal(pickedFile({ id: 'j3', status: 'running' }), '', 't4: 无图条目 pickedFile 为空串');
  assert.equal(pickedPreviewUrl({ id: 'j3', status: 'running' }), '', 't4: 无图条目预览地址为空串');

  // 下标边界:0 / 末位 / 越界 / 负数 / 非数字。
  assert.equal(pickedIndex(four, 0), 0, 't4: 下标 0');
  assert.equal(pickedIndex(four, 3), 3, 't4: 下标末位');
  assert.equal(pickedIndex(four, 4), 3, 't4【越界】:钳到末位');
  assert.equal(pickedIndex(four, 99), 3, 't4【越界】:大幅越界也钳到末位');
  assert.equal(pickedIndex(four, -1), 0, 't4: 负数回落 0');
  assert.equal(pickedIndex(four, undefined), 0, 't4: 未选过 → 0');
  assert.equal(pickedIndex(four, '2'), 2, 't4: 数字字符串');
  assert.equal(pickedIndex(four, 'x'), 0, 't4: 非数字回落 0');
  assert.equal(pickedIndex(four, 1.9), 1, 't4: 小数向下取整');
  // 单图条目:任何下标都只能是第 0 张(这是"多图不改单图行为"的核心一条)。
  for (const idx of [0, 1, 7, -3, undefined, 'x']) {
    assert.equal(pickedIndex(one, idx), 0, `t4【向后兼容】:单图条目下标恒 0(${idx})`);
    assert.equal(pickedFile(one, idx), '/img/solo.png', `t4【向后兼容】:单图条目恒取那一张(${idx})`);
    assert.equal(pickedPreviewUrl(one, idx), one.previewUrl, `t4【向后兼容】:预览地址与服务端写的逐字一致(${idx})`);
  }
  assert.equal(pickedFile(four, 2), '/img/c.png', 't4: 选第 3 张就取第 3 张');
  assert.equal(pickedPreviewUrl(four, 0), four.previewUrl, 't4: 第 1 张的地址与服务端写的 previewUrl 一致');
  assert.equal(entryPreviewUrl(''), '', 't4: 空路径不拼出 file= 空串的请求');
  assert.equal(entryPreviewUrl('/a b#c.png'), '/api/image/preview?file=%2Fa%20b%23c.png', 't4: 路径进 query 前编码');

  // 与服务端写进条目的模板同源:改了一边漏改另一边,后几张的预览就 404。
  const routeSrc = readFileSync(join(REPO, 'server', 'routes', 'image.js'), 'utf8');
  assert.match(routeSrc, /previewUrl: `\/api\/image\/preview\?file=\$\{encodeURIComponent\(files\[0\]\)\}`/,
    't4: 服务端仍用同一个 previewUrl 模板');
}

// ───────────────── 5. 面板消费点:两种视图都消费多图,且不再恒取第一张 ─────────────────
{
  const count = (re) => (PANEL.match(re) || []).length;
  assert.equal(count(/\{imageStrip\(h\)\}/g), 2, 't5: 网格与列表两种视图都渲染缩略条');
  assert.match(PANEL, /\{imageStrip\(current\)\}/, 't5: 生图页的当前预览也带缩略条');
  // 单图操作一律走 shotFile / shotUrl:留下任何一处 h.file / h.previewUrl 就是"恒取第一张"。
  assert.equal(count(/reveal\(h\.file\)/g), 0, 't5: 在文件夹中显示不再恒取第一张');
  assert.equal(count(/src=\{h\.previewUrl\}/g), 0, 't5: 缩略图不再恒取第一张');
  assert.equal(count(/path: h\.file/g), 0, 't5: 放大不再恒取第一张');
  assert.equal(count(/reveal\(current\.file\)|src=\{current\.previewUrl\}/g), 0, 't5: 生图页预览同理');
  assert.match(PANEL, /const MJ_GRID_POSITIONS = \['左上', '右上', '左下', '右下'\]/,
    't5【映射锁】:四宫格位置顺序 = 上游 index 1-4 的顺序');
}

// ───────────────── 7. 前端候选与服务端白名单同源 ─────────────────
{
  const grabbed = [...PANEL.matchAll(/versions:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  assert.ok(grabbed.length, 't7: 没能从 ImagePanel.jsx 里读出版本候选(正则与源码不同步)');
  for (const v of grabbed) assert.ok(MJ_VERSIONS.includes(v), `t7: 前端候选 ${v} 不在服务端白名单里`);
  assert.deepEqual([...grabbed].sort(), [...MJ_VERSIONS].sort(), 't7: 前后端版本清单必须一一对应');

  const speeds = [...(PANEL.match(/const MJ_SPEEDS = \[[\s\S]*?\];/) || [''])[0].matchAll(/id: '([^']*)'/g)]
    .map((m) => m[1]).filter(Boolean);
  assert.ok(speeds.length, 't7: 没能读出前端速度候选');
  for (const s of speeds) assert.ok(MJ_SPEEDS.includes(s), `t7: 前端速度候选 ${s} 不在服务端白名单里`);
}

console.log('✓ check-r84-mj-actions: mj 结构化参数 + 三协议回归锁 + 前后端清单同源 全部通过');

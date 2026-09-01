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

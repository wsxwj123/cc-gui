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
//  ⑦ 前端候选与服务端白名单同源:版本一一对应、速度是子集(默认档在界面上是空串)。
//    两处清单不一致时前端能选出后端拒收的值。
//
// 变异自证(逐条实跑过"改坏就红",不是"写法没变就绿"的文本锁;改动只在源码副本上做、跑完还原):
//  - pickedIndex 去掉钳位(return n)            → t4【越界】红
//  - mj 分支删掉 size 下发那行                   → t1 红
//  - mjVersionFields 的 niji 档只发 version      → t2 红
//  - 动作 body 并入 extra                        → t8 红
//  - 面板某处改回 reveal(h.file)                 → t5 红
//  - 动作路由去掉 !parent.taskId 守卫            → t8【前置校验】红
//
// 全程零网络、零真实配置:只 import 纯函数 + 读源码文本做结构断言。
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须在 import 路由之前:真实 ~/.claude-gui 一个字节不碰(红线),轮询提速只为 t9 秒级跑完。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r84-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r84-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.CGUI_IMAGE_TASK_POLL_INTERVAL_MS = '200';
mkdirSync(join(TMP_HOME, '.claude-gui'), { recursive: true });

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  buildImageRequest, mjVersionFields, MJ_VERSIONS, MJ_SPEEDS,
  buildMjActionRequest, MJ_ACTIONS, MJ_ACTION_INDEX_MAX,
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

  // 【升级回归】r82 时 size 不下发,存量 provider 可能存着从别的协议抄来的像素值;
  // 现在它会被上游当 --ar 解析 → 协议层这个共同经过点只放行 W:H 形态,其余静默不发键
  // (不报错、不阻断:按默认比例出图比整单失败好)。
  for (const bad of ['1024x1024', '3840x2160', '1K', 'auto', '16:', ':9', '16x9', '16 : 9', 'abc']) {
    assert.equal('size' in mj({ size: bad }).body, false, `t1【存量像素值】:${bad} 不当宽高比发出去`);
  }
  for (const good of ['16:9', '1:1', '9:16', '21:9', '1024:768']) {
    assert.equal(mj({ size: good }).body.size, good, `t1: 合法比例 ${good} 照发`);
  }
  assert.equal(mj({ size: '  16:9  ' }).body.size, '16:9', 't1: 比例值两端空白去掉再发');
  // 只作用于 mj:openai 的像素尺寸一如既往照发(别把守卫写到公共路径上)。
  assert.equal(buildImageRequest({ protocol: 'openai', ...BASE, model: 'gpt-image-2', size: '1024x1024' }, 'p').body.size, '1024x1024',
    't1【只管 mj】:openai 的像素尺寸不受影响');

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

// ───────────────── 6. 生成页「清空」 ─────────────────
{
  const block = (PANEL.match(/const clearInputs = \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
  assert.ok(block, 't6: 找得到 clearInputs');
  // 草稿是刻意持久化的(localStorage),只清内存的话刷新就回来了 —— 必须经 restorePrompt('')
  // 写空(它会走 onChange → setPromptDraft → localStorage)。
  assert.match(block, /restorePrompt\(''\)/, 't6【草稿】:清空必须写空 localStorage 草稿');
  assert.match(block, /setRefs\(\[\]\)/, 't6: 参考图一并清空');
  assert.match(block, /revokeRefPreview/, 't6: 上传参考图的 objectURL 要撤,别泄漏');
  assert.equal(/confirmDialog|window\.confirm/.test(block), false, 't6: 清空不弹确认(可撤销的低风险操作)');
  assert.match(PANEL, /onClick=\{clearInputs\}[\s\S]{0,400}>清空<\/button>/, 't6: 生成按钮旁有「清空」按钮');
  assert.match(PANEL, /disabled=\{!prompt && !refs\.length\}/, 't6: 没东西可清时禁用');
  // 草稿键没被改名(改名 = 存量用户的草稿丢失)。
  assert.match(PANEL, /const PROMPT_DRAFT_KEY = 'cgui-image-prompt-draft'/, 't6: 草稿键不变');
}

// ───────────────── 7. 前端候选与服务端白名单同源 ─────────────────
{
  const grabbed = [...PANEL.matchAll(/versions:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  assert.ok(grabbed.length, 't7: 没能从 ImagePanel.jsx 里读出版本候选(正则与源码不同步)');
  for (const v of grabbed) assert.ok(MJ_VERSIONS.includes(v), `t7: 前端候选 ${v} 不在服务端白名单里`);
  assert.deepEqual([...grabbed].sort(), [...MJ_VERSIONS].sort(), 't7: 前后端版本清单必须一一对应');

  // 速度是【子集】不是一一对应:界面把默认档写成空串(不下发 speed 键)而非字面量 'relax'。
  const speeds = [...(PANEL.match(/const MJ_SPEEDS = \[[\s\S]*?\];/) || [''])[0].matchAll(/id: '([^']*)'/g)]
    .map((m) => m[1]);
  assert.ok(speeds.includes(''), 't7: 界面必须有"默认"档(空串 = 不下发 speed 键)');
  for (const s of speeds.filter(Boolean)) assert.ok(MJ_SPEEDS.includes(s), `t7: 前端速度候选 ${s} 不在服务端白名单里`);
}

// ───────────────── 8. U/V 二次操作:端点 / body / 边界 / 接线 ─────────────────
{
  const cfg = { protocol: 'mj', ...BASE, mjSpeed: 'fast' };
  const up = buildMjActionRequest(cfg, 'upscale', 2, 'task_01ABC');
  assert.equal(up.url, 'https://api.example.com/v1/midjourney/generations/upscale', 't8: upscale 端点');
  assert.deepEqual(up.body, { task_id: 'task_01ABC', index: 2, speed: 'fast' }, 't8: body = task_id + index + speed');
  assert.equal(up.headers.Authorization, 'Bearer sk-r84-secret', 't8: 与提交同口径的 Bearer');
  assert.equal(up.form, null, 't8: 动作不是 multipart');
  assert.equal(up.altHeaders, null, 't8: 动作无认证回落');

  const va = buildMjActionRequest({ protocol: 'mj', ...BASE }, 'variation', 4, '  task_x  ');
  assert.equal(va.url, 'https://api.example.com/v1/midjourney/generations/variation', 't8: variation 端点');
  assert.deepEqual(va.body, { task_id: 'task_x', index: 4 }, 't8: 未设速度时不发 speed 键,任务号去空白');

  // 【不并入 extra】:动作端点不收 imagine 的结构化参数,原样转发只会 400 或被丢弃。
  assert.deepEqual(
    buildMjActionRequest({ protocol: 'mj', ...BASE, size: '16:9', mjVersion: 'niji7', extra: { stylize: 250 } }, 'upscale', 1, 't').body,
    { task_id: 't', index: 1 },
    't8: 动作 body 不含 size / version / extra',
  );

  // index 边界:1 与 4 通过,0 / 5 / 小数 / 非数字 / 缺失一律抛人话错误。
  for (const ok of [1, 2, 3, 4, '3']) {
    assert.equal(buildMjActionRequest(cfg, 'upscale', ok, 't').body.index, Math.floor(Number(ok)), `t8: index ${ok} 合法`);
  }
  for (const bad of [0, -1, 5, 99, NaN, 'x', null, undefined, {}]) {
    assert.throws(() => buildMjActionRequest(cfg, 'upscale', bad, 't'), /只能对第 1–4 张/, `t8【边界】:index ${JSON.stringify(bad)} 拒绝`);
  }
  assert.throws(() => buildMjActionRequest(cfg, 'reroll', 1, 't'), /未知的 Midjourney 操作/, 't8: 未列入的动作拒绝(不拿它拼路径)');
  assert.throws(() => buildMjActionRequest(cfg, 'upscale', 1, '   '), /缺少上游任务号/, 't8: 空任务号拒绝');
  assert.throws(() => buildMjActionRequest({ ...cfg, baseURL: '' }, 'upscale', 1, 't'), /baseURL 未配置/, 't8: 空 baseURL 拒绝');
  assert.deepEqual(MJ_ACTIONS, ['upscale', 'variation'], 't8: 本轮只做文档已核实的两个动作');
  assert.equal(MJ_ACTION_INDEX_MAX, 4, 't8: 四宫格');

  // 路由接线:提交响应与 imagine 同形 → 复用既有轮询与下载,不另造状态机。
  const routeSrc = readFileSync(join(REPO, 'server', 'routes', 'image.js'), 'utf8');
  assert.match(routeSrc, /router\.post\('\/image\/actions'/, 't8: 有动作端点');
  assert.match(routeSrc, /await updateHistoryEntry\(jobId, \{ taskId \}\)/, 't8: 上游任务号写进条目(动作要拿它当 task_id)');
  assert.match(routeSrc, /buildMjActionRequest\(provider, action, index, parent\.taskId\)/, 't8: 动作按父任务的上游任务号组装');
  assert.match(routeSrc, /runImageJob\(\{ jobId, provider, prompt, spec, startedAt \}\)/g, 't8: 复用同一个 runner');
  assert.equal((routeSrc.match(/function pollTask/g) || []).length, 1, 't8【零重复】:轮询状态机仍然只有一份');
  for (const [re, why] of [
    [/parent\.status !== 'done'/, '父任务必须已完成'],
    [/!parent\.taskId/, '老记录没有上游任务号时明确拒绝'],
    [/provider\.protocol !== 'mj'/, '非 mj provider 拒绝'],
    [/activeJobs >= MAX_CONCURRENT_JOBS/, '并发闸'],
    [/assertPublicBaseURL\(provider\.baseURL\)/, 'SSRF 守卫'],
  ]) assert.match(routeSrc.slice(routeSrc.indexOf("router.post('/image/actions'")), re, `t8【前置校验】:${why}`);

  // 面板接线:入口在缩略图上,index = 网格位置 + 1,老记录/非 mj 不给入口。
  assert.match(PANEL, /submitAction\(h, act, i \+ 1\)/, 't8【映射】:第 i 格(0 起)提交 index i+1');
  assert.match(PANEL, /const canAct = !!h\.taskId && providers\.find\(\(p\) => p\.id === h\.providerId\)\?\.protocol === 'mj'/,
    't8: 没有上游任务号 / 非 mj provider 时不渲染入口');
  assert.match(PANEL, /body: JSON\.stringify\(\{ jobId: h\.id, action, index \}\)/, 't8: 提交体形态');
  assert.match(PANEL, /const MJ_ACTION_LABEL = \{ upscale: '放大', variation: '变体' \}/, 't8: 用中文动作名而非 U\/V 编号当主标签');
  assert.match(PANEL, /来自上一任务第 \$\{h\.mjIndex\} 张/, 't8【可追溯】:新条目标出来源');

  // 【付费误触】动作条只给【选中那张】渲染。用 opacity 藏是不够的:computed opacity:0 的
  // 按钮照样命中 elementFromPoint,而动作条盖住缩略图底部约 1/4 —— 触屏上"点一下选中"的
  // 第一下就会落在隐藏按钮上,直接提交一个要计费的任务(审查用纯触摸事件实测复现过)。
  const strip = (PANEL.match(/const imageStrip = \(h\) => \{[\s\S]*?\n  \};/) || [''])[0];
  assert.ok(strip, 't8: 找得到 imageStrip');
  assert.match(strip, /\{canAct && i === cur && \(/, 't8【付费误触】:动作条只在选中那张上渲染');
  // 【必须剥注释再断言】上面那段说明里就写着 opacity / pointer-events-none 这些词,
  // 不剥的话断言恒真 = 死锁(第一版就栽在这:变异实跑是绿的才发现)。
  const bar = (strip.match(/\{canAct[\s\S]*?\n            \)\}/) || [''])[0]
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(bar.includes('submitAction'), 't8: 切到的是动作条那一段');
  // 只看动作条【自己那层 div】的 className:按钮上的 disabled:opacity-50 是正当的,
  // 拿整段做子串匹配会把它算进来。
  const barDiv = (bar.match(/<div className=[^\n]*absolute inset-x-0 bottom-0[^\n]*/) || [''])[0];
  assert.ok(barDiv, 't8: 找得到动作条那一层 div');
  // 若哪天改回"隐藏但保留在 DOM 里",必须同时挡住点击 —— 否则这条红。
  assert.equal(/opacity-0|invisible/.test(barDiv) && !/pointer-events-none/.test(barDiv), false,
    't8【付费误触】:隐藏态的动作条必须同时 pointer-events-none(或干脆不渲染)');
  assert.equal(/group-hover/.test(barDiv), false, 't8: 动作条不靠 hover 出现(触屏没有 hover)');
}


// ───────── 9. 端到端:假上游跑完 提交 → 记任务号 → 放大 → 新记录落盘 ─────────
// 源码断言只能证明"接线写了",这一节证明"跑得起来"。全程指向本机假上游(OS 临时口),
// 不打真实网络、不花任何钱。
{
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const seen = { imagine: [], action: [] };
  let server;
  const imgs = (n) => ({ url: Array.from({ length: n }, (_, i) => `http://127.0.0.1:${server.address().port}/img/${i}.png`) });
  app.post('/v1/midjourney/generations', (req, res) => {
    seen.imagine.push(req.body);
    res.json({ code: 200, data: [{ status: 'submitted', task_id: 'task_parent' }] });
  });
  // 动作端点:回一个【新】任务号 —— 与 imagine 逐字同形,这正是"能复用轮询"的前提。
  app.post('/v1/midjourney/generations/:action', (req, res) => {
    seen.action.push({ action: req.params.action, body: req.body, auth: req.headers.authorization });
    res.json({ code: 200, data: [{ status: 'submitted', task_id: 'task_child' }] });
  });
  // 父任务 4 张,放大出来的子任务 1 张(与文档一致:upscale 的 image_urls 只有 1 个元素)。
  app.get('/v1/tasks/:id', (req, res) => res.json({
    code: 200,
    data: { id: req.params.id, status: 'completed', progress: 100, result: { images: [imgs(req.params.id === 'task_child' ? 1 : 4)] } },
  }));
  app.get('/img/:n.png', (_req, res) => res.type('image/png').send(PNG));
  app.use('/api', (await import('../../server/routes/image.js')).default);
  // 端口取 OS 临时口:写死会被同跑的用例抢,制造随机假红。
  server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  const BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body) => {
    const r = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON:留 text 给断言 */ }
    return { status: r.status, text, json };
  };
  const entryOf = async (id) => ((await api('GET', '/api/image/history')).json.history || []).find((e) => e.id === id);
  const waitDone = async (id, ms = 15000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const e = await entryOf(id);
      if (e && e.status !== 'running') return e;
      if (Date.now() > deadline) throw new Error(`t9: 等 ${id} 落终态超时(${JSON.stringify(e)})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  try {
    const mk = await api('POST', '/api/image-providers', {
      name: 'MJ 假上游', protocol: 'mj', baseURL: `${BASE_URL}/v1`, apiKey: 'sk-r84-e2e-secret',
      model: 'midjourney', size: '16:9', savePath: SAVE_DIR, mjVersion: 'niji7', mjSpeed: 'fast',
    });
    assert.equal(mk.status, 200, `t9: provider 建得起来(${mk.text})`);

    const gen = await api('POST', '/api/image/generate', { providerId: mk.json.id, prompt: '一只猫' });
    assert.equal(gen.status, 200, `t9: 提交受理(${gen.text})`);
    const parent = await waitDone(gen.json.jobId);
    assert.equal(parent.status, 'done', `t9: 父任务出图(${parent.error || ''})`);
    assert.equal(parent.files.length, 4, 't9: 4 张全落盘');
    assert.equal(parent.taskId, 'task_parent', 't9【本轮新增】:上游任务号记进了条目');
    assert.deepEqual(seen.imagine[0], { prompt: '一只猫', size: '16:9', niji: true, version: '7', speed: 'fast' },
      't9: 提交体含比例/版本/速度(niji 已拆成两个字段)');

    // 拒绝路径:点不到的东西一律当场 4xx,不进后台任务。
    assert.equal((await api('POST', '/api/image/actions', { jobId: 'nope', action: 'upscale', index: 1 })).status, 404, 't9: 不存在的任务 → 404');
    assert.equal((await api('POST', '/api/image/actions', { action: 'upscale', index: 1 })).status, 400, 't9: 缺 jobId → 400');
    const badIdx = await api('POST', '/api/image/actions', { jobId: gen.json.jobId, action: 'upscale', index: 9 });
    assert.equal(badIdx.status, 400, 't9【边界】:index 越界 → 400');
    assert.match(badIdx.json.error, /只能对第 1–4 张/, 't9: 越界给人话');
    assert.equal((await api('POST', '/api/image/actions', { jobId: gen.json.jobId, action: 'reroll', index: 1 })).status, 400, 't9: 未列入的动作 → 400');

    // 放大第 2 张(= 四宫格右上)。
    const act = await api('POST', '/api/image/actions', { jobId: gen.json.jobId, action: 'upscale', index: 2 });
    assert.equal(act.status, 200, `t9: 动作受理(${act.text})`);

    // 提交是 fire-and-forget(秒回 jobId,上游请求在后台发),所以先等条目落终态再验上游收到什么。
    const child = await waitDone(act.json.jobId);
    assert.equal(seen.action.length, 1, 't9: 上游只收到一次动作提交');
    assert.equal(seen.action[0].action, 'upscale', 't9: 打到 /upscale');
    assert.deepEqual(seen.action[0].body, { task_id: 'task_parent', index: 2, speed: 'fast' }, 't9: 动作体形态');
    assert.equal(seen.action[0].auth, 'Bearer sk-r84-e2e-secret', 't9: 动作带存储的密钥');
    assert.equal(child.status, 'done', `t9: 放大结果落盘(${child.error || ''})`);
    assert.equal(child.parentId, gen.json.jobId, 't9【可追溯】:记了父任务');
    assert.equal(child.mjAction, 'upscale', 't9【可追溯】:记了动作');
    assert.equal(child.mjIndex, 2, 't9【可追溯】:记了第几张');
    assert.equal(child.prompt, '一只猫', 't9: 沿用父任务的提示词(列表里能认出是哪一条)');
    assert.ok(child.file && !child.files, 't9: 单图结果不写 files 字段(与同步协议同形)');
    assert.equal(child.taskId, 'task_child', 't9: 子任务也记了自己的上游任务号(可以继续操作)');
    assert.equal(readdirSync(SAVE_DIR).length, 5, 't9: 磁盘上 4 + 1 张');
  } finally {
    server.closeAllConnections?.();
    server.close();
    await new Promise((r) => server.once('close', r));
  }
}

rmSync(TMP_HOME, { recursive: true, force: true });
rmSync(SAVE_DIR, { recursive: true, force: true });
console.log('✓ check-r84-mj-actions: mj 结构化参数 + 多图选中 + 清空 + U/V 动作 + 三协议回归锁 全部通过');

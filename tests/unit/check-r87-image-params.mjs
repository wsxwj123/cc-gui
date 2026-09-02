#!/usr/bin/env node
// 单测:r87 OpenAI 系生图参数面板 —— 上游方言(openai / apimart)二元能力表、参数下发、
// 实付与预估费用、模型「浏览」按钮。
// Run: node tests/unit/check-r87-image-params.mjs
//
// 核心牙:
//  ① 同名反义:apimart 的 `size` 是【宽高比串】,OpenAI 官方的 `size` 是【像素 WxH】。
//    所以「这个模型支持哪些 size」不能只看模型名,必须 (方言, 模型) 二元判断 —— 修前
//    imageSizeCaps 对 gpt-image-2 只按模型名判,把比例 token 与 K 档全过滤掉,
//    apimart 上的用户一个可用候选都没有。
//  ② 存量零变化:没有 dialect 字段的老 provider 一律按官方语义走,组装产物与 master
//    (基线 e6668bc9)逐字相同 —— 直接 import master 版函数对跑,不靠人工比对。
//  ③ 空值不发键:任何参数留空一律不出现在请求体里(发空串 = 显式指定了空值,上游会 400
//    或按空值处理);`extra` 仍在最后展开,同名键覆盖表单值(四种协议一致的逃生口)。
//  ④ 方言门:`resolution` / `nsfw_check` 是 apimart 独有字段,官方方言下【不许】出现
//    (官方 Images API 没有这两个键,发过去就是 400)。
//  ⑤ 费用宁缺勿错:实付取任务响应里的 `cost` / `credits_cost`(上游权威值);预估价只按
//    调研已复算命中的那条公式算(size_quality_prices[key][quality] × price_factor × 10),
//    任一字段缺失或形态不符一律返回 null 而不是猜一个数出来。
//
// 变异自证(先 commit 再变异,逐条实跑过"改坏就红";还原用 cp 副本):
//  - openai 分支删掉 resolution 下发那行            → t1 红
//  - imageDialect 把未知值也当 apimart              → t2 红
//  - 能力表 apimart 侧的 gpt-image-2 条目改成不匹配   → t3 红
//  - extractTaskState 不取 credits_cost             → t4 红
//  - estimateCredits 缺 price_factor 时按 1 兜底     → t4 红
//  - 删掉整个「浏览」按钮                            → t5 红
//  - 按钮还在但 onClick 改成空函数                   → t5 红
//  - 弹窗从 onPick 退回勾选形态(onConfirm)          → t5 红
//  - validateBody 不校验枚举白名单                   → t6 红
// ⚠️ 头一版 t5 只写 assert.match(src, /浏览/) —— 把按钮整块删掉都不红(那两个字在 title
//    的说明里也有)。变异跑出来才发现,已收紧成"按钮文本 + onClick 接线"两条。
//
// 隔离:HOME/USERPROFILE 指向 mktemp 目录(真实 ~/.claude-gui 一个字节不碰);
// 上游全是本机假服务,绝不打真实网络、绝不发生图请求。
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r87-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r87-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
// 轮询间隔调到 200ms(默认 5s):t8 要跑一个真任务到终态,不改这个每次要多等十几秒。
// 必须在 import server/routes/image.js 之前设 —— 那个常量是模块加载时读的。
process.env.CGUI_IMAGE_TASK_POLL_INTERVAL_MS = '200';
mkdirSync(join(TMP_HOME, '.claude-gui'), { recursive: true });

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = 'e6668bc9'; // r87 的基线 commit(master),回归锁对着它跑

const proto = await import('../../server/utils/image-protocols.js');
const {
  buildImageRequest, extractTaskState, imageDialect, dialectForBaseURL, imageCount,
  estimateCredits, IMAGE_DIALECTS, IMAGE_RESOLUTIONS, IMAGE_QUALITIES,
  IMAGE_OUTPUT_FORMATS, IMAGE_BACKGROUNDS, IMAGE_MODERATIONS, IMAGE_N_MAX, CREDITS_PER_USD,
} = proto;
const caps = await import('../../client/src/utils/imageSizeCaps.js');

const BASE = { baseURL: 'https://api.example.com/v1', apiKey: 'sk-r87-secret', model: 'gpt-image-2' };
const oa = (over) => buildImageRequest({ protocol: 'openai', ...BASE, ...over }, '一只猫');

// ─────────────────────── 1. 组装:方言 × 字段 ───────────────────────
{
  // 官方方言(缺省):像素 size,无 resolution / nsfw_check。
  const off = oa({ size: '1536x1024', quality: 'high', outputFormat: 'webp', background: 'transparent', moderation: 'low', n: 3 });
  assert.equal(off.url, 'https://api.example.com/v1/images/generations', 't1: 官方方言仍打 generations');
  assert.deepEqual(off.body, {
    model: 'gpt-image-2', prompt: '一只猫', n: 3, size: '1536x1024',
    quality: 'high', output_format: 'webp', background: 'transparent', moderation: 'low',
  }, 't1【官方方言】:交集字段按 wire 名下发,size 是像素串');
  assert.equal('resolution' in off.body, false, 't1【方言门】官方方言不许出现 resolution');
  assert.equal('nsfw_check' in off.body, false, 't1【方言门】官方方言不许出现 nsfw_check');

  // apimart 方言:size 是比例串 + resolution 档位 + nsfw_check。
  const am = oa({
    dialect: 'apimart', model: 'gpt-image-2-official', size: '16:9', resolution: '2k',
    quality: 'low', outputFormat: 'png', background: 'opaque', moderation: 'low', n: 2, nsfwCheck: true,
  });
  assert.deepEqual(am.body, {
    model: 'gpt-image-2-official', prompt: '一只猫', n: 2, size: '16:9', resolution: '2k',
    quality: 'low', output_format: 'png', background: 'opaque', moderation: 'low', nsfw_check: true,
  }, 't1【apimart 方言】:resolution 与 nsfw_check 一并下发,size 是比例串');

  // 空值一律不发键(不是发空串)。
  const bare = oa({ dialect: 'apimart' });
  assert.deepEqual(bare.body, { model: 'gpt-image-2', prompt: '一只猫', n: 1 },
    't1【空值不发键】:全部留空时只剩 model/prompt/n,且 n 默认 1(与 master 逐字一致)');
  for (const k of ['size', 'resolution', 'quality', 'output_format', 'background', 'moderation', 'nsfw_check']) {
    assert.equal(k in bare.body, false, `t1【空值不发键】${k} 不出现`);
  }
  // nsfwCheck=false 是"不预审"= 不发键(发 false 也算显式指定,徒增一次形态差异)。
  assert.equal('nsfw_check' in oa({ dialect: 'apimart', nsfwCheck: false }).body, false,
    't1: nsfw_check 为假时不发键');
  // 空串/非法枚举一律当没填(存量脏值不许原样发上去)。
  for (const bad of ['', '  ', 'HD', '8k', null, undefined, 0, {}]) {
    const b = oa({ dialect: 'apimart', resolution: bad, quality: bad, outputFormat: bad, background: bad, moderation: bad }).body;
    for (const k of ['resolution', 'quality', 'output_format', 'background', 'moderation']) {
      assert.equal(k in b, false, `t1【非法枚举 ${JSON.stringify(bad)}】${k} 不发键`);
    }
  }
  // 枚举值大小写与空白规整后再判(用户手改配置文件时的常见形态)。
  assert.equal(oa({ dialect: 'apimart', resolution: ' 2K ' }).body.resolution, '2k', 't1: resolution 归一成小写再发');

  // extra 最后展开 = 优先级最高(四种协议一致的逃生口)。
  assert.equal(oa({ dialect: 'apimart', size: '16:9', resolution: '2k', extra: { size: '21:9', resolution: '4k', n: 4 } }).body.size, '21:9',
    't1【extra 覆盖】size');
  assert.equal(oa({ dialect: 'apimart', resolution: '2k', extra: { resolution: '4k' } }).body.resolution, '4k',
    't1【extra 覆盖】resolution');
  assert.equal(oa({ n: 2, extra: { n: 4 } }).body.n, 4, 't1【extra 覆盖】n');

  // n:1–4,非法/越界一律回落 1(不静默把大数发上去)。
  assert.equal(imageCount(''), 1, 't1: n 空 → 1');
  assert.equal(imageCount(3), 3, 't1: n=3');
  assert.equal(imageCount('4'), 4, 't1: 字符串数字也认');
  assert.equal(IMAGE_N_MAX, 4, 't1: n 上限 4(文档 1~4)');
  for (const bad of [0, -1, 5, 99, 2.5, 'x', null, undefined, NaN, {}]) {
    assert.equal(imageCount(bad), 1, `t1【n 越界/非法 ${String(bad)}】回落 1`);
  }
  assert.equal(oa({ n: 9 }).body.n, 1, 't1: 越界 n 不发出去,按 1 走');
}

// ───────────── 1b. 回归锁:与 master 基线逐字对跑 ─────────────
// 把基线版的 image-protocols.js 拉到临时目录(连同它唯一的本地依赖 safe-path.js)直接
// import,新旧两份真函数同参对跑 —— 比人工比对可靠,也挡得住"以后有人顺手改了别的分支"。
{
  const dir = mkdtempSync(join(tmpdir(), 'cgui-r87-base-'));
  const oldSrc = execFileSync('git', ['show', `${BASELINE}:server/utils/image-protocols.js`], { cwd: REPO, maxBuffer: 8 << 20 });
  writeFileSync(join(dir, 'image-protocols.js'), oldSrc);
  copyFileSync(join(REPO, 'server/utils/safe-path.js'), join(dir, 'safe-path.js'));
  const old = await import(join(dir, 'image-protocols.js'));

  // FormData 不能 deepEqual:压成可比对的条目数组(Blob 只比类型与长度)。
  const norm = (r) => ({
    url: r.url,
    headers: r.headers,
    body: r.body,
    altHeaders: r.altHeaders,
    form: r.form ? [...r.form.entries()].map(([k, v]) => [k, v && typeof v === 'object' && 'size' in v ? `blob:${v.type}:${v.size}` : v]) : null,
  });
  const REF = [{ name: 'a.png', mime: 'image/png', base64: 'aGVsbG8=' }];
  // 新字段一律同时挂在 config 上:它们对别的协议分支必须零影响。
  const NEW_FIELDS = {
    dialect: 'apimart', resolution: '2k', quality: 'high', outputFormat: 'webp',
    background: 'transparent', moderation: 'low', nsfwCheck: true,
  };
  const cases = [];
  for (const protocol of ['gemini', 'chat', 'mj']) {
    for (const size of ['', '16:9', '1024x1024']) {
      for (const refs of [[], REF]) {
        cases.push([{ protocol, ...BASE, model: protocol === 'mj' ? 'midjourney' : 'm-1', size, mjVersion: '7', mjSpeed: 'fast', extra: { foo: 1 } }, refs]);
      }
    }
  }
  // openai:老字段组合(含 multipart edits 与方舟 generations-image 两条图生图路径)。
  for (const size of ['', '1024x1024']) {
    for (const i2iMode of ['edits', 'generations-image']) {
      for (const refs of [[], REF]) {
        cases.push([{ protocol: 'openai', ...BASE, size, i2iMode, extra: { foo: 1 } }, refs]);
      }
    }
  }
  for (const [cfg, refs] of cases) {
    const label = `${cfg.protocol}/${cfg.i2iMode || '-'}/size=${cfg.size || '空'}/refs=${refs.length}`;
    assert.deepEqual(norm(buildImageRequest(cfg, '猫', refs)), norm(old.buildImageRequest(cfg, '猫', refs)),
      `t1b【零差异】${label}:与基线 ${BASELINE} 逐字一致`);
    // 新字段挂上去也不许改变这些分支的产物(openai 的 edits multipart 同样不收新参数)。
    const withNew = { ...cfg, ...NEW_FIELDS };
    if (cfg.protocol !== 'openai' || (refs.length && cfg.i2iMode !== 'generations-image')) {
      assert.deepEqual(norm(buildImageRequest(withNew, '猫', refs)), norm(old.buildImageRequest(cfg, '猫', refs)),
        `t1b【新字段零影响】${label}`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

// ─────────────────────── 2. 方言判定 ───────────────────────
{
  assert.deepEqual(IMAGE_DIALECTS, ['openai', 'apimart'], 't2: 方言只有两种');
  // 缺省 = 官方语义(存量条目没有这个字段)。
  for (const cfg of [{}, null, undefined, { dialect: '' }, { dialect: 'openai' }, { dialect: 'APIMART' }, { dialect: 'x' }, { dialect: 1 }]) {
    assert.equal(imageDialect(cfg), 'openai', `t2【缺省/未知 ${JSON.stringify(cfg)}】= 官方语义`);
  }
  assert.equal(imageDialect({ dialect: 'apimart' }), 'apimart', 't2: 显式 apimart');

  // 按 baseURL host 预选:只认 api.apimart.ai 这一个 host(子域名/相似域名一律不算)。
  assert.equal(dialectForBaseURL('https://api.apimart.ai/v1'), 'apimart', 't2: apimart host 预选 apimart');
  assert.equal(dialectForBaseURL('https://API.ApiMart.AI/v1/'), 'apimart', 't2: host 比对不区分大小写');
  for (const u of ['https://api.openai.com/v1', 'https://apimart.ai/v1', 'https://api.apimart.ai.evil.com/v1',
    'https://xapi.apimart.ai/v1', '', 'not a url', null, undefined]) {
    assert.equal(dialectForBaseURL(u), 'openai', `t2【非 apimart ${String(u)}】预选官方`);
  }

  // 存量条目(无 dialect)的组装与基线逐字一致 —— 1b 已整体对跑过,这里再单点钉一次语义。
  const legacy = { protocol: 'openai', ...BASE, size: '1024x1024' };
  assert.deepEqual(buildImageRequest(legacy, '猫').body, { model: 'gpt-image-2', prompt: '猫', n: 1, size: '1024x1024' },
    't2【存量零变化】没有 dialect 的老条目走官方语义,body 与升级前相同');

  // 前后端同源:客户端能力表模块导出同名函数,行为必须一致(前端不 import 服务端代码,
  // 两份实现分居两处,不比对就会漂)。
  for (const cfg of [{}, { dialect: 'apimart' }, { dialect: 'openai' }, { dialect: 'zzz' }]) {
    assert.equal(caps.imageDialect(cfg), imageDialect(cfg), `t2【同源】imageDialect ${JSON.stringify(cfg)}`);
  }
  for (const u of ['https://api.apimart.ai/v1', 'https://api.openai.com/v1', 'nope']) {
    assert.equal(caps.dialectForBaseURL(u), dialectForBaseURL(u), `t2【同源】dialectForBaseURL ${u}`);
  }
}

// ─────────────────────── 3. 能力表:(方言, 模型) 二元 ───────────────────────
{
  const { sizeCapFor, sizeOptionsFor, APIMART_RATIOS, SIZE_OPTIONS } = caps;

  // ── 修前红:apimart 上的 gpt-image-2 一个可用候选都没有 ──
  const g2 = sizeCapFor('apimart', 'gpt-image-2');
  assert.ok(g2, 't3: apimart 侧 gpt-image-2 命中能力表');
  assert.equal(g2.sizeMode, 'ratio', 't3【apimart】size 是宽高比语义');
  for (const r of ['1:1', '16:9', '9:16', '21:9', '3:1', '9:21']) {
    assert.ok(g2.options.includes(r), `t3【apimart/gpt-image-2】候选必须含比例 ${r}`);
  }
  assert.deepEqual(g2.resolutions, ['1k', '2k', '4k'], 't3【apimart/gpt-image-2】K 档走 resolution 字段,三档齐全');
  assert.equal(g2.options.length, 16, 't3【apimart】15 种比例 + auto');

  // ── 官方方言:像素预设,且不含比例 ──
  const g2o = sizeCapFor('openai', 'gpt-image-2');
  assert.equal(g2o.sizeMode, 'pixel', 't3【官方】size 是像素语义');
  assert.ok(g2o.options.includes('3840x2160') && g2o.options.includes('auto'), 't3【官方/gpt-image-2】像素预设在位');
  assert.ok(!g2o.options.some((s) => s.includes(':')), 't3【官方/gpt-image-2】不许出现比例 token');
  assert.ok(!g2o.options.some((s) => /^\d+K$/i.test(s)), 't3【官方/gpt-image-2】不许出现 K 档 token');
  assert.equal(g2o.resolutions, null, 't3【官方】没有 resolution 字段');
  assert.ok(g2o.options.every((s) => SIZE_OPTIONS.includes(s)), 't3【官方】排除式过滤不许凭空造值');

  // ── 官方方言 = r56 的既有行为,一字不动(存量零变化) ──
  assert.deepEqual(sizeOptionsFor('openai', 'gpt-image-1'), ['auto', '1024x1024', '1536x1024', '1024x1536'], 't3: gpt-image-1 系封闭清单');
  assert.deepEqual(sizeOptionsFor('openai', 'dall-e-3'), ['1024x1024', '1792x1024', '1024x1792'], 't3: dall-e-3 恰 3 项');
  assert.deepEqual(sizeOptionsFor('openai', 'dall-e-2'), ['256x256', '512x512', '1024x1024'], 't3: dall-e-2 恰 3 项');
  assert.ok(sizeOptionsFor('openai', 'doubao-seedream-4-5').includes('4K'), 't3: seedream 保留 K 档');
  for (const m of ['flux-pro-1.1', 'my-relay-custom-model', '', null, undefined, 123]) {
    assert.equal(sizeOptionsFor('openai', m), null, `t3【官方/未知模型 ${String(m)}】回落全量(null)`);
    assert.equal(sizeCapFor('openai', m), null, `t3【官方/未知模型 ${String(m)}】没有条目`);
  }

  // ── apimart 的分家族能力(报告 §A-3 的支持模型矩阵) ──
  const g2official = sizeCapFor('apimart', 'gpt-image-2-official');
  assert.ok(g2official.fields.includes('quality') && g2official.fields.includes('background')
    && g2official.fields.includes('moderation') && g2official.fields.includes('outputFormat'),
  't3【G2O】官方渠道有 quality/background/moderation/output_format');
  assert.ok(g2official.formats.includes('webp'), 't3【G2O】output_format 三种');
  assert.ok(g2official.fields.includes('n'), 't3【G2O】n 可配(文档明列 1~4)');
  assert.deepEqual(g2official.resolutions, ['1k', '2k', '4k'], 't3【G2O】有 K 档');

  // 中转渠道 gpt-image-2:文档 Body 未列 quality/background/moderation/output_format,
  // n 又自相矛盾(定义写"取值:1"、示例给 n:2)→ 一律不放开,只留文档确定的三项。
  assert.ok(!g2.fields.includes('quality'), 't3【G2 中转】不放开 quality(文档未列)');
  assert.ok(!g2.fields.includes('background'), 't3【G2 中转】不放开 background');
  assert.ok(!g2.fields.includes('moderation'), 't3【G2 中转】不放开 moderation');
  assert.ok(!g2.fields.includes('outputFormat'), 't3【G2 中转】不放开 output_format');
  assert.ok(!g2.fields.includes('n'), 't3【G2 中转】n 文档自相矛盾,不放开');
  assert.ok(g2.fields.includes('nsfwCheck'), 't3【G2 中转】nsfw_check 三个渠道都有');

  // gpt-image-1 / 1.5 官方渠道:只有 3 种比例、无 K 档、output_format 无 webp。
  const g1o = sizeCapFor('apimart', 'gpt-image-1.5-official');
  assert.deepEqual(g1o.options, ['auto', '1:1', '3:2', '2:3'], 't3【G1O】比例只有文档明列的三种 + auto');
  assert.equal(g1o.resolutions, null, 't3【G1O】没有 resolution 字段');
  assert.deepEqual(g1o.formats, ['png', 'jpeg'], 't3【G1O】output_format 不含 webp');

  // apimart 未知模型:不回落 null(用户已明说上游是 apimart),但只给通用字段。
  const unknown = sizeCapFor('apimart', 'some-relay-image-model');
  assert.ok(unknown, 't3【apimart/未知模型】仍给一条通用条目(方言已由用户指定)');
  assert.equal(unknown.sizeMode, 'ratio', 't3【apimart/未知模型】按 apimart 的比例语义');
  assert.deepEqual(unknown.fields, ['size', 'n', 'nsfwCheck'], 't3【apimart/未知模型】只放开通用字段');
  assert.equal(unknown.resolutions, null, 't3【apimart/未知模型】不猜 K 档');

  // 比例芯片的用途标签(界面用):值与能力表候选同源。
  assert.ok(Array.isArray(APIMART_RATIOS) && APIMART_RATIOS.length === 16, 't3: 芯片表 15 比例 + auto');
  assert.deepEqual(APIMART_RATIOS.map(([v]) => v), g2.options, 't3: 芯片表的值与能力表候选逐字同源');
  for (const [v, use] of APIMART_RATIOS) {
    assert.ok(typeof use === 'string' && use.trim(), `t3: 比例 ${v} 有用途标签`);
  }

  // 命中条目的候选永远非空(空了就该回落,绝不给用户一个空下拉)。
  for (const [d, m] of [['apimart', 'gpt-image-2'], ['apimart', 'x'], ['openai', 'gpt-image-2'], ['openai', 'dall-e-2']]) {
    assert.ok(sizeOptionsFor(d, m).length > 0, `t3【${d}/${m}】候选非空`);
  }

  // 前端候选必须是服务端白名单的【子集】—— 两处不一致时前端能选出后端拒收的值
  // (r84「前端候选与服务端白名单同源」同款牙)。界面把"默认档"写成空串,故是子集不是等集。
  assert.deepEqual(caps.IMAGE_DIALECTS, IMAGE_DIALECTS, 't3【同源】方言清单两处一致');
  assert.deepEqual(caps.IMAGE_RESOLUTIONS, IMAGE_RESOLUTIONS, 't3【同源】分辨率档两处一致');
  for (const [d, m] of [['apimart', 'gpt-image-2-official'], ['apimart', 'gpt-image-1.5-official'],
    ['apimart', 'gpt-image-2'], ['apimart', 'zzz'], ['openai', 'gpt-image-2'], ['openai', 'gpt-image-1'],
    ['openai', 'dall-e-3'], ['openai', 'seedream-4.0']]) {
    const cap = sizeCapFor(d, m);
    if (!cap) continue;
    for (const q of cap.qualities || []) assert.ok(IMAGE_QUALITIES.includes(q), `t3【同源】${d}/${m} 的质量档 ${q} 在服务端白名单里`);
    for (const f of cap.formats || []) assert.ok(IMAGE_OUTPUT_FORMATS.includes(f), `t3【同源】${d}/${m} 的输出格式 ${f} 在服务端白名单里`);
    for (const r of cap.resolutions || []) assert.ok(IMAGE_RESOLUTIONS.includes(r), `t3【同源】${d}/${m} 的分辨率档 ${r} 在服务端白名单里`);
    // 放开了某个字段就必须给得出它的候选,否则界面上是个空下拉。
    if (cap.fields.includes('quality')) assert.ok(cap.qualities?.length, `t3【${d}/${m}】放开 quality 就必须给候选`);
    if (cap.fields.includes('outputFormat')) assert.ok(cap.formats?.length, `t3【${d}/${m}】放开 output_format 就必须给候选`);
    if (cap.fields.includes('resolution')) assert.ok(cap.resolutions?.length, `t3【${d}/${m}】放开 resolution 就必须给候选`);
  }
  // 官方方言不许放开 apimart 独有的两个字段(放开了界面就会让用户填一个必然 400 的值)。
  for (const m of ['gpt-image-2', 'gpt-image-1', 'dall-e-3', 'seedream-4.0']) {
    const cap = sizeCapFor('openai', m);
    assert.ok(!cap.fields.includes('resolution'), `t3【官方/${m}】不许放开 resolution`);
    assert.ok(!cap.fields.includes('nsfwCheck'), `t3【官方/${m}】不许放开 nsfw_check`);
  }
}

// ─────────────────────── 4. 费用:实付 + 预估 ───────────────────────
{
  // 4-1 实付:apimart 任务查询响应把扣费写在 data.cost / data.credits_cost。
  // fixture 逐字取自文档「查询任务结果」的成功响应样例(tasks_status.md ResponseExample)。
  const done = {
    code: 200,
    data: {
      id: 'task_01KA040M0HP1GJWBJYZMKX1XS1',
      status: 'completed',
      cost: 0.15,
      credits_cost: 1.5,
      progress: 100,
      result: { images: [{ url: ['https://upload.apimart.ai/f/image/a.png'], expires_at: 1763174708 }] },
      created: 1763088289,
      completed: 1763088308,
    },
  };
  const st = extractTaskState(done);
  assert.equal(st.status, 'completed', 't4: 终态');
  assert.deepEqual(st.urls, ['https://upload.apimart.ai/f/image/a.png'], 't4: 取图不受影响');
  assert.equal(st.cost, 0.15, 't4【实付】cost 取出来');
  assert.equal(st.creditsCost, 1.5, 't4【实付】credits_cost 取出来(驼峰化后进条目)');

  // 小数值(官方渠道页样例 0.004792 / 0.04792)原样保留,不做四舍五入。
  const tiny = extractTaskState({ data: { status: 'completed', cost: 0.004792, credits_cost: 0.047920000000000004, result: { images: [{ url: ['https://x/y.png'] }] } } });
  assert.equal(tiny.cost, 0.004792, 't4: 小额 cost 原样');
  assert.equal(tiny.creditsCost, 0.047920000000000004, 't4: 小额 credits_cost 原样');

  // 没有这两个键(MJ 等)一律 null,别写 0 —— 0 会被界面显示成"这次免费"。
  for (const d of [{ data: { status: 'processing' } }, { data: { status: 'completed', result: { images: [] } } },
    { data: { status: 'completed', cost: 'abc', credits_cost: null, result: { images: [] } } }, {}, null]) {
    const s = extractTaskState(d);
    assert.equal(s.cost, null, 't4【无扣费字段】cost = null 不是 0');
    assert.equal(s.creditsCost, null, 't4【无扣费字段】creditsCost = null 不是 0');
  }
  // 失败/取消同样把已扣费带出来(平台侧敏感词拦截也可能计费)。
  const failed = extractTaskState({ data: { status: 'failed', cost: 0.01, credits_cost: 0.1, error: { message: 'x' } } });
  assert.equal(failed.status, 'failed', 't4: 失败态');
  assert.equal(failed.creditsCost, 0.1, 't4【失败也可能计费】creditsCost 照样带出来');

  // 4-2 预估:只按调研已逐位复算命中的那条公式(报告 §A-5)。
  // fixture 取自实测 price-gi2o.json(model=gpt-image-2-official)的相关片段。
  const PRICING = {
    success: true,
    data: {
      model_name: 'gpt-image-2-official',
      supported_qualities: ['auto', 'low', 'medium', 'high'],
      size_quality_prices: {
        '16:9': { auto: 0.0038, low: 0.0038, medium: 0.0325, high: 0.1295 },
        '16:9@2k': { auto: 0.0049, low: 0.0049, medium: 0.0426, high: 0.1697 },
        '16:9@4k': { auto: 0.0113, low: 0.0113, medium: 0.1003, high: 0.4004 },
        '1:1': { auto: 0.0061, low: 0.0061, medium: 0.0529, high: 0.2109 },
      },
      pricing: { group: 'default', group_ratio: 0.8, discount_rate: 1, price_factor: 0.8 },
    },
  };
  assert.equal(CREDITS_PER_USD, 10, 't4: credits/USD 换算常量(唯一样例 0.004792→0.04792)');
  const round4 = (n) => (n === null ? null : Number(n.toFixed(4)));
  // 截图 RUN 按钮的 0.0392:16:9 + 2k + low。
  assert.equal(round4(estimateCredits(PRICING, { size: '16:9', resolution: '2k', quality: 'low' })), 0.0392,
    't4【预估】报告样例逐位命中 0.0392');
  // 1k 档的键是裸比例(没有 @1k 后缀);quality 省略按 auto。
  assert.equal(round4(estimateCredits(PRICING, { size: '16:9', resolution: '1k' })), 0.0304, 't4【预估】1k 档用裸比例键');
  assert.equal(round4(estimateCredits(PRICING, { size: '16:9' })), 0.0304, 't4【预估】不填 resolution 等同 1k');
  assert.equal(round4(estimateCredits(PRICING, { size: '16:9', resolution: '4k', quality: 'high' })), 3.2032, 't4【预估】4k+high');

  // 宁缺勿错:任一字段缺失/形态不符一律 null,绝不猜。
  const noFactor = { data: { ...PRICING.data, pricing: { group: 'default' } } };
  assert.equal(estimateCredits(noFactor, { size: '16:9', resolution: '2k', quality: 'low' }), null,
    't4【缺 price_factor】返回 null(不按 1 兜底)');
  assert.equal(estimateCredits({ data: { model_price: 0.04 } }, { size: '16:9' }), null, 't4【无 size_quality_prices】null');
  assert.equal(estimateCredits(PRICING, { size: '5:4', resolution: '2k', quality: 'low' }), null, 't4【表里没这个尺寸】null');
  // 白名单外的质量值 = 该键根本不会被下发(见 t1)→ 估价按上游默认的 auto 算,与实际请求一致。
  assert.equal(round4(estimateCredits(PRICING, { size: '16:9', resolution: '2k', quality: 'ultra' })), 0.0392,
    't4【白名单外的质量】按不下发处理,估价与实际请求口径一致');
  // 合法质量档但价格表里没有这一档 → null(不拿别的档冒充)。
  const noHigh = { data: { ...PRICING.data, size_quality_prices: { '16:9@2k': { auto: 0.0049, low: 0.0049 } } } };
  assert.equal(estimateCredits(noHigh, { size: '16:9', resolution: '2k', quality: 'high' }), null, 't4【价格表缺该质量档】null');
  assert.equal(estimateCredits(PRICING, { size: '', resolution: '2k' }), null, 't4【没选尺寸】null');
  for (const p of [null, undefined, {}, { data: null }, 'x', 42, { data: { size_quality_prices: 'x', pricing: { price_factor: 0.8 } } }]) {
    assert.equal(estimateCredits(p, { size: '16:9', resolution: '2k', quality: 'low' }), null, `t4【坏报价体 ${JSON.stringify(p)}】null`);
  }
  // 中转渠道形态(resolution_prices 大写 K、无 pricing 块)不在已验证公式的射程内 → null。
  assert.equal(estimateCredits({ data: { resolution_prices: { '1K': 0.010625, '2K': 0.0175 }, discount_percent: 20 } }, { size: '16:9', resolution: '2k' }), null,
    't4【中转渠道形态】没有已验证公式,不显示预估');
}

// ─────────────────────── 5. UI 接线源码锁 ───────────────────────
{
  const src = readFileSync(join(REPO, 'client/src/components/ImagePanel.jsx'), 'utf8');

  // 方言下拉 + 按 baseURL 预选。
  assert.match(src, /dialectForBaseURL/, 't5: 面板按 baseURL 预选方言');
  assert.match(src, /上游方言/, 't5: 方言字段有标签');
  assert.match(src, /dialect: form\.dialect/, 't5: 保存时带上方言');

  // apimart 面板:比例芯片 + resolution 分档 + 高级折叠区。
  assert.match(src, /APIMART_RATIOS/, 't5: 比例芯片读能力表模块的同一份值');
  assert.match(src, /resolution/, 't5: 分辨率档控件在位');
  assert.match(src, /<details/, 't5【折叠】高级参数默认收起(details 无 open 属性)');
  assert.ok(!/<details[^>]*\bopen\b/.test(src), 't5【折叠】不许写 open —— 默认必须是收起的');
  for (const label of ['质量', '输出格式', '背景', '审核强度', '提交前预审']) {
    assert.ok(src.includes(label), `t5: 高级参数「${label}」在位`);
  }
  // nsfw_check 与 moderation 是两件事,文案必须分清(否则用户当成重复开关)。
  assert.match(src, /审核强度[\s\S]{0,400}出图时/, 't5: moderation 文案说明是出图时的过滤松紧');
  assert.match(src, /提交前预审[\s\S]{0,400}额外/, 't5: nsfw_check 文案说明是提交前的额外审核');
  // 【文案不许指向没渲染出来的控件】—— 字段按 (方言, 模型) 显隐,写死的交叉引用会撒谎:
  //  · 官方方言下根本没有 nsfw_check,moderation 的说明却写"与「提交前预审」不同"(真机实测到);
  //  · apimart 中转渠道只放开 nsfw_check,折叠条却承诺"质量 / 输出格式 / 背景 / 审核"。
  // 两处都必须由 has() 派生。
  assert.match(src, /has\('nsfwCheck'\) \?[^\n]*提交前预审/, 't5【文案】moderation 的交叉引用按 nsfwCheck 是否渲染出来才写');
  assert.ok(!/高级参数（质量 \/ 输出格式 \/ 背景 \/ 审核）/.test(src), 't5【文案】折叠条摘要不许写死四项');
  assert.match(src, /ADVANCED_FIELD_LABELS\.filter\(\(\[f\]\) => has\(f\)\)/, 't5【文案】折叠条摘要按实际渲染的字段拼');

  // 模型「浏览」按钮:开 ModelPickModal,不用浮层(表单在滚动容器里)。
  // 锁按钮【文本 + 接线】两处 —— 只锁"出现过 浏览 两个字"太松:它在 title 里也有,
  // 把按钮整个删掉都不会红(实测的变异漏网,已就此收紧)。
  assert.match(src, />浏览<\/button>/, 't5【浏览按钮】在位(按钮文本,不是 title 里的说明)');
  assert.match(src, /onClick=\{\(\) => setBrowsing\(true\)\}/, 't5【浏览按钮】点了要真的开弹窗');
  assert.match(src, /onPick=\{\(id\) =>/, 't5【浏览按钮】用 ModelPickModal 的单选形态回填');
  assert.ok(!/AnchoredPopover/.test(src), 't5: 不许引入浮层(WKWebView 下表单内浮层定位/sticky 都踩过坑)');
  // 原生 datalist 过滤保留(键盘直接敲仍能过滤)。
  assert.match(src, /list="cgui-image-model-options"/, 't5: 保留 <input list> 原生过滤');

  // 实付显示。
  assert.match(src, /实付/, 't5【实付】任务列表显示上游扣费');
  assert.match(src, /creditsCost/, 't5【实付】读的是条目里的 creditsCost');
  // 预估价:只在 apimart 方言下显示,且拿不到就不显示。
  assert.match(src, /预估约/, 't5【预估】生成按钮旁的预估文案');
  assert.match(src, /image\/pricing/, 't5【预估】走服务端报价代理端点');

  // 能力表接线改成二元。
  assert.match(src, /sizeCapFor\(dialect, form\.model\)/, 't5: 能力表按 (方言, 模型) 二元查');

  const modal = readFileSync(join(REPO, 'client/src/components/ModelPickModal.jsx'), 'utf8');
  assert.match(modal, /onPick/, 't5: 弹窗支持单选回填形态');
  assert.match(modal, /flex flex-col/, 't5: 弹窗仍是 flex 列三段(不用 sticky)');
}

// ─────────────────────── 6. 服务端:白名单校验 + 回显 ───────────────────────
const express = (await import('express')).default;
const imageRouter = (await import('../../server/routes/image.js')).default;
const app = express();
app.use(express.json({ limit: '32mb' }));
app.use('/api', imageRouter);
const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const PORT = srv.address().port;
const api = async (path, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const NEW_PROVIDER = {
  name: 'r87', protocol: 'openai', baseURL: 'https://api.apimart.ai/v1',
  model: 'gpt-image-2-official', savePath: SAVE_DIR, apiKey: 'sk-r87',
};
{
  // 合法值全通,且原样回显(前端编辑表单靠回显回填)。
  const ok = await api('/image-providers', {
    method: 'POST',
    body: JSON.stringify({
      ...NEW_PROVIDER, dialect: 'apimart', size: '16:9', resolution: '2k', quality: 'high',
      outputFormat: 'webp', background: 'transparent', moderation: 'low', n: 3, nsfwCheck: true,
    }),
  });
  assert.equal(ok.status, 200, `t6: 合法参数保存成功(实际:${JSON.stringify(ok.json)})`);
  const list = await api('/image-providers');
  const p = list.json.providers.find((x) => x.id === ok.json.id);
  assert.equal(p.dialect, 'apimart', 't6【回显】dialect');
  assert.equal(p.resolution, '2k', 't6【回显】resolution');
  assert.equal(p.quality, 'high', 't6【回显】quality');
  assert.equal(p.outputFormat, 'webp', 't6【回显】outputFormat');
  assert.equal(p.background, 'transparent', 't6【回显】background');
  assert.equal(p.moderation, 'low', 't6【回显】moderation');
  assert.equal(p.n, 3, 't6【回显】n');
  assert.equal(p.nsfwCheck, true, 't6【回显】nsfwCheck');
  assert.equal(p.apiKey, undefined, 't6: 出参永远不含 apiKey');

  // 非法值当场 400(这些值会原样进请求体,不做白名单 = 表单里能填什么上游就收到什么)。
  for (const [k, v] of [['dialect', 'x'], ['resolution', '8k'], ['quality', 'ultra'],
    ['outputFormat', 'bmp'], ['background', 'blur'], ['moderation', 'strict'],
    ['n', 9], ['n', 0], ['n', 'many'], ['nsfwCheck', 'yes']]) {
    const bad = await api('/image-providers', { method: 'POST', body: JSON.stringify({ ...NEW_PROVIDER, [k]: v }) });
    assert.equal(bad.status, 400, `t6【非法 ${k}=${v}】必须 400`);
    assert.ok(String(bad.json.error || '').length > 4, `t6【非法 ${k}】错误文案不是空的`);
  }
  // 存量条目:一个新字段都不传照样能存,回显为缺省(方言 openai / 其余空)。
  const legacy = await api('/image-providers', { method: 'POST', body: JSON.stringify(NEW_PROVIDER) });
  assert.equal(legacy.status, 200, 't6【存量形态】不传新字段照样保存');
  const lp = (await api('/image-providers')).json.providers.find((x) => x.id === legacy.json.id);
  assert.equal(lp.dialect, 'openai', 't6【存量形态】方言缺省 = 官方');
  assert.deepEqual([lp.resolution, lp.quality, lp.outputFormat, lp.background, lp.moderation, lp.n, lp.nsfwCheck],
    ['', '', '', '', '', '', false], 't6【存量形态】其余字段缺省为空');
}

// ─────────────────────── 7. 报价代理端点:免鉴权 + 缓存 + 失败静默 ───────────────────────
{
  let hits = 0;
  let payload = {
    success: true,
    data: {
      size_quality_prices: { '16:9@2k': { auto: 0.0049, low: 0.0049, medium: 0.0426, high: 0.1697 } },
      pricing: { price_factor: 0.8 },
    },
  };
  let authSeen = 'none';
  const upstream = http.createServer((req, res) => {
    hits += 1;
    authSeen = req.headers.authorization || 'none';
    if (!req.url.startsWith('/api/pricing/model?model=')) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${upstream.address().port}/v1`;

  const created = await api('/image-providers', {
    method: 'POST',
    body: JSON.stringify({
      ...NEW_PROVIDER, baseURL: upBase, dialect: 'apimart',
      size: '16:9', resolution: '2k', quality: 'low',
    }),
  });
  assert.equal(created.status, 200, 't7: mock 上游 provider 建好');
  const id = created.json.id;

  const q1 = await api(`/image/pricing?providerId=${id}`);
  assert.equal(q1.status, 200, 't7: 报价查询 200');
  assert.equal(Number(q1.json.credits.toFixed(4)), 0.0392, 't7【预估】端到端算出 0.0392');
  assert.equal(authSeen, 'none', 't7【免鉴权】绝不把 apiKey 带到报价接口');
  assert.equal(hits, 1, 't7: 打了一次上游');

  // 10 分钟缓存:同一 (origin, model) 不再打上游。
  payload = { success: true, data: {} }; // 上游改了也不影响缓存期内的结果
  const q2 = await api(`/image/pricing?providerId=${id}`);
  assert.equal(Number(q2.json.credits.toFixed(4)), 0.0392, 't7【缓存】缓存期内结果不变');
  assert.equal(hits, 1, 't7【缓存】没有再打上游');

  // 官方方言不查报价(官方没有这个接口)。
  const off = await api('/image-providers', { method: 'POST', body: JSON.stringify({ ...NEW_PROVIDER, baseURL: upBase }) });
  const q3 = await api(`/image/pricing?providerId=${off.json.id}`);
  assert.equal(q3.status, 200, 't7: 官方方言也是 200(不报错)');
  assert.equal(q3.json.credits, null, 't7【官方方言】不给预估');
  assert.equal(hits, 1, 't7【官方方言】一次上游都不打');

  // 未知 provider / 上游挂掉 → 静默 null,不把界面搞崩。
  assert.equal((await api('/image/pricing?providerId=nope')).json.credits, null, 't7【未知 provider】null');
  await new Promise((r) => upstream.close(r));
  const dead = await api('/image-providers', {
    method: 'POST',
    body: JSON.stringify({ ...NEW_PROVIDER, baseURL: `http://127.0.0.1:${upstream.address()?.port || 59999}/v1`, dialect: 'apimart', size: '16:9' }),
  });
  const q4 = await api(`/image/pricing?providerId=${dead.json.id}`);
  assert.equal(q4.status, 200, 't7【上游挂掉】仍是 200');
  assert.equal(q4.json.credits, null, 't7【上游挂掉】静默 null');
}

// ───────── 8. 实付端到端:上游【只给 credits_cost】时,条目里也得有实付 ─────────
// extractTaskState 把 cost 与 credits_cost 【分别】判空,而界面优先显示 creditsCost。
// runImageJob 里那道门若只看 cost,上游只给 credits_cost 就一个字都显示不出来 ——
// 这条用例是那道门的牙(单测 t4 只到纯函数,门在路由里)。
{
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = `http://127.0.0.1:${PORT}/up`;
  // 路由在 listen 之后追加(express 支持);路径与 /api 不重叠。
  app.post('/up/v1/images/generations', (_req, res) => res.json({ code: 200, data: [{ task_id: 'task_r87_credits' }] }));
  app.get('/up/v1/tasks/:id', (_req, res) => res.json({
    code: 200,
    // 【故意只给 credits_cost,不给 cost】—— 这正是那道门会漏掉的形态。
    data: { status: 'completed', progress: 100, credits_cost: 0.0479, result: { images: [{ url: [`${up}/img.png`] }] } },
  }));
  app.get('/up/img.png', (_req, res) => res.type('image/png').send(PNG));

  const mk = await api('/image-providers', {
    method: 'POST',
    body: JSON.stringify({ ...NEW_PROVIDER, baseURL: `${up}/v1`, dialect: 'apimart', size: '16:9' }),
  });
  assert.equal(mk.status, 200, `t8: 任务制假上游 provider 建得起来(${JSON.stringify(mk.json)})`);
  const sub = await api('/image/generate', { method: 'POST', body: JSON.stringify({ providerId: mk.json.id, prompt: '一只猫' }) });
  assert.equal(sub.status, 200, `t8: 提交受理(${JSON.stringify(sub.json)})`);

  let entry = null;
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    const h = await api('/image/history');
    entry = (h.json?.history || []).find((e) => e.id === sub.json.jobId) || null;
    if (entry && entry.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(entry, 't8: 历史里找得到这条任务');
  assert.equal(entry.status, 'done', `t8: 任务跑到完成(${entry.error || ''})`);
  assert.equal(entry.creditsCost, 0.0479, 't8【只给 credits_cost】实付照样落进条目(那道门必须两个键各自判空)');
  assert.equal(entry.cost, null, 't8: 上游没给 cost 就是 null,不是 0');
}

await new Promise((r) => srv.close(r));
rmSync(TMP_HOME, { recursive: true, force: true });
rmSync(SAVE_DIR, { recursive: true, force: true });
console.log('✓ check-r87-image-params: 方言二元能力表 / 参数下发 / 实付与预估费用 / 浏览按钮 全部通过');

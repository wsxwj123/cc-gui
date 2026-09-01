#!/usr/bin/env node
// 单测:r52 模型勾选(文本 provider + 生图 provider 通用的 ModelPickModal)。
// 核心牙:①mergeModelLines 只增不减(重新拉取绝不重置用户已选)②selectAllTargets
// 只作用于筛选结果且跳过已添加(上百模型时"全选"不炸)③stripJunkModels 过滤中转站
// 目录噪音 ④生图 provider 的 models 白名单落盘(校验矩阵 + publicView 不漏 key)。
// Run: node tests/unit/check-r52-model-pick.mjs
//
// 隔离:HOME/USERPROFILE 指向 mktemp 目录(真实 ~/.claude-gui 一个字节不碰);端口取 OS 临时口(listen(0),真实端口从 server.address() 读回)。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r52-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r52-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'sk-r52-stored-secret-abcdef123456';

// ─────────────────── 1. 纯函数直击 ───────────────────
const { filterModels, selectAllTargets, mergeModelLines, stripJunkModels, JUNK_MODEL_RE } =
  await import('../../client/src/utils/modelPick.js');

// 1.1 mergeModelLines:保序 / 追加 / 去重 / 绝不删除
{
  assert.deepEqual(
    mergeModelLines(['a', 'b'], ['c']), ['a', 'b', 'c'],
    't1.1: 原行序在前,新选的追加在后',
  );
  // 【核心牙】existing 有 A、checked 不含 A → 结果仍含 A(重新拉取只增不减)
  assert.deepEqual(
    mergeModelLines(['A', 'b'], ['c']), ['A', 'b', 'c'],
    't1.1【只增不减】:未被勾选的已有模型必须原样保留',
  );
  assert.deepEqual(
    mergeModelLines(['a', 'b'], ['b', 'a', 'c']), ['a', 'b', 'c'],
    't1.1: 已有项再次被勾选不产生重复行',
  );
  assert.deepEqual(
    mergeModelLines(['a', 'a', 'b'], ['b', 'b', 'd', 'd']), ['a', 'b', 'd'],
    't1.1: existing 与 checked 内部的重复都要去掉',
  );
  assert.deepEqual(
    mergeModelLines([' a ', '', '  '], ['  c  ']), ['a', 'c'],
    't1.1: 逐条 trim,空行丢弃',
  );
  assert.deepEqual(mergeModelLines(undefined, undefined), [], 't1.1: 缺参不炸');
  const orig = ['a'];
  mergeModelLines(orig, ['b']);
  assert.deepEqual(orig, ['a'], 't1.1: 不就地改入参数组');
}

// 1.2 selectAllTargets:只作用于筛选结果,且跳过已添加
{
  assert.deepEqual(
    selectAllTargets(['a', 'b', 'c'], new Set(['b'])), ['a', 'c'],
    't1.2【跳过已添加】:已在白名单里的不进全选目标',
  );
  assert.deepEqual(
    selectAllTargets(['a', 'b'], new Set()), ['a', 'b'],
    't1.2: 无已添加项时筛选结果全进',
  );
  assert.deepEqual(
    selectAllTargets([], new Set(['a'])), [],
    't1.2: 筛选结果为空 = 全选无目标(不去碰筛选外的候选)',
  );
  assert.deepEqual(
    selectAllTargets(['a', 'b'], ['b']), ['a'],
    't1.2: existing 传数组也认(调用方不必先建 Set)',
  );
}

// 1.3 filterModels:子串、不区分大小写
{
  assert.deepEqual(
    filterModels(['GPT-4o', 'claude-opus', 'Gemini'], 'gpt'), ['GPT-4o'],
    't1.3: 小写查询命中大写候选',
  );
  assert.deepEqual(
    filterModels(['gpt-4o', 'claude-opus'], 'OPUS'), ['claude-opus'],
    't1.3: 大写查询命中小写候选',
  );
  assert.deepEqual(
    filterModels(['a', 'b'], '   '), ['a', 'b'],
    't1.3: 空白查询 = 不过滤',
  );
  assert.deepEqual(
    filterModels(['a', 'b'], 'zzz'), [],
    't1.3: 无命中返回空',
  );
}

// 1.4 stripJunkModels:六类噪音各拒,正常 id 放行
{
  for (const junk of [
    'text-embedding-3-large', 'tts-1-hd', 'whisper-large-v3',
    'sora-video-001', 'flux-1.1-pro', 'bge-reranker-v2',
  ]) {
    assert.deepEqual(stripJunkModels([junk]), [], `t1.4: ${junk} 应被过滤`);
    assert.ok(JUNK_MODEL_RE.test(junk), `t1.4: JUNK_MODEL_RE 命中 ${junk}`);
  }
  assert.deepEqual(
    stripJunkModels(['gpt-5.2', 'claude-opus-4-8', 'deepseek-chat', 'gemini-3-pro']),
    ['gpt-5.2', 'claude-opus-4-8', 'deepseek-chat', 'gemini-3-pro'],
    't1.4: 正常模型 id 一律放行',
  );
  assert.deepEqual(
    stripJunkModels(['gpt-5.2', 'TTS-1', 'claude-opus-4-8']),
    ['gpt-5.2', 'claude-opus-4-8'],
    't1.4: 混合列表只去掉噪音,顺序不变;大小写不敏感',
  );
  assert.deepEqual(stripJunkModels(null), [], 't1.4: 非数组入参返回空数组');
}

// 1.5 场景口径:生图路径不许误杀 FLUX / 视频类(它们正是生图模型),聊天路径全表照旧
{
  assert.deepEqual(
    stripJunkModels(['flux.1-dev', 'flux-pro-1.1', 'sora-video-001'], 'image'),
    ['flux.1-dev', 'flux-pro-1.1', 'sora-video-001'],
    't1.5【生图口径】:flux / video 是生图模型本体,必须保留',
  );
  assert.deepEqual(
    stripJunkModels(['flux.1-dev', 'text-embedding-3-large', 'tts-1', 'whisper-1', 'bge-reranker-v2'], 'image'),
    ['flux.1-dev'],
    't1.5【生图口径】:embedding / tts / whisper / rerank 仍要过滤',
  );
  assert.deepEqual(
    stripJunkModels(['flux.1-dev', 'gpt-5.2'], 'chat'), ['gpt-5.2'],
    't1.5【聊天口径】:flux 仍被过滤(对话场景用不上)',
  );
  assert.deepEqual(
    stripJunkModels(['flux.1-dev', 'gpt-5.2']), ['gpt-5.2'],
    't1.5: 默认口径 = 聊天(既有调用方不传场景,行为不变)',
  );
}

// ─────────────────── 2. 生图 provider 的 models 白名单字段(端到端) ───────────────────
const express = (await import('express')).default;
const imageRouter = (await import('../../server/routes/image.js')).default;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', imageRouter);

const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};
const baseBody = (extra = {}) => ({
  name: 'r52', protocol: 'openai', baseURL: 'https://api.example.com/v1',
  model: 'gpt-image-2', savePath: SAVE_DIR, ...extra,
});

let failure = null;
try {
  // 2.1 校验矩阵:非数组 / 超长条 / 超 200 条 一律 400
  {
    const notArr = await api('POST', '/api/image-providers', baseBody({ models: 'gpt-image-2' }));
    assert.equal(notArr.status, 400, `t2.1: models 非数组 → 400(${notArr.text})`);

    const notStr = await api('POST', '/api/image-providers', baseBody({ models: ['ok', 42] }));
    assert.equal(notStr.status, 400, `t2.1: models 含非字符串 → 400(${notStr.text})`);

    const tooLong = await api('POST', '/api/image-providers', baseBody({ models: ['a'.repeat(129)] }));
    assert.equal(tooLong.status, 400, `t2.1: 单条 >128 字符 → 400(${tooLong.text})`);

    const okLen = await api('POST', '/api/image-providers', baseBody({ name: 'r52-len', models: ['a'.repeat(128)] }));
    assert.equal(okLen.status, 200, `t2.1: 单条正好 128 字符放行(${okLen.text})`);
    await api('DELETE', `/api/image-providers/${okLen.json.id}`);

    const tooMany = await api('POST', '/api/image-providers', baseBody({
      models: Array.from({ length: 201 }, (_, i) => `m-${i}`),
    }));
    assert.equal(tooMany.status, 400, `t2.1: 总数 >200 → 400(${tooMany.text})`);

    const ok200 = await api('POST', '/api/image-providers', baseBody({
      name: 'r52-200', models: Array.from({ length: 200 }, (_, i) => `m-${i}`),
    }));
    assert.equal(ok200.status, 200, `t2.1: 正好 200 条放行(${ok200.text})`);
    await api('DELETE', `/api/image-providers/${ok200.json.id}`);
  }

  // 2.2 POST/PUT 持久化 + publicView 含 models 不含 apiKey
  {
    const mk = await api('POST', '/api/image-providers', baseBody({ models: ['gpt-image-2'], apiKey: KEY }));
    assert.equal(mk.status, 200, `t2.2: 建 provider(${mk.text})`);
    const id = mk.json.id;

    let list = await api('GET', '/api/image-providers');
    let row = list.json.providers.find((p) => p.id === id);
    assert.deepEqual(row.models, ['gpt-image-2'], 't2.2: POST 的 models 落盘并经 publicView 下发');
    assert.equal(row.hasKey, true, 't2.2: hasKey 布尔仍在');
    assert.ok(!('apiKey' in row), 't2.2: publicView 白名单不含 apiKey');
    assert.ok(!list.text.includes(KEY), 't2.2: 列表响应一个字节都不含明文 key');

    // PUT 覆盖(前端发的是 mergeModelLines 的结果 = 全量),留空 key 不抹掉存储 key
    const put = await api('PUT', `/api/image-providers/${id}`, baseBody({ models: ['gpt-image-2', 'dall-e-3'] }));
    assert.equal(put.status, 200, `t2.2: PUT(${put.text})`);
    list = await api('GET', '/api/image-providers');
    row = list.json.providers.find((p) => p.id === id);
    assert.deepEqual(row.models, ['gpt-image-2', 'dall-e-3'], 't2.2: PUT 的 models 持久化');
    assert.equal(row.hasKey, true, 't2.2: PUT 留空 apiKey 仍保留存储 key');

    // 不传 models = 保留旧值(与 apiKey 同语义:客户端没发就别动)
    const keep = await api('PUT', `/api/image-providers/${id}`, baseBody({}));
    assert.equal(keep.status, 200, `t2.2: 不带 models 的 PUT(${keep.text})`);
    list = await api('GET', '/api/image-providers');
    row = list.json.providers.find((p) => p.id === id);
    assert.deepEqual(row.models, ['gpt-image-2', 'dall-e-3'], 't2.2: 不传 models 不清空已存白名单');

    // 显式传空数组 = 清空(用户真删光了)
    const clear = await api('PUT', `/api/image-providers/${id}`, baseBody({ models: [] }));
    assert.equal(clear.status, 200, `t2.2: 清空(${clear.text})`);
    list = await api('GET', '/api/image-providers');
    row = list.json.providers.find((p) => p.id === id);
    assert.deepEqual(row.models, [], 't2.2: 显式空数组清空白名单');

    await api('DELETE', `/api/image-providers/${id}`);
  }

  // 2.3 存量条目(无 models 字段)不炸:publicView 回空数组
  {
    const mk = await api('POST', '/api/image-providers', baseBody({ name: 'r52-legacy' }));
    const list = await api('GET', '/api/image-providers');
    const row = list.json.providers.find((p) => p.id === mk.json.id);
    assert.deepEqual(row.models, [], 't2.3: 未配置白名单的条目下发空数组(前端 map 不炸)');
    await api('DELETE', `/api/image-providers/${mk.json.id}`);
  }
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => server.once('close', r));
  for (const d of [TMP_HOME, SAVE_DIR]) rmSync(d, { recursive: true, force: true });
}
if (failure) throw failure;

// ─────────────────── 3. 前端源码断言 ───────────────────
const read = (p) => readFileSync(join(REPO, p), 'utf8');

// 3.1 弹窗组件:文案 / portal / flex 列三段 / 禁 sticky 与原生 confirm
{
  const src = read('client/src/components/ModelPickModal.jsx');
  for (const copy of ['选择要添加的模型', '已添加', '已选中', '全选', '全不选', '确认', '取消']) {
    assert.ok(src.includes(copy), `t3.1: 弹窗文案含「${copy}」`);
  }
  assert.match(src, /createPortal/, 't3.1: portal 到 body(弹层祖先带 transform 会困住 fixed 遮罩)');
  assert.match(src, /flex flex-col/, 't3.1: flex 列三段结构');
  assert.ok(
    !/class(?:Name)?=["'`][^"'`]*\bsticky\b/.test(src),
    't3.1【模态红线】className 里不许出现 sticky(WKWebView 的 transform 滚动容器内 sticky 失效)',
  );
  assert.ok(!/window\.(confirm|alert)\s*\(/.test(src), 't3.1【模态红线】不许用原生 confirm/alert');
  assert.match(src, /disabled=\{[^}]*checked\.size/, 't3.1: 0 选中时确认按钮 disabled');
  // Esc 相位:仓内浮层惯例 = window 捕获 + 截断(document 冒泡排在相位链最末,会被
  // 弹层/面板/管理弹窗的 window 捕获全员抢跑 → Esc 关错层、勾选连同未保存表单一起丢)。
  assert.match(
    src, /window\.addEventListener\('keydown',\s*\w+,\s*true\)/,
    't3.1【相位】Esc 挂 window 捕获(对齐 ImageLightbox),不挂 document 冒泡',
  );
  assert.ok(
    !/document\.addEventListener\('keydown'/.test(src),
    't3.1【相位】不许再挂 document 键盘监听',
  );
  assert.match(src, /stopImmediatePropagation/, 't3.1【相位】截断同相位其余 Esc 处理');
  // 宿主让行用的标记 + 压过 AnchoredPopover 的内联 zIndex:9999
  // 匹配**属性**而非注释里的同名字样:变异实测「删掉属性只留注释」曾骗过宽松写法。
  assert.match(src, /data-cgui-modelpick=/, 't3.1: 弹窗根挂 data-cgui-modelpick 属性(供宿主查询式让行)');
  const z = src.match(/z-\[(\d+)\]/);
  assert.ok(z && Number(z[1]) > 9999, `t3.1: z 值须压过弹层的内联 zIndex:9999(当前 ${z?.[1]})`);
}

// 3.1b 三个宿主的 Esc 让行/避让(判官必修 1)
{
  const app = read('client/src/App.jsx');
  const sel = read('client/src/components/SessionSelectors.jsx');
  assert.equal(
    (app.match(/\[data-cgui-modelpick\]/g) || []).length, 2,
    't3.1b: App 侧两个宿主(Provider 管理弹窗 Esc、右侧面板 Esc 守卫)各查一次标记让行',
  );
  assert.match(
    app, /if \(document\.querySelector\('\[data-cgui-modelpick\]'\)\) return;[\s\S]{0,200}tryClose\(\)/,
    't3.1b: Provider 管理弹窗的 Esc 在 tryClose 前让行(否则跳过弹窗直接整窗关闭,勾选丢)',
  );
  assert.match(
    sel, /setOpen\(false\);\s*setPickCandidates\(candidates\)|setPickCandidates\(candidates\);\s*setOpen\(false\)/,
    't3.1b: 开勾选弹窗时先关掉下层 AnchoredPopover(消掉 z 压盖与 Esc 竞争)',
  );
}

// 3.2 文本 provider 表单:fetchModels 走弹窗,不再直写全量到 modelsText
{
  const src = read('client/src/App.jsx');
  assert.ok(
    !src.includes('setModelsText(d.models.join'),
    't3.2: fetchModels 不再把全量目录直灌进模型文本域(改走勾选弹窗)',
  );
  assert.match(src, /ModelPickModal/, 't3.2: 表单挂了勾选弹窗');
  assert.match(src, /mergeModelLines\(/, 't3.2: 确认后走 mergeModelLines 写回(只增不减)');
  assert.match(src, /stripJunkModels\(/, 't3.2: 候选先过滤噪音');
}

// 3.3 聊天模型弹窗:自定义 provider 不并入实时目录,官方分支照旧并入(反向钉,防一刀切)
{
  const src = read('client/src/components/SessionSelectors.jsx');
  assert.match(
    src, /const fetchedRows = \(isCustomProvider \? EMPTY_ARRAY : fetched\)/,
    't3.3: 自定义 provider 列表不并 fetchedByProvider;非自定义(官方)仍并入 —— 同一行钉死两个方向',
  );
  assert.match(src, /ModelPickModal/, 't3.3: 「拉取最新」开同一个勾选弹窗');
  assert.match(
    src, /\/api\/custom-providers\/\$\{/,
    't3.3: 勾选结果持久化进该 provider(调既有 custom-providers 更新端点)',
  );
  assert.match(src, /method: 'PUT'/, 't3.3: 用 PUT 更新');
  assert.match(src, /mergeModelLines\(/, 't3.3: merge 语义(重新拉取不重置已选)');
}

// 3.4 生图 provider:datalist 数据源 = provider.models(持久化白名单),不再是会话级拉取结果
{
  const src = read('client/src/components/ImagePanel.jsx');
  assert.match(src, /\{\(form\.models \|\| \[\]\)\.map\(/, 't3.4: datalist 渲染 form.models');
  assert.ok(!/\{models\.map\(/.test(src), 't3.4: 不再渲染会话级拉取结果');
  assert.match(src, /ModelPickModal/, 't3.4: 「拉取模型」开勾选弹窗');
  assert.match(
    src, /stripJunkModels\([^)]*,\s*'image'\)/,
    "t3.4【生图口径】过滤走 'image' 场景(否则 FLUX 全家被误杀,还谎报「服务返回了空的模型列表」)",
  );
  assert.match(src, /mergeModelLines\(/, 't3.4: 勾选结果 merge 进 form.models');
  assert.match(src, /models: form\.models/, 't3.4: 保存时把白名单写进 provider');
}

console.log('✓ check-r52-model-pick: 纯函数(只增不减/全选跳过已加/大小写/噪音过滤)+ 生图 models 白名单落盘 + 三处接线 全部通过');

#!/usr/bin/env node
// 批P:第三方模型名残留的三层防线。
// 症状:切回「Claude 官方」后模型仍显示/仍被写成 deepseek-chat 之类,发消息直接报错。
// 根因:cc-switch 的"通用配置"把第三方的 baseURL/token/模型名漏进每个 provider 的
// settings_config,官方 provider 只是运行时忽略它们 —— 一旦这些模型名进了
// ~/.claude/settings.json 的 env,GUI 的读点、写点、选择器就都跟着跑偏。
// 三层:① 写入拒绝(setDefaultModel)② 读取自愈(getDefaultModel/healForeignModel)
//       ③ 选择器标异常(ModelSelector)。判据必须同源,故只有一份 isClaudeModel。
// 本测试全程只用 fixture,绝不读写真实 ~/.claude/settings.json。
// node tests/unit/check-model-residue-guard.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isClaudeModel, isOfficialAnthropic, isForeignModelResidue, healForeignModel,
} from '../../server/services/model-resolver.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 0. 两个基础判据 ──────────────────────────────────────────────────────
{
  assert.equal(isOfficialAnthropic(''), true, '无 BASE_URL = CLI 默认端点 = 官方');
  assert.equal(isOfficialAnthropic('https://api.anthropic.com'), true);
  assert.equal(isOfficialAnthropic('https://api.deepseek.com/anthropic'), false);
  assert.equal(isOfficialAnthropic('http://127.0.0.1:8788'), false, '环回=本地代理=第三方,不是官方');
  assert.equal(isOfficialAnthropic('not a url'), false, '解析不了一律按非官方(保守)');

  assert.equal(isClaudeModel('claude-sonnet-4-6'), true);
  assert.equal(isClaudeModel('sonnet'), true, 'CLI tier 别名算 claude');
  assert.equal(isClaudeModel('fable'), true);
  assert.equal(isClaudeModel('deepseek-chat'), false);
  assert.equal(isClaudeModel(''), false);
  assert.equal(isClaudeModel(undefined), false);
  // [1m] 是 Claude Code 的 1M 上下文后缀,不是模型名的一部分。剥掉再判,否则官方端点上
  // 完全合法的 sonnet[1m] 会被当成外部模型名拒掉(会让 1M 开关在官方下直接不可用)。
  assert.equal(isClaudeModel('sonnet[1m]'), true, '[1m] 后缀不得让 claude 别名被误判为外部模型');
  assert.equal(isClaudeModel('claude-sonnet-4-6[1m]'), true);
  assert.equal(isClaudeModel('deepseek-chat[1m]'), false, '剥后缀不得把外部模型名放行');
}

// ── 1. 残留判据:官方+非claude→命中;第三方→放行;官方+claude→放行 ────────
{
  assert.equal(isForeignModelResidue('', 'deepseek-chat'), true, '官方 OAuth 态下的 deepseek 名 = 残留');
  assert.equal(isForeignModelResidue('https://api.anthropic.com', 'glm-4.6'), true);

  assert.equal(isForeignModelResidue('https://api.deepseek.com/anthropic', 'deepseek-chat'), false,
    '第三方 provider 下 deepseek 名是正常的,一律放行');
  assert.equal(isForeignModelResidue('http://127.0.0.1:8788', 'mimo-v2.5-pro'), false,
    '走本地代理的第三方同样放行');

  assert.equal(isForeignModelResidue('', 'claude-sonnet-4-6'), false, '官方+claude 名放行');
  assert.equal(isForeignModelResidue('', 'sonnet[1m]'), false, '官方+claude 别名带 1M 后缀放行');
  assert.equal(isForeignModelResidue('', ''), false, '空模型名不是残留(交给后续优先级链)');
}

// ── 2. 防线之二:读取自愈 —— 置换 + 一行说明置换了什么的日志 ──────────────
{
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    assert.equal(healForeignModel('', 'deepseek-chat'), 'claude-sonnet-4-6', '官方+非claude → 置换');
    assert.equal(healForeignModel('https://api.deepseek.com/anthropic', 'deepseek-chat'), 'deepseek-chat',
      '第三方 → 原样返回,绝不置换');
    assert.equal(healForeignModel('', 'claude-opus-4-8'), 'claude-opus-4-8', '官方+claude → 原样返回');
  } finally {
    console.warn = orig;
  }
  assert.equal(warned.length, 1, '只有真正置换的那次记日志(第三方/正常值不得刷日志)');
  assert.ok(/deepseek-chat/.test(warned[0]) && /claude-sonnet-4-6/.test(warned[0]),
    '日志必须同时说明被置换掉的名字和换成了什么');
}

// ── 3. 防线之一:写入拒绝挡在写盘之前,且以 400 出口 ───────────────────────
// setDefaultModel 会写真实 ~/.claude/settings.json,单测绝不调用它 —— 改为对源码取守卫。
{
  const src = readFileSync(join(root, 'server/services/model-resolver.js'), 'utf8');
  const i = src.indexOf('export async function setDefaultModel');
  assert.ok(i > 0, 'model-resolver.js 必须仍导出 setDefaultModel');
  const body = src.slice(i, i + 1200);
  const guard = body.indexOf('isForeignModelResidue');
  const write = body.indexOf('writeFile');
  assert.ok(guard > 0, 'setDefaultModel 必须复用同一条残留判据');
  assert.ok(write > 0 && guard < write, '守卫必须在写盘之前,残留不能先落到 settings.json 再补救');
  assert.ok(/err\.status = 400/.test(body), '拒绝要以 400 出口(用户输入问题,不是服务端故障)');

  const index = readFileSync(join(root, 'server/index.js'), 'utf8');
  const r = index.indexOf("app.put('/api/model'");
  assert.ok(r > 0, 'PUT /api/model 路由必须还在');
  assert.ok(/err\.status \|\| 500/.test(index.slice(r, r + 600)),
    'PUT /api/model 必须透出 err.status,否则守卫的 400 会被压成 500');
}

// ── 4. 防线之三:选择器标异常,且不渲染成正常带勾条目 ──────────────────────
{
  const sel = readFileSync(join(root, 'client/src/components/SessionSelectors.jsx'), 'utf8');
  const i = sel.indexOf('const isForeignModel');
  assert.ok(i > 0, 'ModelSelector 必须有官方端点下的外部模型名判据');
  const fn = sel.slice(i, i + 400);
  assert.ok(/provider !== 'Anthropic'/.test(fn), '只在官方 provider 下判定,第三方一律放行');
  // 判据要和服务端同源:同样先剥 [1m],同样认四个 tier 别名。
  assert.ok(fn.includes('replace(/\\[1m'), '客户端判据同样要先剥 [1m] 后缀(与服务端 isClaudeModel 对齐)');
  assert.ok(/'sonnet', 'opus', 'haiku', 'fable'/.test(fn), '别名列表必须与服务端一致');

  assert.ok(/const isSelected = !foreign &&/.test(sel),
    '异常行不得渲染成带勾的正常选中条目');
  assert.ok(/异常/.test(sel) && /不属于当前 provider/.test(sel), '异常行要有说明性提示文案');
}

console.log('check-model-residue-guard: all assertions passed');

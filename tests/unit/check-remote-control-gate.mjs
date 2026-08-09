#!/usr/bin/env node
// Bug3:第三方 provider 下「远程控制」照样能开(界面显示已激活、输入框锁死,手机永远接不上)。
// Run: node tests/unit/check-remote-control-gate.mjs
//
// 【修的是什么】官方 Remote Control 是第一方能力:CLI 自 2.1.196 起,ANTHROPIC_BASE_URL 指向
// api.anthropic.com 以外的主机就禁用它(二进制原文 "Remote Control is only available when using
// Claude via api.anthropic.com."),而 GUI 切任何第三方 provider 都必写这个变量。此前 POST
// /api/remote-control 一处都没判,spawn 成功即 res.json({ok:true}),pty 输出还被 onData 空回调
// 丢掉 → 前端恒显示「已激活」、composer 恒锁,用户零感知。
//
// 【为什么用 /usr 当 cwd】cwd 门在 provider 门之后。测试绝不能真的起 remote-control 进程,所以
// 每个请求都带一个越界 cwd 当保险丝:门被删掉/判反时请求会被 cwd 门拒掉,而不是走到 pty.spawn。
// 于是「断言的是 provider 那条 message」本身就同时钉死了门的存在与它在 cwd 门之前的位置。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

// 隔离 HOME:remote-control.js / model-resolver.js 都在模块加载期用 homedir() 定住路径,
// 必须在 import 之前改。宿主 shell 可能挂着第三方 provider 的 env,会混进 getAvailableModels
// 的判据(它 merge 了 process.env),一并清掉。
const home = mkdtempSync(join(tmpdir(), 'cgui-rc-gate-'));
mkdirSync(join(home, '.claude'), { recursive: true });   // 故意不建 projects/ → 工作区例外恒 false
mkdirSync(join(home, '.claude-gui'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_MODEL', 'CLAUDE_MODEL']) delete process.env[k];

const SETTINGS = join(home, '.claude', 'settings.json');
const ANTHROPIC_ACTIVE = join(home, '.claude-gui', 'anthropic-active.json');
let tick = 0;
function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj));
  // model-resolver 的 settings 缓存按 mtime 失效;同一毫秒内连写两次可能拿到旧缓存。
  const t = new Date(Date.now() + ++tick * 1000);
  utimesSync(path, t, t);
}

const router = (await import('../../server/routes/remote-control.js')).default;
const { rcFailureIn } = await import('../../server/routes/remote-control.js');

const layer = router.stack.find((l) => l.route?.path === '/remote-control' && l.route.methods?.post);
assert.ok(layer, 'POST /remote-control 路由不见了(改路径了就同步这条断言)');
const handler = layer.route.stack[0].handle;

const SID = '11111111-1111-4111-8111-111111111111';
const FUSE_CWD = '/usr';   // 保险丝:家目录之外、且不是任何 claude 工作区
async function post(body) {
  const out = { status: 200, body: null };
  const res = {
    status(code) { out.status = code; return this; },
    json(payload) { out.body = payload; return this; },
  };
  await handler({ body }, res, () => {});
  return out;
}
const gateMsg = (name) => `远程控制要求 ANTHROPIC_BASE_URL 指向 api.anthropic.com。当前 provider 为「${name}」，切回官方 Anthropic 后可开启。`;
const CWD_MSG = 'cwd 不在家目录、也不在任何打开过的项目目录内';

// ── ① 第三方直连端点 → 拒绝,且报的是 provider 那条 ─────────────────────────
writeJson(SETTINGS, { env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com', ANTHROPIC_MODEL: 'deepseek-chat' } });
{
  const r = await post({ sessionId: SID, cwd: FUSE_CWD });
  assert.equal(r.status, 400, '第三方 provider 下远程控制仍被放行');
  assert.equal(r.body?.error, gateMsg('DeepSeek'), `拒绝理由不对(门缺失时会先撞 cwd 门):${r.body?.error}`);
}

// ── ② 回环代理(GUI 切第三方 claude 中转/openai 协议的真实形态)同样拒绝 ────────
// 这条是最容易漏的:base URL 是 127.0.0.1,只看"是不是 anthropic.com 域名"的弱判据会
// 把它当成"未知"甚至放行。getAvailableModels 会按 anthropic-active.json 还原成真名。
writeJson(ANTHROPIC_ACTIVE, { providerId: 'x', name: 'MiMo 中转', model: 'mimo-v2.5-pro', models: ['mimo-v2.5-pro'] });
writeJson(SETTINGS, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' } });
{
  const r = await post({ sessionId: SID, cwd: FUSE_CWD });
  assert.equal(r.status, 400, '回环代理(第三方中转)下远程控制仍被放行');
  assert.equal(r.body?.error, gateMsg('MiMo 中转'), `回环代理没被还原成真实 provider 名:${r.body?.error}`);
}

// ── ③ 官方端点不许误伤 ────────────────────────────────────────────────
// 官方态下同一个请求应当【走过】provider 门,被后面的 cwd 门挡住 —— 既证明没有假阳性,
// 也证明本测试全程没有 spawn 过任何 RC 进程。
writeJson(SETTINGS, { env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' } });   // 无 BASE_URL = CLI 默认端点
{
  const r = await post({ sessionId: SID, cwd: FUSE_CWD });
  assert.equal(r.status, 400);
  assert.equal(r.body?.error, CWD_MSG, `官方端点被 provider 门误伤:${r.body?.error}`);
}

// ── ④ pty 输出里的失败自检:窄匹配,拿不准不杀 ──────────────────────────────
// 正例逐字取自 RESEARCH-r5-cli-native.md Q4(CLI 二进制原文)。**每条都要有**:只认端点
// 那一条时,官方端点 + API key 的用户照样恒显「已激活」+ 输入框锁死 + 零提示(判官必修项)。
const FAIL_LINES = [
  ['端点(BASE_URL 非官方)', 'Remote Control is only available when using Claude via api.anthropic.com.'],
  ['订阅', 'Remote Control requires a claude.ai subscription. Run `claude auth login` to sign in.'],
  ['长期令牌只有推理权限', 'Remote Control requires a full-scope login token. Long-lived tokens (from `claude setup-token` or CLAUDE_CODE_OAUTH_TOKEN) are limited to inference-only for security reasons.'],
  ['组织策略(直撇号)', "Remote Control is disabled by your organization's policy (managed setting `disableRemoteControl`)."],
  ['组织策略(弯撇号渲染)', 'Remote Control is disabled by your organization’s policy (managed setting `disableRemoteControl`).'],
  ['云会话', 'Remote Control is not available inside a cloud session.'],
  ['bridge 环境注册被拒', 'Remote Control environments are not available for your account.'],
  ['企业网关', 'This session is connected through an enterprise cloud gateway (set up via /login), which does not support Remote Control.'],
];
for (const [name, line] of FAIL_LINES) {
  // 真实形态:ANSI 色码 + 提示框边框 + 前后正常输出。
  const boxed = [
    '\x1b[2m╭─────────────────────────────────╮\x1b[0m',
    `\x1b[33m│\x1b[0m \x1b[1m${line}\x1b[0m \x1b[33m│\x1b[0m`,
    '\x1b[2m╰─────────────────────────────────╯\x1b[0m',
  ].join('\r\n');
  assert.equal(rcFailureIn(boxed), line, `带色码/边框的「${name}」拒绝没被识别:${JSON.stringify(rcFailureIn(boxed))}`);
  assert.equal(rcFailureIn(`welcome\n${line}\nbye`), line, `夹在正常输出里的「${name}」拒绝应被识别`);
}
for (const [name, out] of [
  ['空输出', ''],
  ['undefined', undefined],
  ['正常欢迎屏', '\x1b[1m Welcome to Claude Code \x1b[0m\r\n cwd: /Users/x/proj\r\n'],
  ['成功激活的提示', 'Remote Control session is active — open Claude on your phone to take over.'],
  ['只是提到功能名', 'Type /remote-control to hand this session to your phone.'],
  ['模型自己在聊这个话题', 'The Remote Control feature requires api.anthropic.com, per the docs.'],
  // 扩了正则之后新增的近似句(每条新文案配一条"像但不是"的反例,防止顺手写宽)
  ['订阅正常', 'Remote Control is enabled — your claude.ai subscription covers it.'],
  ['令牌说明文', 'Long-lived tokens from `claude setup-token` are fine for CI runs.'],
  ['组织放开了策略', "Your organization's policy allows Remote Control."],
  ['云会话但可用', 'Cloud session detected; Remote Control is available here.'],
  ['企业代理不是网关那条', 'Connecting through an enterprise proxy at proxy.corp:8080.'],
  ['环境列表正常', 'Remote Control environments: 2 available for this account.'],
]) {
  assert.equal(rcFailureIn(out), null, `误杀:「${name}」被判成了失败`);
}

// ── ⑤ 接线本身(pty 只能在真跑 RC 时才有,这里按源码钉死)───────────────────
const src = await readFile(new URL('../../server/routes/remote-control.js', import.meta.url), 'utf8');
{
  // (a) provider 门在 loadPty 之前 —— 顺序错了等于先 spawn 再判。
  const gateAt = src.search(/if \(provider !== 'Anthropic'\) \{/);
  const ptyAt = src.indexOf('await loadPty()');
  assert.ok(gateAt > 0, 'provider 门不见了(判据换写法了就同步这条断言)');
  assert.ok(ptyAt > gateAt, 'provider 门跑到了 loadPty 之后');
  // 判据必须来自 getAvailableModels(与 /api/slash-commands 的 isAnthropic 同源,它已把
  // 回环代理还原成真实 provider 名)。换成裸读 settings.env.ANTHROPIC_BASE_URL 之类的
  // 弱判据,②那条会先红;这条只是把"同源"这个要求写在明处。
  assert.ok(/getAvailableModels\(\)\)\.provider/.test(src), 'provider 判据没走 getAvailableModels');

  // (b) pty 输出不再进黑洞,且命中失败即 kill + 摘掉 active(否则状态端点照旧谎称已激活)。
  assert.ok(!/term\.onData\(\(\) => \{\}\)/.test(src), 'pty 输出又被空回调丢掉了(失败提示永远看不见)');
  const onData = src.match(/term\.onData\(\(chunk\) => \{[\s\S]*?\n {4}\}\);/);
  assert.ok(onData, '没找到 pty 输出扫描块');
  for (const need of ['rcFailureIn(head)', 'failures.set(sessionId', 'term.kill()', 'active.delete(sessionId)']) {
    assert.ok(onData[0].includes(need), `扫描块缺「${need}」→ 命中失败后状态仍显示已激活`);
  }
  // (c) 失败原因要经状态端点回给前端(前端据此解锁并提示),且读一次即清。
  const status = src.match(/function statusOf\(sessionId\) \{[\s\S]*?\n\}/);
  assert.ok(status && /failures\.get\(sessionId\)/.test(status[0]) && /failures\.delete\(sessionId\)/.test(status[0]),
    'statusOf 没把失败原因回话/没读一次即清');
}

// ── ⑥ 客户端置灰(服务端硬门之外的第二层,免得"能点=能用")────────────────────
const btn = await readFile(new URL('../../client/src/components/SessionSelectors.jsx', import.meta.url), 'utf8');
{
  const comp = btn.slice(btn.indexOf('export function RemoteControlButton'), btn.indexOf('export function ProviderSwitchList'));
  assert.ok(/providerHint \|\| 'anthropic'\) === 'anthropic'/.test(comp), '按钮没按 providerHint 门控');
  assert.ok(/disabled=\{!sid \|\| busy \|\| \(!isOfficial && !active\)\}/.test(comp),
    '置灰条件被改动(已激活时必须仍可点,否则切了 provider 就收不回控制)');
  assert.ok(comp.includes('当前 provider 非官方 Anthropic，远程控制不可用。'), '置灰态缺少说明文案');
  assert.ok(!comp.includes('非 deepseek/mimo'), '旧文案(点名两个厂商,新增第三方即过时)还在');
}

console.log('check-remote-control-gate OK');

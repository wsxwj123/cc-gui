#!/usr/bin/env node
// 批H:切 provider 时优先把【常驻 daemon】的代理端口写进 settings.json。
// 修前:恒写 GUI 进程内代理端口(8789/8788),GUI 一关,共用同一份 settings.json 的
// telegram/微信 bot 全部 ECONNREFUSED。
// 修后:先 TCP 探 daemon 端口(8799/8798),在听就写它;不在听(公开版/未装/挂了)回落
// 进程内端口 —— 回落路径行为与修前完全一致。
// node tests/unit/check-daemon-proxy-port.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'server/routes/settings.js'), 'utf8');
// 真 import:探测/选择是纯函数,直接跑真货,不复刻实现。
const { probeTcpPort, pickProxyPort } = await import('../../server/routes/settings.js');

// ── 1. daemon 在听:临时 net server 冒充 daemon,实测探到 + 选中它 ─────────
const fake = createServer(() => {});
const daemonPort = await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)));
assert.equal(await probeTcpPort(daemonPort), true, 'daemon 在听时必须探到');
assert.equal(await pickProxyPort(daemonPort, 12345), daemonPort, 'daemon 在听 → 写 daemon 端口');

// ── 2. daemon 不在听:关掉同一个端口,必须回落进程内端口 ──────────────────
await new Promise((r) => fake.close(r));
assert.equal(await probeTcpPort(daemonPort), false, 'daemon 关掉后必须探不到');
assert.equal(await pickProxyPort(daemonPort, 12345), 12345, 'daemon 不在 → 回落 GUI 进程内端口');

// ── 3. 绝不抛:非法端口只 resolve false(切 provider 不能因为探测炸掉)──────
for (const bad of [70000, -1, NaN, undefined]) {
  assert.equal(await probeTcpPort(bad), false, `非法端口 ${bad} 应 resolve false 而非抛错`);
}

// ── 4. 源码守卫:两处写入点都必须过 pickProxyPort,且档位别搞反 ─────────────
assert.match(src, /const DAEMON_ANTHROPIC_PORT = 8799;/, 'anthropic daemon 端口常量必须是 8799');
assert.match(src, /const DAEMON_OPENAI_PORT = 8798;/, 'openai daemon 端口常量必须是 8798');

const fnBody = (name) => {
  const i = src.indexOf(`async function ${name}(`);
  assert.notEqual(i, -1, `${name} 必须存在`);
  const body = src.slice(i);
  const end = body.indexOf('\n}\n');
  return body.slice(0, end === -1 ? body.length : end);
};
const oa = fnBody('switchToOpenAIUpstream');
const an = fnBody('switchToAnthropicUpstream');

// 两处写入点都不许再裸写端口
assert.match(oa, /env\.ANTHROPIC_BASE_URL = `http:\/\/127\.0\.0\.1:\$\{await pickProxyPort\(DAEMON_OPENAI_PORT, port\)\}`;/,
  'openai 分支的 ANTHROPIC_BASE_URL 必须经 pickProxyPort(DAEMON_OPENAI_PORT, port)');
assert.match(an, /env\.ANTHROPIC_BASE_URL = `http:\/\/127\.0\.0\.1:\$\{await pickProxyPort\(DAEMON_ANTHROPIC_PORT, port\)\}`;/,
  'anthropic 分支的 ANTHROPIC_BASE_URL 必须经 pickProxyPort(DAEMON_ANTHROPIC_PORT, port)');
// 档位交叉:两个分支不能引用对方的 daemon 端口(写反 = anthropic 流量打到 openai daemon)
assert.ok(!oa.includes('DAEMON_ANTHROPIC_PORT'), 'openai 分支不得引用 DAEMON_ANTHROPIC_PORT');
assert.ok(!an.includes('DAEMON_OPENAI_PORT'), 'anthropic 分支不得引用 DAEMON_OPENAI_PORT');

// 全仓其它读点按 host('127.0.0.1')判"是否走本机代理",不按端口 —— 这条守住,换成
// daemon 端口后 restore*/model-resolver/fetch-models 的判定都不用动。
assert.ok(!/ANTHROPIC_BASE_URL[^\n]*includes\(['"]:87\d\d['"]\)/.test(src),
  'settings.json 的代理判定不得按端口字符串,只按 127.0.0.1(否则 daemon 端口会漏判)');

console.log('check-daemon-proxy-port: ok');

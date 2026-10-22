// C. 第三方代理改写 claude 模型名(行为 6–9)。每条用例起一个子进程(proxy/case.mjs):HOME 指向临时目录,
// 进程内加载 anthropic-proxy / openai-proxy 的公开入口,配本进程内的假上游,经代理 HTTP 口转发;两种代理各验一遍。
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRoot } from '../r151b-xsession-p1/helpers/fixtures.mjs';

const CASE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proxy', 'case.mjs');
test.describe.configure({ timeout: 90_000 });

function runCase(id) {
  fs.mkdirSync(dataRoot(), { recursive: true });
  const home = fs.mkdtempSync(path.join(dataRoot(), 'proxyhome-'));
  const r = spawnSync(process.execPath, [CASE, String(id)], {
    cwd: home, encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: 'en_US.UTF-8', TMPDIR: home, R151Q_ART: dataRoot() },
  });
  const line = String(r.stdout).split('\n').find((l) => l.startsWith('R151Q_RESULT '));
  return { result: line ? JSON.parse(line.slice('R151Q_RESULT '.length)) : null, out: `退出码 ${r.status} 信号 ${r.signal}\n${String(r.stdout).slice(-1500)}\n${String(r.stderr).slice(-1500)}` };
}
const ok = (upstreamModel) => ({ status: 200, upstreamModel });
async function check(id, expected) {
  const { result, out } = runCase(id);
  expect(result, `子进程没给出结果:${out}`).not.toBeNull();
  for (const kind of ['anthropic', 'openai']) expect.soft(result[kind], `${kind} 代理`).toEqual(expected);
}

test('Q06 settings 主模型改成 m2[1m],不重启 → 下一个以 claude-opus-4-7 请求的转发,上游收到 m2', async () => {
  await check(6, { before: ok('r151q-m1'), after: ok('r151q-m2') });
});
test('Q07 模型列表里有 claude 名:settings 里 _MODEL 键 / 顶层 model 配的名字原样转发,没配置且不在列表的映射成主模型', async () => {
  await check(7, { haiku: ok('claude-haiku-4-5'), topModel: ok('claude-opus-4-6'), unconfigured: ok('r151q-m1'), inList: ok('claude-opus-4-7') });
});
test('Q08 (相邻) 模型列表里没有 claude 名,settings 残留 ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5 → 仍映射成主模型', async () => {
  await check(8, { haiku: ok('r151q-m1') });
});
test('Q09 settings 被写成半截 JSON → 沿用上一次成功读到的目标、不报错、日志里没有 token;恢复后下一次转发按新内容生效', async () => {
  await check(9, { good: ok('r151q-m2'), broken1: ok('r151q-m2'), broken2: ok('r151q-m2'), recovered: ok('r151q-m1'), leakedToken: false, logTail: expect.any(String) });
});

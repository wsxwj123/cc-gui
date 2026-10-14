// E 组:GUI 起 CLI 会话进程时传入的 CLAUDE_CODE_AUTO_MODE_SERVER(INTERFACE Y.3.2 后半)。
// 判据 = 假 claude 被拉起那一刻自己记下的环境(有没有这个键、值是什么)。
// 注意:run.sh 故意让 GUI 后端自身的环境里带着 CLAUDE_CODE_AUTO_MODE_SERVER=1 —— 所以下面每条"没有这个键"
// 同时也在验 Y.3.2 最后一条"后端自身环境里的这个键先被剥掉"(没剥掉的话子进程会继承到 "1")。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import {
  startTurn, waitSpawn, useProvider, useOfficial, tpAutoOn, tpAutoOff, resetOverrides, readJson, writeJson, snapshot, SETTINGS,
} from './helpers/api.mjs';
import { provider } from './helpers/scenes.mjs';

let n = 0;
const ws = (tag) => `e-${tag}-${Date.now().toString(36)}-${(n += 1)}`;
let saved = {};

test.beforeEach(async () => {
  saved = snapshot([SETTINGS()]);
  await tpAutoOff();
  resetOverrides({});
});
test.afterEach(async () => {
  for (const [p, c] of Object.entries(saved)) { if (c !== null) fs.writeFileSync(p, c); }
});

async function spawnEnv(tag, permissionMode = 'auto') {
  const { res, cwd } = await startTurn(ws(tag), { permissionMode });
  expect(res.status, `前置:起回合(${res.text.slice(0, 200)})`).toBe(200);
  const rec = await waitSpawn(cwd);
  expect(rec, '前置:应起了会话进程').not.toBeNull();
  return rec;
}
async function thirdParty() { const id = await provider('main'); await useProvider(id); return id; }

test('E1 第三方地址 + 开关开 + settings.json 的 env 里没有该键 → 会话进程拿到 CLAUDE_CODE_AUTO_MODE_SERVER === "0"', async () => {
  await thirdParty();
  await tpAutoOn();
  const rec = await spawnEnv('e1');
  expect(rec.hasAutoModeServer).toBe(true);
  expect(rec.autoModeServer).toBe('0');
});

test('E1b 规则不看会话档位:第三方 + 开关开 + 档位 default 的会话也拿到 "0"(之后切到自动档不必重建进程)', async () => {
  await thirdParty();
  await tpAutoOn();
  const rec = await spawnEnv('e1b', 'default');
  expect(rec.autoModeServer).toBe('0');
});

test('E2 第三方 + 开关关 → 会话进程环境里没有这个键(后端自身环境里的 "1" 也没有漏下去)', async () => {
  await thirdParty();
  const rec = await spawnEnv('e2');
  expect(rec.hasAutoModeServer, `实际值:${rec.autoModeServer}`).toBe(false);
});

test('E3 官方 provider(settings.json 没有 ANTHROPIC_BASE_URL)+ 开关开 → 没有这个键', async () => {
  await useOfficial();
  expect((readJson(SETTINGS()) || {}).env?.ANTHROPIC_BASE_URL, '前置:官方没有 base URL').toBeUndefined();
  await tpAutoOn();
  const rec = await spawnEnv('e3');
  expect(rec.hasAutoModeServer, `实际值:${rec.autoModeServer}`).toBe(false);
});

test('E4 settings.json 的 ANTHROPIC_BASE_URL 是官方地址 + 开关开 → 没有这个键', async () => {
  await useOfficial();
  writeJson(SETTINGS(), { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_MODEL: 'claude-sonnet-4-6' } });
  await tpAutoOn();
  const rec = await spawnEnv('e4');
  expect(rec.hasAutoModeServer, `实际值:${rec.autoModeServer}`).toBe(false);
});

test('E5 settings.json 读不出(损坏)+ 开关开 → 没有这个键', async () => {
  await thirdParty();
  await tpAutoOn();
  fs.writeFileSync(SETTINGS(), '{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8799", 损坏');
  const rec = await spawnEnv('e5');
  expect(rec.hasAutoModeServer, `实际值:${rec.autoModeServer}`).toBe(false);
});

for (const v of ['1', '0']) {
  test(`E6 settings.json 的 env 里已有 CLAUDE_CODE_AUTO_MODE_SERVER="${v}" + 第三方 + 开关开 → GUI 不再传这个键(由 settings.json 自己生效)`, async () => {
    await thirdParty();
    await tpAutoOn();
    const s = readJson(SETTINGS());
    s.env.CLAUDE_CODE_AUTO_MODE_SERVER = v;
    writeJson(SETTINGS(), s);
    const rec = await spawnEnv(`e6-${v}`);
    expect(rec.hasAutoModeServer, `实际值:${rec.autoModeServer}`).toBe(false);
  });
}

test('E7 第三方 + 开关从开切到关 → 之后新起的会话进程没有这个键', async () => {
  await thirdParty();
  await tpAutoOn();
  await tpAutoOff();
  const rec = await spawnEnv('e7');
  expect(rec.hasAutoModeServer, `实际值:${rec.autoModeServer}`).toBe(false);
});

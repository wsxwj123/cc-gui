// G. 审核模型(行为 19–21)。Q19 / Q20 用共享实例(临时 HOME 的 settings.json 直接写假模型地址,不碰切 provider 接口);
// Q21 用一次性实例 + 真 CLI(审核请求只到本地假模型,假模型把请求里的 model 记下来)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { uniq, homeDir, ctlDir, claudeDir, prefsPath, seedSession, makeWorkspace, realCliPath, dataRoot } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { shared, MOCK, waitFor, readText, writeJson, readStream } from '../r151b-xsession-p1/helpers/api.mjs';
import { aiCalls, laneReq } from '../r151c-xsession-p2/helpers/p2.mjs';
import { boot } from '../r151b-xsession-p1/helpers/ui.mjs';
import { openPermissionSettings, tpSection } from '../r151a-auto-audit/helpers/ui.mjs';
import { startInstanceQ } from './helpers/inst.mjs';

test.describe.configure({ timeout: 150_000 });
const SETTINGS = () => path.join(claudeDir(homeDir()), 'settings.json');
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const thirdPartyEnv = (tier, lane) => ({ env: { ANTHROPIC_BASE_URL: `${MOCK}/lane/${lane}`, ANTHROPIC_AUTH_TOKEN: 'dummy-r151q', ANTHROPIC_MODEL: 'r151q-main', ANTHROPIC_DEFAULT_SONNET_MODEL: tier } });

/** 共享实例临时改成"第三方 + 自动档开关开 + sonnet 档 = tier",跑完还原(settings.json 与偏好里的开关)。 */
async function withThirdPartyAudit(tier, fn) {
  const prevSettings = readText(SETTINGS());
  try {
    writeJson(SETTINGS(), thirdPartyEnv(tier, 'q-audit'));
    expect((await shared.put('/api/prefs/third-party-auto', { enabled: true })).status, '前置:打开第三方自动档开关').toBe(200);
    return await fn();
  } finally {
    await shared.put('/api/prefs/third-party-auto', { enabled: false }).catch(() => null);
    if (prevSettings === null) fs.rmSync(SETTINGS(), { force: true }); else fs.writeFileSync(SETTINGS(), prevSettings);
  }
}
/** 在共享实例里用 auto 档起一个假 claude 会话,返回它启动时记下的审核相关环境。 */
async function spawnEnv() {
  const T = seedSession(`q-audit-${uniq('')}`);
  const r = await shared.post('/api/chat', { sessionId: T.sid, cwd: T.cwd, prompt: 'R151Q 审核模型环境', permissionMode: 'auto' });
  expect(r.status, `前置:起会话(${String(r.text).slice(0, 200)})`).toBe(200);
  const rec = await waitFor(() => jsonl(path.join(ctlDir(), 'r151q-env.jsonl')).find((x) => x.sid === T.sid) || null, 15_000, 100);
  readStream(r.body.pid, { timeoutMs: 20_000, base: shared.base }).catch(() => null);
  return rec;
}

test('Q19 第三方 + 自动档开关开 + sonnet 档为 claude-sonnet-5-5 → 状态接口 auditModelUnusable:true,设置页提示"该型号不能作为审核模型",会话进程环境里没有 CLAUDE_CODE_AUTO_MODE_MODEL', async ({ page }) => {
  await withThirdPartyAudit('claude-sonnet-5-5', async () => {
    const st = await shared.get('/api/auto-audit/status');
    expect.soft(st.body && st.body.auditModelUnusable, `自动档状态原文:${String(st.text).slice(0, 500)}`).toBe(true);
    const rec = await spawnEnv();
    expect.soft(rec, '前置:假 claude 起来并记下了环境').toBeTruthy();
    expect.soft(rec && { has: rec.hasAutoModeModel, value: rec.autoModeModel }, '会话进程环境里不应有 CLAUDE_CODE_AUTO_MODE_MODEL').toEqual({ has: false, value: null });
    await boot(page);
    await openPermissionSettings(page);
    await expect.soft(tpSection(page), '设置页第三方自动档块应提示该型号不能作为审核模型').toContainText(/不能作为审核模型/, { timeout: 10_000 });
  });
});

test('Q20 (相邻) sonnet 档为普通名字 r151q-audit → auditModelUnusable:false,进程环境里 CLAUDE_CODE_AUTO_MODE_MODEL=r151q-audit', async () => {
  await withThirdPartyAudit('r151q-audit', async () => {
    const st = await shared.get('/api/auto-audit/status');
    expect.soft(st.body && st.body.auditModelUnusable, `自动档状态原文:${String(st.text).slice(0, 500)}`).toBe(false);
    const rec = await spawnEnv();
    expect.soft(rec, '前置:假 claude 起来并记下了环境').toBeTruthy();
    expect.soft(rec && { has: rec.hasAutoModeModel, value: rec.autoModeModel }, '普通名字照旧注入').toEqual({ has: true, value: 'r151q-audit' });
  });
});

test('Q21 第三方 + 自动档开关开 + 审核模型 r151q-audit,真命令行在自动档写工作目录外的文件 → 假模型收到的审核请求 model 是 r151q-audit', async () => {
  test.skip(!realCliPath(), '本机没有真 claude CLI');
  test.setTimeout(200_000);
  const run = uniq(''); const lane = `real-q21-${run}`;
  const inst = await startInstanceQ('q21', { settings: thirdPartyEnv('r151q-audit', lane) });
  try {
    expect((await inst.c.put('/api/prefs/third-party-auto', { enabled: true })).status, '前置:打开第三方自动档开关').toBe(200);
    const outside = path.join(dataRoot(), `q21-outside-${run}.txt`);
    await aiCalls(inst.c, { lane, cwd: makeWorkspace(`real-q21-${run}`), mode: 'auto', steps: [{ name: 'Write', input: { file_path: outside, content: 'q21' } }] });
    const reqs = laneReq(lane);
    const cls = reqs.filter((q) => q.kind === 'classifier');
    expect(cls.length, `前置:假模型收到了审核请求(本车道请求 kind/model:${JSON.stringify(reqs.map((q) => [q.kind, q.model]))})`).toBeGreaterThan(0);
    expect(cls.map((q) => q.model), '每个审核请求带的 model').toEqual(cls.map(() => 'r151q-audit'));
  } finally { await inst.stop(); }
});

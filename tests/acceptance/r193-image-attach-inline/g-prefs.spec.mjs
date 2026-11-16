// r193-image-attach-inline 黑盒验收(三):设置与接口类 G22、G23。
// 开关「发送时直接带上图片」默认开;GET/PUT /api/prefs/image-inline 读写它;关掉后立刻生效(不重启),发出的内容与改动前逐字相同。
// 接口请求经页面同源发出(与应用自己的请求同路);「命令行收到的」读假命令行收信日志。每个用例结束前把开关恢复成打开,免得影响别的用例。
import { test, expect, prepare } from './helpers/base.mjs';
import { writeScenario } from './helpers/fixtures.mjs';
import { openApp, openJia, uniqueTag } from './helpers/runtime.mjs';
import { bigImage, addImage, sendAndGetResponse, apiFetch, waitReceived, expectedText, finishTurn, imageBlocks } from './helpers/ui.mjs';

const URL_PREF = '/api/prefs/image-inline';
const SHORT = { chunkCount: 3, chunkIntervalMs: 50 };
const getPref = (page) => apiFetch(page, 'GET', URL_PREF);
const putPref = (page, body) => apiFetch(page, 'PUT', URL_PREF, body);

test('G22 【复现】PUT 关掉开关(不重启)后发「T + 大图」:命令行收到字符串、应答无 imageAttach;再打开发「T2 + 大图」:收到 1 个图片块;GET 与刚写入的一致;PUT 不合规请求体 → 400 且值不变', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  try {
    // 关掉:PUT 与 GET 一致。
    const off = await putPref(page, { enabled: false });
    expect(off.status, `G22:PUT enabled=false 应 200(原文 ${off.text.slice(0, 200)})`).toBe(200);
    expect(off.json, 'G22:PUT 应答').toEqual({ ok: true, enabled: false });
    expect((await getPref(page)).json, 'G22:关掉后 GET 读到的值').toEqual({ enabled: false });

    // 不合规的请求体:400 + INVALID_INPUT,值不变(「yes」是真值,若被当成 true 会把开关悄悄打开)。
    const bad = await putPref(page, { enabled: 'yes' });
    expect(bad.status, `G22:PUT {"enabled":"yes"} 应 400(原文 ${bad.text.slice(0, 200)})`).toBe(400);
    expect(bad.json && bad.json.ok, 'G22:不合规请求体的应答 ok').toBe(false);
    expect(bad.json && bad.json.code, 'G22:不合规请求体的应答 code').toBe('INVALID_INPUT');
    const badArr = await putPref(page, [true]);
    expect(badArr.status, `G22:PUT 的请求体不是对象(数组)应 400(原文 ${badArr.text.slice(0, 200)})`).toBe(400);
    expect(badArr.json && badArr.json.code, 'G22:请求体不是对象时的 code').toBe('INVALID_INPUT');
    expect((await getPref(page)).json, 'G22:两次不合规 PUT 之后 GET 读到的值应仍是 false').toEqual({ enabled: false });

    // 开关关着:发「T + 大图」,命令行收到与改动前逐字相同的字符串。
    const T = `G22off-${uniqueTag()}`;
    const p1 = await addImage(page, bigImage('r193-g22-off.png'), 1);
    const r1 = await sendAndGetResponse(page, T);
    const [e1] = await waitReceived(page, ctx, T);
    expect(e1.kind, 'G22:开关关着时命令行收到的内容应是字符串').toBe('string');
    expect(e1.text, 'G22:字符串应与改动前逐字相同').toBe(expectedText(T, [p1]));
    expect(r1.json, `G22:应答应是 JSON(原文 ${r1.raw.slice(0, 200)})`).not.toBe(null);
    expect('imageAttach' in r1.json, 'G22:开关关着时应答里不应有 imageAttach').toBe(false);
    await finishTurn(page, ctx, T);

    // 再打开(仍不重启):发「T2 + 大图」,命令行收到 1 个图片块。
    const on = await putPref(page, { enabled: true });
    expect(on.json, 'G22:PUT enabled=true 的应答').toEqual({ ok: true, enabled: true });
    expect((await getPref(page)).json, 'G22:打开后 GET 读到的值').toEqual({ enabled: true });
    const big2 = bigImage('r193-g22-on.png');
    const T2 = `G22on-${uniqueTag()}`;
    await addImage(page, big2, 1);
    await sendAndGetResponse(page, T2);
    const [e2] = await waitReceived(page, ctx, T2);
    expect(e2.kind, 'G22:重新打开后命令行收到的内容应是数组').toBe('array');
    expect(imageBlocks(e2).map((b) => b.sha256), 'G22:重新打开后应带上那张大图').toEqual([big2.sha]);
  } finally {
    await putPref(page, { enabled: true }).catch(() => {});
  }
});

// ───────────────────────── 设置页开关 ─────────────────────────
const NAME = '发送时直接带上图片';

/** 打开设置页(顶栏面板坞 →「通用」),返回顶部的搜索框。入口照 r151b / r151s 的写法。 */
async function openSettings(page) {
  const gen = page.locator('[data-cgui="panel-dock"] button[title="通用"]').first();
  if (!(await gen.isVisible().catch(() => false))) await page.locator('[data-testid="panel-dock-toggle"]').click();
  await gen.click();
  const box = page.locator('input[data-testid="settings-search"], [data-testid="settings-search"] input, input[placeholder*="搜索设置"]').first();
  await expect(box, '设置页顶部应有搜索框「搜索设置…」').toBeVisible({ timeout: 15_000 });
  return box;
}

/** 开关本体(接口文件约定):区块 [data-testid="image-inline-section"] 里的 [data-testid="image-inline-toggle"],role=switch,aria-checked 为 "true" / "false"。 */
const toggleLoc = (page) => page.locator('[data-testid="image-inline-toggle"]');

test('G23 【复现】打开设置、搜索「图片」找到「发送时直接带上图片」,点一下关掉:GET 读到 false;再点一下:读到 true', async ({ page }) => {
  prepare();
  await openApp(page);
  try {
    const box = await openSettings(page);
    await box.fill('图片');
    const sw = toggleLoc(page);
    // 搜索结果里先出现的可能是「跳转到该设置项」的入口:开关不直接可见、但搜得到这行文字时,点一下它。
    await page.waitForTimeout(800);
    if (!(await sw.isVisible().catch(() => false))) {
      const hit = page.getByText(NAME, { exact: true }).first();
      if (await hit.isVisible().catch(() => false)) await hit.click();
    }
    await expect(sw, `G23:搜索「图片」后应能看到「${NAME}」的开关 [data-testid="image-inline-toggle"]`).toBeVisible({ timeout: 10_000 });
    await expect(sw, 'G23:开关应是 role=switch').toHaveAttribute('role', 'switch');
    await expect(sw, 'G23:默认应是打开(aria-checked=true)').toHaveAttribute('aria-checked', 'true');
    expect((await getPref(page)).json, 'G23:开始时 GET 读到的值(默认应是打开)').toEqual({ enabled: true });
    await sw.click();
    await expect.poll(async () => (await getPref(page)).json, { message: 'G23:点一下关掉后 GET 读到的值', timeout: 10_000 }).toEqual({ enabled: false });
    await expect(sw, 'G23:关掉后开关的 aria-checked 应是 false').toHaveAttribute('aria-checked', 'false');
    await sw.click();
    await expect.poll(async () => (await getPref(page)).json, { message: 'G23:再点一下后 GET 读到的值', timeout: 10_000 }).toEqual({ enabled: true });
    await expect(sw, 'G23:再点一下后开关的 aria-checked 应是 true').toHaveAttribute('aria-checked', 'true');
  } finally {
    await putPref(page, { enabled: true }).catch(() => {});
  }
});

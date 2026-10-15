// 行为清单 26、27(2026-10-15 审计后补):清空残留(GET config 的 stored、POST /api/xsession/clear、设置块的残留提示与【清空】)、
// 转发对话框目标项的"所在项目已隐藏"标注。
// X26:接口部分用一次性实例(全新 HOME,条数可精确断言,不碰共享实例);界面部分只能走共享实例(dev server 只代理到它),
//      先在开关关着时调一次 clear 清掉之前用例留在共享实例上的消息,让界面上的条数可精确断言。
// X27:共享实例 + dev server。本套件的工作区都建在工作树里 = worktree 项目:不开「在项目列表显示 worktree 项目」时,
//      转发目标都属于"所在项目已隐藏";开了之后都不属于。用例结束把这个开关拨回。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startInstance } from './helpers/instance.mjs';
import { seedSession, uniq, xsDir, guiDir, prefsPath } from './helpers/fixtures.mjs';
import { xs, post, listTree, readText } from './helpers/api.mjs';
import { boot, openSessionBySearch, openSessionSettings, recordRequests, sidebar, showWorktreeProjects } from './helpers/ui.mjs';

test.describe.configure({ timeout: 240_000 });

const ALL = 'pending,queued,claimed,processing,done,dismissed';
const CLEAR_WHILE_ENABLED = '请先关闭跨会话消息，或在卡片上逐条处理';
const CONFIRM_TEXT = '清空后，这些消息和它们的正文都会删除，无法恢复。';
const DELIVERED = '已送达，等待对方会话里确认处理';
const HIDDEN_TEXT = '所在项目已隐藏';
const raw = (r) => `(应答原文:${String(r.text).slice(0, 300)})`;
const noFiles = (tree) => tree === null || tree.length === 0;
/** xsession 目录里属于"收件箱记录 / 正文 / 损坏留存"的文件(相对路径);目录不存在时为 []。 */
const inboxFiles = (dir) => (listTree(dir) || []).map((l) => l.split(' ')[0])
  .filter((f) => f === 'messages.json' || f.startsWith('bodies/') || f.startsWith('messages.json.corrupt-'));

test('X26 清空残留:收件箱不存在时 stored 为 0 且不产生文件;开着时 clear → 409 XS_CLEAR_WHILE_ENABLED;关着且有未结束消息时 stored.unfinished = 条数、设置块出现"仍有 N 条…"与【清空】;确认后 clear → 200 {ok:true,removed},收件箱记录 / 正文 / 损坏留存全删、xsession 以外不动、提示与按钮消失', async ({ page }) => {
  const inst = await startInstance('x26');
  try {
    const api = xs(inst.c, inst.home);
    const dir = xsDir(inst.home);
    const clear = (body) => inst.c.post('/api/xsession/clear', body);

    await test.step('一次性实例,收件箱不存在(开关关):GET config → stored {unfinished:0},读取不产生文件;clear → 200 {ok:true,removed:0},不新建文件', async () => {
      expect(noFiles(listTree(dir)), `前置:全新 HOME 的 xsession 下没有文件,实际 ${JSON.stringify(listTree(dir))}`).toBe(true);
      const r = await api.config();
      expect(r.status, `GET config 状态码${raw(r)}`).toBe(200);
      expect.soft(r.body && r.body.stored, `收件箱不存在时 stored${raw(r)}`).toEqual({ unfinished: 0 });
      expect.soft(noFiles(listTree(dir)), `读取 stored 不应产生文件,实际 ${JSON.stringify(listTree(dir))}`).toBe(true);
      const c = await clear();
      expect.soft(c.status, `收件箱不存在时 clear 状态码${raw(c)}`).toBe(200);
      expect.soft(c.body, `收件箱不存在时 clear 应答${raw(c)}`).toEqual({ ok: true, removed: 0 });
      expect.soft(noFiles(listTree(dir)), `收件箱不存在时 clear 不应新建文件,实际 ${JSON.stringify(listTree(dir))}`).toBe(true);
    });

    // 摆场景:B、C 各一条 pending;B 再一条 claimed(未结束)、一条 dismissed(已结束)→ 未结束 3 条,总共 4 条
    const A = seedSession(`x26-a-${uniq('')}`, { home: inst.home });
    const B = seedSession(`x26-b-${uniq('')}`, { home: inst.home });
    const C = seedSession(`x26-c-${uniq('')}`, { home: inst.home });
    await api.on();
    const first = await api.send(A.sid, [B.sid, C.sid], 'R151B x26 一');
    const [m2] = await api.send(A.sid, [B.sid], 'R151B x26 二');
    const [m3] = await api.send(null, [B.sid], 'R151B x26 三');
    await api.claimOk(m2.id);
    expect((await api.dismiss(m3.id)).status, '前置:忽略一条').toBe(200);
    const unfinishedIds = [...first.map((m) => m.id), m2.id];

    await test.step('开关开着:clear → 409 {ok:false,code:"XS_CLEAR_WHILE_ENABLED",error 逐字},一条消息都没删', async () => {
      const r = await clear({});
      expect.soft(r.status, `开着时 clear 状态码${raw(r)}`).toBe(409);
      expect.soft(r.body, `开着时 clear 错误体${raw(r)}`).toEqual({ ok: false, code: 'XS_CLEAR_WHILE_ENABLED', error: CLEAR_WHILE_ENABLED });
      expect((await api.list(B.sid, ALL)).body.messages.map((m) => m.status).sort(), 'B 的消息原样').toEqual(['claimed', 'dismissed', 'pending']);
      expect((await api.list(C.sid, ALL)).body.messages.map((m) => m.status), 'C 的消息原样').toEqual(['pending']);
    });

    await test.step('关掉开关:GET config → stored {unfinished:3}(pending 2 + claimed 1,dismissed 不算)', async () => {
      const off = await api.setConfig({ enabled: false });
      expect(off.status, `前置:关开关${raw(off)}`).toBe(200);
      const r = await api.config();
      expect(r.status, `GET config 状态码${raw(r)}`).toBe(200);
      expect.soft(r.body && r.body.stored, `有 3 条未结束消息时 stored${raw(r)}`).toEqual({ unfinished: 3 });
    });

    await test.step('关着时 clear(带的请求体应被忽略)→ 200 {ok:true,removed:4};收件箱记录、正文、损坏留存全删;xsession 以外不动', async () => {
      fs.writeFileSync(path.join(dir, 'messages.json.corrupt-r151b-x26'), '{"坏的');
      const keepDir = path.join(guiDir(inst.home), 'xsession-r151b-keep'); // 与 xsession 同前缀的兄弟目录
      fs.mkdirSync(keepDir, { recursive: true });
      fs.writeFileSync(path.join(keepDir, 'keep.txt'), 'r151b keep');
      const prefsBefore = readText(prefsPath(inst.home));
      const before = inboxFiles(dir);
      expect(before, '前置:收件箱记录 messages.json 在').toContain('messages.json');
      for (const id of unfinishedIds) expect(before, `前置:未结束消息的正文 bodies/${id}.txt 在`).toContain(`bodies/${id}.txt`);
      expect(before, '前置:损坏留存文件在').toContain('messages.json.corrupt-r151b-x26');

      const r = await clear({ r151b: '请求体应被忽略' });
      expect.soft(r.status, `关着时 clear 状态码${raw(r)}`).toBe(200);
      expect.soft(r.body, `关着时 clear 应答(removed 含已结束的 1 条)${raw(r)}`).toEqual({ ok: true, removed: 4 });
      await new Promise((res) => setTimeout(res, 1_000)); // 等可能的延迟写盘落地,再看文件
      expect.soft(inboxFiles(dir), '收件箱记录 / 正文 / 损坏留存应全部删除').toEqual([]);
      expect(readText(path.join(keepDir, 'keep.txt')), 'xsession 以外(同前缀的兄弟目录)不动').toBe('r151b keep');
      expect(readText(prefsPath(inst.home)), '偏好文件不动').toBe(prefsBefore);
      for (const s of [A, B, C]) expect(fs.existsSync(s.file), `会话记录 ${path.basename(s.file)} 不动`).toBe(true);
    });

    await test.step('清空之后:stored 为 0,读取不产生文件;再 clear → 200 {ok:true,removed:0} 且不新建文件;重新打开开关后 B、C 一条消息都没有', async () => {
      const t0 = listTree(dir);
      const r = await api.config();
      expect.soft(r.body && r.body.stored, `清空后 stored${raw(r)}`).toEqual({ unfinished: 0 });
      expect.soft(listTree(dir), '清空后读取 stored 不产生文件').toEqual(t0);
      const again = await clear();
      expect.soft(again.status, `清空后再 clear 状态码${raw(again)}`).toBe(200);
      expect.soft(again.body, `清空后再 clear 应答${raw(again)}`).toEqual({ ok: true, removed: 0 });
      expect.soft(listTree(dir), '收件箱已不存在时 clear 不新建文件').toEqual(t0);
      await api.on();
      expect.soft((await api.list(B.sid, ALL)).body.messages, 'B 的消息(含已结束的)全部删除').toEqual([]);
      expect.soft((await api.list(C.sid, ALL)).body.messages, 'C 的消息全部删除').toEqual([]);
    });
  } finally { await inst.stop(); }

  await test.step('界面(共享实例):开着时没有提示;在设置块里关掉开关 → "仍有 2 条跨会话消息未处理。"+【清空】;点【清空】先出确认框,取消不清;确认 → clear 200 {ok:true,removed:2},提示与按钮消失', async () => {
    const api = xs();
    await api.off();
    const base = await post('/api/xsession/clear');
    expect.soft(base.status, `前置:先清掉共享实例上之前用例留下的消息${raw(base)}`).toBe(200);
    await api.on();
    const mark = uniq('R151BX26');
    const S = seedSession(`x26-s-${mark}`, { title: `${mark} 来源` });
    const T = seedSession(`x26-t-${mark}`, { title: `${mark} 目标` });
    await api.send(S.sid, [T.sid], `${mark} 一`);
    await api.send(S.sid, [T.sid], `${mark} 二`);
    const clears = recordRequests(page, '/api/xsession/clear');
    await boot(page);
    await openSessionSettings(page);
    const section = page.getByTestId('xsession-settings-section');
    await section.scrollIntoViewIfNeeded().catch(() => {});
    await expect(section).toBeVisible({ timeout: 10_000 });
    const toggle = section.getByTestId('xsession-toggle');
    const residual = section.getByTestId('xsession-residual');
    const clearBtn = section.getByTestId('xsession-clear');
    await expect(toggle, '前置:设置块里开关是开着的').toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
    expect(await page.getByTestId('xsession-residual').count(), '开关开着时不显示残留提示').toBe(0);
    expect(await page.getByTestId('xsession-clear').count(), '开关开着时不显示【清空】').toBe(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 10_000 });
    const cfg = await api.config();
    expect.soft(cfg.body && cfg.body.stored, `关掉后 stored${raw(cfg)}`).toEqual({ unfinished: 2 });
    await expect(residual, '关着且有 2 条未结束消息 → 设置块显示提示').toContainText('仍有 2 条跨会话消息未处理。');
    await expect(clearBtn, '提示旁的【清空】').toHaveText('清空');

    // 应用自己的确认框:同时含确认文案和"取消"按钮的最内层元素
    const confirmBox = page.locator('body *').filter({ hasText: CONFIRM_TEXT })
      .filter({ has: page.getByRole('button', { name: '取消', exact: true }) }).last();
    const cancelBtn = confirmBox.getByRole('button', { name: '取消', exact: true });
    const okBtn = confirmBox.getByRole('button', { name: '清空', exact: true });
    await clearBtn.click();
    await expect(confirmBox, '点【清空】先出确认框(文案逐字)').toBeVisible({ timeout: 10_000 });
    await expect(okBtn, '确认框里有确认按钮"清空"').toBeVisible();
    await cancelBtn.click();
    await expect(page.getByText(CONFIRM_TEXT).first(), '取消后确认框关闭').toBeHidden({ timeout: 10_000 });
    await page.waitForTimeout(500);
    expect(clears.filter((r) => r.method === 'POST'), '取消后不调 clear').toEqual([]);
    await expect(residual, '取消后提示还在').toBeVisible();

    await clearBtn.click();
    await expect(confirmBox).toBeVisible({ timeout: 10_000 });
    await expect(okBtn).toBeVisible();
    const respP = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/xsession/clear' && r.request().method() === 'POST');
    await okBtn.click();
    const resp = await respP;
    expect(resp.status(), '确认后 clear 状态码').toBe(200);
    expect(await resp.json(), '确认后 clear 应答').toEqual({ ok: true, removed: 2 });
    expect(clears.filter((r) => r.method === 'POST').length, '确认后只调一次 clear').toBe(1);
    await expect(residual, '清空后提示消失').toHaveCount(0, { timeout: 10_000 });
    await expect(clearBtn, '清空后【清空】消失').toHaveCount(0);
    expect((await api.config()).body.stored, '清空后 stored').toEqual({ unfinished: 0 });
    expect(inboxFiles(xsDir()), '共享实例的收件箱记录 / 正文已删').toEqual([]);
  });
});

test('X27 转发目标的隐藏标注:目标所在项目不在侧栏(没开「在项目列表显示 worktree 项目」)时,目标项标题后有 xs-forward-target-hidden"所在项目已隐藏",照常可选可发送;打开这项显示后重新打开对话框,标注消失', async ({ page }) => {
  const api = xs();
  await api.on();
  const mark = uniq('R151BX27');
  const A = seedSession(`x27-a-${mark}`, { title: `${mark} 来源`, reply: `${mark} 要转发的这条回复。` });
  const T = seedSession(`x27-t-${mark}`, { title: `${mark} 目标` });
  const tProj = path.basename(T.cwd);
  const posts = recordRequests(page, '/api/xsession/messages');
  await boot(page);
  // 按来源会话的完整标题搜:只搜 mark 会连目标会话一起命中
  await openSessionBySearch(page, A.title, A.reply);
  const dialog = page.getByTestId('xs-forward-dialog');
  const item = page.locator(`[data-testid="xs-forward-target"][data-session-id="${T.sid}"]`);
  const openDialog = async () => {
    await page.getByText(A.reply).first().hover();
    await page.getByTestId('xs-forward-btn').first().click();
    await expect(dialog, '对话框应打开').toBeVisible({ timeout: 10_000 });
    await page.getByTestId('xs-forward-search').fill(mark);
    await expect(item, '目标列表里有 T').toBeVisible({ timeout: 10_000 });
  };

  await test.step('不开「显示 worktree 项目」(T 的项目不在侧栏):目标项标题后有标注"所在项目已隐藏";选中它照常能发', async () => {
    expect(await sidebar(page).getByText(tProj).count(), '前置:T 所在项目不在侧栏').toBe(0);
    await openDialog();
    await expect.soft(item.getByTestId('xs-forward-target-hidden'), '目标项里的隐藏标注').toHaveText(HIDDEN_TEXT);
    const txt = await item.innerText();
    const at = txt.indexOf(T.title);
    expect.soft(at >= 0 && txt.indexOf(HIDDEN_TEXT) > at, `标注在标题之后(目标项文字:${JSON.stringify(txt)})`).toBe(true);
    const body = `${mark} 发给隐藏项目里的会话`;
    await page.getByTestId('xs-forward-body').fill(body);
    await item.click();
    await expect(page.getByTestId('xs-forward-send'), '选中带标注的目标后发送可点(带标注的目标照常可选)').toBeEnabled();
    const n0 = posts.length;
    await page.getByTestId('xs-forward-send').click();
    await expect(page.getByTestId('xs-forward-result'), '带标注的目标照常送达').toContainText(DELIVERED, { timeout: 15_000 });
    const sent = posts.slice(n0).filter((p) => p.method === 'POST');
    expect(sent.length, '发了一次转发请求').toBe(1);
    expect(sent[0].body.to, '目标就是 T').toEqual([T.sid]);
    expect((await api.list(T.sid)).body.messages.map((m) => m.body), 'T 收到这一条').toEqual([body]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  const restore = await showWorktreeProjects(page);
  let restoreErr = null;
  try {
    await test.step('打开「显示 worktree 项目」(T 的项目在侧栏)后重新打开对话框:标注消失', async () => {
      await expect(sidebar(page).getByText(tProj).first(), '前置:T 所在项目已在侧栏显示').toBeVisible({ timeout: 30_000 });
      await openDialog();
      await page.waitForTimeout(1_000);
      expect(await item.getByTestId('xs-forward-target-hidden').count(), '项目显示后没有隐藏标注').toBe(0);
      expect(await item.innerText(), '目标项文字里没有"所在项目已隐藏"').not.toContain(HIDDEN_TEXT);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5_000 });
    });
  } finally {
    try { await restore(); } catch (e) { restoreErr = String((e && e.message) || e).slice(0, 300); }
  }
  expect(restoreErr, '收尾:「在项目列表显示 worktree 项目」已拨回').toBeNull();
});

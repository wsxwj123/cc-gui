// r209 设置 → 高级 →「存储清理」页面。后端 A。每个用例开头 wipeMainBackups() 再造自己的备份(目录名 r209-dyn-*;u1 是静态会话,备份写在它自己的目录里)。
// 文案逐字取自接口文件 3.7;时间文字用页面自己的 toLocaleString('zh-CN',{hour12:false}) 算期望值(避免 Node 与 WebKit 的格式差异)。
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { STATIC } from './helpers/fixtures.mjs';
import { wipeMainBackups, dynDir, mainHome, putFile, putSession, userLine, hb, sidOf, tok, names, exists, backupNamesOf } from './helpers/common.mjs';
import { openApp, openSettings, settingsSearch, openStorageSection, tid, confirmHost, confirmButtons } from './helpers/ui.mjs';

const H = 3_600_000;
const base = () => Math.floor(Date.now() / 1000) * 1000;
const put = (dir, name, size, mt, content) => putFile(dir, name, { size, mtimeMs: mt ?? Date.now(), content });
const u1 = STATIC.u1;
const ROW = '[data-testid="histbak-row"]';
const rowOf = (page, sid) => page.locator(`${ROW}[data-session-id="${sid}"]`);
const fmt = (page, ms) => page.evaluate((x) => new Date(x).toLocaleString('zh-CN', { hour12: false }), ms);
const LINE2 = '直接删除,不进废纸篓,删了找不回;不影响会话记录本身。';

/** u1(present,在侧栏里能找到)+ 可选的 gone / elsewhere / unknown 三组。返回各自 sid 与路径。 */
function seed({ u1Files, gone, elsewhere, unknown }) {
  wipeMainBackups();
  const b = base(); const out = {};
  u1Files.forEach(([ageH, size]) => put(u1.dir, hb(u1.sid, b - ageH * H, tok('a')), size, b));
  if (gone) { out.goneSid = sidOf(101); out.goneDir = dynDir('ui'); put(out.goneDir, hb(out.goneSid, b - 5 * H, tok('a')), gone, b, userLine('R209 已删会话标题')); }
  if (elsewhere) { out.elseSid = sidOf(102); out.elseDir = dynDir('ui-a'); putSession(dynDir('ui-b'), out.elseSid); put(out.elseDir, hb(out.elseSid, b - 6 * H, tok('a')), elsewhere, b, 'not json'); }
  if (unknown) {
    out.unkSid = sidOf(103); out.unkDir = dynDir('ui-u');
    fs.mkdirSync(path.join(mainHome(), 'r209-outside'), { recursive: true }); fs.writeFileSync(path.join(mainHome(), 'r209-outside', 'u.jsonl'), `${userLine('u')}\n`);
    fs.mkdirSync(out.unkDir, { recursive: true }); fs.symlinkSync(path.join(mainHome(), 'r209-outside', 'u.jsonl'), path.join(out.unkDir, `${out.unkSid}.jsonl`));
    put(out.unkDir, hb(out.unkSid, b - H, tok('a')), unknown, b);
  }
  out.b = b; return out;
}

test('U1 页面显示:说明三段、汇总行、遗漏提示、按占用排序的会话行(标签/标题/时间范围/份数与大小),字节格式', async ({ page }) => {
  const s = seed({ u1Files: [[1, 1024], [2, 512], [3, 512]], gone: 2 * 1024 * 1024, elsewhere: 1024, unknown: 50 });
  await openApp(page);
  const sec = await openStorageSection(page);
  await expect(sec.getByText('存储清理').first()).toBeVisible();
  const rules = await tid(page, 'histbak-rules').innerText();
  for (const p of [
    '这是什么:回退、压缩片段、体检与清理、去掉思考块等操作改写会话记录之前,会把整份会话记录复制一份,放在会话记录所在的目录里(文件名含 .histbak- 或 .bak)。',
    '自动清理:只保留 14 天内的,每个会话最多保留最近 3 份;会话记录已不在的,它的备份也会删除;删除会话时,它的备份一并删除。应用启动后清理一次,运行期间定时检查。文件名以 .jsonl.bak 结尾的不自动清理,只能在这里手动删除。',
    '这里的删除是直接删除,不进废纸篓,删了找不回;不影响会话记录本身。',
  ]) expect(rules.replace(/\s+/g, ' '), '说明框应逐字含这一段').toContain(p);
  await expect(tid(page, 'histbak-summary')).toHaveText('共 5 份备份 · 占用 2.00 MB');
  await expect(tid(page, 'histbak-skipped')).toHaveText('有 1 份备份无法确认所属会话,未列出');
  const rows = page.locator(ROW);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0), '占用最大的在最前').toHaveAttribute('data-session-id', s.goneSid);
  await expect(rows.nth(1)).toHaveAttribute('data-session-id', u1.sid);
  await expect(rows.nth(2)).toHaveAttribute('data-session-id', s.elseSid);
  await expect(rows.nth(0)).toHaveAttribute('data-project-hash', 'r209-dyn-ui');
  await expect(rows.nth(0).getByTestId('histbak-gone')).toHaveText('会话已删除');
  await expect(rows.nth(0).getByTestId('histbak-title')).toHaveText('R209 已删会话标题');
  await expect(rows.nth(0).getByTestId('histbak-size')).toHaveText('1 份 · 2.00 MB');
  await expect(rows.nth(0).getByTestId('histbak-meta')).toHaveText(`${s.goneSid.slice(0, 8)} · ${await fmt(page, s.b - 5 * H)}`);
  await expect(rows.nth(1).getByTestId('histbak-title'), '会话还在且页面加载了它:用侧栏里的会话名').toContainText(u1.marker);
  await expect(rows.nth(1).getByTestId('histbak-size')).toHaveText('3 份 · 2.0 KB');
  await expect(rows.nth(1).getByTestId('histbak-meta')).toHaveText(`${u1.sid.slice(0, 8)} · ${await fmt(page, s.b - 3 * H)} – ${await fmt(page, s.b - H)}`);
  await expect(rows.nth(2).getByTestId('histbak-elsewhere')).toHaveText('会话记录在别的工作区目录');
  await expect(rows.nth(2).getByTestId('histbak-title')).toHaveText('(无标题)');
  await expect(rows.nth(2).getByTestId('histbak-size')).toHaveText('1 份 · 1.0 KB');
  await expect(rows.nth(1).getByTestId('histbak-delete-one')).toHaveAttribute('title', '删除这个会话的全部备份');
});

test('U2 删除单个会话的备份:先取消(不发请求、文件不少),再确认 → 请求路径、结果提示、该行消失、汇总更新、磁盘上只少这个会话的', async ({ page }) => {
  const s = seed({ u1Files: [[1, 1024], [2, 512], [3, 512]], gone: 2048 });
  const deletes = []; page.on('request', (r) => { if (r.method() === 'DELETE' && r.url().includes('/api/history-backups')) deletes.push(new URL(r.url()).pathname); });
  await openApp(page);
  await openStorageSection(page);
  await expect(tid(page, 'histbak-summary')).toHaveText('共 4 份备份 · 占用 4.0 KB');
  const row = rowOf(page, u1.sid);
  await row.getByTestId('histbak-delete-one').click();
  await expect(confirmHost(page)).toHaveCount(1);
  const lines = (await confirmHost(page).innerText()).split('\n').map((l) => l.trim()).filter(Boolean);
  expect(lines.slice(0, 2), '确认文字').toEqual(['删除这个会话的 3 份备份(共 2.0 KB)？', LINE2]);
  await confirmButtons(page).cancel.click();
  await expect(confirmHost(page)).toHaveCount(0);
  expect(deletes, '点取消不发任何删除请求').toEqual([]);
  expect(backupNamesOf(u1.dir, u1.sid).length, '取消后一份不少').toBe(3);
  await row.getByTestId('histbak-delete-one').click();
  await confirmButtons(page).confirm.click();
  await expect(tid(page, 'histbak-notice')).toHaveText('已删除 3 份,释放 2.0 KB');
  expect(deletes).toEqual([`/api/history-backups/${encodeURIComponent(u1.projectHash)}/${u1.sid}`]);
  await expect(page.locator(ROW)).toHaveCount(1);
  await expect(rowOf(page, u1.sid)).toHaveCount(0);
  await expect(tid(page, 'histbak-summary')).toHaveText('共 1 份备份 · 占用 2.0 KB');
  expect(backupNamesOf(u1.dir, u1.sid), 'u1 的备份删光').toEqual([]);
  expect(exists(u1.file), '会话记录本身还在').toBe(true);
  expect(backupNamesOf(s.goneDir, s.goneSid).length, '别的会话的备份不动').toBe(1);
});

test('U3 全部清理:确认文字含总份数与总大小;先取消不发请求;确认后列表清空显示「没有会话记录备份」,全部清理按钮禁用,归属不明的仍在磁盘上', async ({ page }) => {
  const s = seed({ u1Files: [[1, 512], [2, 512]], gone: 1024, elsewhere: 1024, unknown: 50 });
  const deletes = []; page.on('request', (r) => { if (r.method() === 'DELETE' && r.url().includes('/api/history-backups')) deletes.push(new URL(r.url()).pathname); });
  await openApp(page);
  await openStorageSection(page);
  await expect(tid(page, 'histbak-summary')).toHaveText('共 4 份备份 · 占用 3.0 KB');
  await tid(page, 'histbak-delete-all').click();
  const lines = (await confirmHost(page).innerText()).split('\n').map((l) => l.trim()).filter(Boolean);
  expect(lines.slice(0, 2)).toEqual(['删除全部 4 份会话记录备份(共 3.0 KB)？', LINE2]);
  await confirmButtons(page).cancel.click();
  expect(deletes, '点取消不发请求').toEqual([]);
  expect(backupNamesOf(u1.dir, u1.sid).length).toBe(2);
  await tid(page, 'histbak-delete-all').click();
  await confirmButtons(page).confirm.click();
  await expect(tid(page, 'histbak-notice')).toContainText('已删除 4 份,释放 3.0 KB');
  expect(deletes).toEqual(['/api/history-backups/all']);
  await expect(tid(page, 'histbak-empty')).toHaveText('没有会话记录备份');
  await expect(tid(page, 'histbak-summary')).toHaveText('共 0 份备份 · 占用 0 B');
  await expect(tid(page, 'histbak-delete-all'), '没有备份时禁用').toBeDisabled();
  await expect(tid(page, 'histbak-skipped')).toHaveText('有 1 份备份无法确认所属会话,未列出');
  expect(backupNamesOf(s.unkDir, s.unkSid).length, '归属不明的备份没删').toBe(1);
  expect(names(u1.dir), '会话记录本身还在').toEqual([`${u1.sid}.jsonl`]);
});

test('U4 设置搜索:搜「备份」「histbak」都能找到「会话记录备份清理」并跳到存储清理小节', async ({ page }) => {
  seed({ u1Files: [[1, 100]] });
  await openApp(page);
  await openSettings(page);
  for (const q of ['备份', 'histbak']) {
    await settingsSearch(page).fill(q);
    const hit = page.locator('button').filter({ hasText: '会话记录备份清理' }).first();
    await expect(hit, `搜「${q}」应出现「会话记录备份清理」`).toBeVisible({ timeout: 10_000 });
    await hit.click();
    await expect(page.locator('#set-storage'), `点结果后应看到存储清理小节(搜「${q}」)`).toBeVisible({ timeout: 10_000 });
    await openSettings(page);
  }
});

test('U5 列表读取失败:显示「读取备份列表失败:<error>」(没有 error 时用 HTTP 状态码)与「重试」,不显示空列表文案;重试成功后恢复', async ({ page }) => {
  seed({ u1Files: [[1, 100]] });
  const fail = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/api\/history-backups(\?.*)?$/, fail(500, { ok: false, code: 'X', error: 'boom' }));
  await openApp(page);
  await openStorageSection(page);
  await expect(tid(page, 'histbak-error')).toHaveText('读取备份列表失败:boom');
  await expect(tid(page, 'histbak-empty'), '加载失败时不显示空列表文案').toHaveCount(0);
  await page.unroute(/\/api\/history-backups(\?.*)?$/);
  await page.route(/\/api\/history-backups(\?.*)?$/, fail(503, {}));
  await page.getByRole('button', { name: '重试' }).click();
  await expect(tid(page, 'histbak-error')).toHaveText('读取备份列表失败:503');
  await page.unroute(/\/api\/history-backups(\?.*)?$/);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(tid(page, 'histbak-summary')).toHaveText('共 1 份备份 · 占用 100 B');
  await expect(tid(page, 'histbak-error')).toHaveCount(0);
});

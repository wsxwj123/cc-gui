// r209 历史操作之后的清理 + 删除会话时连带删备份。后端 A(自动清理被推迟到约 24.8 天后,用例期间不会自己动手)。
// 静态会话(h1/h2/d1/u1)在后端起来前由 run.sh 写好;备份文件由各用例开头自己造(先 wipeMainBackups,用例之间互不依赖)。
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { STATIC } from './helpers/fixtures.mjs';
import { api, wipeMainBackups, dynDir, putFile, hb, hbOld, bakTs, bakPlain, sidOf, tok, backupNamesOf, names, exists, DAY } from './helpers/common.mjs';
import { openApp, openSession, openWorkspaceGroup, rollbackOnly, sessionRows, confirmHost, TRIM_FAILED } from './helpers/ui.mjs';

const H = 3_600_000;
const mk = (dir, name, mtimeMs) => putFile(dir, name, { size: 200, mtimeMs });

test('H1 回退成功(200)后:同会话三种形态合计只剩3份、刚写的那份在且能按引用取到、邻居不受影响', async ({ page }) => {
  wipeMainBackups();
  const c = STATIC.h1; const now = Date.now();
  const old = { b1: hb(c.sid, now - H, tok('a')), b2: hbOld(c.sid, now - 2 * H), b3: bakTs(c.sid, now - 3 * H), b4: hb(c.sid, now - 4 * H, tok('b')), b5: hb(c.sid, now - 20 * DAY, tok('c')) };
  for (const n of Object.values(old)) mk(c.dir, n, now);
  mk(c.dir, bakPlain(c.sid), now - 30 * DAY);
  const other = sidOf(91); const otherNames = [1, 2, 3, 4, 5].map((i) => hb(other, now - i * H, tok('d')));
  for (const n of otherNames) mk(c.dir, n, now);
  const elseDir = dynDir('h1-else'); const elseNames = [1, 2, 3, 4].map((i) => hb(c.sid, now - i * H, tok('e')));
  for (const n of elseNames) mk(elseDir, n, now);

  await openSession(page, c);
  const respP = page.waitForResponse((r) => new RegExp(`/api/sessions/${c.sid}/trim(\\?|$)`).test(r.url()) && r.request().method() === 'POST' && !/"dryRun"\s*:\s*true/.test(r.request().postData() || ''), { timeout: 30_000 });
  await rollbackOnly(page, c.targetText);
  const resp = await respP;
  expect(resp.status(), '回退应成功(200)').toBe(200);
  const body = await resp.json();
  expect(typeof body.backupRef, '响应里应有字符串 backupRef').toBe('string');

  const group = backupNamesOf(c.dir, c.sid).filter((n) => n !== bakPlain(c.sid));
  const fresh = group.filter((n) => new RegExp(`^${c.sid}\\.jsonl\\.histbak-\\d{13}-[0-9a-f]{24}$`).test(n) && !Object.values(old).includes(n));
  expect(fresh.length, `应新写了 1 份 .histbak-<时刻>-<24位令牌>;目录里该会话的备份:${JSON.stringify(group)}`).toBe(1);
  expect(group.length, `三种形态合计应恰好 3 份;实际:${JSON.stringify(group)}`).toBe(3);
  expect([...group].sort(), '留下的应是:本次那份 + 最新的两份旧备份').toEqual([fresh[0], old.b1, old.b2].sort());
  expect(exists(path.join(c.dir, bakPlain(c.sid))), '古早 .jsonl.bak 不动').toBe(true);
  expect(names(c.dir).filter((n) => n.startsWith(other)).sort(), '同目录别的会话的备份一份不少').toEqual([...otherNames].sort());
  expect(names(elseDir).sort(), '别的目录里同编号的备份一份不少').toEqual([...elseNames].sort());
  expect(exists(c.file), '会话记录本身还在').toBe(true);

  const got = await api('GET', `/api/sessions/${c.sid}/backups/${encodeURIComponent(body.backupRef)}`);
  expect(got.status, `按 backupRef 应能取到刚写的备份(${got.text.slice(0, 200)})`).toBe(200);
  await expect(page.getByText(/在访达中显示/).first(), '右下角提示「在访达中显示」应出现').toBeVisible({ timeout: 10_000 });
});

test('H2 回退失败(消息已不在会话记录里):磁盘上该会话的备份一份不多一份不少', async ({ page }) => {
  wipeMainBackups();
  const c = STATIC.h2; const now = Date.now();
  for (let i = 1; i <= 5; i += 1) mk(c.dir, hb(c.sid, now - i * H, tok('a')), now);
  await openSession(page, c);
  const kept = fs.readFileSync(c.file, 'utf8').split('\n').filter((l) => l.trim() && !l.includes(c.targetText));
  fs.writeFileSync(c.file, `${kept.join('\n')}\n`);
  const before = names(c.dir);
  await rollbackOnly(page, c.targetText);
  await expect(page.locator('body'), `点回退后应出现黄字「${TRIM_FAILED}」`).toContainText(TRIM_FAILED, { timeout: 30_000 });
  expect(names(c.dir), '失败的回退不写新备份、也不清理旧备份:目录列表应与点之前完全相同').toEqual(before);
});

test('D1 删除会话(200 {deleted:true}):该会话三种形态备份全删,古早.bak、别的会话、别的目录的备份不受影响', async () => {
  wipeMainBackups();
  const c = STATIC.d1; const now = Date.now();
  const mine = [hb(c.sid, now - H, tok('a')), hb(c.sid, now - 20 * DAY, tok('b')), hbOld(c.sid, now - 2 * H), bakTs(c.sid, now - 3 * H)];
  for (const n of mine) mk(c.dir, n, now);
  mk(c.dir, bakPlain(c.sid), now - 30 * DAY);
  const other = sidOf(92); const otherN = [hb(other, now - H, tok('a')), bakTs(other, now - 2 * H)];
  for (const n of otherN) mk(c.dir, n, now);
  const elseDir = dynDir('d1-else'); const elseN = hb(c.sid, now - H, tok('c')); mk(elseDir, elseN, now);

  const res = await api('DELETE', `/api/sessions/${c.sid}?projectHash=${encodeURIComponent(c.projectHash)}`);
  expect(res.status, `删除会话应 200(${res.text.slice(0, 200)})`).toBe(200);
  expect(res.json, '响应体仍是 {deleted:true}').toEqual({ deleted: true });
  expect(exists(c.file), '会话记录本身已删').toBe(false);
  expect(backupNamesOf(c.dir, c.sid).filter((n) => n !== bakPlain(c.sid)), '该会话的三种形态备份应全部删除(不论新旧)').toEqual([]);
  expect(exists(path.join(c.dir, bakPlain(c.sid))), '古早 .jsonl.bak 不连带删除').toBe(true);
  expect(names(c.dir).filter((n) => n.startsWith(other)).sort(), '别的会话的备份不动').toEqual([...otherN].sort());
  expect(names(elseDir), '别的目录里同编号的备份不动').toEqual([elseN]);
});

test('D2 删除不存在的会话(404):它的备份一份不删', async () => {
  wipeMainBackups();
  const dir = dynDir('d2'); const ghost = sidOf(93); const now = Date.now();
  const bk = [hb(ghost, now - H, tok('a')), hbOld(ghost, now - 2 * H), bakTs(ghost, now - 3 * H)];
  for (const n of bk) mk(dir, n, now);
  const res = await api('DELETE', `/api/sessions/${ghost}?projectHash=${encodeURIComponent('r209-dyn-d2')}`);
  expect(res.status, `会话记录不存在应 404(${res.text.slice(0, 200)})`).toBe(404);
  expect(names(dir).sort(), '404 时不删任何备份').toEqual([...bk].sort());
});

test('D3 删除会话的确认框:原文不变,另起一行写明备份一并删除、删了找不回', async ({ page }) => {
  const c = STATIC.u1;
  await openApp(page);
  await openWorkspaceGroup(page, c);
  const row = sessionRows(page).filter({ hasText: c.marker }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.hover();
  await row.locator('xpath=..').getByTestId('session-actions-btn').click();
  await page.getByTestId('session-actions-delete').click();
  await expect(confirmHost(page), '点「删除会话」后应出现确认框').toHaveCount(1, { timeout: 5_000 });
  const text = await confirmHost(page).innerText();
  expect(text, '原有文字不变').toContain('删除该会话的本地历史记录');
  expect(text.split('\n').map((l) => l.trim()), '追加的一行(单独成行)').toContain('该会话的会话记录备份(.histbak 等)也会一并删除,删了找不回。');
  await page.keyboard.press('Escape');
  await expect(confirmHost(page), 'Esc 取消后确认框消失').toHaveCount(0, { timeout: 5_000 });
  expect(exists(c.file), '取消后会话记录还在').toBe(true);
});

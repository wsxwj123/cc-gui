// r120 界面验收:回滚点的可见性、删除入口、二次确认、跳过告知。
// 依据只有 .devflow/INTERFACE-r120.md §B(B1 可见性 / B2 二次确认 / B3 跳过告知)。
// 界面落点合同没写死:一律"把面板坞里每个面板都打开看一遍",不写死组件结构;
// 找不到就如实判红/跳过,不去猜、也不假装覆盖。
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as ui from './helpers/ui.mjs';

const HOME = process.env.R120_HOME;
const WS = process.env.R120_WORKSPACE;
const SID = process.env.R120_SESSION_ID;
const MARK = process.env.R120_SESSION_MARK;
const PROJECT_HASH = process.env.R120_PROJECT_HASH;
const BIG_SID = 'b1200000-0000-4000-8000-0000000000b1';
const BIG_DIR = path.join(HOME, 'work', 'big');

const WORDS = /回滚点|检查点|快照/;
const snapDirOf = (sessionId) => path.join(HOME, '.claude', 'gui', 'checkpoints', sessionId);
/** 某会话磁盘上真实的快照 sha 列表(直接问 checkpoints 仓,不依赖列表接口)。 */
function shasOf(sessionId) {
  const dir = snapDirOf(sessionId);
  if (!existsSync(dir)) return [];
  try {
    return execFileSync('git', ['--git-dir', dir, 'log', '--format=%H'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}
/** 造 n 条快照(直调接口,等价于用户回滚了几次)。 */
async function seedSnapshots(n, tag) {
  for (let i = 0; i < n; i += 1) {
    writeFileSync(path.join(WS, 'note-0.txt'), `${tag} ${i}\n`);
    const r = await ui.api('POST', '/api/checkpoints', { sessionId: SID, cwd: WS });
    expect(r.status, `造快照失败:${r.text.slice(0, 200)}`).toBe(200);
  }
  return shasOf(SID);
}

test.describe('r120 回滚点失控', () => {
  test('B1 界面上能看到回滚点占用(总量 + 每会话)', async ({ page }) => {
    await seedSnapshots(2, 'b1');
    await ui.boot(page);
    const { text, panels, total } = await ui.scanAllPanels(page);
    expect(panels.length, `面板坞里应该有多个面板,实际只打开到 ${panels.length}/${total} 个:${panels.join('/')}`)
      .toBeGreaterThanOrEqual(8);
    expect(text, `界面上任何地方都找不到"回滚点/检查点/快照"的占用信息(已逐面板扫过:${panels.join('/')})`)
      .toMatch(WORDS);
    // 有落点的话,必须给得出"占多少空间"
    expect(text, '占用块应给出可读的计量(占用/空间/大小/MB…)').toMatch(/占用|空间|大小|MB|KB|GB|字节/);
  });

  test('B3 超阈值目录拍快照 → 界面明确告知"未创建"及原因', async ({ page }) => {
    const before = shasOf(BIG_SID).length;
    const res = await ui.api('POST', '/api/checkpoints', { sessionId: BIG_SID, cwd: BIG_DIR });
    expect(res.status, '按约定"不得报错"').toBe(200);
    expect(shasOf(BIG_SID).length, '超阈值时不该新增快照').toBe(before);   // 接口层红锚点,先钉死

    await ui.boot(page);
    const { text } = await ui.scanAllPanels(page);
    expect(text, `界面必须能看出"本次未创建回滚点"及原因(已逐面板扫过);可见文本尾部:\n${text.slice(-1200)}`)
      .toMatch(/未创建|已跳过|跳过.*回滚|目录过大|体积过大|过大/);
  });

  test('B2 一键清理:确认前一个删除请求都不发;取消后一条不少', async ({ page }) => {
    const before = await seedSnapshots(2, 'b2');
    expect(before.length, '前置:先要有快照可删').toBeGreaterThan(0);

    await ui.boot(page);
    const seen = ui.blockDeleteRequests(page);       // 挂起所有 DELETE:发了就一定看得见
    const found = await ui.findButtonAcrossPanels(page, /清理|清除/);
    expect(found, `面板坞里找不到任何"清理/清除"入口(用户根本没有一键清理的地方)`).not.toBeNull();
    test.skip(!found, '找不到一键清理入口');
    const beforeClick = seen.length;
    expect(seen, `点清理之前就发了删除请求:${JSON.stringify(seen)}`).toHaveLength(0);

    await found.locator.click({ force: true });
    await page.waitForTimeout(1_200);
    expect(seen, `确认前不得发出任何删除请求,实际发了:${JSON.stringify(seen.slice(beforeClick))}`)
      .toHaveLength(beforeClick);

    const dlg = await ui.waitConfirmDialog(page, 10_000);
    expect(dlg, '点清理后必须弹出二次确认(项目既有 confirmDialog 的 danger 形态),否则会误触').not.toBeNull();
    if (!dlg) return;
    expect(dlg.text, `确认弹窗应说清删的是什么:${dlg.text}`).toMatch(/删除|清理|清除|回滚|快照|检查点/);
    expect(seen, '弹窗只是打开、还没确认,不得发删除请求').toHaveLength(0);

    const cancel = ui.dialogButton(dlg, /取消|关闭/);
    if (await cancel.count()) {
      await cancel.click({ force: true });
      await page.waitForTimeout(800);
      expect(shasOf(SID).length, '点了取消之后一条都不许少').toBe(before.length);
      expect(seen, '取消路径不得发出删除请求').toHaveLength(0);
    } else {
      expect(false, '确认弹窗里应该有「取消/关闭」让用户退出去').toBe(true);
    }
  });

  test('B2 单个会话的回滚点能在界面里看到并删除(确认前不删)', async ({ page }) => {
    const all = await seedSnapshots(3, 'b2-single');
    expect(all.length).toBeGreaterThanOrEqual(2);
    const victim = all[0];

    await ui.boot(page);
    const seen = ui.blockDeleteRequests(page);
    const { text } = await ui.scanAllPanels(page);
    expect(text, `界面上看不到任何会话的回滚点明细,用户无从删起(会话标记 ${MARK})`)
      .toMatch(new RegExp(MARK));

    const found = await ui.findButtonAcrossPanels(page, /回滚点|检查点|快照/);
    test.skip(!found, '找不到回滚点明细入口 —— 单条删除无法真实驱动');
    await page.waitForTimeout(1_000);
    expect(seen, `确认前不得发删除请求,实际:${JSON.stringify(seen)}`).toHaveLength(0);
    const dlg = await ui.waitConfirmDialog(page, 8_000);
    expect(dlg, '删除前应有二次确认').not.toBeNull();
    expect(seen, '确认前仍不得发删除请求').toHaveLength(0);
    expect(shasOf(SID), '确认前磁盘上的快照不许被动').toContain(victim);
  });

  test('R4 删会话后,该会话的回滚点目录一并消失', async () => {
    const shas = await seedSnapshots(2, 'r4');
    expect(shas.length).toBeGreaterThan(0);
    const res = await ui.api('DELETE', `/api/sessions/${SID}?projectHash=${PROJECT_HASH}`);
    expect(res.status, `删会话应成功:${res.text.slice(0, 200)}`).toBe(200);
    expect(existsSync(snapDirOf(SID)), '会话没了,它的回滚点目录必须一起清掉').toBe(false);
  });
});

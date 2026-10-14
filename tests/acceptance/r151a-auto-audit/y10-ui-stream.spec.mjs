// I 组:消息流里的提示(INTERFACE Y.3.3 / Y.3.4 "消息流里的提示")。
// 假 claude 按脚本吐事件;事件形态照 2026-10-14 用本机真实 CLI(2.1.296)对本地假接口实录的样子:
//   {type:"system", subtype:"permission_denied", tool_name, tool_use_id, decision_reason_type:"classifier", decision_reason, message}
//   {type:"system", subtype:"permission_check_status", tool_use_id, status:"checking"|"done"}
//   can_use_tool 控制请求里的 decision_reason:"3 consecutive actions were blocked. Please review the transcript before continuing.\n\nLatest blocked action: …"
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { useProvider, tpAutoOff, resetOverrides, writeScript, touchCtl, snapshot, SETTINGS } from './helpers/api.mjs';
import { boot, openFreshSession, sendPrompt } from './helpers/ui.mjs';
import { UI } from './helpers/texts.mjs';
import { provider } from './helpers/scenes.mjs';

let saved = {};
test.beforeEach(async () => { saved = snapshot([SETTINGS()]); await tpAutoOff(); resetOverrides({}); await useProvider(await provider('main')); });
test.afterEach(async () => { for (const [p, c] of Object.entries(saved)) if (c !== null) fs.writeFileSync(p, c); });

const REASON = 'R151 mock: writes outside the working directory';
const BLOCK_MSG = `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${REASON}. If you have other tasks that don't depend on this action, continue working on those.`;
const UNAVAIL_MSG = 'r151-main is temporarily unavailable (server error), so auto mode cannot determine the safety of Bash right now. Wait a moment and then try this action again.';
let k = 0;
const uid = (tag) => `${tag}-${Date.now().toString(36)}-${(k += 1)}`;
const toolId = (tag) => `toolu_r151_${tag.replace(/[^a-z0-9]/gi, '')}_${Date.now().toString(36)}`;
const denied = (id, extra) => ({ emit: { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: id, decision_reason_type: 'classifier', decision_reason: REASON, message: BLOCK_MSG, ...extra } });
const notices = (page) => page.locator('[data-testid="denial-notice"]');

/** 在一条新打开的会话里跑一段脚本。 */
async function runScript(page, tag, steps) {
  const name = uid(tag);
  writeScript(name, steps);
  await boot(page);
  await openFreshSession(page, tag);
  await sendPrompt(page, `R151S:${name} 跑一下`);
  return name;
}

test.describe('I 拒绝提示行(denial-notice)', () => {
  test('I1 自动档审核的判定结果 → data-denial-kind="blocked",文案「已拒绝 Bash(自动档审核):<原因>」', async ({ page }) => {
    const id = toolId('i1');
    await runScript(page, 'i1', [{ toolUse: { id, name: 'Bash', input: { command: 'touch ../r151-i1' } } }, denied(id), { toolResult: { tool_use_id: id, content: BLOCK_MSG, is_error: true } }, { say: 'R151-I1-DONE' }]);
    await expect(notices(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(notices(page).first()).toHaveAttribute('data-denial-kind', 'blocked');
    await expect(notices(page).first()).toContainText(UI.denialBlocked('Bash', REASON));
  });

  for (const [label, extra, reasonShown] of [
    ['原因等于 Classifier unavailable', { decision_reason: 'Classifier unavailable', message: 'auto mode classifier could not run' }, 'Classifier unavailable'],
    ['原因以 Auto mode could not evaluate 开头', { decision_reason: 'Auto mode could not evaluate this action (timeout)', message: 'auto mode classifier gave no verdict' }, 'Auto mode could not evaluate this action (timeout)'],
    ['说明文字含 temporarily unavailable', { decision_reason: 'R151 其它原因', message: UNAVAIL_MSG }, 'R151 其它原因'],
  ]) {
    test(`I2 ${label} → data-denial-kind="unavailable",文案「未执行 Bash:审核模型没有给出结论(<原因>)。这不是对该操作安全性的判定。」`, async ({ page }) => {
      const id = toolId('i2');
      await runScript(page, 'i2', [{ toolUse: { id, name: 'Bash', input: { command: 'touch ../r151-i2' } } }, denied(id, extra), { say: 'R151-I2-DONE' }]);
      await expect(notices(page)).toHaveCount(1, { timeout: 15_000 });
      await expect(notices(page).first()).toHaveAttribute('data-denial-kind', 'unavailable');
      await expect(notices(page).first()).toContainText(UI.denialUnavailable('Bash', reasonShown));
    });
  }

  test('I3 其它来源(权限规则)的拒绝 → data-denial-kind="other",不带自动档审核的字样', async ({ page }) => {
    const id = toolId('i3');
    await runScript(page, 'i3', [{ toolUse: { id, name: 'Bash', input: { command: 'rm -rf build' } } },
      denied(id, { decision_reason_type: 'rule', decision_reason: 'Bash(rm:*) 在拒绝规则里', message: 'Permission to use Bash with command rm -rf build has been denied.' }), { say: 'R151-I3-DONE' }]);
    await expect(notices(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(notices(page).first()).toHaveAttribute('data-denial-kind', 'other');
    await expect(notices(page).first()).not.toContainText('(自动档审核)');
    await expect(notices(page).first()).not.toContainText('审核模型没有给出结论');
  });

  test('I4 同一个 tool_use_id 的拒绝事件来两次 → 只出现一行', async ({ page }) => {
    const id = toolId('i4');
    await runScript(page, 'i4', [{ toolUse: { id, name: 'Bash', input: { command: 'touch ../r151-i4' } } }, denied(id), denied(id), { say: 'R151-I4-DONE' }]);
    await expect(page.getByText('R151-I4-DONE').first()).toBeVisible({ timeout: 15_000 });
    await expect(notices(page)).toHaveCount(1);
  });

  test('I5 原因超过 300 字 → 显示的原因被截断(不出现全文),前段仍可见', async ({ page }) => {
    const id = toolId('i5');
    const long = `R151长原因${'甲乙丙丁戊己庚辛壬癸'.repeat(40)}尾巴标记R151TAIL`;
    await runScript(page, 'i5', [{ toolUse: { id, name: 'Bash', input: { command: 'touch ../r151-i5' } } }, denied(id, { decision_reason: long }), { say: 'R151-I5-DONE' }]);
    await expect(notices(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(notices(page).first()).toHaveAttribute('data-denial-kind', 'blocked');
    await expect(notices(page).first()).toContainText(long.slice(0, 200));
    await expect(notices(page).first()).not.toContainText('R151TAIL');
  });
});

test.describe('I 审核进行中(audit-checking)', () => {
  const checking = (id, status = 'checking') => ({ emit: { type: 'system', subtype: 'permission_check_status', tool_use_id: id, status } });

  test('I6 收到 status:"checking" → 出现「正在审核 Bash…」;同一 tool_use_id 的 status:"done" → 消失', async ({ page }) => {
    const id = toolId('i6');
    const gate = `go-${uid('i6')}`;
    await runScript(page, 'i6', [{ toolUse: { id, name: 'Bash', input: { command: 'ls' } } }, checking(id), { waitFile: gate }, checking(id, 'done'), { sleep: 1500 }, { toolResult: { tool_use_id: id, content: 'ok' } }, { say: 'R151-I6-DONE' }]);
    const el = page.getByTestId('audit-checking');
    await expect(el).toHaveText(UI.checking('Bash'), { timeout: 15_000 });
    touchCtl(gate);
    await expect(el).toHaveCount(0, { timeout: 1_400 });
  });

  test('I6b 按 tool_use_id 找不到工具名 → 显示「正在审核操作…」', async ({ page }) => {
    const gate = `go-${uid('i6b')}`;
    await runScript(page, 'i6b', [checking('toolu_r151_nowhere'), { waitFile: gate }, { say: 'R151-I6b-DONE' }]);
    await expect(page.getByTestId('audit-checking')).toHaveText(UI.CHECKING_UNKNOWN, { timeout: 15_000 });
    touchCtl(gate);
  });

  test('I6c 没等到 done,但该工具的结果到了 → 「正在审核」消失', async ({ page }) => {
    const id = toolId('i6c');
    const gate = `go-${uid('i6c')}`;
    await runScript(page, 'i6c', [{ toolUse: { id, name: 'Bash', input: { command: 'ls' } } }, checking(id), { waitFile: gate }, { toolResult: { tool_use_id: id, content: 'ok' } }, { sleep: 3000 }, { say: 'R151-I6c-DONE' }]);
    const el = page.getByTestId('audit-checking');
    await expect(el).toBeVisible({ timeout: 15_000 });
    touchCtl(gate);
    await expect(el).toHaveCount(0, { timeout: 2_500 });
  });

  test('I6d 没等到 done,回合直接结束 → 「正在审核」消失', async ({ page }) => {
    const id = toolId('i6d');
    const gate = `go-${uid('i6d')}`;
    await runScript(page, 'i6d', [{ toolUse: { id, name: 'Bash', input: { command: 'ls' } } }, checking(id), { waitFile: gate }, { result: {} }]);
    const el = page.getByTestId('audit-checking');
    await expect(el).toBeVisible({ timeout: 15_000 });
    touchCtl(gate);
    await expect(el).toHaveCount(0, { timeout: 5_000 });
  });

  test('I6e 缺 tool_use_id 或 status 不是 checking/done 的事件被忽略(同一流里合法的那条照常显示)', async ({ page }) => {
    const id = toolId('i6e');
    const gate1 = `go1-${uid('i6e')}`;
    const gate2 = `go2-${uid('i6e')}`;
    await runScript(page, 'i6e', [{ toolUse: { id, name: 'Bash', input: { command: 'ls' } } },
      { emit: { type: 'system', subtype: 'permission_check_status', status: 'checking' } },
      { emit: { type: 'system', subtype: 'permission_check_status', tool_use_id: id, status: 'pending' } },
      { waitFile: gate1 }, checking(id), { waitFile: gate2 }, checking(id, 'done'), { say: 'R151-I6e-DONE' }]);
    await page.waitForTimeout(2_500);
    await expect(page.getByTestId('audit-checking'), '非法事件不应让「正在审核」出现').toHaveCount(0);
    touchCtl(gate1);
    await expect(page.getByTestId('audit-checking'), '阳性对照:合法事件应显示').toHaveText(UI.checking('Bash'), { timeout: 10_000 });
    touchCtl(gate2);
  });
});

test.describe('I 权限卡上的连续拦截提示(perm-audit-streak)', () => {
  const ask = (id, reason) => ({ canUseTool: { tool_name: 'Bash', display_name: 'Bash', input: { command: `touch ../${id}`, description: 'r151' }, description: 'r151',
    permission_suggestions: [], blocked_path: `/tmp/${id}`, decision_reason: reason, decision_reason_type: 'classifier', tool_use_id: id } });

  test('I7 原因以 "3 consecutive actions were blocked" 开头 → 卡上原因之前多一行「自动审核已连续拦下多次操作,这一次由你决定。」', async ({ page }) => {
    const id = toolId('i7');
    const reason = `3 consecutive actions were blocked. Please review the transcript before continuing.\n\nLatest blocked action: ${REASON}`;
    await runScript(page, 'i7', [{ toolUse: { id, name: 'Bash', input: { command: `touch ../${id}` } } }, ask(id, reason), { say: 'R151-I7-DONE' }]);
    const streak = page.getByTestId('perm-audit-streak');
    await expect(streak).toHaveText(UI.STREAK, { timeout: 15_000 });
    const reasonEl = page.getByText('Latest blocked action', { exact: false }).first();
    await expect(reasonEl).toBeVisible();
    const before = await streak.evaluate((s, r) => Boolean(s.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING), await reasonEl.elementHandle());
    expect(before, '提示行应在原因之前').toBe(true);
  });

  test('I7b 原因中间含 "consecutive actions were blocked"(不在开头)→ 也有这一行', async ({ page }) => {
    const id = toolId('i7b');
    await runScript(page, 'i7b', [{ toolUse: { id, name: 'Bash', input: { command: `touch ../${id}` } } }, ask(id, `Note: 5 consecutive actions were blocked. Latest: ${REASON}`), { say: 'R151-I7b-DONE' }]);
    await expect(page.getByTestId('perm-audit-streak')).toHaveText(UI.STREAK, { timeout: 15_000 });
  });

  test('I7c 普通原因的权限卡 → 没有这一行', async ({ page }) => {
    const id = toolId('i7c');
    await runScript(page, 'i7c', [{ toolUse: { id, name: 'Bash', input: { command: `touch ../${id}` } } }, ask(id, 'This command writes outside the working directory R151I7C'), { say: 'R151-I7c-DONE' }]);
    await expect(page.getByText('R151I7C', { exact: false }).first(), '权限卡应已出现').toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('perm-audit-streak')).toHaveCount(0);
  });
});

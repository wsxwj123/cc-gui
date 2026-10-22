// B. 页面与服务端(行为 R07–R13,另加 R12b/R12c 两条"大小写/反引号"变体)。
// 共享隔离实例(run.sh 起:临时 HOME + 假 claude 外壳 + vite dev server);每条用例自己种一个会话、写一份"以指定报错文案收场"的假 claude 剧本,
// 然后在页面里打开会话、发一句话,看错误气泡下的清理卡 / 指引文字。只走页面与 HTTP,不 import 产品代码。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedSession, ctlDir, encodeProjectDir, newSid, uniq } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { boot, openSessionBySearch, sendPrompt } from '../r151b-xsession-p1/helpers/ui.mjs';
import * as T from './texts.mjs';

test.describe.configure({ timeout: 150_000 });

const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];

/** 假 claude 剧本:不管当前是哪个权限档位,都以"API 报错"收场(文本 = text),并像真 CLI 一样往会话记录追加那条报错行。 */
function writeErrorScript(name, text) {
  const dir = path.join(ctlDir(), 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  const steps = [
    ...MODES.map((mode) => ({ errorIfMode: { mode, status: 400, transcript: true, text } })),
    { result: { is_error: true, api_error_status: 400, result: text } },
  ];
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(steps));
}

/** 普通会话:一问一答,没有任何空段落。 */
function plainSeed(name) {
  const tag = uniq(name);
  const seed = seedSession(`r151r-${tag}`, { title: `R151R ${tag}`, reply: `${tag} 旧回复` });
  return { ...seed, tag };
}

/** 带空段落的会话:2 段纯空白 thinking(" \n"、"  ")+ 1 段空 text(""),其余为正常文字。 */
function emptiesSeed(name) {
  const tag = uniq(name);
  const sid = newSid();
  const title = `R151R ${tag}`;
  const reply1 = `${tag} 正常回复一`;
  const reply2 = `${tag} 正常回复二`;
  const t0 = Date.parse('2026-10-01T08:00:00.000Z');
  const ts = (n) => new Date(t0 + n * 1000).toISOString();
  const user = (n, parent, text) => ({ type: 'user', uuid: `${sid}-u${n}`, parentUuid: parent, timestamp: ts(n), message: { role: 'user', content: text } });
  const asst = (n, parent, content) => ({
    type: 'assistant', uuid: `${sid}-a${n}`, parentUuid: parent, timestamp: ts(n), requestId: `req_${sid.slice(0, 8)}_${n}`,
    message: { id: `msg_${sid.slice(0, 8)}_${n}`, type: 'message', role: 'assistant', model: 'r151-chat', content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } },
  });
  const lines = [
    { type: 'summary', summary: title, leafUuid: `${sid}-a3` },
    user(0, null, `${title} 第一问`),
    asst(1, `${sid}-u0`, [{ type: 'thinking', thinking: ' \n', signature: 'sigA' }, { type: 'text', text: reply1 }]),
    user(2, `${sid}-a1`, `${title} 第二问`),
    asst(3, `${sid}-u2`, [{ type: 'thinking', thinking: '  ', signature: 'sigB' }, { type: 'text', text: '' }, { type: 'text', text: reply2 }]),
  ];
  const seed = seedSession(`r151r-${tag}`, { sid, title, lines });
  return { ...seed, tag, reply: reply1, reply1, reply2 };
}

/** 数会话记录里空或纯空白的 text / thinking 段落。 */
function countEmpties(file) {
  let emptyText = 0;
  let emptyThinking = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o = null;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o && o.message && o.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text' && String(b.text ?? '').trim() === '') emptyText += 1;
      if (b.type === 'thinking' && String(b.thinking ?? '').trim() === '') emptyThinking += 1;
    }
  }
  return { emptyText, emptyThinking };
}

/** 打开种子会话、发一句话让假 claude 以 errorText 收场,等错误文案(snippet)显示出来;返回报错文字的定位器。 */
async function failTurn(page, seed, errorText, snippet) {
  const script = `r151r-${uniq('s')}`;
  writeErrorScript(script, errorText);
  await boot(page);
  await openSessionBySearch(page, seed.tag, seed.reply);
  await sendPrompt(page, `R151S:${script} 请继续`);
  const errBox = page.getByText(snippet).first();
  await expect(errBox, '回合报错应显示在错误气泡里').toBeVisible({ timeout: 40_000 });
  return errBox;
}

const cardButton = (page) => page.getByRole('button', { name: T.CARD_BUTTON });

/** 目标元素的顶边不得高于参照元素(= 在它下面或同一行之后)。 */
async function expectNotAbove(target, ref, what) {
  const a = await target.boundingBox();
  const b = await ref.boundingBox();
  expect(a && b, `${what}:两个元素都应有可见位置`).toBeTruthy();
  expect(a.y, `${what}:应在报错文字之下`).toBeGreaterThanOrEqual(b.y);
}

/** 指引应在报错原文之后、另起一行(按页面可见文字的先后顺序判断,不区分大小写;页面会吃掉反引号,两边都先去掉)。 */
async function expectGuidanceOnNewLineAfterError(page, plainError, guide) {
  const norm = (s) => s.replace(/`/g, '').toLowerCase();
  const text = norm(await page.locator('body').innerText());
  const g = text.indexOf(norm(guide));
  expect(g, '指引原文应出现在页面上').toBeGreaterThanOrEqual(0);
  const e = text.lastIndexOf(norm(plainError), g);
  expect(e, '指引之前应有报错原文').toBeGreaterThanOrEqual(0);
  expect(text.slice(e + plainError.length, g), '指引应在报错原文之后另起一行').toContain('\n');
}

test('R07 回合以「each thinking block must contain non-whitespace thinking」报错结束 → 错误气泡下出现按钮「体检与清理(自动备份原文件)…」', async ({ page }) => {
  const errBox = await failTurn(page, plainSeed('r07'), T.ERR_THINKING_BLANK, T.SNIP_THINKING_BLANK);
  const btn = cardButton(page).first();
  await expect(btn, '应出现清理卡按钮').toBeVisible({ timeout: 20_000 });
  await expectNotAbove(btn, errBox, '清理卡按钮');
});

test('R08 同 R07,会话记录里有 2 段纯空白 thinking、1 段空 text → 卡片说明为「…(空text 1 处/空thinking 2 处)」', async ({ page }) => {
  await failTurn(page, emptiesSeed('r08'), T.ERR_THINKING_BLANK, T.SNIP_THINKING_BLANK);
  await expect(page.getByText(T.cardDescDone(1, 2)).first(), '体检结果到达后卡片说明应写出空段落数').toBeVisible({ timeout: 30_000 });
});

test('R09 (相邻) 回合以旧文案「text content blocks must be non-empty」报错结束 → 照旧出现清理卡按钮', async ({ page }) => {
  await failTurn(page, plainSeed('r09'), T.ERR_TEXT_EMPTY, T.SNIP_TEXT_EMPTY);
  await expect(cardButton(page).first(), '旧文案应照旧挂清理卡').toBeVisible({ timeout: 20_000 });
});

test('R10 (相邻) 回合以「prompt is too long」报错结束 → 没有清理卡,也没有清理卡指引和签名指引', async ({ page }) => {
  await failTurn(page, plainSeed('r10'), T.ERR_TOO_LONG, T.SNIP_TOO_LONG);
  await page.waitForTimeout(2_000); // 没有"出现"这个正向信号可等,留一小段时间让可能的清理卡/体检结果渲染出来
  await expect(cardButton(page), '不该有清理卡按钮').toHaveCount(0);
  await expect(page.getByText(T.GUIDE_CARD), '不该有清理卡指引').toHaveCount(0);
  await expect(page.getByText(T.GUIDE_SIGNATURE), '不该有签名指引').toHaveCount(0);
});

test('R11 R07 场景下,清理卡里有固定指引「清理只删除空段落。清理后仍被拒：…」', async ({ page }) => {
  await failTurn(page, plainSeed('r11'), T.ERR_THINKING_BLANK, T.SNIP_THINKING_BLANK);
  await expect(page.getByText(T.GUIDE_CARD).first(), '清理卡里应有指引原文').toBeVisible({ timeout: 20_000 });
});

for (const [id, label, errorText] of [
  ['R12', '「Invalid `signature` in `thinking` block」', T.ERR_SIGNATURE],
  ['R12b', '去掉反引号的「Invalid signature in thinking block」', T.ERR_SIGNATURE_NO_TICKS],
  ['R12c', '全大写的「INVALID `SIGNATURE` IN `THINKING` BLOCK」', T.ERR_SIGNATURE_UPPER],
]) {
  test(`${id} 回合以${label}报错结束 → 报错原文之后另起一行给出切回 provider 指引;没有清理卡按钮`, async ({ page }) => {
    await failTurn(page, plainSeed(id.toLowerCase()), errorText, T.SIG_ERROR_RE);
    await expect(page.getByText(T.GUIDE_SIGNATURE).first(), '错误气泡里应有签名报错指引原文').toBeVisible({ timeout: 20_000 });
    await expectGuidanceOnNewLineAfterError(page, T.SIG_ERROR_PLAIN, T.GUIDE_SIGNATURE);
    await page.waitForTimeout(1_000);
    await expect(cardButton(page), '签名报错不该挂清理卡').toHaveCount(0);
  });
}

test('R13 (相邻) 对含空 thinking/text 的会话在体检与清理窗口执行清理 → 空段落被删、生成备份、再体检无可清理', async ({ page, request }) => {
  const seed = emptiesSeed('r13');
  expect(countEmpties(seed.file), '前置:种子会话里有 1 段空 text、2 段纯空白 thinking').toEqual({ emptyText: 1, emptyThinking: 2 });
  const checkUrl = `${process.env.R151B_API_BASE}/api/sessions/${seed.sid}/repair-official-compat?projectHash=${encodeURIComponent(encodeProjectDir(seed.cwd))}`;
  const before = await (await request.get(checkUrl)).json();
  console.log(`[R13] 清理前体检:${JSON.stringify(before).slice(0, 600)}`);
  expect(before.report, '前置:清理前体检应报出 1 段空 text、2 段空 thinking').toMatchObject({ emptyText: 1, emptyThinking: 2 });

  await boot(page);
  await openSessionBySearch(page, seed.tag, seed.reply1);
  await page.locator('[data-cgui="session-menu"] button').last().click();
  const entry = page.locator('button[title^="官方兼容体检与清理"]');
  await expect(entry, '会话菜单里应有「官方兼容体检与清理」入口').toBeVisible({ timeout: 20_000 });
  await entry.click();
  const clean = page.getByRole('button', { name: /^清理[（(]自动备份原文件[）)]$/ });
  await expect(clean, '体检结果出来后应能点「清理（自动备份原文件）」').toBeVisible({ timeout: 60_000 });
  console.log(`[R13] 体检窗口文字:${(await page.locator('div.glass-popover').last().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500)}`);
  await clean.click();
  await expect(page.getByText('官方兼容修复完成').first(), '清理完成应有提示').toBeVisible({ timeout: 60_000 });

  expect(countEmpties(seed.file), '清理后会话记录里不再有空或纯空白的 text / thinking 段落').toEqual({ emptyText: 0, emptyThinking: 0 });
  const kept = fs.readFileSync(seed.file, 'utf8');
  expect(kept, '正常文字必须保留').toContain(seed.reply1);
  expect(kept, '正常文字必须保留').toContain(seed.reply2);
  const dir = path.dirname(seed.file);
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith(`${seed.sid}.jsonl.histbak-`));
  expect(backups.length, '应在会话目录生成 .histbak-* 备份').toBeGreaterThan(0);
  expect(countEmpties(path.join(dir, backups[0])), '备份应是清理前的原文').toEqual({ emptyText: 1, emptyThinking: 2 });

  const again = await request.get(checkUrl);
  expect(again.status()).toBe(200);
  const recheck = await again.json();
  console.log(`[R13] 清理后再体检:${JSON.stringify(recheck).slice(0, 600)}`);
  expect(recheck.report, '再次体检:空 text、空 thinking 两项都为 0').toMatchObject({ emptyText: 0, emptyThinking: 0 });
  expect(recheck.changed, '再次体检:已无可清理内容').toBe(false);
});

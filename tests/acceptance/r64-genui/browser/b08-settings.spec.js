// B8 设置里的两件事(INTERFACE §4)。渲染开关在浏览器本地、技能状态在模型侧,
// 两者各有独立真相来源、互不代表、互不纠正。
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, TID, ctl, bootUI, modelSays, fence, dismissOverlays, openGenuiSettings, closeSettings, clickSafe, waitTurnEnd } from './harness.js';

const UI = { items: [{ type: 'text', content: 'RENDERED-BLOCK' }] };
const skillsDir = (app) => path.join(app.home, '.claude', 'skills');
const listSkills = (app) => { try { return fs.readdirSync(skillsDir(app)); } catch { return []; } };

const section = (page) => page.getByTestId(TID.settingsSection);
/** 打开设置并回传渲染开关(§9.7:Cmd/Ctrl+0 → settings-search 输入 genui)。 */
const openToggle = async (page) => (await openGenuiSettings(page)).getByTestId(TID.genuiToggle);

// 每条用例都从"未安装"起跑。本组用例会装/归档/删技能,而同一个 worker 里的用例
// 共用同一份临时 HOME —— 上一条留下的技能目录会让下一条一开局就不是未安装态,
// 于是并行调度顺序一变就时红时绿(实测 B86/B89/B99/B100 轮流翻车)。
// 这里只是**复位起点**,不碰任何断言。
test.beforeEach(async ({ app }) => {
  for (const d of [skillsDir(app), path.join(app.home, '.claude', 'skills-archive')]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});


test('B86 渲染开关默认是开的', async ({ page, app }) => {
  await bootUI(page, app);
  await expect(await openToggle(page)).toBeChecked();
});

test('B87 关掉：围栏退回普通代码块，JSON 原文可见可复制', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(UI), { box });
  await page.getByTestId(TID.block).first().waitFor({ timeout: 20_000 });
  const toggle = await openToggle(page);
  await toggle.uncheck();
  await closeSettings(page);
  await expect(page.getByTestId(TID.block)).toHaveCount(0);
  await expect(page.getByTestId(TID.source)).toBeVisible();
  await expect(page.getByTestId(TID.source)).toContainText('RENDERED-BLOCK');
});

test('B88 关掉后历史消息里的围栏同样退回代码块', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(UI), { box });
  // 连发两回合必须等第一回合收尾:会话忙着的时候第二条会进队列,
  // 表现成"第一回合整条不在 DOM、第二回合正文出现两次"。
  // (只在这条需要连发的用例里等,不放进 modelSays —— 那会把不需要等的用例拖慢拖红。)
  await waitTurnEnd(page);
  await modelSays(page, app, '第二回合正文', { box });
  await waitTurnEnd(page);
  await page.getByTestId(TID.block).first().waitFor({ timeout: 20_000 });
  const toggle = await openToggle(page);
  await toggle.uncheck();
  await closeSettings(page);
  await expect(page.getByTestId(TID.block)).toHaveCount(0);
  await expect(page.getByTestId(TID.source)).toHaveCount(1);
});

test('B89 流式进行中关掉：正在写的那条当场退回代码块，不等回合结束', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence(UI) + '\n\n' + '还在写。'.repeat(200), { box, hold: true });
  await page.getByTestId(TID.block).first().waitFor({ timeout: 20_000 });
  const toggle = await openToggle(page);
  await toggle.uncheck();
  await closeSettings(page);
  await expect(page.getByTestId(TID.block), '不等回合结束就要退回代码块').toHaveCount(0, { timeout: 4000 });
  await expect(page.getByTestId(TID.source)).toBeVisible();
  ctl.release(app);
});

test('B90 关了再开：重新渲染成组件，且交互状态仍在', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence({ items: [{ type: 'input', label: '格', id: 'k1' }] }), { box });
  const block = page.getByTestId(TID.block).first();
  await block.waitFor({ timeout: 20_000 });
  await block.getByRole('textbox').first().fill('KEEP-ME');
  let toggle = await openToggle(page);
  await toggle.uncheck();
  await closeSettings(page);
  await expect(page.getByTestId(TID.source)).toBeVisible();
  toggle = await openToggle(page);
  await toggle.check();
  await closeSettings(page);
  await expect(page.getByTestId(TID.block).first().getByRole('textbox').first()).toHaveValue('KEEP-ME');
});

test('B91 开关不影响 html/svg/mermaid 的既有预览', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, fence('<b>hi</b>', 'html'), { box });
  const toggle = await openToggle(page);
  await toggle.uncheck();
  await closeSettings(page);
  // 判据用锚不用按钮文案:文案会变、渲染时机也会抖。要守的回归是
  // "genui 的开关不把 html 围栏接管过去",这一点用 testid 判定最稳
  // (与 b01 里 B03-B05 同一口径)。
  await expect(page.getByTestId(TID.block), 'html 围栏不该被 genui 接管').toHaveCount(0);
  await expect(page.getByTestId(TID.source), 'html 围栏不该走 genui 的降级代码块').toHaveCount(0);
  await expect(page.getByTestId(TID.notice), 'html 围栏不该出现 genui 的说明条').toHaveCount(0);
});

test('B92 关掉后模型仍可能输出围栏，只是显示成代码块（不是 bug）', async ({ page, app }) => {
  const box = await bootUI(page, app);
  const toggle = await openToggle(page);
  await toggle.uncheck();
  await closeSettings(page);
  await modelSays(page, app, fence(UI), { box });
  await expect(page.getByTestId(TID.source)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId(TID.block)).toHaveCount(0);
  await expect(page.getByTestId(TID.notice), '这不是错误,不该弹说明条').toHaveCount(0);
});

// ── 技能状态(模型侧,与上面的渲染开关互不代表)──────────────────────────────
const state = (page) => section(page).getByTestId(TID.skillState);
const act = (page) => section(page).getByTestId(TID.skillAction);

test('B93 技能三态显示，且每次打开设置都现读真实状态（不缓存）', async ({ page, app }) => {
  await bootUI(page, app);
  await openGenuiSettings(page);
  await expect(state(page)).toHaveText('未安装');
  await act(page).click();                                   // 安装
  await expect(state(page)).toHaveText('已安装');
  expect(listSkills(app).length, '磁盘上应当真的多了一个技能目录').toBeGreaterThan(0);
  const name = listSkills(app)[0];
  // 绕过界面，直接把技能从磁盘上挪走：重开设置必须现读到"未安装"
  fs.renameSync(path.join(skillsDir(app), name), path.join(app.home, '.moved-' + name));
  await closeSettings(page);
  await openGenuiSettings(page);
  await expect(state(page), '必须现读磁盘真实状态,不能读缓存').toHaveText('未安装');
});

test('B94 界面明示影响范围与生效时机', async ({ page, app }) => {
  await bootUI(page, app);
  await openGenuiSettings(page);
  const note = section(page).getByTestId(TID.skillScopeNote);
  await expect(note).toBeVisible();
  await expect(note).toContainText('所有 claude CLI 会话');
  await expect(note).toContainText('新会话');
});

test('B95 在既有技能管理面板里归档，设置里跟着变（同一个真相来源）', async ({ page, app }) => {
  await bootUI(page, app);
  await openGenuiSettings(page);
  await act(page).click();
  await expect(state(page)).toHaveText('已安装');
  await closeSettings(page);
  // §9.7 可达性:技能面板的入口在面板坞 rail 里,先展开坞
  await clickSafe(page, page.getByTestId(TID.panelDockToggle));
  const panel = page.getByRole('button', { name: /技能/ });
  await clickSafe(page, panel.first());
  await page.getByRole('button', { name: '归档' }).first().click();
  await closeSettings(page);
  await openGenuiSettings(page);
  await expect(state(page), '两处必须是同一个真相来源').toHaveText('已归档');
});

test('B96 技能已存在时点安装：不覆盖，显示“已安装”', async ({ page, app }) => {
  await bootUI(page, app);
  // 先取到技能目录名:装一次、读出名字、再彻底删掉,回到"未安装"
  await openGenuiSettings(page);
  await act(page).click();
  await expect(state(page)).toHaveText('已安装');
  const name = listSkills(app)[0];
  fs.rmSync(path.join(skillsDir(app), name), { recursive: true, force: true });
  await closeSettings(page);

  // 重开设置:现读磁盘 → 未安装,此时动作按钮才是「安装」
  await openGenuiSettings(page);
  await expect(state(page), '文件删掉后现读应为未安装').toHaveText('未安装');

  // 点之前,从外部把同名技能连同用户改过的内容放回去
  const file = path.join(skillsDir(app), name, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '用户自己改过的内容-DO-NOT-OVERWRITE');

  await act(page).click();                                     // 这一下是「安装」
  await expect(state(page)).toHaveText('已安装');
  expect(fs.readFileSync(file, 'utf8'), '已存在时安装不得覆盖(那等于销毁用户数据)')
    .toContain('DO-NOT-OVERWRITE');
});

test('B97 安装失败（目标目录不可写）：显示明确原因，状态保持“未安装”', async ({ page, app }) => {
  await bootUI(page, app);
  fs.mkdirSync(skillsDir(app), { recursive: true });
  fs.chmodSync(skillsDir(app), 0o500);                        // 只读,写不进去
  try {
    await openGenuiSettings(page);
    await act(page).click();
    await expect(state(page), '失败了就不能显示成功').toHaveText('未安装');
    // 「权限」等既有 tab 文案会撞上这条正则,必须限定在 genui 设置区内
    await expect(section(page).getByText(/失败|无法|权限/).first()).toBeVisible({ timeout: 8000 });
  } finally { fs.chmodSync(skillsDir(app), 0o700); }
});

test('B98 归档时技能已被手动删掉：视为已达成，不报错、不弹错误框', async ({ page, app }) => {
  await bootUI(page, app);
  await openGenuiSettings(page);
  await act(page).click();
  await expect(state(page)).toHaveText('已安装');
  // 界面先翻态、落盘随后:等磁盘上真出现技能目录再去动它
  await expect.poll(() => listSkills(app).length, { timeout: 8000 }).toBeGreaterThan(0);
  const name = listSkills(app)[0];
  fs.rmSync(path.join(skillsDir(app), name), { recursive: true, force: true });
  await act(page).click();                                    // 点归档
  await expect(state(page)).toHaveText(/已归档|未安装/);
  await expect(page.getByRole('alertdialog'), '不该弹错误框').toHaveCount(0);
  expect(page.__logs.join('\n')).not.toMatch(/pageerror/i);
});

test('B99 恢复时本机已有同名技能：拒绝并提示，不覆盖', async ({ page, app }) => {
  await bootUI(page, app);
  await openGenuiSettings(page);
  await act(page).click();                                    // 安装
  await expect(state(page)).toHaveText('已安装');
  await expect.poll(() => listSkills(app).length, { timeout: 8000 }).toBeGreaterThan(0);
  const name = listSkills(app)[0];
  await act(page).click();                                    // 归档
  await expect(state(page)).toHaveText('已归档');
  fs.mkdirSync(path.join(skillsDir(app), name), { recursive: true });
  fs.writeFileSync(path.join(skillsDir(app), name, 'SKILL.md'), '别人的同名技能-MINE');
  await act(page).click();                                    // 恢复
  await expect(page.getByText(/已存在|同名|无法恢复/)).toBeVisible({ timeout: 8000 });
  expect(fs.readFileSync(path.join(skillsDir(app), name, 'SKILL.md'), 'utf8')).toContain('MINE');
});

test('B100+B101 开关开着但技能已归档：不是错误，不自动纠正、不弹警告；重启后也不对账', async ({ page, app }) => {
  await bootUI(page, app);
  let toggle = await openToggle(page);
  await expect(toggle).toBeChecked();
  await act(page).click();                                    // 安装
  // 动作按钮同一时刻只有一个(§4.2):必须等它从「安装」翻成「归档」再点第二下,
  // 否则两下都打在「安装」上,状态压根不会走到已归档。
  await expect(state(page)).toHaveText('已安装');
  await act(page).click();                                    // 归档
  await expect(state(page)).toHaveText('已归档');
  await expect(toggle, '技能归档不得顺手把渲染开关也关了').toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // 界面先翻态、落盘随后:刷新前等磁盘上的真相也变过来,
  // 否则重启后现读到的还是旧状态(这条本来就是在验"重启后现读真实状态")。
  await expect.poll(() => listSkills(app).length, { timeout: 8000 }).toBe(0);
  await page.reload();
  await dismissOverlays(page);
  toggle = await openToggle(page);
  await expect(toggle, '重启后开关仍从浏览器本地读').toBeChecked();
  await expect(state(page), '重启后技能仍是真实状态,两者都不对账').toHaveText('已归档');
});

test('B102 技能刚装完、当前会话还在进行：这一轮拿不到新技能是预期', async ({ page, app }) => {
  const box = await bootUI(page, app);
  await modelSays(page, app, '第一回合', { box, hold: true });
  await openGenuiSettings(page);
  await act(page).click();
  await expect(state(page)).toHaveText('已安装');
  // 仅新会话生效:趁设置**还开着**断言这句说明,关掉之后设置区就不在 DOM 里了
  await expect(section(page).getByTestId(TID.skillScopeNote)).toContainText('新会话');
  await closeSettings(page);
  ctl.release(app);
  expect(page.__logs.join('\n')).not.toMatch(/pageerror/i);
});

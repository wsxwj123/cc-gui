import { test, expect } from '@playwright/test';
import { closePanelTerminals, dismissTransientOverlays, getRuntime } from './helpers/runtime.mjs';

// FB-T36（R01/R29 用户复现链路）：顶栏"终端"打开面板 → 执行算式得可见结果 → 收起 →
// 重新展开：旧输出仍在且 shell 可继续执行新算式 → exit 结束（出现"重新连接"、旧输出保留、不再接受输入）。
//
// 使用的黑盒合同句柄：顶栏"终端"按钮、终端标签"关闭…"按钮、页面文本定位（白名单内）、page.keyboard。
//
// 顺序无关：本用例结束时面板里的 shell 不得再存活。正常路径由用例自身的 exit 结束；中途失败则由
// finally 用合同入口"标签关闭"结束自己开的 shell，不把终端名额留给后面的用例。
//
// 黑盒合同下不可表达/已声明假设（详见交付报告）：
// 1. 输入路径：打开面板后先等 shell 提示符文本可见（终端就绪证据）再用 page.keyboard 输入。
//    不点终端内部元素——实测提示符文本节点被终端自身的指针接收层遮挡，合同句柄点不中。
//    该路径依赖"面板打开时终端自动获得键盘焦点"：隔离实例 Chromium 实测打开与重新展开后直接输入
//    都能落入终端；若产品改为必须先点击面板才聚焦，本用例会以输出不可见失败，属真实信号而非误报。
// 2. 就绪等待匹配"user@host … 提示符字符结尾"的通用 shell 提示符形状；测环境须使用带 user@host
//    的交互式 shell（当前隔离实例为 zsh 默认提示符）。
// 3. 输出断言依赖终端以 DOM 文本渲染；若使用 canvas/WebGL 渲染器，文本不在 DOM 中，
//    getByText 观测不到，需平台人工验证。
// 4. 自然退出的退出码具体展示格式合同未锁定，此处只以"重新连接"按钮出现作为退出已被识别的证据。

const TERMINAL_TOGGLE = { name: '终端', exact: true };
const SHELL_PROMPT = /@[^\s@]+\s.*[%$#]\s*$/;

test('FB-T36 收起终端面板不结束shell：重开后旧输出保留且可继续交互，exit后出现重新连接', async ({ page }) => {
  const { baseURL } = getRuntime();

  await page.goto(baseURL);
  await dismissTransientOverlays(page); // 关闭会遮挡/抢焦点的偶发浮层

  // 顶栏"终端"显示/收起面板（合同点名的入口）
  const terminalToggle = page.getByRole('button', TERMINAL_TOGGLE).first();
  try {
    await terminalToggle.click();

    // 等终端就绪：shell 提示符出现在可见文本里，之后键盘输入才会落入终端
    await expect(page.getByText(SHELL_PROMPT).first()).toBeVisible();

    // 第一次算式：CALC1_42 只可能来自 shell 求值输出——输入回显是未求值的 "$(( 21 * 2 ))"
    const firstOutput = 'CALC1_42';
    await page.keyboard.type('echo CALC1_$(( 21 * 2 ))');
    await page.keyboard.press('Enter');
    await expect(page.getByText(firstOutput)).toBeVisible();

    // 收起面板：终端内容从可见 UI 消失（收起而非关闭）
    await terminalToggle.click();
    await expect(page.getByText(firstOutput)).toBeHidden();

    // 重新展开：旧输出仍在——收起只分离显示，不杀死 shell（R01）
    await terminalToggle.click();
    await expect(page.getByText(firstOutput)).toBeVisible();

    // shell 仍可继续交互：执行第二个新算式并得到求值输出
    await page.keyboard.type('echo CALC2_$(( 50 + 8 ))');
    await page.keyboard.press('Enter');
    await expect(page.getByText('CALC2_58')).toBeVisible();

    // 显式 exit 结束该 shell
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '重新连接' })).toBeVisible();

    // 自然退出保留已有输出（合同：界面显示退出码并保留已有输出；此处验证保留部分）
    await expect(page.getByText(firstOutput)).toBeVisible();

    // 反向断言：退出后 shell 不再接受输入，新算式不产生求值输出
    await page.keyboard.type('echo AFTER_EXIT_$(( 1 + 1 ))');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await expect(page.getByText('AFTER_EXIT_2')).toHaveCount(0);
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

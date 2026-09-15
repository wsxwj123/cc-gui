import { test, expect } from '@playwright/test';
import { closePanelTerminals, fixtureSection, openFixtureFile } from './helpers/runtime.mjs';

// 夹具载体与制备前提（本套件不用会话级 URL：产品任何路径都渲染首页，夹具一律经公开 UI 点选打开，
// 导航实现见 helpers/runtime.mjs 的 openFixtureFile，细节见 README「夹具导航」）：
// 夹具 = 夹具项目根目录下的 markdown 文件（manifest.markdown.fileName，内含 bash 代码块
// runnableMarker/runnableCommand），导航 = 侧栏搜索 manifest.markdown.sessionSearchMarker
// 打开该项目会话 → 顶栏「设置」→「文件」→ 点文件名 → 文件预览 → 点代码块"运行"。
// 文件预览里同样有代码块"运行"入口与确认框（黑盒可见，实测与断言同形）；无模型凭据也可制备本夹具。
// 局限：本轮无模型凭据，未覆盖聊天回复里的代码块运行入口，需具备真实模型时补验（见 README）。
//
// FB-T24（R06/R29）：对含 bash 代码块的会话点代码块"运行"：
// 1. 确认框显示将执行的完整命令；
// 2. "本次会话记住"不可由内容默认勾选（合同：不可由内容默认勾选）；
// 3. 确认后命令真实执行且只执行一次——执行证据是 shell 输出独有的标记文本出现在终端里
//    （expectedRunOutput 是求值结果，输入回显只含未求值命令，合同明确输入回显不能算执行证据）。
//
// 使用的黑盒合同句柄：公开 UI 点选导航（夹具）、pre（Markdown 渲染产物标准语义元素）、
// "运行"按钮（合同点名文案）、dialog（标准 ARIA 角色）、checkbox（标准 input 元素）、页面文本定位、
// 终端标签"关闭此标签(结束对应进程)"（收尾用，合同点名的终端标签"关闭"）。
//
// 顺序无关：确认运行会打开终端面板并留下一个存活 shell；关闭浏览器页面不会结束它，不清理就会占住
// maxTerminals=4 名额。本用例在 finally 用合同入口"标签关闭"结束自己开出来的 shell。
//
// 合同模糊点（详见交付报告）：确认框的确认按钮文案合同未点名，此处按 常见命名 匹配；
// 另假设"运行"按钮位于代码块 pre 元素内部，若产品放在 pre 之外，黑盒合同内无法建立二者的归属关联。

test('FB-T24 bash代码块点运行：确认框显示完整命令，确认后命令真实执行一次（shell输出标记为证）', async ({ page }) => {
  const markdown = fixtureSection('markdown');
  const command = markdown.runnableCommand;
  const expectedOutput = markdown.expectedRunOutput;

  try {
    await openFixtureFile(page, markdown);

    // 用运行标记定位唯一的目标代码块（pre 是白名单内的标准语义元素）
    const codeBlock = page.locator('pre', { hasText: markdown.runnableMarker });
    await expect(codeBlock).toHaveCount(1);
    await codeBlock.getByRole('button', { name: '运行' }).click();

    // 确认框出现，并显示将执行的完整命令（不是摘要/截断）
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(command)).toBeVisible();

    // "本次会话记住"类复选框不允许被内容默认勾选
    const checkboxes = dialog.locator('input[type="checkbox"]');
    const checkboxCount = await checkboxes.count();
    for (let i = 0; i < checkboxCount; i++) {
      await expect(checkboxes.nth(i)).not.toBeChecked();
    }

    // 确认执行（确认按钮文案合同未锁定，见文件头说明）
    await dialog.getByRole('button', { name: /^(确认|确定|运行)$/ }).click();

    // 确认后自动打开终端面板并执行一次：求值结果标记可见
    await expect(page.getByText(expectedOutput)).toBeVisible();

    // 执行证据恰好一次：完整命令只执行一遍（若执行两次，标记输出会出现两份）
    await expect(page.getByText(expectedOutput)).toHaveCount(1);
  } finally {
    await closePanelTerminals(page).catch(() => null);
  }
});

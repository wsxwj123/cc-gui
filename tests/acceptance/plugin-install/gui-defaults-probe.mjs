import { chromium } from '@playwright/test';

const guiUrl = process.env.R33_GUI_URL;
const chromeExecutable = process.env.R33_CHROME_EXECUTABLE;

if (!guiUrl || !chromeExecutable) {
  throw new Error('R33_GUI_URL and R33_CHROME_EXECUTABLE are required');
}

const browser = await chromium.launch({
  headless: true,
  executablePath: chromeExecutable,
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  const captured = [];

  await page.route('**/api/plugins/install', async (route) => {
    let payload;
    try {
      payload = route.request().postDataJSON();
    } catch {
      payload = { invalidPostData: route.request().postData() };
    }
    captured.push(payload);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  const dismissVisibleOverlays = async () => {
    for (let pass = 0; pass < 6; pass += 1) {
      let dismissed = false;
      for (const label of ['稍后', '跳过', '以后再说', '已知晓']) {
        const button = page.locator('button').filter({ hasText: label }).last();
        if (await button.isVisible().catch(() => false)) {
          await button.click({ force: true });
          await page.waitForTimeout(150);
          dismissed = true;
        }
      }
      if (!dismissed) return;
    }
  };

  await page.goto(guiUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await dismissVisibleOverlays();

  await page.locator('button').filter({ hasText: '设置' }).first().click();
  await page.waitForTimeout(200);
  await dismissVisibleOverlays();
  await page.locator('button').filter({ hasText: /^工具$/ }).click();
  await page.waitForTimeout(300);
  await dismissVisibleOverlays();
  await page.locator('button[role="tab"]').filter({ hasText: /^插件$/ }).click();
  await page.waitForTimeout(700);
  await dismissVisibleOverlays();
  await page.locator('button').filter({ hasText: /^添加$/ }).last().click();
  await page.getByText('添加插件', { exact: true }).waitFor();
  await page.getByText(/Anthropic 官方精选/).waitFor();
  await dismissVisibleOverlays();

  const allInstallCards = page.locator('button')
    .filter({ hasText: /^安装$/ })
    .locator('xpath=..');
  const defaultCards = allInstallCards.filter({ hasNotText: '第三方源' });
  const defaultCardCount = await defaultCards.count();
  const totalInstallCardCount = await allInstallCards.count();
  if (defaultCardCount === 0) throw new Error('public GUI selectors found no default install cards');

  for (let index = 0; index < defaultCardCount; index += 1) {
    const card = defaultCards.nth(index);
    await card.locator('button').filter({ hasText: /^安装$/ }).click();
    await page.waitForTimeout(100);
    const acknowledge = page.locator('button').filter({ hasText: /^知道了$/ }).last();
    if (await acknowledge.isVisible().catch(() => false)) await acknowledge.click();
  }

  process.stdout.write(`${JSON.stringify({ defaultCardCount, totalInstallCardCount, payloads: captured })}\n`);
} finally {
  await browser.close();
}

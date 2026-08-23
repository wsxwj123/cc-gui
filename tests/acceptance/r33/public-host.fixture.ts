import { expect, test, type FilePayload, type Locator, type Page } from '@playwright/test';

/**
 * These tests exercise a real, externally hosted application. Each URL must
 * expose the public UI described in .devflow/INTERFACE.md and arrange only the
 * stated precondition. Missing scenarios are skipped instead of being replaced
 * by an in-process product mock.
 */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  test.skip(!value, `public acceptance host is missing ${name}`);
  return value ?? 'about:blank';
}

export async function openScenario(page: Page, envName: string): Promise<void> {
  await page.goto(requiredEnv(envName));
  await expect(page.locator('body')).toBeVisible();
}

export function textFixture(name: string): string {
  return requiredEnv(name);
}

export function attachment(name: string, body = `r33:${name}`): FilePayload {
  return {
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(body, 'utf8'),
  };
}

export async function addAttachments(page: Page, files: FilePayload[]): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('home-attachment-add').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}

export async function choosePublicOption(page: Page, control: Locator, optionName: string): Promise<void> {
  if ((await control.evaluate((node) => node.tagName)) === 'SELECT') {
    await control.selectOption({ label: optionName });
    return;
  }

  await control.click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

export async function publicControlValue(control: Locator): Promise<string> {
  return control.evaluate((node) => {
    if (node instanceof HTMLSelectElement || node instanceof HTMLInputElement) {
      return node.value;
    }
    return [
      node.getAttribute('aria-label'),
      node.getAttribute('aria-valuetext'),
      node.getAttribute('data-value'),
      node.textContent,
    ].filter(Boolean).join('|');
  });
}

type GoalDomSample = {
  count: number;
  texts: string[];
  url: string;
};

export async function installGoalDomObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    type GoalObserverWindow = Window & {
      __r33GoalObserver?: MutationObserver;
      __r33GoalSamples?: GoalDomSample[];
    };
    const observedWindow = window as GoalObserverWindow;
    observedWindow.__r33GoalObserver?.disconnect();
    observedWindow.__r33GoalSamples = [];
    const capture = () => {
      const texts = Array.from(document.querySelectorAll('[data-testid="goal-bar"]'))
        .map((node) => node.textContent?.trim() ?? '');
      observedWindow.__r33GoalSamples?.push({ count: texts.length, texts, url: location.href });
    };
    capture();
    observedWindow.__r33GoalObserver = new MutationObserver(capture);
    observedWindow.__r33GoalObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

export async function goalDomSamples(page: Page): Promise<GoalDomSample[]> {
  return page.evaluate(() => {
    const observedWindow = window as Window & { __r33GoalSamples?: GoalDomSample[] };
    return observedWindow.__r33GoalSamples ?? [];
  });
}

export async function installPlanCardCountObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    type PlanObserverWindow = Window & {
      __r33PlanObserver?: MutationObserver;
      __r33PlanCounts?: number[];
    };
    const observedWindow = window as PlanObserverWindow;
    observedWindow.__r33PlanObserver?.disconnect();
    observedWindow.__r33PlanCounts = [];
    const capture = () => observedWindow.__r33PlanCounts?.push(
      document.querySelectorAll('[data-testid="plan-card"]').length,
    );
    capture();
    observedWindow.__r33PlanObserver = new MutationObserver(capture);
    observedWindow.__r33PlanObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

export async function planCardCountSamples(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const observedWindow = window as Window & { __r33PlanCounts?: number[] };
    return observedWindow.__r33PlanCounts ?? [];
  });
}

export { expect, test };

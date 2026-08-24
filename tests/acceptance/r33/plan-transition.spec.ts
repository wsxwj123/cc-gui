import {
  expect,
  installPlanCardCountObserver,
  openScenario,
  planCardCountSamples,
  requiredEnv,
  test,
  textFixture,
} from './public-host.fixture';

test.describe('r33 plan reconciliation', () => {
  test('R33-PLAN-001 repeated realtime plans never exceed one card and history merges approval', async ({ page }) => {
    await openScenario(page, 'R33_REALTIME_PLAN_URL');
    const plans = page.getByTestId('plan-card');
    await expect(plans).toHaveCount(1);
    const firstCardText = await plans.innerText();
    await installPlanCardCountObserver(page);

    const repeatAction = page.getByRole('button', {
      name: textFixture('R33_REPEAT_PLAN_ACTION'),
      exact: true,
    });
    for (let repetition = 0; repetition < 15; repetition += 1) {
      await repeatAction.click();
      await expect(plans).toHaveCount(1);
    }

    await page.getByRole('button', {
      name: textFixture('R33_HISTORY_ACTION'),
      exact: true,
    }).click();
    await expect(plans).toHaveCount(1);
    await expect.poll(() => plans.innerText()).toContain(firstCardText.trim());
    await expect(plans).toContainText(textFixture('R33_APPROVAL_VISIBLE_TEXT'));
    const observedCounts = await planCardCountSamples(page);
    expect(observedCounts.length).toBeGreaterThan(0);
    expect(Math.max(...observedCounts)).toBe(1);
  });

  test('R33-PLAN-002 CRLF, LF, and surrounding whitespace are one equivalent plan', async ({ page }) => {
    await openScenario(page, 'R33_PLAN_WHITESPACE_EQUIVALENCE_URL');
    await expect(page.getByTestId('plan-card')).toHaveCount(1);
    await expect(page.getByTestId('plan-card')).toContainText(textFixture('R33_EQUIVALENT_PLAN_SENTINEL'));
  });

  test('R33-PLAN-003 internal Markdown differences are not merged', async ({ page }) => {
    await openScenario(page, 'R33_PLAN_INTERNAL_MARKDOWN_DIFFERENCE_URL');
    const plans = page.getByTestId('plan-card');
    await expect(plans).toHaveCount(2);
    await expect(plans.filter({ hasText: textFixture('R33_MARKDOWN_VARIANT_A_TEXT') })).toHaveCount(1);
    await expect(plans.filter({ hasText: textFixture('R33_MARKDOWN_VARIANT_B_TEXT') })).toHaveCount(1);
  });

  test('R33-PLAN-004 fast draft-to-real session switching does not duplicate or cross-wire plans', async ({ page }) => {
    await openScenario(page, 'R33_DRAFT_PLAN_URL');
    const draftSentinel = textFixture('R33_DRAFT_PLAN_SENTINEL');
    await expect(page.getByTestId('plan-card')).toHaveCount(1);
    await expect(page.getByTestId('plan-card')).toContainText(draftSentinel);

    await page.goto(requiredEnv('R33_OTHER_SESSION_PLAN_URL'), { waitUntil: 'domcontentloaded' });
    await page.goto(requiredEnv('R33_REAL_SESSION_PLAN_URL'), { waitUntil: 'domcontentloaded' });
    const realPlans = page.getByTestId('plan-card');
    await expect(realPlans).toHaveCount(1);
    await expect(realPlans).toContainText(draftSentinel);
    await expect(realPlans).not.toContainText(textFixture('R33_OTHER_SESSION_PLAN_SENTINEL'));
  });
});

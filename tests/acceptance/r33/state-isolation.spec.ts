import {
  expect,
  goalDomSamples,
  installGoalDomObserver,
  openScenario,
  requiredEnv,
  test,
  textFixture,
} from './public-host.fixture';

test.describe('r33 goal and plan state isolation', () => {
  test('R33-STATE-001 hidden goal survives session switches and reload', async ({ page }) => {
    await openScenario(page, 'R33_GOAL_SESSION_A_URL');
    await expect(page.getByTestId('goal-bar')).toBeVisible();
    await page.getByTestId('goal-hide').click();
    await expect(page.getByTestId('goal-bar')).toHaveCount(0);

    await page.goto(requiredEnv('R33_GOAL_SESSION_B_URL'));
    await expect(page.getByTestId('goal-bar')).toBeVisible();
    await page.goto(requiredEnv('R33_GOAL_SESSION_A_URL'));
    await expect(page.getByTestId('goal-bar')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('goal-bar')).toHaveCount(0);
  });

  test('R33-STATE-002 goal hiding is scoped to goal identity and session', async ({ page }) => {
    await openScenario(page, 'R33_GOAL_IDENTITY_A_URL');
    await page.getByTestId('goal-hide').click();
    await expect(page.getByTestId('goal-bar')).toHaveCount(0);

    await page.goto(requiredEnv('R33_GOAL_IDENTITY_B_URL'));
    await expect(page.getByTestId('goal-bar')).toBeVisible();
    await page.goto(requiredEnv('R33_GOAL_OTHER_SESSION_URL'));
    await expect(page.getByTestId('goal-bar')).toBeVisible();
    await page.goto(requiredEnv('R33_GOAL_IDENTITY_A_URL'));
    await expect(page.getByTestId('goal-bar')).toHaveCount(0);
  });

  test('R33-STATE-003 hiding a goal leaves its plan visible and interactive', async ({ page }) => {
    await openScenario(page, 'R33_GOAL_WITH_PLAN_URL');
    const plan = page.getByTestId('plan-card');
    const before = await plan.innerText();

    await page.getByTestId('goal-hide').click();
    await expect(page.getByTestId('goal-bar')).toHaveCount(0);
    await expect(plan).toBeVisible();
    await page.getByTestId('plan-toggle').click();
    await expect.poll(() => plan.innerText()).not.toBe(before);
  });

  test('R33-STATE-004 plan can expand and then collapse on the same page', async ({ page }) => {
    await openScenario(page, 'R33_PLAN_SESSION_A_URL');
    const plan = page.getByTestId('plan-card');
    const initialText = await plan.innerText();
    await page.getByTestId('plan-toggle').click();
    await expect.poll(() => plan.innerText()).not.toBe(initialText);
    await page.getByTestId('plan-toggle').click();
    await expect.poll(() => plan.innerText()).toBe(initialText);
  });

  test('R33-STATE-005 plan hiding persists and does not affect goal, todo, or another session', async ({ page }) => {
    await openScenario(page, 'R33_ISOLATION_SESSION_A_URL');
    const todoAText = textFixture('R33_TODO_A_TEXT');
    await page.getByTestId('plan-hide').click();
    await expect(page.getByTestId('goal-bar')).toBeVisible();
    await expect(page.getByText(todoAText, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('plan-card')).toHaveCount(0);
    await expect(page.getByTestId('goal-bar')).toBeVisible();
    await expect(page.getByText(todoAText, { exact: true })).toBeVisible();

    await page.goto(requiredEnv('R33_ISOLATION_SESSION_B_URL'));
    await expect(page.getByTestId('goal-bar')).toBeVisible();
    await expect(page.getByTestId('plan-card')).toBeVisible();
    await expect(page.getByText(textFixture('R33_TODO_B_TEXT'), { exact: true })).toBeVisible();

    await page.goto(requiredEnv('R33_ISOLATION_SESSION_A_URL'));
    await expect(page.getByTestId('plan-card')).toHaveCount(0);
    await expect(page.getByTestId('goal-bar')).toBeVisible();
    await expect(page.getByText(todoAText, { exact: true })).toBeVisible();
  });

  test('R33-GOAL-RACE-001 switching from optimistic A never paints A in session B', async ({ page }) => {
    await openScenario(page, 'R33_GOAL_OPTIMISTIC_SWITCH_URL');
    const goalA = textFixture('R33_GOAL_A_SENTINEL');
    const goalB = textFixture('R33_GOAL_B_SENTINEL');
    await expect(page.getByTestId('goal-bar')).toContainText(goalA);
    await installGoalDomObserver(page);

    await page.getByRole('button', { name: textFixture('R33_GOAL_SWITCH_B_ACTION'), exact: true }).click();
    await expect(page.getByTestId('goal-bar')).toContainText(goalB);
    const bUrlToken = textFixture('R33_GOAL_B_URL_TOKEN');
    const bSamples = (await goalDomSamples(page)).filter((sample) => sample.url.includes(bUrlToken));
    expect(bSamples.length).toBeGreaterThan(0);
    expect(bSamples.some((sample) => sample.texts.some((text) => text.includes(goalB)))).toBe(true);
    expect(bSamples.every((sample) => sample.texts.every((text) => !text.includes(goalA)))).toBe(true);
  });

  test('R33-GOAL-RACE-002 draft A to draft B does not cross-paint goals', async ({ page }) => {
    await openScenario(page, 'R33_GOAL_DRAFT_SWITCH_URL');
    const draftA = textFixture('R33_DRAFT_GOAL_A_SENTINEL');
    const draftB = textFixture('R33_DRAFT_GOAL_B_SENTINEL');
    await expect(page.getByTestId('goal-bar')).toContainText(draftA);
    await installGoalDomObserver(page);

    await page.getByRole('button', { name: textFixture('R33_DRAFT_GOAL_SWITCH_B_ACTION'), exact: true }).click();
    await expect(page.getByTestId('goal-bar')).toContainText(draftB);
    const bUrlToken = textFixture('R33_DRAFT_GOAL_B_URL_TOKEN');
    const bSamples = (await goalDomSamples(page)).filter((sample) => sample.url.includes(bUrlToken));
    expect(bSamples.length).toBeGreaterThan(0);
    expect(bSamples.some((sample) => sample.texts.some((text) => text.includes(draftB)))).toBe(true);
    expect(bSamples.every((sample) => sample.texts.every((text) => !text.includes(draftA)))).toBe(true);
  });

  test('R33-GOAL-RACE-003 draft-to-real handoff never flashes away the current goal', async ({ page }) => {
    await openScenario(page, 'R33_GOAL_DRAFT_REAL_HANDOFF_URL');
    const goal = textFixture('R33_DRAFT_REAL_GOAL_SENTINEL');
    await expect(page.getByTestId('goal-bar')).toContainText(goal);
    await installGoalDomObserver(page);

    await page.getByRole('button', { name: textFixture('R33_DRAFT_REAL_ACTION'), exact: true }).click();
    await expect(page.getByText(textFixture('R33_DRAFT_REAL_SETTLED_TEXT'), { exact: true })).toBeVisible();
    const realUrlToken = textFixture('R33_REAL_SESSION_URL_TOKEN');
    const realSamples = (await goalDomSamples(page)).filter((sample) => sample.url.includes(realUrlToken));
    expect(realSamples.length).toBeGreaterThan(0);
    expect(realSamples.every((sample) => sample.count === 1)).toBe(true);
    expect(realSamples.every((sample) => sample.texts[0]?.includes(goal))).toBe(true);
  });
});

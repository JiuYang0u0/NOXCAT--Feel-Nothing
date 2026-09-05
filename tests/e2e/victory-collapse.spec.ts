import { expect, test } from '@playwright/test';

test('final hit plays the Boss collapse before revealing the result screen', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'One mobile renderer covers the deterministic victory effect');
  await page.goto('/?debug=1&demo=off');
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 8_000 });
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');
  await page.evaluate(() => window.__NOXCAT_TEST__?.pauseAttacksForVisualTest());

  for (let hit = 1; hit <= 4; hit += 1) {
    await page.evaluate(() => window.__NOXCAT_TEST__?.damageBoss());
    if (hit < 4) {
      await page.waitForFunction(
        (expectedHits) => (
          (window.__NOXCAT_TEST__?.snapshot().mainAttackHits ?? 0) >= expectedHits
          && window.__NOXCAT_TEST__?.snapshot().state === 'DODGING'
        ),
        hit,
      );
    }
  }

  await expect.poll(() => page.evaluate(() => window.__NOXCAT_TEST__?.bossDefeatSnapshot().state))
    .toBe('collapsing');
  const collapse = await page.evaluate(() => window.__NOXCAT_TEST__?.bossDefeatSnapshot());
  expect(collapse?.fragmentCount).toBe(9);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('.result-screen')).toHaveCount(0);
  await page.waitForTimeout(1_750);
  await expect(page.locator('.result-screen')).toHaveCount(0);

  await expect(page.getByTestId('result-title')).toHaveText('BOSS DEFEATED', { timeout: 5_000 });
});

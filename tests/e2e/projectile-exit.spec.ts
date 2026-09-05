import { expect, test } from '@playwright/test';

test('near-plane cards accelerate and recycle independently beyond the viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'One deterministic Phaser integration covers outbound lifecycle');

  await page.route('**/api/boss', (route) => route.abort('failed'));
  await page.goto('/?debug=1&demo=off');
  await page.getByTestId('quick-需求一直改').click();
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 8_000 });
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');
  await page.evaluate(() => window.__NOXCAT_TEST__?.pauseAttacksForVisualTest());
  await page.waitForFunction(() => (
    window.__NOXCAT_TEST__?.projectileSnapshot().length === 0
  ));
  await page.evaluate(() => window.__NOXCAT_TEST__?.spawnExitProbesForTest());

  // 離場的文件加速很快，等條件與取樣分成兩趟的話，回收會發生在兩趟之間。
  // 一律在 waitForFunction 內回傳當幀的快照。
  const nearHandle = await page.waitForFunction(() => (
    window.__NOXCAT_TEST__?.projectileSnapshot().find((item) => (
      item.kind === 'paper' && item.continuingOffscreen
    )) ?? null
  ), undefined, { timeout: 1_500 });
  const near = await nearHandle.jsonValue();
  const nearSpeed = Math.hypot(near!.vx, near!.vy);
  expect(near!.collisionActive).toBe(true);
  expect(near!.visibleX).toBeCloseTo(near!.x, 5);
  expect(near!.visibleY).toBeCloseTo(near!.y, 5);
  expect(nearSpeed).toBeGreaterThanOrEqual(760);
  expect(near!.vx).toBeLessThan(0);
  expect(near!.vy).toBeGreaterThan(0);

  const laterHandle = await page.waitForFunction((speed) => {
    const paper = window.__NOXCAT_TEST__?.projectileSnapshot().find((item) => (
      item.kind === 'paper' && item.continuingOffscreen
    ));
    return paper != null && Math.hypot(paper.vx, paper.vy) >= speed + 20 ? paper : null;
  }, nearSpeed, { timeout: 500 });
  const later = await laterHandle.jsonValue();
  expect(later).not.toBeNull();
  expect(later!.visibleY).toBeGreaterThan(near!.visibleY);
  expect(Math.hypot(later!.vx, later!.vy)).toBeGreaterThanOrEqual(nearSpeed);

  // The faster paper leaves and is recycled while the later comment keeps
  // moving. This guards against the former whole-wave fade/recycle behavior.
  const survivorHandle = await page.waitForFunction(() => {
    const projectiles = window.__NOXCAT_TEST__?.projectileSnapshot() ?? [];
    return projectiles.length === 1 && projectiles[0]?.kind === 'comment' ? projectiles[0] : null;
  }, undefined, { timeout: 1_000 });
  const survivor = await survivorHandle.jsonValue();
  expect(survivor!.kind).toBe('comment');

  await page.waitForFunction(() => (
    window.__NOXCAT_TEST__?.projectileSnapshot().length === 0
  ), undefined, { timeout: 1_000 });
});

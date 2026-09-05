/* global window */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, devices } from '@playwright/test';

const baseUrl = process.env.NOXCAT_BASE_URL ?? 'http://127.0.0.1:4173';
const output = resolve('docs/screenshots');
await mkdir(output, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices['iPhone 13'],
  viewport: { width: 390, height: 844 },
  colorScheme: 'dark',
});
const page = await context.newPage();

try {
  await page.goto(`${baseUrl}/?capture=1`);
  await page.screenshot({ path: resolve(output, 'start-mobile.png') });
  await page.getByTestId('quick-需求一直改').click();
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();
  await page.locator('canvas').waitFor({ state: 'visible' });
  await page.waitForFunction(() => Boolean(window.__NOXCAT_TEST__));
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');
  await page.waitForFunction(() => (
    window.__NOXCAT_TEST__?.waveSnapshot().phase === 'TELEGRAPH'
  ));
  await page.screenshot({ path: resolve(output, 'danger-telegraph-mobile.png') });
  await page.waitForFunction(() => (
    window.__NOXCAT_TEST__?.waveSnapshot().phase === 'ACTIVE'
  ));
  await page.waitForFunction(() => {
    const depths = window.__NOXCAT_TEST__?.projectileSnapshot()
      .map((projectile) => projectile.tunnelDepth) ?? [];
    return depths.some((depth) => depth >= 0.58 && depth <= 0.82);
  });
  await page.screenshot({ path: resolve(output, 'attack-perspective-mobile.png') });
  await page.screenshot({ path: resolve(output, 'battle-full-viewport-mobile.png') });

  const canvasBox = await page.locator('canvas').boundingBox();
  if (!canvasBox) throw new Error('Canvas does not have a bounding box');
  const dragStart = {
    x: canvasBox.x + canvasBox.width * 0.5,
    y: canvasBox.y + canvasBox.height * 0.865,
  };
  const dragEnd = {
    // Keep the fully stretched glow silhouette inside the frame so this
    // artifact demonstrates deformation instead of edge clipping.
    x: canvasBox.x + canvasBox.width * 0.23,
    y: dragStart.y,
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  for (let step = 1; step <= 7; step += 1) {
    const progress = step / 7;
    await page.mouse.move(
      dragStart.x + (dragEnd.x - dragStart.x) * progress,
      dragStart.y,
    );
    await page.waitForTimeout(28);
  }
  await page.screenshot({ path: resolve(output, 'jelly-drag-mobile.png') });
  const dragVisual = await page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot());
  await page.mouse.up();
  await page.waitForTimeout(75);
  await page.screenshot({ path: resolve(output, 'jelly-release-mobile.png') });
  const releaseVisual = await page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot());
  console.log('Jelly capture snapshots', { dragVisual, releaseVisual });

  for (let hit = 1; hit <= 4; hit += 1) {
    await page.waitForFunction(() => {
      const state = window.__NOXCAT_TEST__?.snapshot().state;
      return state === 'DODGING' || state === 'VULNERABLE';
    });
    await page.evaluate(() => {
      window.__NOXCAT_TEST__?.fillEnergy();
      window.__NOXCAT_TEST__?.damageBoss();
    });
    await page.waitForFunction(
      (expected) => (window.__NOXCAT_TEST__?.snapshot().mainAttackHits ?? 0) >= expected,
      hit,
    );
  }
  await page.getByTestId('result-title').waitFor({ state: 'visible' });
  await page.screenshot({ path: resolve(output, 'result-mobile.png') });

  await page.goto(`${baseUrl}/?capture=1`);
  await page.getByTestId('quick-需求一直改').click();
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();
  await page.locator('canvas').waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');
  await page.evaluate(() => window.__NOXCAT_TEST__?.fillEnergy());
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'VULNERABLE');
  const launchBox = await page.locator('canvas').boundingBox();
  if (!launchBox) throw new Error('Canvas does not have a bounding box for launch capture');
  const launchX = launchBox.x + launchBox.width * 0.5;
  const launchStartY = launchBox.y + launchBox.height * 0.79;
  const launchPullY = launchBox.y + launchBox.height * 0.93;
  await page.mouse.move(launchX, launchStartY);
  await page.mouse.down();
  await page.mouse.move(launchX, launchPullY, { steps: 7 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  await page.screenshot({ path: resolve(output, 'jelly-launch-mobile.png') });
} finally {
  await context.close();
  await browser.close();
}

console.log(`Screenshots written to ${output}`);

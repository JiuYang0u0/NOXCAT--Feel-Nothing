import { expect, test, type Page } from '@playwright/test';

import { FALLBACK_BOSS } from '../../src/ai/fallbackBoss';
import { MAIN_ATTACK_HITS_TO_WIN as HITS_TO_WIN } from '../../src/game/constants';

test('small phone can reach the primary action without horizontal overflow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop-chromium', 'Small touch viewport coverage');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant-TW');
  await expect(page.getByRole('textbox', { name: '今天最想打敗的是？' })).toBeVisible();
  await expect(page.locator('#camera-enabled')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '配戴額前護目鏡' })).toBeChecked();
  await expect(page.locator('.css-noxcat')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '配樂與音效' })).toBeChecked();
  await expectMinimumTargetSize(page, 'button, .accessory-toggle, .sound-row');

  const action = page.getByTestId('generate-boss');
  await action.scrollIntoViewIfNeeded();
  const box = await action.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.y ?? 568) + (box?.height ?? 0)).toBeLessThanOrEqual(568);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const screenOverflow = await page.locator('.screen').evaluate(
    (screen) => screen.scrollHeight - screen.clientHeight,
  );
  expect(screenOverflow).toBeLessThanOrEqual(1);

  await page.getByTestId('quick-需求一直改').click();
  await expect(page.getByTestId('quick-需求一直改')).toHaveAttribute('aria-pressed', 'true');
  await action.click();
  await page.getByTestId('skip-camera').click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 8_000 });
});

test('camera consent and result screens keep focus, statistics, and actions accessible', async ({ page }, testInfo) => {
  if (testInfo.project.name !== 'desktop-chromium') {
    await page.setViewportSize({ width: 320, height: 568 });
  }
  const longBossName = 'W'.repeat(24);
  const longResultLine = 'R'.repeat(48);
  await page.route('**/api/boss', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 650));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        source: 'fallback',
        boss: { ...FALLBACK_BOSS, bossName: longBossName, resultLine: longResultLine },
      }),
    });
  });
  await page.goto('/?debug=1&demo=off');
  await page.getByTestId('generate-boss').click();

  const loadingTitle = page.getByRole('heading', { name: /AI 正在把煩惱.*編譯成 BOSS/ });
  await expect(loadingTitle).toBeFocused();
  await expect(page.locator('.loading-screen')).toHaveAttribute('aria-busy', 'true');
  const compileProgress = page.getByRole('progressbar', { name: 'AI 對話生成進度' });
  await expect(compileProgress).toBeVisible();
  await expect(page.locator('.compile-ring-shell')).toBeVisible();
  await expect(page.locator('.compile-count')).toHaveCount(0);
  await expect.poll(async () => Number(await compileProgress.getAttribute('aria-valuenow')), {
    timeout: 450,
  }).toBeGreaterThan(0);
  expect(Number(await compileProgress.getAttribute('aria-valuenow'))).toBeLessThan(50);

  const cameraTitle = page.getByRole('heading', { name: '面無表情模式' });
  await expect(cameraTitle).toBeVisible({ timeout: 5_000 });
  await expect(cameraTitle).toBeFocused();
  await expect(page.locator('.camera-screen')).toHaveAttribute('aria-describedby', 'camera-privacy');
  await expectMinimumTargetSize(page, '.camera-actions button');
  await expectScreenContentsToFit(page, '.camera-screen');

  await page.getByTestId('skip-camera').click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 5_000 });
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');
  await page.evaluate(() => window.__NOXCAT_TEST__?.pauseAttacksForVisualTest());
  for (let hit = 1; hit <= HITS_TO_WIN; hit += 1) {
    await page.evaluate(() => window.__NOXCAT_TEST__?.damageBoss());
    if (hit < HITS_TO_WIN) {
      await page.waitForFunction(
        (expected) => (
          (window.__NOXCAT_TEST__?.snapshot().mainAttackHits ?? 0) >= expected
          && window.__NOXCAT_TEST__?.snapshot().state === 'DODGING'
        ),
        hit,
      );
    }
  }

  const resultTitle = page.getByTestId('result-title');
  await expect(resultTitle).toHaveText('BOSS DEFEATED', { timeout: 5_000 });
  await expect(resultTitle).toBeFocused();
  await expect(page.locator('.grade')).toHaveText(/^評級 [SABC]$/);
  await expect(page.locator('.result-boss')).toHaveText(longBossName);
  await expect(page.locator('.result-line')).toHaveText(longResultLine);
  await expect(page.locator('[data-stat="time"]')).not.toBeEmpty();
  await expect(page.locator('[data-stat="graze"]')).toHaveText(/^\d+$/);
  await expect(page.locator('[data-stat="reflect"]')).toHaveText(/^\d+$/);
  await expect(page.locator('[data-stat="hits"]')).toHaveText(`${HITS_TO_WIN} / ${HITS_TO_WIN}`);
  await expect(page.locator('.neutral-result')).toBeHidden();
  await expectMinimumTargetSize(page, '.result-actions button');
  await expectScreenContentsToFit(page, '.result-screen');

  await page.getByTestId('change-annoyance').click();
  await expect(page.getByRole('heading', { name: /NOXCAT FEEL NOTHING/ })).toBeFocused();
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(1);
  expect(overflow.y).toBeLessThanOrEqual(1);
});

test('keyboard focus is visible and quick choices expose their selected state', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop keyboard navigation coverage');
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.locator('#annoyance')).toBeFocused();
  await page.getByTestId('quick-程式 Bug').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('quick-程式 Bug')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('quick-需求一直改')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#annoyance')).toHaveValue('程式 Bug');
  const outline = await page.getByTestId('quick-程式 Bug').evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);
  await page.locator('#annoyance').fill('新的煩惱');
  await expect(page.getByTestId('quick-程式 Bug')).toHaveAttribute('aria-pressed', 'false');
});

test('touch landscape overlay pauses battle and resumes after portrait countdown', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop-chromium', 'Touch orientation coverage');
  await startBattle(page);
  const before = await page.evaluate(() => window.__NOXCAT_TEST__?.snapshot().elapsedMs ?? 0);

  await page.setViewportSize({ width: 844, height: 390 });
  const warning = page.locator('.landscape-warning');
  await expect(warning).toBeVisible();
  const pausedAt = await page.evaluate(() => window.__NOXCAT_TEST__?.snapshot().elapsedMs ?? 0);
  await page.waitForTimeout(800);
  const stillPaused = await page.evaluate(() => window.__NOXCAT_TEST__?.snapshot().elapsedMs ?? 0);
  expect(stillPaused - pausedAt).toBeLessThanOrEqual(75);
  expect(pausedAt).toBeGreaterThanOrEqual(before);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(warning).toBeHidden();
  await page.waitForTimeout(1_200);
  const resumed = await page.evaluate(() => window.__NOXCAT_TEST__?.snapshot().elapsedMs ?? 0);
  expect(resumed).toBeGreaterThan(stillPaused + 75);
});

test('mobile battle fills the live visual viewport without letterbox bars or stretched art', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop-chromium', 'Mobile visual viewport coverage');
  await page.setViewportSize({ width: 390, height: 844 });
  await startBattle(page);
  const canvas = page.locator('canvas');
  const tall = await canvas.boundingBox();
  expect(tall).not.toBeNull();
  expect(tall).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  const tallViewport = await page.evaluate(() => window.__NOXCAT_TEST__?.viewportSnapshot());
  expect(tallViewport?.width).toBeCloseTo(540, 4);
  expect(tallViewport?.height ?? 0).toBeGreaterThan(960);
  expect(tallViewport?.top ?? 0).toBeLessThan(0);
  const tallCamera = await page.evaluate(() => window.__NOXCAT_TEST__?.cameraSnapshot());
  expect(tallCamera?.zoomX).toBeCloseTo(tallViewport?.zoom ?? 0, 4);
  expect(tallCamera?.zoomY).toBeCloseTo(tallViewport?.zoom ?? 0, 4);
  expect(tallCamera?.worldLeft).toBeCloseTo(tallViewport?.left ?? 0, 0);
  expect(tallCamera?.worldTop).toBeCloseTo(tallViewport?.top ?? 0, 0);
  expect(tallCamera?.worldWidth).toBeCloseTo(tallViewport?.width ?? 0, 0);
  expect(tallCamera?.worldHeight).toBeCloseTo(tallViewport?.height ?? 0, 0);

  await page.setViewportSize({ width: 390, height: 600 });
  await expect.poll(async () => {
    const box = await canvas.boundingBox();
    return box == null ? null : {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  }).toEqual({ x: 0, y: 0, width: 390, height: 600 });
  await page.waitForFunction(() => {
    const viewport = window.__NOXCAT_TEST__?.viewportSnapshot();
    return viewport != null && Math.abs(viewport.height - 960) < 0.01;
  });
  const short = await canvas.boundingBox();
  expect(short).not.toBeNull();
  expect(short?.height ?? 0).toBeLessThan(tall?.height ?? Number.POSITIVE_INFINITY);
  expect(short).toMatchObject({ x: 0, y: 0, width: 390, height: 600 });
  const shortViewport = await page.evaluate(() => window.__NOXCAT_TEST__?.viewportSnapshot());
  expect(shortViewport?.height).toBeCloseTo(960, 4);
  expect(shortViewport?.width ?? 0).toBeGreaterThan(540);
  expect(shortViewport?.left ?? 0).toBeLessThan(0);
  expect(shortViewport?.zoom).toBeCloseTo(600 / 960, 4);
  const shortCamera = await page.evaluate(() => window.__NOXCAT_TEST__?.cameraSnapshot());
  expect(shortCamera?.zoomX).toBeCloseTo(shortViewport?.zoom ?? 0, 4);
  expect(shortCamera?.zoomY).toBeCloseTo(shortViewport?.zoom ?? 0, 4);
  expect(shortCamera?.worldLeft).toBeCloseTo(shortViewport?.left ?? 0, 0);
  expect(shortCamera?.worldTop).toBeCloseTo(shortViewport?.top ?? 0, 0);
  expect(shortCamera?.worldWidth).toBeCloseTo(shortViewport?.width ?? 0, 0);
  expect(shortCamera?.worldHeight).toBeCloseTo(shortViewport?.height ?? 0, 0);

  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(1);
  expect(overflow.y).toBeLessThanOrEqual(1);
});

test('mobile start and result screens fill and follow the live visual viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop-chromium', 'Mobile visual viewport coverage');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?debug=1&demo=off');

  const start = page.locator('.start-screen');
  await expect(start).toBeVisible();
  expect(await start.boundingBox()).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  await expectScreenContentsToFit(page, '.start-screen');

  await page.setViewportSize({ width: 390, height: 600 });
  await expect.poll(() => start.evaluate((element) => element.getBoundingClientRect().height)).toBe(600);
  expect(await start.boundingBox()).toMatchObject({ x: 0, y: 0, width: 390, height: 600 });
  await expectScreenContentsToFit(page, '.start-screen');

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
  const result = page.locator('.result-screen');
  await expect(result).toBeVisible({ timeout: 6_000 });
  expect(await result.boundingBox()).toMatchObject({ x: 0, y: 0, width: 390, height: 600 });
  await expectScreenContentsToFit(page, '.result-screen');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => result.evaluate((element) => element.getBoundingClientRect().height)).toBe(844);
  expect(await result.boundingBox()).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  await expectScreenContentsToFit(page, '.result-screen');
});

test('installed PWA start and result screens use the standalone viewport path', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Isolates the standalone fallback from touch media queries');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', {
      configurable: true,
      value: true,
    });
  });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto('/?debug=1&demo=off');
  await expect(page.locator('html')).toHaveAttribute('data-display-mode', 'standalone');

  const start = page.locator('.start-screen');
  await expect(start).toBeVisible();
  expect(await start.boundingBox()).toMatchObject({ x: 0, y: 0, width: 393, height: 852 });

  await page.setViewportSize({ width: 393, height: 620 });
  await expect.poll(() => start.evaluate((element) => element.getBoundingClientRect().height)).toBe(620);
  expect(await start.boundingBox()).toMatchObject({ x: 0, y: 0, width: 393, height: 620 });

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

  const result = page.locator('.result-screen');
  await expect(result).toBeVisible({ timeout: 6_000 });
  expect(await result.boundingBox()).toMatchObject({ x: 0, y: 0, width: 393, height: 620 });
  await page.setViewportSize({ width: 393, height: 852 });
  await expect.poll(() => result.evaluate((element) => element.getBoundingClientRect().height)).toBe(852);
  expect(await result.boundingBox()).toMatchObject({ x: 0, y: 0, width: 393, height: 852 });
  await expectScreenContentsToFit(page, '.result-screen');
});

test('low-height desktop is not blocked by the touch landscape warning', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop viewport coverage');
  await page.setViewportSize({ width: 1366, height: 560 });
  await page.goto('/');
  await expect(page.locator('.landscape-warning')).toBeHidden();
  const action = page.getByTestId('generate-boss');
  await expect(action).toBeVisible();
  await expectScreenContentsToFit(page, '.start-screen');
  const [screenBox, actionBox] = await Promise.all([
    page.locator('.start-screen').boundingBox(),
    action.boundingBox(),
  ]);
  expect(screenBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  expect((actionBox?.y ?? 0) + (actionBox?.height ?? 0)).toBeLessThanOrEqual(
    (screenBox?.y ?? 0) + (screenBox?.height ?? 0) + 1,
  );
});

test('releasing outside the canvas ends the active desktop drag', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop pointer-outside coverage');
  await startBattle(page);
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas does not have a bounding box');
  const startX = box.x + box.width * 0.5;
  const pointerY = box.y + box.height * 0.79;

  await page.mouse.move(startX, pointerY);
  await page.mouse.down();
  await page.mouse.move(box.x + 4, pointerY, { steps: 5 });
  await page.mouse.move(Math.max(0, box.x - 18), pointerY);
  await page.mouse.up();
  await page.waitForTimeout(80);

  const visual = await page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot());
  expect(visual?.isDragging).toBe(false);
});

async function startBattle(page: Page): Promise<void> {
  await page.goto('/?debug=1&demo=off');
  await page.getByTestId('quick-需求一直改').click();
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 8_000 });
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');
}

async function expectMinimumTargetSize(page: Page, selector: string): Promise<void> {
  const targets = page.locator(selector).filter({ visible: true });
  const count = await targets.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const box = await targets.nth(index).boundingBox();
    expect(box, `target ${selector} #${index} has no visible box`).not.toBeNull();
    expect(box?.width ?? 0, `target ${selector} #${index} is narrower than 44px`).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0, `target ${selector} #${index} is shorter than 44px`).toBeGreaterThanOrEqual(44);
  }
}

async function expectScreenContentsToFit(page: Page, selector: string): Promise<void> {
  const fit = await page.locator(selector).evaluate((screen) => {
    const bounds = screen.getBoundingClientRect();
    const visibleChildren = Array.from(screen.children).filter((child) => {
      const style = getComputedStyle(child);
      return style.display !== 'none' && style.position !== 'absolute' && style.position !== 'fixed';
    });
    return {
      childrenFit: visibleChildren.every((child) => {
        const rect = child.getBoundingClientRect();
        return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1
          && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      }),
    };
  });
  expect(fit.childrenFit).toBe(true);
}

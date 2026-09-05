import { expect, test, type Page } from '@playwright/test';
import { FINGER_OFFSET_Y, PLAYER_MAX_Y, PLAYER_MIN_Y } from '../../src/game/constants';
import { noxcatPerspectiveScale } from '../../src/game/systems/JellyMotionSystem';

test('an API failure falls back locally and four real pull-release launches win', async ({ page, browserName }) => {
  await page.route('**/api/boss', (route) => route.abort('failed'));
  await page.goto('/?debug=1&demo=off');
  await page.getByTestId('quick-需求一直改').click();
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible({ timeout: 8_000 });
  await page.waitForFunction(() => Boolean(window.__NOXCAT_TEST__));
  await page.evaluate(() => window.__NOXCAT_TEST__?.pauseAttacksForVisualTest());
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  for (let hit = 1; hit <= 4; hit += 1) {
    await page.waitForFunction(() => {
      const state = window.__NOXCAT_TEST__?.snapshot().state;
      return state === 'DODGING' || state === 'VULNERABLE';
    });
    await page.evaluate(() => window.__NOXCAT_TEST__?.fillEnergy());
    await expect.poll(
      () => page.evaluate(() => window.__NOXCAT_TEST__?.waveSnapshot().dangerOverlayAlpha),
    ).toBe(0);
    await launchUpward(page, browserName === 'webkit');
    await page.waitForFunction(
      (expectedHits) => (
        (window.__NOXCAT_TEST__?.snapshot().mainAttackHits ?? 0) >= expectedHits
        || document.querySelector('[data-testid="result-title"]')?.textContent === 'BOSS DEFEATED'
      ),
      hit,
      { timeout: 5_000 },
    );
  }

  await expect(page.getByTestId('result-title')).toHaveText('BOSS DEFEATED', { timeout: 6_000 });
  await expect(page.getByTestId('retry')).toBeVisible();
  await page.getByTestId('retry').click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 5_000 });
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'INTRO');
});

test('client-side API failure still starts a playable local boss', async ({ page }) => {
  await page.route('**/api/boss', (route) => route.abort('failed'));
  await page.goto('/?debug=1&demo=off');
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 5_000 });
  await page.waitForFunction(() => Boolean(window.__NOXCAT_TEST__));
  const snapshot = await page.evaluate(() => window.__NOXCAT_TEST__?.snapshot());
  expect(snapshot?.lives).toBe(3);
});

test('the layered SVG character fits the start screen and battle', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', '390x844 character and layout coverage');
  await page.goto('/?debug=1&demo=off');

  await expect(page.getByTestId('goggles-enabled')).toBeChecked();
  await expect(page.locator('.css-noxcat')).toBeVisible();
  const screenBox = await page.locator('.start-screen').boundingBox();
  const formBox = await page.getByTestId('start-form').boundingBox();
  if (!screenBox || !formBox) throw new Error('Start screen does not have measurable bounds');
  expect(formBox.y + formBox.height).toBeLessThanOrEqual(screenBox.y + screenBox.height + 1);
  const verticalOverflow = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(verticalOverflow).toBeLessThanOrEqual(1);

  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 8_000 });
  await page.waitForFunction(() => Boolean(window.__NOXCAT_TEST__));
  await expect.poll(
    () => page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot().goggleVisible),
  ).toBe(true);
});

test('desktop layout accepts keyboard movement without horizontal overflow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop keyboard coverage');
  await page.goto('/?debug=1&demo=off');
  await page.getByTestId('quick-需求一直改').click();
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible({ timeout: 8_000 });
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');

  await page.evaluate(() => window.__NOXCAT_TEST__?.pauseAttacksForVisualTest());
  const before = await page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot());
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(360);
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot());

  expect((after?.x ?? 0)).toBeLessThan((before?.x ?? 0) - 8);
  // 每幀的模擬時間有 50ms 夾限，機器一忙同樣的牆鐘時間走的模擬距離就變短。
  // 改成按住直到抵達邊界，測的仍是「鍵盤能一路推到移動區邊界並停在那裡」。
  const holdUntilY = async (key: string, edgeY: number) => {
    await page.keyboard.down(key);
    await page.waitForFunction(
      (target) => Math.abs((window.__NOXCAT_TEST__?.visualSnapshot().y ?? 9_999) - target) < 0.5,
      edgeY,
      { timeout: 8_000 },
    );
    await page.keyboard.up(key);
    await page.waitForTimeout(150);
    return page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot());
  };
  const upper = await holdUntilY('ArrowUp', PLAYER_MIN_Y);
  expect(upper?.y).toBeCloseTo(PLAYER_MIN_Y, 0);
  const lower = await holdUntilY('s', PLAYER_MAX_Y);
  expect(lower?.y).toBeCloseTo(PLAYER_MAX_Y, 0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(300);
  expect(box?.height ?? 0).toBeGreaterThan(600);
});

test('jelly body follows a fast drag without a tail, glows, rebounds, and keeps a fixed hit body', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium provides deterministic mouse-drag timing for visual sampling');
  await page.goto('/?debug=1&demo=off');
  await page.getByTestId('quick-需求一直改').click();
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible({ timeout: 8_000 });
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');
  await page.evaluate(() => window.__NOXCAT_TEST__?.pauseAttacksForVisualTest());
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas does not have a bounding box');

  const startX = box.x + box.width * 0.5;
  const pointerY = box.y + box.height * 0.79;
  const endX = box.x + box.width * 0.08;
  await page.mouse.move(startX, pointerY);
  await page.mouse.down();
  for (let step = 1; step <= 7; step += 1) {
    await page.mouse.move(startX + (endX - startX) * (step / 7), pointerY);
    await page.waitForTimeout(28);
  }

  await page.waitForTimeout(100);
  const dragSample = await page.evaluate(() => ({
    visual: window.__NOXCAT_TEST__?.visualSnapshot(),
    input: window.__NOXCAT_TEST__?.inputSnapshot(),
  }));
  const dragging = dragSample.visual;
  if (!dragging || !dragSample.input) throw new Error('Drag sample is unavailable');
  expect(dragging?.hitRadius).toBe(18);
  expect(Math.abs(dragging.y - (dragSample.input.worldY - FINGER_OFFSET_Y))).toBeLessThan(4);
  // A full-width swipe should be almost caught up within ~200 ms; this guards
  // against reintroducing pointer smoothing or the old sluggish follow spring.
  expect(dragging?.x ?? 999).toBeLessThan(115);
  // Ordinary movement is carried entirely by the bun body. The rejected
  // triangular ribbon and launch-only particles must not appear while dragging.
  expect(dragging).not.toHaveProperty('trailStrength');
  expect(dragging).not.toHaveProperty('activeTrailPoints');
  expect(dragging?.activeGhosts).toBe(0);
  expect(dragging?.activeDroplets).toBe(0);
  expect(dragging?.glowLayerCount).toBe(3);
  expect(dragging?.glowOuterAlpha).toBeGreaterThan(0.04);
  expect(dragging.eyeX).toBeCloseTo(0, 3);
  expect(dragging?.bodyDisplayWidth).toBeCloseTo(138, 3);
  expect(dragging.bodyDisplayHeight / dragging.bodyDisplayWidth).toBeCloseTo(182.656 / 200, 4);
  expect(dragging.eyeDisplayWidth / dragging.bodyDisplayWidth).toBeCloseTo(Math.abs(dragging.scaleX), 3);
  expect(dragging.eyeDisplayHeight / dragging.bodyDisplayHeight).toBeCloseTo(Math.abs(dragging.scaleY), 3);
  expect(dragging.goggleDisplayWidth).toBeCloseTo(dragging.eyeDisplayWidth, 3);
  expect(dragging.goggleDisplayHeight).toBeCloseTo(dragging.eyeDisplayHeight, 3);
  expect(dragging?.goggleVisible).toBe(true);
  // The logo-led bun body visibly deforms while the round head stays intact.
  expect((dragging?.scaleX ?? 0) - (dragging?.scaleY ?? 0)).toBeGreaterThan(0.08);

  await page.mouse.up();
  await page.waitForTimeout(30);
  const released = await page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot());
  expect(released?.activeGhosts).toBe(0);
  expect(released?.activeDroplets).toBe(0);

  expect(released?.isDragging).toBe(false);
  // The five alternating release lobes are verified frame-rate-independently
  // in jellyMotion.test.ts. Sampling a lobe here aliases badly when a busy
  // browser coalesces frames, so verify the rendered body reaches rest instead.
  await page.waitForTimeout(650);
  const settled = await page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot());
  expect(Math.abs((settled?.scaleX ?? 1) - 1)).toBeLessThan(0.06);
  expect(Math.abs((settled?.scaleY ?? 1) - 1)).toBeLessThan(0.06);

  if (!settled) throw new Error('NOXCAT did not expose its settled visual state');
  const viewport = await page.evaluate(() => window.__NOXCAT_TEST__?.viewportSnapshot());
  if (!viewport) throw new Error('Battle viewport is unavailable');
  const upperDragStart = worldToScreen(box, viewport, settled.x, settled.y);
  const upperPointer = worldToScreen(box, viewport, settled.x, 502);
  await page.mouse.move(upperDragStart.x, upperDragStart.y);
  await page.mouse.down();
  await page.mouse.move(upperPointer.x, upperPointer.y, { steps: 8 });
  await page.waitForTimeout(320);
  const upper = await page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot());
  await page.mouse.up();
  expect(upper?.y).toBeCloseTo(PLAYER_MIN_Y, 0);
  expect(upper?.depthScale ?? 0).toBeCloseTo(noxcatPerspectiveScale(PLAYER_MIN_Y), 1);
  // Perspective changes only the image; the logical gameplay body stays fixed.
  expect(upper?.hitRadius).toBe(18);
});

test('default Neutral mode disclosure can be skipped without blocking play', async ({ page }) => {
  // 揭露畫面與 Boss 來源無關；不攔截的話兩批對話生成要跑 20 秒以上。
  await page.route('**/api/boss', (route) => route.abort('failed'));
  await page.goto('/');
  await expect(page.locator('#camera-enabled')).toHaveCount(0);
  await page.getByTestId('generate-boss').click();
  await expect(page.getByText('面無表情模式')).toBeVisible();
  await expect(page.getByText('鏡頭畫面不會上傳、不會錄影', { exact: false })).toBeVisible();
  await page.getByTestId('skip-camera').click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 5_000 });
});

test('camera permission failure degrades to standard mode', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium provides deterministic headless permission denial');
  await page.goto('/');
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('start-calibration').click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('[data-battle-status]')).toHaveText('無法啟用相機，已自動改用標準模式。');
});

async function launchUpward(page: Page, useTrustedMouse = false): Promise<void> {
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas does not have a bounding box');
  const state = await page.evaluate(() => ({
    visual: window.__NOXCAT_TEST__?.visualSnapshot(),
    viewport: window.__NOXCAT_TEST__?.viewportSnapshot(),
  }));
  if (!state.visual || !state.viewport) {
    throw new Error('NOXCAT visual state or battle viewport is unavailable before launch');
  }
  const start = worldToScreen(box, state.viewport, state.visual.x, state.visual.y);
  const pull = worldToScreen(box, state.viewport, state.visual.x, state.visual.y + 140);
  const x = start.x;
  const startY = start.y;
  const pullY = Math.min(box.y + box.height - 4, pull.y);
  const hasTouch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (!hasTouch || useTrustedMouse) {
    await page.mouse.move(x, startY);
    await page.mouse.down();
    await page.mouse.move(x, pullY, { steps: 7 });
    await expectAimState(page);
    await page.mouse.up();
  } else {
    // Chromium's DevTools touch injection produces trusted browser touch input,
    // unlike constructing an untrusted TouchEvent inside the page.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: startY, radiusX: 2, radiusY: 2, force: 1 }],
    });
    for (let step = 1; step <= 7; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{
          x,
          y: startY + (pullY - startY) * (step / 7),
          radiusX: 2,
          radiusY: 2,
          force: 1,
        }],
      });
    }
    await expectAimState(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await expect.poll(
    () => page.evaluate(() => window.__NOXCAT_TEST__?.snapshot().state),
    { timeout: 400 },
  ).toBe('LAUNCHED');
}

async function expectAimState(page: Page): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => window.__NOXCAT_TEST__?.snapshot().state),
  ).toBe('AIMING');
}

function worldToScreen(
  box: Readonly<{ x: number; y: number; width: number; height: number }>,
  viewport: Readonly<{ left: number; top: number; width: number; height: number }>,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: box.x + box.width * ((x - viewport.left) / viewport.width),
    y: box.y + box.height * ((y - viewport.top) / viewport.height),
  };
}

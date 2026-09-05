import { expect, test, type Page } from '@playwright/test';
import {
  BOSS_MAX_HP,
  ENERGY_PER_REFLECT,
  FINGER_OFFSET_Y,
  PLAYER_MAX_X,
  PLAYER_MAX_Y,
  PLAYER_MIN_X,
  PLAYER_MIN_Y,
  REFLECT_DAMAGE,
} from '../../src/game/constants';

// 指標位置換算：手指在角色下方 FINGER_OFFSET_Y，所以要貼到移動區底線
// 得把指標放在 PLAYER_MAX_Y + FINGER_OFFSET_Y。
const BOTTOM_POINTER_Y = PLAYER_MAX_Y + FINGER_OFFSET_Y;

interface CanvasBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function startFallbackBattle(page: Page) {
  await page.route('**/api/boss', (route) => route.abort('failed'));
  await page.goto('/?debug=1&demo=off');
  await page.getByTestId('quick-需求一直改').click();
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible({ timeout: 8_000 });
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');
  return canvas;
}

function toScreen(box: CanvasBox, x: number, y: number): { x: number; y: number } {
  return {
    x: box.x + box.width * (x / 540),
    y: box.y + box.height * (y / 960),
  };
}

test('a real pointer drag into a real paper-rain card damages NOXCAT', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Deterministic mouse timing covers the live Phaser collision path');

  const canvas = await startFallbackBattle(page);
  await page.waitForFunction(() => {
    const hook = window.__NOXCAT_TEST__;
    return hook?.waveSnapshot().pattern === 'paper_rain'
      && hook.waveSnapshot().phase === 'ACTIVE'
      && hook.projectileSnapshot().some((projectile) => (
        projectile.kind === 'paper' && projectile.isDamage
      ));
  }, undefined, { timeout: 4_000 });

  const [box, visual] = await Promise.all([
    canvas.boundingBox(),
    page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot()),
  ]);
  if (!box || !visual) throw new Error('Canvas or NOXCAT position unavailable');
  const start = toScreen(box, visual.x, visual.y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();

  let observedRealPaper = false;
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const sample = await page.evaluate(() => {
      const hook = window.__NOXCAT_TEST__;
      const papers = (hook?.projectileSnapshot() ?? [])
        .filter((projectile) => projectile.kind === 'paper' && projectile.isDamage)
        .sort((first, second) => second.tunnelDepth - first.tunnelDepth);
      return {
        lives: hook?.snapshot().lives ?? 0,
        target: papers[0] ?? null,
      };
    });
    if (sample.lives < 3) break;
    if (sample.target) {
      observedRealPaper = true;
      const target = toScreen(
        box,
        sample.target.visibleX,
        Math.min(956, sample.target.visibleY),
      );
      await page.mouse.move(target.x, target.y);
    }
    await page.waitForTimeout(12);
  }
  await page.mouse.up();

  const result = await page.evaluate(() => window.__NOXCAT_TEST__?.snapshot());
  expect(observedRealPaper).toBe(true);
  expect(result?.lives).toBe(2);
});

test('moving NOXCAT to the upper arena does not bypass paper-rain damage', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Deterministic mouse timing covers upper-arena collision activation');

  const canvas = await startFallbackBattle(page);
  const [box, visual] = await Promise.all([
    canvas.boundingBox(),
    page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot()),
  ]);
  if (!box || !visual) throw new Error('Canvas or NOXCAT position unavailable');

  const start = toScreen(box, visual.x, visual.y + FINGER_OFFSET_Y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();

  await page.waitForFunction(() => (
    window.__NOXCAT_TEST__?.waveSnapshot().pattern === 'paper_rain'
      && window.__NOXCAT_TEST__?.waveSnapshot().phase === 'ACTIVE'
  ));

  // 不能固定停在 x=270：文件雨的安全通道是有種子的，會整條移動，硬編的欄位
  // 隨時可能落進通道的避讓範圍而永遠打不到。改成把 y 釘在移動區上緣、只追著
  // 真實文件的欄位走，這樣測的才是「上方區域一樣會啟用碰撞」。
  let observedUpperPaper = false;
  let catYAtHit = 0;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const sample = await page.evaluate(({ minX, maxX, bandY }) => {
      const hook = window.__NOXCAT_TEST__;
      const papers = (hook?.projectileSnapshot() ?? [])
        .filter((projectile) => (
          projectile.kind === 'paper' && projectile.isDamage
          && projectile.visibleX >= minX && projectile.visibleX <= maxX
        ))
        .sort((first, second) => (
          Math.abs(first.visibleY - bandY) - Math.abs(second.visibleY - bandY)
        ));
      return {
        lives: hook?.snapshot().lives ?? 0,
        catY: hook?.visualSnapshot().y ?? 0,
        target: papers[0] ?? null,
      };
    }, { minX: PLAYER_MIN_X, maxX: PLAYER_MAX_X, bandY: PLAYER_MIN_Y });
    catYAtHit = sample.catY;
    if (sample.lives < 3) break;
    if (sample.target) {
      observedUpperPaper = true;
      const target = toScreen(box, sample.target.visibleX, PLAYER_MIN_Y + FINGER_OFFSET_Y);
      await page.mouse.move(target.x, target.y);
    }
    await page.waitForTimeout(12);
  }
  await page.mouse.up();

  expect(observedUpperPaper).toBe(true);
  // 命中必須發生在上方區域，否則這個測試就退化成一般的文件雨碰撞測試。
  expect(catYAtHit).toBeLessThan(PLAYER_MIN_Y + 40);
  expect(await page.evaluate(() => window.__NOXCAT_TEST__?.snapshot().lives)).toBe(2);
});

test('the full NOXCAT silhouette fits through the advertised paper safe lane', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Deterministic mouse timing covers the live Phaser safe lane');

  const canvas = await startFallbackBattle(page);
  await page.waitForFunction(() => {
    const wave = window.__NOXCAT_TEST__?.waveSnapshot();
    return wave?.pattern === 'paper_rain'
      && wave.phase === 'TELEGRAPH'
      && wave.safeLane?.axis === 'vertical';
  });
  const [box, state] = await Promise.all([
    canvas.boundingBox(),
    page.evaluate(() => ({
      cat: window.__NOXCAT_TEST__?.visualSnapshot(),
      laneX: window.__NOXCAT_TEST__?.waveSnapshot().safeLane?.center,
    })),
  ]);
  if (!box || !state.cat || state.laneX == null) {
    throw new Error('Canvas, NOXCAT, or paper safe lane unavailable');
  }
  const start = toScreen(box, state.cat.x, state.cat.y);
  const target = toScreen(box, state.laneX, BOTTOM_POINTER_Y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 5 });
  await page.waitForFunction(
    (laneX) => Math.abs((window.__NOXCAT_TEST__?.visualSnapshot().x ?? -999) - laneX) < 10,
    state.laneX,
  );
  await page.waitForFunction(() => {
    const wave = window.__NOXCAT_TEST__?.waveSnapshot();
    return wave?.pattern === 'paper_rain' && wave.phase === 'RECOVERY';
  }, undefined, { timeout: 10_000 });
  await page.mouse.up();

  expect(await page.evaluate(() => window.__NOXCAT_TEST__?.snapshot().lives)).toBe(3);
});

test('a real high-speed flick returns the real marked document to the Boss', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Deterministic mouse timing covers the live Phaser collision path');

  const canvas = await startFallbackBattle(page);
  await page.waitForFunction(() => {
    const hook = window.__NOXCAT_TEST__;
    return hook?.waveSnapshot().pattern === 'returnable_burst'
      && hook.waveSnapshot().phase === 'ACTIVE'
      && hook.projectileSnapshot().some((projectile) => projectile.kind === 'returnable');
  }, undefined, { timeout: 15_000 });

  const [box, initial] = await Promise.all([
    canvas.boundingBox(),
    page.evaluate(() => ({
      cat: window.__NOXCAT_TEST__?.visualSnapshot(),
      card: window.__NOXCAT_TEST__?.projectileSnapshot()
        .find((projectile) => projectile.kind === 'returnable'),
      lives: window.__NOXCAT_TEST__?.snapshot().lives,
    })),
  ]);
  if (!box || !initial.cat || !initial.card) {
    throw new Error('Canvas, NOXCAT, or real returnable card unavailable');
  }
  const direction = initial.card.x < 270 ? -1 : 1;
  const interactionX = Math.min(480, Math.max(60, initial.card.x + direction * 10));
  const startX = Math.min(494, Math.max(46, interactionX - direction * 130));
  const endX = Math.min(494, Math.max(46, interactionX + direction * 100));
  const start = toScreen(box, startX, BOTTOM_POINTER_Y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.waitForFunction(
    ({ expectedX, expectedY }) => {
      const cat = window.__NOXCAT_TEST__?.visualSnapshot();
      return cat != null && Math.abs(cat.x - expectedX) < 12 && Math.abs(cat.y - expectedY) < 12;
    },
    { expectedX: startX, expectedY: PLAYER_MAX_Y },
    { timeout: 1_500 },
  );
  await page.waitForFunction(() => {
    const card = window.__NOXCAT_TEST__?.projectileSnapshot()
      .find((projectile) => projectile.kind === 'returnable');
    return card != null && card.tunnelDepth >= 0.76;
  }, undefined, { timeout: 2_000 });
  const livesAfterSlowContact = await page.evaluate(
    () => window.__NOXCAT_TEST__?.snapshot().lives,
  );
  expect(livesAfterSlowContact).toBe(initial.lives);

  const end = toScreen(box, endX, BOTTOM_POINTER_Y);
  await page.mouse.move(end.x, end.y);
  await page.waitForFunction(
    () => (window.__NOXCAT_TEST__?.snapshot().reflectCount ?? 0) >= 1,
    undefined,
    { timeout: 3_000 },
  );
  await page.mouse.up();

  const result = await page.evaluate(() => window.__NOXCAT_TEST__?.snapshot());
  expect(result).toMatchObject({
    lives: initial.lives, reflectCount: 1, bossHp: BOSS_MAX_HP - REFLECT_DAMAGE,
  });
  expect(result?.energy ?? 0).toBeGreaterThanOrEqual(ENERGY_PER_REFLECT);
});

test('a too-short pull keeps its PULL FARTHER hint readable before the countdown resumes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Deterministic mouse timing covers the live aim-release path');

  const canvas = await startFallbackBattle(page);
  await page.evaluate(() => window.__NOXCAT_TEST__?.fillEnergy());
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'VULNERABLE');

  const [box, cat] = await Promise.all([
    canvas.boundingBox(),
    page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot()),
  ]);
  if (!box || !cat) throw new Error('Canvas or NOXCAT position unavailable');
  const grab = toScreen(box, cat.x, cat.y);
  // 只拉 14 世界像素，遠低於 AIM_MIN_PULL，因此彈射會被判定為拉太短。
  const short = toScreen(box, cat.x, cat.y + 14);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'AIMING');
  await page.mouse.move(short.x, short.y);
  await page.mouse.up();

  // 提示只保留 PULL_HINT_HOLD_MS(650ms)。原本先睡 250ms 再取樣，只剩 400ms
  // 餘裕吃 waitForTimeout + IPC，機器一忙就會抓到已經跳回的倒數字串。
  // 改成放開後立刻取樣，held 的行為一樣被涵蓋，但不再賭牆鐘。
  const held = await page.evaluate(() => window.__NOXCAT_TEST__?.waveSnapshot());
  expect(held?.stateMessage).toBe('PULL FARTHER');
  expect(held?.vulnerableRemainingMs ?? 0).toBeGreaterThan(0);

  await page.waitForFunction(
    () => (window.__NOXCAT_TEST__?.waveSnapshot().stateMessage ?? '').startsWith('DO EVERYTHING'),
    undefined,
    { timeout: 2_000 },
  );
});

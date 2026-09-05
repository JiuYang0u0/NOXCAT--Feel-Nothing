import { expect, test, type Page } from '@playwright/test';
import { FALLBACK_BOSS } from '../../src/ai/fallbackBoss';
import {
  FINGER_OFFSET_Y,
  PLAYER_MIN_Y,
  PLAYER_MAX_Y,
  PLAYER_MIN_X,
  PLAYER_MAX_X,
} from '../../src/game/constants';
import { clipLineToBounds } from '../../src/game/systems/LineGeometry';

// 上緣 / 中段 / 下緣三個取樣點；中段由常數推導，移動區高度改動時自動跟上。
const DODGE_AREA_MID_Y = Math.round((PLAYER_MIN_Y + PLAYER_MAX_Y) / 2);
for (const y of [PLAYER_MIN_Y, DODGE_AREA_MID_Y, PLAYER_MAX_Y]) {
  test(`pulse barrage leaves the visible safe centre clear at y=${y}`, async ({ page }) => {
    await page.route('**/api/boss', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ source: 'fallback', boss: {
        ...FALLBACK_BOSS,
        seed: 12,
        attacks: Array.from({ length: 3 }, () => ({
          pattern: 'pulse_barrage', intensity: 2, durationMs: 6_500,
        })),
      } }),
    }));
    await page.goto('/?capture=1&demo=off');
    await page.getByTestId('generate-boss').click();
    await page.getByTestId('skip-camera').click();
    await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');
    const lane = await page.evaluate(() => window.__NOXCAT_TEST__!.waveSnapshot().safeLane!);
    await moveToBattlePosition(page, lane.center, y);
    await page.waitForFunction(() => window.__NOXCAT_TEST__!.projectileSnapshot().some((card) => (
      card.isDamage && card.collisionActive
    )));
    await page.waitForFunction(() => {
      const hook = window.__NOXCAT_TEST__!;
      return hook.snapshot().lives < 3 || hook.snapshot().state === 'VULNERABLE'
        || hook.waveSnapshot().phase === 'RECOVERY';
    });
    expect(await page.evaluate(() => window.__NOXCAT_TEST__!.snapshot().lives)).toBe(3);
  });
}

for (const position of ['safe_left', 'safe_center', 'safe_right', 'danger'] as const) {
  test(`closing walls reach the lower dodge area at ${position}`, async ({ page }) => {
    await page.route('**/api/boss', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ source: 'fallback', boss: {
        ...FALLBACK_BOSS,
        seed: 12,
        attacks: Array.from({ length: 3 }, () => ({
          pattern: 'closing_walls', intensity: 3, durationMs: 6_500,
        })),
      } }),
    }));
    await page.goto('/?capture=1&demo=off');
    await page.getByTestId('generate-boss').click();
    await page.getByTestId('skip-camera').click();
    await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');
    const before = await page.evaluate(() => ({
      lives: window.__NOXCAT_TEST__!.snapshot().lives,
      lane: window.__NOXCAT_TEST__!.waveSnapshot().safeLane!,
    }));
    const safe = position !== 'danger';
    const x = position === 'safe_left' ? PLAYER_MIN_X : position === 'safe_right' ? PLAYER_MAX_X : 270;
    const y = safe ? before.lane.center : PLAYER_MAX_Y - 6;
    if (!safe) expect(y).toBeGreaterThan(before.lane.center + before.lane.halfWidth);
    await moveToBattlePosition(page, x, y);
    if (safe) {
      // 不能只檢查沒扣血：必須先確認有可碰撞文件橫穿下方，再等整波結束。
      await page.waitForFunction(({ minY, maxY }) => (
        window.__NOXCAT_TEST__!.projectileSnapshot().some((card) => (
          card.kind === 'wall' && card.isDamage && card.collisionActive
          && card.visibleX >= 200 && card.visibleX <= 340
          && card.visibleY >= minY && card.visibleY <= maxY
        ))
      ), { minY: PLAYER_MIN_Y, maxY: PLAYER_MAX_Y });
      await page.waitForFunction(() => window.__NOXCAT_TEST__!.waveSnapshot().phase === 'RECOVERY');
      expect(await page.evaluate(() => window.__NOXCAT_TEST__!.snapshot().lives)).toBe(before.lives);
    } else {
      await expect.poll(() => page.evaluate(() => window.__NOXCAT_TEST__!.snapshot().lives))
        .toBe(before.lives - 1);
    }
  });
}

for (const seed of [12, 13, 14]) {
  for (const position of ['safe', 'first_ray', 'second_ray'] as const) {
    test(`random simultaneous crossfire seed ${seed} at ${position}`, async ({ page }) => {
      await page.route('**/api/boss', (route) => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ source: 'fallback', boss: {
          ...FALLBACK_BOSS,
          seed,
          attacks: Array.from({ length: 3 }, () => ({
            pattern: 'comment_crossfire', intensity: 3, durationMs: 4_500,
          })),
        } }),
      }));
      await page.goto('/?capture=1&demo=off');
      await page.getByTestId('generate-boss').click();
      await page.getByTestId('skip-camera').click();
      // 讀取危險區與移動都必須落在 TELEGRAPH 內，否則移動做完時整波可能已經
      // 換過安全點與射線，站位就對不上這一波。
      const syncToTelegraph = () => page.waitForFunction(() => {
        const hook = window.__NOXCAT_TEST__;
        const wave = hook?.waveSnapshot();
        // TELEGRAPH 剛進入時危險區還沒發布，要等射線都上線才取樣。
        return hook?.snapshot().state === 'DODGING'
          && wave?.phase === 'TELEGRAPH'
          && wave.pattern === 'comment_crossfire'
          && wave.safeSpot != null
          && wave.dangerZones.filter((zone) => zone.kind === 'ray').length >= 2;
      }, undefined, { timeout: 15_000 });
      const readWave = () => page.evaluate(() => ({
        lives: window.__NOXCAT_TEST__?.snapshot().lives,
        spot: window.__NOXCAT_TEST__?.waveSnapshot().safeSpot,
        rays: window.__NOXCAT_TEST__?.waveSnapshot().dangerZones.filter((zone) => zone.kind === 'ray'),
      }));

      await syncToTelegraph();
      const before = await readWave();
      expect(before.spot).toBeTruthy();
      expect(before.rays!.length).toBeGreaterThanOrEqual(2);

      if (position === 'safe') {
        await moveToBattlePosition(page, before.spot!.x, before.spot!.y);
        await page.waitForFunction(({ minY, maxY }) => (
          window.__NOXCAT_TEST__?.projectileSnapshot().some((card) => (
            card.kind === 'comment' && card.collisionActive
            && card.visibleX >= 46 && card.visibleX <= 494
            && card.visibleY >= minY && card.visibleY <= maxY
          ))
        ), { minY: PLAYER_MIN_Y, maxY: PLAYER_MAX_Y });
        await page.waitForFunction(() => window.__NOXCAT_TEST__?.waveSnapshot().phase === 'RECOVERY');
        expect(await page.evaluate(() => window.__NOXCAT_TEST__?.snapshot().lives)).toBe(before.lives);
      } else {
        // 跨越競技場的彈簧跟隨要近兩秒，比一個 ACTIVE 還長，可能整波都錯過。
        // 射線每波都會重算，所以錯過就重新對位下一波，最多三次。
        // 容差放寬到 6px：射線是一條線，這個誤差仍遠在文件碰撞半徑內。
        let wave = before;
        let hit = false;
        for (let attempt = 0; attempt < 3 && !hit; attempt += 1) {
          if (attempt > 0) {
            await syncToTelegraph();
            wave = await readWave();
            if ((wave.rays?.length ?? 0) < 2) continue;
          }
          const ray = wave.rays![position === 'first_ray' ? 0 : 1]!;
          const path = clipLineToBounds(ray.from, { x: ray.to.x - ray.from.x, y: ray.to.y - ray.from.y }, {
            left: PLAYER_MIN_X, right: PLAYER_MAX_X, top: PLAYER_MIN_Y, bottom: PLAYER_MAX_Y,
          })!;
          const midpoint = {
            x: (path.entry.x + path.exit.x) / 2,
            y: (path.entry.y + path.exit.y) / 2,
          };
          await moveToBattlePosition(page, midpoint.x, midpoint.y, 6);
          hit = await page.waitForFunction(
            (expected) => (window.__NOXCAT_TEST__?.snapshot().lives ?? 0) <= expected,
            (wave.lives ?? 0) - 1,
            { timeout: 3_000 },
          ).then(() => true, () => false);
        }
        expect(hit, `站在 ${position} 上三波都沒有被打中`).toBe(true);
      }

      // 波次組成與玩家站位無關，所以另外抓一波乾淨的波次來驗。跟移動綁在同一
      // 個 ACTIVE 會搶時間：跨越競技場的跟隨要近兩秒，而回收波的 ACTIVE 只有
      // 約 1.65 秒，抓到的往往已是殘缺的批次。
      // 同一組射線分兩批發射（第二批 +460ms），整波文件數是射線數的兩倍；
      // 抵達近景後 tunnelDepth 會停在 1、分不出批次，所以只看仍在接近中的卡。
      // 條件成立與取樣必須在同一幀完成，否則中間就飽和了。
      const volleyHandle = await page.waitForFunction(() => {
        const hook = window.__NOXCAT_TEST__;
        if (!hook) return null;
        const wave = hook.waveSnapshot();
        if (wave.phase !== 'ACTIVE' || wave.pattern !== 'comment_crossfire') return null;
        const rayCount = wave.dangerZones.filter((zone) => zone.kind === 'ray').length;
        const cards = hook.projectileSnapshot()
          .filter((card) => card.kind === 'comment' && card.tunnelDepth < 1);
        return rayCount >= 2 && cards.length >= rayCount ? { rayCount, cards } : null;
      }, undefined, { timeout: 15_000 });
      const volley = await volleyHandle.jsonValue();
      expect(volley).not.toBeNull();
      expect(volley!.cards.length).toBeGreaterThanOrEqual(volley!.rayCount);
      expect(volley!.cards.length).toBeLessThanOrEqual(volley!.rayCount * 2);
      // 相同深度代表同一幀發射。取「最完整的一批」而不是最深的一批：先射出的
      // 那批可能已經有卡回收，只剩零星殘留，深度最深卻湊不滿一批。
      const cards = [...volley!.cards].sort((first, second) => first.tunnelDepth - second.tunnelDepth);
      const groups: (typeof cards)[] = [];
      for (const card of cards) {
        const current = groups.at(-1);
        if (current && Math.abs(card.tunnelDepth - current[0]!.tunnelDepth) < 0.001) current.push(card);
        else groups.push([card]);
      }
      const batch = groups.sort((first, second) => second.length - first.length)[0]!;
      expect(batch).toHaveLength(volley!.rayCount);
      expect(new Set(batch.map((card) => Math.round(Math.atan2(card.vy, card.vx) * 180 / Math.PI))).size)
        .toBe(batch.length);
    });
  }
}

async function moveToBattlePosition(
  page: Page,
  x: number,
  y: number,
  toleranceX = 2,
): Promise<void> {
  const box = await page.locator('canvas').boundingBox();
  const state = await page.evaluate(() => ({
    cat: window.__NOXCAT_TEST__?.visualSnapshot(),
    viewport: window.__NOXCAT_TEST__?.viewportSnapshot(),
  }));
  if (!box || !state.cat || !state.viewport) throw new Error('Battle viewport unavailable');
  const { cat, viewport } = state;
  const screen = (worldX: number, worldY: number) => ({
    x: box.x + (worldX - viewport.left) * box.width / viewport.width,
    y: box.y + (worldY - viewport.top) * box.height / viewport.height,
  });
  const start = screen(cat.x, cat.y + FINGER_OFFSET_Y);
  const target = screen(x, y + FINGER_OFFSET_Y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 5 });
  await page.waitForFunction((target) => {
    const cat = window.__NOXCAT_TEST__?.visualSnapshot();
    // Canvas CSS scaling can quantize the pointer by slightly more than one
    // logical pixel. Two pixels is still far inside the 18 px safe marker.
    return cat != null && Math.hypot(cat.x - target.x, cat.y - target.y) < target.tolerance;
  }, { x, y, tolerance: toleranceX }, { timeout: 3_000 });
  await page.mouse.up();
}

test('a wave progresses through a clear recovery before the next pattern', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop Chromium wave timing coverage');
  await page.route('**/api/boss', (route) => route.abort('failed'));
  await page.goto('/?debug=1&demo=off');
  await page.getByTestId('quick-需求一直改').click();
  await page.getByTestId('generate-boss').click();
  await page.getByTestId('skip-camera').click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 8_000 });

  await page.waitForFunction(() => {
    const hook = window.__NOXCAT_TEST__;
    return hook?.snapshot().state === 'DODGING' && hook.waveSnapshot().phase === 'TELEGRAPH';
  }, undefined, { timeout: 12_000 });
  const telegraph = await page.evaluate(() => window.__NOXCAT_TEST__?.waveSnapshot());
  expect(telegraph).toMatchObject({
    phase: 'TELEGRAPH',
    pattern: 'paper_rain',
    activeProjectileCount: 0,
    activeDangerous: 0,
    safeLane: { axis: 'vertical' },
  });
  const [canvasBox, cat] = await Promise.all([
    page.locator('canvas').boundingBox(),
    page.evaluate(() => window.__NOXCAT_TEST__?.visualSnapshot()),
  ]);
  if (!canvasBox || !cat || telegraph?.safeLane?.center == null) {
    throw new Error('Canvas, NOXCAT, or paper safe lane unavailable');
  }
  const screenPoint = (x: number, y: number) => ({
    x: canvasBox.x + canvasBox.width * (x / 540),
    y: canvasBox.y + canvasBox.height * (y / 960),
  });
  const start = screenPoint(cat.x, cat.y);
  const safeTarget = screenPoint(telegraph.safeLane.center, PLAYER_MAX_Y + FINGER_OFFSET_Y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(safeTarget.x, safeTarget.y, { steps: 5 });

  await page.waitForFunction(() => {
    const wave = window.__NOXCAT_TEST__?.waveSnapshot();
    return wave?.phase === 'ACTIVE' && wave.pattern === 'paper_rain';
  }, undefined, { timeout: 2_000 });
  const activeSample = await page.evaluate(() => ({
    wave: window.__NOXCAT_TEST__?.waveSnapshot(),
    elapsedMs: window.__NOXCAT_TEST__?.snapshot().elapsedMs,
  }));
  const active = activeSample.wave;
  expect(active?.activeProjectileCount).toBeGreaterThan(0);
  expect(active?.activeDangerous).toBeGreaterThan(0);
  expect(active?.activeDangerous).toBe(active?.activeProjectileCount);
  expect(active?.safeLane).toEqual(telegraph?.safeLane);

  await page.waitForFunction(() => {
    const wave = window.__NOXCAT_TEST__?.waveSnapshot();
    return wave?.phase === 'RECOVERY' && wave.pattern === 'paper_rain';
  }, undefined, { timeout: 12_000 });
  await page.mouse.up();
  const recoverySample = await page.evaluate(() => ({
    wave: window.__NOXCAT_TEST__?.waveSnapshot(),
    elapsedMs: window.__NOXCAT_TEST__?.snapshot().elapsedMs,
  }));
  const recovery = recoverySample.wave;
  expect(recovery?.activeDangerous).toBe(0);
  // The fallback paper step allocates 5,640 ms to ACTIVE, but its last hostile
  // leaves earlier. Director must not burn the empty tail of that allocation.
  expect((recoverySample.elapsedMs ?? 0) - (activeSample.elapsedMs ?? 0)).toBeLessThan(5_400);
  const recoveryObservedAt = performance.now();

  await page.waitForFunction(() => {
    const wave = window.__NOXCAT_TEST__?.waveSnapshot();
    return wave?.phase === 'TELEGRAPH' && wave.pattern === 'returnable_burst';
  }, undefined, { timeout: 1_000 });
  expect(performance.now() - recoveryObservedAt).toBeLessThan(800);
  const nextTelegraph = await page.evaluate(() => window.__NOXCAT_TEST__?.waveSnapshot());
  expect(nextTelegraph).toMatchObject({
    phase: 'TELEGRAPH',
    pattern: 'returnable_burst',
    activeProjectileCount: 0,
    activeDangerous: 0,
    safeLane: { axis: 'vertical' },
  });

  // 開場的教學齊射現在是 5~6 張（intensity 2/3），而且是分批進場的，所以不能
  // 等某個固定張數；重點是「標記文件出現前，場上只有普通文件」。條件與取樣
  // 必須同一幀完成，否則中間就會多進一張。
  const openingHandle = await page.waitForFunction(() => {
    const hook = window.__NOXCAT_TEST__;
    const wave = hook?.waveSnapshot();
    if (wave?.phase !== 'ACTIVE' || wave.pattern !== 'returnable_burst') return null;
    const projectiles = hook!.projectileSnapshot();
    return projectiles.length >= 3 ? projectiles : null;
  }, undefined, { timeout: 2_000 });
  const opening = await openingHandle.jsonValue();
  expect(opening!.every((projectile) => projectile.kind === 'paper')).toBe(true);

  // The ordinary teaching volley is explicitly cleared before the marked
  // document appears. This zero-danger beat is the player's visual reset.
  await page.waitForFunction(() => {
    const hook = window.__NOXCAT_TEST__;
    const wave = hook?.waveSnapshot();
    return wave?.phase === 'ACTIVE'
      && wave.pattern === 'returnable_burst'
      && wave.activeDangerous === 0;
  }, undefined, { timeout: 2_000 });
  // 互動窗口現在會放兩張標記文件；斷言的是「窗口內只有標記文件」，
  // 而不是某個固定張數。
  const interactionHandle = await page.waitForFunction(() => {
    const projectiles = window.__NOXCAT_TEST__?.projectileSnapshot() ?? [];
    return projectiles.length > 0
      && projectiles.every((projectile) => projectile.kind === 'returnable')
      ? projectiles : null;
  }, undefined, { timeout: 1_000 });
  const interactionWindow = await interactionHandle.jsonValue();
  expect(interactionWindow!.length).toBeGreaterThan(0);
  expect(interactionWindow!.every((projectile) => projectile.isDamage)).toBe(true);
});

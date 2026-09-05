import { expect, test, type Page } from '@playwright/test';

import { FALLBACK_BOSS } from '../../src/ai/fallbackBoss';

interface FakeCameraState {
  activity: 'neutral' | 'active' | 'no-face';
  bitmapCloseCalls: number;
  getUserMediaCalls: number;
  lastConstraints: MediaStreamConstraints | null;
  trackReadyState: 'live' | 'ended';
  trackStopCalls: number;
  workerCloseRequests: number;
  workerFrames: number;
  workerResults: number;
  workerTerminated: boolean;
}

test('default Neutral mode succeeds through calibration, bonus, suppression, and cleanup', async ({ page }) => {
  await installSyntheticCamera(page);
  await page.route('**/api/boss', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ source: 'fallback', boss: FALLBACK_BOSS }),
  }));
  await page.goto('/?debug=1&faceTest=1');

  await page.getByTestId('generate-boss').click();
  await expect(page.getByText('面無表情模式')).toBeVisible();
  await expect(page.getByText('鏡頭畫面不會上傳、不會錄影', { exact: false })).toBeVisible();

  const calibrationStartedAt = await page.evaluate(() => performance.now());
  await page.getByTestId('start-calibration').click();
  await expect(page.getByText('自然看向鏡頭')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '相機校正進度' })).toHaveAttribute('aria-valuenow', /\d+/);
  await expect(page.getByTestId('calibration-progress')).toContainText(
    /· (?:1\d|2\d)/,
    { timeout: 1_700 },
  );

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible({ timeout: 5_000 });
  const calibrationElapsedMs = await page.evaluate(
    (startedAt) => performance.now() - startedAt,
    calibrationStartedAt,
  );
  expect(calibrationElapsedMs).toBeGreaterThanOrEqual(1_900);

  const cameraAfterCalibration = await readFakeCameraState(page);
  expect(cameraAfterCalibration.getUserMediaCalls).toBe(1);
  expect(cameraAfterCalibration.workerFrames).toBeGreaterThan(0);
  expect(cameraAfterCalibration.workerResults).toBeGreaterThanOrEqual(10);
  expect(cameraAfterCalibration.lastConstraints).toEqual({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 320 },
      height: { ideal: 240 },
      frameRate: { ideal: 15, max: 24 },
    },
  });

  await page.waitForFunction(() => window.__NOXCAT_TEST__?.snapshot().state === 'DODGING');
  await page.evaluate(() => window.__NOXCAT_TEST__?.pauseAttacksForVisualTest());
  const host = page.getByTestId('game-host');
  await expect(host).toHaveAttribute('data-face-neutral', '100');
  await expect(host).toHaveAttribute('data-face-found', 'true');
  await expect(host).toHaveAttribute('data-face-bonus-eligible', 'true');
  await expect(host).toHaveAttribute('data-face-mode', 'worker');

  const energyBeforeBonus = await battleEnergy(page);
  await expect.poll(() => battleEnergy(page), { timeout: 2_500 }).toBeGreaterThan(
    energyBeforeBonus + 0.15,
  );

  await setSyntheticActivity(page, 'active');
  await expect.poll(async () => Number(await host.getAttribute('data-face-neutral')), {
    timeout: 1_500,
  }).toBeLessThan(70);
  await expect.poll(
    async () => Number(await host.getAttribute('data-face-activity-detected-count')),
    { timeout: 2_000 },
  ).toBeGreaterThanOrEqual(1);
  await expect(host).toHaveAttribute('data-face-bonus-eligible', 'false');
  const energyWhileSuppressed = await battleEnergy(page);
  await page.waitForTimeout(450);
  expect(await battleEnergy(page)).toBeLessThanOrEqual(energyWhileSuppressed + 0.15);

  await setSyntheticActivity(page, 'no-face');
  await expect(host).toHaveAttribute('data-face-neutral', '--', { timeout: 800 });
  await expect(host).toHaveAttribute('data-face-found', 'false');
  await expect(host).toHaveAttribute('data-face-bonus-eligible', 'false');

  for (let hit = 1; hit <= 4; hit += 1) {
    await page.evaluate(() => window.__NOXCAT_TEST__?.damageBoss());
    if (hit < 4) {
      await page.waitForFunction(
        (expectedHits) => (window.__NOXCAT_TEST__?.snapshot().mainAttackHits ?? 0) >= expectedHits,
        hit,
      );
    }
  }
  await expect(page.getByTestId('result-title')).toHaveText('BOSS DEFEATED', {
    timeout: 5_000,
  });
  await expect(page.locator('.neutral-result')).toBeVisible();
  await expect(page.locator('.neutral-result b')).toHaveText(/^\d+%$/);
  await expect(page.locator('.neutral-result small')).toHaveText(/^最高 \d+%$/);

  await expect.poll(async () => (await readFakeCameraState(page)).trackReadyState).toBe('ended');
  const cameraAfterExit = await readFakeCameraState(page);
  expect(cameraAfterExit.trackStopCalls).toBe(1);
  expect(cameraAfterExit.workerCloseRequests).toBe(1);
  expect(cameraAfterExit.workerTerminated).toBe(true);
  expect(cameraAfterExit.bitmapCloseCalls).toBeGreaterThan(0);
});

async function battleEnergy(page: Page): Promise<number> {
  return page.evaluate(() => window.__NOXCAT_TEST__?.snapshot().energy ?? 0);
}

async function readFakeCameraState(page: Page): Promise<FakeCameraState> {
  return page.evaluate(() => {
    const state = (window as unknown as { __NOXCAT_FAKE_CAMERA__: FakeCameraState })
      .__NOXCAT_FAKE_CAMERA__;
    return { ...state };
  });
}

async function setSyntheticActivity(
  page: Page,
  activity: FakeCameraState['activity'],
): Promise<void> {
  await page.evaluate((nextActivity) => {
    (window as unknown as { __NOXCAT_FAKE_CAMERA__: FakeCameraState })
      .__NOXCAT_FAKE_CAMERA__.activity = nextActivity;
  }, activity);
}

async function installSyntheticCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface WorkerFrameRequest {
      bitmap?: { close(): void };
      frameId?: number;
      timestampMs?: number;
      type?: string;
    }

    interface BrowserFakeCameraState {
      activity: 'neutral' | 'active' | 'no-face';
      bitmapCloseCalls: number;
      getUserMediaCalls: number;
      lastConstraints: MediaStreamConstraints | null;
      trackReadyState: 'live' | 'ended';
      trackStopCalls: number;
      workerCloseRequests: number;
      workerFrames: number;
      workerResults: number;
      workerTerminated: boolean;
    }

    const state: BrowserFakeCameraState = {
      activity: 'neutral',
      bitmapCloseCalls: 0,
      getUserMediaCalls: 0,
      lastConstraints: null,
      trackReadyState: 'live',
      trackStopCalls: 0,
      workerCloseRequests: 0,
      workerFrames: 0,
      workerResults: 0,
      workerTerminated: false,
    };
    Object.defineProperty(window, '__NOXCAT_FAKE_CAMERA__', {
      configurable: true,
      value: state,
    });

    const track = {
      stop(): void {
        state.trackStopCalls += 1;
        state.trackReadyState = 'ended';
      },
    };
    const stream = { getTracks: () => [track] };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          state.getUserMediaCalls += 1;
          state.lastConstraints = constraints;
          return stream;
        },
      },
    });

    const mediaSources = new WeakMap<HTMLMediaElement, unknown>();
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get(): unknown {
        return mediaSources.get(this) ?? null;
      },
      set(value: unknown) {
        mediaSources.set(this, value);
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      configurable: true,
      get: () => 4,
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: async () => undefined,
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: () => undefined,
    });

    class SyntheticFaceWorker extends EventTarget {
      public postMessage(message: unknown): void {
        const request = message as WorkerFrameRequest;
        if (request.type === 'init') {
          queueMicrotask(() => this.emit({ type: 'ready' }));
          return;
        }
        if (request.type === 'close') {
          state.workerCloseRequests += 1;
          queueMicrotask(() => this.emit({ type: 'closed' }));
          return;
        }
        if (request.type !== 'frame') return;

        state.workerFrames += 1;
        request.bitmap?.close();
        const sample = state.activity === 'no-face'
          ? null
          : state.activity === 'active'
            ? { smile: 0.95, jawOpen: 0.08, browUp: 0.1, eyeWide: 0.1 }
            : { smile: 0.1, jawOpen: 0.08, browUp: 0.1, eyeWide: 0.1 };
        // Mobile WebKit may throttle headless timer callbacks. A small result
        // batch keeps the test deterministic while still exercising the real
        // controller's >=10-sample calibration gate and median calculation.
        for (let index = 0; index < 3; index += 1) {
          queueMicrotask(() => {
            state.workerResults += 1;
            this.emit({
              type: 'result',
              frameId: request.frameId ?? state.workerFrames,
              timestampMs: (request.timestampMs ?? performance.now()) + index * 0.01,
              sample,
              inferenceMs: 0.25,
            });
          });
        }
      }

      public terminate(): void {
        state.workerTerminated = true;
      }

      private emit(data: object): void {
        this.dispatchEvent(new MessageEvent('message', { data }));
      }
    }

    Object.defineProperty(window, 'Worker', {
      configurable: true,
      value: SyntheticFaceWorker,
    });
    Object.defineProperty(window, 'createImageBitmap', {
      configurable: true,
      value: async () => ({
        close(): void {
          state.bitmapCloseCalls += 1;
        },
      }),
    });
  });
}

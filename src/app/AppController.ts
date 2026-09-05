import Phaser from 'phaser';
import { fetchBossDNA, type BossApiResult } from '../ai/bossClient';
import {
  FaceController,
  type FaceControllerStatus,
  type FaceScoreUpdate,
} from '../face/FaceController';
import { createGameConfig } from '../game/config';
import { MAIN_ATTACK_HITS_TO_WIN } from '../game/constants';
import { setBattleRuntime } from '../game/runtime';
import type { BattleResultDetail } from '../game/scenes/BattleScene';
import { AudioSystem } from '../game/systems/AudioSystem';
import { formatSeconds, requireElement, setSafeText } from './dom';
import { presentResultScreen } from './resultScreen';
import { noxcatSvg } from '../assets/noxcatDesign';

const QUICK_ANNOYANCES = ['需求一直改', '程式 Bug', '星期一', '已讀不回'] as const;

export class AppController {
  private game: Phaser.Game | null = null;
  private faceController: FaceController | null = null;
  private faceScore: FaceScoreUpdate | null = null;
  private latestBoss: BossApiResult | null = null;
  private latestAnnoyance = '需求一直改';
  private wantsCamera = true;
  private soundEnabled = true;
  private gogglesVisible = true;
  private generation = 0;
  private loadingProgressFrame: number | null = null;
  private loadingProgress = 0;
  private loadingProgressCeiling = 48;
  private loadingProgressComplete = false;
  private loadingProgressLastTime = 0;
  private faceActivityDetectedCount = 0;
  private pendingBattleStatus = '';
  private readonly faceTestProbeEnabled = (() => {
    const params = new URLSearchParams(window.location.search);
    return import.meta.env.DEV && params.get('debug') === '1' && params.get('faceTest') === '1';
  })();
  private readonly uiAudio = new AudioSystem();

  constructor(private readonly root: HTMLElement) {
    window.addEventListener('noxcat:battle-result', this.onBattleResult as EventListener);
    this.root.addEventListener('pointerdown', this.onUiPointerDown);
    this.root.addEventListener('keydown', this.onUiKeyDown);
  }

  start(): void {
    this.showStartScreen();
  }

  private showStartScreen(restoreFocus = false): void {
    this.root.classList.remove('battle-active');
    this.generation += 1;
    this.stopLoadingProgressAnimation();
    this.destroyGame();
    void this.stopFace();
    this.root.innerHTML = `
      <main class="screen start-screen" aria-labelledby="game-title">
        <div class="scanlines" aria-hidden="true"></div>
        <header class="brand-lockup">
          <p class="eyebrow">FEEL NOTHING. DO EVERYTHING.</p>
          <h1 id="game-title" class="game-title" tabindex="-1">
            <img class="official-wordmark" src="/assets/ip/noxcat/noxcat-logo-official-white.png" alt="NOXCAT" />
            <span>FEEL NOTHING</span>
          </h1>
          <p class="tagline">你的煩惱是 BOSS；<br><strong>NOXCAT 自己就是果凍砲彈。</strong></p>
        </header>
        <div class="start-visual" aria-hidden="true">
          <img class="start-boss-ghost" src="/assets/boss/boss-office-base-v1.png" alt="" />
          <div class="css-noxcat">${noxcatSvg()}</div>
        </div>
        <form class="annoyance-form" data-testid="start-form">
          <label for="annoyance">今天最想打敗的是？</label>
          <div class="input-shell"><input id="annoyance" name="annoyance" autocomplete="off" inputmode="text" aria-describedby="annoyance-help" placeholder="輸入今天最煩的事…" /></div>
          <span id="annoyance-help" class="sr-only">最多輸入 80 個 Unicode 字元；留白時會使用「需求一直改」。</span>
          <div class="quick-options" role="group" aria-label="快速選項"></div>
          <div class="secondary-options">
            <label class="accessory-toggle">
              <input id="goggles-enabled" data-testid="goggles-enabled" type="checkbox"${this.gogglesVisible ? ' checked' : ''} />
              <span class="toggle" aria-hidden="true"></span>
              <b>配戴額前護目鏡</b>
            </label>
            <label class="sound-row"><input id="sound-enabled" type="checkbox" checked /> 配樂與音效</label>
          </div>
          <button class="primary-button" type="submit" data-testid="generate-boss">生成我的 BOSS <span>→</span></button>
        </form>
      </main>
      <div class="landscape-warning" role="status"><strong>請轉回直式</strong><span>果凍砲彈需要垂直戰場</span></div>
    `;

    const input = requireElement<HTMLInputElement>(this.root, '#annoyance');
    const quickOptions = requireElement<HTMLDivElement>(this.root, '.quick-options');
    const gogglesInput = requireElement<HTMLInputElement>(this.root, '#goggles-enabled');
    const gogglesPreview = requireElement<SVGElement>(this.root, '.css-goggles');
    const syncGogglesPreview = (): void => {
      gogglesPreview.setAttribute('visibility', gogglesInput.checked ? 'visible' : 'hidden');
    };
    gogglesInput.addEventListener('change', syncGogglesPreview);
    input.addEventListener('input', () => {
      const characters = Array.from(input.value);
      if (characters.length > 80) input.value = characters.slice(0, 80).join('');
      quickOptions.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) => {
        chip.classList.remove('selected');
        chip.setAttribute('aria-pressed', 'false');
      });
    });
    syncGogglesPreview();
    for (const option of QUICK_ANNOYANCES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = option;
      button.dataset.testid = `quick-${option}`;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        input.value = option;
        quickOptions.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) => {
          chip.classList.remove('selected');
          chip.setAttribute('aria-pressed', 'false');
        });
        button.classList.add('selected');
        button.setAttribute('aria-pressed', 'true');
      });
      quickOptions.append(button);
    }

    requireElement<HTMLFormElement>(this.root, '.annoyance-form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.latestAnnoyance = input.value.trim() || '需求一直改';
      // Neutral mode is the standard flow. Camera access is still requested
      // only after the player reads the on-device privacy disclosure.
      this.wantsCamera = true;
      this.soundEnabled = requireElement<HTMLInputElement>(this.root, '#sound-enabled').checked;
      this.gogglesVisible = gogglesInput.checked;
      void this.compileBoss();
    });
    if (restoreFocus) {
      requireElement<HTMLElement>(this.root, '#game-title').focus({ preventScroll: true });
    }
  }

  private async compileBoss(): Promise<void> {
    const requestGeneration = ++this.generation;
    this.showLoadingScreen();
    const result = await fetchBossDNA(
      this.latestAnnoyance,
      'zh-TW',
      undefined,
      (progress) => {
        if (requestGeneration === this.generation) {
          this.updateLoadingProgress(progress.percent);
        }
      },
    );
    if (requestGeneration !== this.generation) return;
    // Keep the completed cyber dial on screen long enough to register even
    // when the local fallback resolves almost instantly.
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 650));
    if (requestGeneration !== this.generation) return;
    this.stopLoadingProgressAnimation();
    this.latestBoss = result;
    if (this.wantsCamera) this.showCameraConsent();
    else this.launchBattle(result);
  }

  private showLoadingScreen(): void {
    this.root.classList.remove('battle-active');
    this.stopLoadingProgressAnimation();
    this.root.innerHTML = `
      <main class="screen loading-screen" aria-live="polite" aria-busy="true" aria-labelledby="loading-title">
        <p class="eyebrow">BOSS COMPILER v1.0</p>
        <h2 id="loading-title" tabindex="-1">AI 正在把煩惱<br>編譯成 BOSS…</h2>
        <div class="compile-ring-shell">
          <div class="compile-orbit" aria-hidden="true"><i></i><i></i><i></i></div>
          <div class="compile-ring" role="progressbar" aria-label="AI 對話生成進度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <span class="compile-ticks" aria-hidden="true"></span>
            <span class="compile-scanner" aria-hidden="true"></span>
            <span class="compile-core" aria-hidden="true">
              <strong data-loading-percent>0%</strong>
              <small>DNA SYNC</small>
            </span>
          </div>
        </div>
      </main>
    `;
    this.startLoadingProgressAnimation();
    requireElement<HTMLElement>(this.root, '#loading-title').focus({ preventScroll: true });
  }

  private updateLoadingProgress(percent: number): void {
    const safePercent = Math.max(0, Math.min(100, percent));
    this.loadingProgressCeiling = safePercent >= 100
      ? 100
      : safePercent >= 50
        ? 94
        : 48;
    this.loadingProgressComplete = safePercent >= 100;
  }

  private startLoadingProgressAnimation(): void {
    this.loadingProgress = 0;
    this.loadingProgressCeiling = 48;
    this.loadingProgressComplete = false;
    this.loadingProgressLastTime = performance.now();
    this.renderLoadingProgress(0);

    const animate = (time: number): void => {
      const deltaSeconds = Math.min(0.1, Math.max(0, time - this.loadingProgressLastTime) / 1000);
      this.loadingProgressLastTime = time;
      const smoothing = this.loadingProgressComplete ? 9.5 : 0.62;
      const blend = 1 - Math.exp(-smoothing * deltaSeconds);
      this.loadingProgress += (this.loadingProgressCeiling - this.loadingProgress) * blend;
      if (this.loadingProgressComplete && this.loadingProgressCeiling - this.loadingProgress < 0.12) {
        this.loadingProgress = 100;
      }
      this.renderLoadingProgress(this.loadingProgress);
      if (this.loadingProgress < 100 && this.root.querySelector('.loading-screen')) {
        this.loadingProgressFrame = window.requestAnimationFrame(animate);
      } else {
        this.loadingProgressFrame = null;
      }
    };
    this.loadingProgressFrame = window.requestAnimationFrame(animate);
  }

  private renderLoadingProgress(percent: number): void {
    const progressBar = this.root.querySelector<HTMLElement>('.compile-ring');
    const percentLabel = this.root.querySelector<HTMLElement>('[data-loading-percent]');
    if (!progressBar || !percentLabel) return;

    const safePercent = Math.max(0, Math.min(100, percent));
    const roundedPercent = Math.round(safePercent);
    progressBar.style.setProperty('--progress', `${safePercent.toFixed(2)}%`);
    progressBar.setAttribute('aria-valuenow', String(roundedPercent));
    setSafeText(percentLabel, `${roundedPercent}%`);
  }

  private stopLoadingProgressAnimation(): void {
    if (this.loadingProgressFrame !== null) {
      window.cancelAnimationFrame(this.loadingProgressFrame);
      this.loadingProgressFrame = null;
    }
  }

  private showCameraConsent(message = ''): void {
    this.stopLoadingProgressAnimation();
    this.root.classList.remove('battle-active');
    this.root.innerHTML = `
      <main class="screen camera-screen" aria-labelledby="camera-title" aria-describedby="camera-privacy">
        <p class="eyebrow">ON-DEVICE MODE</p>
        <h2 id="camera-title" tabindex="-1">面無表情模式</h2>
        <div class="camera-glyph" aria-hidden="true"><span>• •</span></div>
        <p id="camera-privacy" class="camera-copy">此模式預設啟用。鏡頭畫面不會上傳、不會錄影，只用來估算笑、張嘴、抬眉等<strong>可見動作</strong>。</p>
        <p class="status-message" role="status"></p>
        <div class="camera-actions">
          <button type="button" class="primary-button" data-testid="start-calibration">開始 2 秒校正</button>
          <button type="button" class="text-button" data-testid="skip-camera">略過相機</button>
        </div>
      </main>
    `;
    setSafeText(requireElement(this.root, '.status-message'), message);
    requireElement<HTMLButtonElement>(this.root, '[data-testid="start-calibration"]').addEventListener('click', () => void this.startCalibration());
    requireElement<HTMLButtonElement>(this.root, '[data-testid="skip-camera"]').addEventListener('click', () => {
      this.wantsCamera = false;
      void this.stopFace().then(() => this.latestBoss && this.launchBattle(this.latestBoss));
    });
    requireElement<HTMLElement>(this.root, '#camera-title').focus({ preventScroll: true });
  }

  private async startCalibration(): Promise<void> {
    const button = requireElement<HTMLButtonElement>(this.root, '[data-testid="start-calibration"]');
    const status = requireElement<HTMLElement>(this.root, '.status-message');
    button.disabled = true;
    setSafeText(status, '正在請求前鏡頭權限…');
    await this.stopFace();
    this.faceActivityDetectedCount = 0;
    this.faceController = new FaceController({
      onStatus: ({ status: nextStatus, reason }) => this.updateCameraStatus(nextStatus, reason),
      onScore: (update) => this.updateFaceScore(update),
      onCalibrationProgress: (progress, validSamples) => this.updateCalibrationProgress(progress, validSamples)
    });
    const started = await this.faceController.start(true);
    if (!started.ok) {
      await this.stopFace();
      this.continueWithoutCamera('無法啟用相機，已自動改用標準模式。');
      return;
    }
    this.showCalibrationScreen();
    if (new URLSearchParams(location.search).get('debug') === '1') {
      const video = this.faceController.debugVideoElement;
      if (video) {
        video.className = 'debug-camera-preview';
        this.root.append(video);
      }
    }
    const calibrated = await this.faceController.calibrate(2_000, 10);
    if (!calibrated.ok) {
      await this.stopFace();
      this.continueWithoutCamera('沒有取得足夠的臉部樣本，已自動改用標準模式。');
      return;
    }
    if (this.latestBoss) this.launchBattle(this.latestBoss);
  }

  private continueWithoutCamera(message: string): void {
    this.wantsCamera = false;
    this.root.innerHTML = `
      <main class="screen camera-screen" aria-live="polite" aria-labelledby="camera-fallback-title">
        <p class="eyebrow">CAMERA OPTIONAL</p>
        <h2 id="camera-fallback-title" tabindex="-1">標準模式準備完成</h2>
        <div class="camera-glyph" aria-hidden="true"><span>• •</span></div>
        <p class="status-message" role="status"></p>
        <button type="button" class="primary-button continue-standard" data-testid="continue-standard">繼續標準模式</button>
      </main>
    `;
    setSafeText(requireElement(this.root, '.status-message'), message);
    requireElement<HTMLElement>(this.root, '#camera-fallback-title').focus({ preventScroll: true });
    let continued = false;
    const continueBattle = (): void => {
      if (continued || !this.latestBoss) return;
      continued = true;
      this.pendingBattleStatus = message;
      this.launchBattle(this.latestBoss);
    };
    requireElement<HTMLButtonElement>(this.root, '[data-testid="continue-standard"]')
      .addEventListener('click', continueBattle);
    window.setTimeout(continueBattle, 2_200);
  }

  private showCalibrationScreen(): void {
    this.root.innerHTML = `
      <main class="screen calibration-screen" aria-labelledby="calibration-title">
        <p class="eyebrow">ON-DEVICE CALIBRATION</p>
        <div class="calibration-ring" style="--progress:0" role="progressbar" aria-label="相機校正進度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="css-face" aria-hidden="true">• •</div></div>
        <h2 id="calibration-title" tabindex="-1">自然看向鏡頭</h2>
        <p>校正中 <strong data-testid="calibration-progress">0%</strong></p>
        <small>請保持自然即可，不是在判斷你的情緒。</small>
      </main>
    `;
    requireElement<HTMLElement>(this.root, '#calibration-title').focus({ preventScroll: true });
  }

  private updateCalibrationProgress(progress: number, validSamples: number): void {
    const ring = this.root.querySelector<HTMLElement>('.calibration-ring');
    const label = this.root.querySelector<HTMLElement>('[data-testid="calibration-progress"]');
    ring?.style.setProperty('--progress', String(progress));
    ring?.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    ring?.setAttribute('aria-valuetext', `${Math.round(progress * 100)}%，有效樣本 ${validSamples}`);
    if (label) label.textContent = `${Math.round(progress * 100)}% · ${validSamples}`;
  }

  private updateCameraStatus(status: FaceControllerStatus, reason?: string): void {
    const element = this.root.querySelector<HTMLElement>('.status-message');
    if (!element) return;
    const statusText: Partial<Record<FaceControllerStatus, string>> = {
      'requesting-camera': '正在請求前鏡頭權限…',
      initializing: '正在本機載入臉部動作模型…',
      unavailable: reason === 'permission-denied' ? '相機權限遭拒，仍可正常遊玩。' : '相機目前不可用，仍可正常遊玩。'
    };
    setSafeText(element, statusText[status] ?? '');
  }

  private updateFaceScore(update: FaceScoreUpdate): void {
    this.faceScore = update;
    if (update.activityDetected) this.faceActivityDetectedCount += 1;
    if (!this.faceTestProbeEnabled) return;

    // Phaser renders its HUD inside WebGL, which is intentionally opaque to
    // browser accessibility/test tooling. This explicit opt-in probe mirrors
    // only the numeric input supplied to that HUD; it never exposes a frame,
    // landmark, bitmap, or camera stream.
    const host = this.root.querySelector<HTMLElement>('#game-host');
    if (!host) return;
    host.dataset.faceNeutral = update.neutral == null ? '--' : String(update.neutral);
    host.dataset.faceRawNeutral = update.rawNeutral == null ? '--' : String(update.rawNeutral);
    host.dataset.faceFound = String(update.faceFound);
    host.dataset.faceBonusEligible = String(update.bonusEligible);
    host.dataset.faceActivityDetectedCount = String(this.faceActivityDetectedCount);
    host.dataset.faceMode = update.mode;
  }

  private launchBattle(result: BossApiResult): void {
    this.stopLoadingProgressAnimation();
    this.destroyGame();
    this.root.classList.add('battle-active');
    this.root.innerHTML = `
      <main class="battle-shell" aria-label="NOXCAT Boss 戰">
        <p class="sr-only" role="status" data-battle-status></p>
        <div id="game-host" data-testid="game-host"></div>
        <div class="battle-frame" aria-hidden="true"></div>
      </main>
      <div class="landscape-warning" role="status"><strong>請轉回直式</strong><span>果凍砲彈需要垂直戰場</span></div>
    `;
    // 僅保留開發環境的單招診斷入口；一般遊戲一律使用完整隨機招池。
    const attackSequence = import.meta.env.DEV
      && new URLSearchParams(window.location.search).get('demo') === 'off'
      ? result.boss.attacks
      : undefined;
    setBattleRuntime({
      boss: result.boss,
      attackSequence,
      source: result.source,
      annoyance: this.latestAnnoyance,
      soundEnabled: this.soundEnabled,
      gogglesVisible: this.gogglesVisible,
      faceProvider: () => this.faceScore
    });
    const pendingStatus = this.pendingBattleStatus;
    this.pendingBattleStatus = '';
    if (pendingStatus) {
      window.setTimeout(() => {
        const status = this.root.querySelector<HTMLElement>('[data-battle-status]');
        if (status) setSafeText(status, pendingStatus);
      }, 0);
    }
    this.game = new Phaser.Game(createGameConfig('game-host'));
  }

  private readonly onBattleResult = (event: CustomEvent<BattleResultDetail>): void => {
    void this.stopFace();
    this.showResultScreen(event.detail);
  };

  private showResultScreen(result: BattleResultDetail): void {
    this.destroyGame();
    this.root.classList.remove('battle-active');
    const snapshot = result.snapshot;
    const presented = presentResultScreen({
      won: result.won,
      lives: snapshot.lives,
      resultLine: result.resultLine,
    });
    this.root.innerHTML = `
      <main class="screen result-screen ${presented.modifier}" data-result-kind="${presented.kind}" aria-labelledby="result-title">
        <p class="eyebrow" data-testid="result-eyebrow"></p>
        <p class="grade"><span class="sr-only">評級 </span><span data-grade-value></span></p>
        <h2 id="result-title" tabindex="-1" data-testid="result-title"></h2>
        <h3 class="result-boss"></h3>
        <p class="result-line" data-testid="result-line"></p>
        <dl class="stats-grid">
          <div><dt>完成時間</dt><dd data-stat="time"></dd></div>
          <div><dt>擦彈</dt><dd data-stat="graze"></dd></div>
          <div><dt>反彈</dt><dd data-stat="reflect"></dd></div>
          <div><dt>主要撞擊</dt><dd data-stat="hits"></dd></div>
        </dl>
        <div class="neutral-result" hidden><span>AVG NEUTRAL</span><b></b><small></small></div>
        <div class="result-actions">
          <button type="button" class="primary-button" data-testid="retry">再挑戰一次</button>
          <button type="button" class="secondary-button" data-testid="change-annoyance">換一個煩惱</button>
        </div>
      </main>
    `;
    setSafeText(requireElement(this.root, '[data-testid="result-eyebrow"]'), presented.eyebrow);
    setSafeText(requireElement(this.root, '[data-grade-value]'), result.grade);
    setSafeText(requireElement(this.root, '[data-testid="result-title"]'), presented.title);
    setSafeText(requireElement(this.root, '.result-boss'), result.bossName);
    setSafeText(requireElement(this.root, '[data-testid="result-line"]'), presented.line);
    setSafeText(requireElement(this.root, '[data-stat="time"]'), formatSeconds(snapshot.elapsedMs));
    setSafeText(requireElement(this.root, '[data-stat="graze"]'), String(snapshot.grazeCount));
    setSafeText(requireElement(this.root, '[data-stat="reflect"]'), String(snapshot.reflectCount));
    setSafeText(requireElement(this.root, '[data-stat="hits"]'), `${snapshot.mainAttackHits} / ${MAIN_ATTACK_HITS_TO_WIN}`);
    if (snapshot.averageNeutral !== null) {
      const neutral = requireElement<HTMLElement>(this.root, '.neutral-result');
      neutral.hidden = false;
      setSafeText(requireElement(neutral, 'b'), `${Math.round(snapshot.averageNeutral)}%`);
      setSafeText(requireElement(neutral, 'small'), `最高 ${Math.round(snapshot.highestNeutral ?? snapshot.averageNeutral)}%`);
    }
    requireElement<HTMLElement>(this.root, '#result-title').focus({ preventScroll: true });
    requireElement<HTMLButtonElement>(this.root, '[data-testid="retry"]').addEventListener('click', () => {
      if (!this.latestBoss) return;
      if (this.wantsCamera) this.showCameraConsent();
      else this.launchBattle(this.latestBoss);
    });
    requireElement<HTMLButtonElement>(this.root, '[data-testid="change-annoyance"]').addEventListener('click', () => this.showStartScreen(true));
  }

  private destroyGame(): void {
    this.game?.destroy(true);
    this.game = null;
  }

  private readonly onUiPointerDown = (event: PointerEvent): void => {
    this.playButtonCue(event.target);
  };

  private readonly onUiKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') this.playButtonCue(event.target);
  };

  private playButtonCue(target: EventTarget | null): void {
    if (!(target instanceof Element) || !target.closest('button')) return;
    const checkbox = this.root.querySelector<HTMLInputElement>('#sound-enabled');
    this.uiAudio.setEnabled(checkbox?.checked ?? this.soundEnabled);
    const cue = target.closest('.start-screen') ? 'homeSelect' : 'button';
    void this.uiAudio.unlock().then(() => this.uiAudio.play(cue));
  }

  private async stopFace(): Promise<void> {
    const controller = this.faceController;
    this.faceController = null;
    this.faceScore = null;
    await controller?.stop();
  }
}

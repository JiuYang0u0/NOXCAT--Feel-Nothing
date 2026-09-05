import { clipLineToBounds } from '../systems/LineGeometry';
import Phaser from 'phaser';
import { COMBAT_COLORS, PALETTE, PALETTE_CSS } from '../../theme/palette';
import { GameSession, type GameSessionSnapshot } from '../../state/GameSession';
import { SeededRng } from '../../utils/rng';
import { createAttackPool } from '../attackSequence';
import {
  AIM_MAX_PULL,
  AIM_MIN_PULL,
  BOSS_WEAK_POINT_RADIUS,
  DODGE_AREA_TOP,
  DODGE_AREA_BOTTOM,
  GAME_HEIGHT,
  GAME_WIDTH,
  LAUNCH_SPEED,
  ENERGY_PER_WAVE,
  ENERGY_PER_PERFECT_WAVE,
  NEUTRAL_ENERGY_PER_SECOND,
  POST_HIT_RELIEF_MS,
  PLAYER_INVULNERABLE_MS,
  PLAYER_LAUNCH_RADIUS,
  PLAYER_GRAZE_RADIUS,
  PLAYER_HIT_RADIUS,
  PLAYER_REFLECT_RADIUS,
  REFLECT_MIN_SPEED,
  STAGGER_DURATION_MS,
  VULNERABLE_WINDOW_MS,
} from '../constants';
import { DebugOverlay } from '../debug/DebugOverlay';
import { Boss, BOSS_DEFEAT_DURATION_MS } from '../entities/Boss';
import { Noxcat } from '../entities/Noxcat';
import { BattleState, isTerminalBattleState } from '../events';
import { getBattleRuntime, type BattleFaceSnapshot } from '../runtime';
import { AimGuide } from '../ui/AimGuide';
import { Hud } from '../ui/Hud';
import { ATTACK_NAMES, DANGER_INSTRUCTION } from '../ui/attackCues';
import { AttackDirector, type DangerZoneHint } from '../systems/AttackDirector';
import { AudioSystem } from '../systems/AudioSystem';
import {
  polygonSeparation,
  segmentDistance,
  sweptPointDistance,
} from '../systems/CollisionMath';
import { beamSegment } from '../patterns/deadlineBeam';
import { ProjectileSystem } from '../systems/ProjectileSystem';
import { computePacing, type PacingScale } from '../systems/PacingDirector';
import {
  advancePerformanceQuality,
  createPerformanceQualityState,
  visualBudgetForQuality,
  type PerformanceQualityState,
} from '../systems/PerformanceQuality';
import {
  calculateBattleViewportLayout,
  type BattleViewportLayout,
  viewportPointToWorld,
} from '../systems/ViewportLayout';
import { BOSS_PROJECTILE_ORIGIN, floorGridY } from '../systems/ProjectileDepth';
import {
  ATTACK_NEAR_MAX_X,
  ATTACK_NEAR_MIN_X,
  SIDE_ATTACK_ORIGIN_LEFT_X,
  SIDE_ATTACK_ORIGIN_RIGHT_X,
  SIDE_ATTACK_ORIGIN_Y,
} from '../patterns/fairness';
import {
  projectDangerRayHatch,
  projectDangerRectToVanishingQuad,
  projectDangerTargetCone,
} from '../systems/DangerTelegraph';
import {
  clampToLaunchBoundary,
  crossedLaunchBoundary,
} from '../systems/JellyMotionSystem';
import { GlassShatterEffect } from '../effects/GlassShatterEffect';

/** 拉桿不足的提示至少維持這麼久，之後才交還給脆弱窗口倒數。 */
const PULL_HINT_HOLD_MS = 650;

export interface BattleResultDetail {
  won: boolean;
  bossName: string;
  resultLine: string;
  source: 'ai' | 'fallback';
  grade: 'S' | 'A' | 'B' | 'C';
  snapshot: GameSessionSnapshot;
}

export class BattleScene extends Phaser.Scene {
  private readonly session = new GameSession();
  private noxcat!: Noxcat;
  private boss!: Boss;
  private hud!: Hud;
  private aimGuide!: AimGuide;
  private projectiles!: ProjectileSystem;
  private director!: AttackDirector;
  private audio!: AudioSystem;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd?: Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;
  private debug?: DebugOverlay;
  private testHook?: NonNullable<Window['__NOXCAT_TEST__']>;
  private waveGuide!: Phaser.GameObjects.Graphics;
  private lastHomingCueMs = 0;
  private bossSpeech!: Phaser.GameObjects.Text;
  private glassShatter!: GlassShatterEffect;
  private chatterTimer?: Phaser.Time.TimerEvent;
  private battleLineIndex = 0;
  private lastBossLineAt = Number.NEGATIVE_INFINITY;
  private dragging = false;
  private activePointerId: number | null = null;
  private aimAnchor = new Phaser.Math.Vector2();
  private aimPointer = new Phaser.Math.Vector2();
  private aimPull = 0;
  private focusPaused = false;
  private pauseResumeTimer?: Phaser.Time.TimerEvent;
  private touchLandscapeQuery?: MediaQueryList;
  private ended = false;
  private firstEnergyTutorial = true;
  private neutralScore: number | null = null;
  private faceSnapshot: BattleFaceSnapshot | null = null;
  private lastFaceTimestamp = -1;
  private hitReliefTimer?: Phaser.Time.TimerEvent;
  private performanceQuality: PerformanceQualityState = createPerformanceQualityState();
  private simulationUpdateCount = 0;
  private collisionUpdateCount = 0;
  private vulnerableRemainingMs = 0;
  /** 讓短暫的操作提示撐過幾幀，不被每幀重寫的倒數蓋掉。 */
  private stateMessageHoldUntilMs = 0;
  private combatTimeScale = 1;
  private presentationTimeMs = 0;
  private lastInputSample: {
    event: 'none' | 'down' | 'move' | 'up';
    rawX: number;
    rawY: number;
    worldX: number;
    worldY: number;
  } = {
    event: 'none',
    rawX: 0,
    rawY: 0,
    worldX: 0,
    worldY: 0,
  };
  private viewportLayout: BattleViewportLayout = calculateBattleViewportLayout(
    GAME_WIDTH,
    GAME_HEIGHT,
  );
  private background?: Phaser.GameObjects.Graphics;
  private vignette?: Phaser.GameObjects.Graphics;
  private waveStartLives = 3;
  private readonly handleViewportResize = (): void => this.applyViewportLayout();
  private currentPacing: PacingScale | null = null;

  constructor() {
    super('BattleScene');
  }

  create(): void {
    this.performanceQuality = createPerformanceQualityState();
    this.simulationUpdateCount = 0;
    this.collisionUpdateCount = 0;
    const runtime = getBattleRuntime();
    this.applyViewportLayout();
    this.drawBackground();
    this.waveGuide = this.add.graphics().setDepth(-4).setAlpha(0);
    this.boss = new Boss(this, runtime.boss.bossName, runtime.boss.weakPointLabel);
    this.noxcat = new Noxcat(this);
    this.noxcat.setGogglesVisible(runtime.gogglesVisible);
    this.projectiles = new ProjectileSystem(this);
    this.hud = new Hud(this, runtime.boss.bossName);
    this.hud.relayout(this.viewportLayout);
    this.aimGuide = new AimGuide(this);
    this.audio = new AudioSystem();
    this.audio.setEnabled(runtime.soundEnabled);
    this.audio.setMusicMode('intro');
    this.audio.startMusic('battle.main');
    // A submit, camera, or skip gesture has already happened before the Scene
    // exists. Browsers requiring a canvas gesture retry from setupInput.
    void this.audio.unlock();
    this.glassShatter = new GlassShatterEffect(this);
    this.setupBossChatter();
    const fixedSequence = import.meta.env.DEV ? runtime.attackSequence : undefined;
    this.director = new AttackDirector(
      {
        attacks: fixedSequence ?? createAttackPool(runtime.boss.attacks),
        shuffleSeed: fixedSequence ? undefined : runtime.boss.seed,
        commentLines: runtime.boss.commentLines,
      },
      new SeededRng(runtime.boss.seed),
      this.projectiles,
      {
        scene: this,
        player: this.noxcat,
        onPatternChanged: (pattern) => {
          if (this.debug) this.hud.setStateMessage(pattern.replaceAll('_', ' ').toUpperCase());
        },
        onReturnableTutorial: () => this.hud.flash('↻ 高速撞回去！', 1500),
        onReturnableWindow: () => {
          this.hideDangerZones();
          this.hud.setStateMessage('↻ 高速撞回文件');
        },
        onDangerZonesChanged: (zones) => this.paintDangerZones(zones),
        getPlayerPosition: () => ({ x: this.noxcat.x, y: this.noxcat.y }),
        onWavePhaseChanged: (phase, pattern, _volley, _safeLane, dangerZones) => {
          if (phase === 'TELEGRAPH') {
            this.waveStartLives = this.session.lives;
            this.boss.setExpression('charging');
            this.showDangerZones(dangerZones ?? []);
            this.hud.setStateMessage(pattern === 'closing_walls' ? '跟著缺口移動' : DANGER_INSTRUCTION, pattern !== 'closing_walls');
            this.hud.flash(ATTACK_NAMES[pattern], 850, true);
          } else if (phase === 'ACTIVE') {
            this.boss.setExpression('attacking');
            this.fadeDangerZones();
            this.hud.setStateMessage(pattern === 'closing_walls' ? '跟著缺口移動' : DANGER_INSTRUCTION, pattern !== 'closing_walls');
          } else {
            this.boss.setExpression('recovering');
            this.hideDangerZones();
            const bonus = ENERGY_PER_WAVE
              + (this.session.lives === this.waveStartLives ? ENERGY_PER_PERFECT_WAVE : 0);
            this.session.addEnergy(bonus);
            this.hud.setStateMessage(`能量恢復 +${bonus}`);
          }
        },
      },
    );

    this.setupInput();
    this.setupVisibilityHandling();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleViewportResize);
    this.showIntro(runtime.boss.bossName, runtime.boss.openingLine, runtime.source);
    this.setupDebug();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
  }

  update(_time: number, deltaMs: number): void {
    if (this.focusPaused || this.ended) return;
    const delta = Math.min(deltaMs, 50);
    const dt = delta / 1000;
    const runtime = getBattleRuntime();
    const face = runtime.faceProvider();

    this.updateKeyboard(dt);
    this.presentationTimeMs += delta * this.combatTimeScale;
    const noxcatBeforeStep = { x: this.noxcat.x, y: this.noxcat.y };
    this.noxcat.updateMotion(dt * this.combatTimeScale);
    this.boss.pulse(this.presentationTimeMs);

    if (this.session.state !== BattleState.INTRO && !isTerminalBattleState(this.session.state)) {
      this.simulationUpdateCount += 1;
      // 與 director / 碰撞 / 畫質共用同一個夾限時鐘，避免掉幀時倒數跑得比模擬快。
      this.session.advanceTime(Math.max(0, delta));
      if (isTerminalBattleState(this.session.state)) {
        this.hud.update(this.session.snapshot(), this.neutralScore);
        this.finishBattle();
        return;
      }
      this.syncMusicToBattleState();
      this.currentPacing = computePacing({
        elapsedMs: this.session.elapsedMs,
        remainingMs: this.session.remainingMs,
        energy: this.session.energy,
        bossHp: this.session.bossHp,
        mainHits: this.session.mainAttackHits,
        grazeCount: this.session.grazeCount,
        lives: this.session.lives,
      });
      this.director.setPacingScale(this.currentPacing);
      this.updateVulnerabilityWindow(delta);
      this.updateNeutral(face, dt);
      this.handleBeamCollisions(noxcatBeforeStep);
      this.projectiles.update(dt, this.noxcat, this.combatTimeScale);
      this.updateHomingCue(delta);
      this.handleProjectileCollisions(noxcatBeforeStep, delta);
      this.collisionUpdateCount += 1;
      if (this.session.state === BattleState.DODGING) {
        this.director.update(delta, this.session.lives);
        if (this.session.energy >= 100 && this.director.currentPhase === 'RECOVERY') {
          this.openVulnerability();
        }
      }
      if (this.session.state === BattleState.LAUNCHED) this.updateLaunch(noxcatBeforeStep);
    }

    const boostActive = this.faceSnapshot?.bonusEligible === true
      && this.session.state === BattleState.DODGING
      && !this.ended
      && !this.focusPaused;
    this.hud.update(this.session.snapshot(), this.neutralScore, boostActive, delta * this.combatTimeScale);
    this.debug?.update(
      this.session,
      this.noxcat,
      this.game.loop.actualFps,
      `${this.director.currentPattern}/${this.director.currentPhase}`,
      this.faceSnapshot,
      this.projectiles,
      this.director.currentSafeLane,
      this.currentPacing,
    );
    // Quality monitoring follows wall-clock frame time rather than the 50 ms
    // physics clamp, so a genuinely slow device still degrades after about
    // two real seconds. Cap a single sample to reject a one-off long stall.
    this.adjustQuality(this.game.loop.actualFps, Math.min(Math.max(deltaMs, 0), 250));

    if (isTerminalBattleState(this.session.state)) this.finishBattle();
  }

  private drawBackground(): void {
    const background = this.background ?? this.add.graphics().setDepth(-20);
    this.background = background;
    background.clear();
    const view = this.viewportLayout;
    const overscan = 360;
    background.fillGradientStyle(0x070a08, 0x070a08, 0x121b0d, 0x070a08, 1);
    background.fillRect(
      view.left - overscan,
      view.top - overscan,
      view.width + overscan * 2,
      view.height + overscan * 2,
    );
    background.lineStyle(1, 0x97ba22, 0.11);
    const floorBottom = Math.max(900, view.bottom - 60);
    const floorDivisions = 11;
    const floorRows = Array.from({ length: floorDivisions }, (_, row) => (
      floorGridY(row + 1, floorDivisions, floorBottom)
    ));
    const boundaryRow = floorRows.reduce((nearest, y) => (
      Math.abs(y - DODGE_AREA_TOP) < Math.abs(nearest - DODGE_AREA_TOP) ? y : nearest
    ));
    // 不同螢幕比例下，最近的地板橫線都與活動邊界共用同一高度。
    for (const rowY of floorRows) {
      const y = rowY === boundaryRow ? DODGE_AREA_TOP : rowY;
      background.lineBetween(view.left, y, view.right, y);
    }
    // The floor frame and Boss-fired documents now share the exact same
    // vanishing point and overscanned near-plane bounds. Their edges cannot
    // visually diverge as the cards approach the player.
    const gridColumns = 10;
    const gridTopY = 420;
    const attackNearY = 820;
    const xOnAttackRay = (targetX: number, y: number): number => {
      const depth = (y - BOSS_PROJECTILE_ORIGIN.y)
        / (attackNearY - BOSS_PROJECTILE_ORIGIN.y);
      return BOSS_PROJECTILE_ORIGIN.x
        + (targetX - BOSS_PROJECTILE_ORIGIN.x) * depth;
    };
    for (let column = 0; column <= gridColumns; column += 1) {
      const progress = column / gridColumns;
      const targetX = Phaser.Math.Linear(ATTACK_NEAR_MIN_X, ATTACK_NEAR_MAX_X, progress);
      background.lineBetween(
        xOnAttackRay(targetX, gridTopY),
        gridTopY,
        xOnAttackRay(targetX, floorBottom),
        floorBottom,
      );
    }
    // Side portal rails frame the second perspective family used by crossfire
    // and closing-wall attacks. Their origins sit just outside the crop.
    background.lineStyle(2, PALETTE.green, 0.13);
    background.lineBetween(
      SIDE_ATTACK_ORIGIN_LEFT_X,
      SIDE_ATTACK_ORIGIN_Y,
      ATTACK_NEAR_MIN_X,
      attackNearY,
    );
    background.lineBetween(
      SIDE_ATTACK_ORIGIN_RIGHT_X,
      SIDE_ATTACK_ORIGIN_Y,
      ATTACK_NEAR_MAX_X,
      attackNearY,
    );
    background.fillStyle(PALETTE.green, 0.035).fillEllipse(270, 450, 510, 560);

    // 用淡色地板與短邊線標示一般移動區，避免玩家碰到看不見的牆。
    background.fillStyle(PALETTE.green, 0.025)
      .fillRect(0, DODGE_AREA_TOP, GAME_WIDTH, GAME_HEIGHT - DODGE_AREA_TOP);
    background.lineStyle(2, PALETTE.green, 0.3)
      .lineBetween(12, DODGE_AREA_TOP, GAME_WIDTH - 12, DODGE_AREA_TOP)
      .lineBetween(12, DODGE_AREA_TOP, 12, DODGE_AREA_TOP + 18)
      .lineBetween(GAME_WIDTH - 12, DODGE_AREA_TOP, GAME_WIDTH - 12, DODGE_AREA_TOP + 18);

    const vignette = this.vignette ?? this.add.graphics().setDepth(90).setAlpha(0.12);
    this.vignette = vignette;
    vignette.clear().lineStyle(46 / view.zoom, 0x000000, 1).strokeRect(
      view.left,
      view.top,
      view.width,
      view.height,
    );
  }

  private applyViewportLayout(): void {
    const displayWidth = Math.max(1, this.scale.width);
    const displayHeight = Math.max(1, this.scale.height);
    this.viewportLayout = calculateBattleViewportLayout(displayWidth, displayHeight);
    this.cameras.main
      .setViewport(0, 0, displayWidth, displayHeight)
      .setZoom(this.viewportLayout.zoom)
      .centerOn(this.viewportLayout.centerX, this.viewportLayout.centerY);
    this.hud?.relayout(this.viewportLayout);
    if (this.background) this.drawBackground();
  }

  private showDangerZones(zones: readonly DangerZoneHint[]): void {
    this.tweens.killTweensOf(this.waveGuide);
    this.waveGuide.clear().setAlpha(0);
    if (zones.length === 0) return;

    this.paintDangerZones(zones);
    this.tweens.add({
      targets: this.waveGuide,
      alpha: { from: 0.35, to: 1 },
      duration: 240,
      ease: 'Sine.Out',
    });
  }

  private paintDangerZones(zones: readonly DangerZoneHint[]): void {
    this.waveGuide.clear();
    if (this.director.currentPattern === 'closing_walls') {
      this.drawClosingWallGuide();
      return;
    }
    for (const zone of zones) {
      if (zone.kind === 'rect') this.drawHatchedDangerRect(zone);
      else if (zone.kind === 'ray') this.drawDirectionalDanger(zone);
      else if (zone.kind === 'safe') this.drawSafeSpot(zone);
      else this.drawTargetDanger(zone.x, zone.y, zone.radius);
    }
  }

  private drawClosingWallGuide(): void {
    const lane = this.director.currentSafeLane;
    if (!lane) return;
    const top = lane.center - lane.halfWidth;
    const bottom = lane.center + lane.halfWidth;
    const left = 16;
    const right = GAME_WIDTH - 16;
    const g = this.waveGuide;
    // 兩側文件匣只標記危險高度，留白通道與實際共用的玩家安全缺口一致。
    for (const [y, height, edge] of [
      [DODGE_AREA_TOP, top - DODGE_AREA_TOP, top],
      [bottom, DODGE_AREA_BOTTOM - bottom, bottom],
    ] as const) {
      g.fillStyle(COMBAT_COLORS.danger, 0.035).fillRect(left, y, right - left, height);
      for (const x of [left, right - 24]) {
        g.fillStyle(COMBAT_COLORS.danger, 0.16).fillRoundedRect(x, y, 24, height, 4);
        for (let row = y + 14; row < y + height - 8; row += 24) {
          g.lineStyle(2, COMBAT_COLORS.danger, 0.48).lineBetween(x + 5, row, x + 19, row - 5);
        }
      }
      g.lineStyle(7, PALETTE.green, 0.09).lineBetween(left + 28, edge, right - 28, edge);
      g.lineStyle(1.5, PALETTE.green, 0.85).lineBetween(left + 28, edge, right - 28, edge);
      for (const x of [left + 28, right - 28]) {
        const direction = edge === top ? 1 : -1;
        g.lineStyle(3, PALETTE.white, 0.9).lineBetween(x, edge, x, edge + direction * 14);
      }
      const cueY = y + height / 2;
      if (height > 45) {
        this.drawCueArrow(72, cueY, 1, 0);
        this.drawCueArrow(GAME_WIDTH - 72, cueY, -1, 0);
      }
    }
  }

  private drawHatchedDangerRect(zone: Extract<DangerZoneHint, { kind: 'rect' }>): void {
    const colour = COMBAT_COLORS.danger;
    if (zone.projection === 'screen') {
      const right = zone.x + zone.width;
      const bottom = zone.y + zone.height;
      const points = [
        { x: zone.x, y: zone.y },
        { x: right, y: zone.y },
        { x: right, y: bottom },
        { x: zone.x, y: bottom },
      ];
      this.waveGuide.fillStyle(colour, 0.075).fillPoints(points, true, true);
      this.waveGuide.lineStyle(3, colour, 0.78).strokePoints(points, true, true);
      this.waveGuide.lineStyle(2, colour, 0.3);
      for (let fraction = 0.1; fraction < 1; fraction += 0.1) {
        const x = Phaser.Math.Linear(zone.x, right, fraction);
        this.waveGuide.lineBetween(x, zone.y, x, bottom);
      }
      for (const depth of [0.28, 0.56, 0.82]) {
        const y = Phaser.Math.Linear(zone.y, bottom, depth);
        this.waveGuide.lineBetween(zone.x, y, right, y);
      }
      const cueTop = Math.max(zone.y, DODGE_AREA_TOP + 20);
      const cueBottom = Math.min(bottom, GAME_HEIGHT - 100);
      if (cueBottom - cueTop > 24) {
        const y = (cueTop + cueBottom) / 2;
        if (this.director.currentPattern === 'closing_walls') {
          this.drawCueArrow(76, y, 1, 0);
          this.drawCueArrow(GAME_WIDTH - 76, y, -1, 0);
        } else if (
          this.director.currentPattern === 'top_downpour'
          || this.director.currentPattern === 'paper_rain'
          || this.director.currentPattern === 'pulse_barrage'
        ) {
          const x = (Math.max(20, zone.x) + Math.min(GAME_WIDTH - 20, right)) / 2;
          for (const offset of [-40, 40]) this.drawCueArrow(x, y + offset, 0, 1);
        }
      }
      return;
    }
    const quad = projectDangerRectToVanishingQuad(zone);
    const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
    this.waveGuide.fillStyle(colour, 0.075).fillPoints(points, true, true);
    this.waveGuide.lineStyle(3, colour, 0.78).strokePoints(points, true, true);

    // Fan the hatch from the Boss to the near edge. Unlike a screen-aligned
    // rectangle, every stroke now reinforces the exact incoming projectile ray.
    this.waveGuide.lineStyle(2, colour, 0.3);
    for (let fraction = 0.1; fraction < 1; fraction += 0.1) {
      const { start, end } = projectDangerRayHatch(quad, fraction);
      this.waveGuide.lineBetween(start.x, start.y, end.x, end.y);
    }
    for (const depth of [0.28, 0.56, 0.82]) {
      const left = {
        x: Phaser.Math.Linear(quad.topLeft.x, quad.bottomLeft.x, depth),
        y: Phaser.Math.Linear(quad.topLeft.y, quad.bottomLeft.y, depth),
      };
      const right = {
        x: Phaser.Math.Linear(quad.topRight.x, quad.bottomRight.x, depth),
        y: Phaser.Math.Linear(quad.topRight.y, quad.bottomRight.y, depth),
      };
      this.waveGuide.lineBetween(left.x, left.y, right.x, right.y);
    }
    const ray = projectDangerRayHatch(quad, 0.5);
    const dx = ray.end.x - ray.start.x;
    const dy = ray.end.y - ray.start.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const depths = this.director.currentPattern === 'pulse_barrage' ? [0.68, 0.8, 0.92] : [0.84];
    for (const depth of depths) {
      this.drawCueArrow(ray.start.x + dx * depth, ray.start.y + dy * depth, dx / length, dy / length);
    }
  }

  private drawCueArrow(x: number, y: number, dx: number, dy: number): void {
    this.waveGuide.lineStyle(3, COMBAT_COLORS.danger, 0.9)
      .lineBetween(x - dx * 12, y - dy * 12, x + dx * 12, y + dy * 12);
    this.waveGuide.fillStyle(COMBAT_COLORS.danger, 0.95).fillTriangle(
      x + dx * 17, y + dy * 17,
      x + dx * 3 - dy * 8, y + dy * 3 + dx * 8,
      x + dx * 3 + dy * 8, y + dy * 3 - dx * 8,
    );
  }

  private drawDirectionalDanger(zone: Extract<DangerZoneHint, { kind: 'ray' }>): void {
    const dx = zone.to.x - zone.from.x;
    const dy = zone.to.y - zone.from.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / distance;
    const uy = dy / distance;
    const clipped = clipLineToBounds(zone.from, { x: ux, y: uy }, {
      left: 14, right: GAME_WIDTH - 14, top: DODGE_AREA_TOP + 8, bottom: GAME_HEIGHT - 64,
    });
    if (!clipped) return;
    // clipLineToBounds 裁的是無限直線，但光束只到 zone.to；不夾回線段範圍，
    // 斜向光束會把終點之後可安全站立的地板畫成危險區。
    const entryOffset = (clipped.entry.x - zone.from.x) * ux + (clipped.entry.y - zone.from.y) * uy;
    const exitOffset = (clipped.exit.x - zone.from.x) * ux + (clipped.exit.y - zone.from.y) * uy;
    const startOffset = Math.max(0, Math.min(entryOffset, exitOffset));
    const endOffset = Math.min(distance, Math.max(entryOffset, exitOffset));
    const length = endOffset - startOffset;
    if (length <= 1) return;
    const from = { x: zone.from.x + ux * startOffset, y: zone.from.y + uy * startOffset };
    const to = { x: zone.from.x + ux * endOffset, y: zone.from.y + uy * endOffset };
    const colour = COMBAT_COLORS.danger;
    const band = [
      { x: from.x - uy * zone.halfWidth, y: from.y + ux * zone.halfWidth },
      { x: to.x - uy * zone.halfWidth, y: to.y + ux * zone.halfWidth },
      { x: to.x + uy * zone.halfWidth, y: to.y - ux * zone.halfWidth },
      { x: from.x + uy * zone.halfWidth, y: from.y - ux * zone.halfWidth },
    ];
    // 光帶表示彈幕寬度，短虛線與實心箭頭表示來向；避開 Boss 與底部 HUD。
    this.waveGuide.fillStyle(colour, 0.065).fillPoints(band, true, true);
    for (const side of [-1, 1]) {
      const ox = -uy * zone.halfWidth * side;
      const oy = ux * zone.halfWidth * side;
      this.waveGuide.lineStyle(1, colour, 0.2).lineBetween(from.x + ox, from.y + oy, to.x + ox, to.y + oy);
    }
    this.waveGuide.lineStyle(10, colour, 0.06).lineBetween(from.x, from.y, to.x, to.y);
    for (let offset = 12; offset < length - 12; offset += 28) {
      const end = Math.min(offset + 11, length - 12);
      this.waveGuide.lineStyle(1.5, PALETTE.white, 0.55)
        .lineBetween(from.x + ux * offset, from.y + uy * offset, from.x + ux * end, from.y + uy * end);
    }
    for (let offset = 40; offset < length - 16; offset += 100) {
      const x = from.x + ux * offset;
      const y = from.y + uy * offset;
      this.waveGuide.fillStyle(colour, 0.9).fillTriangle(
        x + ux * 10, y + uy * 10,
        x - ux * 7 - uy * 7, y - uy * 7 + ux * 7,
        x - ux * 7 + uy * 7, y - uy * 7 - ux * 7,
      );
    }
    // 入口只用一個短刻度收尾，讓多條路徑同時出現時仍容易辨識。
    this.waveGuide.lineStyle(3, colour, 0.8)
      .lineBetween(from.x - uy * 10, from.y + ux * 10, from.x + uy * 10, from.y - ux * 10);
  }

  private drawSafeSpot(zone: Extract<DangerZoneHint, { kind: 'safe' }>): void {
    this.waveGuide.fillStyle(PALETTE.black, 0.9).fillCircle(zone.x, zone.y, zone.radius + 6);
    this.waveGuide.fillStyle(PALETTE.green, 0.12).fillCircle(zone.x, zone.y, zone.radius);
    this.waveGuide.lineStyle(1.5, PALETTE.white, 0.75).strokeCircle(zone.x, zone.y, zone.radius);
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 2) {
      this.waveGuide.lineStyle(2.5, PALETTE.green, 0.9).beginPath()
        .arc(zone.x, zone.y, zone.radius + 7, angle + 0.2, angle + 0.9).strokePath();
    }
    this.waveGuide.fillStyle(PALETTE.white, 0.8).fillCircle(zone.x, zone.y, 2);
  }

  private drawTargetDanger(x: number, y: number, radius: number): void {
    const colour = COMBAT_COLORS.danger;
    const cone = projectDangerTargetCone({ kind: 'target', x, y, radius });
    const conePoints = [
      cone.originLeft,
      cone.originRight,
      cone.targetRight,
      cone.targetLeft,
    ];
    this.waveGuide.fillStyle(colour, 0.035).fillPoints(conePoints, true, true);
    this.waveGuide.lineStyle(2, colour, 0.38).strokePoints(conePoints, true, true);
    this.waveGuide.fillStyle(colour, 0.055).fillCircle(x, y, radius);
    this.waveGuide.lineStyle(3, colour, 0.92)
      .strokeCircle(x, y, radius)
      .strokeCircle(x, y, radius * 0.58)
      .lineBetween(x - radius - 14, y, x - radius * 0.45, y)
      .lineBetween(x + radius * 0.45, y, x + radius + 14, y)
      .lineBetween(x, y - radius - 14, x, y - radius * 0.45)
      .lineBetween(x, y + radius * 0.45, x, y + radius + 14)
      .lineBetween(x - 9, y - 9, x + 9, y + 9)
      .lineBetween(x + 9, y - 9, x - 9, y + 9);
  }

  private fadeDangerZones(): void {
    this.tweens.killTweensOf(this.waveGuide);
    this.tweens.add({
      targets: this.waveGuide,
      // Actual projectiles take over as the primary cue during ACTIVE, while a
      // faint hatch preserves the promise made by the telegraph.
      alpha: this.director.currentPattern === 'closing_walls' ? 0.75 : 0.22,
      duration: 240,
      ease: 'Quad.Out',
    });
  }

  private hideDangerZones(): void {
    this.tweens.killTweensOf(this.waveGuide);
    this.waveGuide.clear().setAlpha(0);
  }

  private updateHomingCue(deltaMs: number): void {
    if (this.session.state !== BattleState.DODGING || this.director.currentPattern !== 'revision_homing'
      || this.director.currentPhase !== 'ACTIVE') return;
    this.lastHomingCueMs += deltaMs;
    if (this.lastHomingCueMs < 100) return;
    this.lastHomingCueMs = 0;
    const cards = this.projectiles.activeProjectiles().filter((card) => card.kind === 'homing' && card.isDamage && !card.friendly);
    if (cards.length === 0) return;
    // 只以 10 Hz 更新小型瞄準圈；追蹤停止後圈的位置也固定，讓閃避時機可讀。
    this.tweens.killTweensOf(this.waveGuide);
    this.waveGuide.clear().setAlpha(0.8);
    for (const card of cards) {
      const { x, y } = card.homingTarget;
      const radius = card.homingRemainingMs > 0 ? 38 : 30;
      this.waveGuide.lineStyle(2, COMBAT_COLORS.danger, 0.8).strokeCircle(x, y, radius)
        .lineBetween(x - 10, y, x + 10, y).lineBetween(x, y - 10, x, y + 10);
    }
    this.hud.setStateMessage(DANGER_INSTRUCTION, true);
  }

  private showIntro(name: string, line: string, source: 'ai' | 'fallback'): void {
    this.boss.setScale(0.72).setAlpha(0);
    this.tweens.add({ targets: this.boss, alpha: 1, scale: 1, duration: 650, ease: 'Back.Out' });
    const title = this.add.text(270, 425, name, {
      fontFamily: 'Inter, Noto Sans TC, system-ui, sans-serif',
      fontSize: '30px',
      fontStyle: '900',
      color: '#f4f7f2',
      stroke: '#000000',
      strokeThickness: 5,
      align: 'center',
      wordWrap: { width: 470 }
    }).setOrigin(0.5).setDepth(120);
    const quote = this.add.text(270, 474, `「${line}」`, {
      fontFamily: 'Inter, Noto Sans TC, system-ui, sans-serif',
      fontSize: '18px',
      color: PALETTE_CSS.green,
      align: 'center',
      wordWrap: { width: 450 }
    }).setOrigin(0.5).setDepth(120);
    const badge = this.add.text(270, 520, source === 'ai' ? 'AI BOSS DNA COMPILED' : 'LOCAL BOSS DNA READY', {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: '#071008',
      backgroundColor: PALETTE_CSS.green,
      padding: { x: 9, y: 5 }
    }).setOrigin(0.5).setDepth(120);
    this.time.delayedCall(1_850, () => {
      this.tweens.add({
        targets: [title, quote, badge],
        alpha: 0,
        y: '-=12',
        duration: 220,
        onComplete: () => {
          title.destroy();
          quote.destroy();
          badge.destroy();
        }
      });
      this.session.startBattle();
      this.director.start();
      this.startBossChatter();
    });
  }

  private setupInput(): void {
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      const audioReady = this.audio.unlock();
      if (this.focusPaused || this.activePointerId !== null) return;
      const world = viewportPointToWorld(this.viewportLayout, pointer.x, pointer.y);
      if (this.isBossSpeechHit(pointer)) {
        this.triggerBossSpeechShatter(pointer);
        this.lastInputSample = {
          event: 'down',
          rawX: pointer.x,
          rawY: pointer.y,
          worldX: world.x,
          worldY: world.y,
        };
        return;
      }
      this.lastInputSample = {
        event: 'down',
        rawX: pointer.x,
        rawY: pointer.y,
        worldX: world.x,
        worldY: world.y,
      };
      if (this.session.state === BattleState.VULNERABLE) {
        const distance = Phaser.Math.Distance.Between(world.x, world.y, this.noxcat.x, this.noxcat.y);
        if (distance <= 86 && this.session.beginAim()) {
          this.activePointerId = pointer.id;
          this.dragging = false;
          this.aimAnchor.set(this.noxcat.x, this.noxcat.y);
          this.aimPointer.set(world.x, world.y);
          this.noxcat.beginAim();
          void audioReady.then(() => {
            if (this.session.state === BattleState.AIMING && this.activePointerId === pointer.id) {
              this.audio.startDraw();
              this.audio.setDrawTension(this.aimPull / AIM_MAX_PULL);
            }
          });
        }
        return;
      }
      if (this.session.state === BattleState.DODGING) {
        this.activePointerId = pointer.id;
        this.dragging = true;
        this.noxcat.beginDrag();
        this.noxcat.setPointerTarget(world.x, world.y);
      }
    });
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (pointer.id !== this.activePointerId) return;
      const world = viewportPointToWorld(this.viewportLayout, pointer.x, pointer.y);
      this.lastInputSample = {
        event: 'move',
        rawX: pointer.x,
        rawY: pointer.y,
        worldX: world.x,
        worldY: world.y,
      };
      if (this.session.state === BattleState.AIMING) {
        this.aimPointer.set(world.x, world.y);
        this.aimPull = this.noxcat.updateAim(world.x, world.y, this.aimAnchor.x, this.aimAnchor.y);
        this.audio.setDrawTension(this.aimPull / AIM_MAX_PULL);
        this.aimGuide.show(this.aimAnchor.x, this.aimAnchor.y, world.x, world.y);
      } else if (this.dragging && this.session.state === BattleState.DODGING) {
        this.noxcat.setPointerTarget(world.x, world.y);
      }
    });
    const releasePointer = (pointer: Phaser.Input.Pointer): void => {
      if (pointer.id !== this.activePointerId) return;
      const world = viewportPointToWorld(this.viewportLayout, pointer.x, pointer.y);
      this.lastInputSample = {
        event: 'up',
        rawX: pointer.x,
        rawY: pointer.y,
        worldX: world.x,
        worldY: world.y,
      };
      this.activePointerId = null;
      const releasedDodge = this.dragging && this.session.state === BattleState.DODGING;
      this.dragging = false;
      if (releasedDodge) this.noxcat.releaseDrag();
      if (this.session.state !== BattleState.AIMING) return;
      this.audio.stopDraw();
      this.aimGuide.hide();
      const pullVector = this.aimAnchor.clone().subtract(this.aimPointer);
      const launched = this.session.releaseAim(this.aimPull);
      if (!launched || this.aimPull < AIM_MIN_PULL || pullVector.lengthSq() === 0) {
        this.noxcat.cancelAim(this.aimAnchor.x, this.aimAnchor.y);
        this.hud.setStateMessage('PULL FARTHER');
        this.stateMessageHoldUntilMs = this.time.now + PULL_HINT_HOLD_MS;
        return;
      }
      const speed = LAUNCH_SPEED * Phaser.Math.Clamp(this.aimPull / AIM_MAX_PULL, 0.62, 1);
      this.clearVulnerabilityWindow();
      this.setCombatTimeScale(1);
      this.noxcat.launch(pullVector, speed);
      this.boss.setWeakPointVisible(true);
      this.hud.setStateMessage('');
      this.audio.play('launch');
    };
    this.input.on('pointerup', releasePointer);
    this.input.on('pointerupoutside', releasePointer);

    this.cursors = this.input.keyboard?.createCursorKeys();
    if (this.input.keyboard) {
      this.input.keyboard.once('keydown', () => void this.audio.unlock());
      this.wasd = this.input.keyboard.addKeys('W,S,A,D') as Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;
      this.wasd = {
        up: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
        down: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
        left: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
        right: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D)
      };
    }
  }

  private updateKeyboard(dt: number): void {
    if (this.session.state !== BattleState.DODGING) return;
    const dx = Number(Boolean(this.cursors?.right.isDown || this.wasd?.right.isDown))
      - Number(Boolean(this.cursors?.left.isDown || this.wasd?.left.isDown));
    const dy = Number(Boolean(this.cursors?.down.isDown || this.wasd?.down.isDown))
      - Number(Boolean(this.cursors?.up.isDown || this.wasd?.up.isDown));
    if (dx !== 0 || dy !== 0) this.noxcat.nudgeTarget(dx, dy, dt);
  }

  private handleProjectileCollisions(
    noxcatBeforeStep: Readonly<{ x: number; y: number }>,
    deltaMs: number,
  ): void {
    const noxcatNow = { x: this.noxcat.x, y: this.noxcat.y };
    const frameSpeed = Phaser.Math.Distance.Between(
      noxcatBeforeStep.x,
      noxcatBeforeStep.y,
      noxcatNow.x,
      noxcatNow.y,
    ) / Math.max(deltaMs / 1000, 1 / 240);
    // The transformed cat silhouette is identical for every card this frame.
    // Computing it once avoids repeated trigonometry and dozens of temporary
    // point allocations during dense waves.
    const noxcatCollisionPolygon = this.noxcat.collisionPolygon();
    for (const projectile of this.projectiles.activeProjectiles()) {
      if (projectile.friendly) {
        const bossPoint = { x: this.boss.x, y: this.boss.y - 13 };
        const bossDistance = sweptPointDistance(
          { x: projectile.previousX, y: projectile.previousY },
          { x: projectile.collisionCenterX, y: projectile.collisionCenterY },
          bossPoint,
          bossPoint,
        );
        if (bossDistance <= projectile.radius + 42) {
          const hp = this.session.applyReflectedBossHit();
          this.boss.setHp(hp);
          this.boss.hitFeedback(false);
          this.audio.play('bossHit');
          this.showBossLine(true);
          projectile.recycle();
        }
        continue;
      }
      if (
        this.session.state !== BattleState.DODGING
        || !projectile.isDamage
        || !projectile.collisionActive
      ) continue;
      const projectileBeforeStep = projectile.previousCollisionActive
        ? { x: projectile.previousX, y: projectile.previousY }
        : { x: projectile.collisionCenterX, y: projectile.collisionCenterY };
      const distance = sweptPointDistance(
        projectileBeforeStep,
        { x: projectile.collisionCenterX, y: projectile.collisionCenterY },
        noxcatBeforeStep,
        noxcatNow,
      );
      const visualSeparation = polygonSeparation(
        noxcatCollisionPolygon,
        projectile.collisionPolygon,
        PLAYER_REFLECT_RADIUS - PLAYER_HIT_RADIUS,
      );
      const sweptHit = distance <= projectile.effectiveCollisionRadius + PLAYER_HIT_RADIUS;
      const overlapsVisuals = visualSeparation <= 0;
      const reflectionSpeed = Math.max(this.noxcat.speed, frameSpeed);
      if (
        projectile.reflectable
        && reflectionSpeed >= REFLECT_MIN_SPEED
        && (overlapsVisuals || visualSeparation <= PLAYER_REFLECT_RADIUS - PLAYER_HIT_RADIUS)
      ) {
        projectile.reflectTowards(this.boss.x, this.boss.y - 13);
        this.hud.flash('RETURN TO SENDER', 650);
        this.audio.play('reflect');
        continue;
      }
      // The marked green document is an interaction target, not a second
      // hostile card.  It may share the cat silhouette for several frames
      // while the player lines up a flick, so it must never fall through to
      // the ordinary hit branch merely because the current frame is below
      // REFLECT_MIN_SPEED.  A later high-speed overlap can still reflect it.
      if (projectile.reflectable) continue;
      const contact = overlapsVisuals || sweptHit
        ? 'hit'
        : visualSeparation <= PLAYER_GRAZE_RADIUS - PLAYER_HIT_RADIUS
          ? 'graze'
          : 'none';
      if (contact === 'graze' && this.session.registerGraze(projectile)) {
        this.showGraze(projectile.collisionCenterX, projectile.collisionCenterY);
        this.audio.play('graze');
      } else if (contact === 'hit' && this.session.takePlayerHit(this.session.elapsedMs)) {
        projectile.recycle();
        this.noxcat.hitFeedback();
        this.audio.play('hurt');
        this.hud.flash('FEEL THAT?', 650);
        this.showBossLine(true);
        this.beginPostHitRelief();
      }
    }
  }

  private handleBeamCollisions(
    previous: { x: number; y: number },
  ): void {
    const live = this.projectiles.activeBeams().filter((beam) => beam.telegraphMs <= 0);
    for (const beam of live) {
      const segment = beamSegment(beam);
      const collides = segmentDistance(
        previous,
        { x: this.noxcat.x, y: this.noxcat.y },
        segment.start,
        segment.end,
      ) <= this.noxcat.hitRadius + beam.height / 2;
      if (collides && !beam.hitPlayer && this.session.state === BattleState.DODGING) {
        beam.hitPlayer = true;
        if (this.session.takePlayerHit(this.session.elapsedMs)) {
          this.noxcat.hitFeedback();
          this.audio.play('hurt');
          this.showBossLine(true);
          this.beginPostHitRelief();
        }
      }
    }
  }

  private showGraze(x: number, y: number): void {
    const ring = this.add.circle(x, y, 14).setStrokeStyle(3, PALETTE.green, 0.8).setDepth(25);
    this.tweens.add({
      targets: ring,
      radius: 46,
      alpha: 0,
      duration: 280,
      onComplete: () => ring.destroy()
    });
  }

  private openVulnerability(): void {
    if (!this.session.openVulnerability()) return;
    this.hitReliefTimer?.remove(false);
    this.hitReliefTimer = undefined;
    this.director.cancelCurrent();
    this.hideDangerZones();
    this.boss.setExpression('stunned');
    this.boss.setWeakPointVisible(true);
    this.vulnerableRemainingMs = VULNERABLE_WINDOW_MS;
    this.stateMessageHoldUntilMs = 0;
    const combatScale = this.currentPacing?.combatScale ?? 0.55;
    this.setCombatTimeScale(combatScale);
    this.audio.play('full');
    this.showAttackTimeoutPrompt(VULNERABLE_WINDOW_MS);
    this.showBossLine(true);
    if (this.firstEnergyTutorial) {
      this.firstEnergyTutorial = false;
      this.hud.flash('5 秒內按住果凍貓・向後拉・放開！', 2_400);
    } else {
      this.hud.flash('5 秒內拉伸彈射！', 1_600);
    }
  }

  private updateLaunch(
    noxcatBeforeStep: Readonly<{ x: number; y: number }>,
  ): void {
    if (this.session.launchMissReturnPending) {
      if (this.noxcat.mode === 'returning') return;
      if (this.session.completeLaunchMissReturn()) {
        this.hud.setStateMessage('');
        this.director.resume(true);
      }
      return;
    }

    const bossPoint = { x: this.boss.x, y: this.boss.y - 13 };
    const bossDistance = sweptPointDistance(
      noxcatBeforeStep,
      { x: this.noxcat.x, y: this.noxcat.y },
      bossPoint,
      bossPoint,
    );
    if (bossDistance <= PLAYER_LAUNCH_RADIUS + BOSS_WEAK_POINT_RADIUS) {
      this.resolveMajorHit();
      return;
    }
    if (crossedLaunchBoundary(this.noxcat)) {
      const bouncePoint = clampToLaunchBoundary(this.noxcat);
      this.noxcat.setPosition(bouncePoint.x, bouncePoint.y);
      this.clearVulnerabilityWindow();
      this.setCombatTimeScale(1);
      this.session.resolveLaunch(false);
      this.boss.setWeakPointVisible(false);
      this.noxcat.startReturn(GAME_WIDTH / 2, GAME_HEIGHT * 0.77);
      this.hud.flash('MISS — ENERGY 30', 850);
    }
  }

  private resolveMajorHit(): void {
    if (this.session.state !== BattleState.LAUNCHED) return;
    this.clearVulnerabilityWindow();
    this.setCombatTimeScale(1);
    this.session.resolveLaunch(true);
    this.boss.setHp(this.session.bossHp);
    this.boss.hitFeedback(true);
    this.audio.play('bossHit');
    this.showBossLine(true);
    navigator.vibrate?.(20);
    this.noxcat.setPosition(this.boss.x, this.boss.y - 13);
    this.noxcat.beginImpact();
    const won = this.session.bossHp <= 0;
    this.hud.setStateMessage(won ? 'FEEL NOTHING' : 'BOSS STAGGERED');
    this.time.delayedCall(220, () => this.noxcat.startReturn(GAME_WIDTH / 2, GAME_HEIGHT * 0.77));
    if (won) return;
    this.time.delayedCall(STAGGER_DURATION_MS, () => {
      if (this.session.endStagger()) {
        this.boss.setWeakPointVisible(false);
        this.director.resume(true);
        this.hud.setStateMessage('');
      }
    });
  }

  private updateVulnerabilityWindow(deltaMs: number): void {
    if (this.vulnerableRemainingMs <= 0) return;
    if (this.session.state !== BattleState.VULNERABLE && this.session.state !== BattleState.AIMING) {
      this.clearVulnerabilityWindow();
      return;
    }
    this.vulnerableRemainingMs = Math.max(0, this.vulnerableRemainingMs - deltaMs);
    if (this.vulnerableRemainingMs > 0) {
      this.showAttackTimeoutPrompt(this.vulnerableRemainingMs);
      return;
    }

    if (this.session.state === BattleState.AIMING) this.cancelPointerInteraction();
    if (!this.session.expireVulnerability()) return;
    this.boss.setWeakPointVisible(false);
    this.setCombatTimeScale(1);
    this.director.resume(true);
    if (this.focusPaused) this.director.pause();
    this.hud.setStateMessage('');
    this.hud.flash('時間到・窗口關閉', 700, true);
  }

  private showAttackTimeoutPrompt(remainingMs: number): void {
    if (this.time.now < this.stateMessageHoldUntilMs) return;
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    this.hud.setStateMessage(`DO EVERYTHING · ${seconds}`, seconds <= 2);
  }

  private clearVulnerabilityWindow(): void {
    this.vulnerableRemainingMs = 0;
    this.stateMessageHoldUntilMs = 0;
  }

  private setCombatTimeScale(scale: number): void {
    this.combatTimeScale = scale;
    this.tweens.timeScale = scale;
  }

  private updateNeutral(face: BattleFaceSnapshot | null, dt: number): void {
    const now = performance.now();
    const current = face != null && now - face.timestampMs <= 500 ? face : null;
    this.faceSnapshot = current;
    this.neutralScore = current?.neutral ?? null;
    const isNewInference = current != null && current.timestampMs !== this.lastFaceTimestamp;
    if (isNewInference) {
      this.lastFaceTimestamp = current.timestampMs;
      this.session.recordNeutralScore(current.neutral);
      if (current.activityDetected) this.hud.flash('FEEL DETECTED', 600);
    }
    if (current?.bonusEligible && this.session.state === BattleState.DODGING) {
      this.session.addEnergy(NEUTRAL_ENERGY_PER_SECOND * dt);
    }
  }

  private beginPostHitRelief(): void {
    // A hit ends the authored wave completely. Resuming a paused delayed
    // timeline could otherwise emit another formation without a fresh
    // telegraph after the relief window.
    this.director.cancelCurrent();
    this.hideDangerZones();
    this.hitReliefTimer?.remove(false);
    this.hitReliefTimer = this.time.delayedCall(POST_HIT_RELIEF_MS, () => {
      this.hitReliefTimer = undefined;
      if (!this.ended && !this.focusPaused && this.session.state === BattleState.DODGING) {
        this.director.resume(true);
      }
    });
  }

  private adjustQuality(fps: number, deltaMs: number): void {
    const previousLevel = this.performanceQuality.level;
    this.performanceQuality = advancePerformanceQuality(this.performanceQuality, fps, deltaMs);
    if (this.performanceQuality.level === previousLevel) return;

    const budget = visualBudgetForQuality(this.performanceQuality.level);
    this.noxcat.setGhostQuality(budget.ghostLimit);
    this.projectiles.setVisualQuality(budget.reduceProjectileEffects);
    this.hud.setVisualQualityReduced(budget.reduceProjectileEffects);
  }

  private setupVisibilityHandling(): void {
    const touchLandscapeQuery = window.matchMedia(
      '(orientation: landscape) and (max-height: 600px) and (max-width: 1024px)',
    );
    this.touchLandscapeQuery = touchLandscapeQuery;
    const syncPause = (): void => {
      if (this.ended || !this.scene.isActive()) return;
      const shouldPause = document.hidden || touchLandscapeQuery.matches;
      if (shouldPause) {
        this.pauseResumeTimer?.remove(false);
        this.pauseResumeTimer = undefined;
        if (!this.focusPaused) this.cancelPointerInteraction();
        this.focusPaused = true;
        this.audio.setMusicPaused(true);
        // Returning early from Scene.update is not enough to pause Phaser's
        // Clock: delayed calls (intro, stagger, hit relief, and launch return)
        // are advanced by the Scene systems before update runs. Freeze that
        // clock as well so a background tab or the landscape blocker cannot
        // silently complete combat state while the player cannot interact.
        this.time.paused = true;
        this.director.pause();
        this.hud.setStateMessage('PAUSED');
      } else if (this.focusPaused && !this.pauseResumeTimer) {
        // The one-second READY countdown itself uses this Clock, so reactivate
        // it before scheduling while keeping focusPaused true until it fires.
        this.time.paused = false;
        this.hud.setStateMessage('READY…');
        this.pauseResumeTimer = this.time.delayedCall(1_000, () => {
          this.pauseResumeTimer = undefined;
          if (document.hidden || touchLandscapeQuery.matches || this.ended) return;
          this.focusPaused = false;
          this.audio.setMusicPaused(false);
          if (this.session.state === BattleState.DODGING && !this.hitReliefTimer) {
            this.director.resume(false);
          }
          this.hud.setStateMessage('');
        });
      }
    };
    document.addEventListener('visibilitychange', syncPause);
    window.addEventListener('resize', syncPause, { passive: true });
    window.addEventListener('orientationchange', syncPause, { passive: true });
    touchLandscapeQuery.addEventListener('change', syncPause);
    this.registry.set('pauseHandler', syncPause);
    syncPause();
  }

  private setupBossChatter(): void {
    this.bossSpeech = this.add.text(270, 376, '', {
      fontFamily: 'Inter, Noto Sans TC, system-ui, sans-serif',
      fontSize: '32px',
      fontStyle: '900',
      color: '#f4f7f2',
      backgroundColor: 'rgba(15, 15, 15, 0.7)',
      stroke: '#071008',
      strokeThickness: 4,
      padding: { x: 24, y: 14 },
      align: 'center',
      wordWrap: { width: 450 },
    }).setOrigin(0.5).setDepth(105).setAlpha(0);
    this.bossSpeech.setInteractive({ useHandCursor: true });
  }

  private isBossSpeechHit(pointer: Phaser.Input.Pointer): boolean {
    if (this.ended || this.focusPaused || isTerminalBattleState(this.session.state)) return false;
    if (this.session.state === BattleState.INTRO) return false;
    if (!this.bossSpeech.visible || this.bossSpeech.alpha < 0.12) return false;
    const world = viewportPointToWorld(this.viewportLayout, pointer.x, pointer.y);
    const bounds = this.bossSpeech.getBounds();
    const pad = 10;
    return world.x >= bounds.left - pad && world.x <= bounds.right + pad
      && world.y >= bounds.top - pad && world.y <= bounds.bottom + pad;
  }

  private triggerBossSpeechShatter(pointer: Phaser.Input.Pointer): void {
    const now = this.time.now;
    if (!this.glassShatter?.canShatter(now)) return;
    const world = viewportPointToWorld(this.viewportLayout, pointer.x, pointer.y);
    const bounds = this.bossSpeech.getBounds();
    const shatterX = Phaser.Math.Clamp(world.x, bounds.left + 12, bounds.right - 12);
    const shatterY = Phaser.Math.Clamp(world.y, bounds.top + 12, bounds.bottom - 12);
    const reduced = this.performanceQuality.level === 'reduced' || this.projectiles?.isVisualQualityReduced === true;
    const shattered = this.glassShatter.shatter(shatterX, shatterY, reduced);
    if (!shattered) return;
    this.audio.play('reflect');
    this.tweens.killTweensOf(this.bossSpeech);
    this.tweens.add({
      targets: this.bossSpeech,
      scaleX: 0.94,
      scaleY: 1.06,
      duration: 55,
      yoyo: true,
      repeat: 1,
      ease: 'Sine.easeInOut',
      onComplete: () => this.bossSpeech.setScale(1),
    });
  }

  private syncBossSpeechInteractive(): void {
    if (!this.bossSpeech) return;
    const bounds = this.bossSpeech.getBounds();
    const w = Math.max(120, bounds.width + 20);
    const h = Math.max(36, bounds.height + 16);
    this.bossSpeech.setInteractive(
      new Phaser.Geom.Rectangle(-w / 2, -h / 2, w, h),
      Phaser.Geom.Rectangle.Contains,
    );
    this.bossSpeech.input!.cursor = 'pointer';
  }

  private startBossChatter(): void {
    this.time.delayedCall(450, () => this.showBossLine(true));
    this.chatterTimer = this.time.addEvent({
      delay: 2_400,
      loop: true,
      callback: () => this.showBossLine(),
    });
  }

  private showBossLine(force = false): void {
    if (
      this.ended
      || this.focusPaused
      || this.session.state === BattleState.INTRO
      || isTerminalBattleState(this.session.state)
    ) return;
    if (!force && this.time.now - this.lastBossLineAt < 1_200) return;

    const runtime = getBattleRuntime();
    const lines = runtime.boss.battleLines;
    const lineNumber = this.battleLineIndex % lines.length;
    const line = lines[lineNumber];
    if (!line) return;
    this.battleLineIndex += 1;
    this.lastBossLineAt = this.time.now;

    this.tweens.killTweensOf(this.bossSpeech);
    this.bossSpeech.setText(`「${line}」`).setY(388).setAlpha(0).setScale(0.9).setVisible(true);
    this.syncBossSpeechInteractive();
    this.tweens.add({
      targets: this.bossSpeech,
      y: 370,
      alpha: 1,
      scale: 1,
      duration: 150,
      ease: 'Back.Out',
      onComplete: () => {
        this.syncBossSpeechInteractive();
        this.tweens.add({
          targets: this.bossSpeech,
          alpha: 0,
          y: 362,
          delay: 1_650,
          duration: 260,
          ease: 'Sine.In',
          onComplete: () => {
            this.bossSpeech.disableInteractive();
          },
        });
      },
    });
  }

  private cancelPointerInteraction(): void {
    this.activePointerId = null;
    if (this.dragging) {
      this.dragging = false;
      this.noxcat.cancelDrag();
    }
    if (this.session.state !== BattleState.AIMING) return;
    this.audio.stopDraw();
    this.aimGuide.hide();
    this.session.releaseAim(0);
    this.noxcat.cancelAim(this.aimAnchor.x, this.aimAnchor.y);
    this.aimPull = 0;
  }

  private setupDebug(): void {
    const params = new URLSearchParams(location.search);
    // Keep ordinary local play identical to the production presentation.
    // Diagnostics are opt-in so a development build does not permanently
    // cover the upper-left HUD with the debug panel.
    const debugEnabled = params.get('debug') === '1';
    // Screenshot automation is a local-development convenience, not a
    // production cheat surface. The documented `?debug=1` demo diagnostics
    // remain available in production, but `?capture=1` must never expose the
    // hidden state-mutating hook from a built deployment.
    const captureEnabled = import.meta.env.DEV && params.get('capture') === '1';
    if (!debugEnabled && !captureEnabled) return;
    const actions = {
      fillEnergy: (): void => {
        this.session.setEnergyForDebug(100);
        this.openVulnerability();
      },
      openWeakPoint: (): void => {
        this.session.setEnergyForDebug(100);
        this.openVulnerability();
        this.boss.setWeakPointVisible(true);
      },
      damageBoss: (): void => this.forceMajorHit(),
      spawnReflectable: (): void => {
        // Keep the debug card close but outside both contact radii. A fixed
        // side target makes the documented "high-speed撞回去" interaction
        // reproducible with mouse, touch, or the live-browser smoke test.
        const direction = this.noxcat.x <= GAME_WIDTH / 2 ? 1 : -1;
        const x = Phaser.Math.Clamp(this.noxcat.x + direction * 110, 70, GAME_WIDTH - 70);
        this.projectiles.spawn({
          kind: 'returnable',
          x,
          y: this.noxcat.y,
          vx: 0,
          vy: 0,
          radius: 22,
          yawOffset: 24 * Math.PI / 180,
        });
      },
      pauseAttacksForVisualTest: (): void => {
        this.director.pause();
        this.projectiles.clearDangerous(true);
      },
      advanceAttackForTest: (): void => {
        this.director.pause();
        this.projectiles.clearDangerous(true);
        this.director.resume(true);
      },
      toggleHitboxes: (): void => this.debug?.toggleHitboxes()
    };
    const runtime = getBattleRuntime();
    if (debugEnabled && !captureEnabled) {
      this.debug = new DebugOverlay(this, runtime.boss, runtime.source, actions);
    }
    if (!import.meta.env.DEV) return;
    this.testHook = {
      ...actions,
      spawnPerspectiveProbeForTest: (hitPlayer: boolean): void => {
        const target = hitPlayer
          ? { x: this.noxcat.x, y: this.noxcat.y }
          : { x: 70, y: 820 };
        this.projectiles.spawn({
          kind: 'paper',
          x: BOSS_PROJECTILE_ORIGIN.x,
          y: 155,
          vx: 0,
          vy: hitPlayer ? 4_000 : 800,
          radius: 18,
          perspectiveTarget: target,
          perspectiveDurationMs: hitPlayer ? 20 : 400,
        });
      },
      spawnExitProbesForTest: (): void => {
        this.projectiles.spawn({
          kind: 'paper',
          x: 180,
          y: 155,
          vx: 0,
          vy: 260,
          damage: false,
          radius: 18,
          perspectiveTarget: { x: 180, y: 700 },
          perspectiveDurationMs: 500,
        });
        this.projectiles.spawn({
          kind: 'comment',
          x: 360,
          y: 155,
          vx: 0,
          vy: 260,
          damage: false,
          radius: 24,
          text: 'EXIT',
          perspectiveTarget: { x: 360, y: 700 },
          perspectiveDurationMs: 900,
        });
      },
      forceLowFpsForTest: () => {
        // Forty deterministic 50 ms samples model two uninterrupted seconds
        // at 44 FPS without changing simulation or collision scheduling.
        for (let index = 0; index < 40; index += 1) this.adjustQuality(44, 50);
      },
      expireRoundForTest: () => {
        if (isTerminalBattleState(this.session.state)) return;
        // Use the same clock and transition entry as a naturally elapsed
        // round; the next scene update then runs the normal result dispatch.
        this.session.advanceTime(this.session.remainingMs);
      },
      overloadForTest: () => {
        if (isTerminalBattleState(this.session.state)) return;
        let nowMs = this.session.elapsedMs;
        while (this.session.lives > 0 && !isTerminalBattleState(this.session.state)) {
          nowMs += PLAYER_INVULNERABLE_MS + 1;
          this.session.takePlayerHit(nowMs);
        }
      },
      snapshot: () => this.session.snapshot(),
      visualSnapshot: () => this.noxcat.visualSnapshot(),
      qualitySnapshot: () => ({
        level: this.performanceQuality.level,
        consecutiveLowFpsMs: this.performanceQuality.consecutiveLowFpsMs,
        ghostLimit: this.noxcat.visualSnapshot().ghostLimit,
        dropletLimit: this.noxcat.visualSnapshot().dropletLimit,
        projectileEffectsReduced: this.projectiles.isVisualQualityReduced,
        actualFps: this.game.loop.actualFps,
        simulationUpdateCount: this.simulationUpdateCount,
        collisionUpdateCount: this.collisionUpdateCount,
      }),
      waveSnapshot: () => {
        const activeProjectiles = this.projectiles.activeProjectiles();
        const activeBeams = this.projectiles.activeBeams();
        return {
          phase: this.director.currentPhase,
          pattern: this.director.currentPattern,
          activeProjectileCount: activeProjectiles.length,
          activeDangerous: activeProjectiles.filter((projectile) => (
            projectile.isDamage && !projectile.friendly
          )).length + activeBeams.filter((beam) => beam.telegraphMs <= 0 && beam.activeMs > 0).length,
          safeLane: this.director.currentSafeLane ?? null,
          safeSpot: this.director.currentSafeSpot ?? null,
          dangerZones: this.director.currentDangerZones,
          combatTimeScale: this.combatTimeScale,
          vulnerableRemainingMs: this.vulnerableRemainingMs,
          stateMessage: this.hud.stateMessage,
          weakPointTweenCount: this.boss.weakPointTweenCount,
          dangerOverlayAlpha: this.waveGuide.alpha,
          pacing: this.currentPacing,
        };
      },
      projectileSnapshot: () => this.projectiles.activeProjectiles().map((projectile) => ({
        x: projectile.x,
        y: projectile.y,
        visibleX: projectile.visibleCenterX,
        visibleY: projectile.visibleCenterY,
        previousCollisionX: projectile.previousX,
        previousCollisionY: projectile.previousY,
        previousCollisionActive: projectile.previousCollisionActive,
        radius: projectile.radius,
        effectiveCollisionRadius: projectile.effectiveCollisionRadius,
        isDamage: projectile.isDamage,
        hasGrazedPlayer: projectile.hasGrazedPlayer,
        kind: projectile.kind,
        tunnelDepth: projectile.tunnelDepth,
        collisionActive: projectile.collisionActive,
        vx: projectile.vx,
        vy: projectile.vy,
        yawOffset: projectile.yawOffset,
        perspectiveYaw: projectile.perspectiveYaw,
        screenRoll: projectile.screenRoll,
        continuingOffscreen: projectile.isContinuingOffscreen,
      })),
      viewportSnapshot: () => ({ ...this.viewportLayout }),
      inputSnapshot: () => ({ ...this.lastInputSample }),
      cameraSnapshot: () => ({
        zoomX: this.cameras.main.zoomX,
        zoomY: this.cameras.main.zoomY,
        scrollX: this.cameras.main.scrollX,
        scrollY: this.cameras.main.scrollY,
        worldLeft: this.cameras.main.worldView.left,
        worldTop: this.cameras.main.worldView.top,
        worldWidth: this.cameras.main.worldView.width,
        worldHeight: this.cameras.main.worldView.height,
      }),
      bossDefeatSnapshot: () => ({
        state: this.boss.defeatAnimationState,
        fragmentCount: this.boss.activeDefeatFragments,
      }),
    };
    window.__NOXCAT_TEST__ = this.testHook;
  }

  private forceMajorHit(): void {
    if (isTerminalBattleState(this.session.state)) return;
    if (this.session.state === BattleState.DODGING) {
      this.session.setEnergyForDebug(100);
      this.openVulnerability();
    }
    if (this.session.state === BattleState.VULNERABLE) this.session.beginAim();
    if (this.session.state === BattleState.AIMING) this.session.releaseAim(AIM_MIN_PULL + 1);
    if (this.session.state === BattleState.LAUNCHED) {
      this.resolveMajorHit();
      // The debug hook keeps automated runs deterministic even when a headless
      // WebKit page heavily throttles animation frames.
      if (this.session.snapshot().state === BattleState.STAGGERED && this.session.endStagger()) {
        this.boss.setWeakPointVisible(false);
        this.director.resume(true);
        this.hud.setStateMessage('');
      }
    }
  }

  private finishBattle(): void {
    if (this.ended) return;
    this.ended = true;
    this.hitReliefTimer?.remove(false);
    this.hitReliefTimer = undefined;
    this.clearVulnerabilityWindow();
    this.setCombatTimeScale(1);
    this.director.pause();
    this.projectiles.clearDangerous(true);
    this.hideDangerZones();
    this.hud.clearFlash();
    this.boss.setWeakPointVisible(false);
    const won = this.session.state === BattleState.WON;
    this.audio.stopMusic();
    this.audio.play(won ? 'bossDefeat' : 'lose');
    this.hud.setStateMessage(won ? 'BOSS DEFEATED' : 'NOXCAT OVERLOADED');
    if (won) this.boss.playDefeatCollapse();
    const snapshot = this.session.snapshot();
    const detail: BattleResultDetail = {
      won,
      bossName: getBattleRuntime().boss.bossName,
      resultLine: getBattleRuntime().boss.resultLine,
      source: getBattleRuntime().source,
      grade: calculateGrade(snapshot, won),
      snapshot
    };
    const resultDelay = won
      ? BOSS_DEFEAT_DURATION_MS
      : import.meta.env.DEV && window.__NOXCAT_TEST__ ? 100 : 900;
    this.time.delayedCall(resultDelay, () => window.dispatchEvent(new CustomEvent<BattleResultDetail>('noxcat:battle-result', { detail })));
  }

  private syncMusicToBattleState(): void {
    const modes = {
      [BattleState.INTRO]: 'intro',
      [BattleState.DODGING]: 'dodge',
      [BattleState.VULNERABLE]: 'vulnerable',
      [BattleState.AIMING]: 'aiming',
      [BattleState.LAUNCHED]: 'launched',
      [BattleState.STAGGERED]: 'staggered',
    } as const;
    if (this.session.state === BattleState.WON || this.session.state === BattleState.LOST) return;
    this.audio.setMusicMode(modes[this.session.state]);
  }

  private cleanup(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleViewportResize);
    const pauseHandler = this.registry.get('pauseHandler') as EventListener | undefined;
    if (pauseHandler) {
      document.removeEventListener('visibilitychange', pauseHandler);
      window.removeEventListener('resize', pauseHandler);
      window.removeEventListener('orientationchange', pauseHandler);
      this.touchLandscapeQuery?.removeEventListener('change', pauseHandler);
    }
    this.touchLandscapeQuery = undefined;
    this.pauseResumeTimer?.remove(false);
    this.hitReliefTimer?.remove(false);
    this.chatterTimer?.remove(false);
    this.clearVulnerabilityWindow();
    this.projectiles?.destroy();
    this.glassShatter?.destroy();
    this.audio?.close();
    if (import.meta.env.DEV && this.testHook && window.__NOXCAT_TEST__ === this.testHook) {
      delete window.__NOXCAT_TEST__;
    }
    this.testHook = undefined;
  }
}

function calculateGrade(snapshot: GameSessionSnapshot, won: boolean): 'S' | 'A' | 'B' | 'C' {
  if (!won) return snapshot.mainAttackHits >= 2 ? 'B' : 'C';
  const seconds = snapshot.elapsedMs / 1000;
  const score = 100 - seconds * 0.65 + snapshot.grazeCount * 1.8 + snapshot.reflectCount * 4 + snapshot.lives * 6;
  if (score >= 102) return 'S';
  if (score >= 82) return 'A';
  if (score >= 62) return 'B';
  return 'C';
}

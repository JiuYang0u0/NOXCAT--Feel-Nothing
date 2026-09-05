import type Phaser from 'phaser';
import type { AttackStep, PatternId } from '../../ai/bossSchema';
import { SeededRng } from '../../utils/rng';
import { shuffleAttackRound } from '../attackSequence';
import type { Noxcat } from '../entities/Noxcat';
import {
  CLOSING_WALL_SAFE_GAP_HALF_HEIGHT,
  runClosingWalls,
} from '../patterns/closingWalls';
import {
  commentCrossfireLayout,
  runCommentCrossfire,
} from '../patterns/commentCrossfire';
import { planDeadlineBeams, runDeadlineBeam, type BeamLayout } from '../patterns/deadlineBeam';
import {
  PAPER_SAFE_LANE_HALF_WIDTH,
  runPaperRain,
} from '../patterns/paperRain';
import {
  RETURNABLE_SAFE_LANE_HALF_WIDTH,
  RETURNABLE_RECOVERY_MS,
  runRecoveryReturnables,
  runReturnableBurst,
} from '../patterns/returnableBurst';
import { runRevisionHoming } from '../patterns/revisionHoming';
import {
  TOP_DOWNPOUR_SAFE_LANE_HALF_WIDTH,
  runTopDownpour,
} from '../patterns/topDownpour';
import {
  PULSE_BARRAGE_SAFE_LANE_HALF_WIDTH,
  runPulseBarrage,
} from '../patterns/pulseBarrage';
import {
  ALTERNATING_ZIPPER_SAFE_LANE_HALF_WIDTH,
  runAlternatingZipper,
} from '../patterns/alternatingZipper';
import {
  clamp,
  clampPlayerPosition,
  reachableLane,
  reachableSafeSpot,
  type PlayerPosition,
} from '../patterns/fairness';
import type {
  AttackPatternContext,
  AttackPatternHandle,
} from '../patterns/types';
import type { PacingScale } from './PacingDirector';
import type { ProjectileSystem } from './ProjectileSystem';
import {
  dangerZonesForPattern,
  type DangerZoneHint,
  type SafeLaneHint,
  type SafeSpotHint,
} from './DangerTelegraph';

export type WavePhase = 'TELEGRAPH' | 'ACTIVE' | 'RECOVERY';

export type { DangerZoneHint, SafeLaneHint } from './DangerTelegraph';

export const ATTACK_TELEGRAPH_MS: Readonly<Record<PatternId, number>> = {
  paper_rain: 500,
  comment_crossfire: 550,
  deadline_beam: 750,
  closing_walls: 650,
  revision_homing: 650,
  returnable_burst: 550,
  top_downpour: 650,
  pulse_barrage: 650,
  alternating_zipper: 600,
};

export const ATTACK_RECOVERY_MS: Readonly<Record<PatternId, number>> = {
  paper_rain: 360,
  comment_crossfire: 400,
  deadline_beam: 420,
  closing_walls: 500,
  revision_homing: 440,
  returnable_burst: 380,
  top_downpour: 400,
  pulse_barrage: 460,
  alternating_zipper: 420,
};

/**
 * Prevents a failed/instantly-cleared spawn from flashing straight through
 * ACTIVE. Normal waves stay active until their final hostile leaves; the
 * returnable wave additionally preserves its authored interaction beat.
 */
export const ATTACK_MIN_ACTIVE_MS: Readonly<Record<PatternId, number>> = {
  paper_rain: 1_200,
  comment_crossfire: 1_100,
  deadline_beam: 520,
  closing_walls: 1_400,
  revision_homing: 1_500,
  returnable_burst: 2_140,
  top_downpour: 1_300,
  pulse_barrage: 2_400,
  alternating_zipper: 2_800,
};

// 加速有下限，保留可辨識節拍、追蹤停止時間與反彈操作窗。
const ATTACK_ACTIVE_FLOOR_MS: Readonly<Record<PatternId, number>> = {
  paper_rain: 2_800, top_downpour: 2_600, pulse_barrage: 3_100,
  alternating_zipper: 3_200, comment_crossfire: 1_900, closing_walls: 2_600,
  revision_homing: 3_500, returnable_burst: 4_000, deadline_beam: 2_700,
};

export interface AttackDirectorHooks {
  scene: Phaser.Scene;
  player: Noxcat;
  onPatternChanged?: (pattern: PatternId) => void;
  onReturnableTutorial?: () => void;
  onReturnableWindow?: () => void;
  onDangerZonesChanged?: (zones: readonly DangerZoneHint[]) => void;
  onWavePhaseChanged?: (
    phase: WavePhase,
    pattern: PatternId,
    volley: number,
    safeLane?: SafeLaneHint,
    dangerZones?: readonly DangerZoneHint[],
  ) => void;
  getPlayerPosition?: () => PlayerPosition;
}

export interface AttackSequenceConfig {
  readonly attacks: readonly AttackStep[];
  readonly shuffleSeed?: number;
  readonly commentLines?: readonly string[];
}

export class AttackDirector {
  private stepIndex = 0;
  private roundAttacks: readonly AttackStep[];
  private readonly orderRng?: SeededRng;
  private phaseElapsedMs = 0;
  private wavePhase: WavePhase = 'TELEGRAPH';
  private volley = 0;
  private running = false;
  private returnableTutorialShown = false;
  private paperSafeLane = 270;
  private commentLayout?: ReturnType<typeof commentCrossfireLayout>;
  private returnableSafeLane = 270;
  private topDownpourSafeLane = 270;
  private pulseBarrageSafeLane = 270;
  private alternatingZipperSafeLane = 270;
  private wallSafeGap = 650;
  private deadlineBeams: readonly BeamLayout[] = [];
  private deadlineSafeSpot?: SafeSpotHint;
  private activePattern?: AttackPatternHandle;
  private recoveryPattern?: AttackPatternHandle;
  private pacing: PacingScale | null = null;

  constructor(
    private readonly dna: AttackSequenceConfig,
    private readonly rng: SeededRng,
    private readonly projectiles: ProjectileSystem,
    private readonly hooks: AttackDirectorHooks = {} as AttackDirectorHooks,
  ) {
    // 選招與彈幕布局各用獨立 RNG，避免玩家移動或布局抽樣影響下一輪順序。
    this.orderRng = dna.shuffleSeed === undefined ? undefined : new SeededRng(dna.shuffleSeed);
    this.roundAttacks = this.orderRng
      ? shuffleAttackRound(dna.attacks, this.orderRng)
      : dna.attacks;
  }

  get currentPattern(): PatternId {
    return this.roundAttacks[this.stepIndex]?.pattern ?? 'paper_rain';
  }

  get currentPhase(): WavePhase {
    return this.wavePhase;
  }

  get currentSafeLane(): SafeLaneHint | undefined {
    switch (this.currentPattern) {
      case 'paper_rain':
        return {
          axis: 'vertical',
          center: this.paperSafeLane,
          halfWidth: PAPER_SAFE_LANE_HALF_WIDTH,
          projection: 'screen',
        };

      case 'closing_walls':
        return { axis: 'horizontal', center: this.wallSafeGap, halfWidth: CLOSING_WALL_SAFE_GAP_HALF_HEIGHT, projection: 'screen' };
      case 'returnable_burst':
        return { axis: 'vertical', center: this.returnableSafeLane, halfWidth: RETURNABLE_SAFE_LANE_HALF_WIDTH, projection: 'screen' };
      case 'top_downpour':
        return {
          axis: 'vertical',
          center: this.topDownpourSafeLane,
          halfWidth: TOP_DOWNPOUR_SAFE_LANE_HALF_WIDTH,
          projection: 'screen',
        };
      case 'pulse_barrage':
        return {
          axis: 'vertical',
          center: this.pulseBarrageSafeLane,
          halfWidth: PULSE_BARRAGE_SAFE_LANE_HALF_WIDTH,
          projection: 'screen',
        };
      case 'alternating_zipper':
        return { axis: 'vertical', center: this.alternatingZipperSafeLane, halfWidth: ALTERNATING_ZIPPER_SAFE_LANE_HALF_WIDTH, projection: 'screen' };
      default:
        return undefined;
    }
  }

  get currentSafeSpot(): SafeSpotHint | undefined {
    if (this.currentPattern === 'deadline_beam') return this.deadlineSafeSpot;
    return this.currentPattern === 'comment_crossfire' ? this.commentLayout?.safeSpot : undefined;
  }

  get currentDangerZones(): readonly DangerZoneHint[] {
    const zones = dangerZonesForPattern(
      this.currentPattern,
      this.currentSafeLane,
      this.playerPosition(),
      this.deadlineBeams,
    );
    if (this.currentPattern === 'comment_crossfire' && this.commentLayout) {
      zones.push(...this.commentLayout.rays.map((ray) => ray.warning), this.commentLayout.safeSpot);
    }
    if (this.currentPattern === 'deadline_beam' && this.deadlineSafeSpot) zones.push(this.deadlineSafeSpot);
    return zones;
  }

  start(): void {
    this.cancelPatternTimeline();
    this.running = true;
    this.beginStep();
  }

  pause(): void {
    this.running = false;
  }

  resume(nextPattern = false): void {
    if (nextPattern) this.advanceStep();
    this.running = true;
  }

  cancelCurrent(): void {
    this.running = false;
    this.cancelPatternTimeline();
    this.projectiles.clearDangerous(true);
  }

  setPacingScale(scale: PacingScale | null): void {
    this.pacing = scale;
  }

  get pacingScale(): PacingScale | null {
    return this.pacing;
  }

  update(deltaMs: number, playerLives: number): void {
    if (!this.running || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
    let remainingMs = deltaMs;
    // BattleScene normally supplies <=50 ms. The loop also keeps phase timing
    // deterministic if a test or recovering browser supplies one long frame.
    while (remainingMs > 0 && this.running) {
      const step = this.roundAttacks[this.stepIndex];
      if (!step) return;
      if (this.canEnterEarlyRecovery(step.pattern)) {
        this.advanceWavePhase(step.pattern, step.intensity, playerLives);
        continue;
      }
      const phaseAtFrameStart = this.wavePhase;
      const phaseRemainingMs = Math.max(
        0,
        this.phaseDuration(step.pattern, step.durationMs, this.wavePhase) - this.phaseElapsedMs,
      );
      const minActiveRemainingMs = this.wavePhase === 'ACTIVE'
        ? Math.max(0, this.minActiveMs(step.pattern) - this.phaseElapsedMs)
        : Number.POSITIVE_INFINITY;
      const advanceMs = Math.min(
        remainingMs,
        phaseRemainingMs,
        minActiveRemainingMs > 0 ? minActiveRemainingMs : Number.POSITIVE_INFINITY,
      );
      this.phaseElapsedMs += advanceMs;
      remainingMs -= advanceMs;
      if (phaseAtFrameStart === 'ACTIVE') this.activePattern?.update(advanceMs);
      if (phaseAtFrameStart === 'RECOVERY') this.recoveryPattern?.update(advanceMs);

      if (this.phaseElapsedMs >= this.phaseDuration(step.pattern, step.durationMs, this.wavePhase)) {
        this.advanceWavePhase(step.pattern, step.intensity, playerLives);
        continue;
      }
      if (this.canEnterEarlyRecovery(step.pattern)) {
        this.advanceWavePhase(step.pattern, step.intensity, playerLives);
        continue;
      }
      // All durations are positive; this is defensive against a future bad
      // timing table causing a zero-progress loop.
      if (advanceMs <= 0) return;
    }
  }

  private beginStep(): void {
    this.phaseElapsedMs = 0;
    this.wavePhase = 'TELEGRAPH';
    const player = this.playerPosition();
    if (this.currentPattern === 'paper_rain') {
      this.paperSafeLane = reachableLane(this.rng, 'x', player, PAPER_SAFE_LANE_HALF_WIDTH);
    } else if (this.currentPattern === 'comment_crossfire') {
      // 隨機組合在預警開始時決定，發射時沿用，避免箭頭與實際方向不符。
      this.commentLayout = commentCrossfireLayout(this.rng, this.roundAttacks[this.stepIndex]!.intensity, player);
    } else if (this.currentPattern === 'closing_walls') {
      this.wallSafeGap = reachableLane(this.rng, 'y', player, CLOSING_WALL_SAFE_GAP_HALF_HEIGHT);
    } else if (this.currentPattern === 'returnable_burst') {
      this.returnableSafeLane = clamp(player?.x ?? this.rng.range(150, 390), 70, 470);
    } else if (this.currentPattern === 'top_downpour') {
      this.topDownpourSafeLane = reachableLane(this.rng, 'x', player, TOP_DOWNPOUR_SAFE_LANE_HALF_WIDTH);
    } else if (this.currentPattern === 'pulse_barrage') {
      this.pulseBarrageSafeLane = reachableLane(this.rng, 'x', player, PULSE_BARRAGE_SAFE_LANE_HALF_WIDTH);
    } else if (this.currentPattern === 'alternating_zipper') {
      this.alternatingZipperSafeLane = reachableLane(this.rng, 'x', player, ALTERNATING_ZIPPER_SAFE_LANE_HALF_WIDTH);
    } else if (this.currentPattern === 'deadline_beam') {
      this.deadlineSafeSpot = reachableSafeSpot(this.rng, player);
      this.deadlineBeams = planDeadlineBeams(
        this.rng,
        this.roundAttacks[this.stepIndex]?.intensity ?? 1,
        this.deadlineSafeSpot,
      );
    }
    this.hooks.onPatternChanged?.(this.currentPattern);
    this.hooks.onWavePhaseChanged?.(
      this.wavePhase,
      this.currentPattern,
      this.volley,
      this.currentSafeLane,
      this.currentDangerZones,
    );
  }

  private advanceStep(): void {
    if (this.recoveryPattern) this.projectiles.releaseDangerousForExit();
    this.cancelPatternTimeline();
    const previousPattern = this.currentPattern;
    this.stepIndex += 1;
    if (this.stepIndex >= this.roundAttacks.length) {
      this.roundAttacks = this.orderRng
        ? shuffleAttackRound(this.dna.attacks, this.orderRng, previousPattern)
        : this.dna.attacks;
      this.stepIndex = 0;
    }
    this.beginStep();
  }

  private phaseDuration(pattern: PatternId, stepDurationMs: number, phase: WavePhase): number {
    const telegraph = ATTACK_TELEGRAPH_MS[pattern];
    const recovery = ATTACK_RECOVERY_MS[pattern];
    const isBeam = pattern === 'deadline_beam';
    const telegraphScale = isBeam ? 1 : (this.pacing?.telegraphScale ?? 1);
    const recoveryScale = isBeam ? 1 : (this.pacing?.recoveryScale ?? 1);
    // 回收波的 RECOVERY 固定為 RETURNABLE_RECOVERY_MS，ACTIVE 的預算必須扣掉
    // 同一個值，否則每個回收波都會超出 AttackStep.durationMs 約 1.9 秒。
    const scaledRecovery = this.hasRecoveryReturnables(pattern)
      ? RETURNABLE_RECOVERY_MS
      : Math.max(1, Math.round(recovery * recoveryScale));
    if (phase === 'TELEGRAPH') return Math.max(500, Math.round(telegraph * telegraphScale));
    if (phase === 'RECOVERY') return scaledRecovery;
    const scaledTelegraph = Math.max(500, Math.round(telegraph * telegraphScale));
    const activeBudget = Math.max(1, Math.round(stepDurationMs - scaledTelegraph - scaledRecovery));
    const cadence = isBeam ? 1 : (this.pacing?.speedScale ?? 1);
    // 最後一命會再減速 13%，尾張文件仍需完整走完接近路徑。
    const slowestClock = isBeam ? 1 : Math.min(1, (this.pacing?.speedScale ?? 1) * 0.87);
    return Math.max(
      this.minActiveMs(pattern), Math.ceil(ATTACK_ACTIVE_FLOOR_MS[pattern] / slowestClock),
      Math.round(activeBudget / Math.max(1, cadence)),
    );
  }

  private advanceWavePhase(
    pattern: PatternId,
    intensity: 1 | 2 | 3,
    playerLives: number,
  ): void {
    this.phaseElapsedMs = 0;
    if (this.wavePhase === 'TELEGRAPH') {
      this.wavePhase = 'ACTIVE';
      const baseLifeScale = playerLives <= 1 ? 0.87 : 1;
      const pacingSpeed = this.pacing?.speedScale ?? 1;
      const speedScale = baseLifeScale * pacingSpeed;
      this.activePattern = this.startPattern(pattern, intensity, speedScale);
      this.volley += 1;
    } else if (this.wavePhase === 'ACTIVE') {
      this.wavePhase = 'RECOVERY';
      this.cancelPatternTimeline();
      // Stop gameplay ownership, but let each card preserve its perspective
      // momentum and leave beyond the viewport on its own. Emergency clears
      // (hit / vulnerability / cancellation) still use the explicit fade.
      this.projectiles.releaseDangerousForExit();
      if (this.hasRecoveryReturnables(pattern)) {
        this.recoveryPattern = runRecoveryReturnables({
          rng: this.rng,
          projectiles: this.projectiles,
          waveIndex: this.volley,
          player: this.playerPosition() ?? { x: 270, y: 700 },
        }, () => this.hooks.onReturnableWindow?.());
      }
    } else {
      this.advanceStep();
      return;
    }
    this.hooks.onWavePhaseChanged?.(
      this.wavePhase,
      pattern,
      this.volley,
      this.currentSafeLane,
      this.currentDangerZones,
    );
  }

  private startPattern(
    pattern: PatternId,
    intensity: 1 | 2 | 3,
    speedScale: number,
  ): AttackPatternHandle {
    const step = this.roundAttacks[this.stepIndex];
    const context: AttackPatternContext = {
      scene: this.hooks.scene,
      rng: this.rng,
      intensity,
      durationMs: this.phaseDuration(pattern, step?.durationMs ?? 4_500, 'ACTIVE'),
      player: this.hooks.player,
      projectiles: this.projectiles,
      speedScale,
      waveIndex: this.volley,
      commentLines: this.dna.commentLines,
    };
    switch (pattern) {
      case 'paper_rain': {
        return runPaperRain(
          context,
          this.paperSafeLane,
        );
      }
      case 'comment_crossfire':
        return runCommentCrossfire(context, this.commentLayout);
      case 'deadline_beam':
        return runDeadlineBeam(context, this.deadlineBeams, this.deadlineSafeSpot);
      case 'closing_walls': {
        return runClosingWalls(
          context,
          this.wallSafeGap,
          (safeGapY) => {
            this.wallSafeGap = safeGapY;
            this.hooks.onDangerZonesChanged?.(this.currentDangerZones);
          },
        );
      }
      case 'revision_homing':
        return runRevisionHoming(context);
      case 'returnable_burst': {
        return runReturnableBurst(
          context,
          this.returnableSafeLane,
          () => {
            this.hooks.onReturnableWindow?.();
            if (this.returnableTutorialShown) return;
            this.returnableTutorialShown = true;
            this.hooks.onReturnableTutorial?.();
          },
        );
      }
      case 'top_downpour':
        return runTopDownpour(context, this.topDownpourSafeLane);
      case 'pulse_barrage':
        return runPulseBarrage(context, this.pulseBarrageSafeLane);
      case 'alternating_zipper':
        return runAlternatingZipper(context, this.alternatingZipperSafeLane);
    }
  }

  private cancelPatternTimeline(): void {
    this.activePattern?.cancel();
    this.activePattern = undefined;
    this.recoveryPattern?.cancel();
    this.recoveryPattern = undefined;
  }

  private hasRecoveryReturnables(pattern: PatternId): boolean {
    return pattern !== 'returnable_burst' && this.volley > 0 && this.volley % 2 === 0;
  }

  private minActiveMs(pattern: PatternId): number {
    const speed = this.pacing?.speedScale ?? 1;
    return Math.max(1, Math.round(ATTACK_MIN_ACTIVE_MS[pattern] / Math.max(1, speed)));
  }

  private canEnterEarlyRecovery(pattern: PatternId): boolean {
    if (this.wavePhase !== 'ACTIVE'
      || this.phaseElapsedMs < this.minActiveMs(pattern)
      || !this.activePattern?.finished) {
      return false;
    }
    const hostileProjectile = this.projectiles.activeProjectiles().some((projectile) => (
      projectile.isDamage && !projectile.friendly
    ));
    // A warning beam is still a scheduled threat even before its damaging
    // segment begins, so retain the wave until the beam object is exhausted.
    const hostileBeam = this.projectiles.activeBeams().some((beam) => (
      beam.telegraphMs > 0 || beam.activeMs > 0
    ));
    return !hostileProjectile && !hostileBeam;
  }

  private playerPosition(): PlayerPosition | undefined {
    let position: PlayerPosition | undefined;
    try {
      position = this.hooks.getPlayerPosition?.();
    } catch {
      // A presentation hook must never be able to stop deterministic attacks.
    }
    const livePlayer = this.hooks.player;
    return clampPlayerPosition(position ?? (livePlayer ? {
      x: livePlayer.x,
      y: livePlayer.y,
    } : undefined));
  }
}

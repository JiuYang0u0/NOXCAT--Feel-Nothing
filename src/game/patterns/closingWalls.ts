import type { SeededRng } from '../../utils/rng';
import { PLAYER_HIT_RADIUS, PLAYER_MIN_Y, PLAYER_MAX_Y } from '../constants';
import type { ProjectileConfig } from '../entities/Projectile';
import type { ProjectileSystem } from '../systems/ProjectileSystem';
import {
  clamp,
  LEFT_WARNING_X,
  RIGHT_WARNING_X,
  SIDE_ATTACK_ORIGIN_LEFT_X,
  SIDE_ATTACK_ORIGIN_RIGHT_X,
} from './fairness';
import {
  createPatternTimeline,
  spawnConfigs,
  type AttackPatternContext,
  type AttackPatternHandle,
  type AttackIntensity,
} from './types';

export const CLOSING_WALL_SAFE_GAP_HALF_HEIGHT = 68;
const WALL_PROJECTILE_RADIUS = 27;
const WALL_EXCLUSION_FROM_GAP = CLOSING_WALL_SAFE_GAP_HALF_HEIGHT
  + WALL_PROJECTILE_RADIUS
  + PLAYER_HIT_RADIUS
  + 30;
// 一列文件能打到的玩家中心範圍（文件半徑 + 玩家碰撞半徑）。
const WALL_REACH_MARGIN = WALL_PROJECTILE_RADIUS + PLAYER_HIT_RADIUS;
const WALL_CLEARANCE_JITTER = 4;
// 相鄰兩列的間距；小於兩倍 WALL_REACH_MARGIN，確保外推時覆蓋連續不留縫。
const WALL_LAYER_SPACING = 58;
// 覆蓋到移動區邊緣通常只要 1~3 列；上限純粹是文件池的保險。
const MAX_WALL_LAYERS = 3;
const WALL_NEAR_LEFT_X = 145;
const WALL_NEAR_RIGHT_X = 395;

/** 整波缺口的位移量。 */
export function closingWallGapTravel(intensity: AttackIntensity): number {
  // 下方移動區較矮，整波只移動其高度的 10%，保留重疊文件之間的通路。
  return Math.min(44 + intensity * 10, (PLAYER_MAX_Y - PLAYER_MIN_Y) * 0.1);
}

export interface ClosingWallsPlan {
  readonly safeGapY: number;
  readonly projectiles: readonly ProjectileConfig[];
}

export interface ClosingWallFormation extends ClosingWallsPlan {
  readonly atMs: number;
}

export interface ClosingWallWavePlan {
  readonly formations: readonly ClosingWallFormation[];
  readonly startGapY: number;
  readonly endGapY: number;
}

export function planClosingWalls(
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  speedScale: number,
  gapY: number,
  gapTravel = 0,
): ClosingWallsPlan {
  const speed = (180 + intensity * 20) * speedScale;
  // 以缺口向外排列，避免縮小移動區後只剩上方文件列。
  // 加上整波位移量，確保舊文件還在場上時也不會穿過新的缺口。
  const clearance = WALL_EXCLUSION_FROM_GAP + gapTravel + rng.range(0, WALL_CLEARANCE_JITTER);
  const projectiles: ProjectileConfig[] = [];
  // 固定層數會在移動區縮短後失準：缺口靠邊時最外側那列之外還留著打不到的
  // 安全口袋，玩家可以整波賴在那裡不穿缺口。改成每側往外補到覆蓋範圍蓋過
  // 移動區邊緣為止，既不留口袋，也不會多發落在區外的文件。
  for (const verticalSide of [-1, 1]) {
    const edgeDistance = Math.abs(
      (verticalSide < 0 ? PLAYER_MIN_Y : PLAYER_MAX_Y) - gapY,
    );
    for (let layer = 0; layer < MAX_WALL_LAYERS; layer += 1) {
      const offset = clearance + layer * WALL_LAYER_SPACING;
      const rowY = gapY + verticalSide * offset;
      for (const fromLeft of [true, false]) {
        projectiles.push({
          kind: 'wall',
          x: fromLeft ? LEFT_WARNING_X : RIGHT_WARNING_X,
          y: rowY,
          vx: fromLeft ? speed : -speed,
          vy: 0,
          radius: WALL_PROJECTILE_RADIUS,
          // 入口和近景落點維持同一高度，接近、啟用碰撞與離場都沿缺口外側橫穿。
          perspectiveOrigin: {
            x: fromLeft ? SIDE_ATTACK_ORIGIN_LEFT_X : SIDE_ATTACK_ORIGIN_RIGHT_X,
            y: rowY,
          },
          perspectiveTarget: {
            x: fromLeft ? WALL_NEAR_LEFT_X : WALL_NEAR_RIGHT_X,
            y: rowY,
          },
          perspectiveDurationMs: Math.max(1_100, Math.round(1_550 / Math.max(0.1, speedScale))),
        });
      }
      if (offset + WALL_REACH_MARGIN >= edgeDistance) break;
    }
  }
  return { safeGapY: gapY, projectiles };
}

export function spawnClosingWalls(
  projectiles: ProjectileSystem,
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  speedScale: number,
  gapY: number,
): void {
  const plan = planClosingWalls(rng, intensity, speedScale, gapY);
  for (const config of plan.projectiles) projectiles.spawn(config);
}

/**
 * Plans several deterministic wall slices instead of one static row. Their
 * opening moves by a small monotonic amount, giving the player a readable
 * route to follow for the complete wave.
 */
export function planClosingWallWave(
  rng: SeededRng,
  intensity: AttackIntensity,
  speedScale: number,
  startGapY: number,
  durationMs: number,
): ClosingWallWavePlan {
  const maximumGapY = PLAYER_MAX_Y - CLOSING_WALL_SAFE_GAP_HALF_HEIGHT;
  const minimumGapY = PLAYER_MIN_Y + CLOSING_WALL_SAFE_GAP_HALF_HEIGHT;
  const clampedStart = clamp(startGapY, minimumGapY, maximumGapY);
  const direction = rng.int(0, 1) === 0 ? -1 : 1;
  const travel = closingWallGapTravel(intensity);
  const endGapY = clamp(clampedStart + direction * travel, minimumGapY, maximumGapY);
  const formationCount = intensity === 1 ? 4 : 5;
  // 減速時也按實際接近時間預留尾段，避免最後一層尚未進場就被收尾。
  const tailMs = Math.max(1_600, Math.round(1_550 / Math.max(0.1, speedScale)) + 50);
  const lastEmissionMs = Math.max(0, durationMs - tailMs);
  const formations = Array.from({ length: formationCount }, (_, index) => {
    const progress = formationCount <= 1 ? 1 : index / (formationCount - 1);
    const easedProgress = progress * progress * (3 - 2 * progress);
    const safeGapY = clampedStart + (endGapY - clampedStart) * easedProgress;
    return {
      ...planClosingWalls(rng, intensity, speedScale, safeGapY, Math.abs(endGapY - clampedStart)),
      atMs: Math.round(lastEmissionMs * progress),
    };
  });
  return { formations, startGapY: clampedStart, endGapY };
}

export function runClosingWalls(
  context: AttackPatternContext,
  startGapY: number,
  onGapMoved?: (safeGapY: number) => void,
): AttackPatternHandle {
  const wave = planClosingWallWave(
    context.rng,
    context.intensity,
    context.speedScale,
    startGapY,
    context.durationMs,
  );
  const timeline = createPatternTimeline(
    context.durationMs,
    wave.formations.map((formation) => ({
      atMs: formation.atMs,
      emit: () => {
        spawnConfigs(context.projectiles, formation.projectiles);
      },
    })),
  );
  let elapsedMs = 0;
  let lastReportedGapY = wave.startGapY;
  onGapMoved?.(wave.startGapY);
  return {
    get cancelled() { return timeline.cancelled; },
    get finished() { return timeline.finished; },
    update(deltaMs) {
      if (timeline.cancelled || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
      elapsedMs += deltaMs;
      const progress = clamp(elapsedMs / Math.max(1, wave.formations.at(-1)!.atMs), 0, 1);
      const eased = progress * progress * (3 - 2 * progress);
      // 整波位移量已列入文件避讓距離；提示可連續移動，不隨發射批次跳格。
      // 缺口停住後（含 timeline 結束）不再回報，省下每幀重建 Graphics 的成本。
      const gapY = wave.startGapY + (wave.endGapY - wave.startGapY) * eased;
      if (Math.abs(gapY - lastReportedGapY) > 0.01) {
        lastReportedGapY = gapY;
        onGapMoved?.(gapY);
      }
      timeline.update(deltaMs);
    },
    cancel() { timeline.cancel(); },
  };
}

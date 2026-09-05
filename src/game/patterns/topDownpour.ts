import type { SeededRng } from '../../utils/rng';
import { PLAYER_HIT_RADIUS } from '../constants';
import type { ProjectileConfig } from '../entities/Projectile';
import {
  FALLING_ATTACK_MAX_X,
  FALLING_ATTACK_MIN_X,
  FALLING_ATTACK_ORIGIN_Y,
  clamp,
  evenlySpaced,
  randomSignedYawOffset,
} from './fairness';
import {
  createPatternTimeline,
  fitEmissionTimes,
  staggeredSpawnEvents,
  type AttackPatternContext,
  type AttackPatternHandle,
} from './types';

export const TOP_DOWNPOUR_SAFE_LANE_HALF_WIDTH = 76;
export const TOP_DOWNPOUR_ORIGIN_Y = FALLING_ATTACK_ORIGIN_Y;
export const TOP_DOWNPOUR_TARGET_Y = 910;
export const TOP_DOWNPOUR_STAGGER_MS = 120;

const PROJECTILE_RADIUS = 18;
const LANE_CLEARANCE = TOP_DOWNPOUR_SAFE_LANE_HALF_WIDTH
  + PLAYER_HIT_RADIUS
  + PROJECTILE_RADIUS
  + 38;

export interface TopDownpourPlan {
  readonly safeLaneX: number;
  readonly projectiles: readonly ProjectileConfig[];
}

/**
 * A screen-top rain curtain. Every document owns a separate portal directly
 * above its final x coordinate, so its complete projected ray is vertical
 * rather than converging on the Boss floor vanishing point.
 */
export function planTopDownpour(
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  speedScale: number,
  safeLaneX: number,
): TopDownpourPlan {
  const clampedLane = clamp(safeLaneX, 90, 450);
  const leftMaximum = clampedLane - LANE_CLEARANCE;
  const rightMinimum = clampedLane + LANE_CLEARANCE;
  const totalCount = 12 + intensity * 2;
  const leftSpan = Math.max(0, leftMaximum - FALLING_ATTACK_MIN_X);
  const rightSpan = Math.max(0, FALLING_ATTACK_MAX_X - rightMinimum);
  const combinedSpan = Math.max(1, leftSpan + rightSpan);
  const leftCount = leftSpan <= 0
    ? 0
    : rightSpan <= 0
      ? totalCount
      : Math.max(1, Math.min(totalCount - 1, Math.round(totalCount * leftSpan / combinedSpan)));
  const rightCount = totalCount - leftCount;
  const leftColumns = evenlySpaced(FALLING_ATTACK_MIN_X, leftMaximum, leftCount);
  const rightColumns = evenlySpaced(rightMinimum, FALLING_ATTACK_MAX_X, rightCount);
  // 左右雨柱交錯落下，讓兩邊的紅色預警在開場就有對應文件。
  const columns: number[] = [];
  for (let index = 0; index < Math.max(leftCount, rightCount); index++) {
    if (leftColumns[index] !== undefined) columns.push(leftColumns[index]!);
    if (rightColumns[index] !== undefined) columns.push(rightColumns[index]!);
  }
  const speed = (250 + intensity * 22) * speedScale;
  const depthClockScale = Math.max(0.1, speedScale);
  const projectiles = columns.map((columnX, index): ProjectileConfig => {
    const leftOfLane = columnX < clampedLane;
    const x = clamp(
      columnX + rng.range(-7, 7),
      leftOfLane ? FALLING_ATTACK_MIN_X : rightMinimum,
      leftOfLane ? leftMaximum : FALLING_ATTACK_MAX_X,
    );
    return {
      kind: 'paper',
      x,
      y: TOP_DOWNPOUR_ORIGIN_Y - 28,
      vx: 0,
      vy: speed,
      radius: PROJECTILE_RADIUS,
      yawOffset: randomSignedYawOffset(rng, 8, 20),
      perspectiveOrigin: { x, y: TOP_DOWNPOUR_ORIGIN_Y },
      perspectiveTarget: { x, y: TOP_DOWNPOUR_TARGET_Y },
      perspectiveDurationMs: Math.max(1_300, Math.round(
        (1_650 + (index % 2) * 180 + rng.range(-25, 25)) / depthClockScale,
      )),
    };
  });

  return { safeLaneX: clampedLane, projectiles };
}

export function runTopDownpour(
  context: AttackPatternContext,
  safeLaneX: number,
): AttackPatternHandle {
  const plan = planTopDownpour(
    context.rng,
    context.intensity,
    context.speedScale,
    safeLaneX,
  );
  const events = staggeredSpawnEvents(context.projectiles, plan.projectiles, TOP_DOWNPOUR_STAGGER_MS);
  const times = fitEmissionTimes(events.map((event) => event.atMs), context.durationMs,
    Math.max(...plan.projectiles.map((config) => config.perspectiveDurationMs!)) + 150);
  return createPatternTimeline(context.durationMs, events.map((event, index) => ({ ...event, atMs: times[index]! })));
}

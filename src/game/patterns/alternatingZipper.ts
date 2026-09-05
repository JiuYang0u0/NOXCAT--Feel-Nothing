import type { SeededRng } from '../../utils/rng';
import { PLAYER_HIT_RADIUS } from '../constants';
import type { ProjectileConfig } from '../entities/Projectile';
import { clamp, randomSignedYawOffset, FALLING_ATTACK_MIN_X, FALLING_ATTACK_MAX_X, FALLING_ATTACK_ORIGIN_Y } from './fairness';
import {
  createPatternTimeline,
  fitEmissionTimes,
  type AttackPatternContext,
  type AttackPatternHandle,
} from './types';

export const ALTERNATING_ZIPPER_SAFE_LANE_HALF_WIDTH = 72;
export const ALTERNATING_ZIPPER_INTERVALS_MS = [620, 560, 500, 440, 380, 340, 300] as const;

const PROJECTILE_RADIUS = 18;
const TARGET_CLEARANCE = ALTERNATING_ZIPPER_SAFE_LANE_HALF_WIDTH
  + PLAYER_HIT_RADIUS
  + PROJECTILE_RADIUS
  + 38;

export interface AlternatingZipperShot {
  readonly atMs: number;
  readonly side: -1 | 1;
  readonly projectile: ProjectileConfig;
}

export interface AlternatingZipperPlan {
  readonly safeLaneX: number;
  readonly shots: readonly AlternatingZipperShot[];
}

/** Left/right single shots accelerate into a zipper while one lane stays open. */
export function planAlternatingZipper(
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  waveIndex: number,
  speedScale: number,
  safeLaneX: number,
): AlternatingZipperPlan {
  const shotCount = 8 + intensity;
  const firstSide: -1 | 1 = waveIndex % 2 === 0 ? -1 : 1;
  const depthClockScale = Math.max(0.1, speedScale);
  let atMs = 0;
  const shots = Array.from({ length: shotCount }, (_, index): AlternatingZipperShot => {
    const side: -1 | 1 = index % 2 === 0 ? firstSide : (firstSide === -1 ? 1 : -1);
    const target = {
      x: clamp(
        safeLaneX + side * (TARGET_CLEARANCE + rng.range(0, 36)),
        FALLING_ATTACK_MIN_X,
        FALLING_ATTACK_MAX_X,
      ),
      y: 910,
    };
    // 左右交替齒列沿通道外側向外斜落，整段路徑都不穿過可站通道。
    const originX = safeLaneX + side * TARGET_CLEARANCE;
    target.x = side < 0 ? Math.min(target.x, originX) : Math.max(target.x, originX);
    const shot = {
      atMs,
      side,
      projectile: {
        kind: 'paper' as const,
        x: originX,
        y: FALLING_ATTACK_ORIGIN_Y,
        vx: side * rng.range(22, 44) * speedScale,
        vy: (285 + intensity * 22) * speedScale,
        radius: PROJECTILE_RADIUS,
        yawOffset: randomSignedYawOffset(rng, 10, 24),
        perspectiveTarget: target,
        perspectiveOrigin: { x: originX, y: FALLING_ATTACK_ORIGIN_Y },
        // 後段同時加快接近速度，讓「越射越快」在畫面上也能讀出來。
        perspectiveDurationMs: Math.max(1_050, Math.round((1_500 - index * 40) / depthClockScale)),
      },
    };
    atMs += ALTERNATING_ZIPPER_INTERVALS_MS[
      Math.min(index, ALTERNATING_ZIPPER_INTERVALS_MS.length - 1)
    ]!;
    return shot;
  });

  return { safeLaneX, shots };
}

export function runAlternatingZipper(
  context: AttackPatternContext,
  safeLaneX: number,
): AttackPatternHandle {
  const plan = planAlternatingZipper(
    context.rng,
    context.intensity,
    context.waveIndex,
    context.speedScale,
    safeLaneX,
  );
  const tailMs = Math.max(...plan.shots.map((shot) => shot.projectile.perspectiveDurationMs ?? 0)) + 200;
  const times = fitEmissionTimes(plan.shots.map((shot) => shot.atMs), context.durationMs, tailMs);
  return createPatternTimeline(
    context.durationMs,
    plan.shots.map((shot, index) => ({
      atMs: times[index]!,
      emit: () => { context.projectiles.spawn(shot.projectile); },
    })),
  );
}

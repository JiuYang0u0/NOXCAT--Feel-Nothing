import type { SeededRng } from '../../utils/rng';
import type { ProjectileConfig } from '../entities/Projectile';
import type { ProjectileSystem } from '../systems/ProjectileSystem';
import { PLAYER_HIT_RADIUS } from '../constants';
import {
  FALLING_ATTACK_MAX_X,
  FALLING_ATTACK_MIN_X,
  FALLING_ATTACK_ORIGIN_Y,
  columnsOutsideLane,
  randomSignedYawOffset,
} from './fairness';
import {
  createPatternTimeline,
  fitEmissionTimes,
  staggeredSpawnEvents,
  type AttackPatternContext,
  type AttackPatternHandle,
} from './types';

// The gameplay collider follows the complete jelly-cat silhouette rather than
// an 18 px centre circle. Reserve enough room for that wide bun-shaped body
// plus the reduced near-plane document surface.
export const PAPER_SAFE_LANE_HALF_WIDTH = 72;
const PAPER_PROJECTILE_RADIUS = 18;
const PAPER_LANE_EXCLUSION = PAPER_SAFE_LANE_HALF_WIDTH
  + PAPER_PROJECTILE_RADIUS
  + PLAYER_HIT_RADIUS
  + 38;

export function planPaperRain(
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  speedScale: number,
  safeLaneCentre: number,
): ProjectileConfig[] {
  // A whole AttackStep is one wave. Keep enough documents in that single
  // formation for graze-based players to charge without continuous spawning.
  const count = 10 + intensity * 2;
  const wideLaneCentres = columnsOutsideLane(safeLaneCentre, PAPER_LANE_EXCLUSION, count);
  const durationBands = [1_650, 1_950, 2_350, 2_750] as const;
  return Array.from({ length: count }, (_, index) => {
    // Build every formation across an overscanned near plane. Pure random
    // x-coordinates occasionally left both screen edges empty, allowing a
    // player to camp there for a complete wave.
    const x = wideLaneCentres[index]!;
    const side = x < safeLaneCentre ? -1 : 1;
    const y = FALLING_ATTACK_ORIGIN_Y - rng.range(0, 28);
    const vy = rng.range(220, 265 + intensity * 38) * speedScale;
    const vx = side * rng.range(4, 30) * speedScale;
    const perspectiveY = 820;
    const perspectiveTime = (perspectiveY - y) / Math.max(1, vy);
    const targetX = Math.min(
      FALLING_ATTACK_MAX_X,
      Math.max(FALLING_ATTACK_MIN_X, x + vx * perspectiveTime),
    );
    return {
      kind: 'paper' as const,
      x,
      y,
      // Drift away from the reserved lane so it remains safe for the volley's
      // whole descent instead of only at the spawn frame.
      vx,
      vy,
      radius: PAPER_PROJECTILE_RADIUS,
      yawOffset: randomSignedYawOffset(rng, 8, 24),
      perspectiveOrigin: { x, y: FALLING_ATTACK_ORIGIN_Y },
      perspectiveTarget: {
        x: targetX,
        y: perspectiveY,
      },
      // Independent deterministic depth clocks combine with timeline staging
      // so cards occupy visibly different near/mid/far planes.
      perspectiveDurationMs: Math.max(1_250, Math.round((durationBands[index % durationBands.length]!
        + rng.range(-45, 45)) / Math.max(0.1, speedScale))),
    };
  });
}

export function spawnPaperRain(
  projectiles: ProjectileSystem,
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  speedScale: number,
  safeLaneCentre: number
): void {
  for (const config of planPaperRain(rng, intensity, speedScale, safeLaneCentre)) {
    projectiles.spawn(config);
  }
}

export function runPaperRain(
  context: AttackPatternContext,
  safeLaneCentre: number,
): AttackPatternHandle {
  const configs = planPaperRain(
    context.rng,
    context.intensity,
    context.speedScale,
    safeLaneCentre,
  );
  const events = staggeredSpawnEvents(context.projectiles, configs, 145);
  const times = fitEmissionTimes(events.map((event) => event.atMs), context.durationMs,
    Math.max(...configs.map((config) => config.perspectiveDurationMs!)) + 150);
  return createPatternTimeline(context.durationMs, events.map((event, index) => ({ ...event, atMs: times[index]! })));
}

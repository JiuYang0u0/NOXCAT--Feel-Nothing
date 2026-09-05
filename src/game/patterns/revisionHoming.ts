import type { SeededRng } from '../../utils/rng';
import type { ProjectileConfig } from '../entities/Projectile';
import type { ProjectileSystem } from '../systems/ProjectileSystem';
import { PLAYER_MAX_Y } from '../constants';
import { calculateTunnelContactDepth } from '../systems/ProjectileDepth';
import { clampPlayerPosition, FALLING_ATTACK_ORIGIN_Y, randomSignedYawOffset, type PlayerPosition } from './fairness';
import {
  createPatternTimeline,
  fitEmissionTimes,
  staggeredSpawnEvents,
  type AttackPatternContext,
  type AttackPatternHandle,
} from './types';

export const REVISION_WARNING_Y = -65;

export function planRevisionHoming(
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  speedScale: number,
  playerPosition?: PlayerPosition,
): ProjectileConfig[] {
  const count = intensity === 3 ? 4 : 3;
  const approachMs = Math.max(2_200, Math.round(2_800 / Math.max(0.1, speedScale)));
  const player = clampPlayerPosition(playerPosition);
  return Array.from({ length: count }, (_, index) => {
    const fromLeft = index % 2 === 0;
    const target = clampPlayerPosition({ x: (player?.x ?? 270) + (fromLeft ? -28 : 28), y: player?.y ?? 760 })!;
    const origin = { x: target.x, y: FALLING_ATTACK_ORIGIN_Y };
    // 以整個可移動範圍內「最早啟用碰撞」的深度計算，不能假設固定 0.8。
    const earliestContact = calculateTunnelContactDepth(origin, { x: origin.x, y: PLAYER_MAX_Y });
    return {
      kind: 'homing' as const,
      x: fromLeft ? 75 : 465,
      // Spawn well above the arena; the old y=405 origin could overlap a
      // player at the legal y=430 movement boundary before any warning.
      y: REVISION_WARNING_Y - index * 54,
      vx: (fromLeft ? 1 : -1) * rng.range(105, 145) * speedScale,
      vy: rng.range(130, 180) * speedScale,
      yawOffset: randomSignedYawOffset(rng, 10, 26),
      // 進入可碰撞深度前至少留 650 ms 固定路線，讓玩家有機會移開。
      // 同一批在共同時刻鎖定，後出的文件不能繼續追到玩家剛閃入的位置。
      homingMs: Math.max(0, Math.min(800 + intensity * 80, approachMs * earliestContact - 650) - index * 280),
      homingOffsetX: fromLeft ? -28 : 28,
      perspectiveTarget: target,
      perspectiveOrigin: origin,
      perspectiveDurationMs: approachMs,
    };
  });
}

export function spawnRevisionHoming(
  projectiles: ProjectileSystem,
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  speedScale: number,
): void {
  for (const config of planRevisionHoming(rng, intensity, speedScale)) {
    projectiles.spawn(config);
  }
}

export function runRevisionHoming(context: AttackPatternContext): AttackPatternHandle {
  const configs = planRevisionHoming(
    context.rng,
    context.intensity,
    context.speedScale,
    context.player,
  );
  const events = staggeredSpawnEvents(context.projectiles, configs, 280);
  const times = fitEmissionTimes(events.map((event) => event.atMs), context.durationMs,
    Math.max(...configs.map((config) => config.perspectiveDurationMs!)) + 100);
  return createPatternTimeline(context.durationMs, events.map((event, index) => ({ ...event, atMs: times[index]! })));
}

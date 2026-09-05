import { describe, expect, it } from 'vitest';
import type Phaser from 'phaser';

import { BossDNASchema, type BossDNA, type PatternId } from '../src/ai/bossSchema';
import { FALLBACK_BOSS } from '../src/ai/fallbackBoss';
import { PLAYER_HIT_RADIUS } from '../src/game/constants';
import type { Noxcat } from '../src/game/entities/Noxcat';
import type { ProjectileConfig } from '../src/game/entities/Projectile';
import {
  ALTERNATING_ZIPPER_INTERVALS_MS,
  ALTERNATING_ZIPPER_SAFE_LANE_HALF_WIDTH,
  planAlternatingZipper,
  runAlternatingZipper,
} from '../src/game/patterns/alternatingZipper';
import {
  PULSE_BARRAGE_GAP_MS,
  PULSE_BARRAGE_SAFE_LANE_HALF_WIDTH,
  planPulseBarrage,
  runPulseBarrage,
} from '../src/game/patterns/pulseBarrage';
import {
  TOP_DOWNPOUR_ORIGIN_Y,
  TOP_DOWNPOUR_SAFE_LANE_HALF_WIDTH,
  TOP_DOWNPOUR_TARGET_Y,
  planTopDownpour,
} from '../src/game/patterns/topDownpour';
import type { AttackPatternContext } from '../src/game/patterns/types';
import {
  ATTACK_TELEGRAPH_MS,
  AttackDirector,
} from '../src/game/systems/AttackDirector';
import {
  createTunnelTrajectory,
  PROJECTILE_CONTACT_DEPTH,
  sampleTunnelProjection,
} from '../src/game/systems/ProjectileDepth';
import { initialProjectileExitVelocity } from '../src/game/systems/ProjectileExitMotion';
import type { ProjectileSystem } from '../src/game/systems/ProjectileSystem';
import { verticalSafeWedgeBoundsAtY } from '../src/game/systems/DangerTelegraph';
import { SeededRng } from '../src/utils/rng';

const NEW_PATTERNS = [
  'top_downpour',
  'pulse_barrage',
  'alternating_zipper',
] as const satisfies readonly PatternId[];

function createRuntime(
  projectiles: ProjectileSystem,
  rng = new SeededRng(91),
  intensity: 1 | 2 | 3 = 3,
): AttackPatternContext {
  const scene: Phaser.Scene = Object.create(null);
  const player: Noxcat = Object.create(null);
  player.x = 270;
  player.y = 720;
  return {
    scene,
    player,
    rng,
    intensity,
    // 原始節奏使用足夠長的波次；最短波次的壓縮另由 attackReadability 驗證。
    durationMs: 6_000,
    projectiles,
    speedScale: 1,
    waveIndex: 0,
  };
}

function trajectoryFor(config: ProjectileConfig) {
  return createTunnelTrajectory(
    { x: config.x, y: config.y },
    { x: config.vx, y: config.vy },
    config.radius ?? 18,
    config.perspectiveTarget,
    config.perspectiveDurationMs,
    config.perspectiveOrigin,
  );
}

function expectOutsidePerspectiveSafeLane(
  config: ProjectileConfig,
  laneX: number,
  halfWidth: number,
): void {
  const trajectory = trajectoryFor(config);
  const radius = config.radius ?? 18;
  const side = trajectory.nearPoint.x < laneX ? -1 : 1;
  for (let index = 0; index <= 20; index += 1) {
    const depth = PROJECTILE_CONTACT_DEPTH
      + (1 - PROJECTILE_CONTACT_DEPTH) * index / 20;
    const authoredPoint = {
      x: trajectory.spawn.x
        + (trajectory.approachPoint.x - trajectory.spawn.x) * depth,
      y: trajectory.spawn.y
        + (trajectory.approachPoint.y - trajectory.spawn.y) * depth,
    };
    const projection = sampleTunnelProjection(trajectory, authoredPoint);
    const wedge = verticalSafeWedgeBoundsAtY(
      { center: laneX, halfWidth },
      projection.position.y,
    );
    const clearance = radius + PLAYER_HIT_RADIUS;
    expect(projection.collisionActive).toBe(true);
    if (side < 0) {
      expect(projection.position.x + clearance).toBeLessThanOrEqual(wedge.left + 1e-7);
    } else {
      expect(projection.position.x - clearance).toBeGreaterThanOrEqual(wedge.right - 1e-7);
    }
  }
}

function expectOutsideScreenSafeLane(
  config: ProjectileConfig,
  laneX: number,
  halfWidth: number,
): void {
  const trajectory = trajectoryFor(config);
  const radius = config.radius ?? 18;
  const clearance = halfWidth + radius + PLAYER_HIT_RADIUS;
  for (let index = 0; index <= 20; index += 1) {
    const depth = PROJECTILE_CONTACT_DEPTH
      + (1 - PROJECTILE_CONTACT_DEPTH) * index / 20;
    const authoredPoint = {
      x: trajectory.spawn.x
        + (trajectory.approachPoint.x - trajectory.spawn.x) * depth,
      y: trajectory.spawn.y
        + (trajectory.approachPoint.y - trajectory.spawn.y) * depth,
    };
    const projection = sampleTunnelProjection(trajectory, authoredPoint);
    expect(projection.collisionActive).toBe(true);
    expect(Math.abs(projection.position.x - laneX)).toBeGreaterThanOrEqual(clearance - 1e-7);
  }
}

describe('new deterministic attack patterns', () => {
  it('admits all three pattern ids through the BossDNA trust boundary', () => {
    for (const pattern of NEW_PATTERNS) {
      const candidate: BossDNA = {
        ...FALLBACK_BOSS,
        attacks: [
          { pattern, intensity: 2, durationMs: 6_000 },
          FALLBACK_BOSS.attacks[1],
          FALLBACK_BOSS.attacks[2],
        ],
      };
      expect(BossDNASchema.safeParse(candidate).success).toBe(true);
    }
  });

  it('builds a seeded screen-top curtain whose complete inbound and exit rays stay vertical', () => {
    const first = planTopDownpour(new SeededRng(23), 3, 1, 270);
    const second = planTopDownpour(new SeededRng(23), 3, 1, 270);
    expect(first).toEqual(second);
    expect(first.projectiles).toHaveLength(18);

    for (const config of first.projectiles) {
      const origin = config.perspectiveOrigin;
      const target = config.perspectiveTarget;
      expect(origin).toEqual({ x: config.x, y: TOP_DOWNPOUR_ORIGIN_Y });
      expect(target).toEqual({ x: config.x, y: TOP_DOWNPOUR_TARGET_Y });
      expect(config.y).toBeLessThan(370);
      expect(config.vx).toBe(0);
      expect(Math.abs(config.x - first.safeLaneX)).toBeGreaterThanOrEqual(
        TOP_DOWNPOUR_SAFE_LANE_HALF_WIDTH
          + PLAYER_HIT_RADIUS
          + (config.radius ?? 18)
          + 4,
      );

      const trajectory = trajectoryFor(config);
      for (const depth of [0, 0.25, 0.5, 0.8, 1]) {
        const projection = sampleTunnelProjection(trajectory, {
          x: trajectory.spawn.x
            + (trajectory.approachPoint.x - trajectory.spawn.x) * depth,
          y: trajectory.spawn.y
            + (trajectory.approachPoint.y - trajectory.spawn.y) * depth,
        });
        expect(projection.position.x).toBeCloseTo(config.x, 10);
      }
      const exit = initialProjectileExitVelocity(trajectory, { x: config.vx, y: config.vy });
      expect(exit.x).toBeCloseTo(0, 10);
      expect(exit.y).toBeGreaterThan(0);
    }
  });

  it('shortens each new pattern\'s perspective clock when pacing raises projectile speed', () => {
    const topNormal = planTopDownpour(new SeededRng(19), 2, 1, 270);
    const topUrgent = planTopDownpour(new SeededRng(19), 2, 1.25, 270);
    const pulseNormal = planPulseBarrage(new SeededRng(19), 2, 1, 270);
    const pulseUrgent = planPulseBarrage(new SeededRng(19), 2, 1.25, 270);
    const zipperNormal = planAlternatingZipper(new SeededRng(19), 2, 0, 1, 270);
    const zipperUrgent = planAlternatingZipper(new SeededRng(19), 2, 0, 1.25, 270);

    expect(topUrgent.projectiles[0]!.perspectiveDurationMs).toBeLessThan(
      topNormal.projectiles[0]!.perspectiveDurationMs!,
    );
    expect(pulseUrgent.formations[0]!.projectiles[0]!.perspectiveDurationMs).toBeLessThan(
      pulseNormal.formations[0]!.projectiles[0]!.perspectiveDurationMs!,
    );
    expect(zipperUrgent.shots[0]!.projectile.perspectiveDurationMs).toBeLessThan(
      zipperNormal.shots[0]!.projectile.perspectiveDurationMs!,
    );
  });

  it('emits simultaneous pulse curtains separated by an exact rest beat', () => {
    const first = planPulseBarrage(new SeededRng(42), 3, 1, 270);
    const second = planPulseBarrage(new SeededRng(42), 3, 1, 270);
    expect(first).toEqual(second);
    expect(first.formations.map(({ atMs }) => atMs)).toEqual([
      0,
      PULSE_BARRAGE_GAP_MS,
      PULSE_BARRAGE_GAP_MS * 2,
      PULSE_BARRAGE_GAP_MS * 3,
    ]);
    for (const formation of first.formations) {
      expect(formation.projectiles).toHaveLength(10);
      expect(new Set(formation.projectiles.map((card) => Math.round(card.x / 12))).size)
        .toBeGreaterThan(3);
      for (const config of formation.projectiles) {
        expect(config.perspectiveOrigin).toEqual({ x: config.x, y: TOP_DOWNPOUR_ORIGIN_Y });
        expect(Math.abs(config.x - 270)).toBeGreaterThan(8);
        expectOutsideScreenSafeLane(
          config,
          first.safeLaneX,
          PULSE_BARRAGE_SAFE_LANE_HALF_WIDTH,
        );
      }
    }

    const spawned: ProjectileConfig[] = [];
    const projectiles = {
      spawn: (config: ProjectileConfig) => {
        spawned.push(config);
        return null;
      },
    } as unknown as ProjectileSystem;
    const handle = runPulseBarrage(createRuntime(projectiles), 270);
    expect(spawned).toHaveLength(10);
    handle.update(PULSE_BARRAGE_GAP_MS - 1);
    expect(spawned).toHaveLength(10);
    handle.update(1);
    expect(spawned).toHaveLength(20);
  });

  it('alternates sides with an accelerando while retaining one projected safe wedge', () => {
    const first = planAlternatingZipper(new SeededRng(77), 3, 2, 1, 270);
    const second = planAlternatingZipper(new SeededRng(77), 3, 2, 1, 270);
    expect(first).toEqual(second);
    expect(first.shots).toHaveLength(11);
    expect(first.shots.map(({ side }) => side)).toEqual([-1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1]);
    const gaps = first.shots.slice(1).map((shot, index) => (
      shot.atMs - first.shots[index]!.atMs
    ));
    expect(gaps).toEqual([...ALTERNATING_ZIPPER_INTERVALS_MS, 300, 300, 300]);
    expect(gaps).toEqual([...gaps].sort((left, right) => right - left));
    for (const shot of first.shots) {
      expectOutsidePerspectiveSafeLane(
        shot.projectile,
        first.safeLaneX,
        ALTERNATING_ZIPPER_SAFE_LANE_HALF_WIDTH,
      );
    }

    const spawned: ProjectileConfig[] = [];
    const projectiles = {
      spawn: (config: ProjectileConfig) => {
        spawned.push(config);
        return null;
      },
    } as unknown as ProjectileSystem;
    const handle = runAlternatingZipper(createRuntime(projectiles), 270);
    expect(spawned).toHaveLength(1);
    handle.update(ALTERNATING_ZIPPER_INTERVALS_MS[0] - 1);
    expect(spawned).toHaveLength(1);
    handle.update(1);
    expect(spawned).toHaveLength(2);
    handle.cancel();
    handle.update(10_000);
    expect(spawned).toHaveLength(2);
  });

  it('keeps every new safe lane clear across seeds, intensities, and edge positions', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      for (const intensity of [1, 2, 3] as const) {
        for (const laneX of [100, 270, 440]) {
          const downpour = planTopDownpour(
            new SeededRng(seed),
            intensity,
            1,
            laneX,
          );
          for (const config of downpour.projectiles) {
            expect(Math.abs(config.x - downpour.safeLaneX)).toBeGreaterThanOrEqual(
              TOP_DOWNPOUR_SAFE_LANE_HALF_WIDTH
                + PLAYER_HIT_RADIUS
                + (config.radius ?? 18)
                + 4,
            );
          }

          const pulse = planPulseBarrage(
            new SeededRng(seed),
            intensity,
            1,
            laneX,
          );
          for (const formation of pulse.formations) {
            for (const config of formation.projectiles) {
              expectOutsideScreenSafeLane(
                config,
                pulse.safeLaneX,
                PULSE_BARRAGE_SAFE_LANE_HALF_WIDTH,
              );
            }
          }

          const zipper = planAlternatingZipper(
            new SeededRng(seed),
            intensity,
            seed,
            1,
            laneX,
          );
          for (const shot of zipper.shots) {
            expectOutsidePerspectiveSafeLane(
              shot.projectile,
              zipper.safeLaneX,
              ALTERNATING_ZIPPER_SAFE_LANE_HALF_WIDTH,
            );
          }
        }
      }
    }
  });

  it.each(NEW_PATTERNS)('routes %s through telegraph and exposes its safe lane in debug snapshots', (pattern) => {
    const spawned: ProjectileConfig[] = [];
    const projectiles = {
      spawn: (config: ProjectileConfig) => {
        spawned.push(config);
        return null;
      },
      activeProjectiles: () => [],
      activeBeams: () => [],
      clearDangerous: () => undefined,
      releaseDangerousForExit: () => undefined,
    } as unknown as ProjectileSystem;
    const scene: Phaser.Scene = Object.create(null);
    const player: Noxcat = Object.create(null);
    player.x = 270;
    player.y = 720;
    const dna: BossDNA = {
      ...FALLBACK_BOSS,
      attacks: [
        { pattern, intensity: 2, durationMs: 6_000 },
        FALLBACK_BOSS.attacks[0],
        FALLBACK_BOSS.attacks[1],
      ],
    };
    const director = new AttackDirector(dna, new SeededRng(800), projectiles, {
      scene,
      player,
      getPlayerPosition: () => ({ x: 270, y: 720 }),
    });

    director.start();
    expect(director.currentSafeLane).toMatchObject({ axis: 'vertical' });
    if (pattern === 'top_downpour' || pattern === 'pulse_barrage') {
      expect(director.currentSafeLane?.projection).toBe('screen');
    }
    director.update(ATTACK_TELEGRAPH_MS[pattern] - 1, 3);
    expect(spawned).toHaveLength(0);
    director.update(1, 3);
    expect(spawned.length).toBeGreaterThan(0);
  });
});

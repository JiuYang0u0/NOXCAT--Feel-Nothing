import { describe, expect, it } from 'vitest';
import type Phaser from 'phaser';

import { FALLBACK_BOSS } from '../src/ai/fallbackBoss';
import type { BossDNA } from '../src/ai/bossSchema';
import { PLAYER_HIT_RADIUS, PLAYER_MIN_Y, PLAYER_MAX_Y } from '../src/game/constants';
import type { Noxcat } from '../src/game/entities/Noxcat';
import type { ProjectileConfig } from '../src/game/entities/Projectile';
import {
  CLOSING_WALL_SAFE_GAP_HALF_HEIGHT,
  planClosingWallWave,
  planClosingWalls,
} from '../src/game/patterns/closingWalls';
import {
  COMMENT_SAFE_SPOT_RADIUS,
  COMMENT_CLEARANCE_X,
  COMMENT_CLEARANCE_Y,
  runCommentCrossfire,
  planCommentCrossfire,
} from '../src/game/patterns/commentCrossfire';
import {
  hasMinimumReactionDistance,
  PROJECTILE_RECYCLE_TOP,
} from '../src/game/patterns/fairness';
import {
  PAPER_SAFE_LANE_HALF_WIDTH,
  planPaperRain,
} from '../src/game/patterns/paperRain';
import {
  planReturnableBurst,
  RETURNABLE_INTERACTION_GAP_MS,
  RETURNABLE_MIN_NEAR_PLANE_MS,
  RETURNABLE_STAGGER_MS,
  RETURNABLE_OPENING_CLEAR_MS,
  RETURNABLE_PATH_SEPARATION,
  RETURNABLE_SAFE_LANE_HALF_WIDTH,
  RETURNABLE_WINDOW_START_MS,
  runReturnableBurst,
} from '../src/game/patterns/returnableBurst';
import type { AttackPatternContext } from '../src/game/patterns/types';
import { planRevisionHoming } from '../src/game/patterns/revisionHoming';
import {
  ATTACK_MIN_ACTIVE_MS,
  ATTACK_RECOVERY_MS,
  ATTACK_TELEGRAPH_MS,
  AttackDirector,
  type WavePhase,
} from '../src/game/systems/AttackDirector';
import {
  createTunnelTrajectory,
  nearWallVisualHalfHeight,
  PROJECTILE_CONTACT_DEPTH,
  radialNearPlaneVelocity,
  sampleTunnelProjection,
} from '../src/game/systems/ProjectileDepth';
import { initialProjectileExitVelocity } from '../src/game/systems/ProjectileExitMotion';
import type { ProjectileSystem } from '../src/game/systems/ProjectileSystem';
import { SeededRng } from '../src/utils/rng';

function speedOf(config: ProjectileConfig): number {
  return Math.hypot(config.vx, config.vy);
}

function createPatternRuntime(
  x = 270,
  y = 720,
): Pick<AttackPatternContext, 'scene' | 'player'> {
  // Pattern code only reads the public position in these headless unit tests.
  // Explicit annotations keep the harness aligned with the production
  // Phaser.Scene/Noxcat contract without starting a WebGL renderer.
  const scene: Phaser.Scene = Object.create(null);
  const player: Noxcat = Object.create(null);
  player.x = x;
  player.y = y;
  return { scene, player };
}

function expectNearRayOutsideLane(
  config: ProjectileConfig,
  laneY: number,
  halfWidth: number,
): void {
  const radius = config.radius ?? 18;
  const trajectory = createTunnelTrajectory(
    { x: config.x, y: config.y },
    { x: config.vx, y: config.vy },
    radius,
    config.perspectiveTarget,
    config.perspectiveDurationMs,
    config.perspectiveOrigin,
  );
  const velocity = radialNearPlaneVelocity(trajectory, speedOf(config));
  for (let index = 0; index <= 40; index += 1) {
    const seconds = index * 0.05;
    const point = {
      x: trajectory.nearPoint.x + velocity.x * seconds,
      y: trajectory.nearPoint.y + velocity.y * seconds,
    };
    if (point.x < 46 || point.x > 494) continue;
    expect(Math.abs(point.y - laneY)).toBeGreaterThan(
      halfWidth + PLAYER_HIT_RADIUS + radius,
    );
  }
}

function expectNearRayOutsideVerticalLane(
  config: ProjectileConfig,
  laneX: number,
  halfWidth: number,
): void {
  const radius = config.radius ?? 18;
  const trajectory = createTunnelTrajectory(
    { x: config.x, y: config.y },
    { x: config.vx, y: config.vy },
    radius,
    config.perspectiveTarget,
    config.perspectiveDurationMs,
    config.perspectiveOrigin,
  );
  const velocity = radialNearPlaneVelocity(trajectory, speedOf(config));
  for (let index = 0; index <= 40; index += 1) {
    const seconds = index * 0.05;
    const point = {
      x: trajectory.nearPoint.x + velocity.x * seconds,
      y: trajectory.nearPoint.y + velocity.y * seconds,
    };
    if (point.y < 430 || point.y > 884) continue;
    expect(Math.abs(point.x - laneX)).toBeGreaterThanOrEqual(
      halfWidth + PLAYER_HIT_RADIUS + radius,
    );
  }
}

function expectProjectedCollisionIntervalOutsideVerticalSafeWedge(
  config: ProjectileConfig,
  laneX: number,
  halfWidth: number,
): void {
  const radius = config.radius ?? 18;
  const trajectory = createTunnelTrajectory(
    { x: config.x, y: config.y },
    { x: config.vx, y: config.vy },
    radius,
    config.perspectiveTarget,
    config.perspectiveDurationMs,
    config.perspectiveOrigin,
  );
  const side = trajectory.nearPoint.x < laneX ? -1 : 1;
  const collisionClearance = radius + PLAYER_HIT_RADIUS;
  let minimumClearance = Number.POSITIVE_INFINITY;
  let collisionStayedActive = true;

  for (let index = 0; index <= 40; index += 1) {
    const depth = PROJECTILE_CONTACT_DEPTH
      + (1 - PROJECTILE_CONTACT_DEPTH) * index / 40;
    const authoredPoint = {
      x: trajectory.spawn.x
        + (trajectory.approachPoint.x - trajectory.spawn.x) * depth,
      y: trajectory.spawn.y
        + (trajectory.approachPoint.y - trajectory.spawn.y) * depth,
    };
    const projection = sampleTunnelProjection(trajectory, authoredPoint);
    // 退件改為螢幕直向通道，預警與碰撞不再收斂到 Boss 消失點。
    const wedge = { left: laneX - halfWidth, right: laneX + halfWidth };
    collisionStayedActive &&= projection.collisionActive;
    const clearance = side < 0
      ? wedge.left - (projection.position.x + collisionClearance)
      : (projection.position.x - collisionClearance) - wedge.right;
    minimumClearance = Math.min(minimumClearance, clearance);
  }

  expect(collisionStayedActive).toBe(true);
  expect(minimumClearance).toBeGreaterThanOrEqual(-1e-7);
}

describe('attack pattern fairness geometry', () => {
  it('keeps the paper-rain lane clear for the full downward flight', () => {
    const laneX = 270;
    const projectiles = planPaperRain(new SeededRng(81), 3, 1, laneX);

    expect(projectiles).toHaveLength(16);
    const nearTargets = projectiles.map((projectile) => projectile.perspectiveTarget?.x ?? projectile.x);
    expect(Math.min(...nearTargets)).toBeLessThan(46);
    expect(Math.max(...nearTargets)).toBeGreaterThan(494);
    for (const projectile of projectiles) {
      expect(projectile.perspectiveOrigin).toEqual({
        x: projectile.x,
        y: projectile.perspectiveOrigin?.y,
      });
      expect(projectile.perspectiveOrigin?.y).toBeGreaterThan(80);
      expect(projectile.perspectiveOrigin?.y).toBeLessThan(200);
      expect(projectile.y).toBeGreaterThan(PROJECTILE_RECYCLE_TOP);
      const radius = projectile.radius ?? 18;
      const requiredClearance = PAPER_SAFE_LANE_HALF_WIDTH + PLAYER_HIT_RADIUS + radius;
      expect(Math.abs(projectile.x - laneX)).toBeGreaterThan(requiredClearance);
      expect(Math.abs(projectile.x + projectile.vx * 5 - laneX)).toBeGreaterThan(requiredClearance);
      expect(Math.sign(projectile.vx)).toBe(Math.sign(projectile.x - laneX));
    }
  });

  it('sweeps both legal screen edges before overscanned paper lanes leave the viewport', () => {
    const projectiles = planPaperRain(new SeededRng(81), 3, 1, 270);
    const projectedCentres = projectiles.map((projectile) => {
      const radius = projectile.radius ?? 18;
      const trajectory = createTunnelTrajectory(
        { x: projectile.x, y: projectile.y },
        { x: projectile.vx, y: projectile.vy },
        radius,
        projectile.perspectiveTarget,
        projectile.perspectiveDurationMs,
        projectile.perspectiveOrigin,
      );
      const depth = PROJECTILE_CONTACT_DEPTH;
      return sampleTunnelProjection(trajectory, {
        x: trajectory.spawn.x
          + (trajectory.approachPoint.x - trajectory.spawn.x) * depth,
        y: trajectory.spawn.y
          + (trajectory.approachPoint.y - trajectory.spawn.y) * depth,
      }).position.x;
    });
    const collisionReach = PLAYER_HIT_RADIUS + 18;

    expect(projectedCentres.some((x) => Math.abs(x - 46) <= collisionReach)).toBe(true);
    expect(projectedCentres.some((x) => Math.abs(x - 494) <= collisionReach)).toBe(true);
  });

  it('randomizes directions, origins and angles reproducibly with distinct simultaneous sources', () => {
    const sequence = (seed: number) => {
      const rng = new SeededRng(seed);
      return Array.from({ length: 24 }, () => planCommentCrossfire(rng, 3, 1));
    };
    const first = sequence(12);
    expect(first).toEqual(sequence(12));
    expect(first).not.toEqual(sequence(13));
    const combinations = first.map((plan) => plan.layout.rays.map((ray) => ray.direction).sort().join(','));
    expect(new Set(combinations).size).toBeGreaterThanOrEqual(6);
    expect(new Set(first.flatMap((plan) => plan.layout.rays.map((ray) => ray.direction))).size).toBe(4);
    expect(first.some((plan) => plan.projectiles.length === 4)).toBe(true);
    expect(first.some((plan) => plan.projectiles.length === 6)).toBe(true);
    const angles = first.flatMap((plan) => plan.layout.rays.map((ray) => ((ray.angle % 180) + 180) % 180));
    expect(angles.some((angle) => angle < 10 || angle > 170)).toBe(true);
    expect(angles.some((angle) => angle > 30 && angle < 60)).toBe(true);
    expect(angles.some((angle) => angle > 80 && angle < 100)).toBe(true);
    expect(new Set(angles.map((angle) => Math.round(angle / 15))).size).toBeGreaterThanOrEqual(10);
    for (const plan of first) {
      expect(new Set(plan.layout.rays.map((ray) => ray.direction)).size).toBeGreaterThanOrEqual(2);
      expect(new Set(plan.layout.rays.map((ray) => ray.direction)).size).toBe(plan.projectiles.length / 2);
      for (const card of plan.projectiles) {
        expect(card.perspectiveDurationMs! * PROJECTILE_CONTACT_DEPTH).toBeGreaterThanOrEqual(550);
      }
    }
  });

  it('emits the whole multi-side volley at once and cancels without late emissions', () => {
    const spawned: ProjectileConfig[] = [];
    const runtime = createPatternRuntime();
    const projectiles = {
      spawn: (config: ProjectileConfig) => { spawned.push(config); return null; },
    } as unknown as ProjectileSystem;
    const handle = runCommentCrossfire({
      ...runtime, projectiles, rng: new SeededRng(12), intensity: 3,
      durationMs: 3_000, speedScale: 1, waveIndex: 0,
    });
    const initial = [...spawned];
    expect(initial.length).toBeGreaterThanOrEqual(2);
    expect(new Set(initial.map((card) => `${card.perspectiveOrigin!.x},${card.perspectiveOrigin!.y}`)).size).toBe(initial.length);
    handle.update(459);
    handle.cancel();
    handle.update(10_000);
    expect(spawned).toEqual(initial);
  });

  it('uses the BossDNA LLM lines for comment-crossfire projectiles', () => {
    const commentLines = ['需求又轉彎', '昨天版本呢', '這裡再微調', '今晚能上嗎', '最終版加一'] as const;
    const spawned: ProjectileConfig[] = [];
    const projectiles = {
      spawn: (config: ProjectileConfig) => { spawned.push(config); return null; },
      activeProjectiles: () => [{ isDamage: true, friendly: false }],
      activeBeams: () => [],
      releaseDangerousForExit: () => undefined,
    } as unknown as ProjectileSystem;
    const dna = {
      attacks: [{ pattern: 'comment_crossfire', intensity: 3, durationMs: 4_500 }] as const,
      commentLines,
    };
    const director = new AttackDirector(
      dna,
      new SeededRng(12),
      projectiles,
      createPatternRuntime(),
    );

    director.start();
    director.update(ATTACK_TELEGRAPH_MS.comment_crossfire, 3);

    expect(spawned.length).toBeGreaterThanOrEqual(2);
    expect(spawned.every((projectile) => (
      commentLines.includes(projectile.text as typeof commentLines[number])
    ))).toBe(true);
  });

  it('keeps a reachable safe spot clear throughout every broad-angle flight', () => {
    for (const intensity of [1, 2, 3] as const) {
      for (const speedScale of [0.87, 1, 1.2]) {
        for (let seed = 1; seed <= 40; seed += 1) {
          const plan = planCommentCrossfire(new SeededRng(seed), intensity, speedScale);
          const spot = plan.layout.safeSpot;
          expect(spot.radius).toBe(COMMENT_SAFE_SPOT_RADIUS);
          expect(spot.y - spot.radius).toBeGreaterThanOrEqual(PLAYER_MIN_Y);
          expect(spot.y + spot.radius).toBeLessThanOrEqual(PLAYER_MAX_Y);
          for (const card of plan.projectiles) {
            const trajectory = createTunnelTrajectory(
              { x: card.x, y: card.y }, { x: card.vx, y: card.vy }, card.radius ?? 28,
              card.perspectiveTarget, card.perspectiveDurationMs, card.perspectiveOrigin,
            );
            const points = Array.from({ length: 41 }, (_, i) => {
              const depth = PROJECTILE_CONTACT_DEPTH + (1 - PROJECTILE_CONTACT_DEPTH) * i / 40;
              return sampleTunnelProjection(trajectory, {
                x: trajectory.spawn.x + (trajectory.approachPoint.x - trajectory.spawn.x) * depth,
                y: trajectory.spawn.y + (trajectory.approachPoint.y - trajectory.spawn.y) * depth,
              }).position;
            });
            const velocity = initialProjectileExitVelocity(trajectory, { x: card.vx, y: card.vy });
            for (let i = 1; i <= 240; i += 1) {
              points.push({
                x: trajectory.nearPoint.x + velocity.x * i / 120,
                y: trajectory.nearPoint.y + velocity.y * i / 120,
              });
            }
            const playable = points.filter((point) => point.x >= 46 && point.x <= 494
              && point.y >= PLAYER_MIN_Y && point.y <= PLAYER_MAX_Y);
            expect(playable.length).toBeGreaterThan(0);
            const firstPoint = playable[0]!;
            const lastPoint = playable.at(-1)!;
            expect(Math.hypot(lastPoint.x - firstPoint.x, lastPoint.y - firstPoint.y)).toBeGreaterThan(70);
            const speed = speedOf(card);
            const nx = -card.vy / speed;
            const ny = card.vx / speed;
            const clearance = Math.abs(nx) * COMMENT_CLEARANCE_X + Math.abs(ny) * COMMENT_CLEARANCE_Y + spot.radius;
            const minimumSeparation = Math.min(...points.map((point) => Math.abs(
              (point.x - spot.x) * nx + (point.y - spot.y) * ny,
            )));
            expect(minimumSeparation).toBeGreaterThan(clearance);
          }
        }
      }
    }
  });

  it('opens a stable lane through returnable bursts and warns from far above', () => {
    const topPlayer = { x: 270, y: 430 };
    const plan = planReturnableBurst(new SeededRng(33), 3, 0, 1, topPlayer);

    expect(plan.projectiles).toHaveLength(8);
    expect(plan.returnableIndex).toBeGreaterThanOrEqual(1);
    expect(plan.returnableIndices).toEqual([6, 7]);
    expect(plan.projectiles.filter((projectile) => projectile.kind === 'returnable')).toHaveLength(2);
    expect(plan.openingProjectiles).toHaveLength(6);
    expect(plan.openingProjectiles.every((projectile) => projectile.kind === 'paper')).toBe(true);
    expect(plan.returnableProjectiles).toHaveLength(2);
    expect(plan.returnableProjectiles.every((projectile) => (
      projectile.kind === 'returnable'
    ))).toBe(true);
    const returnableTargetX = plan.returnableProjectiles[0]?.perspectiveTarget?.x;
    expect(returnableTargetX).toBeDefined();
    for (const paper of plan.openingProjectiles) {
      expect(Math.abs(paper.x - plan.interactionLaneX)).toBeGreaterThanOrEqual(
        RETURNABLE_PATH_SEPARATION,
      );
      expect(Math.abs((paper.perspectiveTarget?.x ?? paper.x) - (returnableTargetX ?? 0)))
        .toBeGreaterThanOrEqual(80);
      expect(paper.perspectiveDurationMs).toBeLessThan(RETURNABLE_OPENING_CLEAR_MS);
    }
    for (const projectile of plan.projectiles) {
      const radius = projectile.radius ?? 18;
      expect(Math.abs(projectile.x - plan.safeLaneX)).toBeGreaterThanOrEqual(
        RETURNABLE_SAFE_LANE_HALF_WIDTH + PLAYER_HIT_RADIUS + radius + 4,
      );
      expect(Math.sign(projectile.vx)).toBe(Math.sign(projectile.x - plan.safeLaneX));
      expect(hasMinimumReactionDistance(
        { x: projectile.x, y: projectile.y },
        { x: projectile.x, y: topPlayer.y },
        speedOf(projectile),
        radius,
      )).toBe(true);
    }

    const edgePlan = planReturnableBurst(new SeededRng(34), 3, 0, 1, { x: 46, y: 430 });
    expect(edgePlan.safeLaneX).toBe(70);
    expect(edgePlan.projectiles).toHaveLength(8);
    expect(edgePlan.interactionLaneX).toBe(190);
    expect(edgePlan.openingProjectiles.every((paper) => (
      paper.x - edgePlan.interactionLaneX >= RETURNABLE_PATH_SEPARATION
    ))).toBe(true);
    expect(edgePlan.projectiles.every((projectile) => (
      Math.abs(projectile.x - edgePlan.safeLaneX)
        >= RETURNABLE_SAFE_LANE_HALF_WIDTH
          + PLAYER_HIT_RADIUS
          + (projectile.radius ?? 18)
          + 4
    ))).toBe(true);
  });

  it('spawns homing revisions far enough away to prevent a near-boundary hit', () => {
    const projectiles = planRevisionHoming(new SeededRng(5), 3, 1);

    expect(projectiles).toHaveLength(4);
    for (const projectile of projectiles) {
      const radius = projectile.radius ?? 18;
      expect(hasMinimumReactionDistance(
        { x: projectile.x, y: projectile.y },
        { x: projectile.x, y: 430 },
        speedOf(projectile),
        radius,
      )).toBe(true);
    }
  });

  it('keeps a 2.5-player-diameter gap through both closing walls', () => {
    const gapY = 650;
    const plan = planClosingWalls(new SeededRng(44), 3, 1, gapY);

    expect(CLOSING_WALL_SAFE_GAP_HALF_HEIGHT * 2).toBeGreaterThanOrEqual(PLAYER_HIT_RADIUS * 2 * 2.5);
    const nearestWallCenter = CLOSING_WALL_SAFE_GAP_HALF_HEIGHT
      + 27
      + PLAYER_HIT_RADIUS
      + 4;
    const renderedOpening = 2 * (nearestWallCenter - nearWallVisualHalfHeight());
    expect(renderedOpening).toBeGreaterThanOrEqual(PLAYER_HIT_RADIUS * 2 * 2.5);
    for (const projectile of plan.projectiles) {
      const radius = projectile.radius ?? 27;
      expect(Math.abs(projectile.y - gapY)).toBeGreaterThan(
        CLOSING_WALL_SAFE_GAP_HALF_HEIGHT + PLAYER_HIT_RADIUS + radius,
      );
      const edgePlayer = {
        x: projectile.vx > 0 ? 46 : 494,
        y: projectile.y,
      };
      expect(hasMinimumReactionDistance(
        { x: projectile.x, y: projectile.y },
        edgePlayer,
        speedOf(projectile),
        radius,
      )).toBe(true);
      expectNearRayOutsideLane(projectile, gapY, CLOSING_WALL_SAFE_GAP_HALF_HEIGHT);
    }
  });

  it('moves the closing-wall gap slowly across the whole wave without narrowing it', () => {
    const wave = planClosingWallWave(new SeededRng(144), 3, 1, 650, 5_200);
    const gapPath = wave.formations.map((formation) => formation.safeGapY);
    const deltas = gapPath.slice(1).map((gap, index) => gap - gapPath[index]!);

    expect(wave.formations).toHaveLength(5);
    expect(wave.formations[0]?.atMs).toBe(0);
    expect(wave.formations.at(-1)?.atMs).toBe(3_600);
    expect(gapPath.at(0)).toBe(wave.startGapY);
    expect(gapPath.at(-1)).toBe(wave.endGapY);
    expect(Math.abs(wave.endGapY - wave.startGapY)).toBeLessThanOrEqual(74);
    expect(deltas.every((delta) => Math.sign(delta) === Math.sign(deltas[0]!))).toBe(true);
    for (const formation of wave.formations) {
      for (const projectile of formation.projectiles) {
        expect(Math.abs(projectile.y - formation.safeGapY)).toBeGreaterThan(
          CLOSING_WALL_SAFE_GAP_HALF_HEIGHT
            + PLAYER_HIT_RADIUS
            + (projectile.radius ?? 27),
        );
      }
    }
  });

  it('keeps every moving wall opening reachable inside the lower dodge area', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      for (const startY of [430, 650, PLAYER_MIN_Y, 810, PLAYER_MAX_Y]) {
        const wave = planClosingWallWave(new SeededRng(seed), 3, 1, startY, 5_200);
        for (const formation of wave.formations) {
          expect(formation.safeGapY).toBeGreaterThanOrEqual(PLAYER_MIN_Y);
          expect(formation.safeGapY).toBeLessThanOrEqual(PLAYER_MAX_Y);
          for (const projectile of formation.projectiles) {
            expectNearRayOutsideLane(projectile, formation.safeGapY, CLOSING_WALL_SAFE_GAP_HALF_HEIGHT);
          }
        }
      }
    }
  });

  it('leaves no safe pocket outside the closing wall opening', () => {
    // Review 重現：移動區從 884 縮到 774 後，固定兩層的牆在缺口靠邊時最外側
    // 那列之外仍留著打不到的安全口袋，玩家整波賴在那裡就不必穿缺口。
    const WALL_REACH = PLAYER_HIT_RADIUS + 27;
    for (const seed of [1, 12, 44, 144]) {
      for (const intensity of [1, 2, 3] as const) {
        for (const startY of [PLAYER_MIN_Y, 602, PLAYER_MAX_Y]) {
          const wave = planClosingWallWave(new SeededRng(seed), intensity, 1, startY, 5_200);
          for (const formation of wave.formations) {
            for (const side of [-1, 1]) {
              const label = `seed ${seed} intensity ${intensity} start ${startY} side ${side}`;
              const offsets = [...new Set(formation.projectiles
                .filter((config) => Math.sign(config.y - formation.safeGapY) === side)
                .map((config) => Math.abs(config.y - formation.safeGapY)))]
                .sort((a, b) => a - b);
              expect(offsets.length, `${label}: 這一側完全沒有文件列`).toBeGreaterThan(0);
              // 相鄰列的碰撞覆蓋必須相連，中間不能夾出可站的縫。
              for (let index = 1; index < offsets.length; index += 1) {
                expect(offsets[index]! - offsets[index - 1]!, `${label}: 兩列之間留縫`)
                  .toBeLessThanOrEqual(WALL_REACH * 2);
              }
              // 最外側那列必須蓋過移動區邊緣，否則牆外還有安全口袋。
              const edge = side < 0 ? PLAYER_MIN_Y : PLAYER_MAX_Y;
              expect(offsets.at(-1)! + WALL_REACH, `${label}: 最外列蓋不到移動區邊緣`)
                .toBeGreaterThanOrEqual(Math.abs(edge - formation.safeGapY));
            }
          }
        }
      }
    }
  });

  it('keeps earlier wall formations clear of the moving opening from contact through exit', () => {
    for (const seed of [1, 12, 13, 14, 144]) {
      for (const intensity of [1, 2, 3] as const) {
        for (const startY of [PLAYER_MIN_Y, 775, PLAYER_MAX_Y - CLOSING_WALL_SAFE_GAP_HALF_HEIGHT]) {
          const wave = planClosingWallWave(new SeededRng(seed), intensity, 1, startY, 5_200);
          for (const formation of wave.formations) {
            for (const config of formation.projectiles) {
              const trajectory = createTunnelTrajectory(
                { x: config.x, y: config.y }, { x: config.vx, y: config.vy },
                config.radius ?? 27, config.perspectiveTarget,
                config.perspectiveDurationMs, config.perspectiveOrigin,
              );
              for (let index = 0; index <= 10; index += 1) {
                const depth = PROJECTILE_CONTACT_DEPTH + (1 - PROJECTILE_CONTACT_DEPTH) * index / 10;
                const projection = sampleTunnelProjection(trajectory, {
                  x: config.x + (trajectory.approachPoint.x - config.x) * depth,
                  y: config.y + (trajectory.approachPoint.y - config.y) * depth,
                });
                if (projection.position.x < 46 || projection.position.x > 494) continue;
                for (const opening of wave.formations) {
                  expect(Math.abs(projection.position.y - opening.safeGapY)).toBeGreaterThan(
                    CLOSING_WALL_SAFE_GAP_HALF_HEIGHT + PLAYER_HIT_RADIUS + (config.radius ?? 27),
                  );
                }
              }
              for (const opening of wave.formations) {
                expectNearRayOutsideLane(config, opening.safeGapY, CLOSING_WALL_SAFE_GAP_HALF_HEIGHT);
              }
            }
          }
        }
      }
    }
  });

  it('produces identical safe geometry for identical seeds and inputs', () => {
    const first = planReturnableBurst(new SeededRng(270_027), 2, 4, 0.87, { x: 333, y: 700 });
    const second = planReturnableBurst(new SeededRng(270_027), 2, 4, 0.87, { x: 333, y: 700 });

    expect(first).toEqual(second);
  });

  it('keeps advertised safe lanes clear across seeds, intensities, and edge positions', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      for (const intensity of [1, 2, 3] as const) {
        for (const laneX of [90, 270, 450]) {
          for (const projectile of planPaperRain(new SeededRng(seed), intensity, 1, laneX)) {
            expectNearRayOutsideVerticalLane(projectile, laneX, PAPER_SAFE_LANE_HALF_WIDTH);
          }
          const burst = planReturnableBurst(
            new SeededRng(seed),
            intensity,
            seed % 7,
            1,
            { x: laneX, y: 720 },
          );
          for (const projectile of burst.projectiles) {
            expectNearRayOutsideVerticalLane(
              projectile,
              burst.safeLaneX,
              RETURNABLE_SAFE_LANE_HALF_WIDTH,
            );
          }
        }

        for (const laneY of [535, 650, 805]) {
          const walls = planClosingWalls(new SeededRng(seed), intensity, 1, laneY);
          for (const projectile of walls.projectiles) {
            expectNearRayOutsideLane(projectile, walls.safeGapY, CLOSING_WALL_SAFE_GAP_HALF_HEIGHT);
          }
        }
      }
    }
  });

  it('keeps projected hit circles outside vertical safe wedges for every active depth', () => {
    const paperLanes = [90, 120, 270, 420, 450] as const;
    const returnableLanes = [70, 90, 150, 270, 390, 450, 470] as const;

    for (let seed = 1; seed <= 100; seed += 1) {
      for (const intensity of [1, 2, 3] as const) {
        for (const laneX of paperLanes) {
          const configs = planPaperRain(new SeededRng(seed), intensity, 1, laneX);
          for (const config of configs) {
            expectNearRayOutsideVerticalLane(
              config,
              laneX,
              PAPER_SAFE_LANE_HALF_WIDTH,
            );
          }
        }

        for (const laneX of returnableLanes) {
          const plan = planReturnableBurst(
            new SeededRng(seed),
            intensity,
            seed % 7,
            1,
            { x: laneX, y: 720 },
          );
          for (const config of plan.projectiles) {
            expectProjectedCollisionIntervalOutsideVerticalSafeWedge(
              config,
              plan.safeLaneX,
              RETURNABLE_SAFE_LANE_HALF_WIDTH,
            );
          }
        }
      }
    }
  });
});

describe('AttackDirector wave pacing', () => {
  it('locks every randomized warning and its safe spot until simultaneous emission', () => {
    const spawned: ProjectileConfig[] = [];
    const projectiles = {
      spawn: (config: ProjectileConfig) => { spawned.push(config); return null; },
      activeProjectiles: () => [{ isDamage: true, friendly: false }],
      activeBeams: () => [],
      releaseDangerousForExit: () => undefined,
    } as unknown as ProjectileSystem;
    const dna: BossDNA = { ...FALLBACK_BOSS, attacks: [
      { pattern: 'comment_crossfire', intensity: 3, durationMs: 4_500 },
      { pattern: 'paper_rain', intensity: 1, durationMs: 4_500 },
      { pattern: 'comment_crossfire', intensity: 1, durationMs: 4_500 },
    ] };
    const runtime = createPatternRuntime(46, PLAYER_MIN_Y);
    const director = new AttackDirector(dna, new SeededRng(12), projectiles, runtime);
    director.start();
    let commentWave = 0;
    for (let step = 0; step < 12; step += 1) {
      const isComment = director.currentPattern === 'comment_crossfire';
      const warnings = director.currentDangerZones.filter((zone) => zone.kind === 'ray');
      const spot = director.currentSafeSpot;
      const before = spawned.length;
      // 預警後改變玩家位置不可讓彈道或安全通道跟著換邊。
      runtime.player.x = runtime.player.x === 46 ? 494 : 46;
      const telegraphMs = ATTACK_TELEGRAPH_MS[director.currentPattern];
      director.update(telegraphMs, 3);
      if (isComment) {
        commentWave += 1;
        expect(director.currentSafeSpot).toEqual(spot);
        expect(director.currentDangerZones.filter((zone) => zone.kind === 'ray')).toEqual(warnings);
        const volley = spawned.slice(before);
        expect(volley).toHaveLength(warnings.length);
        warnings.forEach((warning, index) => {
          const card = volley[index]!;
          expect(card.perspectiveOrigin).toEqual(warning.from);
          const target = card.perspectiveTarget!;
          const dx = warning.to.x - warning.from.x;
          const dy = warning.to.y - warning.from.y;
          expect((target.x - warning.from.x) * dy - (target.y - warning.from.y) * dx).toBeCloseTo(0, 7);
        });
      }
      while (director.currentPhase !== 'RECOVERY') director.update(1, 3);
      while (director.currentPhase === 'RECOVERY') director.update(1, 3);
    }
    expect(commentWave).toBe(8);
  });

  it('spawns exactly once per step, releases cards through recovery, then changes pattern', () => {
    const spawned: ProjectileConfig[] = [];
    const phases: WavePhase[] = [];
    let clears = 0;
    let releases = 0;
    const projectiles = {
      spawn: (config: ProjectileConfig) => {
        spawned.push(config);
        return null;
      },
      activeProjectiles: () => [{ isDamage: true, friendly: false }],
      activeBeams: () => [],
      clearDangerous: () => { clears += 1; },
      releaseDangerousForExit: () => { releases += 1; },
    } as unknown as ProjectileSystem;
    const runtime = createPatternRuntime();
    const director = new AttackDirector(FALLBACK_BOSS, new SeededRng(FALLBACK_BOSS.seed), projectiles, {
      ...runtime,
      getPlayerPosition: () => ({ x: 270, y: 720 }),
      onWavePhaseChanged: (phase) => phases.push(phase),
    });

    director.start();
    expect(director.currentPhase).toBe('TELEGRAPH');
    director.update(ATTACK_TELEGRAPH_MS.paper_rain - 1, 3);
    expect(spawned).toHaveLength(0);

    director.update(1, 3);
    expect(director.currentPhase).toBe('ACTIVE');
    expect(spawned).toHaveLength(1);
    director.update(144, 3);
    expect(spawned).toHaveLength(1);
    director.update(1, 3);
    expect(spawned).toHaveLength(2);
    const paperActiveMs = FALLBACK_BOSS.attacks[0].durationMs
      - ATTACK_TELEGRAPH_MS.paper_rain
      - ATTACK_RECOVERY_MS.paper_rain;
    director.update(paperActiveMs - 146, 3);
    expect(director.currentPhase).toBe('ACTIVE');
    expect(spawned).toHaveLength(12);
    expect(clears).toBe(0);
    expect(releases).toBe(0);
    director.update(1, 3);
    expect(director.currentPhase).toBe('RECOVERY');
    expect(spawned).toHaveLength(12);
    expect(clears).toBe(0);
    expect(releases).toBe(1);
    director.update(ATTACK_RECOVERY_MS.paper_rain - 1, 3);
    expect(spawned).toHaveLength(12);
    director.update(1, 3);
    expect(director.currentPhase).toBe('TELEGRAPH');
    expect(director.currentPattern).toBe('returnable_burst');
    expect(spawned).toHaveLength(12);
    director.update(ATTACK_TELEGRAPH_MS.returnable_burst - 1, 3);
    expect(spawned).toHaveLength(12);
    director.update(1, 3);
    expect(director.currentPhase).toBe('ACTIVE');
    // The returnable pattern teaches with a front-to-back paper queue first.
    expect(spawned.slice(12)).toHaveLength(1);
    director.update(99, 3);
    expect(spawned.slice(12)).toHaveLength(1);
    director.update(1, 3);
    expect(spawned.slice(12)).toHaveLength(2);
    expect(spawned.slice(12).every((projectile) => projectile.kind === 'paper')).toBe(true);
    director.update(RETURNABLE_OPENING_CLEAR_MS - 101, 3);
    expect(spawned.slice(12)).toHaveLength(5);
    expect(spawned.slice(12).every((projectile) => projectile.kind === 'paper')).toBe(true);
    expect(clears).toBe(0);
    director.update(1, 3);
    expect(clears).toBe(0);
    expect(releases).toBe(2);
    director.update(RETURNABLE_INTERACTION_GAP_MS - 1, 3);
    expect(spawned.slice(12)).toHaveLength(5);
    director.update(1, 3);
    expect(spawned.slice(12)).toHaveLength(6);
    expect(spawned.at(-1)?.kind).toBe('returnable');
    expect(phases).toEqual([
      'TELEGRAPH',
      'ACTIVE',
      'RECOVERY',
      'TELEGRAPH',
      'ACTIVE',
    ]);
  });

  it('cancels a live pattern handle before its delayed returnables can spawn', () => {
    const spawned: ProjectileConfig[] = [];
    const projectiles = {
      spawn: (config: ProjectileConfig) => {
        spawned.push(config);
        return null;
      },
    } as unknown as ProjectileSystem;
    const runtime = createPatternRuntime();
    const context: AttackPatternContext = {
      ...runtime,
      rng: new SeededRng(270_027),
      intensity: 3,
      durationMs: 5_500,
      projectiles,
      speedScale: 1,
      waveIndex: 0,
    };
    const handle = runReturnableBurst(context, 270);

    expect(spawned).toHaveLength(1);
    expect(spawned.every((projectile) => projectile.kind === 'paper')).toBe(true);
    handle.update(RETURNABLE_OPENING_CLEAR_MS - 1);
    expect(spawned).toHaveLength(6);
    handle.cancel();
    handle.update(10_000);

    expect(handle.cancelled).toBe(true);
    expect(handle.finished).toBe(true);
    expect(spawned).toHaveLength(6);
  });

  it('keeps delayed returnables reachable in the shortest valid ACTIVE window', () => {
    const spawned: ProjectileConfig[] = [];
    let liveDangerous: ProjectileConfig[] = [];
    let releases = 0;
    const projectiles = {
      spawn: (config: ProjectileConfig) => {
        spawned.push(config);
        liveDangerous.push(config);
        return null;
      },
      releaseDangerousForExit: () => {
        releases += 1;
        liveDangerous = [];
      },
    } as unknown as ProjectileSystem;
    const runtime = createPatternRuntime();
    const activeDurationMs = 4_000;
    const handle = runReturnableBurst({
      ...runtime,
      rng: new SeededRng(18),
      intensity: 3,
      durationMs: activeDurationMs,
      projectiles,
      speedScale: 1,
      waveIndex: 0,
    }, 270);

    expect(liveDangerous).toHaveLength(1);
    expect(liveDangerous.every((projectile) => projectile.kind === 'paper')).toBe(true);
    handle.update(RETURNABLE_OPENING_CLEAR_MS);
    expect(releases).toBe(1);
    expect(liveDangerous).toHaveLength(0);
    handle.update(RETURNABLE_INTERACTION_GAP_MS - 1);
    expect(liveDangerous).toHaveLength(0);
    handle.update(1);
    expect(liveDangerous).toHaveLength(1);
    expect(liveDangerous.every((projectile) => projectile.kind === 'returnable')).toBe(true);
    handle.update(RETURNABLE_STAGGER_MS - 1);
    expect(liveDangerous).toHaveLength(1);
    handle.update(1);
    expect(liveDangerous).toHaveLength(2);
    const returnables = spawned.filter((card) => card.kind === 'returnable');
    for (const projectile of returnables) {
      expect(projectile.perspectiveDurationMs).toBeLessThanOrEqual(
        activeDurationMs - RETURNABLE_WINDOW_START_MS - RETURNABLE_STAGGER_MS - RETURNABLE_MIN_NEAR_PLANE_MS,
      );
    }
  });

  it('makes AttackDirector cancellation discard a pattern\'s pending emissions', () => {
    const spawned: ProjectileConfig[] = [];
    let clears = 0;
    let tutorials = 0;
    const projectiles = {
      spawn: (config: ProjectileConfig) => {
        spawned.push(config);
        return null;
      },
      clearDangerous: () => { clears += 1; },
    } as unknown as ProjectileSystem;
    const returnableFirst: BossDNA = {
      ...FALLBACK_BOSS,
      attacks: [
        { pattern: 'returnable_burst', intensity: 3, durationMs: 7_000 },
        FALLBACK_BOSS.attacks[0],
        FALLBACK_BOSS.attacks[2],
      ],
    };
    const director = new AttackDirector(
      returnableFirst,
      new SeededRng(returnableFirst.seed),
      projectiles,
      {
        ...createPatternRuntime(),
        getPlayerPosition: () => ({ x: 270, y: 720 }),
        onReturnableTutorial: () => { tutorials += 1; },
      },
    );

    director.start();
    director.update(ATTACK_TELEGRAPH_MS.returnable_burst, 3);
    expect(spawned).toHaveLength(1);
    expect(spawned.every((projectile) => projectile.kind === 'paper')).toBe(true);

    director.cancelCurrent();
    director.update(10_000, 3);
    expect(clears).toBe(1);
    expect(tutorials).toBe(0);
    expect(spawned).toHaveLength(1);
  });

  it('uses short recoveries without reducing required high-speed warnings', () => {
    expect(Math.min(...Object.values(ATTACK_TELEGRAPH_MS))).toBeGreaterThanOrEqual(500);
    expect(ATTACK_TELEGRAPH_MS.deadline_beam).toBeGreaterThanOrEqual(750);
    expect(ATTACK_RECOVERY_MS).toEqual({
      paper_rain: 360,
      comment_crossfire: 400,
      deadline_beam: 420,
      closing_walls: 500,
      revision_homing: 440,
      returnable_burst: 380,
      top_downpour: 400,
      pulse_barrage: 460,
      alternating_zipper: 420,
    });
    expect(Math.max(...Object.values(ATTACK_RECOVERY_MS))).toBeLessThanOrEqual(500);
  });

  it('starts recovery as soon as a finished timeline has no enemy threats', () => {
    let enemyProjectilePresent = true;
    let friendlyProjectilePresent = false;
    let beamPresent = false;
    let clears = 0;
    let releases = 0;
    const projectiles = {
      spawn: () => null,
      activeProjectiles: () => {
        if (enemyProjectilePresent) return [{ isDamage: true, friendly: false }];
        if (friendlyProjectilePresent) return [{ isDamage: false, friendly: true }];
        return [];
      },
      activeBeams: () => (beamPresent
        ? [{ telegraphMs: 120, activeMs: 520 }]
        : []),
      clearDangerous: () => { clears += 1; },
      releaseDangerousForExit: () => { releases += 1; },
    } as unknown as ProjectileSystem;
    const director = new AttackDirector(
      FALLBACK_BOSS,
      new SeededRng(FALLBACK_BOSS.seed),
      projectiles,
      {
        ...createPatternRuntime(),
        getPlayerPosition: () => ({ x: 270, y: 720 }),
      },
    );

    director.start();
    director.update(ATTACK_TELEGRAPH_MS.paper_rain, 3);
    director.update(ATTACK_MIN_ACTIVE_MS.paper_rain + 500, 3);
    expect(director.currentPhase).toBe('ACTIVE');

    // Friendly reflected cards must not stall pacing, but a live beam warning
    // still represents a future hostile segment and keeps ACTIVE open.
    enemyProjectilePresent = false;
    friendlyProjectilePresent = true;
    beamPresent = true;
    director.update(500, 3);
    expect(director.currentPhase).toBe('ACTIVE');

    beamPresent = false;
    director.update(ATTACK_RECOVERY_MS.paper_rain - 1, 3);
    expect(director.currentPhase).toBe('RECOVERY');
    expect(clears).toBe(0);
    expect(releases).toBe(1);
    director.update(1, 3);
    expect(director.currentPhase).toBe('TELEGRAPH');
    expect(director.currentPattern).toBe('returnable_burst');
  });

  it('does not recover early while a pattern timeline still has pending emissions', () => {
    const closingFirst: BossDNA = {
      ...FALLBACK_BOSS,
      attacks: [
        { pattern: 'closing_walls', intensity: 1, durationMs: 4_500 },
        FALLBACK_BOSS.attacks[1],
        FALLBACK_BOSS.attacks[2],
      ],
    };
    const projectiles = {
      spawn: () => null,
      activeProjectiles: () => [],
      activeBeams: () => [],
      clearDangerous: () => undefined,
      releaseDangerousForExit: () => undefined,
    } as unknown as ProjectileSystem;
    const director = new AttackDirector(
      closingFirst,
      new SeededRng(closingFirst.seed),
      projectiles,
      {
        ...createPatternRuntime(),
        getPlayerPosition: () => ({ x: 270, y: 720 }),
      },
    );

    director.start();
    director.update(ATTACK_TELEGRAPH_MS.closing_walls, 3);
    director.update(ATTACK_MIN_ACTIVE_MS.closing_walls, 3);
    expect(director.currentPhase).toBe('ACTIVE');
    // 4,500 - 650 telegraph - 500 recovery = 3,350 ACTIVE;
    // the last closing-wall emission is deliberately scheduled at 1,750 ms.
    director.update(349, 3);
    expect(director.currentPhase).toBe('ACTIVE');
    director.update(1, 3);
    expect(director.currentPhase).toBe('RECOVERY');
  });
});

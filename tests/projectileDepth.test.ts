import { describe, expect, it } from 'vitest';

import {
  BOSS_PROJECTILE_ORIGIN,
  calculateProjectilePerspectiveQuad,
  calculateTunnelDepthPose,
  createProjectilePerspectiveGridData,
  createProjectilePerspectiveProjection,
  createTunnelTrajectory,
  floorGridY,
  projectProjectilePerspectiveUv,
  projectTunnelLane,
  PROJECTILE_CONTACT_DEPTH,
  radialNearPlaneVelocity,
  sampleTunnelProjection,
} from '../src/game/systems/ProjectileDepth';
import { planCommentCrossfire } from '../src/game/patterns/commentCrossfire';
import { planClosingWalls } from '../src/game/patterns/closingWalls';
import { planPaperRain } from '../src/game/patterns/paperRain';
import {
  planReturnableBurst,
  RETURNABLE_OPENING_CLEAR_MS,
} from '../src/game/patterns/returnableBurst';
import { planRevisionHoming } from '../src/game/patterns/revisionHoming';
import type { ProjectileConfig } from '../src/game/entities/Projectile';
import { SeededRng } from '../src/utils/rng';

function canThreatenLegalPlayerPosition(
  point: { x: number; y: number },
  projectileRadius: number,
): boolean {
  const nearestX = Math.min(494, Math.max(46, point.x));
  const nearestY = Math.min(884, Math.max(430, point.y));
  return Math.hypot(point.x - nearestX, point.y - nearestY) <= 18 + projectileRadius + 1e-6;
}

function verifyNearPlaneTraversal(config: ProjectileConfig): void {
  const radius = config.radius ?? (config.kind === 'comment' ? 24 : 18);
  const speed = Math.hypot(config.vx, config.vy);
  const trajectory = createTunnelTrajectory(
    { x: config.x, y: config.y },
    { x: config.vx, y: config.vy },
    radius,
    config.perspectiveTarget,
    config.perspectiveDurationMs,
    config.perspectiveOrigin,
  );
  const nearVelocity = radialNearPlaneVelocity(trajectory, speed);
  const projectionAtDepth = (depth: number) => sampleTunnelProjection(
    trajectory,
    {
      x: trajectory.spawn.x
        + (trajectory.approachPoint.x - trajectory.spawn.x) * depth,
      y: trajectory.spawn.y
        + (trajectory.approachPoint.y - trajectory.spawn.y) * depth,
    },
  );
  const activeSamples = Array.from(
    { length: 6 },
    (_, index) => trajectory.contactDepth
      + (1 - trajectory.contactDepth) * index / 5,
  ).map(projectionAtDepth);

  expect(activeSamples.every((sample) => sample.collisionActive)).toBe(true);
  // Sample from the first reachable upper-arena contact, not only the lower
  // near plane. Overscanned edge lanes must still cross a legal player
  // silhouette for multiple active samples, so vertical camping is impossible.
  expect(activeSamples.filter((sample) => (
    canThreatenLegalPlayerPosition(sample.position, radius)
  )).length).toBeGreaterThanOrEqual(2);
  expect(Math.hypot(nearVelocity.x, nearVelocity.y)).toBeCloseTo(speed);
}

describe('shared projectile perspective depth', () => {
  it('renders every attack kind far-small and near-large with correct foreshortening', () => {
    for (const kind of ['paper', 'comment', 'returnable', 'wall', 'homing'] as const) {
      const far = calculateTunnelDepthPose(kind, 0);
      const middle = calculateTunnelDepthPose(kind, 0.5);
      const near = calculateTunnelDepthPose(kind, 1);

      expect(far.scale).toBeCloseTo(0.13);
      expect(middle.scale).toBeGreaterThan(far.scale);
      expect(near.scale).toBeGreaterThan(middle.scale);
      expect(far.foreshortening).toBeLessThan(middle.foreshortening);
      expect(middle.foreshortening).toBeLessThan(near.foreshortening);
      expect(far.alpha).toBeLessThan(near.alpha);
      expect(near.displayDepth).toBeGreaterThan(middle.displayDepth);
    }
  });

  it('expands a polar lane radially away from the Boss vanishing point', () => {
    const far = projectTunnelLane(0.72, 0.84, 0.18);
    const middle = projectTunnelLane(0.72, 0.84, 0.55);
    const near = projectTunnelLane(0.72, 0.84, 0.92);
    const radius = (point: { x: number; y: number }): number => Math.hypot(
      point.x - BOSS_PROJECTILE_ORIGIN.x,
      point.y - BOSS_PROJECTILE_ORIGIN.y,
    );

    expect(radius(far)).toBeLessThan(radius(middle));
    expect(radius(middle)).toBeLessThan(radius(near));
    expect(far.x).toBeGreaterThan(BOSS_PROJECTILE_ORIGIN.x);
    expect(far.y).toBeGreaterThan(BOSS_PROJECTILE_ORIGIN.y);
  });

  it('accelerates distance, downward travel, and scale across each perspective quarter', () => {
    const trajectory = createTunnelTrajectory(
      { x: 270, y: -100 },
      { x: 0, y: 250 },
      18,
      { x: 270, y: 820 },
    );
    const depths = [0, 0.25, 0.5, 0.75, 1];
    const samples = depths.map((depth) => sampleTunnelProjection(
      trajectory,
      {
        x: trajectory.spawn.x
          + (trajectory.approachPoint.x - trajectory.spawn.x) * depth,
        y: trajectory.spawn.y
          + (trajectory.approachPoint.y - trajectory.spawn.y) * depth,
      },
    ));
    const distances = samples.map((sample) => sample.radialDistance);
    const ys = samples.map((sample) => sample.position.y);
    const scales = depths.map((depth) => calculateTunnelDepthPose('paper', depth).scale);
    const increments = (values: number[]): number[] => values
      .slice(1)
      .map((value, index) => value - values[index]!);

    expect(ys[0]).toBeCloseTo(BOSS_PROJECTILE_ORIGIN.y);
    expect(ys[4]).toBeCloseTo(820);
    expect(increments(distances)[0]).toBeGreaterThan(50);
    expect(increments(distances)).toEqual([...increments(distances)].sort((a, b) => a - b));
    expect(increments(ys)).toEqual([...increments(ys)].sort((a, b) => a - b));
    expect(increments(scales)).toEqual([...increments(scales)].sort((a, b) => a - b));
  });

  it('advances depth monotonically even if a homing collider briefly turns', () => {
    const trajectory = createTunnelTrajectory(
      { x: 75, y: -65 },
      { x: 130, y: 170 },
      18,
    );
    const first = sampleTunnelProjection(trajectory, { x: 110, y: 10 });
    const second = sampleTunnelProjection(trajectory, { x: 155, y: 90 }, first.depth);
    const turned = sampleTunnelProjection(trajectory, { x: 145, y: 82 }, second.depth);

    expect(second.depth).toBeGreaterThan(first.depth);
    expect(turned.depth).toBe(second.depth);
    expect(second.radialDistance).toBeGreaterThan(first.radialDistance);
  });

  it('blends a homing turn into the near plane without a final-frame position snap', () => {
    const trajectory = createTunnelTrajectory(
      { x: 75, y: -65 },
      { x: 130, y: 170 },
      18,
    );
    const almostDepth = 0.985;
    const deviationX = -trajectory.directionY * 58;
    const deviationY = trajectory.directionX * 58;
    const almostCollider = {
      x: trajectory.spawn.x
        + (trajectory.nearPoint.x - trajectory.spawn.x) * almostDepth
        + deviationX,
      y: trajectory.spawn.y
        + (trajectory.nearPoint.y - trajectory.spawn.y) * almostDepth
        + deviationY,
    };
    const almost = sampleTunnelProjection(trajectory, almostCollider);
    const finalCollider = {
      x: trajectory.nearPoint.x + deviationX,
      y: trajectory.nearPoint.y + deviationY,
    };
    const final = sampleTunnelProjection(trajectory, finalCollider, almost.depth);

    expect(final.collisionActive).toBe(true);
    expect(Math.hypot(
      final.position.x - almost.position.x,
      final.position.y - almost.position.y,
    )).toBeLessThan(15);
  });

  it('shares the Boss lower-bezel vanishing point with non-linear floor depth rows', () => {
    expect(BOSS_PROJECTILE_ORIGIN).toEqual({ x: 270, y: 385 });
    const rows = Array.from({ length: 11 }, (_, index) => floorGridY(index + 1, 11, 900));
    const gaps = rows.map((row, index) => row - (rows[index - 1] ?? BOSS_PROJECTILE_ORIGIN.y));

    expect(rows.at(-1)).toBeCloseTo(900);
    expect(gaps[0]).toBeGreaterThan(0);
    expect(gaps).toEqual([...gaps].sort((a, b) => a - b));
    expect(gaps.at(-1)!).toBeGreaterThan(gaps[0]! * 3);
  });

  it('uses a stronger near-camera size ramp for each physical document kind', () => {
    expect(calculateTunnelDepthPose('paper', 1).scale).toBeCloseTo(1.65);
    expect(calculateTunnelDepthPose('returnable', 1).scale).toBeCloseTo(1.78);
    expect(calculateTunnelDepthPose('comment', 1).scale).toBeCloseTo(1.55);
    expect(calculateTunnelDepthPose('wall', 1).scale).toBeCloseTo(1.55);
    expect(calculateTunnelDepthPose('homing', 1).scale).toBeCloseTo(1.65);
  });

  it('builds a pooled 4x6 surface grid instead of one affine quad', () => {
    const grid = createProjectilePerspectiveGridData(40, 52, 4, 6);
    const vertexCount = 4 * 6 * 2 * 3;
    const projection = createProjectilePerspectiveProjection(
      { x: 175, y: 590 },
      96,
      124,
      0.86,
      { x: 100, y: 760 },
    );

    expect(grid.vertices).toHaveLength(vertexCount * 2);
    expect(grid.uvs).toHaveLength(vertexCount * 2);
    expect(grid.uvs.slice(0, 6)).toEqual([0, 1 / 6, 0, 0, 1 / 4, 1 / 6]);
    expect(Math.min(...grid.uvs)).toBe(0);
    expect(Math.max(...grid.uvs)).toBe(1);
    for (let index = 0; index < grid.uvs.length; index += 6) {
      const first = projectProjectilePerspectiveUv(
        projection,
        grid.uvs[index]!,
        grid.uvs[index + 1]!,
      );
      const second = projectProjectilePerspectiveUv(
        projection,
        grid.uvs[index + 2]!,
        grid.uvs[index + 3]!,
      );
      const third = projectProjectilePerspectiveUv(
        projection,
        grid.uvs[index + 4]!,
        grid.uvs[index + 5]!,
      );
      const signedArea = (second.x - first.x) * (third.y - first.y)
        - (second.y - first.y) * (third.x - first.x);
      expect(signedArea).toBeGreaterThan(0.0001);
    }
  });

  it('projects the texture centre onto the collider and keeps UV rows straight', () => {
    const projection = createProjectilePerspectiveProjection(
      { x: 175, y: 590 },
      96,
      124,
      0.86,
      { x: 100, y: 760 },
    );
    const centre = projectProjectilePerspectiveUv(projection, 0.5, 0.5);
    const lineDistance = (
      point: Readonly<{ x: number; y: number }>,
      start: Readonly<{ x: number; y: number }>,
      end: Readonly<{ x: number; y: number }>,
    ): number => Math.abs(
      (end.x - start.x) * (start.y - point.y)
        - (start.x - point.x) * (end.y - start.y),
    ) / Math.max(1e-9, Math.hypot(end.x - start.x, end.y - start.y));

    expect(centre.x).toBeCloseTo(0, 10);
    expect(centre.y).toBeCloseTo(0, 10);
    for (const u of [0.25, 0.5, 0.75]) {
      const start = projectProjectilePerspectiveUv(projection, u, 0);
      const end = projectProjectilePerspectiveUv(projection, u, 1);
      for (const v of [0.25, 0.5, 0.75]) {
        expect(lineDistance(
          projectProjectilePerspectiveUv(projection, u, v),
          start,
          end,
        )).toBeLessThan(0.000001);
      }
    }
  });

  it('keystones each document toward the Boss instead of only scaling a rectangle', () => {
    const far = calculateProjectilePerspectiveQuad(
      { x: 270, y: 700 },
      96,
      124,
      0,
    );
    const near = calculateProjectilePerspectiveQuad(
      { x: 270, y: 700 },
      96,
      124,
      1,
    );
    const edgeLength = (
      first: Readonly<{ x: number; y: number }>,
      second: Readonly<{ x: number; y: number }>,
    ): number => Math.hypot(second.x - first.x, second.y - first.y);
    const farTop = edgeLength(far.topLeft, far.topRight);
    const farBottom = edgeLength(far.bottomLeft, far.bottomRight);
    const nearTop = edgeLength(near.topLeft, near.topRight);
    const nearBottom = edgeLength(near.bottomLeft, near.bottomRight);

    expect(farTop).toBeLessThan(farBottom);
    expect(nearTop).toBeLessThan(nearBottom);
    expect(nearTop / nearBottom).toBeCloseTo(farTop / farBottom, 10);
    // A straight-down shot stays upright: it is a trapezoid, not a rotated
    // sprite. Perspective correctly shifts the arithmetic corner average;
    // the projected texture centre itself remains on the collider.
    expect(near.topLeft.y).toBeCloseTo(near.topRight.y, 10);
    expect(near.bottomLeft.y).toBeCloseTo(near.bottomRight.y, 10);
    const projection = createProjectilePerspectiveProjection(
      { x: 270, y: 700 },
      96,
      124,
      1,
    );
    expect(projectProjectilePerspectiveUv(projection, 0.5, 0.5)).toEqual({ x: 0, y: 0 });
    expect([
      near.topLeft,
      near.topRight,
      near.bottomRight,
      near.bottomLeft,
    ].reduce((sum, corner) => sum + corner.y, 0)).not.toBeCloseTo(0, 2);
  });

  it('uses the authored Boss ray when the card is still on the vanishing point', () => {
    const quad = calculateProjectilePerspectiveQuad(
      BOSS_PROJECTILE_ORIGIN,
      48,
      62,
      0.2,
      { x: 440, y: 780 },
    );
    const corners = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];

    expect(corners.every((corner) => Number.isFinite(corner.x) && Number.isFinite(corner.y)))
      .toBe(true);
    expect(quad.topRight.x + quad.topRight.y).not.toBeCloseTo(
      -(quad.bottomLeft.x + quad.bottomLeft.y),
      5,
    );
  });

  it('gives left and right lanes visibly opposite 3D yaw with zero roll', () => {
    const left = calculateProjectilePerspectiveQuad(
      { x: 175, y: 590 },
      96,
      124,
      0.72,
      { x: 100, y: 760 },
    );
    const right = calculateProjectilePerspectiveQuad(
      { x: 365, y: 590 },
      96,
      124,
      0.72,
      { x: 440, y: 760 },
    );
    const center = calculateProjectilePerspectiveQuad(
      { x: 270, y: 590 },
      96,
      124,
      0.72,
      { x: 270, y: 760 },
    );
    const edgeLength = (
      first: Readonly<{ x: number; y: number }>,
      second: Readonly<{ x: number; y: number }>,
    ): number => Math.hypot(second.x - first.x, second.y - first.y);
    const leftOuterEdge = edgeLength(left.topLeft, left.bottomLeft);
    const leftInnerEdge = edgeLength(left.topRight, left.bottomRight);
    const rightInnerEdge = edgeLength(right.topLeft, right.bottomLeft);
    const rightOuterEdge = edgeLength(right.topRight, right.bottomRight);
    const centerLeftEdge = edgeLength(center.topLeft, center.bottomLeft);
    const centerRightEdge = edgeLength(center.topRight, center.bottomRight);

    // Each card opens its inner edge toward the Boss ray. Mirrored screen
    // lanes therefore expose mirrored card faces rather than reusing one 2D
    // shape with the left/right deformation accidentally reversed.
    expect(leftInnerEdge).toBeGreaterThan(leftOuterEdge * 1.18);
    expect(rightInnerEdge).toBeGreaterThan(rightOuterEdge * 1.18);
    expect(leftInnerEdge).toBeCloseTo(rightInnerEdge, 8);
    expect(leftOuterEdge).toBeCloseTo(rightOuterEdge, 8);
    expect(left.topLeft.x).toBeCloseTo(-right.topRight.x, 8);
    expect(left.topLeft.y).toBeCloseTo(right.topRight.y, 8);
    expect(left.bottomLeft.x).toBeCloseTo(-right.bottomRight.x, 8);
    expect(left.bottomLeft.y).toBeCloseTo(right.bottomRight.y, 8);

    // The centre lane has pitch but no yaw/roll, so its two side edges remain
    // equal and the document does not become a rotated 2D sprite.
    expect(centerLeftEdge).toBeCloseTo(centerRightEdge, 10);
    expect(center.topLeft.y).toBeCloseTo(center.topRight.y, 10);
    expect(center.bottomLeft.y).toBeCloseTo(center.bottomRight.y, 10);
  });

  it('keeps the lane-corrected plane orientation fixed throughout flight', () => {
    const reference = { x: 92, y: 790 };
    const far = calculateProjectilePerspectiveQuad(
      BOSS_PROJECTILE_ORIGIN,
      96,
      124,
      0.08,
      reference,
    );
    const near = calculateProjectilePerspectiveQuad(
      { x: 92, y: 790 },
      96,
      124,
      1,
      reference,
    );
    const edgeLength = (
      first: Readonly<{ x: number; y: number }>,
      second: Readonly<{ x: number; y: number }>,
    ): number => Math.hypot(second.x - first.x, second.y - first.y);
    const innerEdgeRatio = (quad: typeof far): number => (
      edgeLength(quad.topRight, quad.bottomRight)
      / edgeLength(quad.topLeft, quad.bottomLeft)
    );

    expect(innerEdgeRatio(far)).toBeGreaterThan(1);
    expect(innerEdgeRatio(near)).toBeCloseTo(innerEdgeRatio(far), 10);
  });

  it('keeps a far authored point separate before converging on the near point', () => {
    const spawn = { x: 270, y: 155 };
    const velocity = { x: 0, y: 300 };
    const trajectory = createTunnelTrajectory(spawn, velocity, 22);
    const before = sampleTunnelProjection(trajectory, { x: 270, y: 330 });
    const atEntry = sampleTunnelProjection(trajectory, trajectory.nearPoint, before.depth);

    expect(before.collisionActive).toBe(false);
    expect(before.position).not.toEqual({ x: 270, y: 330 });
    expect(atEntry.depth).toBe(1);
    expect(atEntry.collisionActive).toBe(true);
    expect(atEntry.position.x).toBeCloseTo(trajectory.nearPoint.x, 10);
    expect(atEntry.position.y).toBeCloseTo(trajectory.nearPoint.y, 10);
  });

  it('activates contact as the projected ray reaches the upper player arena', () => {
    const trajectory = createTunnelTrajectory(
      { x: 270, y: 155 },
      { x: 0, y: 300 },
      18,
      { x: 390, y: 820 },
      1_000,
    );
    const sampleAt = (depth: number) => sampleTunnelProjection(
      trajectory,
      {
        x: trajectory.spawn.x
          + (trajectory.approachPoint.x - trajectory.spawn.x) * depth,
        y: trajectory.spawn.y
          + (trajectory.approachPoint.y - trajectory.spawn.y) * depth,
      },
    );
    const before = sampleAt(trajectory.contactDepth - 0.001);
    const contact = sampleAt(trajectory.contactDepth);
    const approaching = sampleAt(0.95);

    expect(before.collisionActive).toBe(false);
    expect(contact.collisionActive).toBe(true);
    expect(approaching.collisionActive).toBe(true);
    expect(contact.position).not.toEqual(trajectory.nearPoint);
    expect(approaching.position.y).toBeGreaterThan(contact.position.y);
    expect(approaching.depth).toBeLessThan(1);
    expect(contact.position.y).toBeCloseTo(412, 6);
    expect(trajectory.contactDepth).toBeLessThan(PROJECTILE_CONTACT_DEPTH);
  });

  it('uses the same depth ray for top, side, and wall-style spawns', () => {
    const trajectories = [
      createTunnelTrajectory({ x: 90, y: -120 }, { x: 14, y: 230 }, 18),
      createTunnelTrajectory({ x: -170, y: 650 }, { x: 275, y: 0 }, 28),
      createTunnelTrajectory({ x: 710, y: 760 }, { x: -225, y: 0 }, 27),
    ];

    for (const trajectory of trajectories) {
      const spawnProjection = sampleTunnelProjection(trajectory, trajectory.spawn);
      expect(spawnProjection.position.x).toBeCloseTo(BOSS_PROJECTILE_ORIGIN.x, 10);
      expect(spawnProjection.position.y).toBeCloseTo(BOSS_PROJECTILE_ORIGIN.y, 10);
      expect(spawnProjection.collisionActive).toBe(false);
      expect(trajectory.approachLength).toBeGreaterThan(0);
    }
  });

  it('continues paper-rain through the near plane on its Boss-origin radial ray', () => {
    const trajectory = createTunnelTrajectory(
      { x: 88, y: -120 },
      { x: -18, y: 240 },
      18,
    );
    const velocity = radialNearPlaneVelocity(trajectory, 240);
    const bossToNear = {
      x: trajectory.nearPoint.x - BOSS_PROJECTILE_ORIGIN.x,
      y: trajectory.nearPoint.y - BOSS_PROJECTILE_ORIGIN.y,
    };
    const cross = bossToNear.x * velocity.y - bossToNear.y * velocity.x;

    expect(Math.hypot(velocity.x, velocity.y)).toBeCloseTo(240);
    expect(Math.abs(velocity.x)).toBeGreaterThan(20);
    expect(Math.abs(cross)).toBeLessThan(1e-8);
    expect(Math.sign(velocity.x)).toBe(Math.sign(bossToNear.x));
    expect(velocity.y).toBeGreaterThan(0);
  });

  it('does not resume legacy flat side-scroll motion after perspective convergence', () => {
    const trajectory = createTunnelTrajectory(
      { x: -170, y: 650 },
      { x: 280, y: 0 },
      28,
    );
    const velocity = radialNearPlaneVelocity(trajectory, 280);

    expect(velocity.x).toBeLessThan(0);
    expect(velocity.y).toBeGreaterThan(0);
    expect(velocity.y).not.toBe(0);
  });

  it('keeps all five physical kinds threatening after the near-plane hand-off', () => {
    const configs: ProjectileConfig[] = [
      planPaperRain(new SeededRng(11), 2, 1, 270)[0]!,
      planReturnableBurst(new SeededRng(12), 2, 0, 1, { x: 270, y: 720 })
        .projectiles.find((projectile) => projectile.kind === 'returnable')!,
      planCommentCrossfire(new SeededRng(13), 3, 1)
        .projectiles[0]!,
      planClosingWalls(new SeededRng(14), 3, 1, 650).projectiles[0]!,
      planRevisionHoming(new SeededRng(15), 3, 1)[0]!,
    ];

    for (const config of configs) verifyNearPlaneTraversal(config);
  });

  it('carries side-authored comment and wall rays across an edge lane before exiting', () => {
    const sideConfigs = [
      planCommentCrossfire(new SeededRng(21), 1, 1)
        .projectiles[0]!,
      planClosingWalls(new SeededRng(22), 3, 1, 739.2).projectiles
        .find((projectile) => projectile.x < 0 && projectile.y > 739.2)!,
    ];

    for (const config of sideConfigs) {
      const radius = config.radius ?? 18;
      const trajectory = createTunnelTrajectory(
        { x: config.x, y: config.y },
        { x: config.vx, y: config.vy },
        radius,
        config.perspectiveTarget,
        config.perspectiveDurationMs,
        config.perspectiveOrigin,
      );
      const velocity = radialNearPlaneVelocity(trajectory, Math.hypot(config.vx, config.vy));

      expect(trajectory.nearPoint.y).toBeGreaterThanOrEqual(430);
      expect(Math.sign(velocity.x)).toBe(Math.sign(config.vx));
      expect(Math.sign(velocity.y)).toBe(Math.sign(config.vy));
      verifyNearPlaneTraversal(config);
    }
  });

  it('keeps paper deep while placing the returnable at the player current height', () => {
    const paper = planPaperRain(new SeededRng(31), 3, 1, 270)[0]!;
    const returnable = planReturnableBurst(
      new SeededRng(32),
      3,
      0,
      1,
      { x: 270, y: 720 },
    ).projectiles.find((projectile) => projectile.kind === 'returnable')!;

    for (const config of [paper, returnable]) {
      const trajectory = createTunnelTrajectory(
        { x: config.x, y: config.y },
        { x: config.vx, y: config.vy },
        config.radius ?? 18,
        config.perspectiveTarget,
        config.perspectiveDurationMs,
        config.perspectiveOrigin,
      );
      if (config.kind === 'returnable') expect(trajectory.nearPoint.y).toBe(720);
      else expect(trajectory.nearPoint.y).toBeGreaterThanOrEqual(800);
      expect(trajectory.approachLength / Math.hypot(config.vx, config.vy)).toBeLessThan(2.8);
      verifyNearPlaneTraversal(config);
    }
  });

  it('keeps depth timing deterministic across paper rain and the staged returnable wave', () => {
    const paperA = planPaperRain(new SeededRng(91), 3, 1, 270);
    const paperB = planPaperRain(new SeededRng(91), 3, 1, 270);
    const burstA = planReturnableBurst(
      new SeededRng(92),
      3,
      2,
      1,
      { x: 270, y: 720 },
    );
    const burstB = planReturnableBurst(
      new SeededRng(92),
      3,
      2,
      1,
      { x: 270, y: 720 },
    );
    const durations = (configs: readonly ProjectileConfig[]): number[] => configs
      .map((config) => config.perspectiveDurationMs ?? 0);
    const depthBandsAt1200ms = (configs: readonly ProjectileConfig[]): Set<number> => new Set(
      durations(configs).map((duration) => Math.round(Math.min(1, 1_200 / duration) * 10)),
    );

    expect(durations(paperA)).toEqual(durations(paperB));
    expect(durations(burstA.openingProjectiles)).toEqual(
      durations(burstB.openingProjectiles),
    );
    expect(durations(burstA.returnableProjectiles)).toEqual(
      durations(burstB.returnableProjectiles),
    );
    expect(new Set(durations(paperA)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(durations(burstA.openingProjectiles)).size).toBeGreaterThanOrEqual(3);
    expect(depthBandsAt1200ms(paperA).size).toBeGreaterThanOrEqual(3);
    for (const duration of durations(paperA)) {
      expect(duration).toBeGreaterThanOrEqual(1_400);
      expect(duration).toBeLessThanOrEqual(2_800);
    }
    for (const duration of durations(burstA.openingProjectiles)) {
      expect(duration).toBeGreaterThanOrEqual(650);
      expect(duration).toBeLessThan(RETURNABLE_OPENING_CLEAR_MS);
    }
    expect(durations(burstA.returnableProjectiles)).toHaveLength(2);
    expect(durations(burstA.returnableProjectiles)[0]).toBeGreaterThanOrEqual(1_400);
    expect(durations(burstA.returnableProjectiles)[0]).toBeLessThanOrEqual(1_500);
  });
});

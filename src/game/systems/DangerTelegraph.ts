import type { PatternId } from '../../ai/bossSchema';
import { DODGE_AREA_TOP, DODGE_AREA_BOTTOM } from '../constants';
import { BEAM_HALF_THICKNESS, beamSegment, type BeamLayout } from '../patterns/deadlineBeam';
import {
  BOSS_PROJECTILE_ORIGIN,
  calculateTunnelContactDepth,
  projectileDepthExpansion,
  projectTunnelTargetAtDepth,
  type ProjectileDepthPoint,
} from './ProjectileDepth';

export const COMBAT_ARENA = Object.freeze({
  // Overscan both sides so the projected warning continues beneath the
  // viewport crop. The player can no longer read either screen edge as a
  // permanently unthreatened strip.
  x: -90,
  y: DODGE_AREA_TOP,
  width: 720,
  height: DODGE_AREA_BOTTOM - DODGE_AREA_TOP,
});

export interface SafeLaneHint {
  axis: 'vertical' | 'horizontal';
  center: number;
  halfWidth: number;
  /** Top-origin attacks use a screen-aligned corridor instead of the floor vanishing point. */
  projection?: 'perspective' | 'screen';
}

export interface DangerRectHint {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  projection?: 'perspective' | 'screen';
}

export interface DangerTargetHint {
  kind: 'target';
  x: number;
  y: number;
  radius: number;
}

export interface DangerRayHint {
  kind: 'ray';
  from: ProjectileDepthPoint;
  to: ProjectileDepthPoint;
  halfWidth: number;
}

export interface SafeSpotHint {
  kind: 'safe';
  x: number;
  y: number;
  radius: number;
}

export type DangerZoneHint = DangerRectHint | DangerTargetHint | DangerRayHint | SafeSpotHint;

export interface DangerPerspectiveQuad {
  readonly topLeft: ProjectileDepthPoint;
  readonly topRight: ProjectileDepthPoint;
  readonly bottomRight: ProjectileDepthPoint;
  readonly bottomLeft: ProjectileDepthPoint;
}

export interface DangerRayHatchSegment {
  readonly start: ProjectileDepthPoint;
  readonly end: ProjectileDepthPoint;
}

export interface DangerTargetCone {
  readonly originLeft: ProjectileDepthPoint;
  readonly originRight: ProjectileDepthPoint;
  readonly targetRight: ProjectileDepthPoint;
  readonly targetLeft: ProjectileDepthPoint;
}

export interface HorizontalSafeWedgeBounds {
  readonly left: number;
  readonly right: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Converts the reserved safe lane to its attacked complement. The safe lane is
 * deliberately absent from the result, so presentation code cannot
 * accidentally fill it as if it were dangerous.
 */
export function dangerRectsOutsideSafeLane(hint: SafeLaneHint): DangerRectHint[] {
  const right = COMBAT_ARENA.x + COMBAT_ARENA.width;
  const bottom = COMBAT_ARENA.y + COMBAT_ARENA.height;
  const projection = hint.projection === 'screen'
    ? { projection: 'screen' as const }
    : {};

  if (hint.axis === 'vertical') {
    const safeLeft = clamp(hint.center - hint.halfWidth, COMBAT_ARENA.x, right);
    const safeRight = clamp(hint.center + hint.halfWidth, COMBAT_ARENA.x, right);
    const zones: DangerRectHint[] = [
      {
        kind: 'rect',
        x: COMBAT_ARENA.x,
        y: COMBAT_ARENA.y,
        width: Math.max(0, safeLeft - COMBAT_ARENA.x),
        height: COMBAT_ARENA.height,
        ...projection,
      },
      {
        kind: 'rect',
        x: safeRight,
        y: COMBAT_ARENA.y,
        width: Math.max(0, right - safeRight),
        height: COMBAT_ARENA.height,
        ...projection,
      },
    ];
    return zones.filter((rect) => rect.width > 0);
  }

  const safeTop = clamp(hint.center - hint.halfWidth, COMBAT_ARENA.y, bottom);
  const safeBottom = clamp(hint.center + hint.halfWidth, COMBAT_ARENA.y, bottom);
  const zones: DangerRectHint[] = [
    {
      kind: 'rect',
      x: COMBAT_ARENA.x,
      y: COMBAT_ARENA.y,
      width: COMBAT_ARENA.width,
      height: Math.max(0, safeTop - COMBAT_ARENA.y),
      ...projection,
    },
    {
      kind: 'rect',
      x: COMBAT_ARENA.x,
      y: safeBottom,
      width: COMBAT_ARENA.width,
      height: Math.max(0, bottom - safeBottom),
      ...projection,
    },
  ];
  return zones.filter((rect) => rect.height > 0);
}

/** Screen-space edges of a vertical lane after the floor-perspective projection. */
export function verticalSafeWedgeBoundsAtY(
  hint: Pick<SafeLaneHint, 'center' | 'halfWidth'>,
  y: number,
  vanishingPoint: ProjectileDepthPoint = BOSS_PROJECTILE_ORIGIN,
): HorizontalSafeWedgeBounds {
  const arenaRight = COMBAT_ARENA.x + COMBAT_ARENA.width;
  const safeLeft = clamp(hint.center - hint.halfWidth, COMBAT_ARENA.x, arenaRight);
  const safeRight = clamp(hint.center + hint.halfWidth, COMBAT_ARENA.x, arenaRight);
  return {
    left: projectFloorPoint({ x: safeLeft, y }, vanishingPoint).x,
    right: projectFloorPoint({ x: safeRight, y }, vanishingPoint).x,
  };
}

/**
 * Moves an authored near target just far enough into its telegraphed danger
 * side that the complete gameplay collision circle clears the dark safe wedge
 * as soon as collision activates. Both the projectile ray and wedge expand
 * monotonically from the same vanishing point, so this earliest active depth
 * is the minimum-clearance point for the vertical attacks that use this helper.
 */
export function clearVerticalSafeWedgeForTunnelTarget(
  target: ProjectileDepthPoint,
  hint: Pick<SafeLaneHint, 'center' | 'halfWidth'>,
  side: -1 | 1,
  collisionClearance: number,
  contactDepth?: number,
): ProjectileDepthPoint {
  const resolvedContactDepth = contactDepth ?? calculateTunnelContactDepth(
    BOSS_PROJECTILE_ORIGIN,
    target,
  );
  const expansion = projectileDepthExpansion(resolvedContactDepth);
  if (expansion <= 0) return { ...target };

  const projected = projectTunnelTargetAtDepth(target, resolvedContactDepth);
  const wedge = verticalSafeWedgeBoundsAtY(hint, projected.y);
  const requiredProjectedX = side < 0
    ? wedge.left - Math.max(0, collisionClearance)
    : wedge.right + Math.max(0, collisionClearance);
  const correction = side < 0
    ? Math.min(0, requiredProjectedX - projected.x)
    : Math.max(0, requiredProjectedX - projected.x);

  return {
    x: target.x + correction / expansion,
    y: target.y,
  };
}

export function dangerZonesForPattern(
  pattern: PatternId,
  safeLane: SafeLaneHint | undefined,
  playerPosition: { x: number; y: number } | undefined,
  deadlineBeams: readonly BeamLayout[] = [],
): DangerZoneHint[] {
  if (safeLane) return dangerRectsOutsideSafeLane(safeLane);

  if (pattern === 'deadline_beam') {
    return deadlineBeams.map((layout) => {
      const segment = beamSegment(layout);
      return {
        kind: 'ray' as const,
        from: segment.start,
        to: segment.end,
        halfWidth: BEAM_HALF_THICKNESS + 5,
      };
    });
  }

  if (pattern === 'revision_homing' && playerPosition) {
    return [{
      kind: 'target',
      x: clamp(playerPosition.x, COMBAT_ARENA.x, COMBAT_ARENA.x + COMBAT_ARENA.width),
      y: clamp(playerPosition.y, COMBAT_ARENA.y, COMBAT_ARENA.y + COMBAT_ARENA.height),
      radius: 52,
    }];
  }

  return [];
}

/**
 * Projects an authored screen-space danger rectangle onto the floor plane.
 * The x coordinate contracts linearly as y approaches the Boss origin, so
 * each side edge is a true ray through the same vanishing point used by the
 * projectile tunnel and background grid.
 */
export function projectDangerRectToVanishingQuad(
  rect: DangerRectHint,
  vanishingPoint: ProjectileDepthPoint = BOSS_PROJECTILE_ORIGIN,
): DangerPerspectiveQuad {
  const top = rect.y;
  const bottom = rect.y + rect.height;
  return {
    topLeft: projectFloorPoint({ x: rect.x, y: top }, vanishingPoint),
    topRight: projectFloorPoint({ x: rect.x + rect.width, y: top }, vanishingPoint),
    bottomRight: projectFloorPoint({ x: rect.x + rect.width, y: bottom }, vanishingPoint),
    bottomLeft: projectFloorPoint({ x: rect.x, y: bottom }, vanishingPoint),
  };
}

/**
 * Samples one longitudinal hatch from a projected warning quad. Reusing the
 * same authored fraction on both depth edges is essential: any offset between
 * them creates a screen-space diagonal that no longer passes through the
 * shared Boss vanishing point and visibly disagrees with the floor grid.
 */
export function projectDangerRayHatch(
  quad: DangerPerspectiveQuad,
  fraction: number,
): DangerRayHatchSegment {
  const rayFraction = clamp(fraction, 0, 1);
  return {
    start: {
      x: quad.topLeft.x + (quad.topRight.x - quad.topLeft.x) * rayFraction,
      y: quad.topLeft.y + (quad.topRight.y - quad.topLeft.y) * rayFraction,
    },
    end: {
      x: quad.bottomLeft.x + (quad.bottomRight.x - quad.bottomLeft.x) * rayFraction,
      y: quad.bottomLeft.y + (quad.bottomRight.y - quad.bottomLeft.y) * rayFraction,
    },
  };
}

/** A directional target cue whose two sides open from the Boss to the target. */
export function projectDangerTargetCone(
  target: DangerTargetHint,
  vanishingPoint: ProjectileDepthPoint = BOSS_PROJECTILE_ORIGIN,
): DangerTargetCone {
  const deltaX = target.x - vanishingPoint.x;
  const deltaY = target.y - vanishingPoint.y;
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  const directionX = deltaX / distance;
  const directionY = deltaY / distance;
  const perpendicularX = -directionY;
  const perpendicularY = directionX;
  const originOffset = Math.min(12, distance * 0.12);
  const originHalfWidth = Math.max(2.5, target.radius * 0.07);
  const targetHalfWidth = target.radius;
  const originCenter = {
    x: vanishingPoint.x + directionX * originOffset,
    y: vanishingPoint.y + directionY * originOffset,
  };

  return {
    originLeft: {
      x: originCenter.x - perpendicularX * originHalfWidth,
      y: originCenter.y - perpendicularY * originHalfWidth,
    },
    originRight: {
      x: originCenter.x + perpendicularX * originHalfWidth,
      y: originCenter.y + perpendicularY * originHalfWidth,
    },
    targetRight: {
      x: target.x + perpendicularX * targetHalfWidth,
      y: target.y + perpendicularY * targetHalfWidth,
    },
    targetLeft: {
      x: target.x - perpendicularX * targetHalfWidth,
      y: target.y - perpendicularY * targetHalfWidth,
    },
  };
}

function projectFloorPoint(
  point: ProjectileDepthPoint,
  vanishingPoint: ProjectileDepthPoint,
): ProjectileDepthPoint {
  const floorBottom = COMBAT_ARENA.y + COMBAT_ARENA.height;
  const depth = clamp(
    (point.y - vanishingPoint.y) / Math.max(1, floorBottom - vanishingPoint.y),
    0,
    1,
  );
  return {
    x: vanishingPoint.x + (point.x - vanishingPoint.x) * depth,
    y: Math.max(point.y, vanishingPoint.y),
  };
}

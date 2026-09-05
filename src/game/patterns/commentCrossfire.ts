import type { SeededRng } from '../../utils/rng';
import { GAME_WIDTH, GAME_HEIGHT, DODGE_AREA_TOP, PLAYER_MIN_X, PLAYER_MAX_X, PLAYER_MIN_Y, PLAYER_MAX_Y } from '../constants';
import type { ProjectileConfig } from '../entities/Projectile';
import type { ProjectileSystem } from '../systems/ProjectileSystem';
import { clipLineToBounds } from '../systems/LineGeometry';
import { reachableSafeSpot, type PlayerPosition } from './fairness';
import {
  createPatternTimeline,
  fitEmissionTimes,
  staggeredSpawnEvents,
  type AttackPatternContext,
  type AttackPatternHandle,
} from './types';

const FALLBACK_COMMENTS = ['這裡對齊', '字再大一點', '再改一下', '今天要上', '最終版呢'] as const;
export const COMMENT_SAFE_SPOT_RADIUS = 26;
// 以角色與文件的完整輪廓保留空間，不能只拿固定碰撞圓判斷安全。
export const COMMENT_CLEARANCE_X = 138;
export const COMMENT_CLEARANCE_Y = 96;
const PLAY_BOUNDS = { left: PLAYER_MIN_X, right: PLAYER_MAX_X, top: PLAYER_MIN_Y, bottom: PLAYER_MAX_Y };
const SOURCE_BOUNDS = { left: -60, right: GAME_WIDTH + 60, top: DODGE_AREA_TOP - 120, bottom: GAME_HEIGHT + 80 };

export function commentCrossfireLayout(rng: SeededRng, intensity: 1 | 2 | 3, player?: PlayerPosition) {
  const safeSpot = reachableSafeSpot(rng, player, COMMENT_SAFE_SPOT_RADIUS);
  const candidates = [];
  for (let baseAngle = 0; baseAngle < 360; baseAngle += 15) {
    const angle = baseAngle + (baseAngle % 90 === 0 ? 0 : rng.range(-4, 4));
    const radians = angle * Math.PI / 180;
    const unit = { x: Math.cos(radians), y: Math.sin(radians) };
    const normal = { x: -unit.y, y: unit.x };
    for (const x of [62, 145, 270, 395, 478]) {
      for (const y of [PLAYER_MIN_Y + 4, (PLAYER_MIN_Y + PLAYER_MAX_Y) / 2, PLAYER_MAX_Y - 4]) {
        const anchor = { x, y };
        const distance = Math.abs((safeSpot.x - x) * normal.x + (safeSpot.y - y) * normal.y);
        const clearance = Math.abs(normal.x) * COMMENT_CLEARANCE_X
          + Math.abs(normal.y) * COMMENT_CLEARANCE_Y + safeSpot.radius + 4;
        if (distance < clearance) continue;
        const segment = clipLineToBounds(anchor, unit, PLAY_BOUNDS)!;
        const length = Math.hypot(segment.exit.x - segment.entry.x, segment.exit.y - segment.entry.y);
        if (length < 100) continue;
        const source = clipLineToBounds(anchor, unit, SOURCE_BOUNDS)!;
        const sourceEdge = Math.abs(source.entry.x - SOURCE_BOUNDS.left) < 1e-6 ? 'left'
          : Math.abs(source.entry.x - SOURCE_BOUNDS.right) < 1e-6 ? 'right'
            : Math.abs(source.entry.y - SOURCE_BOUNDS.top) < 1e-6 ? 'top' : 'bottom';
        const target = { x: segment.entry.x + unit.x * 28, y: segment.entry.y + unit.y * 28 };
        candidates.push({
          direction: sourceEdge,
          angle,
          origin: source.entry,
          target,
          warning: {
            kind: 'ray' as const,
            from: source.entry,
            to: source.exit,
            halfWidth: Math.abs(normal.x) * 58 + Math.abs(normal.y) * 26 + 6,
          },
        });
      }
    }
  }
  // 先篩掉會封死避難點的射線，再隨機選來源和角度；同一波不依序輪流發射。
  const pool = rng.shuffled(candidates);
  const rays = [pool[0]!];
  const count = intensity === 3 && rng.chance(0.5) ? 3 : 2;
  while (rays.length < count) {
    const available = pool.filter((candidate) => rays.every((ray) => ray.direction !== candidate.direction));
    const diverse = available.find((candidate) => rays.every((ray) => {
      const difference = Math.abs(candidate.angle - ray.angle) % 180;
      return Math.min(difference, 180 - difference) >= 20;
    }));
    const next = diverse ?? available[0];
    if (!next) break;
    rays.push(next);
  }
  return { rays, safeSpot };
}

export interface CommentCrossfirePlan {
  readonly layout: ReturnType<typeof commentCrossfireLayout>;
  readonly projectiles: readonly ProjectileConfig[];
}

export function planCommentCrossfire(
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  speedScale: number,
  commentLines: readonly string[] = FALLBACK_COMMENTS,
  layout = commentCrossfireLayout(rng, intensity),
): CommentCrossfirePlan {
  const speed = (235 + intensity * 20) * speedScale;
  const comments = commentLines.length > 0 ? commentLines : FALLBACK_COMMENTS;
  // 同一組安全射線分兩批發射，增加文件但不增加封路方向。
  const projectiles = [...layout.rays, ...layout.rays].map((ray): ProjectileConfig => {
    const dx = ray.target.x - ray.origin.x;
    const dy = ray.target.y - ray.origin.y;
    const length = Math.hypot(dx, dy);
    return {
      kind: 'comment',
      x: ray.origin.x,
      y: ray.origin.y,
      vx: dx / length * speed,
      vy: dy / length * speed,
      radius: 28,
      text: rng.pick(comments),
      perspectiveOrigin: ray.origin,
      perspectiveTarget: ray.target,
      perspectiveDurationMs: Math.max(1_100, Math.round(1_650 / Math.max(0.1, speedScale))),
    };
  });
  return { layout, projectiles };
}

export function spawnCommentCrossfire(
  projectiles: ProjectileSystem,
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  speedScale: number,
  commentLines?: readonly string[],
): void {
  const plan = planCommentCrossfire(rng, intensity, speedScale, commentLines);
  for (const config of plan.projectiles) projectiles.spawn(config);
}

export function runCommentCrossfire(
  context: AttackPatternContext,
  layout?: ReturnType<typeof commentCrossfireLayout>,
): AttackPatternHandle {
  const plan = planCommentCrossfire(
    context.rng,
    context.intensity,
    context.speedScale,
    context.commentLines,
    layout,
  );
  const times = fitEmissionTimes(plan.projectiles.map((_, index) =>
    index < plan.layout.rays.length ? 0 : 460), context.durationMs,
  Math.max(...plan.projectiles.map((card) => card.perspectiveDurationMs!)) + 120);
  return createPatternTimeline(context.durationMs,
    staggeredSpawnEvents(context.projectiles, plan.projectiles, 0)
      .map((event, index) => ({ ...event, atMs: times[index]! })));
}

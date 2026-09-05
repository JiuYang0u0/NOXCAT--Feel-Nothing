import type { SeededRng } from '../../utils/rng';
import {
  DEADLINE_BEAM_TELEGRAPH_MS,
  GAME_WIDTH,
  PLAYER_MIN_X,
  PLAYER_MAX_X,
  PLAYER_MIN_Y,
  PLAYER_MAX_Y,
} from '../constants';
import { distanceToLineSegment } from '../systems/CollisionMath';
import { DODGE_BODY_CLEARANCE, reachableSafeSpot, type PlayerPosition } from './fairness';
import type { ProjectileSystem } from '../systems/ProjectileSystem';
import { planPaperRain } from './paperRain';
import {
  createPatternTimeline,
  type AttackPatternContext,
  type AttackPatternHandle,
} from './types';

export const BEAM_HALF_THICKNESS = 17;
export const BEAM_LENGTH = 780;

const BEAM_ANGLES = [0, Math.PI / 2, Math.PI / 4, (3 * Math.PI) / 4] as const;

export interface BeamLayout {
  readonly x: number;
  readonly y: number;
  /** 0 = 水平向右，π/2 = 垂直向下。 */
  readonly angle: number;
}

export function beamSegment(layout: BeamLayout): {
  readonly start: { x: number; y: number };
  readonly end: { x: number; y: number };
} {
  const cosine = Math.cos(layout.angle);
  const sine = Math.sin(layout.angle);
  const half = BEAM_LENGTH / 2;
  return {
    start: { x: layout.x - cosine * half, y: layout.y - sine * half },
    end: { x: layout.x + cosine * half, y: layout.y + sine * half },
  };
}

export function distanceToBeam(x: number, y: number, layout: BeamLayout): number {
  const segment = beamSegment(layout);
  return distanceToLineSegment({ x, y }, segment.start, segment.end);
}

/** 先保留可達避難點，再向場內偏移雷射；不以失敗重抽後的任意布局當 fallback。 */
export function planDeadlineBeams(
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  safeSpot: PlayerPosition = reachableSafeSpot(rng),
): BeamLayout[] {
  const count = intensity >= 3 ? 3 : intensity === 1 ? 2 : rng.int(2, 3);
  const midX = (PLAYER_MIN_X + PLAYER_MAX_X) / 2;
  const midY = (PLAYER_MIN_Y + PLAYER_MAX_Y) / 2;
  return rng.shuffled([...BEAM_ANGLES]).slice(0, count).map((angle) => {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const normal = { x: -sine, y: cosine };
    const towardCentre = (midX - safeSpot.x) * normal.x + (midY - safeSpot.y) * normal.y;
    const side = towardCentre < 0 ? -1 : 1;
    const offset = DODGE_BODY_CLEARANCE + BEAM_HALF_THICKNESS + 26 + rng.range(4, 18);
    const lineX = safeSpot.x + normal.x * offset * side;
    const lineY = safeSpot.y + normal.y * offset * side;
    // 沿雷射方向對齊活動區中心，有限線段才能蓋滿 dodge box；避難點只靠法線偏移。
    const along = (midX - lineX) * cosine + (midY - lineY) * sine;
    return { x: lineX + cosine * along, y: lineY + sine * along, angle };
  });
}

export function spawnDeadlineBeam(
  projectiles: ProjectileSystem,
  rng: SeededRng,
  planned?: readonly BeamLayout[] | number,
  telegraphMs = DEADLINE_BEAM_TELEGRAPH_MS,
): void {
  const beams = resolveBeams(rng, 1, planned);
  for (const beam of beams) projectiles.spawnBeam(beam, telegraphMs, 520);
}

export function runDeadlineBeam(
  context: AttackPatternContext,
  planned?: readonly BeamLayout[] | number,
  safeSpot?: PlayerPosition,
): AttackPatternHandle {
  const beams = resolveBeams(context.rng, context.intensity, planned);
  // 雷射結束後落下文件，沿用已預告避難點的 X 通道。
  const papers = safeSpot ? planPaperRain(context.rng, context.intensity, context.speedScale, safeSpot.x)
    .slice(0, 4 + context.intensity).map((card) => ({ ...card, perspectiveDurationMs: 1_200 })) : [];
  return createPatternTimeline(context.durationMs, [{
    atMs: 0,
    // AttackDirector owns the mandatory 750 ms warning phase.
    emit: () => {
      for (const beam of beams) context.projectiles.spawnBeam(beam, 0, 520);
    },
  }, ...papers.map((card, index) => ({
    atMs: 600 + index * 80,
    emit: () => { context.projectiles.spawn(card); },
  }))]);
}

function resolveBeams(
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  planned?: readonly BeamLayout[] | number,
): BeamLayout[] {
  if (Array.isArray(planned) && planned.length > 0) return [...planned];
  if (typeof planned === 'number') {
    return [{ x: GAME_WIDTH / 2, y: planned, angle: 0 }];
  }
  return planDeadlineBeams(rng, intensity);
}

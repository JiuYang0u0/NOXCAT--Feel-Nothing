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
  spawnConfigs,
  type AttackPatternContext,
  type AttackPatternHandle,
} from './types';

export const PULSE_BARRAGE_SAFE_LANE_HALF_WIDTH = 76;
export const PULSE_BARRAGE_GAP_MS = 980;

const PROJECTILE_RADIUS = 18;
// 旋轉文件與完整貓輪廓比固定碰撞圓寬，近景通道必須預留額外間距。
const SILHOUETTE_CLEARANCE = PROJECTILE_RADIUS + PLAYER_HIT_RADIUS + 32;

interface ColumnSpan {
  readonly minimum: number;
  readonly maximum: number;
}

export interface PulseBarrageFormation {
  readonly atMs: number;
  readonly projectiles: readonly ProjectileConfig[];
}

export interface PulseBarragePlan {
  readonly safeLaneX: number;
  readonly formations: readonly PulseBarrageFormation[];
}

/**
 * Splits the visible column range into the two hostile spans flanking the safe
 * lane. Pulse cards now fall straight down their own column, so any column
 * outside these spans would either sit inside the lane or never cross the
 * canvas at all — both are wasted threats.
 */
function hostileColumnSpans(safeLaneX: number): ColumnSpan[] {
  const exclusion = PULSE_BARRAGE_SAFE_LANE_HALF_WIDTH + SILHOUETTE_CLEARANCE;
  const inside = (value: number): number =>
    clamp(value, FALLING_ATTACK_MIN_X, FALLING_ATTACK_MAX_X);
  const spans = [
    { minimum: FALLING_ATTACK_MIN_X, maximum: inside(safeLaneX - exclusion) },
    { minimum: inside(safeLaneX + exclusion), maximum: FALLING_ATTACK_MAX_X },
  ].filter((span) => span.maximum - span.minimum >= PROJECTILE_RADIUS);
  if (spans.length > 0) return spans;
  return [{ minimum: FALLING_ATTACK_MIN_X, maximum: FALLING_ATTACK_MAX_X }];
}

/** Splits `count` cards between the hostile spans in proportion to their width. */
function shareCardsAcrossSpans(spans: readonly ColumnSpan[], count: number): number[] {
  const widths = spans.map((span) => span.maximum - span.minimum);
  const total = widths.reduce((sum, width) => sum + width, 0);
  const exact = widths.map((width) =>
    total > 0 ? (count * width) / total : count / spans.length);
  const shares = exact.map((value) => Math.floor(value));
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction);
  let remaining = count - shares.reduce((sum, share) => sum + share, 0);
  for (const { index } of order) {
    if (remaining <= 0) break;
    shares[index]! += 1;
    remaining -= 1;
  }
  return shares;
}

/**
 * Even pulses anchor their columns to both span edges; odd pulses use the cell
 * centres of the same span so consecutive curtains interleave without any
 * column leaving the visible range.
 */
function columnsInSpan(span: ColumnSpan, count: number, staggered: boolean): number[] {
  if (count <= 0) return [];
  if (!staggered) return evenlySpaced(span.minimum, span.maximum, count);
  const width = span.maximum - span.minimum;
  return Array.from(
    { length: count },
    (_, index) => span.minimum + ((index + 0.5) * width) / count,
  );
}

/** Compact simultaneous curtains separated by a clearly readable rest beat. */
export function planPulseBarrage(
  rng: SeededRng,
  intensity: 1 | 2 | 3,
  speedScale: number,
  safeLaneX: number,
): PulseBarragePlan {
  const pulseCount = intensity + 1;
  const cardsPerPulse = 7 + intensity;
  const depthClockScale = Math.max(0.1, speedScale);
  const spans = hostileColumnSpans(safeLaneX);
  const shares = shareCardsAcrossSpans(spans, cardsPerPulse);
  const formations = Array.from({ length: pulseCount }, (_, pulseIndex) => {
    const staggered = pulseIndex % 2 === 1;
    const projectiles = spans.flatMap((span, spanIndex) => {
      const columns = columnsInSpan(span, shares[spanIndex]!, staggered);
      // 抖動幅度不得吃掉太多欄距，否則相鄰卡片會擠成看不出間隔的一團。
      const spacing = columns.length > 1
        ? columns[1]! - columns[0]!
        : span.maximum - span.minimum;
      const spread = Math.min(10, spacing / 4);
      return columns.map((column): ProjectileConfig => {
        // 抖動不得把卡片推進安全通道或推出畫布，因此夾回本側可用範圍。
        const x = clamp(column + rng.range(-spread, spread), span.minimum, span.maximum);
        return {
          kind: 'paper',
          x,
          y: FALLING_ATTACK_ORIGIN_Y - pulseIndex * 8,
          vx: 0,
          vy: (270 + intensity * 24) * speedScale,
          radius: PROJECTILE_RADIUS,
          yawOffset: randomSignedYawOffset(rng, 7, 18),
          perspectiveOrigin: { x, y: FALLING_ATTACK_ORIGIN_Y },
          perspectiveTarget: { x, y: 910 },
          perspectiveDurationMs: Math.max(1_050, Math.round(1_300 / depthClockScale)),
        };
      });
    });
    return {
      atMs: pulseIndex * PULSE_BARRAGE_GAP_MS,
      projectiles,
    };
  });

  return { safeLaneX, formations };
}

export function runPulseBarrage(
  context: AttackPatternContext,
  safeLaneX: number,
): AttackPatternHandle {
  const plan = planPulseBarrage(
    context.rng,
    context.intensity,
    context.speedScale,
    safeLaneX,
  );
  const tailMs = Math.max(...plan.formations.flatMap((formation) =>
    formation.projectiles.map((card) => card.perspectiveDurationMs ?? 0))) + 200;
  const times = fitEmissionTimes(plan.formations.map((formation) => formation.atMs), context.durationMs, tailMs);
  return createPatternTimeline(
    context.durationMs,
    plan.formations.map((formation, index) => ({
      atMs: times[index]!,
      emit: () => spawnConfigs(context.projectiles, formation.projectiles),
    })),
  );
}

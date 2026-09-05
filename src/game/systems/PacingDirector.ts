import { MAIN_ATTACK_HITS_TO_WIN, ROUND_DURATION_MS, TARGET_VICTORY_MS } from '../constants';
import { clamp } from '../../utils/math';

export interface PacingInput {
  elapsedMs: number;
  remainingMs: number;
  energy: number;
  bossHp: number;
  mainHits: number;
  grazeCount: number;
  lives: number;
}

export interface PacingScale {
  speedScale: number;
  telegraphScale: number;
  recoveryScale: number;
  vulnerableScale: number;
  combatScale: number;
  urgency: number;
  relief: number;
}

export function computeExpectedHits(progress01: number): number {
  return progress01 * (MAIN_ATTACK_HITS_TO_WIN + 0.2);
}

export function computeGrazeRatePerMinute(grazeCount: number, elapsedMs: number): number {
  if (!Number.isFinite(grazeCount) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return (grazeCount / elapsedMs) * 60_000;
}

export function computePacing(input: PacingInput): PacingScale {
  const elapsed = Number.isFinite(input.elapsedMs) ? clamp(input.elapsedMs, 0, ROUND_DURATION_MS) : 0;
  const remaining = Number.isFinite(input.remainingMs) ? clamp(input.remainingMs, 0, ROUND_DURATION_MS) : ROUND_DURATION_MS - elapsed;
  const energy = Number.isFinite(input.energy) ? clamp(input.energy, 0, 100) : 0;
  const mainHits = Number.isFinite(input.mainHits) ? clamp(input.mainHits, 0, 10) : 0;
  const grazeCount = Number.isFinite(input.grazeCount) ? Math.max(0, input.grazeCount) : 0;

  const progress = clamp(elapsed / TARGET_VICTORY_MS, 0, 1);
  const expectedHits = computeExpectedHits(progress);
  const hitsBehind = expectedHits - mainHits;

  // Time is the main driver: later seconds should feel clearly faster.
  const timeUrgency = progress * progress * 0.25 + progress * 0.55;
  const endgameBoost = remaining < 15_000 ? ((15_000 - remaining) / 15_000) * 0.22 : 0;
  const baseUrgency = clamp(timeUrgency + endgameBoost, 0, 1);

  let relief = 0;
  if (hitsBehind > 0.65) relief += clamp(hitsBehind * 0.08, 0, 0.12);
  if (energy < 30 && progress > 0.35 && hitsBehind > 0.3) relief += 0.05;
  const grazeRate = computeGrazeRatePerMinute(grazeCount, elapsed);
  if (grazeRate < 4 && progress > 0.3 && hitsBehind > 0.25) relief += 0.04;
  if (input.lives <= 1 && hitsBehind > 0) relief += 0.03;
  relief = clamp(relief, 0, 0.18);

  const urgency = clamp(baseUrgency, 0, 0.95);

  const rawSpeedBoost = urgency * 0.85;
  const rawTelegraphReduction = urgency * 0.30;
  const rawRecoveryReduction = urgency * 0.90;
  const rawVulnerableReduction = urgency * 0.22;

  const speedScale = clamp(1 + rawSpeedBoost - relief, 0.90, 1.75);
  const telegraphScale = clamp(1 - rawTelegraphReduction + relief * 0.30, 0.70, 1);
  const recoveryScale = clamp(1 - rawRecoveryReduction + relief * 0.50, 0.22, 1);
  const vulnerableScale = clamp(1 - rawVulnerableReduction + relief * 0.40, 0.65, 1);
  const combatScale = clamp(0.55 + urgency * 0.12 - relief * 0.05, 0.52, 0.70);

  return {
    speedScale,
    telegraphScale,
    recoveryScale,
    vulnerableScale,
    combatScale,
    urgency,
    relief,
  };
}

export function computeTelegraphMs(baseMs: number, scale: number): number {
  return Math.max(1, Math.round(baseMs * scale));
}

export function computeRecoveryMs(baseMs: number, scale: number): number {
  return Math.max(1, Math.round(baseMs * scale));
}

export function computeVulnerableMs(baseMs: number, scale: number): number {
  return Math.max(1, Math.round(baseMs * scale));
}

import {
  AIM_MIN_PULL,
  BOSS_MAX_HP,
  ENERGY_LOSS_ON_HIT,
  ENERGY_MAX,
  ENERGY_PER_GRAZE,
  ENERGY_PER_PERFECT_WAVE,
  ENERGY_PER_REFLECT,
  LAUNCH_MISS_ENERGY,
  MAIN_ATTACK_DAMAGE,
  PLAYER_GRAZE_RADIUS,
  PLAYER_HIT_RADIUS,
  PLAYER_INVULNERABLE_MS,
  PLAYER_MAX_LIVES,
  REFLECT_DAMAGE,
  ROUND_DURATION_MS,
} from '../game/constants';
import { BattleState, isTerminalBattleState } from '../game/events';
import { clamp } from '../utils/math';

export type ProjectileContact = 'none' | 'graze' | 'hit';

export interface GrazeableProjectile {
  hasGrazedPlayer: boolean;
}

export interface BattleTransition {
  from: BattleState;
  to: BattleState;
  reason?: string;
  elapsedMs: number;
}

export interface GameSessionSnapshot {
  state: BattleState;
  launchMissReturnPending: boolean;
  lives: number;
  energy: number;
  bossHp: number;
  elapsedMs: number;
  remainingMs: number;
  invulnerableUntilMs: number;
  grazeCount: number;
  reflectCount: number;
  mainAttackHits: number;
  averageNeutral: number | null;
  highestNeutral: number | null;
}

export interface GameSessionOptions {
  lives?: number;
  energy?: number;
  bossHp?: number;
  roundDurationMs?: number;
}

const ALLOWED_TRANSITIONS: Readonly<Record<BattleState, readonly BattleState[]>> = {
  [BattleState.INTRO]: [BattleState.DODGING, BattleState.LOST],
  [BattleState.DODGING]: [BattleState.VULNERABLE, BattleState.LOST],
  [BattleState.VULNERABLE]: [BattleState.AIMING, BattleState.DODGING, BattleState.LOST],
  [BattleState.AIMING]: [BattleState.LAUNCHED, BattleState.VULNERABLE, BattleState.LOST],
  [BattleState.LAUNCHED]: [BattleState.STAGGERED, BattleState.DODGING, BattleState.LOST],
  [BattleState.STAGGERED]: [BattleState.DODGING, BattleState.WON, BattleState.LOST],
  [BattleState.WON]: [],
  [BattleState.LOST]: [],
};

export function canTransitionBattleState(from: BattleState, to: BattleState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function classifyProjectileContact(
  distance: number,
  projectileRadius: number,
  hitRadius = PLAYER_HIT_RADIUS,
  grazeRadius = PLAYER_GRAZE_RADIUS,
): ProjectileContact {
  const safeDistance = Math.max(0, distance);
  const safeProjectileRadius = Math.max(0, projectileRadius);
  if (safeDistance <= hitRadius + safeProjectileRadius) {
    return 'hit';
  }
  if (safeDistance <= grazeRadius + safeProjectileRadius) {
    return 'graze';
  }
  return 'none';
}

export class GameSession {
  private currentState = BattleState.INTRO;
  private currentLives: number;
  private currentEnergy: number;
  private currentBossHp: number;
  private currentElapsedMs = 0;
  private currentInvulnerableUntilMs = 0;
  private currentLaunchMissReturnPending = false;
  private readonly durationMs: number;
  private neutralTotal = 0;
  private neutralSamples = 0;
  private neutralPeak: number | null = null;

  readonly transitions: BattleTransition[] = [];

  grazeCount = 0;
  reflectCount = 0;
  mainAttackHits = 0;

  constructor(options: GameSessionOptions = {}) {
    this.currentLives = clamp(options.lives ?? PLAYER_MAX_LIVES, 0, PLAYER_MAX_LIVES);
    this.currentEnergy = clamp(options.energy ?? 0, 0, ENERGY_MAX);
    this.currentBossHp = clamp(options.bossHp ?? BOSS_MAX_HP, 0, BOSS_MAX_HP);
    this.durationMs = Math.max(1, options.roundDurationMs ?? ROUND_DURATION_MS);
  }

  get state(): BattleState {
    return this.currentState;
  }

  get lives(): number {
    return this.currentLives;
  }

  get energy(): number {
    return this.currentEnergy;
  }

  get bossHp(): number {
    return this.currentBossHp;
  }

  get elapsedMs(): number {
    return this.currentElapsedMs;
  }

  get remainingMs(): number {
    return Math.max(0, this.durationMs - this.currentElapsedMs);
  }

  get invulnerableUntilMs(): number {
    return this.currentInvulnerableUntilMs;
  }

  get launchMissReturnPending(): boolean {
    return this.currentLaunchMissReturnPending;
  }

  get averageNeutral(): number | null {
    return this.neutralSamples === 0 ? null : this.neutralTotal / this.neutralSamples;
  }

  get highestNeutral(): number | null {
    return this.neutralPeak;
  }

  transition(next: BattleState, reason?: string): void {
    if (!canTransitionBattleState(this.currentState, next)) {
      throw new Error(`Invalid battle transition: ${this.currentState} -> ${next}`);
    }

    const from = this.currentState;
    this.currentState = next;
    if (next !== BattleState.LAUNCHED) this.currentLaunchMissReturnPending = false;
    this.transitions.push({
      from,
      to: next,
      ...(reason === undefined ? {} : { reason }),
      elapsedMs: this.currentElapsedMs,
    });
  }

  startBattle(): void {
    this.transition(BattleState.DODGING, 'intro-complete');
  }

  addEnergy(amount: number): number {
    if (!Number.isFinite(amount)) {
      throw new TypeError('energy amount must be finite');
    }

    this.currentEnergy = clamp(this.currentEnergy + amount, 0, ENERGY_MAX);
    return this.currentEnergy;
  }

  setEnergyForDebug(amount: number): number {
    if (!Number.isFinite(amount)) {
      throw new TypeError('energy amount must be finite');
    }

    this.currentEnergy = clamp(amount, 0, ENERGY_MAX);
    return this.currentEnergy;
  }

  registerGraze(projectile: GrazeableProjectile): boolean {
    if (projectile.hasGrazedPlayer || isTerminalBattleState(this.currentState)) {
      return false;
    }

    projectile.hasGrazedPlayer = true;
    this.grazeCount += 1;
    this.addEnergy(ENERGY_PER_GRAZE);
    return true;
  }

  registerPerfectWave(): void {
    if (!isTerminalBattleState(this.currentState)) {
      this.addEnergy(ENERGY_PER_PERFECT_WAVE);
    }
  }

  registerReflection(): void {
    if (isTerminalBattleState(this.currentState)) {
      return;
    }

    this.reflectCount += 1;
    this.addEnergy(ENERGY_PER_REFLECT);
  }

  applyReflectedBossHit(): number {
    if (isTerminalBattleState(this.currentState)) {
      return this.currentBossHp;
    }

    this.registerReflection();
    // Reflections soften the boss but cannot bypass the launch-based finishing
    // flow required by the state machine (STAGGERED -> WON).
    this.currentBossHp = clamp(this.currentBossHp - REFLECT_DAMAGE, 1, BOSS_MAX_HP);
    return this.currentBossHp;
  }

  isInvulnerable(nowMs: number): boolean {
    return nowMs < this.currentInvulnerableUntilMs;
  }

  takePlayerHit(nowMs: number): boolean {
    if (
      !Number.isFinite(nowMs) ||
      isTerminalBattleState(this.currentState) ||
      this.isInvulnerable(nowMs)
    ) {
      return false;
    }

    this.currentLives = Math.max(0, this.currentLives - 1);
    this.addEnergy(-ENERGY_LOSS_ON_HIT);
    this.currentInvulnerableUntilMs = nowMs + PLAYER_INVULNERABLE_MS;

    if (this.currentLives === 0) {
      this.transition(BattleState.LOST, 'no-lives');
    }

    return true;
  }

  openVulnerability(): boolean {
    if (this.currentState !== BattleState.DODGING || this.currentEnergy < ENERGY_MAX) {
      return false;
    }

    this.transition(BattleState.VULNERABLE, 'energy-full');
    return true;
  }

  beginAim(): boolean {
    if (this.currentState !== BattleState.VULNERABLE) {
      return false;
    }

    this.transition(BattleState.AIMING, 'aim-started');
    return true;
  }

  expireVulnerability(): boolean {
    if (this.currentState !== BattleState.VULNERABLE) {
      return false;
    }

    this.transition(BattleState.DODGING, 'vulnerability-expired');
    return true;
  }

  releaseAim(pullDistance: number): boolean {
    if (this.currentState !== BattleState.AIMING) {
      return false;
    }

    if (pullDistance < AIM_MIN_PULL) {
      this.transition(BattleState.VULNERABLE, 'aim-cancelled');
      return false;
    }

    this.currentLaunchMissReturnPending = false;
    this.transition(BattleState.LAUNCHED, 'launched');
    return true;
  }

  resolveLaunch(hitBoss: boolean): void {
    if (this.currentState !== BattleState.LAUNCHED) {
      throw new Error('A launch can only be resolved from the LAUNCHED state');
    }

    if (!hitBoss) {
      this.currentEnergy = LAUNCH_MISS_ENERGY;
      // Crossing the boundary starts the visual rebound, but the launch is not
      // finished until NOXCAT has landed back in the play area. Keeping the
      // state LAUNCHED also keeps collision and attack spawning suspended.
      this.currentLaunchMissReturnPending = true;
      return;
    }

    this.currentLaunchMissReturnPending = false;
    this.currentBossHp = clamp(this.currentBossHp - MAIN_ATTACK_DAMAGE, 0, BOSS_MAX_HP);
    this.currentEnergy = 0;
    this.mainAttackHits += 1;
    this.transition(BattleState.STAGGERED, 'main-attack-hit');

    if (this.currentBossHp === 0) {
      this.transition(BattleState.WON, 'boss-defeated');
    }
  }

  completeLaunchMissReturn(): boolean {
    if (this.currentState !== BattleState.LAUNCHED || !this.currentLaunchMissReturnPending) {
      return false;
    }

    this.currentLaunchMissReturnPending = false;
    this.transition(BattleState.DODGING, 'launch-return-complete');
    return true;
  }

  endStagger(): boolean {
    if (this.currentState !== BattleState.STAGGERED) {
      return false;
    }

    this.transition(BattleState.DODGING, 'stagger-complete');
    return true;
  }

  recordNeutralScore(score: number | null): void {
    if (score == null || !Number.isFinite(score)) {
      return;
    }

    const safeScore = clamp(score, 0, 100);
    this.neutralTotal += safeScore;
    this.neutralSamples += 1;
    this.neutralPeak = this.neutralPeak === null ? safeScore : Math.max(this.neutralPeak, safeScore);
  }

  advanceTime(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError('deltaMs must be a finite, non-negative number');
    }
    if (isTerminalBattleState(this.currentState)) {
      return;
    }
    // 拉弓、飛行和硬直也計入整局倒數；失焦暫停由 BattleScene 停止推進。
    this.currentElapsedMs = Math.min(this.durationMs, this.currentElapsedMs + deltaMs);
    if (this.currentElapsedMs >= this.durationMs) {
      this.transition(BattleState.LOST, 'time-expired');
    }
  }

  snapshot(): GameSessionSnapshot {
    return {
      state: this.currentState,
      launchMissReturnPending: this.currentLaunchMissReturnPending,
      lives: this.currentLives,
      energy: this.currentEnergy,
      bossHp: this.currentBossHp,
      elapsedMs: this.currentElapsedMs,
      remainingMs: this.remainingMs,
      invulnerableUntilMs: this.currentInvulnerableUntilMs,
      grazeCount: this.grazeCount,
      reflectCount: this.reflectCount,
      mainAttackHits: this.mainAttackHits,
      averageNeutral: this.averageNeutral,
      highestNeutral: this.highestNeutral,
    };
  }
}

import { describe, expect, it } from 'vitest';
import type Phaser from 'phaser';
import { AttackStepSchema, BossDNASchema, PatternIdSchema, type PatternId } from '../src/ai/bossSchema';
import { createFallbackBoss, FALLBACK_BOSS } from '../src/ai/fallbackBoss';
import { createAttackPool, shuffleAttackRound } from '../src/game/attackSequence';
import type { Noxcat } from '../src/game/entities/Noxcat';
import { AttackDirector } from '../src/game/systems/AttackDirector';
import type { ProjectileSystem } from '../src/game/systems/ProjectileSystem';
import { SeededRng } from '../src/utils/rng';

const patterns = [...PatternIdSchema.options].sort();

function visitAttacks(seed: number, count: number, extraLayoutDraws = 0): PatternId[] {
  const layoutRng = new SeededRng(seed);
  const director = new AttackDirector(
    { attacks: createAttackPool(FALLBACK_BOSS.attacks), shuffleSeed: seed },
    layoutRng,
    {} as ProjectileSystem,
  );
  director.start();
  const visited = [director.currentPattern];
  for (let index = 1; index < count; index += 1) {
    for (let draw = 0; draw < extraLayoutDraws; draw += 1) layoutRng.next();
    director.pause();
    director.resume(true);
    visited.push(director.currentPattern);
  }
  return visited;
}

describe('shared all-pattern attack pool', () => {
  it('expands three BossDNA steps into every implemented pattern exactly once', () => {
    const pool = createAttackPool(FALLBACK_BOSS.attacks);
    expect(pool.map(({ pattern }) => pattern).sort()).toEqual(patterns);
    for (const step of pool) expect(AttackStepSchema.safeParse(step).success).toBe(true);
  });

  it('preserves AI-selected intensity and duration for each matching pattern', () => {
    const boss = createFallbackBoss();
    boss.attacks = [
      { pattern: 'revision_homing', intensity: 3, durationMs: 9_000 },
      { pattern: 'closing_walls', intensity: 1, durationMs: 4_500 },
      { pattern: 'pulse_barrage', intensity: 2, durationMs: 7_600 },
    ];
    const pool = createAttackPool(boss.attacks);
    for (const attack of boss.attacks) expect(pool).toContainEqual(attack);
  });

  it('deduplicates repeated AI patterns, keeping their first configuration', () => {
    const pool = createAttackPool([
      { pattern: 'paper_rain', intensity: 1, durationMs: 4_500 },
      { pattern: 'paper_rain', intensity: 3, durationMs: 9_000 },
      { pattern: 'paper_rain', intensity: 2, durationMs: 6_000 },
    ]);
    expect(pool.map(({ pattern }) => pattern).sort()).toEqual(patterns);
    expect(pool.find(({ pattern }) => pattern === 'paper_rain')).toEqual({
      pattern: 'paper_rain', intensity: 1, durationMs: 4_500,
    });
  });

  it('keeps runtime pool changes isolated from BossDNA and its three-step API contract', () => {
    const boss = createFallbackBoss();
    const pool = createAttackPool(boss.attacks);
    pool.find(({ pattern }) => pattern === 'paper_rain')!.durationMs = 9_000;
    expect(boss).toEqual(FALLBACK_BOSS);
    expect(createAttackPool(boss.attacks)).not.toEqual(pool);
    expect(BossDNASchema.safeParse(boss).success).toBe(true);
    expect(BossDNASchema.safeParse({ ...boss, attacks: pool }).success).toBe(false);
  });
});

describe('seeded attack rounds', () => {
  it('emits every shuffled pattern through its normal timeline and respects its configured duration', () => {
    const pool = createAttackPool(FALLBACK_BOSS.attacks);
    const visited: PatternId[] = [];
    const emitted = new Set<PatternId>();
    const projectiles = {
      spawn: () => { emitted.add(director.currentPattern); return null; },
      spawnBeam: () => { emitted.add(director.currentPattern); },
      activeProjectiles: () => [{ isDamage: true, friendly: false }],
      activeBeams: () => [],
      releaseDangerousForExit: () => {},
    } as unknown as ProjectileSystem;
    const director = new AttackDirector(
      { attacks: pool, shuffleSeed: 270_027 },
      new SeededRng(270_027),
      projectiles,
      {
        scene: {} as Phaser.Scene,
        player: { x: 270, y: 780 } as Noxcat,
        onPatternChanged: (pattern) => visited.push(pattern),
      },
    );
    director.start();
    for (let index = 0; index < 18; index += 1) {
      const current = director.currentPattern;
      const duration = pool.find(({ pattern }) => pattern === current)!.durationMs;
      for (let elapsed = 0; elapsed < duration - 20; elapsed += 20) director.update(20, 3);
      expect(director.currentPattern).toBe(current);
      expect(director.currentPhase).toBe('RECOVERY');
      expect(emitted.has(current)).toBe(true);
      // 每兩波新增反彈休息段，須完整走完再開始下一個預警。
      let recoveryMs = 0;
      while (director.currentPhase === 'RECOVERY' && recoveryMs < 3_000) {
        director.update(1, 3);
        recoveryMs++;
      }
      expect(director.currentPhase).toBe('TELEGRAPH');
      expect(director.currentPattern).not.toBe(current);
    }
    expect([...emitted].sort()).toEqual(patterns);
    expect(visited.slice(0, 9).sort()).toEqual(patterns);
    expect(visited.slice(9, 18).sort()).toEqual(patterns);
  });

  it('plays every pattern once per round and avoids repeats at every round boundary', () => {
    for (let seed = 1; seed <= 64; seed += 1) {
      const visited = visitAttacks(seed, patterns.length * 4);
      for (let offset = 0; offset < visited.length; offset += patterns.length) {
        expect(visited.slice(offset, offset + patterns.length).sort()).toEqual(patterns);
        if (offset > 0) expect(visited[offset]).not.toBe(visited[offset - 1]);
      }
    }
  });

  it('reproduces the complete order for the same seed', () => {
    expect(visitAttacks(270_027, 36)).toEqual(visitAttacks(270_027, 36));
  });

  it('reshuffles subsequent rounds and varies the order between seeds', () => {
    const visited = visitAttacks(270_027, 18);
    expect(visited.slice(0, 9)).not.toEqual(visited.slice(9));
    const orders = new Set(Array.from({ length: 12 }, (_, seed) => visitAttacks(seed + 1, 9).join(',')));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('keeps selection independent of random draws used for projectile layouts', () => {
    expect(visitAttacks(270_027, 36, 17)).toEqual(visitAttacks(270_027, 36));
  });

  it('fixes a boundary repeat without dropping or duplicating a pattern', () => {
    const pool = createAttackPool(FALLBACK_BOSS.attacks);
    const first = shuffleAttackRound(pool, new SeededRng(25));
    const corrected = shuffleAttackRound(pool, new SeededRng(25), first[0]!.pattern);
    expect(corrected[0]!.pattern).not.toBe(first[0]!.pattern);
    expect(corrected.map(({ pattern }) => pattern).sort()).toEqual(patterns);
    expect(pool).toEqual(createAttackPool(FALLBACK_BOSS.attacks));
  });

  it('allows a one-pattern diagnostic pool to repeat without losing its step', () => {
    const pool = [FALLBACK_BOSS.attacks[0]];
    expect(shuffleAttackRound(pool, new SeededRng(1), 'paper_rain')).toEqual(pool);
  });

  it('retains the fixed sequence used by isolated pattern diagnostics', () => {
    const director = new AttackDirector(FALLBACK_BOSS, new SeededRng(12), {} as ProjectileSystem);
    director.start();
    const visited = [director.currentPattern];
    for (let index = 1; index < 6; index += 1) {
      director.pause();
      director.resume(true);
      visited.push(director.currentPattern);
    }
    expect(visited).toEqual([...FALLBACK_BOSS.attacks, ...FALLBACK_BOSS.attacks].map(({ pattern }) => pattern));
  });
});

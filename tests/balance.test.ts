import { describe, expect, it } from 'vitest';
import type Phaser from 'phaser';
import type { Noxcat } from '../src/game/entities/Noxcat';
import type { ProjectileConfig } from '../src/game/entities/Projectile';
import type { ProjectileSystem } from '../src/game/systems/ProjectileSystem';
import { AttackDirector } from '../src/game/systems/AttackDirector';
import { runClosingWalls } from '../src/game/patterns/closingWalls';
import { RETURNABLE_RECOVERY_MS } from '../src/game/patterns/returnableBurst';
import type { AttackPatternContext } from '../src/game/patterns/types';
import { DODGE_AREA_BOTTOM, PLAYER_MAX_Y } from '../src/game/constants';
import { COMBAT_ARENA } from '../src/game/systems/DangerTelegraph';
import { SeededRng } from '../src/utils/rng';

describe('one-minute battle balance', () => {
  it('reserves the complete body above the invisible HUD boundary', () => {
    expect(PLAYER_MAX_Y + 76).toBe(DODGE_AREA_BOTTOM);
    expect(DODGE_AREA_BOTTOM).toBeLessThan(960 - 102);
    expect(COMBAT_ARENA.y + COMBAT_ARENA.height).toBe(DODGE_AREA_BOTTOM);
  });

  it('interleaves one return card after the second wave and prevents the next attack on cancellation', () => {
    const cards: { at: number; config: ProjectileConfig }[] = [];
    let time = 0;
    const projectiles = {
      spawn: (config: ProjectileConfig) => { cards.push({ at: time, config }); return null; },
      activeProjectiles: () => [{ isDamage: true, friendly: false }],
      activeBeams: () => [],
      clearDangerous: () => {},
      releaseDangerousForExit: () => {},
    } as unknown as ProjectileSystem;
    const director = new AttackDirector({ attacks: [{ pattern: 'paper_rain', intensity: 1, durationMs: 4_500 }] },
      new SeededRng(31), projectiles, { scene: {} as Phaser.Scene, player: { x: 270, y: 700 } as Noxcat });
    director.start();
    while (time < 12_000 && cards.filter(({ config }) => config.kind === 'returnable').length < 1) {
      time += 10;
      director.update(10, 3);
    }
    const returnables = cards.filter(({ config }) => config.kind === 'returnable');
    expect(returnables).toHaveLength(1);
    expect(director.currentPhase).toBe('RECOVERY');
    expect(returnables.every(({ config }) => config.perspectiveDurationMs! >= 1_200)).toBe(true);
    director.cancelCurrent();
    const count = cards.length;
    director.update(RETURNABLE_RECOVERY_MS * 2, 3);
    expect(cards).toHaveLength(count);
  });

  it('moves the wall guide smoothly between emissions and freezes it on cancellation', () => {
    const gaps: number[] = [];
    const handle = runClosingWalls({
      rng: new SeededRng(31), intensity: 2, durationMs: 5_000, speedScale: 1,
      projectiles: { spawn: () => null },
    } as unknown as AttackPatternContext, 600, (gap) => gaps.push(gap));
    for (let frame = 0; frame < 90; frame++) handle.update(1000 / 60);
    expect(new Set(gaps).size).toBeGreaterThan(80);
    expect(Math.max(...gaps.slice(1).map((gap, index) => Math.abs(gap - gaps[index]!)))).toBeLessThan(1);
    handle.cancel();
    const count = gaps.length;
    handle.update(5_000);
    expect(gaps).toHaveLength(count);
  });
});

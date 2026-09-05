import { describe, expect, it } from 'vitest';
import type Phaser from 'phaser';
import type { PatternId } from '../src/ai/bossSchema';
import type { Noxcat } from '../src/game/entities/Noxcat';
import type { ProjectileConfig } from '../src/game/entities/Projectile';
import { planPaperRain } from '../src/game/patterns/paperRain';
import { planTopDownpour } from '../src/game/patterns/topDownpour';
import { commentCrossfireLayout } from '../src/game/patterns/commentCrossfire';
import { planPulseBarrage, runPulseBarrage } from '../src/game/patterns/pulseBarrage';
import { runAlternatingZipper } from '../src/game/patterns/alternatingZipper';
import { planRevisionHoming } from '../src/game/patterns/revisionHoming';
import { AttackDirector } from '../src/game/systems/AttackDirector';
import { dangerZonesForPattern } from '../src/game/systems/DangerTelegraph';
import type { ProjectileSystem } from '../src/game/systems/ProjectileSystem';
import { SeededRng } from '../src/utils/rng';

describe('readable attack directions and complete beats', () => {
  it('warns across the full horizontal laser instead of tapering its edges', () => {
    const zones = dangerZonesForPattern('deadline_beam', undefined, undefined, [
      { x: 270, y: 780, angle: 0 },
    ]);
    expect(zones[0]).toMatchObject({ kind: 'ray', halfWidth: expect.any(Number) });
    const ray = zones[0] as Extract<typeof zones[number], { kind: 'ray' }>;
    expect(Math.abs(ray.to.x - ray.from.x)).toBeGreaterThan(500);
    expect(Math.abs(ray.to.y - ray.from.y)).toBeLessThan(1);
  });

  it('uses a horizontal screen-space opening for walls entering from the sides', () => {
    const director = new AttackDirector({ attacks: [{ pattern: 'closing_walls', intensity: 2, durationMs: 5800 }] },
      new SeededRng(8), {} as ProjectileSystem);
    director.start();
    expect(director.currentSafeLane).toMatchObject({ axis: 'horizontal', projection: 'screen' });
    expect(director.currentDangerZones.every((zone) => zone.kind === 'rect' && zone.projection === 'screen')).toBe(true);
  });

  it('preserves at least 500 ms of warning at maximum pacing', () => {
    const emitted: ProjectileConfig[] = [];
    const director = new AttackDirector({ attacks: [{ pattern: 'paper_rain', intensity: 3, durationMs: 4500 }] },
      new SeededRng(8), { spawn: (config: ProjectileConfig) => { emitted.push(config); } } as unknown as ProjectileSystem,
      { scene: {} as Phaser.Scene, player: { x: 270, y: 780 } as Noxcat });
    director.setPacingScale({ speedScale: 1.35, telegraphScale: 0.75, recoveryScale: 0.4,
      vulnerableScale: 0.7, combatScale: 0.65, urgency: 0.65, relief: 0 });
    director.start();
    director.update(499, 3);
    expect(emitted).toHaveLength(0);
    director.update(1, 3);
    expect(emitted.length).toBeGreaterThan(0);
  });

  it('makes paper-rain approach clocks respect the actual pacing speed', () => {
    const normal = planPaperRain(new SeededRng(8), 2, 1, 270);
    const fast = planPaperRain(new SeededRng(8), 2, 1.25, 270);
    expect(fast[0]!.perspectiveDurationMs).toBeLessThan(normal[0]!.perspectiveDurationMs!);
  });

  it('starts downpour on both sides of its clear lane', () => {
    const plan = planTopDownpour(new SeededRng(8), 3, 1, 270);
    const first = plan.projectiles.slice(0, 2).map((card) => Math.sign(card.x - plan.safeLaneX));
    expect(new Set(first).size).toBe(2);
  });

  it('keeps low-intensity crossfire recognizable as simultaneous, distinct directions', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { rays } = commentCrossfireLayout(new SeededRng(seed), 1);
      expect(rays).toHaveLength(2);
      expect(new Set(rays.map((ray) => ray.direction)).size).toBe(2);
    }
  });

  it('brings each pulse curtain to the near plane together', () => {
    const plan = planPulseBarrage(new SeededRng(8), 3, 1, 270);
    for (const formation of plan.formations) {
      expect(new Set(formation.projectiles.map((card) => card.perspectiveDurationMs)).size).toBe(1);
    }
  });

  it.each(['pulse_barrage', 'alternating_zipper'] as const)('finishes %s before the shortest active window ends', (pattern) => {
    const durationMs = pattern === 'pulse_barrage' ? 3390 : 3480;
    let elapsedMs = 0;
    const emitted: { atMs: number; card: ProjectileConfig }[] = [];
    const projectiles = { spawn: (card: ProjectileConfig) => { emitted.push({ atMs: elapsedMs, card }); } } as unknown as ProjectileSystem;
    const context = { scene: {} as Phaser.Scene, player: { x: 270, y: 780 } as Noxcat,
      projectiles, rng: new SeededRng(8), intensity: 3 as const, speedScale: 1, durationMs, waveIndex: 0 };
    const handle = pattern === 'pulse_barrage' ? runPulseBarrage(context, 270) : runAlternatingZipper(context, 270);
    for (elapsedMs = 10; elapsedMs <= durationMs; elapsedMs += 10) handle.update(10);
    expect(handle.finished).toBe(true);
    expect(emitted).toHaveLength(pattern === 'pulse_barrage' ? 40 : 11);
    expect(Math.max(...emitted.map(({ atMs, card }) => atMs + card.perspectiveDurationMs!)))
      .toBeLessThanOrEqual(durationMs - 100);
  });

  it('keeps a reaction interval after homing locks, including fast pacing', () => {
    for (const speed of [0.85, 1, 1.35]) {
      for (const card of planRevisionHoming(new SeededRng(8), 3, speed)) {
        expect(card.perspectiveDurationMs! * 0.8 - card.homingMs!).toBeGreaterThanOrEqual(399);
      }
    }
  });

  it('does not repeat warnings or emit another pattern when an attack is cancelled', () => {
    const changed: PatternId[] = [];
    const projectiles = { clearDangerous: () => {} } as unknown as ProjectileSystem;
    const director = new AttackDirector({ attacks: [{ pattern: 'paper_rain', intensity: 1, durationMs: 5400 }] },
      new SeededRng(8), projectiles, { scene: {} as Phaser.Scene, player: {} as Noxcat,
        onPatternChanged: (pattern) => changed.push(pattern) });
    director.start();
    director.cancelCurrent();
    director.update(10000, 3);
    expect(changed).toEqual(['paper_rain']);
  });
});

import { describe, expect, it } from 'vitest';

import {
  ENERGY_MAX,
  ENERGY_PER_GRAZE,
  ENERGY_PER_WAVE,
  ENERGY_PER_PERFECT_WAVE,
  ENERGY_PER_REFLECT,
  LAUNCH_MISS_ENERGY,
  MAIN_ATTACK_DAMAGE,
  PLAYER_INVULNERABLE_MS,
  ROUND_DURATION_MS,
  TARGET_VICTORY_MS,
  VULNERABLE_WINDOW_MS,
} from '../src/game/constants';
import { BattleState } from '../src/game/events';
import {
  GameSession,
  classifyProjectileContact,
  type GrazeableProjectile,
} from '../src/state/GameSession';

function landMainAttack(session: GameSession): void {
  session.setEnergyForDebug(ENERGY_MAX);
  expect(session.openVulnerability()).toBe(true);
  expect(session.beginAim()).toBe(true);
  expect(session.releaseAim(100)).toBe(true);
  session.resolveLaunch(true);
}

describe('GameSession combat rules', () => {
  it('keeps the full round limit at 90 seconds', () => {
    const session = new GameSession();

    expect(ROUND_DURATION_MS).toBe(90_000);
    expect(TARGET_VICTORY_MS).toBe(60_000);
    expect(session.remainingMs).toBe(90_000);
  });

  it('fills after three clean waves with one graze each without a camera', () => {
    const session = new GameSession();
    session.startBattle();
    for (let wave = 0; wave < 3; wave++) {
      session.addEnergy(ENERGY_PER_WAVE);
      session.registerPerfectWave();
      session.registerGraze({ hasGrazedPlayer: false });
      if (wave < 2) expect(session.energy).toBeLessThan(100);
    }
    expect(session.energy).toBe(100);
    expect(ENERGY_PER_REFLECT).toBeGreaterThan(ENERGY_PER_GRAZE);
    expect(ENERGY_PER_PERFECT_WAVE).toBeLessThan(ENERGY_PER_WAVE);
  });

  it('clamps energy between zero and the maximum', () => {
    const session = new GameSession({ energy: -100 });

    expect(session.energy).toBe(0);
    expect(session.addEnergy(1_000)).toBe(ENERGY_MAX);
    expect(session.addEnergy(-1_000)).toBe(0);
  });

  it('registers each projectile graze only once', () => {
    const session = new GameSession();
    session.startBattle();
    const projectile: GrazeableProjectile = { hasGrazedPlayer: false };

    expect(session.registerGraze(projectile)).toBe(true);
    expect(session.registerGraze(projectile)).toBe(false);
    expect(session.energy).toBe(ENERGY_PER_GRAZE);
    expect(session.grazeCount).toBe(1);
  });

  it('lets reflected documents damage but not deliver the state-machine final blow', () => {
    const session = new GameSession({ bossHp: 3 });
    session.startBattle();

    expect(session.applyReflectedBossHit()).toBe(1);
    expect(session.reflectCount).toBe(1);
    expect(session.state).toBe(BattleState.DODGING);
  });

  it('distinguishes hit, graze, and safe distances at their exact boundaries', () => {
    expect(classifyProjectileContact(28, 10)).toBe('hit');
    expect(classifyProjectileContact(29, 10)).toBe('graze');
    expect(classifyProjectileContact(53, 10)).toBe('graze');
    expect(classifyProjectileContact(54, 10)).toBe('none');
  });

  it('does not deduct consecutive lives during invulnerability', () => {
    const session = new GameSession({ energy: 50 });
    session.startBattle();

    expect(session.takePlayerHit(1_000)).toBe(true);
    expect(session.takePlayerHit(1_000 + PLAYER_INVULNERABLE_MS - 1)).toBe(false);
    expect(session.lives).toBe(2);
    expect(session.energy).toBe(30);

    expect(session.takePlayerHit(1_000 + PLAYER_INVULNERABLE_MS)).toBe(true);
    expect(session.lives).toBe(1);
  });

  it(`needs four ${MAIN_ATTACK_DAMAGE}-damage main attacks to defeat the tougher boss`, () => {
    const session = new GameSession();
    session.startBattle();

    landMainAttack(session);
    expect(session.bossHp).toBe(98);
    expect(session.state).toBe(BattleState.STAGGERED);
    session.endStagger();

    landMainAttack(session);
    expect(session.bossHp).toBe(64);
    session.endStagger();

    landMainAttack(session);
    expect(session.bossHp).toBe(30);
    expect(session.state).toBe(BattleState.STAGGERED);
    session.endStagger();

    landMainAttack(session);
    expect(session.bossHp).toBe(0);
    expect(session.mainAttackHits).toBe(4);
    expect(session.state).toBe(BattleState.WON);
  });

  it('rejects illegal state transitions', () => {
    const session = new GameSession();

    expect(() => session.transition(BattleState.AIMING)).toThrow(/Invalid battle transition/);
  });

  it('closes an unused vulnerability window without consuming stored energy', () => {
    const session = new GameSession({ energy: ENERGY_MAX });
    session.startBattle();

    expect(session.openVulnerability()).toBe(true);
    expect(session.expireVulnerability()).toBe(true);
    expect(session.state).toBe(BattleState.DODGING);
    expect(session.energy).toBe(ENERGY_MAX);
    expect(session.transitions.at(-1)?.reason).toBe('vulnerability-expired');
  });

  it('keeps a missed launch active until the visual return has completed', () => {
    const session = new GameSession({ energy: ENERGY_MAX });
    session.startBattle();
    session.openVulnerability();
    session.beginAim();
    session.releaseAim(100);

    session.resolveLaunch(false);

    expect(session.state).toBe(BattleState.LAUNCHED);
    expect(session.energy).toBe(LAUNCH_MISS_ENERGY);
    expect(session.launchMissReturnPending).toBe(true);
    expect(session.snapshot().launchMissReturnPending).toBe(true);
    expect(session.transitions.at(-1)?.reason).toBe('launched');

    expect(session.completeLaunchMissReturn()).toBe(true);
    expect(session.state).toBe(BattleState.DODGING);
    expect(session.launchMissReturnPending).toBe(false);
    expect(session.transitions.at(-1)?.reason).toBe('launch-return-complete');
    expect(session.completeLaunchMissReturn()).toBe(false);
  });

  it('retains an ordered transition history for the debug overlay', () => {
    const session = new GameSession({ energy: ENERGY_MAX });
    session.startBattle();
    session.openVulnerability();
    session.beginAim();
    session.releaseAim(100);

    expect(session.transitions.map(({ from, to, reason }) => ({ from, to, reason }))).toEqual([
      { from: BattleState.INTRO, to: BattleState.DODGING, reason: 'intro-complete' },
      { from: BattleState.DODGING, to: BattleState.VULNERABLE, reason: 'energy-full' },
      { from: BattleState.VULNERABLE, to: BattleState.AIMING, reason: 'aim-started' },
      { from: BattleState.AIMING, to: BattleState.LAUNCHED, reason: 'launched' },
    ]);
  });

  it('counts the 5-second slingshot window toward the round limit', () => {
    expect(VULNERABLE_WINDOW_MS).toBe(5_000);
    const session = new GameSession({ energy: ENERGY_MAX, roundDurationMs: 10_000 });
    session.startBattle();
    session.advanceTime(1_000);
    expect(session.remainingMs).toBe(9_000);

    session.openVulnerability();
    session.advanceTime(2_000);
    expect(session.remainingMs).toBe(7_000);

    session.beginAim();
    session.advanceTime(1_000);
    expect(session.remainingMs).toBe(6_000);

    expect(session.releaseAim(0)).toBe(false);
    expect(session.expireVulnerability()).toBe(true);
    session.advanceTime(500);
    expect(session.remainingMs).toBe(5_500);
  });

  it('expires safely while a missed launch is still returning', () => {
    const session = new GameSession({ energy: ENERGY_MAX, roundDurationMs: 1 });
    session.startBattle();
    session.openVulnerability();
    session.beginAim();
    session.releaseAim(100);
    session.resolveLaunch(false);

    session.advanceTime(1);
    expect(session.state).toBe(BattleState.LOST);
    expect(session.remainingMs).toBe(0);
    expect(session.completeLaunchMissReturn()).toBe(false);
    expect(session.launchMissReturnPending).toBe(false);
    expect(session.transitions.at(-1)?.reason).toBe('time-expired');
  });

  it('expires during stagger if a last-second hit did not defeat the boss', () => {
    const session = new GameSession({ energy: ENERGY_MAX, roundDurationMs: 1_000 });
    session.startBattle();
    session.advanceTime(999);
    landMainAttack(session);

    expect(session.state).toBe(BattleState.STAGGERED);
    session.advanceTime(800);
    expect(session.state).toBe(BattleState.LOST);
    expect(session.endStagger()).toBe(false);
    expect(session.transitions.at(-1)?.reason).toBe('time-expired');
  });

  it('loses cleanly when the round timer expires', () => {
    const session = new GameSession({ roundDurationMs: 1_000 });
    session.startBattle();

    session.advanceTime(999);
    expect(session.state).toBe(BattleState.DODGING);
    session.advanceTime(1);
    expect(session.state).toBe(BattleState.LOST);
    expect(session.remainingMs).toBe(0);
  });
});

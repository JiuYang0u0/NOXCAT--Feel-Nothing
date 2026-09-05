import Phaser from 'phaser';
import { PALETTE } from '../../theme/palette';

const SHATTER_DURATION = 520;
const SHARD_COUNT = 10;
const COOLDOWN_MS = 450;

export class GlassShatterEffect {
  private readonly crackGraphics: Phaser.GameObjects.Graphics;
  private readonly flashCore: Phaser.GameObjects.Arc;
  private readonly flashHalo: Phaser.GameObjects.Arc;
  private readonly holeRing: Phaser.GameObjects.Arc;
  private shardPool: Phaser.GameObjects.Rectangle[] = [];
  private activeShards: Phaser.GameObjects.Rectangle[] = [];
  private activeTweens: Phaser.Tweens.Tween[] = [];
  private lastShatterAt = Number.NEGATIVE_INFINITY;
  private cleanupTimer?: Phaser.Time.TimerEvent;

  constructor(private readonly scene: Phaser.Scene) {
    this.crackGraphics = scene.add.graphics().setDepth(106).setVisible(false);
    this.flashCore = scene.add.circle(0, 0, 6, 0xffffff, 0)
      .setDepth(107).setVisible(false).setBlendMode(Phaser.BlendModes.ADD);
    this.flashHalo = scene.add.circle(0, 0, 14, PALETTE.green, 0)
      .setDepth(106).setVisible(false).setBlendMode(Phaser.BlendModes.ADD);
    this.holeRing = scene.add.circle(0, 0, 9, PALETTE.green, 0)
      .setDepth(106).setVisible(false).setStrokeStyle(2, PALETTE.green, 0.9);
    this.holeRing.setBlendMode(Phaser.BlendModes.ADD);

    for (let i = 0; i < SHARD_COUNT + 4; i += 1) {
      const shard = scene.add.rectangle(0, 0, 8, 12, PALETTE.green, 0.92)
        .setDepth(107).setVisible(false).setActive(false);
      this.shardPool.push(shard);
    }
  }

  canShatter(now: number): boolean {
    return now - this.lastShatterAt >= COOLDOWN_MS;
  }

  shatter(worldX: number, worldY: number, reducedQuality = false): boolean {
    const now = this.scene.time.now;
    if (!this.canShatter(now)) return false;
    this.lastShatterAt = now;
    this.clearActive();

    const count = reducedQuality ? 6 : SHARD_COUNT;
    const baseAngle = Phaser.Math.FloatBetween(0, Math.PI * 2);

    this.flashCore.setPosition(worldX, worldY).setVisible(true).setAlpha(0.95).setScale(0.4);
    this.flashHalo.setPosition(worldX, worldY).setVisible(true).setAlpha(0.72).setScale(0.5);
    this.holeRing.setPosition(worldX, worldY).setVisible(true).setAlpha(0.95).setScale(0.6);

    this.drawCracks(worldX, worldY);

    const flashTween1 = this.scene.tweens.add({
      targets: this.flashCore,
      scale: 2.8,
      alpha: 0,
      duration: 180,
      ease: 'Cubic.easeOut',
      onComplete: () => this.flashCore.setVisible(false),
    });
    const flashTween2 = this.scene.tweens.add({
      targets: this.flashHalo,
      scale: 2.2,
      alpha: 0,
      duration: 280,
      ease: 'Cubic.easeOut',
      onComplete: () => this.flashHalo.setVisible(false),
    });
    const ringTween = this.scene.tweens.add({
      targets: this.holeRing,
      scale: 1.8,
      alpha: 0,
      duration: 420,
      ease: 'Quad.easeOut',
      onComplete: () => this.holeRing.setVisible(false),
    });
    this.activeTweens.push(flashTween1, flashTween2, ringTween);

    const crackTween = this.scene.tweens.add({
      targets: this.crackGraphics,
      alpha: { from: 1, to: 0 },
      duration: 520,
      delay: 140,
      ease: 'Sine.easeIn',
      onComplete: () => this.crackGraphics.setVisible(false).setAlpha(1),
    });
    this.activeTweens.push(crackTween);

    for (let i = 0; i < count; i += 1) {
      const shard = this.shardPool.pop();
      if (!shard) break;
      this.activeShards.push(shard);
      const angle = baseAngle + (Math.PI * 2 * i) / count + Phaser.Math.FloatBetween(-0.22, 0.22);
      const speed = Phaser.Math.Between(180, 380);
      const distance = speed * 0.42;
      const shardW = Phaser.Math.Between(5, 11);
      const shardH = Phaser.Math.Between(9, 18);
      shard.setPosition(worldX, worldY)
        .setSize(shardW, shardH)
        .setRotation(angle + Math.PI / 4)
        .setFillStyle(i % 3 === 0 ? 0xffffff : PALETTE.green, i % 3 === 0 ? 0.92 : 0.88)
        .setStrokeStyle(i % 2 === 0 ? 1 : 0, PALETTE.green, 0.35)
        .setVisible(true).setActive(true).setAlpha(1).setScale(1);

      const tween = this.scene.tweens.add({
        targets: shard,
        x: worldX + Math.cos(angle) * distance + Phaser.Math.Between(-8, 8),
        y: worldY + Math.sin(angle) * distance + 26 + Phaser.Math.Between(-6, 12),
        angle: shard.angle + Phaser.Math.Between(-420, 420),
        alpha: 0,
        scaleX: 0.3,
        scaleY: 0.3,
        duration: 380 + Phaser.Math.Between(0, 140),
        delay: i * 12,
        ease: 'Quad.easeOut',
        onComplete: () => this.recycleShard(shard),
      });
      this.activeTweens.push(tween);
    }

    for (let i = 0; i < (reducedQuality ? 2 : 4); i += 1) {
      const sparkAngle = baseAngle + i * (Math.PI / 2) + Phaser.Math.FloatBetween(-0.3, 0.3);
      const spark = this.shardPool.pop();
      if (!spark) break;
      this.activeShards.push(spark);
      spark.setPosition(worldX, worldY)
        .setSize(2, 14)
        .setRotation(sparkAngle)
        .setFillStyle(PALETTE.green, 0.95)
        .setVisible(true).setActive(true).setAlpha(1).setScale(1);
      const st = this.scene.tweens.add({
        targets: spark,
        x: worldX + Math.cos(sparkAngle) * 44,
        y: worldY + Math.sin(sparkAngle) * 44,
        scaleY: 0.15,
        alpha: 0,
        duration: 260,
        delay: 18 + i * 14,
        ease: 'Quad.easeOut',
        onComplete: () => this.recycleShard(spark),
      });
      this.activeTweens.push(st);
    }

    this.cleanupTimer?.remove(false);
    this.cleanupTimer = this.scene.time.delayedCall(SHATTER_DURATION + 200, () => this.clearActive());

    try { navigator.vibrate?.(12); } catch { /* ignore */ }

    this.scene.cameras.main.shake(90, 0.006);

    return true;
  }

  private drawCracks(cx: number, cy: number): void {
    const g = this.crackGraphics;
    g.clear().setPosition(0, 0).setVisible(true).setAlpha(1);
    g.lineStyle(1.5, PALETTE.green, 0.92);
    g.strokeCircle(cx, cy, 10);
    g.lineStyle(1, PALETTE.green, 0.55);
    g.strokeCircle(cx, cy, 18);
    g.lineStyle(1.5, PALETTE.green, 0.88);
    for (let i = 0; i < 8; i += 1) {
      const angle = (Math.PI * 2 * i) / 8 + Phaser.Math.FloatBetween(-0.12, 0.12);
      const len = 26 + Phaser.Math.Between(-6, 10);
      const midJitter = Phaser.Math.Between(-4, 4);
      const midX = cx + Math.cos(angle) * (len * 0.52) + Math.cos(angle + Math.PI / 2) * midJitter * 0.3;
      const midY = cy + Math.sin(angle) * (len * 0.52) + Math.sin(angle + Math.PI / 2) * midJitter * 0.3;
      const endX = cx + Math.cos(angle) * len;
      const endY = cy + Math.sin(angle) * len;
      g.lineBetween(cx + Math.cos(angle) * 8, cy + Math.sin(angle) * 8, midX, midY);
      g.lineBetween(midX, midY, endX, endY);
      if (i % 2 === 0) {
        const branchAngle = angle + Phaser.Math.FloatBetween(-0.55, 0.55);
        const branchLen = 9 + Phaser.Math.Between(0, 7);
        g.lineStyle(1, PALETTE.green, 0.48);
        g.lineBetween(midX, midY, midX + Math.cos(branchAngle) * branchLen, midY + Math.sin(branchAngle) * branchLen);
        g.lineStyle(1.5, PALETTE.green, 0.88);
      }
    }
    g.lineStyle(1, 0xffffff, 0.28);
    for (let i = 0; i < 4; i += 1) {
      const a1 = (Math.PI * 2 * i) / 4;
      const a2 = (Math.PI * 2 * (i + 1)) / 4;
      const r = 14;
      const x1 = cx + Math.cos(a1) * r;
      const y1 = cy + Math.sin(a1) * r;
      const x2 = cx + Math.cos(a2) * r;
      const y2 = cy + Math.sin(a2) * r;
      if (i % 2 === 0) g.lineBetween(x1, y1, x2, y2);
    }
  }

  private recycleShard(shard: Phaser.GameObjects.Rectangle): void {
    shard.setVisible(false).setActive(false).setAlpha(1).setScale(1);
    const idx = this.activeShards.indexOf(shard);
    if (idx !== -1) this.activeShards.splice(idx, 1);
    if (!this.shardPool.includes(shard)) this.shardPool.push(shard);
  }

  private clearActive(): void {
    for (const t of this.activeTweens) t.stop();
    this.activeTweens = [];
    for (const s of [...this.activeShards]) this.recycleShard(s);
    this.crackGraphics.setVisible(false).setAlpha(1);
    this.flashCore.setVisible(false);
    this.flashHalo.setVisible(false);
    this.holeRing.setVisible(false);
  }

  destroy(): void {
    this.cleanupTimer?.remove(false);
    this.clearActive();
    this.crackGraphics.destroy();
    this.flashCore.destroy();
    this.flashHalo.destroy();
    this.holeRing.destroy();
    for (const s of this.shardPool) s.destroy();
    for (const s of this.activeShards) s.destroy();
    this.shardPool = [];
    this.activeShards = [];
  }
}

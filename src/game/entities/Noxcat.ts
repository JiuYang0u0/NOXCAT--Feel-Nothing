import Phaser from 'phaser';
import { AssetRegistry } from '../../assets/AssetRegistry';
import {
  NOXCAT_DISPLAY_WIDTH,
  NOXCAT_DISPLAY_HEIGHT,
  NOXCAT_FACE_TEXTURE,
  sampleNoxcatBunOutline,
} from '../../assets/noxcatDesign';
import { PALETTE } from '../../theme/palette';
import {
  calculateJellyPose,
  createReturnArc,
  noxcatPerspectiveScale,
  releasePulse,
  RELEASE_PULSE_DURATION_SECONDS,
  sampleReturnArc,
  springScalar,
  type JellyPose,
  type ReturnArc,
} from '../systems/JellyMotionSystem';
import {
  AIM_MAX_PULL,
  FINGER_OFFSET_Y,
  GAME_HEIGHT,
  GAME_WIDTH,
  MAX_FOLLOW_SPEED,
  PLAYER_HIT_RADIUS,
  PLAYER_MIN_X,
  PLAYER_MAX_X,
  PLAYER_MIN_Y,
  PLAYER_MAX_Y,
  POSITION_DAMPING,
  POSITION_STIFFNESS,
} from '../constants';
import type { CollisionPoint } from '../systems/CollisionMath';

export type NoxcatMode = 'follow' | 'aim' | 'launched' | 'impact' | 'returning';

export interface NoxcatVisualSnapshot {
  mode: NoxcatMode;
  x: number;
  y: number;
  speed: number;
  isDragging: boolean;
  scaleX: number;
  scaleY: number;
  depthScale: number;
  eyeX: number;
  activeGhosts: number;
  activeDroplets: number;
  ghostLimit: number;
  dropletLimit: number;
  glowLayerCount: number;
  glowOuterAlpha: number;
  bodyDisplayWidth: number;
  bodyDisplayHeight: number;
  eyeDisplayWidth: number;
  eyeDisplayHeight: number;
  goggleDisplayWidth: number;
  goggleDisplayHeight: number;
  goggleVisible: boolean;
  hitRadius: number;
}

interface GooDroplet {
  display: Phaser.GameObjects.Ellipse;
  velocityX: number;
  velocityY: number;
  age: number;
  duration: number;
}

// Compact enough to leave readable dodge space on a 390px-wide phone while
// retaining the official logo silhouette. The fixed hit circle stays separate.
const BODY_DISPLAY_WIDTH = NOXCAT_DISPLAY_WIDTH;
const BODY_DISPLAY_HEIGHT = NOXCAT_DISPLAY_HEIGHT;
const DROPLET_COUNT = 6;
const GHOST_COUNT = 8;
const COLLISION_OUTLINE = sampleNoxcatBunOutline();

export class Noxcat extends Phaser.GameObjects.Container {
  readonly hitRadius = PLAYER_HIT_RADIUS;
  readonly visual: Phaser.GameObjects.Container;
  readonly shadow: Phaser.GameObjects.Ellipse;

  private readonly bodyImage: Phaser.GameObjects.Image;
  private readonly bodyGlowLayers: Phaser.GameObjects.Image[];
  private readonly eyes: Phaser.GameObjects.Image;
  private readonly goggles: Phaser.GameObjects.Image;
  private readonly ghosts: Phaser.GameObjects.Image[];
  private readonly droplets: GooDroplet[];
  private readonly target = new Phaser.Math.Vector2();
  private readonly velocity = new Phaser.Math.Vector2();
  private readonly launchVelocity = new Phaser.Math.Vector2();
  private readonly visualVelocity = new Phaser.Math.Vector2();
  private returnArc: ReturnArc | null = null;
  private returnElapsed = 0;

  private desiredScaleX = 1;
  private desiredScaleY = 1;
  private scaleVelocityX = 0;
  private scaleVelocityY = 0;
  private sloshVelocityX = 0;
  private sloshVelocityY = 0;
  private ghostClock = 0;
  private dropletCooldown = 0;
  private ghostLimit = GHOST_COUNT;
  private dropletLimit = DROPLET_COUNT;
  private lastDirection = -1;
  private previousVelocityAngle = 0;
  private wobble = 0;
  private wobbleVelocity = 0;
  private releaseElapsed = RELEASE_PULSE_DURATION_SECONDS;
  private releaseStrength = 0;
  private releaseHorizontal = true;
  private aimAngle = 0;
  private aimPull01 = 0;
  private impactElapsed = 0;
  private impactHorizontal = true;
  private dragging = false;
  private gestureImpulse = 0;
  private gestureAngle = 0;

  mode: NoxcatMode = 'follow';

  constructor(scene: Phaser.Scene, x = GAME_WIDTH / 2, y = GAME_HEIGHT * 0.77) {
    super(scene, Phaser.Math.Clamp(x, PLAYER_MIN_X, PLAYER_MAX_X), Phaser.Math.Clamp(y, PLAYER_MIN_Y, PLAYER_MAX_Y));
    scene.add.existing(this);
    this.target.set(this.x, this.y);

    this.shadow = scene.add.ellipse(0, 72, 122, 10, 0x000000, 0.5);
    this.bodyGlowLayers = [
      { scale: 1.14, alpha: 0.055, additive: true },
      { scale: 1.075, alpha: 0.15, additive: true },
      { scale: 1.03, alpha: 0.82, additive: false },
    ].map(({ scale, alpha, additive }) => {
      const layer = scene.add.image(0, 0, AssetRegistry.key('noxcat.body'))
        .setOrigin(0.5)
        .setDisplaySize(BODY_DISPLAY_WIDTH * scale, BODY_DISPLAY_HEIGHT * scale)
        .setTintFill(PALETTE.green)
        .setAlpha(alpha);
      if (additive) layer.setBlendMode(Phaser.BlendModes.ADD);
      return layer;
    });
    this.bodyImage = scene.add.image(0, 0, AssetRegistry.key('noxcat.body'))
      .setOrigin(0.5)
      .setDisplaySize(BODY_DISPLAY_WIDTH, BODY_DISPLAY_HEIGHT);
    this.eyes = scene.add.image(0, 0, AssetRegistry.key('noxcat.eyes'))
      .setOrigin(0.5)
      .setDisplaySize(BODY_DISPLAY_WIDTH, BODY_DISPLAY_HEIGHT);
    this.goggles = scene.add.image(0, 0, AssetRegistry.key('noxcat.goggles'))
      .setOrigin(0.5)
      .setDisplaySize(BODY_DISPLAY_WIDTH, BODY_DISPLAY_HEIGHT);
    this.visual = scene.add.container(0, 0, [
      ...this.bodyGlowLayers,
      this.bodyImage,
      this.eyes,
      this.goggles,
    ]);
    this.add([this.shadow, this.visual]);
    this.setDepth(30);

    this.ghosts = Array.from({ length: GHOST_COUNT }, () => scene.add
      .image(x, y, AssetRegistry.key('noxcat.body'))
      .setOrigin(0.5)
      .setDisplaySize(BODY_DISPLAY_WIDTH, BODY_DISPLAY_HEIGHT)
      .setAlpha(0)
      .setTintFill(PALETTE.green)
      .setDepth(21));

    this.droplets = Array.from({ length: DROPLET_COUNT }, () => ({
      display: scene.add.ellipse(x, y, 13, 7, PALETTE.green, 1)
        .setStrokeStyle(1, 0xf3ffae, 0.5)
        .setDepth(23)
        .setAlpha(0)
        .setVisible(false),
      velocityX: 0,
      velocityY: 0,
      age: 1,
      duration: 0,
    }));
  }

  get speed(): number {
    return this.mode === 'launched' ? this.launchVelocity.length() : this.velocity.length();
  }

  get velocityVector(): Phaser.Math.Vector2 {
    return this.mode === 'launched' ? this.launchVelocity.clone() : this.velocity.clone();
  }

  visualSnapshot(): NoxcatVisualSnapshot {
    return {
      mode: this.mode,
      x: this.x,
      y: this.y,
      speed: this.speed,
      isDragging: this.dragging,
      scaleX: this.visual.scaleX,
      scaleY: this.visual.scaleY,
      depthScale: this.scaleX,
      eyeX: this.eyes.x,
      activeGhosts: this.ghosts.filter((ghost) => ghost.visible && ghost.alpha > 0.008).length,
      activeDroplets: this.droplets.filter((droplet) => droplet.display.visible).length,
      ghostLimit: this.ghostLimit,
      dropletLimit: this.dropletLimit,
      glowLayerCount: this.bodyGlowLayers.length,
      glowOuterAlpha: this.bodyGlowLayers[0]?.alpha ?? 0,
      bodyDisplayWidth: this.bodyImage.displayWidth,
      bodyDisplayHeight: this.bodyImage.displayHeight,
      eyeDisplayWidth: this.eyes.displayWidth * Math.abs(this.visual.scaleX),
      eyeDisplayHeight: this.eyes.displayHeight * Math.abs(this.visual.scaleY),
      goggleDisplayWidth: this.goggles.displayWidth * Math.abs(this.visual.scaleX),
      goggleDisplayHeight: this.goggles.displayHeight * Math.abs(this.visual.scaleY),
      goggleVisible: this.goggles.visible,
      hitRadius: this.hitRadius,
    };
  }

  setGogglesVisible(visible: boolean): void {
    this.goggles.setVisible(visible);
  }

  /** Actual transformed SVG body outline used for document overlap checks. */
  collisionPolygon(): readonly CollisionPoint[] {
    const rootScale = Math.abs(this.scaleX);
    const localScaleX = this.visual.scaleX;
    const localScaleY = this.visual.scaleY;
    const cosine = Math.cos(this.visual.rotation);
    const sine = Math.sin(this.visual.rotation);
    const flip = this.bodyImage.flipX ? -1 : 1;
    return COLLISION_OUTLINE.map((point) => {
      const localX = (point.x - NOXCAT_FACE_TEXTURE.width / 2) * (BODY_DISPLAY_WIDTH / NOXCAT_FACE_TEXTURE.width) * flip * localScaleX;
      const localY = (point.y - NOXCAT_FACE_TEXTURE.height / 2) * (BODY_DISPLAY_HEIGHT / NOXCAT_FACE_TEXTURE.height) * localScaleY;
      const rotatedX = localX * cosine - localY * sine;
      const rotatedY = localX * sine + localY * cosine;
      return {
        x: this.x + rootScale * (this.visual.x + rotatedX),
        y: this.y + rootScale * (this.visual.y + rotatedY),
      };
    });
  }

  beginDrag(): void {
    if (this.mode !== 'follow') return;
    this.dragging = true;
    this.gestureImpulse = 0;
    this.releaseElapsed = RELEASE_PULSE_DURATION_SECONDS;
  }

  releaseDrag(): void {
    if (!this.dragging || this.mode !== 'follow') return;
    this.dragging = false;
    const speed01 = Phaser.Math.Clamp(this.velocity.length() / MAX_FOLLOW_SPEED, 0, 1);
    this.releaseElapsed = 0;
    this.releaseStrength = 0.55 + speed01 * 0.75;
    this.releaseHorizontal = Math.abs(this.velocity.x) >= Math.abs(this.velocity.y);
    this.scaleVelocityX += (this.releaseHorizontal ? 2.4 : -1.7) * this.releaseStrength;
    this.scaleVelocityY += (this.releaseHorizontal ? -1.7 : 2.4) * this.releaseStrength;
    this.wobbleVelocity += Phaser.Math.Clamp(this.velocity.x / MAX_FOLLOW_SPEED, -1, 1) * 1.4;
  }

  cancelDrag(): void {
    this.dragging = false;
  }

  setPointerTarget(x: number, y: number): void {
    if (this.mode !== 'follow') return;
    const nextX = Phaser.Math.Clamp(x, PLAYER_MIN_X, PLAYER_MAX_X);
    const nextY = Phaser.Math.Clamp(y - FINGER_OFFSET_Y, PLAYER_MIN_Y, PLAYER_MAX_Y);
    const pointerDx = nextX - this.target.x;
    const pointerDy = nextY - this.target.y;
    const pointerTravel = Math.hypot(pointerDx, pointerDy);
    if (this.dragging && pointerTravel > 4) {
      this.gestureImpulse = Math.max(
        this.gestureImpulse,
        Phaser.Math.Clamp(pointerTravel / 70, 0, 0.82),
      );
      this.gestureAngle = Math.atan2(pointerDy, pointerDx);
      if (Math.abs(nextX - this.target.x) > 2) {
        this.lastDirection = Math.sign(nextX - this.target.x);
      }
    }
    this.target.set(nextX, nextY);
  }

  nudgeTarget(dx: number, dy: number, dt: number): void {
    if (this.mode !== 'follow') return;
    this.target.x = Phaser.Math.Clamp(this.target.x + dx * 510 * dt, PLAYER_MIN_X, PLAYER_MAX_X);
    this.target.y = Phaser.Math.Clamp(this.target.y + dy * 510 * dt, PLAYER_MIN_Y, PLAYER_MAX_Y);
  }

  beginAim(): void {
    this.mode = 'aim';
    this.clearLaunchEffects();
    this.dragging = false;
    this.velocity.set(0, 0);
    this.aimPull01 = 0;
    this.releaseElapsed = RELEASE_PULSE_DURATION_SECONDS;
  }

  updateAim(pointerX: number, pointerY: number, anchorX: number, anchorY: number): number {
    const dx = pointerX - anchorX;
    const dy = pointerY - anchorY;
    const pull = Math.min(Math.hypot(dx, dy), AIM_MAX_PULL);
    this.aimPull01 = pull / AIM_MAX_PULL;
    this.aimAngle = Math.atan2(dy, dx);
    this.x = Phaser.Math.Clamp(anchorX + Math.cos(this.aimAngle) * pull, PLAYER_MIN_X, PLAYER_MAX_X);
    // 拉力仍以手指距離計算；角色本體不能被拉進底部 HUD。
    this.y = Phaser.Math.Clamp(anchorY + Math.sin(this.aimAngle) * pull, PLAYER_MIN_Y, PLAYER_MAX_Y);
    this.visual.rotation = this.aimAngle;
    this.visual.scaleX = Phaser.Math.Linear(1, 0.72, this.aimPull01);
    this.visual.scaleY = Phaser.Math.Linear(1, 1.24, this.aimPull01);
    this.scaleVelocityX = 0;
    this.scaleVelocityY = 0;
    this.eyes.rotation = 0;
    this.alignFaceLayers();
    const launchDirection = Math.sign(-dx);
    if (launchDirection !== 0) this.lastDirection = launchDirection;
    return pull;
  }

  cancelAim(anchorX: number, anchorY: number): void {
    this.mode = 'follow';
    this.x = anchorX;
    this.y = anchorY;
    this.target.set(anchorX, anchorY);
    this.visual.setPosition(0, 0).setRotation(0).setScale(1);
    this.eyes.setRotation(0).setScale(1);
    this.alignFaceLayers();
    this.scaleVelocityX = 0;
    this.scaleVelocityY = 0;
    this.clearLaunchEffects();
  }

  launch(direction: Phaser.Math.Vector2, speed: number): void {
    this.mode = 'launched';
    this.clearLaunchEffects();
    this.launchVelocity.copy(direction.normalize().scale(speed));
    this.impactHorizontal = Math.abs(this.launchVelocity.x) >= Math.abs(this.launchVelocity.y);
    this.lastDirection = Math.sign(this.launchVelocity.x) || this.lastDirection;
    const pose = calculateJellyPose(this.launchVelocity, {
      maxSpeed: speed,
      stretchAmount: 0.52,
      squashAmount: 0.28,
    });
    this.visual.setRotation(pose.leanRadians).setScale(pose.scaleX, pose.scaleY);
    this.scaleVelocityX = 0;
    this.scaleVelocityY = 0;
    this.eyes.rotation = 0;
    this.alignFaceLayers();
    this.emitDroplets(1, true);
  }

  beginImpact(): void {
    this.mode = 'impact';
    this.clearLaunchEffects();
    this.impactElapsed = 0;
    this.launchVelocity.set(0, 0);
    this.scaleVelocityX = 0;
    this.scaleVelocityY = 0;
    this.visual.rotation = 0;
    this.eyes.rotation = 0;
    this.visual.scaleX = this.impactHorizontal ? 0.5 : 1.5;
    this.visual.scaleY = this.impactHorizontal ? 1.5 : 0.5;
    this.alignFaceLayers();
  }

  startReturn(targetX: number, targetY: number): void {
    this.mode = 'returning';
    this.clearLaunchEffects();
    this.target.set(
      Phaser.Math.Clamp(targetX, PLAYER_MIN_X, PLAYER_MAX_X),
      Phaser.Math.Clamp(targetY, PLAYER_MIN_Y, PLAYER_MAX_Y),
    );
    const bendSide = Math.sign(this.launchVelocity.x) || this.lastDirection || 1;
    this.returnArc = createReturnArc(
      { x: this.x, y: this.y },
      { x: this.target.x, y: this.target.y },
      bendSide,
    );
    this.returnElapsed = 0;
    const initial = sampleReturnArc(this.returnArc, 0);
    this.velocity.set(initial.velocityX, initial.velocityY);
    this.launchVelocity.set(0, 0);
    this.impactElapsed = 0;
  }

  finishReturn(): void {
    this.mode = 'follow';
    this.returnArc = null;
    this.returnElapsed = 0;
    this.x = this.target.x;
    this.y = this.target.y;
    this.velocity.set(0, 0);
    this.visual.setPosition(0, 0).setRotation(0).setScale(1.16, 0.82);
    this.eyes.rotation = 0;
    this.alignFaceLayers();
    this.scaleVelocityX = 0;
    this.scaleVelocityY = 0;
    this.releaseElapsed = 0;
    this.releaseStrength = 0.95;
    this.releaseHorizontal = true;
    this.clearLaunchEffects();
  }

  hitFeedback(): void {
    this.releaseElapsed = 0;
    this.releaseStrength = 1.15;
    this.releaseHorizontal = Math.abs(this.velocity.x) >= Math.abs(this.velocity.y);
    this.scene.tweens.add({
      targets: this,
      alpha: 0.25,
      duration: 90,
      yoyo: true,
      repeat: 5,
    });
  }

  updateMotion(deltaSeconds: number): void {
    const dt = Math.min(deltaSeconds, 1 / 20);
    // Keep the latest direct-pointer impulse while the finger is held. This
    // makes the deform readable even when a busy mobile browser coalesces
    // render frames after delivering its pointer-move events.
    if (!this.dragging) this.gestureImpulse *= Math.exp(-8 * dt);
    this.dropletCooldown = Math.max(0, this.dropletCooldown - dt);
    this.updateGhosts(dt);
    this.updateDroplets(dt);
    this.updateWobble(dt);

    if (this.mode === 'launched') {
      this.x += this.launchVelocity.x * dt;
      this.y += this.launchVelocity.y * dt;
      this.updatePerspectiveScale(dt);
      const pose = calculateJellyPose(this.launchVelocity, {
        maxSpeed: Math.max(1, this.launchVelocity.length()),
        stretchAmount: 0.52,
        squashAmount: 0.28,
      });
      this.updateVisualRig(dt, pose, 0.008);
      this.updateLaunchEffects(dt);
      return;
    }

    if (this.mode === 'impact') {
      this.updatePerspectiveScale(dt);
      this.impactElapsed += dt;
      const rebound = this.impactElapsed < 0.12;
      this.desiredScaleX = this.impactHorizontal
        ? (rebound ? 1.34 : 1.04)
        : (rebound ? 0.74 : 0.98);
      this.desiredScaleY = this.impactHorizontal
        ? (rebound ? 0.74 : 0.98)
        : (rebound ? 1.34 : 1.04);
      this.applyScaleSpring(dt, 150, 14);
      this.visual.x = Phaser.Math.Linear(this.visual.x, 0, 1 - Math.exp(-18 * dt));
      this.visual.y = Phaser.Math.Linear(this.visual.y, 0, 1 - Math.exp(-18 * dt));
      this.visual.rotation = Phaser.Math.Linear(this.visual.rotation, 0, 1 - Math.exp(-16 * dt));
      this.updateFacing();
      return;
    }

    if (this.mode === 'aim') {
      this.updatePerspectiveScale(dt);
      this.visual.x = Phaser.Math.Linear(this.visual.x, 0, 1 - Math.exp(-18 * dt));
      this.visual.y = Phaser.Math.Linear(this.visual.y, 0, 1 - Math.exp(-18 * dt));
      this.updateFacing();
      return;
    }

    if (this.mode === 'returning' && this.returnArc) {
      this.returnElapsed += dt;
      const sample = sampleReturnArc(this.returnArc, this.returnElapsed);
      this.x = sample.x;
      this.y = sample.y;
      this.updatePerspectiveScale(dt);
      this.velocity.set(sample.velocityX, sample.velocityY);
      const pose = calculateJellyPose(this.velocity, {
        maxSpeed: MAX_FOLLOW_SPEED,
        stretchAmount: 0.3,
        squashAmount: 0.18,
      });
      this.updateVisualRig(dt, pose, 0.01);
      if (sample.progress >= 1) this.finishReturn();
      return;
    }

    this.integratePosition(dt);
    this.updatePerspectiveScale(dt);
    this.visualVelocity.copy(this.velocity);
    const speed01 = Phaser.Math.Clamp(this.velocity.length() / MAX_FOLLOW_SPEED, 0, 1);
    if (this.dragging && this.gestureImpulse > speed01) {
      this.visualVelocity.setToPolar(this.gestureAngle, this.gestureImpulse * MAX_FOLLOW_SPEED);
    }
    const pose = calculateJellyPose(this.visualVelocity, {
      maxSpeed: MAX_FOLLOW_SPEED,
      // With the rejected ribbon removed, ordinary movement is communicated
      // by a clearer but still logo-safe bun squash and elastic overshoot.
      stretchAmount: this.dragging ? 0.27 : 0.19,
      squashAmount: this.dragging ? 0.17 : 0.11,
    });
    this.applyReleasePulse(pose, dt);
    this.detectSharpTurn(pose);
    this.updateVisualRig(dt, pose, 0.018);
  }

  setGhostQuality(count: number): void {
    this.ghostLimit = Phaser.Math.Clamp(Math.floor(count), 0, GHOST_COUNT);
    this.ghosts.forEach((ghost, index) => {
      const enabled = index < this.ghostLimit;
      ghost.setActive(enabled).setVisible(enabled && ghost.alpha > 0.01);
    });
    this.dropletLimit = this.ghostLimit >= GHOST_COUNT ? DROPLET_COUNT : 3;
  }

  override destroy(fromScene?: boolean): void {
    this.ghosts.forEach((ghost) => ghost.destroy());
    this.droplets.forEach((droplet) => droplet.display.destroy());
    super.destroy(fromScene);
  }

  private integratePosition(dt: number): void {
    [this.x, this.velocity.x] = springScalar(
      this.x,
      this.velocity.x,
      this.target.x,
      POSITION_STIFFNESS,
      POSITION_DAMPING,
      dt,
    );
    [this.y, this.velocity.y] = springScalar(
      this.y,
      this.velocity.y,
      this.target.y,
      POSITION_STIFFNESS,
      POSITION_DAMPING,
      dt,
    );
    if (this.velocity.length() > MAX_FOLLOW_SPEED) this.velocity.setLength(MAX_FOLLOW_SPEED);
    const clampedX = Phaser.Math.Clamp(this.x, PLAYER_MIN_X, PLAYER_MAX_X);
    const clampedY = Phaser.Math.Clamp(this.y, PLAYER_MIN_Y, PLAYER_MAX_Y);
    if (clampedX !== this.x) this.velocity.x = 0;
    if (clampedY !== this.y) this.velocity.y = 0;
    this.x = clampedX;
    this.y = clampedY;
  }

  private applyReleasePulse(pose: JellyPose, dt: number): void {
    if (this.releaseElapsed >= RELEASE_PULSE_DURATION_SECONDS) {
      this.desiredScaleX = pose.scaleX;
      this.desiredScaleY = pose.scaleY;
      return;
    }

    this.releaseElapsed += dt;
    const pulse = releasePulse(
      this.releaseElapsed,
      0.26 * this.releaseStrength,
      RELEASE_PULSE_DURATION_SECONDS,
    );
    this.desiredScaleX = pose.scaleX + (this.releaseHorizontal ? pulse : -pulse * 0.72);
    this.desiredScaleY = pose.scaleY + (this.releaseHorizontal ? -pulse * 0.72 : pulse);
  }

  private detectSharpTurn(pose: JellyPose): void {
    if (pose.speed < 120) return;
    const velocityAngle = Math.atan2(this.velocity.y, this.velocity.x);
    const turn = Phaser.Math.Angle.Wrap(velocityAngle - this.previousVelocityAngle);
    if (Math.abs(turn) > 0.5 && pose.speed01 > 0.28) {
      this.wobbleVelocity += Phaser.Math.Clamp(turn, -0.8, 0.8) * 2.4;
    }
    this.previousVelocityAngle = velocityAngle;
  }

  private updateWobble(dt: number): void {
    [this.wobble, this.wobbleVelocity] = springScalar(
      this.wobble,
      this.wobbleVelocity,
      0,
      72,
      10,
      dt,
    );
  }

  private updateVisualRig(dt: number, pose: JellyPose, sloshFactor: number): void {
    if (this.releaseElapsed >= RELEASE_PULSE_DURATION_SECONDS) {
      this.desiredScaleX = pose.scaleX;
      this.desiredScaleY = pose.scaleY;
    }
    const releasing = this.releaseElapsed < RELEASE_PULSE_DURATION_SECONDS;
    this.applyScaleSpring(dt, releasing ? 145 : 96, releasing ? 11 : 13);

    const effectVelocity = this.velocityForEffects();
    let desiredX = -effectVelocity.x * sloshFactor;
    let desiredY = -effectVelocity.y * sloshFactor;
    const sloshLength = Math.hypot(desiredX, desiredY);
    if (sloshLength > 18) {
      desiredX *= 18 / sloshLength;
      desiredY *= 18 / sloshLength;
    }
    [this.visual.x, this.sloshVelocityX] = springScalar(
      this.visual.x,
      this.sloshVelocityX,
      desiredX,
      120,
      16,
      dt,
    );
    [this.visual.y, this.sloshVelocityY] = springScalar(
      this.visual.y,
      this.sloshVelocityY,
      desiredY,
      120,
      16,
      dt,
    );

    const desiredRotation = pose.leanRadians + Phaser.Math.Clamp(this.wobble, -0.2, 0.2);
    this.visual.rotation += Phaser.Math.Angle.Wrap(desiredRotation - this.visual.rotation)
      * (1 - Math.exp(-14 * dt));
    if (Math.abs(effectVelocity.x) > 24) this.lastDirection = Math.sign(effectVelocity.x);
    this.updateFacing();
    this.shadow.scaleX = Phaser.Math.Linear(
      this.shadow.scaleX,
      1 + pose.speed01 * 0.14,
      1 - Math.exp(-10 * dt),
    );
    this.shadow.scaleY = Phaser.Math.Linear(
      this.shadow.scaleY,
      1 - pose.speed01 * 0.18,
      1 - Math.exp(-10 * dt),
    );
  }

  private applyScaleSpring(dt: number, stiffness: number, damping: number): void {
    [this.visual.scaleX, this.scaleVelocityX] = springScalar(
      this.visual.scaleX,
      this.scaleVelocityX,
      this.desiredScaleX,
      stiffness,
      damping,
      dt,
    );
    [this.visual.scaleY, this.scaleVelocityY] = springScalar(
      this.visual.scaleY,
      this.scaleVelocityY,
      this.desiredScaleY,
      stiffness,
      damping,
      dt,
    );
  }

  private updatePerspectiveScale(dt: number): void {
    const targetScale = noxcatPerspectiveScale(this.y);
    const response = 1 - Math.exp(-12 * dt);
    const scale = Phaser.Math.Linear(this.scaleX, targetScale, response);
    // The broad-phase hitRadius stays fixed; exact overlap uses collisionPolygon(),
    // which includes this root scale and therefore matches the visible far cat.
    this.setScale(scale);
  }

  private updateFacing(): void {
    const facesRight = this.lastDirection > 0;
    this.bodyImage.setFlipX(facesRight);
    this.bodyGlowLayers.forEach((layer) => layer.setFlipX(facesRight));
    this.eyes.setFlipX(facesRight);
    this.goggles.setFlipX(facesRight);
    this.alignFaceLayers();
  }

  private alignFaceLayers(): void {
    // All layers share the traced logo coordinates. Jelly deformation and
    // perspective apply to the complete face, keeping eye spacing registered.
    this.eyes.setPosition(0, 0).setRotation(0)
      .setDisplaySize(BODY_DISPLAY_WIDTH, BODY_DISPLAY_HEIGHT);
    this.goggles.setPosition(0, 0).setRotation(0)
      .setDisplaySize(BODY_DISPLAY_WIDTH, BODY_DISPLAY_HEIGHT);
  }

  private updateLaunchEffects(dt: number): void {
    this.emitGhost(dt);
    this.emitDroplets(0.42, false);
  }

  private emitGhost(dt: number): void {
    if (this.mode !== 'launched') return;
    this.ghostClock += dt;
    if (this.ghostClock < 0.055) return;
    this.ghostClock = 0;
    const ghost = this.ghosts.reduce((best, candidate) => candidate.alpha < best.alpha ? candidate : best);
    if (!ghost.active) return;
    ghost.setPosition(this.x + this.visual.x, this.y + this.visual.y)
      .setRotation(this.visual.rotation)
      .setFlipX(this.bodyImage.flipX)
      .setDisplaySize(
        BODY_DISPLAY_WIDTH * this.scaleX * Math.max(0.62, this.visual.scaleX),
        BODY_DISPLAY_HEIGHT * this.scaleY * Math.max(0.62, this.visual.scaleY),
      )
      .setAlpha(0.065)
      .setVisible(true);
  }

  private updateGhosts(dt: number): void {
    for (const ghost of this.ghosts) {
      if (!ghost.active || ghost.alpha <= 0.008) {
        ghost.setAlpha(0).setVisible(false);
        continue;
      }
      ghost.alpha *= Math.exp(-7.5 * dt);
      ghost.scaleX *= Math.exp(-0.25 * dt);
      ghost.scaleY *= Math.exp(-0.25 * dt);
    }
  }

  private emitDroplets(strength: number, force: boolean): void {
    if (!force && this.dropletCooldown > 0) return;
    this.dropletCooldown = force ? 0.08 : 0.14;
    const effectVelocity = this.velocityForEffects();
    const speed = Math.hypot(effectVelocity.x, effectVelocity.y);
    const directionX = speed > 1 ? effectVelocity.x / speed : this.lastDirection;
    const directionY = speed > 1 ? effectVelocity.y / speed : 0;
    const perpendicularX = -directionY;
    const perpendicularY = directionX;

    for (let index = 0; index < this.dropletLimit; index += 1) {
      const droplet = this.droplets[index];
      if (!droplet) continue;
      const side = index % 2 === 0 ? -1 : 1;
      const spread = side * (15 + index * 4);
      droplet.display
        .setPosition(
          this.x - directionX * (36 + index * 7) + perpendicularX * spread * 0.55,
          this.y - directionY * (36 + index * 7) + perpendicularY * spread * 0.55,
        )
        .setDisplaySize(11 + strength * 8, 5 + strength * 4)
        .setScale(1)
        .setAlpha(0.68 * strength)
        .setVisible(true);
      droplet.velocityX = -directionX * (78 + index * 17) + perpendicularX * spread * 1.35;
      droplet.velocityY = -directionY * (78 + index * 17) + perpendicularY * spread * 1.35 - 18;
      droplet.age = 0;
      droplet.duration = 0.36 + index * 0.03;
    }
  }

  private updateDroplets(dt: number): void {
    for (const droplet of this.droplets) {
      if (!droplet.display.visible) continue;
      droplet.age += dt;
      if (droplet.age >= droplet.duration) {
        droplet.display.setVisible(false).setAlpha(0);
        continue;
      }
      droplet.velocityY += 65 * dt;
      droplet.display.x += droplet.velocityX * dt;
      droplet.display.y += droplet.velocityY * dt;
      droplet.display.rotation = Math.atan2(droplet.velocityY, droplet.velocityX);
      const remaining = 1 - droplet.age / droplet.duration;
      droplet.display.setAlpha(0.64 * remaining).setScale(0.55 + remaining * 0.65);
    }
  }

  private velocityForEffects(): Phaser.Math.Vector2 {
    return this.mode === 'launched' ? this.launchVelocity : this.velocity;
  }

  private clearLaunchEffects(): void {
    this.ghostClock = 0;
    for (const ghost of this.ghosts) ghost.setAlpha(0).setVisible(false);
    for (const droplet of this.droplets) droplet.display.setAlpha(0).setVisible(false);
  }
}

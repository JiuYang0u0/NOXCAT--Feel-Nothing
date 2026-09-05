import Phaser from 'phaser';
import { AssetRegistry } from '../../assets/AssetRegistry';
import { PALETTE, PALETTE_CSS } from '../../theme/palette';
import { interpolateThresholdCrossing } from '../systems/CollisionMath';
import { trackHomingTarget } from '../systems/HomingGuidance';
import {
  accelerateProjectileExit,
  initialProjectileExitVelocity,
} from '../systems/ProjectileExitMotion';
import {
  BOSS_PROJECTILE_ORIGIN,
  calculateTunnelDepthPose,
  createProjectilePerspectiveGridData,
  createProjectilePerspectiveProjection,
  createTunnelTrajectory,
  projectProjectilePerspectiveUv,
  retargetTunnelTrajectory,
  sampleTunnelProjection,
  type TunnelTrajectory,
  type ProjectileKind,
  WALL_CARD_SCALE_Y,
} from '../systems/ProjectileDepth';

export type { ProjectileKind } from '../systems/ProjectileDepth';

// Keep near-plane cards readable without letting one document cover most of
// NOXCAT's available dodge corridor on a narrow phone.
const PROJECTILE_CARD_WIDTH = 40;
const PROJECTILE_CARD_HEIGHT = 52;
// Phaser's 2D mesh shader interpolates texture coordinates per triangle. A
// 4x6 grid keeps the paper artwork visually rigid under a strong keystone
// without creating per-frame objects or an expensive custom shader.
const PROJECTILE_GRID_COLUMNS = 4;
const PROJECTILE_GRID_ROWS = 6;
const PROJECTILE_GRID = createProjectilePerspectiveGridData(
  PROJECTILE_CARD_WIDTH,
  PROJECTILE_CARD_HEIGHT,
  PROJECTILE_GRID_COLUMNS,
  PROJECTILE_GRID_ROWS,
);
// Closing-wall documents overlap horizontally at the near plane, turning the
// row into a real barrier across both edge lanes instead of two small cards.
const WALL_CARD_WIDTH_SCALE = 2.5;

class ProjectilePerspectiveMesh extends Phaser.GameObjects.Mesh {
  /** Phaser updates Mesh geometry before Scene.update; resync after our step. */
  syncProjection(): void {
    super.preUpdate(0, 0);
  }
}

export interface ProjectileConfig {
  kind: ProjectileKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius?: number;
  /** Fixed signed 3D yaw around the screen's vertical axis, in radians. */
  yawOffset?: number;
  damage?: boolean;
  homingMs?: number;
  homingOffsetX?: number;
  text?: string;
  /** Screen-space point where the far-to-near pass reaches player depth. */
  perspectiveTarget?: Readonly<{ x: number; y: number }>;
  /** Optional wall portal used by attacks that enter from a side of the arena. */
  perspectiveOrigin?: Readonly<{ x: number; y: number }>;
  /** Authored duration of the far-to-near pass, independent of old 2D spawn distance. */
  perspectiveDurationMs?: number;
}

export class Projectile extends Phaser.GameObjects.Container {
  kind: ProjectileKind = 'paper';
  vx = 0;
  vy = 0;
  radius = 18;
  yawOffset = 0;
  isDamage = true;
  reflectable = false;
  friendly = false;
  collisionActive = false;
  effectiveCollisionRadius = 0;
  previousCollisionActive = false;
  previousX = 0;
  previousY = 0;
  tunnelDepth = 0;
  hasGrazedPlayer = false;
  homingRemainingMs = 0;
  ageMs = 0;
  private homingOffsetX = 0;
  private tunnelTrajectory!: TunnelTrajectory;
  private authoredX = 0;
  private authoredY = 0;
  private projectedX = 0;
  private projectedY = 0;
  private projectedYaw = 0;
  private reducedVisualQuality = false;
  private outboundExitActive = false;
  private readonly collisionPoints = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];
  private readonly projectedSurfacePoint = { x: 0, y: 0 };

  private readonly sprite: Phaser.GameObjects.Image;
  private readonly comment: Phaser.GameObjects.Text;
  private readonly perspectiveMesh?: ProjectilePerspectiveMesh;
  private readonly depthShadow: Phaser.GameObjects.Ellipse;
  private readonly visualLayer: Phaser.GameObjects.Container;

  get visibleCenterX(): number {
    return this.x + this.visualLayer.x;
  }

  get visibleCenterY(): number {
    return this.y + this.visualLayer.y;
  }

  /** The screen-space centre used by gameplay collision this frame. */
  get collisionCenterX(): number {
    return this.visibleCenterX;
  }

  /** The screen-space centre used by gameplay collision this frame. */
  get collisionCenterY(): number {
    return this.visibleCenterY;
  }

  get isContinuingOffscreen(): boolean {
    return this.outboundExitActive;
  }

  /** Fixed world/screen-Y plane yaw after lane correction and launch offset. */
  get perspectiveYaw(): number {
    return this.projectedYaw;
  }

  /** Must remain zero: documents never roll around the camera-facing axis. */
  get screenRoll(): number {
    return this.visualLayer.rotation;
  }

  get homingTarget(): Readonly<{ x: number; y: number }> {
    return this.tunnelTrajectory.nearPoint;
  }

  /** Actual screen-space corners of the rendered document this frame. */
  get collisionPolygon(): readonly Readonly<{ x: number; y: number }>[] {
    return this.collisionPoints;
  }

  constructor(scene: Phaser.Scene) {
    super(scene, -200, -200);
    scene.add.existing(this);
    this.depthShadow = scene.add.ellipse(8, 11, 45, 18, 0x000000, 0.38)
      .setStrokeStyle(1, PALETTE.green, 0.12);
    this.sprite = scene.add.image(0, 0, AssetRegistry.key('projectile.paper'))
      .setDisplaySize(PROJECTILE_CARD_WIDTH, PROJECTILE_CARD_HEIGHT);
    this.comment = scene.add.text(0, 0, '', {
      fontFamily: 'Inter, Noto Sans TC, system-ui, sans-serif',
      fontSize: '15px',
      fontStyle: '700',
      color: '#10150e',
      backgroundColor: PALETTE_CSS.green,
      padding: { x: 9, y: 6 }
    }).setOrigin(0.5).setVisible(false);
    if (scene.sys.game.renderer.type === Phaser.WEBGL) {
      this.perspectiveMesh = new ProjectilePerspectiveMesh(
        scene,
        0,
        0,
        AssetRegistry.key('projectile.paper'),
      );
      scene.add.existing(this.perspectiveMesh);
      this.perspectiveMesh.addVertices(
        PROJECTILE_GRID.vertices,
        PROJECTILE_GRID.uvs,
      );
      this.perspectiveMesh.hideCCW = false;
      this.perspectiveMesh.setOrtho(
        this.perspectiveMesh.width,
        this.perspectiveMesh.height,
      );
    }
    this.visualLayer = scene.add.container(0, 0, [
      this.depthShadow,
      this.sprite,
      ...(this.perspectiveMesh ? [this.perspectiveMesh] : []),
      this.comment,
    ]);
    this.add(this.visualLayer);
    this.setDepth(18).setActive(false).setVisible(false);
  }

  reset(config: ProjectileConfig): this {
    this.kind = config.kind;
    this.setPosition(config.x, config.y)
      .setRotation(0)
      .setAlpha(0.24)
      .setScale(1)
      .setDepth(18);
    this.vx = config.vx;
    this.vy = config.vy;
    this.radius = config.radius ?? (config.kind === 'comment' ? 24 : 18);
    this.yawOffset = config.yawOffset ?? 0;
    this.isDamage = config.damage ?? true;
    this.reflectable = config.kind === 'returnable';
    this.friendly = false;
    this.hasGrazedPlayer = false;
    this.homingRemainingMs = config.homingMs ?? 0;
    this.homingOffsetX = config.homingOffsetX ?? 0;
    this.ageMs = 0;
    this.outboundExitActive = false;
    this.projectedYaw = 0;
    this.tunnelDepth = 0;
    this.authoredX = config.x;
    this.authoredY = config.y;
    this.tunnelTrajectory = createTunnelTrajectory(
      { x: config.x, y: config.y },
      { x: config.vx, y: config.vy },
      this.radius,
      config.perspectiveTarget,
      config.perspectiveDurationMs,
      config.perspectiveOrigin,
    );
    const initialProjection = sampleTunnelProjection(
      this.tunnelTrajectory,
      { x: config.x, y: config.y },
    );
    this.collisionActive = initialProjection.collisionActive;
    this.previousCollisionActive = this.collisionActive;
    this.previousX = this.x;
    this.previousY = this.y;
    this.tunnelDepth = initialProjection.depth;
    this.projectedX = initialProjection.position.x;
    this.projectedY = initialProjection.position.y;
    const initialPose = calculateTunnelDepthPose(
      this.kind,
      this.tunnelDepth,
      this.tunnelTrajectory.contactDepth,
    );
    this.effectiveCollisionRadius = this.radius * Math.min(1, initialPose.scale);
    const initialVisualScaleY = this.perspectiveMesh
      ? initialPose.scale
      : initialPose.scale * initialPose.foreshortening;
    this.visualLayer
      .setPosition(this.projectedX - config.x, this.projectedY - config.y)
      .setRotation(0)
      .setScale(initialPose.scale, initialVisualScaleY);
    this.sprite.setVisible(!this.perspectiveMesh && config.kind !== 'comment');
    const asset = config.kind === 'wall' ? 'projectile.wall'
      : this.reflectable ? 'projectile.returnable' : 'projectile.paper';
    this.sprite
      .setTexture(AssetRegistry.key(asset))
      .setDisplaySize(PROJECTILE_CARD_WIDTH, PROJECTILE_CARD_HEIGHT);
    this.sprite.clearTint();
    this.sprite.setRotation(0);
    this.depthShadow.setVisible(true).setAlpha(0.18).setScale(0.55);
    this.comment
      .setVisible(!this.perspectiveMesh && config.kind === 'comment')
      .setText(config.text ?? '這裡對齊');
    this.perspectiveMesh
      ?.setVisible(true)
      .setTexture(config.kind === 'comment'
        ? this.comment.texture.key
        : AssetRegistry.key(asset),
      undefined,
      false,
      false)
      .clearTint();
    this.perspectiveMesh?.setOrtho(
      this.perspectiveMesh.width,
      this.perspectiveMesh.height,
    );
    // Wall rows overlap enough to read as a barrier, but stay short enough
    // that the rendered cards never visually seal their advertised opening.
    if (config.kind === 'wall') {
      this.sprite.setDisplaySize(
        PROJECTILE_CARD_WIDTH * WALL_CARD_WIDTH_SCALE,
        PROJECTILE_CARD_HEIGHT * WALL_CARD_SCALE_Y,
      );
    }
    this.updatePerspectiveSurface(
      this.projectedX,
      this.projectedY,
      initialPose.progress,
      initialPose.scale,
      initialVisualScaleY,
      true,
      this.yawOffset,
    );
    return this.setActive(true).setVisible(true);
  }

  step(deltaSeconds: number, playerX: number, playerY: number, timeScale = 1): void {
    const dt = deltaSeconds * timeScale;
    const positionBeforeStep = { x: this.x, y: this.y };
    const authoredPositionBeforeStep = { x: this.authoredX, y: this.authoredY };
    const tunnelDepthBeforeStep = this.tunnelDepth;
    const collisionWasActive = this.collisionActive;
    this.ageMs += deltaSeconds * 1000;
    if (this.outboundExitActive && !this.friendly) {
      const velocity = accelerateProjectileExit({ x: this.vx, y: this.vy }, dt);
      this.vx = velocity.x;
      this.vy = velocity.y;
    }
    if (this.kind === 'homing' && this.homingRemainingMs > 0 && !this.friendly) {
      const target = trackHomingTarget(this.homingTarget,
        { x: playerX + this.homingOffsetX, y: playerY }, dt, this.homingRemainingMs);
      this.tunnelTrajectory = retargetTunnelTrajectory(this.tunnelTrajectory, target);
      this.homingRemainingMs = Math.max(0, this.homingRemainingMs - dt * 1000);
    }
    const followsProjectedApproach = !this.friendly && !this.outboundExitActive;
    if (followsProjectedApproach) {
      this.authoredX += this.vx * dt;
      this.authoredY += this.vy * dt;
    } else {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
    }
    const authoredPositionAfterStep = { x: this.authoredX, y: this.authoredY };
    const projection = followsProjectedApproach
      ? sampleTunnelProjection(
          this.tunnelTrajectory,
          authoredPositionAfterStep,
          this.tunnelDepth,
        )
      : {
          position: { x: this.x, y: this.y },
          depth: 1,
          radialDistance: Math.hypot(
            this.x - BOSS_PROJECTILE_ORIGIN.x,
            this.y - BOSS_PROJECTILE_ORIGIN.y,
          ),
          collisionActive: true,
        };
    const enteredContactDepth = !collisionWasActive && projection.collisionActive;
    const enteredNearPlane = followsProjectedApproach
      && tunnelDepthBeforeStep < 1
      && projection.depth >= 1;
    this.tunnelDepth = projection.depth;
    this.collisionActive = projection.collisionActive;
    if (enteredContactDepth) {
      const startAlongRay = this.distanceAlongAuthoredRay(authoredPositionBeforeStep);
      const endAlongRay = this.distanceAlongAuthoredRay(authoredPositionAfterStep);
      const authoredContactPoint = interpolateThresholdCrossing(
        authoredPositionBeforeStep,
        authoredPositionAfterStep,
        startAlongRay,
        endAlongRay,
        this.tunnelTrajectory.approachLength * this.tunnelTrajectory.contactDepth,
      );
      const contactProjection = sampleTunnelProjection(
        this.tunnelTrajectory,
        authoredContactPoint,
        tunnelDepthBeforeStep,
      );
      // A low-FPS frame can cross the contact threshold before collision is
      // sampled. Start the first sweep at the exact projected threshold point.
      this.previousX = contactProjection.position.x;
      this.previousY = contactProjection.position.y;
    }
    if (followsProjectedApproach) {
      // Before contact this root is only an authored clock. From contact depth
      // onward it is the real collider, exactly co-located with the visual.
      this.setPosition(
        this.collisionActive ? projection.position.x : this.authoredX,
        this.collisionActive ? projection.position.y : this.authoredY,
      );
    }
    if (enteredNearPlane) {
      const exitVelocity = initialProjectileExitVelocity(
        this.tunnelTrajectory,
        { x: this.vx, y: this.vy },
      );
      this.vx = exitVelocity.x;
      this.vy = exitVelocity.y;
      this.outboundExitActive = true;
    }
    // The first dangerous sweep begins at the exact contact-depth projection;
    // every subsequent active frame retains the true prior collision centre.
    this.previousCollisionActive = this.collisionActive;
    if (!enteredContactDepth) {
      this.previousX = collisionWasActive ? positionBeforeStep.x : this.x;
      this.previousY = collisionWasActive ? positionBeforeStep.y : this.y;
    }
    const depthPose = calculateTunnelDepthPose(
      this.kind,
      this.tunnelDepth,
      this.tunnelTrajectory.contactDepth,
    );
    this.effectiveCollisionRadius = this.radius * Math.min(1, depthPose.scale);
    // A document is a rigid plane. The projected mesh already supplies all
    // pitch, yaw and foreshortening. Never add speed-based squash/stretch to a
    // rigid card; Canvas only keeps the mild depth foreshortening fallback.
    const visualScaleX = depthPose.scale;
    const visualScaleY = depthPose.scale * (
      this.perspectiveMesh ? 1 : depthPose.foreshortening
    );
    this.visualLayer.setScale(visualScaleX, visualScaleY);
    this.setAlpha(depthPose.alpha * (this.reducedVisualQuality ? 0.88 : 1))
      .setDepth(depthPose.displayDepth);
    this.visualLayer.setPosition(
      projection.position.x - this.x,
      projection.position.y - this.y,
    );
    // The paper's pose is chosen once at launch. Never accumulate a 2D roll
    // while it travels; all apparent turning comes from its fixed 3D yaw.
    this.visualLayer.setRotation(0);
    this.updatePerspectiveSurface(
      projection.position.x,
      projection.position.y,
      depthPose.progress,
      visualScaleX,
      visualScaleY,
      true,
      this.yawOffset,
    );
    this.depthShadow
      .setScale(Phaser.Math.Linear(0.55, 1.45, depthPose.progress))
      .setAlpha(Phaser.Math.Linear(0.1, 0.5, depthPose.progress));
    this.sprite.setRotation(0);
    this.projectedX = projection.position.x;
    this.projectedY = projection.position.y;
  }

  reflectTowards(x: number, y: number, speed = 760): void {
    if (this.tunnelDepth < 1) {
      // Contact may happen during the final perspective approach. Promote the
      // projected collision centre before aiming the friendly return so the
      // card never teleports back to its hidden authored coordinate.
      this.setPosition(this.visibleCenterX, this.visibleCenterY);
      this.visualLayer.setPosition(0, 0);
    }
    const angle = Math.atan2(y - this.y, x - this.x);
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.friendly = true;
    this.isDamage = false;
    this.reflectable = false;
    this.collisionActive = true;
    this.previousCollisionActive = true;
    this.previousX = this.x;
    this.previousY = this.y;
    this.tunnelDepth = 1;
    this.outboundExitActive = false;
    this.visualLayer.setPosition(0, 0);
    this.sprite
      .setTint(PALETTE.green)
      .setDisplaySize(PROJECTILE_CARD_WIDTH * 1.18, PROJECTILE_CARD_HEIGHT * 1.18);
    this.perspectiveMesh?.setTint(PALETTE.green);
    this.depthShadow.setStrokeStyle(2, PALETTE.green, 0.75);
  }

  setVisualQuality(reduced: boolean): void {
    this.reducedVisualQuality = reduced;
  }

  /**
   * Ends gameplay ownership without visually deleting the card. The pooled
   * projectile keeps flying on its established ray and recycles only after its
   * complete card is outside the padded viewport.
   */
  releaseForOffscreenExit(): void {
    if (!this.active || this.friendly) return;
    this.isDamage = false;
    this.reflectable = false;
    if (!this.collisionActive || this.outboundExitActive) return;
    const exitVelocity = initialProjectileExitVelocity(
      this.tunnelTrajectory,
      { x: this.vx, y: this.vy },
    );
    this.vx = exitVelocity.x;
    this.vy = exitVelocity.y;
    this.outboundExitActive = true;
  }

  recycle(): void {
    this.outboundExitActive = false;
    this.setRotation(0);
    this.sprite.setRotation(0);
    this.depthShadow.setStrokeStyle(1, PALETTE.green, 0.12);
    this.visualLayer.setPosition(0, 0).setRotation(0).setScale(0.3);
    this.setActive(false).setVisible(false).setPosition(-200, -200);
  }

  override destroy(fromScene?: boolean): void {
    super.destroy(fromScene);
  }

  private distanceAlongAuthoredRay(point: Readonly<{ x: number; y: number }>): number {
    return (point.x - this.tunnelTrajectory.spawn.x) * this.tunnelTrajectory.directionX
      + (point.y - this.tunnelTrajectory.spawn.y) * this.tunnelTrajectory.directionY;
  }

  private updatePerspectiveSurface(
    projectedX: number,
    projectedY: number,
    depth: number,
    visualScaleX: number,
    visualScaleY: number,
    warped: boolean,
    yawOffsetRadians: number,
  ): void {
    const sourceWidth = this.kind === 'comment'
      ? Math.max(1, this.comment.width)
      : PROJECTILE_CARD_WIDTH * (this.kind === 'wall' ? WALL_CARD_WIDTH_SCALE : 1);
    const sourceHeight = this.kind === 'comment'
      ? Math.max(1, this.comment.height)
      : PROJECTILE_CARD_HEIGHT * (this.kind === 'wall' ? WALL_CARD_SCALE_Y : 1);
    const safeScaleX = Math.max(0.001, Math.abs(visualScaleX));
    const safeScaleY = Math.max(0.001, Math.abs(visualScaleY));
    const projection = warped && Boolean(this.perspectiveMesh)
      ? createProjectilePerspectiveProjection(
          { x: projectedX, y: projectedY },
          sourceWidth * safeScaleX,
          sourceHeight * safeScaleY,
          depth,
          this.tunnelTrajectory.nearPoint,
          this.tunnelTrajectory.origin,
          yawOffsetRadians,
        )
      : undefined;
    const quad = projection
      ? {
          topLeft: projectProjectilePerspectiveUv(projection, 0, 0),
          topRight: projectProjectilePerspectiveUv(projection, 1, 0),
          bottomRight: projectProjectilePerspectiveUv(projection, 1, 1),
          bottomLeft: projectProjectilePerspectiveUv(projection, 0, 1),
        }
      : {
          topLeft: { x: -sourceWidth * safeScaleX / 2, y: -sourceHeight * safeScaleY / 2 },
          topRight: { x: sourceWidth * safeScaleX / 2, y: -sourceHeight * safeScaleY / 2 },
          bottomRight: { x: sourceWidth * safeScaleX / 2, y: sourceHeight * safeScaleY / 2 },
          bottomLeft: { x: -sourceWidth * safeScaleX / 2, y: sourceHeight * safeScaleY / 2 },
        };
    this.projectedYaw = projection?.yawRadians ?? yawOffsetRadians;
    const corners = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
    for (let index = 0; index < corners.length; index += 1) {
      const corner = corners[index];
      const collisionPoint = this.collisionPoints[index];
      if (!corner || !collisionPoint) continue;
      collisionPoint.x = corner.x;
      collisionPoint.y = corner.y;
      collisionPoint.x += projectedX;
      collisionPoint.y += projectedY;
    }
    if (!this.perspectiveMesh) return;
    for (let index = 0; index < this.perspectiveMesh.vertices.length; index += 1) {
      const vertex = this.perspectiveMesh.vertices[index];
      if (!vertex) continue;
      const point = projection
        ? projectProjectilePerspectiveUv(
            projection,
            vertex.u,
            vertex.v,
            this.projectedSurfacePoint,
          )
        : this.projectedSurfacePoint;
      if (!projection) {
        point.x = (vertex.u - 0.5) * sourceWidth * safeScaleX;
        point.y = (vertex.v - 0.5) * sourceHeight * safeScaleY;
      }
      vertex.x = point.x / safeScaleX;
      // Phaser's orthographic Mesh transform flips local Y. Counter-flip the
      // authored screen-space quad so the Boss-facing edge stays the narrow
      // edge and text on the card remains upright.
      vertex.y = -point.y / safeScaleY;
    }
    // Phaser's Mesh cache does not observe direct Vertex.x/y writes. A zero
    // view pan is its cheapest public dirty signal: active meshes transform
    // once, while all inactive pooled meshes can take the cached fast path.
    this.perspectiveMesh.panX(0);
    this.perspectiveMesh.syncProjection();
  }
}

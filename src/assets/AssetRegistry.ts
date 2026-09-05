import Phaser from 'phaser';
import { PALETTE } from '../theme/palette';
import {
  NOXCAT_EYES,
  NOXCAT_EYE_COLOR,
  NOXCAT_FACE_TEXTURE,
  NOXCAT_OFFICIAL_BLACK,
  noxcatSvg,
  sampleNoxcatBunOutline,
} from './noxcatDesign';

export type AssetKey =
  | 'noxcat.body'
  | 'noxcat.eyes'
  | 'noxcat.goggles'
  | 'noxcat.hit'
  | 'boss.crt'
  | 'projectile.paper'
  | 'projectile.wall'
  | 'projectile.returnable';

const textureKeys: Record<AssetKey, string> = {
  'noxcat.body': 'noxcat-logo-traced-body',
  'noxcat.eyes': 'noxcat-logo-traced-eyes',
  'noxcat.goggles': 'noxcat-logo-traced-goggles',
  'noxcat.hit': 'noxcat-runtime-hit',
  'boss.crt': 'boss-runtime-crt',
  'projectile.paper': 'projectile-runtime-paper',
  'projectile.wall': 'projectile-runtime-wall',
  'projectile.returnable': 'projectile-runtime-returnable'
};

/**
 * The only place that knows whether art is supplied, derived, or procedural.
 * The start screen uses the unchanged official wordmark; this registry owns the
 * approved game redraw and runtime textures so scenes never hard-code paths.
 */
export class AssetRegistry {
  static readonly usesOfficialNoxcat = true;

  static preload(scene: Phaser.Scene): void {
    for (const layer of ['body', 'eyes', 'goggles'] as const) {
      const key = this.key(`noxcat.${layer}`);
      if (scene.textures.exists(key)) continue;
      scene.load.svg(key, `data:image/svg+xml;base64,${btoa(noxcatSvg(layer))}`, {
        width: NOXCAT_FACE_TEXTURE.width * 4,
        height: Math.round(NOXCAT_FACE_TEXTURE.height * 4),
      });
    }
    const bossKey = this.key('boss.crt');
    if (!scene.textures.exists(bossKey)) {
      scene.load.image(bossKey, '/assets/boss/boss-office-base-v1.png');
    }
    const paperKey = this.key('projectile.paper');
    if (!scene.textures.exists(paperKey)) {
      scene.load.image(paperKey, '/assets/projectiles/paper-generated-v1.png');
    }
    const returnableKey = this.key('projectile.returnable');
    if (!scene.textures.exists(returnableKey)) {
      scene.load.image(returnableKey, '/assets/projectiles/returnable-generated-v1.png');
    }
  }

  static key(key: AssetKey): string {
    return textureKeys[key];
  }

  static createRuntimeTextures(scene: Phaser.Scene): void {
    this.makeNoxcatBody(scene);
    this.makeNoxcatEyes(scene);
    this.makeNoxcatGoggles(scene);
    this.makeHitFlash(scene);
    this.makeBossFallback(scene);
    this.makePaper(scene, false);
    this.makePaper(scene, true);
    this.makeWall(scene);
  }

  /** 文件匣的橫向紙疊，只建立一次 texture，飛行與碰撞沿用同一張卡面。 */
  private static makeWall(scene: Phaser.Scene): void {
    const key = this.key('projectile.wall');
    if (scene.textures.exists(key)) return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    for (let layer = 2; layer >= 0; layer--) {
      const x = 3 + layer * 3, y = 3 + layer * 5;
      g.fillStyle(layer === 0 ? 0xe4e9d8 : 0x68745b, 1).fillRoundedRect(x, y, 108, 44, 3);
      g.lineStyle(1.5, 0x202b1c, 1).strokeRoundedRect(x, y, 108, 44, 3);
    }
    g.fillStyle(0x263321, 1).fillRoundedRect(10, 10, 26, 30, 2);
    g.lineStyle(2.5, PALETTE.green, 1)
      .lineBetween(17, 19, 27, 30).lineBetween(27, 19, 17, 30);
    g.lineStyle(2, 0x66715a, 0.8);
    for (let row = 0; row < 3; row++) g.lineBetween(44, 16 + row * 8, 99 - row * 10, 16 + row * 8);
    g.fillStyle(0xd95365, 1).fillRect(103, 5, 6, 40);
    g.lineStyle(1, 0xf8fff0, 0.8).lineBetween(6, 5, 105, 5);
    g.generateTexture(key, 120, 64);
    g.destroy();
  }

  private static makeNoxcatBody(scene: Phaser.Scene): void {
    const key = this.key('noxcat.body');
    if (scene.textures.exists(key)) return;
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    graphics.fillStyle(NOXCAT_OFFICIAL_BLACK, 1);
    graphics.fillPoints(sampleNoxcatBunOutline(), true, true);
    graphics.generateTexture(key, NOXCAT_FACE_TEXTURE.width, NOXCAT_FACE_TEXTURE.height);
    graphics.destroy();
  }

  private static makeNoxcatEyes(scene: Phaser.Scene): void {
    const key = this.key('noxcat.eyes');
    if (scene.textures.exists(key)) return;
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    graphics.fillStyle(NOXCAT_EYE_COLOR, 1);
    for (const eye of NOXCAT_EYES) {
      graphics.fillPoints(eye, true, true);
    }
    graphics.generateTexture(key, NOXCAT_FACE_TEXTURE.width, NOXCAT_FACE_TEXTURE.height);
    graphics.destroy();
  }

  private static makeNoxcatGoggles(scene: Phaser.Scene): void {
    const key = this.key('noxcat.goggles');
    if (scene.textures.exists(key)) return;
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    // A failed SVG load omits this optional accessory, preserving the face.
    graphics.generateTexture(key, NOXCAT_FACE_TEXTURE.width, NOXCAT_FACE_TEXTURE.height);
    graphics.destroy();
  }

  private static makeHitFlash(scene: Phaser.Scene): void {
    const key = this.key('noxcat.hit');
    if (scene.textures.exists(key)) return;
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    graphics.fillStyle(0xffffff, 0.92);
    graphics.fillCircle(48, 48, 42);
    graphics.generateTexture(key, 96, 96);
    graphics.destroy();
  }

  /** Keeps a complete battle playable if the generated Boss PNG cannot load. */
  private static makeBossFallback(scene: Phaser.Scene): void {
    const key = this.key('boss.crt');
    if (scene.textures.exists(key)) return;
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    graphics.fillStyle(PALETTE.black, 1);
    graphics.lineStyle(7, PALETTE.green, 0.55);
    graphics.fillRoundedRect(82, 34, 348, 218, 30);
    graphics.strokeRoundedRect(82, 34, 348, 218, 30);
    graphics.fillStyle(0x020402, 1);
    graphics.lineStyle(4, PALETTE.midGray, 0.35);
    graphics.fillRoundedRect(112, 66, 288, 154, 18);
    graphics.strokeRoundedRect(112, 66, 288, 154, 18);
    graphics.fillStyle(PALETTE.black, 1);
    graphics.lineStyle(5, PALETTE.green, 0.38);
    graphics.fillRoundedRect(24, 210, 132, 82, 34);
    graphics.strokeRoundedRect(24, 210, 132, 82, 34);
    graphics.fillRoundedRect(356, 210, 132, 82, 34);
    graphics.strokeRoundedRect(356, 210, 132, 82, 34);
    graphics.fillStyle(0x0b0e09, 1);
    graphics.fillRect(176, 248, 160, 244);
    graphics.lineStyle(2, PALETTE.midGray, 0.3);
    for (let row = 0; row < 20; row += 1) {
      const inset = (row % 4) * 5;
      graphics.lineBetween(176 + inset, 254 + row * 12, 336 - inset, 254 + row * 12);
    }
    graphics.generateTexture(key, 512, 512);
    graphics.destroy();
  }

  /** Small procedural card used only if a generated projectile cannot load. */
  private static makePaper(scene: Phaser.Scene, returnable: boolean): void {
    const asset: AssetKey = returnable ? 'projectile.returnable' : 'projectile.paper';
    const key = this.key(asset);
    if (scene.textures.exists(key)) return;
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    // Offset backing, face and top highlight give each card a readable 2.5D
    // thickness before Projectile applies its camera-depth scale animation.
    graphics.fillStyle(0x050805, 0.78);
    graphics.fillRoundedRect(6, 8, 40, 52, 3);
    graphics.fillStyle(returnable ? 0x10160f : 0xe9f0d9, 1);
    graphics.lineStyle(returnable ? 4 : 2, returnable ? PALETTE.green : 0x879071, 1);
    graphics.fillRoundedRect(3, 3, 42, 56, 3);
    graphics.strokeRoundedRect(3, 3, 42, 56, 3);
    graphics.lineStyle(2, returnable ? PALETTE.white : 0xffffff, 0.72);
    graphics.lineBetween(6, 6, 41, 6);
    graphics.lineBetween(6, 6, 6, 52);
    graphics.lineStyle(3, returnable ? PALETTE.green : 0x1b2219, 1);
    graphics.lineBetween(12, 43, 35, 43);
    graphics.lineBetween(12, 49, 29, 49);
    if (returnable) {
      graphics.strokeCircle(24, 23, 11);
      graphics.beginPath();
      graphics.moveTo(30, 12);
      graphics.lineTo(36, 19);
      graphics.lineTo(27, 19);
      graphics.closePath();
      graphics.fillStyle(PALETTE.green, 1);
      graphics.fillPath();
    } else {
      graphics.lineBetween(13, 14, 35, 34);
      graphics.lineBetween(35, 14, 13, 34);
    }
    graphics.generateTexture(key, 48, 62);
    graphics.destroy();
  }
}

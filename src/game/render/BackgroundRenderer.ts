import Phaser from 'phaser';
import { PALETTE, mixColor } from '../../app/Palette';
import { createRandom } from '../../core/math/Interpolation';
import type { LevelDefinition } from '../level/LevelSchema';
import { TEXTURES } from './TextureFactory';

interface RayDefinition {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  intensity: number;
  phase: number;
}

interface Mote {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  size: number;
  phase: number;
}

/**
 * Многослойный фон оранжереи.
 *
 * Глубина набирается не одним рисунком, а слоями с разным `scrollFactor`:
 * стеклянная крыша почти неподвижна, дальние силуэты растений двигаются
 * медленно, ближние — быстрее. Между ними — объёмные лучи света и парящая
 * пыльца, которая связывает планы и оживляет пустое пространство.
 */
export class BackgroundRenderer {
  private readonly sky: Phaser.GameObjects.Graphics;
  private readonly farLayer: Phaser.GameObjects.Graphics;
  private readonly midLayer: Phaser.GameObjects.Graphics;
  private readonly nearLayer: Phaser.GameObjects.Graphics;
  private readonly rayLayer: Phaser.GameObjects.Graphics;
  private readonly moteLayer: Phaser.GameObjects.Graphics;
  private readonly rainLayer: Phaser.GameObjects.Graphics;

  private readonly rays: RayDefinition[] = [];
  private readonly motes: Mote[] = [];
  private readonly rainDrops: { x: number; y: number; speed: number; length: number }[] = [];

  private layerBudget = 4;
  private showRays = true;
  private showRain = true;
  private moteCount = 90;
  private worldWidth = 4200;
  private worldHeight = 1400;

  constructor(scene: Phaser.Scene, level: LevelDefinition, baseDepth: number) {
    this.worldWidth = level.worldBounds.width;
    this.worldHeight = level.worldBounds.height;

    this.sky = scene.add.graphics().setDepth(baseDepth).setScrollFactor(0);
    this.farLayer = scene.add.graphics().setDepth(baseDepth + 1).setScrollFactor(0.12);
    this.rayLayer = scene.add
      .graphics()
      .setDepth(baseDepth + 2)
      .setScrollFactor(0.28)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.midLayer = scene.add.graphics().setDepth(baseDepth + 3).setScrollFactor(0.42);
    this.nearLayer = scene.add.graphics().setDepth(baseDepth + 4).setScrollFactor(0.66);
    this.moteLayer = scene.add
      .graphics()
      .setDepth(baseDepth + 5)
      .setScrollFactor(0.8)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.rainLayer = scene.add
      .graphics()
      .setDepth(baseDepth + 2)
      .setScrollFactor(0.18)
      .setBlendMode(Phaser.BlendModes.ADD);

    this.buildRays();
    this.buildMotes();
    this.buildRain();
    this.drawStaticLayers();
  }

  setQuality(layers: number, rays: boolean, rain: boolean, motes: number): void {
    this.layerBudget = layers;
    this.showRays = rays;
    this.showRain = rain;
    this.moteCount = motes;
    this.rayLayer.setVisible(rays);
    this.rainLayer.setVisible(rain);
    this.midLayer.setVisible(layers >= 3);
    this.nearLayer.setVisible(layers >= 4);
    this.drawStaticLayers();
  }

  destroy(): void {
    this.sky.destroy();
    this.farLayer.destroy();
    this.midLayer.destroy();
    this.nearLayer.destroy();
    this.rayLayer.destroy();
    this.moteLayer.destroy();
    this.rainLayer.destroy();
  }

  private buildRays(): void {
    const random = createRandom(9181);
    // Лучи привязаны к пролётам стеклянной крыши, а не разбросаны случайно —
    // так они читаются как свет из окон, а не как абстрактное свечение.
    const spans = Math.max(4, Math.round(this.worldWidth / 620));
    for (let i = 0; i < spans; i++) {
      const x = (i + 0.5) * (this.worldWidth / spans) + (random() - 0.5) * 160;
      this.rays.push({
        x,
        y: -60,
        width: 150 + random() * 190,
        height: this.worldHeight * (0.75 + random() * 0.35),
        angle: -0.16 + random() * 0.32,
        intensity: 0.1 + random() * 0.13,
        phase: random() * Math.PI * 2,
      });
    }
  }

  private buildMotes(): void {
    const random = createRandom(4477);
    for (let i = 0; i < 160; i++) {
      this.motes.push({
        x: random() * this.worldWidth,
        y: random() * this.worldHeight,
        z: 0.35 + random() * 0.65,
        vx: (random() - 0.5) * 12,
        vy: -3 - random() * 9,
        size: 1 + random() * 2.4,
        phase: random() * Math.PI * 2,
      });
    }
  }

  private buildRain(): void {
    const random = createRandom(3311);
    for (let i = 0; i < 90; i++) {
      this.rainDrops.push({
        x: random() * this.worldWidth,
        y: random() * this.worldHeight * 0.7,
        speed: 420 + random() * 340,
        length: 14 + random() * 26,
      });
    }
  }

  private drawStaticLayers(): void {
    this.drawSky();
    this.drawFarLayer();
    this.drawMidLayer();
    this.drawNearLayer();
  }

  /** Небо рисуется в экранных координатах и не двигается вовсе. */
  private drawSky(): void {
    const g = this.sky;
    g.clear();
    const width = 4096;
    const height = 2304;
    const bands = 26;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const color =
        t < 0.5
          ? mixColor(PALETTE.skyTop, PALETTE.skyMid, t * 2)
          : mixColor(PALETTE.skyMid, PALETTE.skyLow, (t - 0.5) * 2);
      g.fillStyle(color, 1);
      g.fillRect(-width / 2, -height / 2 + (height / bands) * i, width, height / bands + 2);
    }
    // Тёплое зарево у горизонта — источник всего света в комнате.
    g.fillStyle(PALETTE.skyHorizon, 0.13);
    g.fillEllipse(0, -height * 0.12, width * 0.9, height * 0.5);
  }

  private drawFarLayer(): void {
    const g = this.farLayer;
    g.clear();
    const random = createRandom(1717);

    // Каркас стеклянной крыши: арки и переплёты.
    const archCount = Math.ceil(this.worldWidth / 520) + 2;
    for (let i = 0; i < archCount; i++) {
      const x = i * 520 - 200;
      g.lineStyle(7, mixColor(PALETTE.farFoliage, PALETTE.metalBase, 0.6), 0.5);
      g.beginPath();
      g.moveTo(x, this.worldHeight * 0.62);
      g.lineTo(x, 210);
      g.lineTo(x + 260, 90);
      g.lineTo(x + 520, 210);
      g.strokePath();

      // Диагональные переплёты стекла.
      g.lineStyle(2.4, mixColor(PALETTE.farFoliage, PALETTE.metalEdge, 0.4), 0.22);
      for (let s = 1; s < 5; s++) {
        const t = s / 5;
        g.beginPath();
        g.moveTo(x + 520 * t, 210 - 120 * (1 - Math.abs(t - 0.5) * 2));
        g.lineTo(x + 520 * t, this.worldHeight * 0.5);
        g.strokePath();
      }
    }

    // Дальние силуэты крон.
    for (let i = 0; i < 42; i++) {
      const x = random() * this.worldWidth * 1.2 - this.worldWidth * 0.1;
      const y = this.worldHeight * (0.35 + random() * 0.5);
      const radius = 90 + random() * 220;
      g.fillStyle(PALETTE.farFoliage, 0.55);
      g.fillEllipse(x, y, radius * 1.7, radius);
    }
  }

  private drawMidLayer(): void {
    const g = this.midLayer;
    g.clear();
    if (this.layerBudget < 3) return;
    const random = createRandom(8123);

    for (let i = 0; i < 34; i++) {
      const x = random() * this.worldWidth * 1.1;
      const baseY = this.worldHeight * (0.6 + random() * 0.42);
      const height = 180 + random() * 420;
      const width = 90 + random() * 200;

      // Крупный лист: сегментированный веер.
      g.fillStyle(PALETTE.midFoliage, 0.82);
      const blades = 5 + Math.floor(random() * 4);
      for (let b = 0; b < blades; b++) {
        const spread = (b / (blades - 1) - 0.5) * 1.5;
        const tipX = x + Math.sin(spread) * width;
        const tipY = baseY - Math.cos(spread) * height;
        g.beginPath();
        g.moveTo(x, baseY);
        g.lineTo(tipX - 26, tipY + 46);
        g.lineTo(tipX, tipY);
        g.lineTo(tipX + 26, tipY + 46);
        g.closePath();
        g.fillPath();
      }
    }
  }

  private drawNearLayer(): void {
    const g = this.nearLayer;
    g.clear();
    if (this.layerBudget < 4) return;
    const random = createRandom(6541);

    for (let i = 0; i < 22; i++) {
      const x = random() * this.worldWidth * 1.05;
      const baseY = this.worldHeight * (0.78 + random() * 0.3);
      const height = 240 + random() * 380;
      g.fillStyle(PALETTE.nearFoliage, 0.9);
      g.beginPath();
      g.moveTo(x - 70, baseY);
      g.lineTo(x - 18, baseY - height * 0.8);
      g.lineTo(x, baseY - height);
      g.lineTo(x + 18, baseY - height * 0.8);
      g.lineTo(x + 70, baseY);
      g.closePath();
      g.fillPath();
    }
  }

  update(deltaSeconds: number, time: number, camera: Phaser.Cameras.Scene2D.Camera): void {
    if (this.showRays) this.drawRays(time);
    this.drawMotes(deltaSeconds, time, camera);
    if (this.showRain) this.drawRain(deltaSeconds, camera);
  }

  private drawRays(time: number): void {
    const g = this.rayLayer;
    g.clear();
    for (const ray of this.rays) {
      // Медленное «дыхание» лучей: слабое колебание ширины и яркости.
      const breathe = 0.82 + 0.18 * Math.sin(time / 3400 + ray.phase);
      const alpha = ray.intensity * breathe;
      const halfWidth = (ray.width / 2) * breathe;
      const spread = halfWidth * 2.3;
      const tan = Math.tan(ray.angle);
      const topX = ray.x - tan * ray.y;
      const bottomX = ray.x + tan * ray.height;

      g.fillStyle(PALETTE.sunWarm, alpha);
      g.beginPath();
      g.moveTo(topX - halfWidth, ray.y);
      g.lineTo(topX + halfWidth, ray.y);
      g.lineTo(bottomX + spread, ray.y + ray.height);
      g.lineTo(bottomX - spread, ray.y + ray.height);
      g.closePath();
      g.fillPath();

      // Яркая сердцевина.
      g.fillStyle(PALETTE.sunCore, alpha * 0.5);
      g.beginPath();
      g.moveTo(topX - halfWidth * 0.28, ray.y);
      g.lineTo(topX + halfWidth * 0.28, ray.y);
      g.lineTo(bottomX + spread * 0.3, ray.y + ray.height * 0.85);
      g.lineTo(bottomX - spread * 0.3, ray.y + ray.height * 0.85);
      g.closePath();
      g.fillPath();
    }
  }

  private drawMotes(deltaSeconds: number, time: number, camera: Phaser.Cameras.Scene2D.Camera): void {
    const g = this.moteLayer;
    g.clear();
    const count = Math.min(this.moteCount, this.motes.length);
    const view = camera.worldView;

    for (let i = 0; i < count; i++) {
      const mote = this.motes[i]!;
      mote.x += (mote.vx + Math.sin(time / 1800 + mote.phase) * 9) * deltaSeconds;
      mote.y += mote.vy * deltaSeconds;
      if (mote.y < -40) {
        mote.y = this.worldHeight + 40;
        mote.x = Math.random() * this.worldWidth;
      }
      if (mote.x < -60) mote.x = this.worldWidth + 60;
      if (mote.x > this.worldWidth + 60) mote.x = -60;

      // Отбраковка за пределами видимой области с запасом на параллакс.
      if (
        mote.x < view.x - 400 ||
        mote.x > view.right + 400 ||
        mote.y < view.y - 400 ||
        mote.y > view.bottom + 400
      ) {
        continue;
      }

      const twinkle = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(time / 700 + mote.phase * 3));
      g.fillStyle(PALETTE.sunWarm, 0.18 * mote.z * twinkle);
      g.fillCircle(mote.x, mote.y, mote.size * 2.6);
      g.fillStyle(PALETTE.sunCore, 0.5 * mote.z * twinkle);
      g.fillCircle(mote.x, mote.y, mote.size * 0.75);
    }
  }

  private drawRain(deltaSeconds: number, camera: Phaser.Cameras.Scene2D.Camera): void {
    const g = this.rainLayer;
    g.clear();
    const view = camera.worldView;

    // Дождь идёт снаружи, за стеклом: он мягкий и почти прозрачный.
    g.lineStyle(1.4, PALETTE.silkGlow, 0.1);
    g.beginPath();
    for (const drop of this.rainDrops) {
      drop.y += drop.speed * deltaSeconds;
      if (drop.y > this.worldHeight * 0.72) {
        drop.y = -40;
        drop.x = Math.random() * this.worldWidth;
      }
      if (drop.x < view.x - 300 || drop.x > view.right + 300) continue;
      g.moveTo(drop.x, drop.y);
      g.lineTo(drop.x + 5, drop.y + drop.length);
    }
    g.strokePath();
  }

  /** Ссылка на текстуру свечения нужна сцене для эффектов ламп. */
  static readonly glowTexture = TEXTURES.glowSoft;
}

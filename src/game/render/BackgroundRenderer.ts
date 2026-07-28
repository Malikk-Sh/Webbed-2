import { PALETTE, mixColor } from '../../app/Palette';
import { createRandom } from '../../core/math/Interpolation';
import { cssColor } from '../../engine/Color';
import type { Rect } from '../../core/math/Geometry';
import type { Camera2D } from '../../engine/Camera2D';
import type { Painter } from '../../engine/Painter';
import { ShapeBuffer } from '../../engine/ShapeBuffer';
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

/** Множители прокрутки слоёв: чем ближе план, тем быстрее он едет. */
const SCROLL = {
  far: 0.12,
  rain: 0.18,
  rays: 0.28,
  mid: 0.42,
  near: 0.66,
  motes: 0.8,
} as const;

/**
 * Многослойный фон оранжереи.
 *
 * Глубина набирается не одним рисунком, а слоями с разным множителем
 * прокрутки: стеклянная крыша почти неподвижна, дальние силуэты растений
 * двигаются медленно, ближние — быстрее. Между ними — объёмные лучи света и
 * парящая пыльца, которая связывает планы и оживляет пустое пространство.
 *
 * Каждый план рисуется своей матрицей камеры, поэтому масштаб у всех планов
 * общий и при отдалении картинка не расслаивается.
 */
export class BackgroundRenderer {
  private readonly farLayer = new ShapeBuffer();
  private readonly midLayer = new ShapeBuffer();
  private readonly nearLayer = new ShapeBuffer();

  private readonly rays: RayDefinition[] = [];
  private readonly motes: Mote[] = [];
  private readonly rainDrops: { x: number; y: number; speed: number; length: number }[] = [];
  private readonly layerView: Rect = { x: 0, y: 0, width: 0, height: 0 };

  private layerBudget = 4;
  private showRays = true;
  private showRain = true;
  private moteCount = 90;
  private worldWidth = 4200;
  private worldHeight = 1400;

  constructor(level: LevelDefinition) {
    this.worldWidth = level.worldBounds.width;
    this.worldHeight = level.worldBounds.height;

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
    this.drawStaticLayers();
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
    this.drawFarLayer();
    this.drawMidLayer();
    this.drawNearLayer();
    this.farLayer.seal();
    this.midLayer.seal();
    this.nearLayer.seal();
  }

  /**
   * Небо рисуется прямо в экранных координатах.
   *
   * Раньше это был обычный слой с нулевым множителем прокрутки, и какая часть
   * градиента попадала в кадр, зависело от масштаба камеры и плотности
   * пикселей — на разных устройствах небо получалось разной светлоты.
   * Экранный градиент снимает вопрос: верх кадра всегда верх неба.
   */
  private drawSky(painter: Painter, width: number, height: number): void {
    const ctx = painter.ctx;

    const vertical = ctx.createLinearGradient(0, 0, 0, height);
    vertical.addColorStop(0, cssColor(PALETTE.skyTop, 1));
    vertical.addColorStop(0.34, cssColor(PALETTE.skyMid, 1));
    vertical.addColorStop(1, cssColor(PALETTE.skyLow, 1));
    painter.fillGradient(vertical);
    painter.fillRect(0, 0, width, height);

    // Зеленоватое зарево у горизонта — источник всего света в комнате.
    // Именно радиальный градиент, а не залитый эллипс: у эллипса виден край,
    // и на тёмном фоне он читается как посторонняя дуга поперёк кадра.
    const radius = Math.max(width, height) * 0.95;
    const glow = ctx.createRadialGradient(
      width / 2,
      height * 0.8,
      0,
      width / 2,
      height * 0.8,
      radius,
    );
    glow.addColorStop(0, cssColor(PALETTE.skyHorizon, 0.3));
    glow.addColorStop(0.45, cssColor(PALETTE.skyHorizon, 0.14));
    glow.addColorStop(1, cssColor(PALETTE.skyHorizon, 0));
    painter.fillGradient(glow);
    painter.fillRect(0, 0, width, height);
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

  /** Симуляция пыльцы и дождя; отрисовка идёт отдельно, в свой момент кадра. */
  update(deltaSeconds: number, time: number): void {
    const count = Math.min(this.moteCount, this.motes.length);
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
    }

    if (!this.showRain) return;
    for (const drop of this.rainDrops) {
      drop.y += drop.speed * deltaSeconds;
      if (drop.y > this.worldHeight * 0.72) {
        drop.y = -40;
        drop.x = Math.random() * this.worldWidth;
      }
    }
  }

  /**
   * Полная отрисовка фона. Порядок планов и их режимы наложения повторяют
   * прежнюю раскладку по глубине: небо, дальний план, лучи и дождь на
   * сложении, средний и ближний планы, пыльца сверху.
   */
  draw(
    painter: Painter,
    camera: Camera2D,
    pixelRatio: number,
    time: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    const ctx = painter.ctx;

    this.drawSky(painter, viewportWidth, viewportHeight);

    camera.applyTo(ctx, pixelRatio, SCROLL.far);
    this.farLayer.replay(painter, camera.viewFor(SCROLL.far, this.layerView));

    painter.setBlendMode('add');
    if (this.showRays) {
      camera.applyTo(ctx, pixelRatio, SCROLL.rays);
      this.drawRays(painter, time, camera.viewFor(SCROLL.rays, this.layerView));
    }
    if (this.showRain) {
      camera.applyTo(ctx, pixelRatio, SCROLL.rain);
      this.drawRain(painter, camera.viewFor(SCROLL.rain, this.layerView));
    }
    painter.setBlendMode('normal');

    if (this.layerBudget >= 3) {
      camera.applyTo(ctx, pixelRatio, SCROLL.mid);
      this.midLayer.replay(painter, camera.viewFor(SCROLL.mid, this.layerView));
    }
    if (this.layerBudget >= 4) {
      camera.applyTo(ctx, pixelRatio, SCROLL.near);
      this.nearLayer.replay(painter, camera.viewFor(SCROLL.near, this.layerView));
    }

    painter.setBlendMode('add');
    camera.applyTo(ctx, pixelRatio, SCROLL.motes);
    this.drawMotes(painter, time, camera.viewFor(SCROLL.motes, this.layerView));
    painter.setBlendMode('normal');

    camera.applyTo(ctx, pixelRatio, 1);
  }

  private drawRays(painter: Painter, time: number, view: Rect): void {
    const left = view.x - 400;
    const right = view.x + view.width + 400;

    for (const ray of this.rays) {
      if (ray.x < left || ray.x > right) continue;
      // Медленное «дыхание» лучей: слабое колебание ширины и яркости.
      const breathe = 0.82 + 0.18 * Math.sin(time / 3400 + ray.phase);
      const alpha = ray.intensity * breathe;
      const halfWidth = (ray.width / 2) * breathe;
      const spread = halfWidth * 2.3;
      const tan = Math.tan(ray.angle);
      const topX = ray.x - tan * ray.y;
      const bottomX = ray.x + tan * ray.height;

      painter.fillStyle(PALETTE.sunWarm, alpha);
      painter.beginPath();
      painter.moveTo(topX - halfWidth, ray.y);
      painter.lineTo(topX + halfWidth, ray.y);
      painter.lineTo(bottomX + spread, ray.y + ray.height);
      painter.lineTo(bottomX - spread, ray.y + ray.height);
      painter.closePath();
      painter.fillPath();

      // Яркая сердцевина.
      painter.fillStyle(PALETTE.sunCore, alpha * 0.5);
      painter.beginPath();
      painter.moveTo(topX - halfWidth * 0.28, ray.y);
      painter.lineTo(topX + halfWidth * 0.28, ray.y);
      painter.lineTo(bottomX + spread * 0.3, ray.y + ray.height * 0.85);
      painter.lineTo(bottomX - spread * 0.3, ray.y + ray.height * 0.85);
      painter.closePath();
      painter.fillPath();
    }
  }

  private drawMotes(painter: Painter, time: number, view: Rect): void {
    const count = Math.min(this.moteCount, this.motes.length);
    const right = view.x + view.width;
    const bottom = view.y + view.height;

    for (let i = 0; i < count; i++) {
      const mote = this.motes[i]!;
      if (
        mote.x < view.x - 40 ||
        mote.x > right + 40 ||
        mote.y < view.y - 40 ||
        mote.y > bottom + 40
      ) {
        continue;
      }

      const twinkle = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(time / 700 + mote.phase * 3));
      painter.fillStyle(PALETTE.sunWarm, 0.18 * mote.z * twinkle);
      painter.fillCircle(mote.x, mote.y, mote.size * 2.6);
      painter.fillStyle(PALETTE.sunCore, 0.5 * mote.z * twinkle);
      painter.fillCircle(mote.x, mote.y, mote.size * 0.75);
    }
  }

  private drawRain(painter: Painter, view: Rect): void {
    const left = view.x - 300;
    const right = view.x + view.width + 300;

    // Дождь идёт снаружи, за стеклом: он мягкий и почти прозрачный.
    painter.lineStyle(1.4, PALETTE.silkGlow, 0.1);
    painter.beginPath();
    for (const drop of this.rainDrops) {
      if (drop.x < left || drop.x > right) continue;
      painter.moveTo(drop.x, drop.y);
      painter.lineTo(drop.x + 5, drop.y + drop.length);
    }
    painter.strokePath();
  }

  /** Ссылка на текстуру свечения нужна сцене для эффектов ламп. */
  static readonly glowTexture = TEXTURES.glowSoft;
}

import { mixColor, shade } from '../../app/Palette';
import { createRandom } from '../../core/math/Interpolation';
import { cssColor } from '../../engine/Color';
import type { Rect } from '../../core/math/Geometry';
import type { Camera2D } from '../../engine/Camera2D';
import type { Painter } from '../../engine/Painter';
import { ShapeBuffer } from '../../engine/ShapeBuffer';
import type { LevelDefinition } from '../level/LevelSchema';
import { getTheme, type LevelTheme } from '../level/LevelTheme';
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

/** Живность фона: летит по своей орбите вокруг облюбованной точки. */
interface Flyer {
  homeX: number;
  homeY: number;
  radiusX: number;
  radiusY: number;
  speed: number;
  phase: number;
  size: number;
  x: number;
  y: number;
  previousX: number;
  /** Мигание светлячка и трепет крыльев бабочки. */
  pulse: number;
}

/** Множители прокрутки слоёв: чем ближе план, тем быстрее он едет. */
const SCROLL = {
  far: 0.12,
  rain: 0.18,
  rays: 0.28,
  mid: 0.42,
  life: 0.55,
  near: 0.66,
  motes: 0.8,
} as const;

/**
 * Многослойный фон локации.
 *
 * Глубина набирается не одним рисунком, а слоями с разным множителем
 * прокрутки: дальний каркас почти неподвижен, силуэты растений двигаются
 * медленно, ближние — быстрее. Между ними — объёмные лучи, дымка и парящая
 * взвесь, которая связывает планы и оживляет пустое пространство.
 *
 * Каждый план рисуется своей матрицей камеры, поэтому масштаб у всех планов
 * общий и при отдалении картинка не расслаивается.
 *
 * Всё, что отличает одну локацию от другой, приходит из темы: цвета, форма
 * каркаса, сила дождя и то, кто здесь летает. Кода на комнату не добавляется.
 */
export class BackgroundRenderer {
  private readonly farLayer = new ShapeBuffer();
  private readonly midLayer = new ShapeBuffer();
  private readonly nearLayer = new ShapeBuffer();

  private readonly theme: LevelTheme;
  private readonly rays: RayDefinition[] = [];
  private readonly motes: Mote[] = [];
  private readonly flyers: Flyer[] = [];
  private readonly rainDrops: { x: number; y: number; speed: number; length: number }[] = [];
  private readonly layerView: Rect = { x: 0, y: 0, width: 0, height: 0 };

  private readonly hazeCache = new Map<string, CanvasGradient>();
  private layerBudget = 4;
  private showRays = true;
  private showRain = true;
  private moteCount = 90;
  private worldWidth = 4200;
  private worldHeight = 1400;

  constructor(level: LevelDefinition) {
    this.theme = getTheme(level.theme);
    this.worldWidth = level.worldBounds.width;
    this.worldHeight = level.worldBounds.height;

    this.buildRays();
    this.buildMotes();
    this.buildFlyers();
    this.buildRain();
    this.drawStaticLayers();
  }

  /** Цвет, которым сцена заливает холст до отрисовки кадра. */
  get clearColor(): number {
    return this.theme.skyTop;
  }

  setQuality(layers: number, rays: boolean, rain: boolean, motes: number): void {
    this.hazeCache.clear();
    this.layerBudget = layers;
    this.showRays = rays;
    this.showRain = rain;
    this.moteCount = motes;
    this.drawStaticLayers();
  }

  private buildRays(): void {
    if (this.theme.rayIntensity <= 0) return;
    const random = createRandom(9181);
    // Лучи привязаны к пролётам крыши, а не разбросаны случайно — так они
    // читаются как свет из окон, а не как абстрактное свечение.
    const spans = Math.max(4, Math.round(this.worldWidth / 620));
    for (let i = 0; i < spans; i++) {
      const x = (i + 0.5) * (this.worldWidth / spans) + (random() - 0.5) * 160;
      this.rays.push({
        x,
        y: -60,
        width: 150 + random() * 190,
        height: this.worldHeight * (0.75 + random() * 0.35),
        angle: -0.16 + random() * 0.32,
        intensity: (0.1 + random() * 0.13) * this.theme.rayIntensity,
        phase: random() * Math.PI * 2,
      });
    }
  }

  private buildMotes(): void {
    const random = createRandom(4477);
    const rise = this.theme.moteRise;
    for (let i = 0; i < 160; i++) {
      this.motes.push({
        x: random() * this.worldWidth,
        y: random() * this.worldHeight,
        z: 0.35 + random() * 0.65,
        vx: (random() - 0.5) * 12,
        vy: (-3 - random() * 9) * rise,
        size: 1 + random() * 2.4,
        phase: random() * Math.PI * 2,
      });
    }
  }

  /**
   * Живность облюбовывает верхнюю половину комнаты и держится своей орбиты.
   * Случайное блуждание выглядело бы дёрганым, а замкнутая петля с двумя
   * несоизмеримыми частотами читается как осмысленный полёт.
   */
  private buildFlyers(): void {
    if (this.theme.life === 'none') return;
    const random = createRandom(5303);
    for (let i = 0; i < this.theme.lifeCount; i++) {
      const homeX = random() * this.worldWidth;
      const homeY = this.worldHeight * (0.18 + random() * 0.5);
      this.flyers.push({
        homeX,
        homeY,
        radiusX: 60 + random() * 190,
        radiusY: 30 + random() * 110,
        speed: 0.22 + random() * 0.4,
        phase: random() * Math.PI * 2,
        size: 2 + random() * 2.6,
        x: homeX,
        y: homeY,
        previousX: homeX,
        pulse: random() * Math.PI * 2,
      });
    }
  }

  private buildRain(): void {
    if (this.theme.rain <= 0) return;
    const random = createRandom(3311);
    const count = Math.round(90 * Math.min(2, this.theme.rain));
    for (let i = 0; i < count; i++) {
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
    const theme = this.theme;

    const vertical = ctx.createLinearGradient(0, 0, 0, height);
    vertical.addColorStop(0, cssColor(theme.skyTop, 1));
    vertical.addColorStop(0.34, cssColor(theme.skyMid, 1));
    vertical.addColorStop(1, cssColor(theme.skyLow, 1));
    painter.fillGradient(vertical);
    painter.fillRect(0, 0, width, height);

    // Зарево у горизонта — источник всего света в комнате. Именно радиальный
    // градиент, а не залитый эллипс: у эллипса виден край, и на тёмном фоне он
    // читается как посторонняя дуга поперёк кадра.
    const centreY = height * theme.horizonHeight;
    const radius = Math.max(width, height) * 0.95;
    const glow = ctx.createRadialGradient(width / 2, centreY, 0, width / 2, centreY, radius);
    glow.addColorStop(0, cssColor(theme.skyHorizon, theme.horizonStrength));
    glow.addColorStop(0.45, cssColor(theme.skyHorizon, theme.horizonStrength * 0.47));
    glow.addColorStop(1, cssColor(theme.skyHorizon, 0));
    painter.fillGradient(glow);
    painter.fillRect(0, 0, width, height);
  }

  /**
   * Дымка поверх дальних планов.
   *
   * В тёмной сцене одного затемнения мало: слои сливаются в общее пятно.
   * Полупрозрачная пелена, плотная у горизонта и прозрачная вверху, отделяет
   * дальний план от ближнего убедительнее, чем любая разница в яркости.
   */
  private drawHaze(painter: Painter, width: number, height: number, strength: number): void {
    const density = this.theme.haze * strength;
    if (density <= 0.01) return;

    // Градиент зависит только от высоты кадра и плотности, поэтому строится
    // один раз на размер окна: `createLinearGradient` каждый кадр стоит
    // дороже самой заливки.
    const key = `${Math.round(height)}:${density.toFixed(3)}`;
    let gradient = this.hazeCache.get(key);
    if (!gradient) {
      gradient = painter.ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, cssColor(this.theme.hazeColor, 0));
      gradient.addColorStop(0.55, cssColor(this.theme.hazeColor, density * 0.5));
      gradient.addColorStop(1, cssColor(this.theme.hazeColor, density));
      this.hazeCache.set(key, gradient);
    }

    painter.fillGradient(gradient);
    painter.fillRect(0, 0, width, height);
  }

  // ------------------------------------------------------------- дальний план

  private drawFarLayer(): void {
    const g = this.farLayer;
    g.clear();

    switch (this.theme.structure) {
      case 'greenhouse':
        this.drawGlassRoof(g);
        break;
      case 'vault':
        this.drawVaults(g);
        break;
      case 'canopy':
        this.drawBoughs(g);
        break;
      case 'ruins':
        this.drawColonnade(g);
        break;
    }

    // Дальние силуэты крон — общий для всех тем «шум» глубины.
    const random = createRandom(1717);
    for (let i = 0; i < 42; i++) {
      const x = random() * this.worldWidth * 1.2 - this.worldWidth * 0.1;
      const y = this.worldHeight * (0.35 + random() * 0.5);
      const radius = 90 + random() * 220;
      g.fillStyle(this.theme.farFoliage, 0.55);
      g.fillEllipse(x, y, radius * 1.7, radius);
    }
  }

  /** Оранжерея: арки стеклянной крыши и диагональные переплёты. */
  private drawGlassRoof(g: ShapeBuffer): void {
    const frame = mixColor(this.theme.farFoliage, 0x37424f, 0.6);
    const glazing = mixColor(this.theme.farFoliage, 0x7d8b9e, 0.4);
    const archCount = Math.ceil(this.worldWidth / 520) + 2;

    for (let i = 0; i < archCount; i++) {
      const x = i * 520 - 200;
      g.lineStyle(7, frame, 0.5);
      g.beginPath();
      g.moveTo(x, this.worldHeight * 0.62);
      g.lineTo(x, 210);
      g.lineTo(x + 260, 90);
      g.lineTo(x + 520, 210);
      g.strokePath();

      g.lineStyle(2.4, glazing, 0.22);
      for (let s = 1; s < 5; s++) {
        const t = s / 5;
        g.beginPath();
        g.moveTo(x + 520 * t, 210 - 120 * (1 - Math.abs(t - 0.5) * 2));
        g.lineTo(x + 520 * t, this.worldHeight * 0.5);
        g.strokePath();
      }
    }
  }

  /**
   * Подвал: ряд кирпичных сводов.
   *
   * Арка набирается ломаной по полуокружности, а не дугой: дуга в буфере
   * фигур хранилась бы отдельной командой ради формы, которую всё равно не
   * видно за дымкой на таком удалении.
   */
  private drawVaults(g: ShapeBuffer): void {
    const random = createRandom(2244);
    const brick = mixColor(this.theme.farFoliage, 0x3a4560, 0.7);
    const span = 440;
    const count = Math.ceil(this.worldWidth / span) + 2;
    const springLine = this.worldHeight * 0.46;

    for (let i = 0; i < count; i++) {
      const x = i * span - 180;
      const radius = span / 2;

      g.fillStyle(shade(brick, -0.35), 0.9);
      g.beginPath();
      g.moveTo(x, this.worldHeight);
      g.lineTo(x, springLine);
      for (let s = 0; s <= 12; s++) {
        const angle = Math.PI - (s / 12) * Math.PI;
        g.lineTo(x + radius - Math.cos(angle) * radius, springLine - Math.sin(angle) * radius * 0.7);
      }
      g.lineTo(x + span, this.worldHeight);
      g.closePath();
      g.fillPath();

      // Кладка: ряды швов вдоль опоры.
      g.lineStyle(1.6, shade(brick, 0.2), 0.18);
      for (let row = 0; row < 9; row++) {
        const y = springLine + 40 + row * 46;
        if (y > this.worldHeight) break;
        g.beginPath();
        g.moveTo(x + 6, y);
        g.lineTo(x + 74, y);
        g.strokePath();
        g.beginPath();
        g.moveTo(x + span - 74, y + 23);
        g.lineTo(x + span - 6, y + 23);
        g.strokePath();
      }

      // Сталактиты под замком свода: сырость точит камень столетиями.
      const drips = 2 + Math.floor(random() * 3);
      g.fillStyle(shade(brick, -0.5), 0.85);
      for (let d = 0; d < drips; d++) {
        const dx = x + 90 + random() * (span - 180);
        const length = 30 + random() * 90;
        const half = 7 + random() * 9;
        g.beginPath();
        g.moveTo(dx - half, springLine - radius * 0.66);
        g.lineTo(dx + half, springLine - radius * 0.66);
        g.lineTo(dx, springLine - radius * 0.66 + length);
        g.closePath();
        g.fillPath();
      }
    }
  }

  /** Крона: толстые сучья, уходящие за край кадра. */
  private drawBoughs(g: ShapeBuffer): void {
    const random = createRandom(6677);
    const bark = mixColor(this.theme.farFoliage, 0x000000, 0.25);
    const count = Math.ceil(this.worldWidth / 700) + 2;

    for (let i = 0; i < count; i++) {
      const rootX = i * 700 - 260 + random() * 180;
      const rootY = this.worldHeight * (0.9 + random() * 0.2);
      let x = rootX;
      let y = rootY;
      let angle = -Math.PI / 2 + (random() - 0.5) * 0.5;
      let width = 70 + random() * 50;

      // Ствол ведётся полосой переменной ширины: каждый сегмент — трапеция.
      for (let s = 0; s < 7; s++) {
        const step = 130 + random() * 90;
        const nextX = x + Math.cos(angle) * step;
        const nextY = y + Math.sin(angle) * step;
        const nextWidth = width * (0.78 + random() * 0.1);

        g.fillStyle(bark, 0.95);
        g.beginPath();
        g.moveTo(x - width / 2, y);
        g.lineTo(x + width / 2, y);
        g.lineTo(nextX + nextWidth / 2, nextY);
        g.lineTo(nextX - nextWidth / 2, nextY);
        g.closePath();
        g.fillPath();

        // Отходящая ветвь с листвой на конце.
        if (s >= 2 && s % 2 === 0) {
          const side = random() > 0.5 ? 1 : -1;
          const branchAngle = angle + side * (0.6 + random() * 0.5);
          const branchLength = 150 + random() * 220;
          const tipX = nextX + Math.cos(branchAngle) * branchLength;
          const tipY = nextY + Math.sin(branchAngle) * branchLength;
          g.lineStyle(nextWidth * 0.42, bark, 0.9);
          g.beginPath();
          g.moveTo(nextX, nextY);
          g.lineTo(tipX, tipY);
          g.strokePath();
          g.fillStyle(this.theme.farFoliage, 0.7);
          g.fillEllipse(tipX, tipY, 220 + random() * 160, 120 + random() * 80);
        }

        x = nextX;
        y = nextY;
        width = nextWidth;
        angle += (random() - 0.5) * 0.4;
      }
    }
  }

  /** Руины: обломанные колонны и остатки антаблемента над ними. */
  private drawColonnade(g: ShapeBuffer): void {
    const random = createRandom(4141);
    const stone = mixColor(this.theme.farFoliage, 0x5b7684, 0.45);
    const span = 380;
    const count = Math.ceil(this.worldWidth / span) + 2;
    const baseY = this.worldHeight * 1.02;

    for (let i = 0; i < count; i++) {
      const x = i * span - 150 + (random() - 0.5) * 60;
      const height = this.worldHeight * (0.3 + random() * 0.42);
      const width = 62 + random() * 34;
      const top = baseY - height;

      g.fillStyle(stone, 0.85);
      g.beginPath();
      g.moveTo(x - width / 2, baseY);
      g.lineTo(x - width / 2 + 4, top + 10);
      // Скол наверху: колонна обломана неровно.
      g.lineTo(x - width * 0.2, top);
      g.lineTo(x + width * 0.1, top + 16 * random());
      g.lineTo(x + width / 2 - 4, top + 8);
      g.lineTo(x + width / 2, baseY);
      g.closePath();
      g.fillPath();

      // Каннелюры.
      g.lineStyle(2, shade(stone, -0.3), 0.35);
      for (let f = 1; f < 4; f++) {
        const fx = x - width / 2 + (width / 4) * f;
        g.beginPath();
        g.moveTo(fx, top + 26);
        g.lineTo(fx, baseY);
        g.strokePath();
      }

      // Уцелевший кусок перекрытия между каждой второй парой колонн.
      if (random() > 0.55 && i > 0) {
        g.fillStyle(shade(stone, -0.18), 0.8);
        g.fillRect(x - span + 20, top - 34, span - 40, 30);
      }
    }
  }

  // -------------------------------------------------------- средний и ближний

  private drawMidLayer(): void {
    const g = this.midLayer;
    g.clear();
    if (this.layerBudget < 3) return;
    const random = createRandom(8123);
    const structure = this.theme.structure;

    for (let i = 0; i < 34; i++) {
      const x = random() * this.worldWidth * 1.1;
      const baseY = this.worldHeight * (0.6 + random() * 0.42);
      const height = 180 + random() * 420;
      const width = 90 + random() * 200;

      g.fillStyle(this.theme.midFoliage, 0.82);

      if (structure === 'vault') {
        // В подвале сверху свисают корневые занавеси, а не растут листья.
        const strands = 4 + Math.floor(random() * 4);
        for (let s = 0; s < strands; s++) {
          const sx = x + (s - strands / 2) * 26;
          g.lineStyle(9 + random() * 12, this.theme.midFoliage, 0.8);
          g.beginPath();
          g.moveTo(sx, 0);
          g.lineTo(sx + (random() - 0.5) * 60, height * 0.6);
          g.lineTo(sx + (random() - 0.5) * 110, height);
          g.strokePath();
        }
        continue;
      }

      // Крупный лист: сегментированный веер.
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
      g.fillStyle(this.theme.nearFoliage, 0.9);
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

  // ------------------------------------------------------------- симуляция

  /** Симуляция взвеси, живности и дождя; отрисовка идёт в свой момент кадра. */
  update(deltaSeconds: number, time: number): void {
    const count = Math.min(this.moteCount, this.motes.length);
    const rising = this.theme.moteRise >= 0;
    for (let i = 0; i < count; i++) {
      const mote = this.motes[i]!;
      mote.x += (mote.vx + Math.sin(time / 1800 + mote.phase) * 9) * deltaSeconds;
      mote.y += mote.vy * deltaSeconds;
      if (rising ? mote.y < -40 : mote.y > this.worldHeight + 40) {
        mote.y = rising ? this.worldHeight + 40 : -40;
        mote.x = Math.random() * this.worldWidth;
      }
      if (mote.x < -60) mote.x = this.worldWidth + 60;
      if (mote.x > this.worldWidth + 60) mote.x = -60;
    }

    for (const flyer of this.flyers) {
      flyer.previousX = flyer.x;
      const t = time / 1000;
      // Две несоизмеримые частоты: петля не замыкается и полёт не выглядит
      // заученным, хотя вычисляется двумя синусами.
      flyer.x = flyer.homeX + Math.sin(t * flyer.speed + flyer.phase) * flyer.radiusX;
      flyer.y =
        flyer.homeY +
        Math.sin(t * flyer.speed * 1.618 + flyer.phase * 2) * flyer.radiusY;
      flyer.pulse = 0.5 + 0.5 * Math.sin(t * (this.theme.life === 'fireflies' ? 1.7 : 9) + flyer.phase);
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

  // ------------------------------------------------------------- отрисовка

  /**
   * Полная отрисовка фона: небо, дальний план, лучи и дождь на сложении,
   * дымка, средний и ближний планы, живность и взвесь сверху.
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

    // Дымка ложится сразу за дальним планом: он должен утонуть в ней целиком.
    // Обе пелены — полноэкранные проходы с прозрачностью, и на низком качестве
    // от них отказываются первыми: заливка всего кадра стоит одинаково на
    // любой сцене, а без ускорителя это самая дорогая строка кадра.
    if (this.layerBudget >= 3) {
      painter.resetTransform(pixelRatio);
      this.drawHaze(painter, viewportWidth, viewportHeight, 1);
    }

    painter.setBlendMode('add');
    if (this.showRays && this.rays.length > 0) {
      camera.applyTo(ctx, pixelRatio, SCROLL.rays);
      this.drawRays(painter, time, camera.viewFor(SCROLL.rays, this.layerView));
    }
    if (this.showRain && this.rainDrops.length > 0) {
      camera.applyTo(ctx, pixelRatio, SCROLL.rain);
      this.drawRain(painter, camera.viewFor(SCROLL.rain, this.layerView));
    }
    painter.setBlendMode('normal');

    if (this.layerBudget >= 3) {
      camera.applyTo(ctx, pixelRatio, SCROLL.mid);
      this.midLayer.replay(painter, camera.viewFor(SCROLL.mid, this.layerView));
    }

    if (this.flyers.length > 0) {
      camera.applyTo(ctx, pixelRatio, SCROLL.life);
      this.drawFlyers(painter, camera.viewFor(SCROLL.life, this.layerView));
    }

    if (this.layerBudget >= 4) {
      camera.applyTo(ctx, pixelRatio, SCROLL.near);
      this.nearLayer.replay(painter, camera.viewFor(SCROLL.near, this.layerView));
    }

    // Вторая, слабая пелена — уже поверх ближнего плана: она отделяет фон от
    // игровой геометрии, по которой ходит героиня. На низком качестве её нет:
    // это второй полноэкранный проход ради довольно тонкого эффекта.
    if (this.layerBudget >= 3) {
      painter.resetTransform(pixelRatio);
      this.drawHaze(painter, viewportWidth, viewportHeight, 0.45);
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

      painter.fillStyle(this.theme.lightWarm, alpha);
      painter.beginPath();
      painter.moveTo(topX - halfWidth, ray.y);
      painter.lineTo(topX + halfWidth, ray.y);
      painter.lineTo(bottomX + spread, ray.y + ray.height);
      painter.lineTo(bottomX - spread, ray.y + ray.height);
      painter.closePath();
      painter.fillPath();

      // Яркая сердцевина.
      painter.fillStyle(this.theme.lightCore, alpha * 0.5);
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
    const big = this.theme.life === 'spores' ? 1.6 : 1;

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
      painter.fillStyle(this.theme.moteColor, 0.18 * mote.z * twinkle);
      painter.fillCircle(mote.x, mote.y, mote.size * 2.6 * big);
      painter.fillStyle(this.theme.lightCore, 0.5 * mote.z * twinkle);
      painter.fillCircle(mote.x, mote.y, mote.size * 0.75 * big);
    }
  }

  /**
   * Живность фона.
   *
   * Бабочка рисуется силуэтом с трепещущими крыльями, светлячок — мигающей
   * точкой со свечением, спора — мягким пухом. Все трое стоят на одной
   * механике полёта: различается только то, чем занята каждая пара строк.
   */
  private drawFlyers(painter: Painter, view: Rect): void {
    const right = view.x + view.width;
    const bottom = view.y + view.height;
    const life = this.theme.life;

    for (const flyer of this.flyers) {
      if (
        flyer.x < view.x - 60 ||
        flyer.x > right + 60 ||
        flyer.y < view.y - 60 ||
        flyer.y > bottom + 60
      ) {
        continue;
      }

      if (life === 'fireflies') {
        painter.setBlendMode('add');
        painter.fillStyle(this.theme.lifeColor, 0.1 + flyer.pulse * 0.22);
        painter.fillCircle(flyer.x, flyer.y, flyer.size * 5.5);
        painter.fillStyle(this.theme.lightCore, 0.35 + flyer.pulse * 0.6);
        painter.fillCircle(flyer.x, flyer.y, flyer.size * 0.9);
        painter.setBlendMode('normal');
        continue;
      }

      if (life === 'spores') {
        painter.fillStyle(this.theme.lifeColor, 0.1 + flyer.pulse * 0.06);
        painter.fillCircle(flyer.x, flyer.y, flyer.size * 3.4);
        painter.fillStyle(this.theme.lifeColor, 0.3);
        painter.fillCircle(flyer.x, flyer.y, flyer.size);
        continue;
      }

      // Бабочка: крылья складываются в такт, а разворот берётся из движения.
      const facing = flyer.x >= flyer.previousX ? 1 : -1;
      const span = flyer.size * (1.1 + flyer.pulse * 2.2);
      painter.fillStyle(this.theme.lifeColor, 0.5);
      painter.beginPath();
      painter.moveTo(flyer.x, flyer.y);
      painter.lineTo(flyer.x - span * facing, flyer.y - flyer.size * 1.6);
      painter.lineTo(flyer.x - span * 0.7 * facing, flyer.y + flyer.size);
      painter.closePath();
      painter.fillPath();
      painter.beginPath();
      painter.moveTo(flyer.x, flyer.y);
      painter.lineTo(flyer.x + span * 0.8 * facing, flyer.y - flyer.size * 1.3);
      painter.lineTo(flyer.x + span * 0.55 * facing, flyer.y + flyer.size * 0.9);
      painter.closePath();
      painter.fillPath();
    }
  }

  private drawRain(painter: Painter, view: Rect): void {
    const left = view.x - 300;
    const right = view.x + view.width + 300;
    const strength = Math.min(1, this.theme.rain);

    // Дождь идёт снаружи, за стеклом: он мягкий и почти прозрачный.
    painter.lineStyle(1.4, this.theme.lightCore, 0.08 * strength + 0.03);
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

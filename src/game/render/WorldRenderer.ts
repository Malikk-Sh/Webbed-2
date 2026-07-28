import Phaser from 'phaser';
import { PALETTE, mixColor, shade } from '../../app/Palette';
import { clamp01, createRandom, easeOutCubic } from '../../core/math/Interpolation';
import type { Polygon } from '../../core/math/Geometry';
import type { Vector2 } from '../../core/math/Vector2';
import type { LevelDecor, LevelDefinition } from '../level/LevelSchema';
import type { LoadedLevel } from '../level/PrototypeLevelLoader';
import { getMaterial } from '../physics/PhysicsMaterials';
import { TEXTURES } from './TextureFactory';

interface EdgeTuft {
  x: number;
  y: number;
  nx: number;
  ny: number;
  height: number;
  lean: number;
  color: number;
  phase: number;
}

/**
 * Отрисовка геометрии комнаты и её декора.
 *
 * Статические слои рисуются один раз: платформы, мох, трещины и растения не
 * меняются, а перерисовка сотен фигур каждый кадр съедала бы весь бюджет CPU.
 * Каждый кадр обновляются только те элементы, которые действительно живут —
 * колышущаяся трава на кромках, свет ламп и точки крепления.
 */
export class WorldRenderer {
  private readonly backLayer: Phaser.GameObjects.Graphics;
  private readonly solidLayer: Phaser.GameObjects.Graphics;
  private readonly detailLayer: Phaser.GameObjects.Graphics;
  private readonly liveLayer: Phaser.GameObjects.Graphics;
  private readonly glowLayer: Phaser.GameObjects.Graphics;
  private readonly lampSprites: Phaser.GameObjects.Image[] = [];

  private readonly tufts: EdgeTuft[] = [];
  private windPhase = 0;

  constructor(
    scene: Phaser.Scene,
    private readonly level: LoadedLevel,
    baseDepth: number,
  ) {
    this.backLayer = scene.add.graphics().setDepth(baseDepth);
    this.solidLayer = scene.add.graphics().setDepth(baseDepth + 1);
    this.detailLayer = scene.add.graphics().setDepth(baseDepth + 2);
    this.liveLayer = scene.add.graphics().setDepth(baseDepth + 3);
    this.glowLayer = scene.add
      .graphics()
      .setDepth(baseDepth + 4)
      .setBlendMode(Phaser.BlendModes.ADD);

    this.drawStatic();
    this.createLamps(scene, level.definition, baseDepth + 5);
  }

  destroy(): void {
    this.backLayer.destroy();
    this.solidLayer.destroy();
    this.detailLayer.destroy();
    this.liveLayer.destroy();
    this.glowLayer.destroy();
    for (const lamp of this.lampSprites) lamp.destroy();
  }

  // ------------------------------------------------------------- статика

  private drawStatic(): void {
    const back = this.backLayer;
    const solid = this.solidLayer;
    const detail = this.detailLayer;
    back.clear();
    solid.clear();
    detail.clear();

    for (const decor of this.level.definition.decor ?? []) {
      if (decor.layer === 0) this.drawDecor(back, decor);
    }

    for (const entry of this.level.polygons) {
      this.drawPlatform(solid, detail, entry.polygon, entry.materialId, entry.id);
    }

    for (const decor of this.level.definition.decor ?? []) {
      if ((decor.layer ?? 1) === 1) this.drawDecor(detail, decor);
    }
  }

  private drawPlatform(
    solid: Phaser.GameObjects.Graphics,
    detail: Phaser.GameObjects.Graphics,
    polygon: Polygon,
    materialId: string,
    id: string,
  ): void {
    const material = getMaterial(materialId);
    const points = polygon.points;
    const random = createRandom(hashString(id));
    const width = polygon.maxX - polygon.minX;
    const height = polygon.maxY - polygon.minY;

    // Основной объём с вертикальным градиентом: свет падает сверху, низ уходит
    // в глубокую тень. Кривая easeOutCubic делает спад быстрым у верхней
    // кромки — так платформа читается как объём, а не как плоская заливка.
    const bands = Math.max(4, Math.min(22, Math.round(height / 18)));
    for (let i = 0; i < bands; i++) {
      const t = i / bands;
      const color = mixColor(material.topColor, shade(material.color, -0.62), easeOutCubic(t));
      solid.fillStyle(color, 1);
      const y0 = polygon.minY + (height / bands) * i;
      this.fillPolygonBand(solid, points, y0, y0 + height / bands + 1);
    }

    // Светлая «губа» на самом верху: тонкая полоса подчёркивает кромку.
    solid.fillStyle(shade(material.topColor, 0.16), 1);
    this.fillPolygonBand(solid, points, polygon.minY, polygon.minY + 4);

    // Фактура материала: у дерева — вертикальные волокна, у камня — крапины.
    if (materialId === 'wood') {
      detail.lineStyle(1.6, shade(material.color, -0.28), 0.4);
      const grains = Math.max(2, Math.round(width / 26));
      for (let i = 0; i < grains; i++) {
        const x = polygon.minX + ((i + 0.5) / grains) * width + (random() - 0.5) * 8;
        detail.beginPath();
        detail.moveTo(x, polygon.minY + 6);
        const knots = 3;
        for (let k = 1; k <= knots; k++) {
          detail.lineTo(x + Math.sin(k * 1.7 + i) * 4, polygon.minY + (height / knots) * k);
        }
        detail.strokePath();
      }
    } else {
      const speckles = Math.round((width * height) / 5200);
      for (let i = 0; i < Math.min(140, speckles); i++) {
        const x = polygon.minX + random() * width;
        const y = polygon.minY + random() * height;
        detail.fillStyle(random() > 0.5 ? shade(material.color, 0.12) : shade(material.color, -0.3), 0.35);
        detail.fillCircle(x, y, 1 + random() * 2.6);
      }
    }

    // Контурная подсветка кромок.
    detail.lineStyle(2, shade(material.edgeColor, 0.08), 0.4);
    detail.beginPath();
    detail.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) detail.lineTo(points[i]!.x, points[i]!.y);
    detail.closePath();
    detail.strokePath();

    // Трещины и сколы — характер поверхности после бури.
    const crackCount = Math.round(width / 260);
    detail.lineStyle(1.4, shade(material.color, -0.5), 0.45);
    for (let i = 0; i < crackCount; i++) {
      let x = polygon.minX + random() * width;
      let y = polygon.minY + 16 + random() * Math.max(10, height - 30);
      detail.beginPath();
      detail.moveTo(x, y);
      const segments = 2 + Math.floor(random() * 3);
      for (let s = 0; s < segments; s++) {
        x += (random() - 0.5) * 46;
        y += random() * 26;
        if (y > polygon.maxY - 4) break;
        detail.lineTo(x, y);
      }
      detail.strokePath();
    }

    this.collectEdgeTufts(polygon, material.mossiness, random, detail);
  }

  /** Заливка горизонтальной полосы многоугольника — даёт мягкий градиент. */
  private fillPolygonBand(
    g: Phaser.GameObjects.Graphics,
    points: Vector2[],
    y0: number,
    y1: number,
  ): void {
    const clipped = clipPolygonToBand(points, y0, y1);
    if (clipped.length < 3) return;
    g.beginPath();
    g.moveTo(clipped[0]!.x, clipped[0]!.y);
    for (let i = 1; i < clipped.length; i++) g.lineTo(clipped[i]!.x, clipped[i]!.y);
    g.closePath();
    g.fillPath();
  }

  /**
   * Мох и трава на кромках.
   *
   * Растительность сажается только на грани, обращённые вверх: так платформа
   * читается как заросшая, а не обклеенная зеленью со всех сторон.
   */
  private collectEdgeTufts(
    polygon: Polygon,
    mossiness: number,
    random: () => number,
    detail: Phaser.GameObjects.Graphics,
  ): void {
    if (mossiness <= 0.02) return;
    const points = polygon.points;

    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const edgeLength = Math.hypot(ex, ey);
      if (edgeLength < 30) continue;

      // Внешняя нормаль ребра (обход по часовой стрелке).
      const nx = ey / edgeLength;
      const ny = -ex / edgeLength;
      const upness = -ny;
      if (upness < 0.55) continue;

      // Подушка мха: неровный силуэт строится как полоса с «гуляющей»
      // верхней границей. Раньше здесь были круги — они читались как ряд
      // одинаковых горошин, а не как заросшая кромка.
      const tx = ex / edgeLength;
      const ty = ey / edgeLength;
      const steps = Math.max(4, Math.round(edgeLength / 14));
      const profile: number[] = [];
      for (let s = 0; s <= steps; s++) {
        const base = 5 + mossiness * 5;
        profile.push(base + Math.sin(s * 1.9 + edgeLength) * 2.4 + random() * 4.5);
      }

      // Основание уходит на пару единиц внутрь платформы, а верхняя граница
      // выступает наружу вдоль нормали — подушка сидит на кромке, а не в ней.
      const drawCushion = (scale: number, color: number, alpha: number) => {
        detail.fillStyle(color, alpha);
        detail.beginPath();
        detail.moveTo(a.x - nx * 3, a.y - ny * 3);
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const h = profile[s]! * scale;
          detail.lineTo(a.x + tx * edgeLength * t + nx * h, a.y + ty * edgeLength * t + ny * h);
        }
        detail.lineTo(b.x - nx * 3, b.y - ny * 3);
        detail.closePath();
        detail.fillPath();
      };

      // От тёмного основания к светлым кончикам — объём в три слоя.
      drawCushion(1, PALETTE.mossLight, 0.55);
      drawCushion(0.7, PALETTE.moss, 0.9);
      drawCushion(0.34, PALETTE.mossDark, 0.9);

      const density = Math.floor((edgeLength / 20) * mossiness);
      for (let s = 0; s < density; s++) {
        const t = random();
        this.tufts.push({
          x: a.x + ex * t,
          y: a.y + ey * t - ny * 3,
          nx,
          ny,
          height: 8 + random() * 16,
          lean: (random() - 0.5) * 0.6,
          color: random() > 0.72 ? PALETTE.mossLight : PALETTE.moss,
          phase: random() * Math.PI * 2,
        });
      }
    }
  }

  // --------------------------------------------------------------- декор

  private drawDecor(g: Phaser.GameObjects.Graphics, decor: LevelDecor): void {
    const random = createRandom((decor.seed ?? 1) * 7919 + 31);
    const scale = decor.scale ?? 1;

    switch (decor.type) {
      case 'pot':
        this.drawPot(g, decor.x, decor.y, scale, random);
        break;
      case 'plant':
        this.drawPlant(g, decor.x, decor.y, scale, random);
        break;
      case 'vine':
        this.drawVine(g, decor.x, decor.y, scale, random);
        break;
      case 'root':
        this.drawRoot(g, decor.x, decor.y, scale, random);
        break;
      case 'glass-pane':
        this.drawGlassPane(g, decor.x, decor.y, scale, random);
        break;
      case 'grass':
        this.drawGrassPatch(decor.x, decor.y, scale, random);
        break;
      case 'lamp':
        // Лампа рисуется отдельным спрайтом со свечением.
        break;
    }
  }

  private drawPot(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    scale: number,
    random: () => number,
  ): void {
    const width = 68 * scale;
    const height = 74 * scale;
    const clay = mixColor(PALETTE.woodEdge, PALETTE.crate, 0.4);

    g.fillStyle(shade(clay, -0.35), 1);
    g.beginPath();
    g.moveTo(x - width / 2, y - height);
    g.lineTo(x + width / 2, y - height);
    g.lineTo(x + width * 0.36, y);
    g.lineTo(x - width * 0.36, y);
    g.closePath();
    g.fillPath();

    g.fillStyle(clay, 1);
    g.beginPath();
    g.moveTo(x - width / 2, y - height);
    g.lineTo(x + width * 0.1, y - height);
    g.lineTo(x + width * 0.02, y);
    g.lineTo(x - width * 0.36, y);
    g.closePath();
    g.fillPath();

    // Ободок.
    g.fillStyle(shade(clay, 0.18), 1);
    g.fillRect(x - width * 0.56, y - height - 9 * scale, width * 1.12, 11 * scale);

    // Трещина: горшок пережил бурю.
    g.lineStyle(2, shade(clay, -0.55), 0.7);
    g.beginPath();
    g.moveTo(x + width * 0.1, y - height + 6);
    g.lineTo(x + width * 0.24, y - height * 0.55);
    g.lineTo(x + width * 0.12, y - height * 0.2);
    g.strokePath();

    // Земля и ростки.
    g.fillStyle(shade(PALETTE.woodBase, -0.2), 1);
    g.fillEllipse(x, y - height - 2 * scale, width * 1.02, 12 * scale);
    for (let i = 0; i < 5; i++) {
      const sx = x + (random() - 0.5) * width * 0.8;
      const sy = y - height - 4 * scale;
      g.lineStyle(2.4 * scale, PALETTE.moss, 0.9);
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + (random() - 0.5) * 26 * scale, sy - (18 + random() * 30) * scale);
      g.strokePath();
    }
  }

  private drawPlant(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    scale: number,
    random: () => number,
  ): void {
    const blades = 5 + Math.floor(random() * 4);
    for (let i = 0; i < blades; i++) {
      const spread = (i / (blades - 1) - 0.5) * 1.7;
      const length = (70 + random() * 90) * scale;
      const tipX = x + Math.sin(spread) * length;
      const tipY = y - Math.cos(spread) * length;
      const midX = x + Math.sin(spread) * length * 0.55 - Math.cos(spread) * 16 * scale;
      const midY = y - Math.cos(spread) * length * 0.55 - Math.sin(spread) * 16 * scale;

      const color = mixColor(PALETTE.mossDark, PALETTE.moss, random());
      g.fillStyle(color, 0.94);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(midX - 11 * scale, midY);
      g.lineTo(tipX, tipY);
      g.lineTo(midX + 11 * scale, midY);
      g.closePath();
      g.fillPath();

      g.lineStyle(1.2, shade(color, 0.28), 0.5);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(tipX, tipY);
      g.strokePath();
    }
  }

  private drawVine(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    scale: number,
    random: () => number,
  ): void {
    const length = (160 + random() * 220) * scale;
    const segments = 12;
    let px = x;
    let py = y;
    g.lineStyle(3.2 * scale, PALETTE.vine, 0.9);
    g.beginPath();
    g.moveTo(px, py);
    const leaves: Vector2[] = [];
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      px = x + Math.sin(t * 5 + random() * 0.2) * 26 * scale;
      py = y + length * t;
      g.lineTo(px, py);
      if (i % 3 === 0) leaves.push({ x: px, y: py });
    }
    g.strokePath();

    for (const leaf of leaves) {
      const side = random() > 0.5 ? 1 : -1;
      g.fillStyle(mixColor(PALETTE.vine, PALETTE.moss, random()), 0.92);
      g.fillEllipse(leaf.x + side * 13 * scale, leaf.y, 26 * scale, 13 * scale);
    }
  }

  private drawRoot(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    scale: number,
    random: () => number,
  ): void {
    // Корни свисают вниз из-под кромки платформы: так они читаются как часть
    // мира, а не как отдельные ветки, воткнутые в воздух.
    const branches = 3 + Math.floor(random() * 3);
    for (let b = 0; b < branches; b++) {
      let px = x + (random() - 0.5) * 40 * scale;
      let py = y;
      let angle = Math.PI / 2 + (random() - 0.5) * 0.9;
      g.lineStyle((4.2 - b * 0.6) * scale, shade(PALETTE.woodBase, -0.25), 0.8);
      g.beginPath();
      g.moveTo(px, py);
      for (let i = 0; i < 5; i++) {
        angle += (random() - 0.5) * 0.55;
        const step = (24 + random() * 26) * scale;
        px += Math.cos(angle) * step;
        py += Math.sin(angle) * step;
        g.lineTo(px, py);
      }
      g.strokePath();
    }
  }

  private drawGlassPane(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    scale: number,
    random: () => number,
  ): void {
    const width = 220 * scale;
    const height = 150 * scale;
    g.fillStyle(PALETTE.slipperyTop, 0.1);
    g.fillRect(x - width / 2, y, width, height);
    g.lineStyle(2, PALETTE.slipperyEdge, 0.22);
    g.strokeRect(x - width / 2, y, width, height);

    // Разбитое стекло: трещины из одной точки удара.
    const hitX = x + (random() - 0.5) * width * 0.5;
    const hitY = y + height * (0.3 + random() * 0.4);
    g.lineStyle(1.5, PALETTE.slipperyEdge, 0.4);
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 2 + random() * 0.4;
      const len = (40 + random() * 90) * scale;
      g.beginPath();
      g.moveTo(hitX, hitY);
      g.lineTo(hitX + Math.cos(angle) * len, hitY + Math.sin(angle) * len);
      g.strokePath();
    }
  }

  private drawGrassPatch(x: number, y: number, scale: number, random: () => number): void {
    for (let i = 0; i < 14; i++) {
      this.tufts.push({
        x: x + (random() - 0.5) * 120 * scale,
        y,
        nx: 0,
        ny: -1,
        height: (14 + random() * 30) * scale,
        lean: (random() - 0.5) * 0.8,
        color: random() > 0.6 ? PALETTE.mossLight : PALETTE.moss,
        phase: random() * Math.PI * 2,
      });
    }
  }

  private createLamps(scene: Phaser.Scene, definition: LevelDefinition, depth: number): void {
    for (const decor of definition.decor ?? []) {
      if (decor.type !== 'lamp') continue;
      const scale = decor.scale ?? 1;
      const halo = scene.add
        .image(decor.x, decor.y + 34 * scale, TEXTURES.glowSoft)
        .setDepth(depth)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(PALETTE.sunWarm)
        .setAlpha(0.3)
        .setScale(1.5 * scale);
      halo.setData('phase', Math.random() * Math.PI * 2);
      halo.setData('baseScale', 1.5 * scale);
      this.lampSprites.push(halo);

      // Корпус лампы рисуется в статичный слой.
      const g = this.detailLayer;
      g.lineStyle(3 * scale, PALETTE.metalEdge, 0.8);
      g.beginPath();
      g.moveTo(decor.x, decor.y);
      g.lineTo(decor.x, decor.y + 22 * scale);
      g.strokePath();
      g.fillStyle(PALETTE.metalBase, 1);
      g.beginPath();
      g.moveTo(decor.x - 24 * scale, decor.y + 22 * scale);
      g.lineTo(decor.x + 24 * scale, decor.y + 22 * scale);
      g.lineTo(decor.x + 15 * scale, decor.y + 44 * scale);
      g.lineTo(decor.x - 15 * scale, decor.y + 44 * scale);
      g.closePath();
      g.fillPath();
      g.fillStyle(PALETTE.sunCore, 0.9);
      g.fillEllipse(decor.x, decor.y + 45 * scale, 24 * scale, 10 * scale);
    }
  }

  // ------------------------------------------------------------- анимация

  update(deltaSeconds: number, time: number, camera: Phaser.Cameras.Scene2D.Camera): void {
    this.windPhase += deltaSeconds;
    const g = this.liveLayer;
    g.clear();

    const view = camera.worldView;
    // Порыв ветра пробегает по комнате слева направо.
    const gustCentre = ((this.windPhase * 260) % (this.level.definition.worldBounds.width + 1400)) - 700;

    for (const tuft of this.tufts) {
      if (tuft.x < view.x - 60 || tuft.x > view.right + 60) continue;
      if (tuft.y < view.y - 80 || tuft.y > view.bottom + 80) continue;

      const gust = clamp01(1 - Math.abs(tuft.x - gustCentre) / 420);
      const sway =
        Math.sin(this.windPhase * 1.6 + tuft.phase) * 0.12 + tuft.lean + gust * 0.55;

      // Травинка гнётся по дуге вдоль поверхности, а не ломается углом.
      const tangentX = -tuft.ny;
      const tangentY = tuft.nx;
      const tipX = tuft.x + tuft.nx * tuft.height + tangentX * sway * tuft.height;
      const tipY = tuft.y + tuft.ny * tuft.height + tangentY * sway * tuft.height;
      const midX = tuft.x + tuft.nx * tuft.height * 0.55 + tangentX * sway * tuft.height * 0.22;
      const midY = tuft.y + tuft.ny * tuft.height * 0.55 + tangentY * sway * tuft.height * 0.22;

      // Два прохода: широкое основание и тонкий кончик — травинка сужается.
      g.lineStyle(2.2, tuft.color, 0.85);
      g.beginPath();
      g.moveTo(tuft.x, tuft.y);
      g.lineTo(midX, midY);
      g.strokePath();
      g.lineStyle(1.2, tuft.color, 0.9);
      g.beginPath();
      g.moveTo(midX, midY);
      g.lineTo(tipX, tipY);
      g.strokePath();
    }

    // Пульсация ламп.
    const glow = this.glowLayer;
    glow.clear();
    for (const lamp of this.lampSprites) {
      const phase = lamp.getData('phase') as number;
      const baseScale = lamp.getData('baseScale') as number;
      // Старые лампы оранжереи мерцают неровно.
      const flicker =
        0.78 + 0.14 * Math.sin(time / 260 + phase) + 0.08 * Math.sin(time / 91 + phase * 3);
      lamp.setAlpha(0.26 * flicker);
      lamp.setScale(baseScale * (0.94 + flicker * 0.08));
    }
  }

  /** Точки крепления: пульсирующие узелки, к которым тянется прицел. */
  renderAnchors(time: number): void {
    const g = this.glowLayer;
    for (const anchor of this.level.anchors) {
      const pulse = 0.5 + 0.5 * Math.sin(time / 760 + anchor.position.x * 0.01);
      const highlight = anchor.highlight;
      const color = highlight > 0.5 ? PALETTE.anchorActive : PALETTE.anchorIdle;
      const radius = 5 + pulse * 1.6 + highlight * 4;

      g.fillStyle(color, 0.1 + highlight * 0.16);
      g.fillCircle(anchor.position.x, anchor.position.y, radius * 3.4);
      g.fillStyle(color, 0.55 + highlight * 0.35);
      g.fillCircle(anchor.position.x, anchor.position.y, radius);
      g.fillStyle(0xffffff, 0.75);
      g.fillCircle(anchor.position.x, anchor.position.y, radius * 0.35);

      // Кольцо-указатель вокруг подсвеченной точки.
      if (highlight > 0.02) {
        g.lineStyle(1.6, color, highlight * 0.8);
        g.strokeCircle(anchor.position.x, anchor.position.y, 13 + (1 - pulse) * 4);
      }
    }
  }
}

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** Отсечение многоугольника горизонтальной полосой (алгоритм Сазерленда). */
const clipPolygonToBand = (points: Vector2[], y0: number, y1: number): Vector2[] => {
  const clipEdge = (input: Vector2[], keepBelow: boolean, y: number): Vector2[] => {
    const output: Vector2[] = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i]!;
      const next = input[(i + 1) % input.length]!;
      const currentInside = keepBelow ? current.y >= y : current.y <= y;
      const nextInside = keepBelow ? next.y >= y : next.y <= y;

      if (currentInside) output.push(current);
      if (currentInside !== nextInside) {
        const t = (y - current.y) / (next.y - current.y);
        output.push({ x: current.x + (next.x - current.x) * t, y });
      }
    }
    return output;
  };

  let result = clipEdge(points, true, y0);
  if (result.length < 3) return [];
  result = clipEdge(result, false, y1);
  return result;
};

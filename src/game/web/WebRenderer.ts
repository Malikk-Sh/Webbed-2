import Phaser from 'phaser';
import { PALETTE, mixColor, tensionColor } from '../../app/Palette';
import { TENSION_STEPS } from '../../app/GameConfig';
import { clamp, clamp01, createRandom } from '../../core/math/Interpolation';
import type { Vector2 } from '../../core/math/Vector2';
import { TEXTURES } from '../render/TextureFactory';
import type { WebSystem } from './WebSystem';
import type { WebStrand } from './WebTypes';

interface DewDrop {
  /** Позиция вдоль нити, 0..1. */
  t: number;
  radius: number;
}

/**
 * Отрисовка паутины.
 *
 * Нить рисуется в несколько проходов: широкий полупрозрачный ореол в режиме
 * ADD, средний слой и яркое ядро. Такой «ручной» блум дешевле полноэкранного
 * постэффекта и, в отличие от него, не размывает интерфейс и фон, а светится
 * только там, где нужно — паутина всегда остаётся читаемой на тёмном фоне.
 */
export class WebRenderer {
  private readonly glowLayer: Phaser.GameObjects.Graphics;
  private readonly coreLayer: Phaser.GameObjects.Graphics;
  private readonly dewLayer: Phaser.GameObjects.Graphics;
  private readonly nodeSprites: Phaser.GameObjects.Group;

  private readonly dewCache = new Map<number, DewDrop[]>();
  private glowPasses = 2;
  private showDew = true;
  private highContrast = false;
  private pulseSprites: Phaser.GameObjects.Image[] = [];

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly web: WebSystem,
    depth: number,
  ) {
    this.glowLayer = scene.add
      .graphics()
      .setDepth(depth - 1)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.coreLayer = scene.add.graphics().setDepth(depth);
    this.dewLayer = scene.add
      .graphics()
      .setDepth(depth + 1)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.nodeSprites = scene.add.group();

    for (let i = 0; i < 12; i++) {
      const sprite = scene.add
        .image(0, 0, TEXTURES.glow)
        .setDepth(depth + 2)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setVisible(false)
        .setScale(0.22);
      this.pulseSprites.push(sprite);
    }
  }

  setQuality(glowPasses: number, dew: boolean, highContrast: boolean): void {
    this.glowPasses = clamp(glowPasses, 1, 3);
    this.showDew = dew;
    this.highContrast = highContrast;
  }

  destroy(): void {
    this.glowLayer.destroy();
    this.coreLayer.destroy();
    this.dewLayer.destroy();
    this.nodeSprites.destroy(true);
    for (const sprite of this.pulseSprites) sprite.destroy();
    this.pulseSprites = [];
  }

  render(time: number, cameraBounds: Phaser.Geom.Rectangle): void {
    const glow = this.glowLayer;
    const core = this.coreLayer;
    const dew = this.dewLayer;
    glow.clear();
    core.clear();
    dew.clear();

    let pulseIndex = 0;

    for (const strand of this.web.graph.allStrands) {
      if (!this.isVisible(strand, cameraBounds)) continue;
      pulseIndex = this.drawStrand(strand, time, pulseIndex);
    }

    for (let i = pulseIndex; i < this.pulseSprites.length; i++) {
      this.pulseSprites[i]!.setVisible(false);
    }

    this.drawSeveredRibbons();
  }

  private isVisible(strand: WebStrand, bounds: Phaser.Geom.Rectangle): boolean {
    const nodeA = this.web.graph.getNode(strand.nodeAId);
    const nodeB = this.web.graph.getNode(strand.nodeBId);
    if (!nodeA || !nodeB) return false;
    const minX = Math.min(nodeA.position.x, nodeB.position.x) - 40;
    const maxX = Math.max(nodeA.position.x, nodeB.position.x) + 40;
    const minY = Math.min(nodeA.position.y, nodeB.position.y) - 40;
    const maxY = Math.max(nodeA.position.y, nodeB.position.y) + 40;
    return (
      maxX > bounds.x &&
      minX < bounds.right &&
      maxY > bounds.y &&
      minY < bounds.bottom
    );
  }

  private drawStrand(strand: WebStrand, time: number, pulseIndex: number): number {
    const points = this.collectPoints(strand);
    if (points.length < 2) return pulseIndex;

    const tension = strand.tensionNormalized;
    const critical = tension >= TENSION_STEPS.pulsing;

    // Появление нити: за первые 120 мс она «дорастает» до полной яркости.
    const birth = clamp01(strand.ageMs / 120);

    // Толщина растёт с натяжением (раздел 24.2 ТЗ).
    const baseWidth = strand.playerCreated ? 2.5 : 2.1;
    const width = (baseWidth + tension * 1.5) * (this.highContrast ? 1.5 : 1);

    let color = tensionColor(tension);
    let alpha = (strand.sleeping ? 0.62 : 0.85) * birth;

    if (critical) {
      // Дрожание перед разрывом: частота и амплитуда растут вместе с
      // накопленной перегрузкой.
      const shakeEnergy = clamp01((tension - TENSION_STEPS.pulsing) / 0.05);
      const flicker = 0.5 + 0.5 * Math.sin(time / 26);
      color = mixColor(color, PALETTE.silkCritical, flicker * shakeEnergy);
      alpha = Math.min(1, alpha + 0.15 * flicker);
      const amplitude = 1.2 + shakeEnergy * 2.4;
      for (let i = 1; i < points.length - 1; i++) {
        const point = points[i]!;
        point.x += Math.sin(time / 22 + i * 1.7) * amplitude;
        point.y += Math.cos(time / 19 + i * 2.1) * amplitude;
      }
    } else if (tension > TENSION_STEPS.bright) {
      const pulse = 0.5 + 0.5 * Math.sin(time / 90);
      alpha = Math.min(1, alpha + pulse * 0.12);
    }

    // --- ореол --------------------------------------------------------
    const glowColor = this.highContrast ? PALETTE.silk : mixColor(color, PALETTE.silkGlow, 0.5);
    for (let pass = this.glowPasses; pass >= 1; pass--) {
      const passWidth = width * (1 + pass * 1.9);
      const passAlpha = (0.055 / pass) * (0.5 + tension * 0.9) * birth + 0.018 * birth;
      this.strokePolyline(this.glowLayer, points, passWidth, glowColor, passAlpha);
    }

    // --- ядро ---------------------------------------------------------
    this.strokePolyline(this.coreLayer, points, width, color, alpha);
    // Тонкий белый блик по центру придаёт нити объём.
    if (!strand.sleeping && tension > 0.15) {
      this.strokePolyline(
        this.coreLayer,
        points,
        Math.max(0.7, width * 0.35),
        0xffffff,
        clamp01(tension * 0.5) * birth,
      );
    }

    // --- капли росы ----------------------------------------------------
    if (this.showDew && !strand.playerCreated) {
      this.drawDew(strand, points, time);
    } else if (this.showDew && strand.playerCreated && strand.restLength > 140) {
      this.drawDew(strand, points, time);
    }

    // --- бегущий импульс ------------------------------------------------
    if (strand.pulseEnergy > 0.02 && pulseIndex < this.pulseSprites.length) {
      const position = this.sampleAlong(points, strand.pulsePosition);
      const sprite = this.pulseSprites[pulseIndex++]!;
      sprite.setVisible(true);
      sprite.setPosition(position.x, position.y);
      sprite.setTint(PALETTE.silkGlow);
      sprite.setAlpha(clamp01(strand.pulseEnergy) * 0.85);
      sprite.setScale(0.16 + strand.pulseEnergy * 0.12);
    }

    // --- узлы -----------------------------------------------------------
    const nodeA = this.web.graph.getNode(strand.nodeAId);
    const nodeB = this.web.graph.getNode(strand.nodeBId);
    for (const node of [nodeA, nodeB]) {
      if (!node) continue;
      this.dewLayer.fillStyle(mixColor(PALETTE.silk, PALETTE.silkGlow, 0.5), 0.35 * birth);
      this.dewLayer.fillCircle(node.position.x, node.position.y, width * 1.5);
    }

    return pulseIndex;
  }

  private drawDew(strand: WebStrand, points: Vector2[], time: number): void {
    let drops = this.dewCache.get(strand.id);
    if (!drops) {
      const random = createRandom(strand.id * 9176 + 13);
      const count = Math.max(0, Math.floor(strand.restLength / 130));
      drops = [];
      for (let i = 0; i < count; i++) {
        drops.push({ t: 0.15 + random() * 0.7, radius: 1.6 + random() * 1.8 });
      }
      this.dewCache.set(strand.id, drops);
    }

    for (const drop of drops) {
      // Капля медленно сползает по натянутой нити и подрагивает.
      const slide = (drop.t + Math.sin(time / 2600 + drop.t * 9) * 0.03) % 1;
      const position = this.sampleAlong(points, slide);
      const radius = drop.radius * (1 + strand.tensionNormalized * 0.3);
      this.dewLayer.fillStyle(PALETTE.dew, 0.42);
      this.dewLayer.fillCircle(position.x, position.y, radius * 1.9);
      this.dewLayer.fillStyle(0xffffff, 0.7);
      this.dewLayer.fillCircle(position.x - radius * 0.25, position.y - radius * 0.3, radius * 0.5);
    }
  }

  private drawSeveredRibbons(): void {
    for (const ribbon of this.web.severed) {
      const fade = 1 - ribbon.ageMs / ribbon.lifetimeMs;
      if (fade <= 0) continue;
      const points = ribbon.points.map((p) => ({ x: p.x, y: p.y }));
      this.strokePolyline(this.glowLayer, points, 5, PALETTE.silkGlow, 0.05 * fade);
      this.strokePolyline(this.coreLayer, points, 2, PALETTE.silk, 0.7 * fade);
    }
  }

  private collectPoints(strand: WebStrand): Vector2[] {
    const points: Vector2[] = [];
    for (const id of strand.particleIds) {
      const particle = this.web.graph.getParticle(id);
      if (particle) points.push({ x: particle.position.x, y: particle.position.y });
    }
    return points;
  }

  /**
   * Полилиния, сглаженная квадратичными кривыми по средним точкам.
   * Ломаная из частиц иначе видна изломами на провисающей нити.
   */
  private strokePolyline(
    g: Phaser.GameObjects.Graphics,
    points: Vector2[],
    width: number,
    color: number,
    alpha: number,
  ): void {
    if (alpha <= 0.004 || points.length < 2) return;
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.moveTo(points[0]!.x, points[0]!.y);

    if (points.length === 2) {
      g.lineTo(points[1]!.x, points[1]!.y);
    } else {
      for (let i = 1; i < points.length - 1; i++) {
        const current = points[i]!;
        const next = points[i + 1]!;
        const midX = (current.x + next.x) / 2;
        const midY = (current.y + next.y) / 2;
        // Phaser Graphics не имеет quadraticCurveTo, поэтому кривая
        // аппроксимируется тремя отрезками — на экране это неразличимо.
        const previous = points[i - 1]!;
        const startX = (previous.x + current.x) / 2;
        const startY = (previous.y + current.y) / 2;
        for (let s = 1; s <= 3; s++) {
          const t = s / 3;
          const inv = 1 - t;
          const x = inv * inv * startX + 2 * inv * t * current.x + t * t * midX;
          const y = inv * inv * startY + 2 * inv * t * current.y + t * t * midY;
          g.lineTo(x, y);
        }
      }
      g.lineTo(points[points.length - 1]!.x, points[points.length - 1]!.y);
    }

    g.strokePath();
  }

  private sampleAlong(points: Vector2[], t: number): Vector2 {
    const clamped = clamp01(t);
    const scaled = clamped * (points.length - 1);
    const index = Math.min(points.length - 2, Math.floor(scaled));
    const local = scaled - index;
    const a = points[index]!;
    const b = points[index + 1]!;
    return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
  }

  /** Убирает кеш капель для исчезнувших нитей. */
  pruneCache(): void {
    if (this.dewCache.size < 160) return;
    for (const id of [...this.dewCache.keys()]) {
      if (!this.web.graph.getStrand(id)) this.dewCache.delete(id);
    }
  }

  get sceneRef(): Phaser.Scene {
    return this.scene;
  }
}

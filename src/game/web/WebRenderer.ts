import { PALETTE, mixColor, tensionColor } from '../../app/Palette';
import { TENSION_STEPS } from '../../app/GameConfig';
import { clamp, clamp01, createRandom } from '../../core/math/Interpolation';
import type { Rect } from '../../core/math/Geometry';
import type { Vector2 } from '../../core/math/Vector2';
import type { Painter } from '../../engine/Painter';
import { textures } from '../../engine/TextureStore';
import { TEXTURES } from '../render/TextureFactory';
import type { WebSystem } from './WebSystem';
import type { WebStrand } from './WebTypes';

interface DewDrop {
  /** Позиция вдоль нити, 0..1. */
  t: number;
  radius: number;
}

/** Подготовленная к отрисовке нить: считается один раз, рисуется трижды. */
interface PreparedStrand {
  strand: WebStrand;
  points: Vector2[];
  count: number;
  width: number;
  color: number;
  alpha: number;
  glowColor: number;
  birth: number;
  tension: number;
}

const MAXIMUM_PULSES = 12;

/**
 * Отрисовка паутины.
 *
 * Нить рисуется в несколько проходов: широкий полупрозрачный ореол на
 * сложении, среднее ядро и яркий блик. Такой «ручной» блум дешевле
 * полноэкранного постэффекта и, в отличие от него, не размывает интерфейс и
 * фон, а светится только там, где нужно — паутина всегда остаётся читаемой
 * на тёмном фоне.
 *
 * Проходы идут по всем нитям сразу, а не по каждой нити отдельно: иначе ядро
 * одной нити перекрывало бы росу и свечение соседней в местах пересечений.
 * Чтобы за это не платить тройным пересчётом, геометрия и цвет готовятся
 * заранее в переиспользуемый пул — за кадр здесь не создаётся ни одного
 * временного объекта.
 */
export class WebRenderer {
  private readonly dewCache = new Map<number, DewDrop[]>();
  private readonly prepared: PreparedStrand[] = [];
  private preparedCount = 0;

  private glowPasses = 2;
  private showDew = true;
  private highContrast = false;

  constructor(private readonly web: WebSystem) {}

  setQuality(glowPasses: number, dew: boolean, highContrast: boolean): void {
    this.glowPasses = clamp(glowPasses, 1, 3);
    this.showDew = dew;
    this.highContrast = highContrast;
  }

  render(painter: Painter, time: number, view: Rect): void {
    this.prepare(time, view);

    painter.setBlendMode('add');
    for (let i = 0; i < this.preparedCount; i++) this.drawGlowPass(painter, this.prepared[i]!);
    this.drawSeveredPass(painter, true);

    painter.setBlendMode('normal');
    for (let i = 0; i < this.preparedCount; i++) this.drawCorePass(painter, this.prepared[i]!);
    this.drawSeveredPass(painter, false);

    painter.setBlendMode('add');
    for (let i = 0; i < this.preparedCount; i++) this.drawDewPass(painter, this.prepared[i]!, time);
    this.drawPulses(painter);
    painter.setBlendMode('normal');
  }

  // ------------------------------------------------------------ подготовка

  private prepare(time: number, view: Rect): void {
    this.preparedCount = 0;
    const right = view.x + view.width;
    const bottom = view.y + view.height;

    for (const strand of this.web.graph.allStrands) {
      const nodeA = this.web.graph.getNode(strand.nodeAId);
      const nodeB = this.web.graph.getNode(strand.nodeBId);
      if (!nodeA || !nodeB) continue;

      const minX = Math.min(nodeA.position.x, nodeB.position.x) - 40;
      const maxX = Math.max(nodeA.position.x, nodeB.position.x) + 40;
      const minY = Math.min(nodeA.position.y, nodeB.position.y) - 40;
      const maxY = Math.max(nodeA.position.y, nodeB.position.y) + 40;
      if (maxX < view.x || minX > right || maxY < view.y || minY > bottom) continue;

      const entry = this.acquire();
      if (!this.fill(entry, strand, time)) continue;
      this.preparedCount++;
    }
  }

  private acquire(): PreparedStrand {
    let entry = this.prepared[this.preparedCount];
    if (!entry) {
      entry = {
        strand: null as unknown as WebStrand,
        points: [],
        count: 0,
        width: 2,
        color: PALETTE.silk,
        alpha: 1,
        glowColor: PALETTE.silkGlow,
        birth: 1,
        tension: 0,
      };
      this.prepared.push(entry);
    }
    return entry;
  }

  private fill(entry: PreparedStrand, strand: WebStrand, time: number): boolean {
    let count = 0;
    for (const id of strand.particleIds) {
      const particle = this.web.graph.getParticle(id);
      if (!particle) continue;
      let point = entry.points[count];
      if (!point) {
        point = { x: 0, y: 0 };
        entry.points.push(point);
      }
      point.x = particle.position.x;
      point.y = particle.position.y;
      count++;
    }
    if (count < 2) return false;

    entry.strand = strand;
    entry.count = count;

    const tension = strand.tensionNormalized;
    entry.tension = tension;
    // Появление нити: за первые 120 мс она «дорастает» до полной яркости.
    entry.birth = clamp01(strand.ageMs / 120);

    // Толщина растёт с натяжением (раздел 24.2 ТЗ).
    const baseWidth = strand.playerCreated ? 2.5 : 2.1;
    entry.width = (baseWidth + tension * 1.5) * (this.highContrast ? 1.5 : 1);

    let color = tensionColor(tension);
    let alpha = (strand.sleeping ? 0.62 : 0.85) * entry.birth;

    if (tension >= TENSION_STEPS.pulsing) {
      // Дрожание перед разрывом: частота и амплитуда растут вместе с
      // накопленной перегрузкой.
      const shakeEnergy = clamp01((tension - TENSION_STEPS.pulsing) / 0.05);
      const flicker = 0.5 + 0.5 * Math.sin(time / 26);
      color = mixColor(color, PALETTE.silkCritical, flicker * shakeEnergy);
      alpha = Math.min(1, alpha + 0.15 * flicker);
      const amplitude = 1.2 + shakeEnergy * 2.4;
      for (let i = 1; i < count - 1; i++) {
        const point = entry.points[i]!;
        point.x += Math.sin(time / 22 + i * 1.7) * amplitude;
        point.y += Math.cos(time / 19 + i * 2.1) * amplitude;
      }
    } else if (tension > TENSION_STEPS.bright) {
      const pulse = 0.5 + 0.5 * Math.sin(time / 90);
      alpha = Math.min(1, alpha + pulse * 0.12);
    }

    entry.color = color;
    entry.alpha = alpha;
    entry.glowColor = this.highContrast
      ? PALETTE.silk
      : mixColor(color, PALETTE.silkGlow, 0.5);
    return true;
  }

  // -------------------------------------------------------------- проходы

  private drawGlowPass(painter: Painter, entry: PreparedStrand): void {
    for (let pass = this.glowPasses; pass >= 1; pass--) {
      const passWidth = entry.width * (1 + pass * 1.9);
      const passAlpha =
        (0.055 / pass) * (0.5 + entry.tension * 0.9) * entry.birth + 0.018 * entry.birth;
      this.strokeStrand(painter, entry, passWidth, entry.glowColor, passAlpha);
    }
  }

  private drawCorePass(painter: Painter, entry: PreparedStrand): void {
    this.strokeStrand(painter, entry, entry.width, entry.color, entry.alpha);
    // Тонкий белый блик по центру придаёт нити объём.
    if (!entry.strand.sleeping && entry.tension > 0.15) {
      this.strokeStrand(
        painter,
        entry,
        Math.max(0.7, entry.width * 0.35),
        0xffffff,
        clamp01(entry.tension * 0.5) * entry.birth,
      );
    }
  }

  private drawDewPass(painter: Painter, entry: PreparedStrand, time: number): void {
    const strand = entry.strand;

    // Узелки на концах нити.
    const nodeA = this.web.graph.getNode(strand.nodeAId);
    const nodeB = this.web.graph.getNode(strand.nodeBId);
    painter.fillStyle(mixColor(PALETTE.silk, PALETTE.silkGlow, 0.5), 0.35 * entry.birth);
    if (nodeA) painter.fillCircle(nodeA.position.x, nodeA.position.y, entry.width * 1.5);
    if (nodeB) painter.fillCircle(nodeB.position.x, nodeB.position.y, entry.width * 1.5);

    if (!this.showDew) return;
    if (strand.playerCreated && strand.restLength <= 140) return;

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
      const position = this.sampleAlong(entry, slide);
      const radius = drop.radius * (1 + entry.tension * 0.3);
      painter.fillStyle(PALETTE.dew, 0.42);
      painter.fillCircle(position.x, position.y, radius * 1.9);
      painter.fillStyle(0xffffff, 0.7);
      painter.fillCircle(position.x - radius * 0.25, position.y - radius * 0.3, radius * 0.5);
    }
  }

  private drawPulses(painter: Painter): void {
    const glow = textures.tint(TEXTURES.glow, PALETTE.silkGlow);
    let drawn = 0;
    for (let i = 0; i < this.preparedCount && drawn < MAXIMUM_PULSES; i++) {
      const entry = this.prepared[i]!;
      if (entry.strand.pulseEnergy <= 0.02) continue;
      const position = this.sampleAlong(entry, entry.strand.pulsePosition);
      const size = glow.width * (0.16 + entry.strand.pulseEnergy * 0.12);
      painter.drawTexture(
        glow.canvas,
        position.x,
        position.y,
        size,
        size,
        0,
        clamp01(entry.strand.pulseEnergy) * 0.85,
      );
      drawn++;
    }
  }

  private drawSeveredPass(painter: Painter, glowPass: boolean): void {
    for (const ribbon of this.web.severed) {
      const fade = 1 - ribbon.ageMs / ribbon.lifetimeMs;
      if (fade <= 0) continue;
      const alpha = glowPass ? 0.05 * fade : 0.7 * fade;
      if (alpha <= 0.004 || ribbon.points.length < 2) continue;

      painter.lineStyle(
        glowPass ? 5 : 2,
        glowPass ? PALETTE.silkGlow : PALETTE.silk,
        alpha,
      );
      painter.beginPath();
      painter.moveTo(ribbon.points[0]!.x, ribbon.points[0]!.y);
      for (let i = 1; i < ribbon.points.length; i++) {
        painter.lineTo(ribbon.points[i]!.x, ribbon.points[i]!.y);
      }
      painter.strokePath();
    }
  }

  /**
   * Нить как сглаженная кривая. Ломаная из частиц иначе видна изломами на
   * провисающем участке; квадратичные кривые по средним точкам убирают их
   * одной командой холста.
   */
  private strokeStrand(
    painter: Painter,
    entry: PreparedStrand,
    width: number,
    color: number,
    alpha: number,
  ): void {
    if (alpha <= 0.004) return;
    const points = entry.points;
    const count = entry.count;

    painter.lineStyle(width, color, alpha);
    painter.beginPath();
    painter.moveTo(points[0]!.x, points[0]!.y);

    if (count === 2) {
      painter.lineTo(points[1]!.x, points[1]!.y);
    } else {
      for (let i = 1; i < count - 1; i++) {
        const current = points[i]!;
        const next = points[i + 1]!;
        painter.quadraticCurveTo(
          current.x,
          current.y,
          (current.x + next.x) / 2,
          (current.y + next.y) / 2,
        );
      }
      painter.lineTo(points[count - 1]!.x, points[count - 1]!.y);
    }

    painter.strokePath();
  }

  private sampleAlong(entry: PreparedStrand, t: number): Vector2 {
    const clamped = clamp01(t);
    const scaled = clamped * (entry.count - 1);
    const index = Math.min(entry.count - 2, Math.floor(scaled));
    const local = scaled - index;
    const a = entry.points[index]!;
    const b = entry.points[index + 1]!;
    return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
  }

  /** Убирает кеш капель для исчезнувших нитей. */
  pruneCache(): void {
    if (this.dewCache.size < 160) return;
    for (const id of [...this.dewCache.keys()]) {
      if (!this.web.graph.getStrand(id)) this.dewCache.delete(id);
    }
  }
}

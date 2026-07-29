import { PALETTE } from '../../app/Palette';
import type { Painter } from '../../engine/Painter';
import { clamp01 } from '../../core/math/Interpolation';
import type { Vector2 } from '../../core/math/Vector2';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: number;
  gravity: number;
  drag: number;
  additive: boolean;
  spin: number;
  angle: number;
  shape: 'dot' | 'shard' | 'streak';
}

/**
 * Пулированные частицы для игровых эффектов.
 *
 * Свой лёгкий пул выбран ради двух вещей: игровые частицы имеют приоритет над
 * декоративными и не должны вытесняться ими при достижении лимита, и каждый
 * всплеск нужно уметь описать одной строкой в месте события, а не заранее
 * собранной конфигурацией.
 *
 * Симуляция и отрисовка разделены: первая идёт с шагом кадра, вторая — в тот
 * момент кадра, когда до слоя частиц доходит очередь.
 */
export class ParticleField {
  private readonly pool: Particle[] = [];
  private readonly active: Particle[] = [];
  private budget = 600;

  setBudget(budget: number): void {
    this.budget = Math.max(40, budget);
  }

  get count(): number {
    return this.active.length;
  }

  private spawn(particle: Omit<Particle, 'life'> & { life?: number }): void {
    if (this.active.length >= this.budget) {
      // Самая старая частица уступает место новой: свежие события важнее.
      const oldest = this.active.shift();
      if (oldest) this.pool.push(oldest);
    }
    const item = this.pool.pop() ?? ({} as Particle);
    Object.assign(item, particle);
    item.life = particle.maxLife;
    this.active.push(item);
  }

  /** Пыль из-под ног при приземлении. */
  burstLanding(position: Vector2, normal: Vector2, strength: number): void {
    const count = Math.round(4 + strength * 12);
    const tangent = { x: -normal.y, y: normal.x };
    for (let i = 0; i < count; i++) {
      const side = Math.random() > 0.5 ? 1 : -1;
      const speed = 40 + Math.random() * 190 * strength;
      this.spawn({
        x: position.x + tangent.x * side * Math.random() * 12,
        y: position.y + tangent.y * side * Math.random() * 12,
        vx: tangent.x * side * speed + normal.x * speed * 0.5,
        vy: tangent.y * side * speed + normal.y * speed * 0.5,
        maxLife: 0.32 + Math.random() * 0.4,
        size: 1.6 + Math.random() * 2.6,
        color: PALETTE.stoneEdge,
        gravity: 700,
        drag: 2.6,
        additive: false,
        spin: 0,
        angle: 0,
        shape: 'dot',
      });
    }
  }

  /**
   * Пылинка из-под лапы на ходу.
   *
   * Одна-две частицы на шаг, а не всплеск: постоянное движение должно
   * оставлять след, но не превращаться в дымовую завесу под ногами.
   */
  puffStep(position: Vector2, normal: Vector2, speed: number): void {
    const count = speed > 200 ? 2 : 1;
    const tangent = { x: -normal.y, y: normal.x };
    for (let i = 0; i < count; i++) {
      const side = Math.random() > 0.5 ? 1 : -1;
      this.spawn({
        x: position.x + tangent.x * side * (4 + Math.random() * 10) + normal.x * 12,
        y: position.y + tangent.y * side * (4 + Math.random() * 10) + normal.y * 12,
        vx: -tangent.x * side * (10 + Math.random() * 40) + normal.x * 30,
        vy: -tangent.y * side * (10 + Math.random() * 40) + normal.y * 30,
        maxLife: 0.26 + Math.random() * 0.3,
        size: 1 + Math.random() * 1.8,
        color: PALETTE.stoneEdge,
        gravity: 260,
        drag: 3.4,
        additive: false,
        spin: 0,
        angle: 0,
        shape: 'dot',
      });
    }
  }

  /** Всплеск шёлка при разрыве нити. */
  burstSilk(position: Vector2, strength = 1): void {
    const count = Math.round(10 + strength * 14);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 260 * strength;
      this.spawn({
        x: position.x,
        y: position.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        maxLife: 0.4 + Math.random() * 0.5,
        size: 1 + Math.random() * 2.2,
        color: Math.random() > 0.35 ? PALETTE.silk : PALETTE.silkGlow,
        gravity: 320,
        drag: 2.2,
        additive: true,
        spin: (Math.random() - 0.5) * 12,
        angle,
        shape: Math.random() > 0.5 ? 'streak' : 'dot',
      });
    }
  }

  /** Короткая вспышка на точке крепления. */
  burstAttach(position: Vector2): void {
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 130;
      this.spawn({
        x: position.x,
        y: position.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        maxLife: 0.22 + Math.random() * 0.24,
        size: 1.2 + Math.random() * 1.8,
        color: PALETTE.silkGlow,
        gravity: 60,
        drag: 5,
        additive: true,
        spin: 0,
        angle,
        shape: 'dot',
      });
    }
  }

  /** Пыль при ударе тяжёлого предмета. */
  burstImpact(position: Vector2, strength: number): void {
    const count = Math.round(5 + strength * 10);
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      const speed = 50 + Math.random() * 200 * strength;
      this.spawn({
        x: position.x + (Math.random() - 0.5) * 30,
        y: position.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.5,
        maxLife: 0.4 + Math.random() * 0.5,
        size: 2 + Math.random() * 3.4,
        color: PALETTE.stoneBase,
        gravity: 520,
        drag: 2.8,
        additive: false,
        spin: 0,
        angle: 0,
        shape: 'dot',
      });
    }
  }

  /** След прыжка — короткий веер по нормали. */
  burstJump(position: Vector2, normal: Vector2): void {
    for (let i = 0; i < 8; i++) {
      const spread = (Math.random() - 0.5) * 1.4;
      const dirX = normal.x * Math.cos(spread) - normal.y * Math.sin(spread);
      const dirY = normal.x * Math.sin(spread) + normal.y * Math.cos(spread);
      const speed = 60 + Math.random() * 140;
      this.spawn({
        x: position.x,
        y: position.y,
        vx: -dirX * speed,
        vy: -dirY * speed,
        maxLife: 0.24 + Math.random() * 0.22,
        size: 1.4 + Math.random() * 2,
        color: PALETTE.stoneEdge,
        gravity: 480,
        drag: 3.4,
        additive: false,
        spin: 0,
        angle: 0,
        shape: 'dot',
      });
    }
  }

  /** Мягкие искры на успехе — открытие двери, финиш. */
  burstSparkle(position: Vector2, color: number = PALETTE.exitGlow, count = 20): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 30 + Math.random() * 120;
      this.spawn({
        x: position.x,
        y: position.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        maxLife: 0.7 + Math.random() * 0.8,
        size: 1.4 + Math.random() * 2.2,
        color,
        gravity: -30,
        drag: 1.4,
        additive: true,
        spin: 0,
        angle,
        shape: 'dot',
      });
    }
  }

  update(deltaSeconds: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i]!;
      p.life -= deltaSeconds;
      if (p.life <= 0) {
        this.active.splice(i, 1);
        this.pool.push(p);
        continue;
      }

      const drag = Math.exp(-p.drag * deltaSeconds);
      p.vx *= drag;
      p.vy = p.vy * drag + p.gravity * deltaSeconds;
      p.x += p.vx * deltaSeconds;
      p.y += p.vy * deltaSeconds;
      p.angle += p.spin * deltaSeconds;
    }
  }

  /**
   * Два прохода по списку: сначала обычные частицы, затем светящиеся. Так
   * свечение всегда ложится поверх пыли, независимо от порядка рождения.
   */
  draw(painter: Painter): void {
    this.drawPass(painter, false);
    painter.setBlendMode('add');
    this.drawPass(painter, true);
    painter.setBlendMode('normal');
  }

  private drawPass(painter: Painter, additive: boolean): void {
    for (const p of this.active) {
      if (p.additive !== additive) continue;

      const t = clamp01(p.life / p.maxLife);
      const alpha = t * t;

      if (p.shape === 'streak') {
        const speed = Math.hypot(p.vx, p.vy);
        const len = Math.min(16, speed * 0.035);
        const dx = speed > 1 ? (p.vx / speed) * len : 0;
        const dy = speed > 1 ? (p.vy / speed) * len : 0;
        painter.lineStyle(p.size * t, p.color, alpha);
        painter.beginPath();
        painter.moveTo(p.x - dx, p.y - dy);
        painter.lineTo(p.x + dx, p.y + dy);
        painter.strokePath();
      } else {
        painter.fillStyle(p.color, alpha);
        painter.fillCircle(p.x, p.y, p.size * (0.4 + t * 0.6));
      }
    }
  }

  clear(): void {
    for (const particle of this.active) this.pool.push(particle);
    this.active.length = 0;
  }
}

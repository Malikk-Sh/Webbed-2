import { PALETTE, mixColor, shade } from '../../app/Palette';
import { clamp01, easeOutCubic } from '../../core/math/Interpolation';
import type { Painter } from '../../engine/Painter';
import { textures } from '../../engine/TextureStore';
import type { LoadedLevel } from '../level/PrototypeLevelLoader';
import { TEXTURES } from './TextureFactory';

/**
 * Отрисовка динамических объектов: ящик, груз, кнопка, дверь и выход.
 * Всё рисуется каждый кадр, потому что тела действительно движутся и
 * поворачиваются — но объектов единицы, и это дешевле, чем кажется.
 */
export class ObjectRenderer {
  constructor(private readonly level: LoadedLevel) {}

  private exitTrigger(): { x: number; y: number } {
    const trigger = this.level.definition.triggers.find(
      (t) => t.action === 'complete-prototype',
    );
    if (!trigger) return { x: 0, y: 0 };
    return { x: trigger.x + trigger.width / 2, y: trigger.y + trigger.height * 0.72 };
  }

  /**
   * Порядок повторяет прежнюю раскладку по глубине: ореол выхода лежит под
   * объектами, затем идут сами объекты, затем их свечение.
   */
  draw(painter: Painter, time: number): void {
    const exit = this.exitTrigger();
    const pulse = 0.5 + 0.5 * Math.sin(time / 900);
    const halo = textures.tint(TEXTURES.glowSoft, PALETTE.exitGlow);
    const haloSize = halo.width * (1.3 + pulse * 0.18);

    painter.setBlendMode('add');
    painter.drawTexture(halo.canvas, exit.x, exit.y, haloSize, haloSize, 0, 0.22 + pulse * 0.14);
    painter.setBlendMode('normal');

    this.drawCrates(painter);
    this.drawWeights(painter);
    this.drawPlates(painter, time);
    this.drawDoors(painter);
    this.drawBlooms(painter, time);
    this.drawSprout(painter, exit, time, pulse);

    painter.setBlendMode('add');
    this.drawWeightGlow(painter);
    this.drawPlateGlow(painter, time);
    this.drawDoorGlow(painter);
    this.drawBloomGlow(painter, time);
    painter.fillStyle(PALETTE.exitGlow, 0.3);
    painter.fillCircle(exit.x + Math.sin(time / 1400) * 6, exit.y - 46, 22 + pulse * 8);
    painter.setBlendMode('normal');
  }

  private drawCrates(g: Painter): void {
    for (const crate of this.level.crates) {
      const { position, angle } = crate.body;
      const hw = crate.width / 2;
      const hh = crate.height / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const corner = (x: number, y: number) => ({
        x: position.x + x * cos - y * sin,
        y: position.y + x * sin + y * cos,
      });

      const c0 = corner(-hw, -hh);
      const c1 = corner(hw, -hh);
      const c2 = corner(hw, hh);
      const c3 = corner(-hw, hh);

      g.fillStyle(PALETTE.crate, 1);
      g.beginPath();
      g.moveTo(c0.x, c0.y);
      g.lineTo(c1.x, c1.y);
      g.lineTo(c2.x, c2.y);
      g.lineTo(c3.x, c3.y);
      g.closePath();
      g.fillPath();

      // Освещённая верхняя грань.
      const inner0 = corner(-hw + 7, -hh + 7);
      const inner1 = corner(hw - 7, -hh + 7);
      g.fillStyle(PALETTE.crateLight, 1);
      g.beginPath();
      g.moveTo(c0.x, c0.y);
      g.lineTo(c1.x, c1.y);
      g.lineTo(inner1.x, inner1.y);
      g.lineTo(inner0.x, inner0.y);
      g.closePath();
      g.fillPath();

      // Доски и обвязка.
      g.lineStyle(2.2, PALETTE.crateEdge, 0.7);
      g.beginPath();
      g.moveTo(c0.x, c0.y);
      g.lineTo(c1.x, c1.y);
      g.lineTo(c2.x, c2.y);
      g.lineTo(c3.x, c3.y);
      g.closePath();
      g.strokePath();

      g.lineStyle(1.8, shade(PALETTE.crate, -0.3), 0.75);
      for (const t of [0.33, 0.66]) {
        const a = corner(-hw, -hh + crate.height * t);
        const b = corner(hw, -hh + crate.height * t);
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.strokePath();
      }
      const d0 = corner(-hw, -hh);
      const d1 = corner(hw, hh);
      g.lineStyle(1.6, shade(PALETTE.crate, -0.2), 0.5);
      g.beginPath();
      g.moveTo(d0.x, d0.y);
      g.lineTo(d1.x, d1.y);
      g.strokePath();
    }
  }

  private drawWeights(g: Painter): void {
    for (const weight of this.level.weights) {
      const { position, angle } = weight.body;
      const r = weight.radius;

      g.fillStyle(shade(PALETTE.weight, -0.25), 1);
      g.fillCircle(position.x, position.y, r);
      g.fillStyle(PALETTE.weight, 1);
      g.fillCircle(position.x - r * 0.12, position.y - r * 0.14, r * 0.86);
      g.fillStyle(PALETTE.weightLight, 0.75);
      g.fillCircle(position.x - r * 0.3, position.y - r * 0.34, r * 0.4);

      // Кольцо-подвес поворачивается вместе с грузом.
      const ringX = position.x + Math.sin(angle) * 0 - Math.sin(angle) * 0;
      g.lineStyle(3.4, PALETTE.metalEdge, 0.9);
      g.strokeCircle(ringX, position.y - r - 5, 7);

      g.lineStyle(2, shade(PALETTE.weightLight, 0.2), 0.5);
      g.beginPath();
      g.arc(position.x, position.y, r * 0.7, angle + 0.6, angle + 2.2);
      g.strokePath();

    }
  }

  private drawWeightGlow(painter: Painter): void {
    for (const weight of this.level.weights) {
      painter.fillStyle(PALETTE.metalEdge, 0.05);
      painter.fillCircle(weight.body.position.x, weight.body.position.y, weight.radius * 1.5);
    }
  }

  private drawPlates(g: Painter, time: number): void {
    for (const plate of this.level.plates) {
      const halfWidth = plate.width / 2;
      const sink = plate.depression * 9;
      const top = plate.surfaceY - 18 + sink;
      const color = plate.active
        ? PALETTE.plateOn
        : mixColor(PALETTE.plateOff, PALETTE.plateOn, plate.depression * 0.5);

      // Утопленный корпус в полу.
      g.fillStyle(shade(PALETTE.plateOff, -0.62), 1);
      g.fillRect(plate.x - halfWidth - 9, plate.surfaceY - 24, plate.width + 18, 26);
      g.lineStyle(1.6, shade(PALETTE.plateOff, 0.25), 0.5);
      g.strokeRect(plate.x - halfWidth - 9, plate.surfaceY - 24, plate.width + 18, 26);

      // Подвижная площадка.
      g.fillStyle(shade(color, -0.35), 1);
      g.fillRect(plate.x - halfWidth, top, plate.width, 15);
      g.fillStyle(color, 1);
      g.fillRect(plate.x - halfWidth, top, plate.width, 7);
      g.lineStyle(2, shade(color, 0.35), 0.95);
      g.strokeRect(plate.x - halfWidth, top, plate.width, 15);

      // Индикатор набранной массы.
      const fill = clamp01(plate.currentMass / Math.max(plate.activationMass, 0.001));
      if (fill > 0.01) {
        g.fillStyle(plate.active ? PALETTE.plateOn : PALETTE.uiWarn, 0.95);
        g.fillRect(plate.x - halfWidth + 6, top - 6, (plate.width - 12) * fill, 3.5);
      }

      // «Сюда» — три шеврона над неактивной кнопкой. Именно они превращают
      // тёмную полосу в понятный призыв поставить сюда груз.
      if (!plate.active) {
        const bob = Math.sin(time / 520) * 3;
        g.lineStyle(2.4, PALETTE.uiWarn, 0.28 + 0.16 * Math.sin(time / 520));
        for (let i = 0; i < 3; i++) {
          const y = top - 22 - i * 11 + bob;
          g.beginPath();
          g.moveTo(plate.x - 13, y);
          g.lineTo(plate.x, y + 8);
          g.lineTo(plate.x + 13, y);
          g.strokePath();
        }
      }

    }
  }

  private drawPlateGlow(painter: Painter, time: number): void {
    for (const plate of this.level.plates) {
      const sink = plate.depression * 9;
      const top = plate.surfaceY - 18 + sink;
      const color = plate.active
        ? PALETTE.plateOn
        : mixColor(PALETTE.plateOff, PALETTE.plateOn, plate.depression * 0.5);
      const pulse = plate.active
        ? 0.45 + 0.22 * Math.sin(time / 260)
        : 0.16 + plate.depression * 0.3;
      painter.fillStyle(color, pulse * 0.55);
      painter.fillEllipse(plate.x, top + 4, plate.width * 1.7, 52);
    }
  }

  private drawDoors(g: Painter): void {
    for (const door of this.level.doors) {
      const offset = door.visualOffset;

      // Проём и направляющие остаются на месте.
      g.fillStyle(shade(PALETTE.doorFrame, -0.5), 1);
      g.fillRect(door.x - 8, door.y - 10, door.width + 16, door.height + 14);
      g.lineStyle(2.4, PALETTE.metalEdge, 0.6);
      g.strokeRect(door.x - 8, door.y - 10, door.width + 16, door.height + 14);

      // Панель уезжает вверх.
      const panelY = door.y - offset;
      g.fillStyle(PALETTE.doorPanel, 1);
      g.fillRect(door.x, panelY, door.width, door.height);
      g.fillStyle(shade(PALETTE.doorPanel, 0.18), 1);
      g.fillRect(door.x, panelY, door.width * 0.4, door.height);

      g.lineStyle(2, PALETTE.crateEdge, 0.75);
      g.strokeRect(door.x, panelY, door.width, door.height);
      for (let i = 1; i < 5; i++) {
        const y = panelY + (door.height / 5) * i;
        g.lineStyle(1.5, shade(PALETTE.doorPanel, -0.35), 0.7);
        g.beginPath();
        g.moveTo(door.x + 4, y);
        g.lineTo(door.x + door.width - 4, y);
        g.strokePath();
      }

    }
  }

  /** Световая щель под приоткрытой дверью. */
  private drawDoorGlow(painter: Painter): void {
    for (const door of this.level.doors) {
      if (door.openness <= 0.02) continue;
      const gap = easeOutCubic(door.openness) * door.height;
      painter.fillStyle(PALETTE.exitGlow, 0.28 * door.openness);
      painter.fillRect(door.x, door.y + door.height - gap, door.width, gap);
    }
  }

  /**
   * Шёлковые бутоны.
   *
   * Закрытый бутон покачивается на месте; при сборе лепестки распахиваются и
   * он растворяется. Раскрытие и угасание идут одной величиной `bloom`,
   * поэтому вспышка всегда попадает в момент исчезновения.
   */
  private drawBlooms(g: Painter, time: number): void {
    for (const bloom of this.level.blooms) {
      if (bloom.collected && bloom.bloom >= 1) continue;
      const open = easeOutCubic(bloom.bloom);
      const alpha = 1 - bloom.bloom;
      const y = bloom.y + Math.sin(time / 900 + bloom.phase) * 4;
      const petals = 5;
      const length = 15 + open * 20;

      for (let i = 0; i < petals; i++) {
        // Закрытый бутон — узкий пучок вверх; раскрытый расходится по кругу.
        const spread = (i / petals - 0.5) * (0.9 + open * 5.4);
        const angle = -Math.PI / 2 + spread;
        const tipX = bloom.x + Math.cos(angle) * length;
        const tipY = y + Math.sin(angle) * length;
        const half = (5 + open * 4) * (1 - open * 0.35);

        g.fillStyle(mixColor(PALETTE.silk, PALETTE.anchorIdle, i / petals), 0.85 * alpha);
        g.beginPath();
        g.moveTo(bloom.x, y + 6);
        g.lineTo(bloom.x + Math.cos(angle - 1.2) * half, y + Math.sin(angle - 1.2) * half);
        g.lineTo(tipX, tipY);
        g.lineTo(bloom.x + Math.cos(angle + 1.2) * half, y + Math.sin(angle + 1.2) * half);
        g.closePath();
        g.fillPath();
      }

      g.fillStyle(PALETTE.silkTense, 0.9 * alpha);
      g.fillCircle(bloom.x, y, 5 - open * 2);

      // Ножка: бутон растёт из воздуха на короткой нити.
      g.lineStyle(1.6, PALETTE.silkSlack, 0.5 * alpha);
      g.beginPath();
      g.moveTo(bloom.x, y + 6);
      g.lineTo(bloom.x, y + 22);
      g.strokePath();
    }
  }

  private drawBloomGlow(painter: Painter, time: number): void {
    for (const bloom of this.level.blooms) {
      if (bloom.collected && bloom.bloom >= 1) continue;
      const pulse = 0.5 + 0.5 * Math.sin(time / 700 + bloom.phase);
      const flash = easeOutCubic(bloom.bloom);
      const alpha = (0.16 + pulse * 0.12) * (1 - bloom.bloom) + flash * (1 - flash) * 1.4;
      painter.fillStyle(PALETTE.anchorIdle, alpha);
      painter.fillCircle(bloom.x, bloom.y, 26 + pulse * 5 + flash * 60);
    }
  }

  /** Росток-выход: маленький светящийся побег, ради которого всё затевалось. */
  private drawSprout(
    g: Painter,
    exit: { x: number; y: number },
    time: number,
    pulse: number,
  ): void {
    g.lineStyle(3.4, PALETTE.moss, 0.95);
    g.beginPath();
    g.moveTo(exit.x, exit.y);
    g.lineTo(exit.x + Math.sin(time / 1400) * 6, exit.y - 40);
    g.strokePath();

    for (const side of [-1, 1]) {
      g.fillStyle(PALETTE.mossLight, 0.9);
      g.fillEllipse(exit.x + side * 13, exit.y - 26 + side * 4, 24, 12);
    }

    g.fillStyle(PALETTE.exitGlow, 0.95);
    g.fillCircle(exit.x + Math.sin(time / 1400) * 6, exit.y - 46, 7 + pulse * 1.6);
  }
}

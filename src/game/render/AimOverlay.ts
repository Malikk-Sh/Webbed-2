import Phaser from 'phaser';
import { webConfig } from '../../app/GameConfig';
import { PALETTE } from '../../app/Palette';
import { clamp01 } from '../../core/math/Interpolation';
import type { Vector2 } from '../../core/math/Vector2';
import type { AimPreview } from '../spider/SpiderWebController';

/**
 * Мировая индикация прицеливания.
 *
 * Цветовой код взят из раздела 22.4 ТЗ: зелёная точка — крепление возможно,
 * жёлтая — цель найдена помощью прицеливания, красная — недоступно.
 * Пунктирная линия показывает будущую нить, круг — предел дальности.
 */
export class AimOverlay {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly glow: Phaser.GameObjects.Graphics;
  private appear = 0;

  constructor(scene: Phaser.Scene, depth: number) {
    this.graphics = scene.add.graphics().setDepth(depth);
    this.glow = scene.add
      .graphics()
      .setDepth(depth + 1)
      .setBlendMode(Phaser.BlendModes.ADD);
  }

  destroy(): void {
    this.graphics.destroy();
    this.glow.destroy();
  }

  render(preview: AimPreview, aiming: boolean, time: number, origin: Vector2): void {
    const g = this.graphics;
    const glow = this.glow;
    g.clear();
    glow.clear();

    this.appear += ((aiming && preview.active ? 1 : 0) - this.appear) * 0.22;
    if (this.appear < 0.02) return;

    const alpha = clamp01(this.appear);
    const from = origin;

    // Круг максимальной дальности — «докуда я вообще дотянусь».
    glow.lineStyle(1.4, PALETTE.uiAccent, 0.1 * alpha);
    glow.strokeCircle(preview.origin.x, preview.origin.y, webConfig.maximumShotDistance * alpha);

    const color = !preview.valid
      ? PALETTE.uiDanger
      : preview.assisted
        ? PALETTE.uiWarn
        : PALETTE.ok;

    const to = preview.target ?? {
      x: preview.origin.x + preview.direction.x * webConfig.maximumShotDistance,
      y: preview.origin.y + preview.direction.y * webConfig.maximumShotDistance,
    };

    // Пунктир будущей нити: бегущие штрихи подсказывают направление выпуска.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const nx = distance > 0 ? dx / distance : 0;
    const ny = distance > 0 ? dy / distance : 0;
    const dash = 14;
    const gap = 11;
    const offset = (time / 26) % (dash + gap);

    g.lineStyle(2, color, 0.75 * alpha);
    for (let d = -offset; d < distance; d += dash + gap) {
      const start = Math.max(0, d);
      const end = Math.min(distance, d + dash);
      if (end <= start) continue;
      g.beginPath();
      g.moveTo(from.x + nx * start, from.y + ny * start);
      g.lineTo(from.x + nx * end, from.y + ny * end);
      g.strokePath();
    }

    if (!preview.valid || !preview.target) {
      // Перечёркнутая метка на конце луча — крепление невозможно.
      const size = 9;
      g.lineStyle(2.4, PALETTE.uiDanger, 0.9 * alpha);
      g.beginPath();
      g.moveTo(to.x - size, to.y - size);
      g.lineTo(to.x + size, to.y + size);
      g.moveTo(to.x + size, to.y - size);
      g.lineTo(to.x - size, to.y + size);
      g.strokePath();
      return;
    }

    // Прицельная метка: пульсирующее кольцо и лепестки по сторонам.
    const pulse = 0.5 + 0.5 * Math.sin(time / 220);
    const radius = 11 + pulse * 3;

    glow.fillStyle(color, 0.22 * alpha);
    glow.fillCircle(to.x, to.y, radius * 2.1);

    g.lineStyle(2.2, color, 0.95 * alpha);
    g.strokeCircle(to.x, to.y, radius);
    g.fillStyle(color, 0.85 * alpha);
    g.fillCircle(to.x, to.y, 3);

    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + time / 1600;
      const inner = radius + 4;
      const outer = radius + 9 + pulse * 2;
      g.lineStyle(2, color, 0.7 * alpha);
      g.beginPath();
      g.moveTo(to.x + Math.cos(angle) * inner, to.y + Math.sin(angle) * inner);
      g.lineTo(to.x + Math.cos(angle) * outer, to.y + Math.sin(angle) * outer);
      g.strokePath();
    }

    // Длина будущей нити — тонкая засечка на середине луча.
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    g.lineStyle(1.6, color, 0.4 * alpha);
    g.beginPath();
    g.moveTo(midX - ny * 5, midY + nx * 5);
    g.lineTo(midX + ny * 5, midY - nx * 5);
    g.strokePath();
  }
}

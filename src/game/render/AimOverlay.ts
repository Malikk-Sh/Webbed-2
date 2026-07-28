import { webConfig } from '../../app/GameConfig';
import { PALETTE } from '../../app/Palette';
import { clamp01 } from '../../core/math/Interpolation';
import type { Painter } from '../../engine/Painter';
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
  private appear = 0;

  render(
    painter: Painter,
    preview: AimPreview,
    aiming: boolean,
    time: number,
    origin: Vector2,
  ): void {
    this.appear += ((aiming && preview.active ? 1 : 0) - this.appear) * 0.22;
    if (this.appear < 0.02) return;

    const alpha = clamp01(this.appear);
    const from = origin;

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

    painter.lineStyle(2, color, 0.75 * alpha);
    for (let d = -offset; d < distance; d += dash + gap) {
      const start = Math.max(0, d);
      const end = Math.min(distance, d + dash);
      if (end <= start) continue;
      painter.beginPath();
      painter.moveTo(from.x + nx * start, from.y + ny * start);
      painter.lineTo(from.x + nx * end, from.y + ny * end);
      painter.strokePath();
    }

    if (!preview.valid || !preview.target) {
      // Перечёркнутая метка на конце луча — крепление невозможно.
      const size = 9;
      painter.lineStyle(2.4, PALETTE.uiDanger, 0.9 * alpha);
      painter.beginPath();
      painter.moveTo(to.x - size, to.y - size);
      painter.lineTo(to.x + size, to.y + size);
      painter.moveTo(to.x + size, to.y - size);
      painter.lineTo(to.x - size, to.y + size);
      painter.strokePath();
      return;
    }

    // Прицельная метка: пульсирующее кольцо и лепестки по сторонам.
    const pulse = 0.5 + 0.5 * Math.sin(time / 220);
    const radius = 11 + pulse * 3;

    painter.lineStyle(2.2, color, 0.95 * alpha);
    painter.strokeCircle(to.x, to.y, radius);
    painter.fillStyle(color, 0.85 * alpha);
    painter.fillCircle(to.x, to.y, 3);

    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + time / 1600;
      const inner = radius + 4;
      const outer = radius + 9 + pulse * 2;
      painter.lineStyle(2, color, 0.7 * alpha);
      painter.beginPath();
      painter.moveTo(to.x + Math.cos(angle) * inner, to.y + Math.sin(angle) * inner);
      painter.lineTo(to.x + Math.cos(angle) * outer, to.y + Math.sin(angle) * outer);
      painter.strokePath();
    }

    // Длина будущей нити — тонкая засечка на середине луча.
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    painter.lineStyle(1.6, color, 0.4 * alpha);
    painter.beginPath();
    painter.moveTo(midX - ny * 5, midY + nx * 5);
    painter.lineTo(midX + ny * 5, midY - nx * 5);
    painter.strokePath();

    // Светящийся слой идёт последним: сложение цвета коммутативно, поэтому
    // порядок внутри него неважен, а поверх обычного слоя он ложится целиком —
    // ровно так же, как раньше это делал отдельный слой поверх основного.
    painter.setBlendMode('add');
    painter.lineStyle(1.4, PALETTE.uiAccent, 0.1 * alpha);
    painter.strokeCircle(
      preview.origin.x,
      preview.origin.y,
      webConfig.maximumShotDistance * alpha,
    );
    painter.fillStyle(color, 0.22 * alpha);
    painter.fillCircle(to.x, to.y, radius * 2.1);
    painter.setBlendMode('normal');
  }
}

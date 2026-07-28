import type { Rect } from '../core/math/Geometry';
import type { Vector2 } from '../core/math/Vector2';

/**
 * Камера комнаты в мировых координатах.
 *
 * Мир никогда не вращается: сколько бы Люма ни бегала по потолку, «верх»
 * экрана остаётся верхом. Поэтому камере хватает центра, масштаба и границ.
 *
 * Параллакс задаётся множителем прокрутки, как в Phaser: слой с множителем 0
 * приколот к экрану, с 1 — намертво к миру, промежуточные значения дают
 * глубину. Матрица для такого слоя считается той же формулой, что и для мира,
 * поэтому фон и передний план всегда согласованы по масштабу.
 */
export class Camera2D {
  /** Центр видимой области в мировых координатах. */
  centerX = 0;
  centerY = 0;
  /** Итоговый масштаб: мировая единица → CSS-пиксель. */
  zoom = 1;

  /** Размер вьюпорта в CSS-пикселях. */
  viewportWidth = 1;
  viewportHeight = 1;

  private boundsRect: Rect | null = null;
  readonly worldView: Rect = { x: 0, y: 0, width: 1, height: 1 };

  setViewport(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
    this.refresh();
  }

  setBounds(bounds: Rect | null): void {
    this.boundsRect = bounds;
    this.refresh();
  }

  centerOn(x: number, y: number): void {
    this.centerX = x;
    this.centerY = y;
    this.refresh();
  }

  setZoom(zoom: number): void {
    this.zoom = Math.max(0.01, zoom);
    this.refresh();
  }

  /**
   * Ограничивает центр так, чтобы видимая область не вылезала за границы
   * комнаты. Если комната меньше экрана по оси — камера встаёт по её центру:
   * это единственный вариант без чёрных полос по одному краю.
   */
  private refresh(): void {
    const halfWidth = this.viewportWidth / (2 * this.zoom);
    const halfHeight = this.viewportHeight / (2 * this.zoom);
    const bounds = this.boundsRect;

    if (bounds) {
      if (bounds.width <= halfWidth * 2) this.centerX = bounds.x + bounds.width / 2;
      else this.centerX = Math.min(
        Math.max(this.centerX, bounds.x + halfWidth),
        bounds.x + bounds.width - halfWidth,
      );

      if (bounds.height <= halfHeight * 2) this.centerY = bounds.y + bounds.height / 2;
      else this.centerY = Math.min(
        Math.max(this.centerY, bounds.y + halfHeight),
        bounds.y + bounds.height - halfHeight,
      );
    }

    this.worldView.x = this.centerX - halfWidth;
    this.worldView.y = this.centerY - halfHeight;
    this.worldView.width = halfWidth * 2;
    this.worldView.height = halfHeight * 2;
  }

  /**
   * Ставит матрицу контекста так, что дальше можно рисовать прямо в мировых
   * координатах. `scrollFactor` управляет параллаксом: слой едет за камерой
   * не полностью, а на заданную долю.
   *
   * Смещение считается от центра камеры, а не от прокрутки: точка мира
   * `centerX · f` всегда оказывается в середине экрана. При множителе 1 это
   * обычная мировая матрица, при 0 — слой приколот к экрану и его начало
   * координат совпадает с центром вьюпорта. Важно, что в формулу не входит
   * размер холста: иначе на экране другого разрешения дальние планы уезжали
   * бы относительно ближних, а на такой ошибке легко потерять сведённую
   * художником композицию.
   */
  applyTo(ctx: CanvasRenderingContext2D, pixelRatio: number, scrollFactor = 1): void {
    const zoom = this.zoom;
    const offsetX = this.viewportWidth / 2 - zoom * this.centerX * scrollFactor;
    const offsetY = this.viewportHeight / 2 - zoom * this.centerY * scrollFactor;
    ctx.setTransform(
      zoom * pixelRatio,
      0,
      0,
      zoom * pixelRatio,
      offsetX * pixelRatio,
      offsetY * pixelRatio,
    );
  }

  /** Видимая в слое область мира — для отсечения по параллаксным слоям. */
  viewFor(scrollFactor: number, out: Rect = { x: 0, y: 0, width: 0, height: 0 }): Rect {
    out.width = this.viewportWidth / this.zoom;
    out.height = this.viewportHeight / this.zoom;
    out.x = this.centerX * scrollFactor - out.width / 2;
    out.y = this.centerY * scrollFactor - out.height / 2;
    return out;
  }

  worldToScreen(point: Vector2, out: Vector2 = { x: 0, y: 0 }): Vector2 {
    out.x = (point.x - this.worldView.x) * this.zoom;
    out.y = (point.y - this.worldView.y) * this.zoom;
    return out;
  }

  screenToWorld(x: number, y: number, out: Vector2 = { x: 0, y: 0 }): Vector2 {
    out.x = this.worldView.x + x / this.zoom;
    out.y = this.worldView.y + y / this.zoom;
    return out;
  }
}

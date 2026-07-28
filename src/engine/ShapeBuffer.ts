import type { Rect } from '../core/math/Geometry';
import type { Painter } from './Painter';

/**
 * Общий словарь рисования.
 *
 * Его понимают и `Painter`, который сразу пишет в холст, и `ShapeBuffer`,
 * который запоминает фигуры на будущее. Благодаря этому один и тот же код
 * отрисовки годится и для живых объектов, и для неизменной геометрии комнаты.
 */
export interface ShapeSink {
  lineStyle(width: number, color: number, alpha?: number): this;
  fillStyle(color: number, alpha?: number): this;
  beginPath(): this;
  moveTo(x: number, y: number): this;
  lineTo(x: number, y: number): this;
  closePath(): this;
  fillPath(): this;
  strokePath(): this;
  fillCircle(x: number, y: number, radius: number): this;
  strokeCircle(x: number, y: number, radius: number): this;
  fillRect(x: number, y: number, width: number, height: number): this;
  strokeRect(x: number, y: number, width: number, height: number): this;
  fillEllipse(x: number, y: number, width: number, height: number): this;
}

const enum Command {
  FillPath,
  StrokePath,
  FillCircle,
  StrokeCircle,
  FillRect,
  StrokeRect,
  FillEllipse,
}

/**
 * Записанный набор фигур для многократной переигровки.
 *
 * Геометрия комнаты, мох, трещины и декор не меняются, но рисовать их всё
 * равно нужно каждый кадр. Хранить их в растре нельзя: комната 4200×1500, и
 * при плотности пикселей 2 такой холст занял бы сотню мегабайт. Поэтому
 * запоминаются сами фигуры — в плоских массивах чисел, без объектов на точку.
 *
 * Помимо экономии на пересчёте процедурной генерации это даёт то, чего не
 * умел прежний движок: у каждой фигуры есть рамка, и фигуры вне экрана
 * пропускаются целиком. В комнате из пяти зон это отсекает большую часть
 * работы, потому что видно одну.
 */
export class ShapeBuffer implements ShapeSink {
  private readonly commands: number[] = [];
  private readonly colors: number[] = [];
  private readonly alphas: number[] = [];
  private readonly widths: number[] = [];
  /** По четыре числа на фигуру: minX, minY, maxX, maxY. */
  private readonly bounds: number[] = [];
  /** Индекс начала и число координат в общем массиве точек. */
  private readonly starts: number[] = [];
  private readonly counts: number[] = [];
  private points: number[] = [];
  private packedPoints: Float32Array | null = null;

  private currentColor = 0xffffff;
  private currentAlpha = 1;
  private currentLineColor = 0xffffff;
  private currentLineAlpha = 1;
  private currentLineWidth = 1;

  private pathStart = 0;
  private pathMinX = Infinity;
  private pathMinY = Infinity;
  private pathMaxX = -Infinity;
  private pathMaxY = -Infinity;
  private pathClosed = false;

  get shapeCount(): number {
    return this.commands.length;
  }

  clear(): void {
    this.commands.length = 0;
    this.colors.length = 0;
    this.alphas.length = 0;
    this.widths.length = 0;
    this.bounds.length = 0;
    this.starts.length = 0;
    this.counts.length = 0;
    this.points.length = 0;
    this.packedPoints = null;
  }

  /**
   * Упаковывает точки в типизированный массив. Вызывается один раз после
   * записи: дальше переигровка идёт без обращений к динамическому массиву.
   */
  seal(): void {
    this.packedPoints = Float32Array.from(this.points);
    this.points = [];
  }

  // ------------------------------------------------------------ запись

  lineStyle(width: number, color: number, alpha = 1): this {
    this.currentLineWidth = width;
    this.currentLineColor = color;
    this.currentLineAlpha = alpha;
    return this;
  }

  fillStyle(color: number, alpha = 1): this {
    this.currentColor = color;
    this.currentAlpha = alpha;
    return this;
  }

  beginPath(): this {
    this.pathStart = this.points.length;
    this.pathMinX = Infinity;
    this.pathMinY = Infinity;
    this.pathMaxX = -Infinity;
    this.pathMaxY = -Infinity;
    this.pathClosed = false;
    return this;
  }

  moveTo(x: number, y: number): this {
    // Разрыв внутри пути помечается парой NaN: при переигровке она означает
    // «начать новый подпуть», а не координату.
    if (this.points.length > this.pathStart) this.points.push(NaN, NaN);
    return this.lineTo(x, y);
  }

  lineTo(x: number, y: number): this {
    this.points.push(x, y);
    if (x < this.pathMinX) this.pathMinX = x;
    if (y < this.pathMinY) this.pathMinY = y;
    if (x > this.pathMaxX) this.pathMaxX = x;
    if (y > this.pathMaxY) this.pathMaxY = y;
    return this;
  }

  closePath(): this {
    this.pathClosed = true;
    return this;
  }

  fillPath(): this {
    return this.pushPath(Command.FillPath, this.currentColor, this.currentAlpha, 0);
  }

  strokePath(): this {
    return this.pushPath(
      Command.StrokePath,
      this.currentLineColor,
      this.currentLineAlpha,
      this.currentLineWidth,
    );
  }

  private pushPath(command: Command, color: number, alpha: number, width: number): this {
    const count = this.points.length - this.pathStart;
    if (count < 4) return this;
    this.commands.push(this.pathClosed ? command | 0x100 : command);
    this.colors.push(color);
    this.alphas.push(alpha);
    this.widths.push(width);
    this.starts.push(this.pathStart);
    this.counts.push(count);
    const pad = width / 2;
    this.bounds.push(
      this.pathMinX - pad,
      this.pathMinY - pad,
      this.pathMaxX + pad,
      this.pathMaxY + pad,
    );
    return this;
  }

  private pushShape(
    command: Command,
    color: number,
    alpha: number,
    width: number,
    a: number,
    b: number,
    c: number,
    d: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): this {
    this.commands.push(command);
    this.colors.push(color);
    this.alphas.push(alpha);
    this.widths.push(width);
    this.starts.push(this.points.length);
    this.counts.push(4);
    this.points.push(a, b, c, d);
    this.bounds.push(minX, minY, maxX, maxY);
    return this;
  }

  fillCircle(x: number, y: number, radius: number): this {
    return this.pushShape(
      Command.FillCircle,
      this.currentColor,
      this.currentAlpha,
      0,
      x,
      y,
      radius,
      0,
      x - radius,
      y - radius,
      x + radius,
      y + radius,
    );
  }

  strokeCircle(x: number, y: number, radius: number): this {
    const pad = radius + this.currentLineWidth / 2;
    return this.pushShape(
      Command.StrokeCircle,
      this.currentLineColor,
      this.currentLineAlpha,
      this.currentLineWidth,
      x,
      y,
      radius,
      0,
      x - pad,
      y - pad,
      x + pad,
      y + pad,
    );
  }

  fillRect(x: number, y: number, width: number, height: number): this {
    return this.pushShape(
      Command.FillRect,
      this.currentColor,
      this.currentAlpha,
      0,
      x,
      y,
      width,
      height,
      x,
      y,
      x + width,
      y + height,
    );
  }

  strokeRect(x: number, y: number, width: number, height: number): this {
    const pad = this.currentLineWidth / 2;
    return this.pushShape(
      Command.StrokeRect,
      this.currentLineColor,
      this.currentLineAlpha,
      this.currentLineWidth,
      x,
      y,
      width,
      height,
      x - pad,
      y - pad,
      x + width + pad,
      y + height + pad,
    );
  }

  fillEllipse(x: number, y: number, width: number, height: number): this {
    return this.pushShape(
      Command.FillEllipse,
      this.currentColor,
      this.currentAlpha,
      0,
      x,
      y,
      width,
      height,
      x - width / 2,
      y - height / 2,
      x + width / 2,
      y + height / 2,
    );
  }

  // -------------------------------------------------------- переигровка

  /** Рисует записанные фигуры; `view` отсекает всё, что вне экрана. */
  replay(painter: Painter, view?: Rect): void {
    const points = this.packedPoints;
    if (!points) return;

    const viewMinX = view ? view.x : -Infinity;
    const viewMinY = view ? view.y : -Infinity;
    const viewMaxX = view ? view.x + view.width : Infinity;
    const viewMaxY = view ? view.y + view.height : Infinity;

    for (let i = 0; i < this.commands.length; i++) {
      const b = i * 4;
      if (
        this.bounds[b]! > viewMaxX ||
        this.bounds[b + 2]! < viewMinX ||
        this.bounds[b + 1]! > viewMaxY ||
        this.bounds[b + 3]! < viewMinY
      ) {
        continue;
      }

      const raw = this.commands[i]!;
      const command = (raw & 0xff) as Command;
      const closed = (raw & 0x100) !== 0;
      const color = this.colors[i]!;
      const alpha = this.alphas[i]!;
      const start = this.starts[i]!;

      switch (command) {
        case Command.FillPath:
        case Command.StrokePath: {
          const end = start + this.counts[i]!;
          const ctx = painter.ctx;
          ctx.beginPath();
          let pendingMove = true;
          for (let p = start; p < end; p += 2) {
            const x = points[p]!;
            if (Number.isNaN(x)) {
              pendingMove = true;
              continue;
            }
            const y = points[p + 1]!;
            if (pendingMove) {
              ctx.moveTo(x, y);
              pendingMove = false;
            } else {
              ctx.lineTo(x, y);
            }
          }
          if (closed) ctx.closePath();
          if (command === Command.FillPath) {
            painter.fillStyle(color, alpha);
            ctx.fill();
          } else {
            painter.lineStyle(this.widths[i]!, color, alpha);
            ctx.stroke();
          }
          break;
        }

        case Command.FillCircle:
          painter.fillStyle(color, alpha);
          painter.fillCircle(points[start]!, points[start + 1]!, points[start + 2]!);
          break;

        case Command.StrokeCircle:
          painter.lineStyle(this.widths[i]!, color, alpha);
          painter.strokeCircle(points[start]!, points[start + 1]!, points[start + 2]!);
          break;

        case Command.FillRect:
          painter.fillStyle(color, alpha);
          painter.fillRect(
            points[start]!,
            points[start + 1]!,
            points[start + 2]!,
            points[start + 3]!,
          );
          break;

        case Command.StrokeRect:
          painter.lineStyle(this.widths[i]!, color, alpha);
          painter.strokeRect(
            points[start]!,
            points[start + 1]!,
            points[start + 2]!,
            points[start + 3]!,
          );
          break;

        case Command.FillEllipse:
          painter.fillStyle(color, alpha);
          painter.fillEllipse(
            points[start]!,
            points[start + 1]!,
            points[start + 2]!,
            points[start + 3]!,
          );
          break;
      }
    }
  }
}

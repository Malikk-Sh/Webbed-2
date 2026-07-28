import { cssColor } from './Color';

export type BlendMode = 'normal' | 'add' | 'multiply' | 'screen';

const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  add: 'lighter',
  multiply: 'multiply',
  screen: 'screen',
};

/**
 * Непосредственное рисование поверх Canvas 2D.
 *
 * Имена и сигнатуры методов намеренно повторяют `Phaser.GameObjects.Graphics`:
 * весь художественный код игры написан в этом словаре, и при переезде с Phaser
 * он остался прежним — поменялся только объект, в который он рисует. Это
 * сознательный компромисс: `fillCircle`/`fillEllipse`/`slice` не самые
 * «канвасные» имена, зато ни одна из тысяч строк отрисовки не переписывалась
 * заново, а значит и не могла сломаться при переносе.
 *
 * В отличие от Phaser здесь нет удерживаемого списка команд: рисование
 * происходит сразу в контекст, а порядок слоёв задаётся порядком вызовов в
 * сцене. Для игры такого размера это и быстрее (нет буфера команд и
 * пересортировки по depth каждый кадр), и понятнее.
 */
export class Painter {
  private strokeWidth = 1;
  private blend: BlendMode = 'normal';

  constructor(public ctx: CanvasRenderingContext2D) {}

  /** Переключение на другой контекст — нужно офскрин-слоям. */
  bind(ctx: CanvasRenderingContext2D): void {
    this.ctx = ctx;
    this.strokeWidth = 1;
    this.blend = 'normal';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  // ------------------------------------------------------------ состояние

  save(): void {
    this.ctx.save();
  }

  restore(): void {
    this.ctx.restore();
    // После `restore` контекст мог вернуться к другому режиму наложения,
    // поэтому кэш режима сбрасывается: иначе следующий `setBlendMode` с тем
    // же значением посчитает себя лишним и ничего не выставит.
    this.blend = 'normal';
  }

  setBlendMode(mode: BlendMode): this {
    if (mode !== this.blend) {
      this.blend = mode;
      this.ctx.globalCompositeOperation = COMPOSITE[mode];
    }
    return this;
  }

  setAlpha(alpha: number): this {
    this.ctx.globalAlpha = alpha;
    return this;
  }

  translate(x: number, y: number): void {
    this.ctx.translate(x, y);
  }

  rotate(angle: number): void {
    this.ctx.rotate(angle);
  }

  scale(x: number, y: number): void {
    this.ctx.scale(x, y);
  }

  // ------------------------------------------------------------- материал

  lineStyle(width: number, color: number, alpha = 1): this {
    this.strokeWidth = width;
    this.ctx.lineWidth = width;
    this.ctx.strokeStyle = cssColor(color, alpha);
    return this;
  }

  fillStyle(color: number, alpha = 1): this {
    this.ctx.fillStyle = cssColor(color, alpha);
    return this;
  }

  /** Прямое присваивание стиля — для градиентов и паттернов. */
  fillGradient(style: CanvasGradient | CanvasPattern): this {
    this.ctx.fillStyle = style;
    return this;
  }

  get lineWidth(): number {
    return this.strokeWidth;
  }

  // ------------------------------------------------------------------ путь

  beginPath(): this {
    this.ctx.beginPath();
    return this;
  }

  moveTo(x: number, y: number): this {
    this.ctx.moveTo(x, y);
    return this;
  }

  lineTo(x: number, y: number): this {
    this.ctx.lineTo(x, y);
    return this;
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): this {
    this.ctx.quadraticCurveTo(cx, cy, x, y);
    return this;
  }

  closePath(): this {
    this.ctx.closePath();
    return this;
  }

  /** Дуга в текущем пути; углы в радианах, как в Phaser. */
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    anticlockwise = false,
  ): this {
    this.ctx.arc(x, y, radius, startAngle, endAngle, anticlockwise);
    return this;
  }

  strokePath(): this {
    this.ctx.stroke();
    return this;
  }

  fillPath(): this {
    this.ctx.fill();
    return this;
  }

  // ------------------------------------------------------------- примитивы

  fillRect(x: number, y: number, width: number, height: number): this {
    this.ctx.fillRect(x, y, width, height);
    return this;
  }

  strokeRect(x: number, y: number, width: number, height: number): this {
    this.ctx.strokeRect(x, y, width, height);
    return this;
  }

  fillCircle(x: number, y: number, radius: number): this {
    if (radius <= 0) return this;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    return this;
  }

  strokeCircle(x: number, y: number, radius: number): this {
    if (radius <= 0) return this;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
    return this;
  }

  /** Как в Phaser: передаются полные ширина и высота, а не радиусы. */
  fillEllipse(x: number, y: number, width: number, height: number): this {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0, width / 2), Math.max(0, height / 2), 0, 0, Math.PI * 2);
    ctx.fill();
    return this;
  }

  /**
   * Эллипс, повёрнутый на произвольный угол; задаются радиусы, а не размеры.
   *
   * Прежний движок рисовал эллипсы только по осям, и повёрнутый приходилось
   * собирать шестнадцатиугольником. Холст умеет это сам и одной командой —
   * силуэт паучихи на наклонных поверхностях стал заметно чище.
   */
  fillEllipseRotated(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
  ): this {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0, radiusX), Math.max(0, radiusY), rotation, 0, Math.PI * 2);
    ctx.fill();
    return this;
  }

  strokeEllipse(x: number, y: number, width: number, height: number): this {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0, width / 2), Math.max(0, height / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
    return this;
  }

  fillRoundedRect(x: number, y: number, width: number, height: number, radius: number): this {
    this.roundedRectPath(x, y, width, height, radius);
    this.ctx.fill();
    return this;
  }

  strokeRoundedRect(x: number, y: number, width: number, height: number, radius: number): this {
    this.roundedRectPath(x, y, width, height, radius);
    this.ctx.stroke();
    return this;
  }

  /** Сектор круга: путь идёт из центра, поэтому заливка даёт «кусок пирога». */
  slice(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    anticlockwise = false,
  ): this {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, Math.max(0, radius), startAngle, endAngle, anticlockwise);
    ctx.closePath();
    return this;
  }

  private roundedRectPath(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.arcTo(x + width, y, x + width, y + r, r);
    ctx.lineTo(x + width, y + height - r);
    ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
    ctx.lineTo(x + r, y + height);
    ctx.arcTo(x, y + height, x, y + height - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  // ----------------------------------------------------------------- текст

  setFont(font: string): this {
    this.ctx.font = font;
    return this;
  }

  setTextAlign(align: CanvasTextAlign, baseline: CanvasTextBaseline = 'alphabetic'): this {
    this.ctx.textAlign = align;
    this.ctx.textBaseline = baseline;
    return this;
  }

  fillText(text: string, x: number, y: number): this {
    this.ctx.fillText(text, x, y);
    return this;
  }

  measureWidth(text: string): number {
    return this.ctx.measureText(text).width;
  }

  /**
   * Разбивает строку по словам под заданную ширину.
   *
   * Замеры кэшируются вызывающей стороной: подсказки меняются редко, а
   * `measureText` на каждый кадр для каждого слова заметно дороже отрисовки.
   */
  wrapText(text: string, maximumWidth: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = '';

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && this.measureWidth(candidate) > maximumWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // -------------------------------------------------------------- текстуры

  /**
   * Текстура по центру с масштабом и поворотом — замена `Image` из Phaser.
   *
   * Поворот и масштаб применяются через матрицу контекста только когда они
   * действительно заданы: `drawImage` без трансформаций заметно дешевле.
   */
  drawTexture(
    texture: CanvasImageSource,
    x: number,
    y: number,
    width: number,
    height: number,
    rotation = 0,
    alpha = 1,
  ): this {
    const ctx = this.ctx;
    const previousAlpha = ctx.globalAlpha;
    if (alpha !== 1) ctx.globalAlpha = previousAlpha * alpha;

    if (rotation === 0) {
      ctx.drawImage(texture, x - width / 2, y - height / 2, width, height);
    } else {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);
      ctx.drawImage(texture, -width / 2, -height / 2, width, height);
      ctx.restore();
    }

    if (alpha !== 1) ctx.globalAlpha = previousAlpha;
    return this;
  }

  /** Текстура с растяжением по прямоугольнику, без центрирования. */
  drawTextureRect(
    texture: CanvasImageSource,
    x: number,
    y: number,
    width: number,
    height: number,
  ): this {
    this.ctx.drawImage(texture, x, y, width, height);
    return this;
  }
}

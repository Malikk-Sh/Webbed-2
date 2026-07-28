/**
 * Холст игры и его размеры.
 *
 * Отдельный класс нужен из-за плотности пикселей: логический размер задаётся в
 * CSS-пикселях, а буфер рисуется в физических, и путать их нельзя ни в вводе,
 * ни в отрисовке. Множитель ограничен двойкой — на телефонах с DPR 3 третий
 * множитель почти не виден, а стоит трети кадрового бюджета.
 */
export class Surface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  /** Размер в CSS-пикселях. */
  width = 0;
  height = 0;
  /** Отношение физических пикселей к CSS-пикселям. */
  pixelRatio = 1;

  private readonly listeners: ((surface: Surface) => void)[] = [];
  private resizeRaf = 0;

  constructor(parent: HTMLElement, private readonly maximumPixelRatio = 2) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    // Жесты браузера (скролл, зум щипком, двойной тап) отбираются у страницы:
    // игра сама разбирает касания и не должна дёргать вид.
    this.canvas.style.touchAction = 'none';
    parent.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Canvas 2D недоступен');
    this.ctx = ctx;

    this.resize();

    window.addEventListener('resize', this.scheduleResize);
    window.addEventListener('orientationchange', this.scheduleResize);
  }

  onResize(listener: (surface: Surface) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  private readonly scheduleResize = (): void => {
    if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0;
      this.resize();
    });
  };

  resize(): void {
    const parent = this.canvas.parentElement;
    const width = Math.max(1, Math.round(parent?.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.round(parent?.clientHeight || window.innerHeight));
    const ratio = Math.min(window.devicePixelRatio || 1, this.maximumPixelRatio);

    if (width === this.width && height === this.height && ratio === this.pixelRatio) return;

    this.width = width;
    this.height = height;
    this.pixelRatio = ratio;
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));

    for (const listener of this.listeners) listener(this);
  }

  /** Сбрасывает матрицу к «одна единица = один CSS-пиксель». */
  resetTransform(): void {
    this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
  }

  clear(color: string): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.resetTransform();
  }

  destroy(): void {
    window.removeEventListener('resize', this.scheduleResize);
    window.removeEventListener('orientationchange', this.scheduleResize);
    if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
    this.canvas.remove();
  }
}

import { cssColor } from './Color';

export interface TextureHandle {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
}

const createCanvas = (width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
};

/**
 * Реестр процедурных текстур.
 *
 * В игре нет ни одного бинарного ассета: все градиенты, зерно и блики
 * рисуются в офскрин-холсты при запуске. Для Canvas 2D это идеальный формат —
 * такой холст напрямую принимается `drawImage` без загрузки и декодирования.
 *
 * Здесь же живёт окрашивание. Canvas 2D не умеет «tint» как GPU-рендер,
 * поэтому цветная копия готовится один раз через `source-in` и кэшируется:
 * оттенков в игре меньше десятка, и все они постоянные.
 */
export class TextureStore {
  private readonly textures = new Map<string, TextureHandle>();
  private readonly tinted = new Map<string, TextureHandle>();

  has(key: string): boolean {
    return this.textures.has(key);
  }

  get(key: string): TextureHandle {
    const texture = this.textures.get(key);
    if (!texture) throw new Error(`Текстура «${key}» не создана`);
    return texture;
  }

  /**
   * Создаёт текстуру рисованием в новый холст. Повторный вызов с тем же
   * ключом ничего не делает — так модули могут не следить за порядком.
   */
  create(
    key: string,
    width: number,
    height: number,
    draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  ): TextureHandle {
    const existing = this.textures.get(key);
    if (existing) return existing;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D недоступен');
    draw(ctx, canvas.width, canvas.height);

    const handle: TextureHandle = { canvas, width: canvas.width, height: canvas.height };
    this.textures.set(key, handle);
    return handle;
  }

  /** Копия текстуры, перекрашенная в указанный цвет с сохранением альфы. */
  tint(key: string, color: number): TextureHandle {
    const cacheKey = `${key}#${color.toString(16)}`;
    const hit = this.tinted.get(cacheKey);
    if (hit) return hit;

    const source = this.get(key);
    const canvas = createCanvas(source.width, source.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D недоступен');

    ctx.drawImage(source.canvas, 0, 0);
    // `source-in` оставляет заливку только там, где у оригинала есть альфа —
    // ровно то, что делает умножение на цвет в GPU-рендере.
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = cssColor(color, 1);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const handle: TextureHandle = { canvas, width: canvas.width, height: canvas.height };
    this.tinted.set(cacheKey, handle);
    return handle;
  }

  destroy(): void {
    this.textures.clear();
    this.tinted.clear();
  }
}

export const textures = new TextureStore();

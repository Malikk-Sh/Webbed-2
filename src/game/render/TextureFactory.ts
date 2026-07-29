import { createRandom } from '../../core/math/Interpolation';
import type { TextureStore } from '../../engine/TextureStore';

/**
 * Генерация всех текстур во время выполнения.
 *
 * В прототипе нет ни одного бинарного ассета: это делает первую загрузку
 * мгновенной, избавляет от атласов и позволяет менять палитру одним числом.
 * Мягкое свечение и объём достигаются наложением этих градиентов в режиме
 * сложения — это заметно дешевле полноценного постэффекта на слабом телефоне.
 */
export const TEXTURES = {
  glow: 'silk-glow',
  glowSoft: 'silk-glow-soft',
  spark: 'silk-spark',
  streak: 'silk-streak',
  grain: 'silk-grain',
  vignette: 'silk-vignette',
  dust: 'silk-dust',
} as const;

const radialTexture = (
  store: TextureStore,
  key: string,
  size: number,
  stops: [number, string][],
): void => {
  store.create(key, size, size, (ctx, width) => {
    const half = width / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, width);
  });
};

export const createRuntimeTextures = (store: TextureStore): void => {
  // Плотное ядро с длинным хвостом — универсальное свечение.
  radialTexture(store, TEXTURES.glow, 128, [
    [0, 'rgba(255,255,255,1)'],
    [0.18, 'rgba(255,255,255,0.72)'],
    [0.45, 'rgba(255,255,255,0.20)'],
    [1, 'rgba(255,255,255,0)'],
  ]);

  // Широкое мягкое пятно для объёмного света и тумана.
  radialTexture(store, TEXTURES.glowSoft, 256, [
    [0, 'rgba(255,255,255,0.55)'],
    [0.35, 'rgba(255,255,255,0.22)'],
    [0.7, 'rgba(255,255,255,0.06)'],
    [1, 'rgba(255,255,255,0)'],
  ]);

  // Маленькая яркая искра с крестообразным бликом.
  store.create(TEXTURES.spark, 64, 64, (ctx, size) => {
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.25, 'rgba(255,255,255,0.5)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    ctx.globalCompositeOperation = 'lighter';
    const streak = ctx.createLinearGradient(0, half, size, half);
    streak.addColorStop(0, 'rgba(255,255,255,0)');
    streak.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    streak.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = streak;
    ctx.fillRect(0, half - 1, size, 2);
    ctx.fillRect(half - 1, 0, 2, size);
  });

  // Вертикальный луч света сквозь разбитое стекло.
  store.create(TEXTURES.streak, 96, 512, (ctx, width, height) => {
    const horizontal = ctx.createLinearGradient(0, 0, width, 0);
    horizontal.addColorStop(0, 'rgba(255,255,255,0)');
    horizontal.addColorStop(0.5, 'rgba(255,255,255,1)');
    horizontal.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = horizontal;
    ctx.fillRect(0, 0, width, height);

    // Затухание к низу: луч растворяется в воздухе, а не обрывается.
    ctx.globalCompositeOperation = 'destination-in';
    const vertical = ctx.createLinearGradient(0, 0, 0, height);
    vertical.addColorStop(0, 'rgba(0,0,0,1)');
    vertical.addColorStop(0.55, 'rgba(0,0,0,0.45)');
    vertical.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = vertical;
    ctx.fillRect(0, 0, width, height);
  });

  // Тканево-бумажное зерно поверх кадра — из визуального направления концепта.
  store.create(TEXTURES.grain, 256, 256, (ctx, size) => {
    const image = ctx.createImageData(size, size);
    const random = createRandom(20240728);
    for (let i = 0; i < image.data.length; i += 4) {
      const value = 128 + (random() - 0.5) * 96;
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 26;
    }
    ctx.putImageData(image, 0, 0);
  });

  // Виньетка — прямоугольная текстура с тёмными краями.
  store.create(TEXTURES.vignette, 512, 512, (ctx, size) => {
    const gradient = ctx.createRadialGradient(
      size / 2,
      size / 2,
      size * 0.28,
      size / 2,
      size / 2,
      size * 0.72,
    );
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(0.6, 'rgba(0,0,0,0.20)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.62)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  });

  radialTexture(store, TEXTURES.dust, 32, [
    [0, 'rgba(255,255,255,0.9)'],
    [0.5, 'rgba(255,255,255,0.28)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
};

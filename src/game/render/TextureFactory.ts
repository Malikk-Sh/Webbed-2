import Phaser from 'phaser';
import { createRandom } from '../../core/math/Interpolation';

/**
 * Генерация всех текстур во время выполнения.
 *
 * В прототипе нет ни одного бинарного ассета: это делает первую загрузку
 * мгновенной, избавляет от атласов и позволяет менять палитру одним числом.
 * Мягкое свечение и объём достигаются наложением этих градиентов в режиме
 * ADD — это заметно дешевле полноценного постэффекта на слабом телефоне.
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
  textures: Phaser.Textures.TextureManager,
  key: string,
  size: number,
  stops: [number, string][],
): void => {
  if (textures.exists(key)) return;
  const canvas = textures.createCanvas(key, size, size);
  if (!canvas) return;
  const ctx = canvas.getContext();
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  canvas.refresh();
};

/**
 * Текстуры создаются один раз на менеджере игры, а не в сцене: HUD
 * запускается раньше игровой сцены, и если готовить их в её `create()`,
 * интерфейс успевает подхватить заглушку «missing texture».
 */
export const createRuntimeTextures = (textures: Phaser.Textures.TextureManager): void => {
  // Плотное ядро с длинным хвостом — универсальное свечение.
  radialTexture(textures, TEXTURES.glow, 128, [
    [0, 'rgba(255,255,255,1)'],
    [0.18, 'rgba(255,255,255,0.72)'],
    [0.45, 'rgba(255,255,255,0.20)'],
    [1, 'rgba(255,255,255,0)'],
  ]);

  // Широкое мягкое пятно для объёмного света и тумана.
  radialTexture(textures, TEXTURES.glowSoft, 256, [
    [0, 'rgba(255,255,255,0.55)'],
    [0.35, 'rgba(255,255,255,0.22)'],
    [0.7, 'rgba(255,255,255,0.06)'],
    [1, 'rgba(255,255,255,0)'],
  ]);

  // Маленькая яркая искра с крестообразным бликом.
  if (!textures.exists(TEXTURES.spark)) {
    const size = 64;
    const canvas = textures.createCanvas(TEXTURES.spark, size, size);
    if (canvas) {
      const ctx = canvas.getContext();
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
      canvas.refresh();
    }
  }

  // Вертикальный луч света сквозь разбитое стекло.
  if (!textures.exists(TEXTURES.streak)) {
    const width = 96;
    const height = 512;
    const canvas = textures.createCanvas(TEXTURES.streak, width, height);
    if (canvas) {
      const ctx = canvas.getContext();
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
      canvas.refresh();
    }
  }

  // Тканево-бумажное зерно поверх кадра — из визуального направления концепта.
  if (!textures.exists(TEXTURES.grain)) {
    const size = 256;
    const canvas = textures.createCanvas(TEXTURES.grain, size, size);
    if (canvas) {
      const ctx = canvas.getContext();
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
      canvas.refresh();
    }
  }

  // Виньетка — прямоугольная текстура с тёмными краями.
  if (!textures.exists(TEXTURES.vignette)) {
    const size = 512;
    const canvas = textures.createCanvas(TEXTURES.vignette, size, size);
    if (canvas) {
      const ctx = canvas.getContext();
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
      canvas.refresh();
    }
  }

  radialTexture(textures, TEXTURES.dust, 32, [
    [0, 'rgba(255,255,255,0.9)'],
    [0.5, 'rgba(255,255,255,0.28)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
};

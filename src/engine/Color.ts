/**
 * Числовые цвета (0xRRGGBB) и их представление для Canvas 2D.
 *
 * Canvas принимает только строки, а игра оперирует числами из палитры, и на
 * кадре таких переводов тысячи. Поэтому строки кэшируются: ключ собирается из
 * цвета и альфы, огрублённой до 1/255 — визуально шаг незаметен, а размер
 * кэша остаётся конечным даже при плавно затухающих частицах.
 */

const cache = new Map<number, string>();

/** Строка `rgba(...)` для числового цвета и альфы 0..1. */
export const cssColor = (color: number, alpha = 1): string => {
  const quantised = alpha >= 1 ? 255 : alpha <= 0 ? 0 : (alpha * 255) | 0;
  const key = ((color & 0xffffff) << 8) | quantised;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const value =
    quantised === 255
      ? `rgb(${r},${g},${b})`
      : `rgba(${r},${g},${b},${(quantised / 255).toFixed(3)})`;
  // Кэш не безграничен: при переполнении дешевле начать заново, чем вести
  // вытеснение — промахи стоят одну конкатенацию.
  if (cache.size > 4096) cache.clear();
  cache.set(key, value);
  return value;
};

export const colorComponents = (color: number): [number, number, number] => [
  (color >> 16) & 0xff,
  (color >> 8) & 0xff,
  color & 0xff,
];

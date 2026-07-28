export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const clamp01 = (value: number): number => clamp(value, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const inverseLerp = (a: number, b: number, value: number): number =>
  Math.abs(b - a) < 1e-9 ? 0 : clamp01((value - a) / (b - a));

export const remap = (
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number => lerp(outMin, outMax, inverseLerp(inMin, inMax, value));

/**
 * Экспоненциальное сглаживание, не зависящее от частоты кадров.
 *
 * `smoothTime` — время (в секундах), за которое расхождение уменьшается
 * примерно в 30 раз. Обычный `lerp(a, b, 0.1)` в кадре ведёт себя по-разному
 * на 30 и 60 FPS, поэтому во всей игре применяется именно этот вариант.
 */
export const damp = (current: number, target: number, smoothTime: number, dt: number): number => {
  if (smoothTime <= 0) return target;
  const t = 1 - Math.exp((-dt / smoothTime) * 3.5);
  return current + (target - current) * t;
};

export const dampAngle = (current: number, target: number, smoothTime: number, dt: number): number => {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return damp(current, current + delta, smoothTime, dt);
};

export const moveTowards = (current: number, target: number, maxDelta: number): number => {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
};

export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);

export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;

export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = clamp01(t);
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/** Детерминированный генератор псевдослучайных чисел (mulberry32). */
export const createRandom = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Дешёвый непрерывный шум на основе синусов.
 * Используется только для декоративного дрожания — от него не требуется
 * статистического качества, только гладкость и повторяемость.
 */
export const wobble = (t: number, seed = 0): number =>
  Math.sin(t * 1.13 + seed * 12.9898) * 0.6 + Math.sin(t * 2.71 + seed * 7.233) * 0.4;

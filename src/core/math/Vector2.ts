/**
 * Минимальная математика двумерных векторов.
 *
 * Векторы намеренно остаются простыми структурами `{ x, y }`, а не классами:
 * решатель паутины обрабатывает сотни точек за кадр, и любое лишнее выделение
 * памяти в горячем цикле сразу видно в профилировщике.
 */
export interface Vector2 {
  x: number;
  y: number;
}

export const vec = (x = 0, y = 0): Vector2 => ({ x, y });

export const clone = (v: Vector2): Vector2 => ({ x: v.x, y: v.y });

export const set = (out: Vector2, x: number, y: number): Vector2 => {
  out.x = x;
  out.y = y;
  return out;
};

export const copy = (out: Vector2, v: Vector2): Vector2 => set(out, v.x, v.y);

export const add = (a: Vector2, b: Vector2): Vector2 => ({ x: a.x + b.x, y: a.y + b.y });

export const sub = (a: Vector2, b: Vector2): Vector2 => ({ x: a.x - b.x, y: a.y - b.y });

export const scale = (v: Vector2, s: number): Vector2 => ({ x: v.x * s, y: v.y * s });

export const dot = (a: Vector2, b: Vector2): number => a.x * b.x + a.y * b.y;

/** Псевдоскалярное (z-компонента) векторного произведения. */
export const cross = (a: Vector2, b: Vector2): number => a.x * b.y - a.y * b.x;

export const lengthSq = (v: Vector2): number => v.x * v.x + v.y * v.y;

export const length = (v: Vector2): number => Math.sqrt(v.x * v.x + v.y * v.y);

export const distanceSq = (a: Vector2, b: Vector2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

export const distance = (a: Vector2, b: Vector2): number => Math.sqrt(distanceSq(a, b));

export const normalize = (v: Vector2): Vector2 => {
  const len = length(v);
  return len > 1e-9 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
};

/** Поворот на 90° против часовой стрелки в экранных координатах (ось Y вниз). */
export const perpendicular = (v: Vector2): Vector2 => ({ x: -v.y, y: v.x });

export const rotate = (v: Vector2, radians: number): Vector2 => {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
};

export const lerpVec = (a: Vector2, b: Vector2, t: number): Vector2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export const angleOf = (v: Vector2): number => Math.atan2(v.y, v.x);

export const fromAngle = (radians: number, len = 1): Vector2 => ({
  x: Math.cos(radians) * len,
  y: Math.sin(radians) * len,
});

/** Ограничивает длину вектора, сохраняя направление. */
export const limit = (v: Vector2, max: number): Vector2 => {
  const lenSq = lengthSq(v);
  if (lenSq <= max * max || lenSq < 1e-12) return { x: v.x, y: v.y };
  const s = max / Math.sqrt(lenSq);
  return { x: v.x * s, y: v.y * s };
};

/**
 * Плавный поворот вектора `from` к `to` не более чем на `maxRadians`.
 * Используется при переходе паука через угол: нормаль поверхности не должна
 * меняться скачком, иначе управление ощущается рывками.
 */
export const rotateTowards = (from: Vector2, to: Vector2, maxRadians: number): Vector2 => {
  const a = angleOf(from);
  const b = angleOf(to);
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const step = Math.max(-maxRadians, Math.min(maxRadians, delta));
  return fromAngle(a + step, 1);
};

/** Кратчайшая знаковая разница между двумя углами в радианах. */
export const angleDelta = (from: number, to: number): number => {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
};

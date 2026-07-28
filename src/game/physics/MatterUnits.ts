import type { Vector2 } from '../../core/math/Vector2';

/**
 * Перевод между игровыми единицами и внутренними единицами Matter.js.
 *
 * Matter хранит скорость как смещение за один шаг, а силу — так, что
 * `a = 1000 * F / m` единиц/с² при шаге 1/60 и `gravity.scale = 0.001`.
 * Вся игровая логика работает в единицах/с и единицах/с², а конвертация
 * живёт только здесь: иначе константы из ТЗ пришлось бы держать в двух
 * несопоставимых системах.
 */

export const STEPS_PER_SECOND = 60;

/**
 * Множитель, связывающий силу Matter с ускорением в единицах/с².
 *
 * Matter интегрирует так: `velocity += (force / mass) * delta²`, где delta
 * задан в миллисекундах. При шаге 1/60 c это `(F/m) · 277.8` пикселя за шаг,
 * то есть `(F/m) · 10⁶` единиц/с². Проверка на гравитации: движок добавляет
 * `mass · gravity.y · gravity.scale = m · 1.75 · 0.001`, что даёт ровно
 * 1750 единиц/с² — совпадает со значением из ТЗ.
 */
export const FORCE_TO_ACCELERATION = 1_000_000;

export interface MatterBodyLike {
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  mass: number;
  force: { x: number; y: number };
  angle: number;
  angularVelocity: number;
}

/** Скорость тела в единицах/с. */
export const getVelocity = (body: MatterBodyLike): Vector2 => ({
  x: body.velocity.x * STEPS_PER_SECOND,
  y: body.velocity.y * STEPS_PER_SECOND,
});

export const velocityToMatter = (velocity: Vector2): Vector2 => ({
  x: velocity.x / STEPS_PER_SECOND,
  y: velocity.y / STEPS_PER_SECOND,
});

/** Сила Matter, дающая телу заданное ускорение в единицах/с². */
export const accelerationToForce = (
  acceleration: Vector2,
  mass: number,
): Vector2 => ({
  x: (acceleration.x * mass) / FORCE_TO_ACCELERATION,
  y: (acceleration.y * mass) / FORCE_TO_ACCELERATION,
});

/** Игровая «сила» (масса × ускорение) в единицах Matter. */
export const forceToMatter = (force: Vector2): Vector2 => ({
  x: force.x / FORCE_TO_ACCELERATION,
  y: force.y / FORCE_TO_ACCELERATION,
});

/** Поворот локального смещения в мировые координаты тела. */
export const bodyToWorld = (body: MatterBodyLike, localOffset: Vector2): Vector2 => {
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  return {
    x: body.position.x + localOffset.x * cos - localOffset.y * sin,
    y: body.position.y + localOffset.x * sin + localOffset.y * cos,
  };
};

export const worldToBody = (body: MatterBodyLike, worldPoint: Vector2): Vector2 => {
  const dx = worldPoint.x - body.position.x;
  const dy = worldPoint.y - body.position.y;
  const cos = Math.cos(-body.angle);
  const sin = Math.sin(-body.angle);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
};

/** Скорость точки тела с учётом вращения, в единицах/с. */
export const pointVelocity = (body: MatterBodyLike, worldPoint: Vector2): Vector2 => {
  const rx = worldPoint.x - body.position.x;
  const ry = worldPoint.y - body.position.y;
  const omega = body.angularVelocity * STEPS_PER_SECOND;
  return {
    x: body.velocity.x * STEPS_PER_SECOND - omega * ry,
    y: body.velocity.y * STEPS_PER_SECOND + omega * rx,
  };
};

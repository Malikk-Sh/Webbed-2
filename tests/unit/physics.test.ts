import { describe, expect, it } from 'vitest';
import { collide } from '../../src/engine/physics/Collision';
import { boxBody, circleBody, polygonBody, RigidBody } from '../../src/engine/physics/RigidBody';
import { PhysicsWorld } from '../../src/engine/physics/PhysicsWorld';

const settle = (world: PhysicsWorld, seconds: number): void => {
  const step = 1 / 60;
  for (let i = 0; i < Math.round(seconds / step); i++) world.step(step);
};

describe('RigidBody', () => {
  it('приводит вершины к центру масс и к обходу по часовой стрелке', () => {
    // Квадрат задан против часовой стрелки на экране и со смещённым центром.
    const body = polygonBody([
      { x: 100, y: 100 },
      { x: 100, y: 200 },
      { x: 200, y: 200 },
      { x: 200, y: 100 },
    ]);

    expect(body.position.x).toBeCloseTo(150, 6);
    expect(body.position.y).toBeCloseTo(150, 6);

    body.markDirty();
    body.updateTransform();
    // Внешние нормали должны смотреть наружу: верхняя грань — вверх экрана.
    const hasUp = body.worldNormals.some((n) => n.y < -0.99);
    const hasDown = body.worldNormals.some((n) => n.y > 0.99);
    const hasLeft = body.worldNormals.some((n) => n.x < -0.99);
    const hasRight = body.worldNormals.some((n) => n.x > 0.99);
    expect([hasUp, hasDown, hasLeft, hasRight]).toEqual([true, true, true, true]);
  });

  it('считает момент инерции прямоугольника по классической формуле', () => {
    const body = boxBody(0, 0, 60, 40, { mass: 3 });
    expect(body.inertia).toBeCloseTo((3 * (60 * 60 + 40 * 40)) / 12, 4);
  });

  it('переводит локальные координаты в мировые и обратно', () => {
    const body = boxBody(120, -40, 10, 10, { angle: 0.7 });
    const world = body.toWorld({ x: 3, y: -5 });
    const local = body.toLocal(world);
    expect(local.x).toBeCloseTo(3, 6);
    expect(local.y).toBeCloseTo(-5, 6);
  });

  it('даёт скорость точки с учётом вращения', () => {
    const body = boxBody(0, 0, 10, 10);
    body.setVelocity(100, 0);
    body.setAngularVelocity(2);
    const velocity = body.velocityAt({ x: 0, y: -10 });
    // ω × r для r = (0,-10) и ω = 2 даёт (+20, 0).
    expect(velocity.x).toBeCloseTo(120, 6);
    expect(velocity.y).toBeCloseTo(0, 6);
  });
});

describe('обнаружение столкновений', () => {
  it('находит нормаль и глубину для перекрывающихся прямоугольников', () => {
    const ground = boxBody(0, 100, 400, 40, { isStatic: true });
    const crate = boxBody(0, 74, 40, 40);
    const manifold = collide(ground, crate);

    expect(manifold).not.toBeNull();
    // Нормаль направлена из A (пол) в B (ящик), то есть вверх экрана.
    expect(manifold!.normal.y).toBeCloseTo(-1, 6);
    // Две точки контакта на плоской грани — иначе ящик качается.
    expect(manifold!.points.length).toBe(2);
    // Верх пола — 80, низ ящика — 94, значит перекрытие ровно 14.
    expect(manifold!.points[0]!.penetration).toBeCloseTo(14, 4);
  });

  it('не находит контакта у разнесённых тел', () => {
    expect(collide(boxBody(0, 0, 10, 10), boxBody(100, 0, 10, 10))).toBeNull();
  });

  it('обрабатывает круг у грани и круг у вершины по-разному', () => {
    const wall = boxBody(0, 0, 100, 100, { isStatic: true });

    const face = collide(wall, circleBody(0, 58, 10));
    expect(face).not.toBeNull();
    expect(face!.normal.x).toBeCloseTo(0, 6);
    expect(face!.normal.y).toBeCloseTo(1, 6);

    // Круг у угла (50, 50): нормаль должна идти по диагонали, а не по грани.
    const corner = collide(wall, circleBody(56, 56, 10));
    expect(corner).not.toBeNull();
    expect(corner!.normal.x).toBeCloseTo(Math.SQRT1_2, 3);
    expect(corner!.normal.y).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('различает круги', () => {
    const manifold = collide(circleBody(0, 0, 10), circleBody(15, 0, 10));
    expect(manifold).not.toBeNull();
    expect(manifold!.normal.x).toBeCloseTo(1, 6);
    expect(manifold!.points[0]!.penetration).toBeCloseTo(5, 6);
  });
});

describe('PhysicsWorld', () => {
  it('свободное падение совпадает с аналитическим решением', () => {
    const world = new PhysicsWorld({ gravityY: 1750 });
    const body = world.add(circleBody(0, 0, 5, { mass: 1 }));
    settle(world, 1);
    // Численное интегрирование Эйлера даёт небольшой избыток; допуск 2%.
    expect(body.position.y).toBeGreaterThan(1750 / 2 - 40);
    expect(body.position.y).toBeLessThan(1750 / 2 + 40);
  });

  it('ящик укладывается на пол и остаётся лежать', () => {
    const world = new PhysicsWorld({ gravityY: 1750 });
    world.add(boxBody(0, 400, 1200, 80, { isStatic: true, friction: 0.6 }));
    const crate = world.add(boxBody(0, 100, 74, 74, { mass: 1.05, friction: 0.45 }));

    settle(world, 3);

    // Верх пола — 360, половина ящика — 37: центр должен встать около 323.
    expect(crate.position.y).toBeGreaterThan(320);
    expect(crate.position.y).toBeLessThan(325);
    expect(Math.abs(crate.velocity.y)).toBeLessThan(5);
    expect(Math.abs(crate.angle)).toBeLessThan(0.02);
  });

  it('ящик не проваливается сквозь пол после падения с высоты', () => {
    const world = new PhysicsWorld({ gravityY: 1750 });
    world.add(boxBody(0, 900, 1200, 80, { isStatic: true }));
    const crate = world.add(boxBody(0, -400, 74, 74, { mass: 1.05 }));

    settle(world, 4);
    expect(crate.position.y).toBeLessThan(870);
    expect(crate.position.y).toBeGreaterThan(810);
  });

  it('статические тела не двигаются от ударов', () => {
    const world = new PhysicsWorld({ gravityY: 1750 });
    const floor = world.add(boxBody(0, 400, 1200, 80, { isStatic: true }));
    world.add(boxBody(0, -600, 74, 74, { mass: 40 }));

    settle(world, 3);
    expect(floor.position.y).toBe(400);
    expect(floor.velocity.x).toBe(0);
    expect(floor.velocity.y).toBe(0);
  });

  it('трение останавливает скользящий ящик', () => {
    const world = new PhysicsWorld({ gravityY: 1750 });
    world.add(boxBody(0, 400, 2000, 80, { isStatic: true, friction: 0.6 }));
    const crate = world.add(boxBody(0, 300, 74, 74, { mass: 1, friction: 0.6 }));

    settle(world, 1);
    crate.setVelocity(400, 0);
    settle(world, 3);

    expect(Math.abs(crate.velocity.x)).toBeLessThan(40);
  });

  it('приложенная сила даёт ожидаемое ускорение', () => {
    const world = new PhysicsWorld();
    const body = world.add(circleBody(0, 0, 5, { mass: 2 }));

    // Сила = масса × ускорение: 2 × 500 должна дать 500 единиц/с² ровно.
    for (let i = 0; i < 60; i++) {
      body.applyForce(body.position, { x: 1000, y: 0 });
      world.step(1 / 60);
    }
    expect(body.velocity.x).toBeCloseTo(500, 0);
  });

  it('стопка из двух ящиков остаётся стоять', () => {
    const world = new PhysicsWorld({ gravityY: 1750 });
    world.add(boxBody(0, 400, 1200, 80, { isStatic: true, friction: 0.6 }));
    const lower = world.add(boxBody(0, 300, 74, 74, { mass: 1, friction: 0.6 }));
    const upper = world.add(boxBody(0, 220, 74, 74, { mass: 1, friction: 0.6 }));

    settle(world, 4);

    expect(upper.position.y).toBeLessThan(lower.position.y - 60);
    expect(Math.abs(upper.velocity.y)).toBeLessThan(6);
  });

  it('игнорирует гравитацию для тел с ignoreGravity', () => {
    const world = new PhysicsWorld({ gravityY: 1750 });
    const body: RigidBody = world.add(circleBody(0, 0, 5, { mass: 1 }));
    body.ignoreGravity = true;
    settle(world, 1);
    expect(body.position.y).toBeCloseTo(0, 6);
  });
});

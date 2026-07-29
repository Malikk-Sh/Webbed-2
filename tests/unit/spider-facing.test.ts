import { describe, expect, it } from 'vitest';
import { rectanglePolygon } from '../../src/core/math/Geometry';
import { circleBody } from '../../src/engine/physics/RigidBody';
import { spiderBodyConfig } from '../../src/app/GameConfig';
import { CollisionWorld } from '../../src/game/physics/CollisionWorld';
import { materials } from '../../src/game/physics/PhysicsMaterials';
import { createInputFrame, type InputFrame } from '../../src/game/input/InputFrame';
import { SpiderController } from '../../src/game/spider/SpiderController';
import { SpiderStateMachine } from '../../src/game/spider/SpiderStateMachine';

/**
 * Комната для проверки разворота: пол снизу, потолок сверху, стена слева.
 * Все три поверхности нужны одновременно — датчик ищет ближайшую, и на
 * отдельных мирах не было бы видно, что он выбирает правильную.
 */
const buildRoom = (): CollisionWorld => {
  const world = new CollisionWorld();
  world.add({ id: 'floor', polygon: rectanglePolygon(0, 600, 1200, 200), material: materials.stone! });
  world.add({ id: 'ceiling', polygon: rectanglePolygon(0, 0, 1200, 200), material: materials.stone! });
  world.add({ id: 'wall', polygon: rectanglePolygon(-200, 0, 200, 800), material: materials.stone! });
  world.rebuildIndex();
  return world;
};

const makeSpider = (world: CollisionWorld): SpiderController =>
  new SpiderController({
    body: circleBody(0, 0, spiderBodyConfig.radius, {
      mass: spiderBodyConfig.mass,
      fixedRotation: true,
    }),
    world,
    state: new SpiderStateMachine(),
  });

const drive = (
  spider: SpiderController,
  input: Partial<InputFrame>,
  steps = 30,
): void => {
  const frame: InputFrame = { ...createInputFrame(), ...input };
  for (let i = 0; i < steps; i++) spider.fixedUpdate(1 / 60, frame, false);
};

/**
 * Куда корпус смотрит на экране.
 *
 * Тело рисуется в системе, повёрнутой на `visualAngle`, поэтому его локальная
 * ось X в мире — это (cos, sin) от угла, а `facing` её переворачивает.
 * Проверять надо именно эту величину: сам по себе знак `facing` ничего не
 * говорит, пока не известна ориентация.
 */
const screenForward = (spider: SpiderController): number =>
  Math.cos(spider.visualAngle) * spider.facing;

describe('разворот корпуса', () => {
  it('на полу смотрит по стику', () => {
    const spider = makeSpider(buildRoom());
    spider.teleport({ x: 600, y: 583 }, { x: 0, y: -1 });

    drive(spider, { moveX: 1 });
    expect(spider.attached).toBe(true);
    expect(screenForward(spider)).toBeGreaterThan(0.9);

    drive(spider, { moveX: -1 });
    expect(screenForward(spider)).toBeLessThan(-0.9);
  });

  it('на потолке смотрит по стику, а не наоборот', () => {
    // Потолок разворачивает локальную ось X: пока знак брался из мировой
    // координаты X, паучиха шла здесь задом наперёд.
    const spider = makeSpider(buildRoom());
    spider.teleport({ x: 600, y: 217 }, { x: 0, y: 1 });

    drive(spider, { moveX: 1 });
    expect(spider.attached).toBe(true);
    expect(Math.abs(spider.visualAngle)).toBeCloseTo(Math.PI, 2);
    expect(screenForward(spider)).toBeGreaterThan(0.9);

    drive(spider, { moveX: -1 });
    expect(screenForward(spider)).toBeLessThan(-0.9);
  });

  it('на стене смотрит по вертикали стика и не дрожит', () => {
    const spider = makeSpider(buildRoom());
    spider.teleport({ x: 17, y: 400 }, { x: 1, y: 0 });

    drive(spider, { moveY: 1 }, 20);
    expect(spider.attached).toBe(true);

    // На стене у касательной мировая координата X около нуля: раньше знак
    // определялся шумом и менялся от кадра к кадру.
    const frame: InputFrame = { ...createInputFrame(), moveY: 1 };
    const seen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      spider.fixedUpdate(1 / 60, frame, false);
      seen.add(spider.facing);
    }
    expect(seen.size).toBe(1);

    // Локальная ось X направлена вниз по экрану — туда же, куда ведёт стик.
    const forwardY = Math.sin(spider.visualAngle) * spider.facing;
    expect(forwardY).toBeGreaterThan(0.9);
  });
});

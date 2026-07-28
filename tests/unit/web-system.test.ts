import { beforeEach, describe, expect, it } from 'vitest';
import { webConfig } from '../../src/app/GameConfig';
import { events } from '../../src/core/events/EventBus';
import { rectanglePolygon } from '../../src/core/math/Geometry';
import { CollisionWorld } from '../../src/game/physics/CollisionWorld';
import { materials } from '../../src/game/physics/PhysicsMaterials';
import { WebSystem, type WebAttachableBody } from '../../src/game/web/WebSystem';

const buildWorld = (): CollisionWorld => {
  const world = new CollisionWorld();
  world.add({
    id: 'floor',
    polygon: rectanglePolygon(0, 500, 2000, 200),
    material: materials.stone!,
  });
  world.rebuildIndex();
  return world;
};

/**
 * Заглушка твёрдого тела: паутине от него нужны только положение, масса и
 * два преобразования. Полный `RigidBody` здесь избыточен и мешал бы задавать
 * телу произвольные координаты между шагами.
 */
const makeBody = (x: number, y: number, mass = 1): WebAttachableBody & { id: number } => ({
  id: 1,
  position: { x, y },
  mass,
  toWorld(local) {
    return { x: this.position.x + local.x, y: this.position.y + local.y };
  },
  velocityAt() {
    return { x: 0, y: 0 };
  },
});

describe('WebSystem', () => {
  let spider = { x: 100, y: 100 };
  let body = makeBody(400, 300);
  let applied: { x: number; y: number }[] = [];
  let web: WebSystem;

  beforeEach(() => {
    spider = { x: 100, y: 100 };
    body = makeBody(400, 300);
    applied = [];
    web = new WebSystem(
      buildWorld(),
      {
        getBody: (id) => (id === body.id ? body : null),
        applyForce: (_id, _point, force) => applied.push({ ...force }),
      },
      { getSpiderPosition: () => spider },
    );
  });

  it('создаёт нить между двумя точками мира', () => {
    const result = web.createStrand({
      start: { type: 'world', point: { x: 0, y: 0 }, surfaceId: 'a' },
      end: { type: 'world', point: { x: 200, y: 0 }, surfaceId: 'b' },
      playerCreated: true,
    });
    expect(result.ok).toBe(true);
    expect(web.graph.strandCount).toBe(1);
    // Число частиц соответствует шагу дискретизации из конфигурации.
    const strand = [...web.graph.allStrands][0]!;
    expect(strand.particleIds.length).toBe(
      Math.round(200 / webConfig.particleSpacing) + 1,
    );
  });

  it('отклоняет слишком короткую нить и не оставляет висячих узлов', () => {
    const result = web.createStrand({
      start: { type: 'world', point: { x: 0, y: 0 }, surfaceId: 'a' },
      end: { type: 'world', point: { x: 5, y: 0 }, surfaceId: 'b' },
      playerCreated: true,
    });
    expect(result).toEqual({ ok: false, reason: 'too-short' });
    expect(web.graph.nodeCount).toBe(0);
  });

  it('отклоняет дубликат между теми же узлами', () => {
    const first = web.createStrand({
      start: { type: 'world', point: { x: 0, y: 0 }, surfaceId: 'a', anchorId: 'a' },
      end: { type: 'world', point: { x: 200, y: 0 }, surfaceId: 'b', anchorId: 'b' },
      playerCreated: true,
    });
    expect(first.ok).toBe(true);
    const second = web.createStrand({
      start: { type: 'world', point: { x: 0, y: 0 }, surfaceId: 'a', anchorId: 'a' },
      end: { type: 'world', point: { x: 200, y: 0 }, surfaceId: 'b', anchorId: 'b' },
      playerCreated: true,
    });
    expect(second).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('соблюдает лимит пользовательских нитей', () => {
    for (let i = 0; i < webConfig.maxPlayerStrands; i++) {
      const result = web.createStrand({
        start: { type: 'world', point: { x: 0, y: i * 10 }, surfaceId: 'a' },
        end: { type: 'world', point: { x: 300, y: i * 10 }, surfaceId: 'b' },
        playerCreated: true,
      });
      expect(result.ok).toBe(true);
    }
    const overflow = web.createStrand({
      start: { type: 'world', point: { x: 0, y: 9999 }, surfaceId: 'a' },
      end: { type: 'world', point: { x: 300, y: 9999 }, surfaceId: 'b' },
      playerCreated: true,
    });
    expect(overflow).toEqual({ ok: false, reason: 'limit-reached' });
  });

  it('рассчитывает натяжение по растяжению относительно длины покоя', () => {
    web.createStrand({
      start: { type: 'world', point: { x: 0, y: 0 }, surfaceId: 'a' },
      end: { type: 'world', point: { x: 260, y: 0 }, surfaceId: 'b' },
      requestedRestLength: 200,
      playerCreated: true,
    });
    web.fixedUpdate(1 / 60);
    const strand = [...web.graph.allStrands][0]!;
    // 260/200 = 1.3 → (1.3 − 1) / (1.52 − 1) ≈ 0.577
    expect(strand.tensionNormalized).toBeCloseTo(0.3 / 0.52, 2);
  });

  it('рвёт нить только после накопления перегрузки', () => {
    web.createStrand({
      start: { type: 'world', point: { x: 0, y: 0 }, surfaceId: 'a' },
      end: { type: 'world', point: { x: 400, y: 0 }, surfaceId: 'b' },
      requestedRestLength: 200,
      playerCreated: true,
    });

    // Один шаг перегрузки нить переживает — это защита от однокадрового рывка.
    web.fixedUpdate(1 / 60);
    expect(web.graph.strandCount).toBe(1);

    let steps = 1;
    while (web.graph.strandCount > 0 && steps < 200) {
      web.fixedUpdate(1 / 60);
      steps++;
    }
    expect(web.graph.strandCount).toBe(0);
    // Задержка разрыва 180 мс ≈ 11 шагов по 1/60 с.
    expect(steps).toBeGreaterThanOrEqual(10);
    expect(steps).toBeLessThanOrEqual(16);
  });

  it('передаёт нагрузку телу только при растяжении', () => {
    web.createStrand({
      start: { type: 'world', point: { x: 400, y: 100 }, surfaceId: 'beam' },
      end: { type: 'body', bodyId: body.id, localOffset: { x: 0, y: -20 } },
      requestedRestLength: 400,
      playerCreated: false,
      scripted: true,
    });

    // Провисшая нить (расстояние 180 < 400) не должна тянуть груз.
    web.fixedUpdate(1 / 60);
    expect(applied.length).toBe(0);

    // Натянутая — тянет вверх, к точке крепления.
    body.position.y = 700;
    applied = [];
    web.fixedUpdate(1 / 60);
    expect(applied.length).toBe(1);
    expect(applied[0]!.y).toBeLessThan(0);
  });

  it('сохраняет и восстанавливает граф', () => {
    web.createStrand({
      start: { type: 'world', point: { x: 0, y: 0 }, surfaceId: 'a' },
      end: { type: 'world', point: { x: 300, y: 40 }, surfaceId: 'b' },
      playerCreated: true,
    });
    const saved = web.serialize();
    expect(saved.strands.length).toBe(1);

    web.reset();
    expect(web.graph.strandCount).toBe(0);

    web.restore(saved);
    expect(web.graph.strandCount).toBe(1);
    const strand = [...web.graph.allStrands][0]!;
    expect(strand.restLength).toBeCloseTo(saved.strands[0]!.restLength, 5);
  });

  it('разрезает ближайшую нить игрока и сообщает событием', () => {
    web.createStrand({
      start: { type: 'world', point: { x: 0, y: 0 }, surfaceId: 'a' },
      end: { type: 'world', point: { x: 300, y: 0 }, surfaceId: 'b' },
      playerCreated: true,
    });
    web.fixedUpdate(1 / 60);

    let cause = '';
    const off = events.on('web:broken', (payload) => {
      cause = payload.cause;
    });
    const cut = web.cutNearestStrand({ x: 150, y: 6 }, 40);
    off();

    expect(cut).not.toBeNull();
    expect(cause).toBe('cut');
    expect(web.graph.strandCount).toBe(0);
  });

  it('усыпляет неподвижную ненагруженную нить', () => {
    web.createStrand({
      start: { type: 'world', point: { x: 0, y: 0 }, surfaceId: 'a' },
      end: { type: 'world', point: { x: 200, y: 0 }, surfaceId: 'b' },
      playerCreated: true,
    });
    for (let i = 0; i < 240; i++) web.fixedUpdate(1 / 60);
    const strand = [...web.graph.allStrands][0]!;
    expect(strand.sleeping).toBe(true);
  });
});

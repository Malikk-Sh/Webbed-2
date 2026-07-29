import { describe, expect, it } from 'vitest';
import { pointInPolygon, rectanglePolygon } from '../../src/core/math/Geometry';
import { CollisionWorld } from '../../src/game/physics/CollisionWorld';
import { materials } from '../../src/game/physics/PhysicsMaterials';
import { WebSystem } from '../../src/game/web/WebSystem';

/**
 * Комната с узким выступом посреди пролёта.
 *
 * Ширина выступа выбрана меньше шага между частицами: именно на такой
 * геометрии нить проходила насквозь, потому что обе соседние частицы
 * оказывались снаружи, а отрезок между ними — внутри.
 */
const buildLedgeWorld = () => {
  const world = new CollisionWorld();
  const ledge = rectanglePolygon(380, 300, 16, 220);
  world.add({ id: 'ledge', polygon: ledge, material: materials.stone! });
  world.rebuildIndex();
  return { world, ledge };
};

const makeWeb = (world: CollisionWorld): WebSystem =>
  new WebSystem(
    world,
    { getBody: () => null, applyForce: () => {} },
    { getSpiderPosition: () => ({ x: 0, y: 0 }) },
  );

describe('нить и геометрия', () => {
  it('ложится на кромку, а не проваливается в неё', () => {
    const { world, ledge } = buildLedgeWorld();
    const web = makeWeb(world);

    // Концы закреплены выше выступа, а длина покоя больше пролёта — нить
    // провисает и ложится на кромку. Именно так она и попадает на углы в игре.
    const created = web.createStrand({
      start: { type: 'world', point: { x: 200, y: 200 }, surfaceId: 'a' },
      end: { type: 'world', point: { x: 600, y: 200 }, surfaceId: 'b' },
      requestedRestLength: 500,
      playerCreated: true,
    });
    expect(created.ok).toBe(true);

    for (let i = 0; i < 180; i++) web.fixedUpdate(1 / 60);

    const strand = [...web.graph.allStrands][0]!;
    let insidePoints = 0;
    let insideMidpoints = 0;

    for (let i = 0; i < strand.particleIds.length; i++) {
      const particle = web.graph.getParticle(strand.particleIds[i]!);
      if (!particle) continue;
      if (pointInPolygon(ledge, particle.position)) insidePoints++;

      const nextId = strand.particleIds[i + 1];
      const next = nextId === undefined ? undefined : web.graph.getParticle(nextId);
      if (!next) continue;
      const mid = {
        x: (particle.position.x + next.position.x) / 2,
        y: (particle.position.y + next.position.y) / 2,
      };
      if (pointInPolygon(ledge, mid)) insideMidpoints++;
    }

    expect(insidePoints, 'частицы внутри камня').toBe(0);
    expect(insideMidpoints, 'середины сегментов внутри камня').toBe(0);
  });

  it('улёгшаяся на кромке нить перестаёт шевелиться', () => {
    const { world } = buildLedgeWorld();
    const web = makeWeb(world);

    web.createStrand({
      start: { type: 'world', point: { x: 200, y: 200 }, surfaceId: 'a' },
      end: { type: 'world', point: { x: 600, y: 200 }, surfaceId: 'b' },
      requestedRestLength: 500,
      playerCreated: true,
    });

    for (let i = 0; i < 300; i++) web.fixedUpdate(1 / 60);

    const strand = [...web.graph.allStrands][0]!;
    const before = strand.particleIds.map((id) => {
      const p = web.graph.getParticle(id)!;
      return { x: p.position.x, y: p.position.y };
    });

    for (let i = 0; i < 30; i++) web.fixedUpdate(1 / 60);

    // Дрожание на углу проявлялось как незатухающие колебания: частица
    // выталкивалась наружу и тут же затягивалась обратно коррекцией длины.
    let drift = 0;
    strand.particleIds.forEach((id, index) => {
      const p = web.graph.getParticle(id)!;
      drift = Math.max(
        drift,
        Math.hypot(p.position.x - before[index]!.x, p.position.y - before[index]!.y),
      );
    });

    expect(drift, 'нить продолжает дёргаться после укладки').toBeLessThan(1.5);
  });
});

describe('выталкивание точки', () => {
  const world = new CollisionWorld();
  world.add({
    id: 'block',
    polygon: rectanglePolygon(0, 0, 200, 200),
    material: materials.stone!,
  });
  world.rebuildIndex();

  it('точка снаружи подтягивается до радиуса', () => {
    const point = { x: 100, y: -1 };
    expect(world.resolvePoint(point, 3)).toBe(true);
    expect(point.y).toBeCloseTo(-3, 5);
  });

  it('точка внутри выходит наружу, как бы глубоко ни сидела', () => {
    // Глубина заведомо больше радиуса: именно здесь прежняя формула давала
    // отрицательный сдвиг и загоняла точку ещё дальше внутрь.
    for (const depth of [1, 5, 20, 60]) {
      const point = { x: 100, y: depth };
      expect(world.resolvePoint(point, 3)).toBe(true);
      expect(point.y, `глубина ${depth}`).toBeLessThanOrEqual(-2.99);
    }
  });

  it('далёкая точка не трогается', () => {
    const point = { x: 100, y: -40 };
    expect(world.resolvePoint(point, 3)).toBe(false);
    expect(point.y).toBe(-40);
  });
});

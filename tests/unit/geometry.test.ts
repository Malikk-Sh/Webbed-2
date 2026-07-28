import { describe, expect, it } from 'vitest';
import {
  closestPointOnPolygon,
  closestPointOnSegment,
  pointInPolygon,
  raycastPolygon,
  rectanglePolygon,
  signedArea,
} from '../../src/core/math/Geometry';

const box = rectanglePolygon(0, 0, 100, 100);

describe('Geometry', () => {
  it('строит прямоугольник по часовой стрелке', () => {
    expect(signedArea(box)).toBeGreaterThan(0);
    expect(box.minX).toBe(0);
    expect(box.maxY).toBe(100);
  });

  it('находит ближайшую точку отрезка', () => {
    const point = closestPointOnSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 });
    expect(point).toEqual({ x: 5, y: 0 });
  });

  it('определяет точки внутри и снаружи', () => {
    expect(pointInPolygon(box, { x: 50, y: 50 })).toBe(true);
    expect(pointInPolygon(box, { x: 150, y: 50 })).toBe(false);
  });

  it('возвращает внешнюю нормаль для точки над верхней гранью', () => {
    const result = closestPointOnPolygon(box, { x: 50, y: -20 });
    expect(result.distance).toBeCloseTo(20, 5);
    expect(result.normal.x).toBeCloseTo(0, 5);
    expect(result.normal.y).toBeCloseTo(-1, 5);
    expect(result.inside).toBe(false);
  });

  it('возвращает отрицательное расстояние внутри тела', () => {
    const result = closestPointOnPolygon(box, { x: 50, y: 90 });
    expect(result.inside).toBe(true);
    expect(result.distance).toBeLessThan(0);
    // Нормаль по-прежнему указывает наружу — по ней выталкивают частицы.
    expect(result.normal.y).toBeCloseTo(1, 5);
  });

  it('на выпуклом углу нормаль поворачивается непрерывно', () => {
    // Ключевое свойство для обхода углов: при движении точки вокруг вершины
    // нормаль не должна прыгать.
    const above = closestPointOnPolygon(box, { x: 99, y: -14 }).normal;
    const diagonal = closestPointOnPolygon(box, { x: 110, y: -10 }).normal;
    const beside = closestPointOnPolygon(box, { x: 114, y: 1 }).normal;

    const angle = (v: { x: number; y: number }) => Math.atan2(v.y, v.x);
    const first = Math.abs(angle(diagonal) - angle(above));
    const second = Math.abs(angle(beside) - angle(diagonal));
    expect(first).toBeLessThan(1);
    expect(second).toBeLessThan(1);
  });

  it('лучевой запрос попадает в ближайшую грань', () => {
    const hit = raycastPolygon(box, { x: 50, y: -50 }, { x: 50, y: 50 });
    expect(hit).not.toBeNull();
    expect(hit!.point.y).toBeCloseTo(0, 5);
    expect(hit!.distance).toBeCloseTo(50, 5);
    expect(hit!.normal.y).toBeCloseTo(-1, 5);
  });

  it('лучевой запрос мимо тела возвращает null', () => {
    expect(raycastPolygon(box, { x: 200, y: -50 }, { x: 200, y: 50 })).toBeNull();
  });
});

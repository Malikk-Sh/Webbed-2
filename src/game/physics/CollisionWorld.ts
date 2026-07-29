import {
  closestPointOnPolygon,
  makePolygon,
  raycastPolygon,
  rectanglePolygon,
  type ClosestPointResult,
  type Polygon,
  type RayHit,
} from '../../core/math/Geometry';
import type { Vector2 } from '../../core/math/Vector2';
import type { LevelGeometry } from '../level/LevelSchema';
import { getMaterial, type PhysicsMaterialDefinition } from './PhysicsMaterials';

export interface CollisionSurface {
  id: string;
  polygon: Polygon;
  material: PhysicsMaterialDefinition;
}

export interface SurfaceQuery {
  surface: CollisionSurface;
  point: Vector2;
  normal: Vector2;
  distance: number;
  inside: boolean;
}

export interface SurfaceRayHit extends RayHit {
  surface: CollisionSurface;
}

/**
 * Статическая геометрия комнаты в виде многоугольников с быстрым доступом
 * по пространственной сетке.
 *
 * Сетка нужна не ради экономии на десятке платформ прототипа, а потому что
 * решатель паутины опрашивает мир для каждой частицы каждый шаг: при 320
 * частицах и шести итерациях перебор всех поверхностей заметен на бюджете.
 */
export class CollisionWorld {
  readonly surfaces: CollisionSurface[] = [];

  private readonly cellSize = 256;
  private readonly grid = new Map<number, number[]>();
  private minCellX = 0;
  private minCellY = 0;

  static fromLevelGeometry(geometry: readonly LevelGeometry[]): CollisionWorld {
    const world = new CollisionWorld();
    for (const item of geometry) {
      if (item.decorative) continue;
      const polygon =
        item.type === 'rectangle'
          ? rectanglePolygon(
              item.x ?? 0,
              item.y ?? 0,
              item.width ?? 0,
              item.height ?? 0,
              ((item.angle ?? 0) * Math.PI) / 180,
            )
          : makePolygon((item.points ?? []).map((p) => ({ x: p.x, y: p.y })));
      world.add({ id: item.id, polygon, material: getMaterial(item.material) });
    }
    world.rebuildIndex();
    return world;
  }

  add(surface: CollisionSurface): void {
    this.surfaces.push(surface);
  }

  rebuildIndex(): void {
    this.grid.clear();
    for (let i = 0; i < this.surfaces.length; i++) {
      const { polygon } = this.surfaces[i]!;
      const x0 = Math.floor(polygon.minX / this.cellSize);
      const x1 = Math.floor(polygon.maxX / this.cellSize);
      const y0 = Math.floor(polygon.minY / this.cellSize);
      const y1 = Math.floor(polygon.maxY / this.cellSize);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = this.cellKey(cx, cy);
          let bucket = this.grid.get(key);
          if (!bucket) {
            bucket = [];
            this.grid.set(key, bucket);
          }
          bucket.push(i);
        }
      }
    }
  }

  private cellKey(cx: number, cy: number): number {
    // Сдвиг избавляет от отрицательных индексов при координатах вне мира.
    return (cx - this.minCellX + 4096) * 16384 + (cy - this.minCellY + 4096);
  }

  /** Индексы поверхностей, чьи ячейки пересекают заданный прямоугольник. */
  private candidatesInRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    out: Set<number>,
  ): void {
    const x0 = Math.floor(minX / this.cellSize);
    const x1 = Math.floor(maxX / this.cellSize);
    const y0 = Math.floor(minY / this.cellSize);
    const y1 = Math.floor(maxY / this.cellSize);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.grid.get(this.cellKey(cx, cy));
        if (!bucket) continue;
        for (const index of bucket) out.add(index);
      }
    }
  }

  private readonly scratch = new Set<number>();

  /**
   * Ближайшая поверхность к точке в пределах радиуса.
   *
   * Именно этот запрос лежит в основе передвижения паучихи: на выпуклом угле
   * ближайшей точкой становится вершина, и нормаль поворачивается непрерывно —
   * переход «пол → стена → потолок» получается без единого частного случая.
   */
  queryClosest(
    position: Vector2,
    radius: number,
    filter?: (surface: CollisionSurface) => boolean,
  ): SurfaceQuery | null {
    this.scratch.clear();
    this.candidatesInRect(
      position.x - radius,
      position.y - radius,
      position.x + radius,
      position.y + radius,
      this.scratch,
    );

    let best: SurfaceQuery | null = null;
    for (const index of this.scratch) {
      const surface = this.surfaces[index]!;
      if (filter && !filter(surface)) continue;
      // Отбраковка по расширенному ограничивающему прямоугольнику.
      const p = surface.polygon;
      if (
        position.x < p.minX - radius ||
        position.x > p.maxX + radius ||
        position.y < p.minY - radius ||
        position.y > p.maxY + radius
      ) {
        continue;
      }
      const result: ClosestPointResult = closestPointOnPolygon(p, position);
      if (result.distance > radius) continue;
      if (!best || result.distance < best.distance) {
        best = {
          surface,
          point: result.point,
          normal: result.normal,
          distance: result.distance,
          inside: result.inside,
        };
      }
    }
    return best;
  }

  /** Ближайшее пересечение луча со статической геометрией. */
  raycast(
    from: Vector2,
    to: Vector2,
    filter?: (surface: CollisionSurface) => boolean,
  ): SurfaceRayHit | null {
    this.scratch.clear();
    this.candidatesInRect(
      Math.min(from.x, to.x),
      Math.min(from.y, to.y),
      Math.max(from.x, to.x),
      Math.max(from.y, to.y),
      this.scratch,
    );

    let best: SurfaceRayHit | null = null;
    for (const index of this.scratch) {
      const surface = this.surfaces[index]!;
      if (filter && !filter(surface)) continue;
      const hit = raycastPolygon(surface.polygon, from, to);
      if (hit && (!best || hit.distance < best.distance)) {
        best = { ...hit, surface };
      }
    }
    return best;
  }

  /** Есть ли между двумя точками сплошная преграда. */
  isBlocked(from: Vector2, to: Vector2): boolean {
    return this.raycast(from, to) !== null;
  }

  /**
   * Выталкивает точку из геометрии. Возвращает `true`, если позиция менялась.
   * Используется частицами паутины, чтобы нити не тонули в платформах.
   *
   * `query.distance` внутри тела отрицательна, а нормаль всегда смотрит
   * наружу, поэтому одно вычитание годится для обоих случаев: снаружи оно
   * добирает недостающее до радиуса, внутри — выталкивает на всю глубину и
   * ещё на радиус сверху. Отдельная ветка для «внутри» была ошибкой: глубже
   * радиуса она давала отрицательный сдвиг и загоняла частицу ещё дальше в
   * камень — отсюда и нити, уходящие за границу объекта.
   */
  resolvePoint(position: Vector2, radius: number): boolean {
    const query = this.queryClosest(position, radius + 2);
    if (!query) return false;
    if (!query.inside && query.distance >= radius) return false;
    const push = radius - query.distance;
    position.x += query.normal.x * push;
    position.y += query.normal.y * push;
    return true;
  }
}

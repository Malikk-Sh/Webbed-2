import { type Vector2, dot, length } from './Vector2';

/**
 * Геометрия уровня хранится как набор выпуклых или простых многоугольников.
 *
 * Собственный набор запросов вместо `Matter.Query` выбран сознательно:
 * паучихе нужны не факты столкновений, а точная ближайшая точка и нормаль
 * поверхности каждый кадр, включая обход углов. Matter такой информации
 * не отдаёт, а лучевые запросы в углах ведут себя нестабильно.
 */
export interface Polygon {
  /** Вершины в порядке обхода. */
  points: Vector2[];
  /** Ограничивающий прямоугольник для быстрой отбраковки. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ClosestPointResult {
  point: Vector2;
  /** Нормаль, направленная наружу многоугольника. */
  normal: Vector2;
  distance: number;
  /** Индекс ребра, на котором лежит ближайшая точка. */
  edgeIndex: number;
  inside: boolean;
}

export interface RayHit {
  point: Vector2;
  normal: Vector2;
  distance: number;
}

export const makePolygon = (points: Vector2[]): Polygon => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { points, minX, minY, maxX, maxY };
};

export const rectanglePolygon = (
  x: number,
  y: number,
  width: number,
  height: number,
  angleRad = 0,
): Polygon => {
  const hw = width / 2;
  const hh = height / 2;
  const cx = x + hw;
  const cy = y + hh;
  const corners: Vector2[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  if (angleRad === 0) {
    return makePolygon(corners.map((c) => ({ x: cx + c.x, y: cy + c.y })));
  }
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return makePolygon(
    corners.map((c) => ({
      x: cx + c.x * cos - c.y * sin,
      y: cy + c.x * sin + c.y * cos,
    })),
  );
};

/**
 * Знаковая площадь (формула шнурования).
 *
 * В экранных координатах (ось Y вниз) положительный знак означает обход по
 * часовой стрелке — именно в таком порядке `rectanglePolygon` перечисляет
 * вершины, и от этого знака зависит направление внешних нормалей.
 */
export const signedArea = (polygon: Polygon): number => {
  const pts = polygon.points;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
};

/** Ближайшая точка отрезка к произвольной точке. */
export const closestPointOnSegment = (a: Vector2, b: Vector2, p: Vector2): Vector2 => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-12) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + abx * t, y: a.y + aby * t };
};

export const pointInPolygon = (polygon: Polygon, p: Vector2): boolean => {
  if (p.x < polygon.minX || p.x > polygon.maxX || p.y < polygon.minY || p.y > polygon.maxY) {
    return false;
  }
  const pts = polygon.points;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const pi = pts[i]!;
    const pj = pts[j]!;
    const intersects =
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y + 1e-12) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
};

/**
 * Ближайшая к точке точка границы многоугольника вместе с внешней нормалью.
 *
 * На выпуклом углу ближайшей оказывается сама вершина, и нормаль плавно
 * поворачивается по мере движения точки — именно это и даёт бесшовный обход
 * углов без специальной обработки «переход стена → потолок».
 */
export const closestPointOnPolygon = (polygon: Polygon, p: Vector2): ClosestPointResult => {
  const pts = polygon.points;
  let bestDistSq = Infinity;
  let bestPoint: Vector2 = { x: p.x, y: p.y };
  let bestEdge = 0;

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const c = closestPointOnSegment(a, b, p);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestPoint = c;
      bestEdge = i;
    }
  }

  const inside = pointInPolygon(polygon, p);
  const dist = Math.sqrt(bestDistSq);

  let normal: Vector2;
  if (dist > 1e-6) {
    const s = inside ? -1 / dist : 1 / dist;
    normal = { x: (p.x - bestPoint.x) * s, y: (p.y - bestPoint.y) * s };
  } else {
    // Точка лежит ровно на границе — берём нормаль ребра.
    normal = edgeNormal(polygon, bestEdge);
  }

  return { point: bestPoint, normal, distance: inside ? -dist : dist, edgeIndex: bestEdge, inside };
};

/** Внешняя нормаль ребра с указанным индексом. */
export const edgeNormal = (polygon: Polygon, edgeIndex: number): Vector2 => {
  const pts = polygon.points;
  const a = pts[edgeIndex % pts.length]!;
  const b = pts[(edgeIndex + 1) % pts.length]!;
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len = Math.sqrt(ex * ex + ey * ey) || 1;
  // Для обхода по часовой стрелке (положительная signedArea) внешняя
  // нормаль — это ребро, повёрнутое на -90°.
  const sign = signedArea(polygon) > 0 ? 1 : -1;
  return { x: (ey / len) * sign, y: (-ex / len) * sign };
};

/** Пересечение отрезка с отрезком. Возвращает параметр t на отрезке [a1, a2]. */
export const segmentIntersection = (
  a1: Vector2,
  a2: Vector2,
  b1: Vector2,
  b2: Vector2,
): number | null => {
  const rx = a2.x - a1.x;
  const ry = a2.y - a1.y;
  const sx = b2.x - b1.x;
  const sy = b2.y - b1.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qpx = b1.x - a1.x;
  const qpy = b1.y - a1.y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
};

/** Лучевой запрос к одному многоугольнику. */
export const raycastPolygon = (polygon: Polygon, from: Vector2, to: Vector2): RayHit | null => {
  // Быстрая отбраковка по ограничивающему прямоугольнику луча.
  const rMinX = Math.min(from.x, to.x);
  const rMaxX = Math.max(from.x, to.x);
  const rMinY = Math.min(from.y, to.y);
  const rMaxY = Math.max(from.y, to.y);
  if (
    rMaxX < polygon.minX ||
    rMinX > polygon.maxX ||
    rMaxY < polygon.minY ||
    rMinY > polygon.maxY
  ) {
    return null;
  }

  const pts = polygon.points;
  let bestT = Infinity;
  let bestEdge = -1;

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const t = segmentIntersection(from, to, a, b);
    if (t !== null && t < bestT) {
      bestT = t;
      bestEdge = i;
    }
  }

  if (bestEdge < 0) return null;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const rayLength = Math.sqrt(dx * dx + dy * dy);
  let normal = edgeNormal(polygon, bestEdge);
  // Нормаль всегда должна смотреть навстречу лучу.
  if (dot(normal, { x: dx, y: dy }) > 0) normal = { x: -normal.x, y: -normal.y };

  return {
    point: { x: from.x + dx * bestT, y: from.y + dy * bestT },
    normal,
    distance: rayLength * bestT,
  };
};

/** Ближайшее пересечение луча со списком многоугольников. */
export const raycastPolygons = (
  polygons: readonly Polygon[],
  from: Vector2,
  to: Vector2,
): { hit: RayHit; index: number } | null => {
  let best: RayHit | null = null;
  let bestIndex = -1;
  for (let i = 0; i < polygons.length; i++) {
    const hit = raycastPolygon(polygons[i]!, from, to);
    if (hit && (!best || hit.distance < best.distance)) {
      best = hit;
      bestIndex = i;
    }
  }
  return best ? { hit: best, index: bestIndex } : null;
};

/** Расстояние от точки до отрезка. */
export const distanceToSegment = (p: Vector2, a: Vector2, b: Vector2): number => {
  const c = closestPointOnSegment(a, b, p);
  return length({ x: p.x - c.x, y: p.y - c.y });
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const rectContains = (rect: Rect, p: Vector2): boolean =>
  p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;

export const rectOverlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

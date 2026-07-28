import type { Vector2 } from '../../core/math/Vector2';
import type { RigidBody } from './RigidBody';

/**
 * Точка контакта.
 *
 * Кроме геометрии здесь хранится состояние решателя. Накопленные импульсы
 * переносятся между кадрами («тёплый старт»): без этого стопка ящиков и
 * лежащий на кнопке груз мелко дрожат, потому что каждый кадр решатель
 * начинает подбирать силу реакции с нуля.
 */
export interface ContactPoint {
  /** Точка на поверхности тела A и тела B в момент построения манифольда. */
  readonly localAnchorA: Vector2;
  readonly localAnchorB: Vector2;
  /** Глубина проникновения в момент построения, > 0. */
  penetration: number;

  normalImpulse: number;
  tangentImpulse: number;

  // Кэш решателя на текущий шаг.
  rax: number;
  ray: number;
  rbx: number;
  rby: number;
  normalMass: number;
  tangentMass: number;
  velocityBias: number;
}

export interface Manifold {
  a: RigidBody;
  b: RigidBody;
  /** Нормаль из A в B, единичная. */
  readonly normal: Vector2;
  points: ContactPoint[];
  friction: number;
  restitution: number;
}

const EPSILON = 1e-6;

const makeContact = (
  a: RigidBody,
  b: RigidBody,
  worldA: Vector2,
  worldB: Vector2,
  penetration: number,
): ContactPoint => ({
  localAnchorA: a.toLocal(worldA),
  localAnchorB: b.toLocal(worldB),
  penetration,
  normalImpulse: 0,
  tangentImpulse: 0,
  rax: 0,
  ray: 0,
  rbx: 0,
  rby: 0,
  normalMass: 0,
  tangentMass: 0,
  velocityBias: 0,
});

export const aabbOverlap = (a: RigidBody, b: RigidBody, margin = 0): boolean =>
  a.aabb.minX - margin <= b.aabb.maxX &&
  a.aabb.maxX + margin >= b.aabb.minX &&
  a.aabb.minY - margin <= b.aabb.maxY &&
  a.aabb.maxY + margin >= b.aabb.minY;

/**
 * Строит манифольд столкновения или возвращает null.
 *
 * Разделяющая ось (SAT) выбрана вместо GJK/EPA не из экономии: все формы в
 * игре — выпуклые многоугольники и круги, для них SAT даёт не только факт
 * пересечения, но и опорную грань, из которой честно вырезаются две точки
 * контакта. Именно две точки не дают ящику качаться на полу, тогда как
 * одноточечный контакт из EPA пришлось бы стабилизировать отдельно.
 */
export const collide = (a: RigidBody, b: RigidBody): Manifold | null => {
  const friction = Math.sqrt(a.friction * b.friction);
  const restitution = Math.max(a.restitution, b.restitution);

  if (a.shape.kind === 'circle' && b.shape.kind === 'circle') {
    return collideCircles(a, b, friction, restitution);
  }
  if (a.shape.kind === 'circle') {
    const manifold = collidePolygonCircle(b, a, friction, restitution);
    return manifold ? flip(manifold) : null;
  }
  if (b.shape.kind === 'circle') {
    return collidePolygonCircle(a, b, friction, restitution);
  }
  return collidePolygons(a, b, friction, restitution);
};

const flip = (manifold: Manifold): Manifold => {
  const swapped: Manifold = {
    a: manifold.b,
    b: manifold.a,
    normal: { x: -manifold.normal.x, y: -manifold.normal.y },
    points: manifold.points.map((point) => ({
      ...point,
      localAnchorA: point.localAnchorB,
      localAnchorB: point.localAnchorA,
    })),
    friction: manifold.friction,
    restitution: manifold.restitution,
  };
  return swapped;
};

// ------------------------------------------------------------------- круги

const collideCircles = (
  a: RigidBody,
  b: RigidBody,
  friction: number,
  restitution: number,
): Manifold | null => {
  if (a.shape.kind !== 'circle' || b.shape.kind !== 'circle') return null;
  const dx = b.position.x - a.position.x;
  const dy = b.position.y - a.position.y;
  const radiusSum = a.shape.radius + b.shape.radius;
  const distanceSquared = dx * dx + dy * dy;
  if (distanceSquared >= radiusSum * radiusSum) return null;

  const distance = Math.sqrt(distanceSquared);
  // Совпавшие центры не задают направления — выталкиваем вверх, чтобы шаг
  // не выродился в деление на ноль.
  const nx = distance > EPSILON ? dx / distance : 0;
  const ny = distance > EPSILON ? dy / distance : -1;
  const penetration = radiusSum - distance;

  const worldA = { x: a.position.x + nx * a.shape.radius, y: a.position.y + ny * a.shape.radius };
  const worldB = { x: b.position.x - nx * b.shape.radius, y: b.position.y - ny * b.shape.radius };

  return {
    a,
    b,
    normal: { x: nx, y: ny },
    points: [makeContact(a, b, worldA, worldB, penetration)],
    friction,
    restitution,
  };
};

// --------------------------------------------------------- круг и полигон

const collidePolygonCircle = (
  poly: RigidBody,
  circle: RigidBody,
  friction: number,
  restitution: number,
): Manifold | null => {
  if (poly.shape.kind !== 'polygon' || circle.shape.kind !== 'circle') return null;
  const radius = circle.shape.radius;
  const centre = circle.position;
  const vertices = poly.worldVertices;
  const normals = poly.worldNormals;
  const count = vertices.length;

  let bestIndex = 0;
  let bestSeparation = -Infinity;
  for (let i = 0; i < count; i++) {
    const n = normals[i]!;
    const v = vertices[i]!;
    const separation = n.x * (centre.x - v.x) + n.y * (centre.y - v.y);
    if (separation > radius) return null;
    if (separation > bestSeparation) {
      bestSeparation = separation;
      bestIndex = i;
    }
  }

  const v1 = vertices[bestIndex]!;
  const v2 = vertices[(bestIndex + 1) % count]!;
  const faceNormal = normals[bestIndex]!;

  let nx = faceNormal.x;
  let ny = faceNormal.y;
  let contactX: number;
  let contactY: number;
  let penetration: number;

  if (bestSeparation < EPSILON) {
    // Центр круга внутри многоугольника: нормаль ближайшей грани — лучшее,
    // что можно взять, а выталкивать надо сразу на весь радиус и глубину.
    contactX = centre.x - nx * radius;
    contactY = centre.y - ny * radius;
    penetration = radius - bestSeparation;
  } else {
    // Область Вороного: середина грани или одна из её вершин. Без этого
    // разделения круг, налетевший на угол, получал бы нормаль грани и
    // «проглатывался» бы вбок вместо честного отскока от угла.
    const ex = v2.x - v1.x;
    const ey = v2.y - v1.y;
    const lengthSquared = ex * ex + ey * ey;
    let t = lengthSquared > EPSILON ? ((centre.x - v1.x) * ex + (centre.y - v1.y) * ey) / lengthSquared : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = v1.x + ex * t;
    const py = v1.y + ey * t;
    const dx = centre.x - px;
    const dy = centre.y - py;
    const distance = Math.hypot(dx, dy);
    if (distance > radius) return null;
    if (distance > EPSILON) {
      nx = dx / distance;
      ny = dy / distance;
    }
    contactX = px;
    contactY = py;
    penetration = radius - distance;
  }

  // Нормаль манифольда идёт из A (многоугольник) в B (круг).
  const worldA = { x: contactX, y: contactY };
  const worldB = { x: centre.x - nx * radius, y: centre.y - ny * radius };

  return {
    a: poly,
    b: circle,
    normal: { x: nx, y: ny },
    points: [makeContact(poly, circle, worldA, worldB, penetration)],
    friction,
    restitution,
  };
};

// ------------------------------------------------------- полигон и полигон

interface FaceQuery {
  index: number;
  separation: number;
}

const findMaximumSeparation = (a: RigidBody, b: RigidBody, out: FaceQuery): void => {
  const vertices = a.worldVertices;
  const normals = a.worldNormals;
  const other = b.worldVertices;

  out.index = 0;
  out.separation = -Infinity;

  for (let i = 0; i < vertices.length; i++) {
    const n = normals[i]!;
    const v = vertices[i]!;
    let minimum = Infinity;
    for (let j = 0; j < other.length; j++) {
      const p = other[j]!;
      const projection = n.x * (p.x - v.x) + n.y * (p.y - v.y);
      if (projection < minimum) minimum = projection;
    }
    if (minimum > out.separation) {
      out.separation = minimum;
      out.index = i;
    }
  }
};

const queryA: FaceQuery = { index: 0, separation: 0 };
const queryB: FaceQuery = { index: 0, separation: 0 };

const collidePolygons = (
  bodyA: RigidBody,
  bodyB: RigidBody,
  friction: number,
  restitution: number,
): Manifold | null => {
  findMaximumSeparation(bodyA, bodyB, queryA);
  if (queryA.separation > 0) return null;
  findMaximumSeparation(bodyB, bodyA, queryB);
  if (queryB.separation > 0) return null;

  // Небольшое предпочтение телу A: без него грань опоры прыгает между
  // телами на почти равных разделениях, а вместе с ней прыгает и нормаль.
  let reference = bodyA;
  let incident = bodyB;
  let referenceIndex = queryA.index;
  let flipped = false;
  if (queryB.separation > queryA.separation + 0.1) {
    reference = bodyB;
    incident = bodyA;
    referenceIndex = queryB.index;
    flipped = true;
  }

  const referenceVertices = reference.worldVertices;
  const referenceNormal = reference.worldNormals[referenceIndex]!;
  const v1 = referenceVertices[referenceIndex]!;
  const v2 = referenceVertices[(referenceIndex + 1) % referenceVertices.length]!;

  // Встречная грань — та, чья нормаль сильнее всего противонаправлена опорной.
  const incidentNormals = incident.worldNormals;
  let incidentIndex = 0;
  let minimumDot = Infinity;
  for (let i = 0; i < incidentNormals.length; i++) {
    const n = incidentNormals[i]!;
    const dot = n.x * referenceNormal.x + n.y * referenceNormal.y;
    if (dot < minimumDot) {
      minimumDot = dot;
      incidentIndex = i;
    }
  }

  const incidentVertices = incident.worldVertices;
  const i1 = incidentVertices[incidentIndex]!;
  const i2 = incidentVertices[(incidentIndex + 1) % incidentVertices.length]!;

  // Отсечение встречной грани боковыми плоскостями опорной.
  const tangentX = referenceNormal.y;
  const tangentY = -referenceNormal.x;
  const sideMinimum = tangentX * v1.x + tangentY * v1.y;
  const sideMaximum = tangentX * v2.x + tangentY * v2.y;
  const low = Math.min(sideMinimum, sideMaximum);
  const high = Math.max(sideMinimum, sideMaximum);

  const clipped = clipSegment(i1, i2, tangentX, tangentY, low, high);
  if (!clipped) return null;

  const offset = referenceNormal.x * v1.x + referenceNormal.y * v1.y;
  const points: ContactPoint[] = [];

  for (const point of clipped) {
    const separation = referenceNormal.x * point.x + referenceNormal.y * point.y - offset;
    if (separation > 0) continue;
    const penetration = -separation;
    // Точка лежит на встречном теле; парная ей точка опорного тела — её
    // проекция на опорную грань.
    const onReference = {
      x: point.x - referenceNormal.x * separation,
      y: point.y - referenceNormal.y * separation,
    };
    const worldA = flipped ? point : onReference;
    const worldB = flipped ? onReference : point;
    points.push(makeContact(bodyA, bodyB, worldA, worldB, penetration));
  }

  if (points.length === 0) return null;

  // Нормаль манифольда всегда направлена из A в B.
  const nx = flipped ? -referenceNormal.x : referenceNormal.x;
  const ny = flipped ? -referenceNormal.y : referenceNormal.y;

  return { a: bodyA, b: bodyB, normal: { x: nx, y: ny }, points, friction, restitution };
};

/** Отсекает отрезок по интервалу вдоль касательной опорной грани. */
const clipSegment = (
  p1: Vector2,
  p2: Vector2,
  tangentX: number,
  tangentY: number,
  low: number,
  high: number,
): Vector2[] | null => {
  const d1 = tangentX * p1.x + tangentY * p1.y;
  const d2 = tangentX * p2.x + tangentY * p2.y;
  const span = d2 - d1;

  let t0 = 0;
  let t1 = 1;

  if (Math.abs(span) < EPSILON) {
    if (d1 < low || d1 > high) return null;
  } else {
    const tLow = (low - d1) / span;
    const tHigh = (high - d1) / span;
    t0 = Math.max(0, Math.min(tLow, tHigh));
    t1 = Math.min(1, Math.max(tLow, tHigh));
    if (t0 > t1) return null;
  }

  return [
    { x: p1.x + (p2.x - p1.x) * t0, y: p1.y + (p2.y - p1.y) * t0 },
    { x: p1.x + (p2.x - p1.x) * t1, y: p1.y + (p2.y - p1.y) * t1 },
  ];
};

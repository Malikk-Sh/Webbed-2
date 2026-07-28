import type { Vector2 } from '../../core/math/Vector2';

export interface Aabb {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type BodyShape =
  | { kind: 'circle'; radius: number }
  | { kind: 'polygon'; vertices: Vector2[] };

export interface BodyOptions {
  label?: string;
  isStatic?: boolean;
  mass?: number;
  friction?: number;
  restitution?: number;
  /** Затухание скорости в воздухе, доля за шаг 1/60 — как в прежнем движке. */
  frictionAir?: number;
  /** Тело не вращается: так задан персонаж. */
  fixedRotation?: boolean;
  angle?: number;
}

let nextBodyId = 1;

/**
 * Твёрдое тело.
 *
 * Все величины хранятся в игровых единицах: скорость — единицы в секунду,
 * ускорение — единицы в секунду в квадрате, сила — масса на ускорение. Это
 * главное отличие от прежнего решения на Matter.js, где скорость измерялась
 * смещением за шаг, а сила — величиной, связанной с ускорением множителем
 * 10⁶. Тот перевод жил в отдельном модуле, регулярно путался и однажды стоил
 * ошибки в тысячу раз: груз улетал за пределы комнаты. Здесь переводить
 * нечего, поэтому и ошибиться негде.
 */
export class RigidBody {
  readonly id = nextBodyId++;
  label: string;

  readonly position: Vector2 = { x: 0, y: 0 };
  readonly velocity: Vector2 = { x: 0, y: 0 };
  angle = 0;
  angularVelocity = 0;

  /** Накопитель сил на шаг; обнуляется интегратором. */
  readonly force: Vector2 = { x: 0, y: 0 };
  torque = 0;

  mass = 1;
  invMass = 1;
  inertia = 1;
  invInertia = 1;

  friction: number;
  restitution: number;
  frictionAir: number;
  isStatic: boolean;
  fixedRotation: boolean;
  /**
   * Тело не притягивается миром. Так задан персонаж: предельная скорость
   * падения, невесомость на стене и сохранение импульса на нити — это правила
   * управления, а не физики, и живут они в контроллере.
   */
  ignoreGravity = false;

  readonly shape: BodyShape;
  /** Вершины в мировых координатах; пересчитываются лениво. */
  readonly worldVertices: Vector2[] = [];
  /** Внешние нормали граней в мировых координатах. */
  readonly worldNormals: Vector2[] = [];
  readonly aabb: Aabb = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  private transformDirty = true;

  constructor(shape: BodyShape, x: number, y: number, options: BodyOptions = {}) {
    this.shape = shape;
    this.label = options.label ?? 'body';
    this.position.x = x;
    this.position.y = y;
    this.angle = options.angle ?? 0;
    this.friction = options.friction ?? 0.4;
    this.restitution = options.restitution ?? 0;
    this.frictionAir = options.frictionAir ?? 0;
    this.isStatic = options.isStatic ?? false;
    this.fixedRotation = options.fixedRotation ?? false;

    if (shape.kind === 'polygon') {
      normalisePolygon(shape.vertices);
      for (let i = 0; i < shape.vertices.length; i++) {
        this.worldVertices.push({ x: 0, y: 0 });
        this.worldNormals.push({ x: 0, y: 0 });
      }
    }

    this.setMass(options.mass ?? defaultMass(shape));
    this.updateTransform();
  }

  setMass(mass: number): void {
    if (this.isStatic) {
      this.mass = Infinity;
      this.invMass = 0;
      this.inertia = Infinity;
      this.invInertia = 0;
      return;
    }
    this.mass = mass;
    this.invMass = mass > 0 ? 1 / mass : 0;
    if (this.fixedRotation) {
      this.inertia = Infinity;
      this.invInertia = 0;
    } else {
      this.inertia = shapeInertia(this.shape, mass);
      this.invInertia = this.inertia > 0 ? 1 / this.inertia : 0;
    }
  }

  setPosition(x: number, y: number): void {
    this.position.x = x;
    this.position.y = y;
    this.transformDirty = true;
  }

  setAngle(angle: number): void {
    this.angle = angle;
    this.transformDirty = true;
  }

  setVelocity(x: number, y: number): void {
    this.velocity.x = x;
    this.velocity.y = y;
  }

  setAngularVelocity(value: number): void {
    this.angularVelocity = value;
  }

  /** Сила приложена в мировой точке: даёт и ускорение, и момент. */
  applyForce(point: Vector2, force: Vector2): void {
    if (this.isStatic) return;
    this.force.x += force.x;
    this.force.y += force.y;
    this.torque += (point.x - this.position.x) * force.y - (point.y - this.position.y) * force.x;
  }

  applyImpulse(point: Vector2, impulseX: number, impulseY: number): void {
    if (this.isStatic) return;
    this.velocity.x += impulseX * this.invMass;
    this.velocity.y += impulseY * this.invMass;
    this.angularVelocity +=
      this.invInertia *
      ((point.x - this.position.x) * impulseY - (point.y - this.position.y) * impulseX);
  }

  toWorld(local: Vector2, out: Vector2 = { x: 0, y: 0 }): Vector2 {
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    out.x = this.position.x + local.x * cos - local.y * sin;
    out.y = this.position.y + local.x * sin + local.y * cos;
    return out;
  }

  toLocal(world: Vector2, out: Vector2 = { x: 0, y: 0 }): Vector2 {
    const dx = world.x - this.position.x;
    const dy = world.y - this.position.y;
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    out.x = dx * cos + dy * sin;
    out.y = -dx * sin + dy * cos;
    return out;
  }

  /** Скорость точки тела с учётом вращения, единицы/с. */
  velocityAt(world: Vector2, out: Vector2 = { x: 0, y: 0 }): Vector2 {
    const rx = world.x - this.position.x;
    const ry = world.y - this.position.y;
    out.x = this.velocity.x - this.angularVelocity * ry;
    out.y = this.velocity.y + this.angularVelocity * rx;
    return out;
  }

  markDirty(): void {
    this.transformDirty = true;
  }

  updateTransform(): void {
    if (!this.transformDirty) return;
    this.transformDirty = false;

    if (this.shape.kind === 'circle') {
      const r = this.shape.radius;
      this.aabb.minX = this.position.x - r;
      this.aabb.minY = this.position.y - r;
      this.aabb.maxX = this.position.x + r;
      this.aabb.maxY = this.position.y + r;
      return;
    }

    const local = this.shape.vertices;
    const count = local.length;
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < count; i++) {
      const source = local[i]!;
      const target = this.worldVertices[i]!;
      target.x = this.position.x + source.x * cos - source.y * sin;
      target.y = this.position.y + source.x * sin + source.y * cos;
      if (target.x < minX) minX = target.x;
      if (target.y < minY) minY = target.y;
      if (target.x > maxX) maxX = target.x;
      if (target.y > maxY) maxY = target.y;
    }

    for (let i = 0; i < count; i++) {
      const current = this.worldVertices[i]!;
      const next = this.worldVertices[(i + 1) % count]!;
      const ex = next.x - current.x;
      const ey = next.y - current.y;
      const inverseLength = 1 / (Math.hypot(ex, ey) || 1);
      // Обход вершин по часовой стрелке на экране, поэтому внешняя нормаль
      // грани — это (ey, -ex). Направление зафиксировано `normalisePolygon`.
      const normal = this.worldNormals[i]!;
      normal.x = ey * inverseLength;
      normal.y = -ex * inverseLength;
    }

    this.aabb.minX = minX;
    this.aabb.minY = minY;
    this.aabb.maxX = maxX;
    this.aabb.maxY = maxY;
  }
}

/**
 * Приводит многоугольник к обходу по часовой стрелке на экране и к центру
 * масс в начале координат. Оба свойства нужны дальше: по первому строятся
 * внешние нормали, по второму считается момент инерции и вращение.
 */
const normalisePolygon = (vertices: Vector2[]): void => {
  let doubleArea = 0;
  let cx = 0;
  let cy = 0;
  const count = vertices.length;

  for (let i = 0; i < count; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % count]!;
    const cross = a.x * b.y - b.x * a.y;
    doubleArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }

  // Центроид считается по знаковой площади: у числителя и знаменателя знак
  // одинаковый, поэтому результат от направления обхода не зависит. Поэтому
  // сдвиг к центру масс делается до разворота, а не после.
  if (Math.abs(doubleArea) > 1e-9) {
    cx /= 3 * doubleArea;
    cy /= 3 * doubleArea;
    for (const vertex of vertices) {
      vertex.x -= cx;
      vertex.y -= cy;
    }
  }

  // Отрицательная площадь — обход против часовой стрелки на экране; разворот
  // приводит его к принятому здесь направлению, из которого выводятся нормали.
  if (doubleArea < 0) vertices.reverse();
};

const polygonArea = (vertices: Vector2[]): number => {
  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
};

const defaultMass = (shape: BodyShape): number => {
  // Плотность подобрана так, чтобы ящик 74×74 весил около единицы — на этих
  // числах настроены пороги напольной кнопки и прочность нитей.
  const density = 0.0002;
  const area =
    shape.kind === 'circle' ? Math.PI * shape.radius * shape.radius : polygonArea(shape.vertices);
  return Math.max(0.05, area * density);
};

const shapeInertia = (shape: BodyShape, mass: number): number => {
  if (shape.kind === 'circle') return 0.5 * mass * shape.radius * shape.radius;

  // Момент инерции произвольного выпуклого многоугольника относительно
  // центра масс: сумма по треугольникам (0, a, b).
  let numerator = 0;
  let denominator = 0;
  const vertices = shape.vertices;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    const cross = Math.abs(a.x * b.y - b.x * a.y);
    numerator += cross * (a.x * a.x + a.x * b.x + b.x * b.x + a.y * a.y + a.y * b.y + b.y * b.y);
    denominator += cross;
  }
  if (denominator === 0) return mass;
  return (mass / 6) * (numerator / denominator);
};

/** Прямоугольник с центром в (x, y). */
export const boxBody = (
  x: number,
  y: number,
  width: number,
  height: number,
  options: BodyOptions = {},
): RigidBody => {
  const hw = width / 2;
  const hh = height / 2;
  return new RigidBody(
    {
      kind: 'polygon',
      vertices: [
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
        { x: hw, y: hh },
        { x: -hw, y: hh },
      ],
    },
    x,
    y,
    options,
  );
};

export const circleBody = (
  x: number,
  y: number,
  radius: number,
  options: BodyOptions = {},
): RigidBody => new RigidBody({ kind: 'circle', radius }, x, y, options);

/** Многоугольник по мировым вершинам: центр масс становится позицией тела. */
export const polygonBody = (
  points: readonly Vector2[],
  options: BodyOptions = {},
): RigidBody => {
  const vertices = points.map((point) => ({ x: point.x, y: point.y }));
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    cx = vertices.reduce((sum, v) => sum + v.x, 0) / vertices.length;
    cy = vertices.reduce((sum, v) => sum + v.y, 0) / vertices.length;
  } else {
    cx /= 3 * area;
    cy /= 3 * area;
  }
  for (const vertex of vertices) {
    vertex.x -= cx;
    vertex.y -= cy;
  }
  return new RigidBody({ kind: 'polygon', vertices }, cx, cy, options);
};

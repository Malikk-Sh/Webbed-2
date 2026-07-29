import { aabbOverlap, collide, type ContactPoint, type Manifold } from './Collision';
import type { RigidBody } from './RigidBody';

export interface PhysicsWorldOptions {
  gravityX?: number;
  gravityY?: number;
  velocityIterations?: number;
  positionIterations?: number;
}

/** Допустимое взаимопроникновение: без него тела дрожат на границе контакта. */
const PENETRATION_SLOP = 0.4;
/** Доля глубины, устраняемая за одну позиционную итерацию. */
const POSITION_CORRECTION = 0.35;
/** Предел за итерацию — иначе глубоко вложенные тела выстреливают. */
const MAXIMUM_CORRECTION = 6;
/** Ниже этой скорости сближения отскок не начисляется: тело должно улечься. */
const RESTITUTION_THRESHOLD = 60;
/** Потолок скорости, единицы/с: страховка от туннелирования на срывах. */
const MAXIMUM_SPEED = 6000;

/**
 * Мир твёрдых тел: широкая фаза, узкая фаза и последовательный импульсный
 * решатель.
 *
 * Масштаб задачи здесь скромный — комната держит около полутора десятков тел,
 * из которых динамических три. Поэтому широкая фаза честно перебирает пары:
 * при таком N дерево или сетка стоили бы дороже самой проверки, а вся
 * пространственная индексация уже есть в `CollisionWorld`, который отвечает
 * на запросы паучихи и паутины.
 *
 * Решатель — последовательные импульсы с тёплым стартом и раздельной
 * позиционной коррекцией. Это тот же класс алгоритма, что стоял за прежним
 * движком, но без перевода единиц: скорость измеряется в единицах в секунду,
 * а не в смещении за шаг.
 */
export class PhysicsWorld {
  readonly bodies: RigidBody[] = [];
  gravityX: number;
  gravityY: number;

  private readonly velocityIterations: number;
  private readonly positionIterations: number;

  /** Манифольды прошлого шага — источник накопленных импульсов. */
  private previous = new Map<number, Manifold>();
  private current = new Map<number, Manifold>();
  private readonly active: Manifold[] = [];

  constructor(options: PhysicsWorldOptions = {}) {
    this.gravityX = options.gravityX ?? 0;
    this.gravityY = options.gravityY ?? 0;
    this.velocityIterations = options.velocityIterations ?? 8;
    this.positionIterations = options.positionIterations ?? 3;
  }

  add(body: RigidBody): RigidBody {
    this.bodies.push(body);
    return body;
  }

  remove(body: RigidBody): void {
    const index = this.bodies.indexOf(body);
    if (index >= 0) this.bodies.splice(index, 1);
  }

  /** Число пар в контакте — для панели диагностики. */
  get contactCount(): number {
    return this.active.length;
  }

  step(deltaSeconds: number): void {
    if (deltaSeconds <= 0) return;

    this.integrateForces(deltaSeconds);
    this.buildContacts();
    this.prepareContacts();
    this.warmStart();

    for (let i = 0; i < this.velocityIterations; i++) this.solveVelocities();

    this.integrateVelocities(deltaSeconds);

    for (let i = 0; i < this.positionIterations; i++) this.solvePositions();

    for (const body of this.bodies) {
      body.force.x = 0;
      body.force.y = 0;
      body.torque = 0;
      body.updateTransform();
    }
  }

  // -------------------------------------------------------------- интеграция

  private integrateForces(dt: number): void {
    for (const body of this.bodies) {
      if (body.isStatic) continue;

      const gravityX = body.ignoreGravity ? 0 : this.gravityX;
      const gravityY = body.ignoreGravity ? 0 : this.gravityY;
      body.velocity.x += (gravityX + body.force.x * body.invMass) * dt;
      body.velocity.y += (gravityY + body.force.y * body.invMass) * dt;
      body.angularVelocity += body.torque * body.invInertia * dt;

      if (body.frictionAir > 0) {
        // Затухание задано долей за шаг 1/60 — так эти числа были подобраны
        // на слух и на глаз, и менять их при переходе не хотелось.
        const damping = Math.pow(1 - body.frictionAir, dt * 60);
        body.velocity.x *= damping;
        body.velocity.y *= damping;
        body.angularVelocity *= damping;
      }

      const speed = Math.hypot(body.velocity.x, body.velocity.y);
      if (speed > MAXIMUM_SPEED) {
        const scale = MAXIMUM_SPEED / speed;
        body.velocity.x *= scale;
        body.velocity.y *= scale;
      }
    }
  }

  private integrateVelocities(dt: number): void {
    for (const body of this.bodies) {
      if (body.isStatic) continue;
      body.setPosition(
        body.position.x + body.velocity.x * dt,
        body.position.y + body.velocity.y * dt,
      );
      if (!body.fixedRotation) body.setAngle(body.angle + body.angularVelocity * dt);
      body.updateTransform();
    }
  }

  // ------------------------------------------------------------ поиск пар

  private buildContacts(): void {
    for (const body of this.bodies) body.updateTransform();

    this.active.length = 0;
    const next = this.current;
    next.clear();

    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i]!;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j]!;
        if (a.isStatic && b.isStatic) continue;
        if (!aabbOverlap(a, b)) continue;

        const manifold = collide(a, b);
        if (!manifold) continue;

        // Порядок тел в паре задан порядком в списке, поэтому ключ устойчив
        // между кадрами — на этом и держится перенос импульсов.
        const key = a.id * 100003 + b.id;
        const old = this.previous.get(key);
        if (old) transferImpulses(old, manifold);
        next.set(key, manifold);
        this.active.push(manifold);
      }
    }

    const swap = this.previous;
    this.previous = next;
    this.current = swap;
  }

  // -------------------------------------------------------------- решатель

  private prepareContacts(): void {
    for (const manifold of this.active) {
      const { a, b, normal } = manifold;
      const tangentX = normal.y;
      const tangentY = -normal.x;

      for (const contact of manifold.points) {
        const pa = a.toWorld(contact.localAnchorA);
        const pb = b.toWorld(contact.localAnchorB);
        const rax = pa.x - a.position.x;
        const ray = pa.y - a.position.y;
        const rbx = pb.x - b.position.x;
        const rby = pb.y - b.position.y;

        contact.rax = rax;
        contact.ray = ray;
        contact.rbx = rbx;
        contact.rby = rby;

        contact.normalMass = effectiveMass(a, b, rax, ray, rbx, rby, normal.x, normal.y);
        contact.tangentMass = effectiveMass(a, b, rax, ray, rbx, rby, tangentX, tangentY);

        const relativeX =
          b.velocity.x - b.angularVelocity * rby - (a.velocity.x - a.angularVelocity * ray);
        const relativeY =
          b.velocity.y + b.angularVelocity * rbx - (a.velocity.y + a.angularVelocity * rax);
        const approach = relativeX * normal.x + relativeY * normal.y;

        // Отскок начисляется только на заметном сближении: иначе лежащее
        // тело каждый кадр получает крошечный импульс и вибрирует.
        contact.velocityBias =
          approach < -RESTITUTION_THRESHOLD ? -manifold.restitution * approach : 0;
      }
    }
  }

  private warmStart(): void {
    for (const manifold of this.active) {
      const { a, b, normal } = manifold;
      const tangentX = normal.y;
      const tangentY = -normal.x;

      for (const contact of manifold.points) {
        const impulseX = normal.x * contact.normalImpulse + tangentX * contact.tangentImpulse;
        const impulseY = normal.y * contact.normalImpulse + tangentY * contact.tangentImpulse;
        applyImpulse(a, b, contact, -impulseX, -impulseY);
      }
    }
  }

  private solveVelocities(): void {
    for (const manifold of this.active) {
      const { a, b, normal } = manifold;
      const tangentX = normal.y;
      const tangentY = -normal.x;

      for (const contact of manifold.points) {
        // Трение решается первым: его предел зависит от нормального импульса
        // прошлой итерации, и такой порядок даёт заметно устойчивее контакт
        // ящика с полом, чем обратный.
        let relativeX =
          b.velocity.x - b.angularVelocity * contact.rby -
          (a.velocity.x - a.angularVelocity * contact.ray);
        let relativeY =
          b.velocity.y + b.angularVelocity * contact.rbx -
          (a.velocity.y + a.angularVelocity * contact.rax);

        const tangentSpeed = relativeX * tangentX + relativeY * tangentY;
        const maximumFriction = manifold.friction * contact.normalImpulse;
        const desiredTangent = contact.tangentImpulse - contact.tangentMass * tangentSpeed;
        const clampedTangent = Math.max(
          -maximumFriction,
          Math.min(maximumFriction, desiredTangent),
        );
        const tangentDelta = clampedTangent - contact.tangentImpulse;
        contact.tangentImpulse = clampedTangent;
        applyImpulse(a, b, contact, -tangentX * tangentDelta, -tangentY * tangentDelta);

        relativeX =
          b.velocity.x - b.angularVelocity * contact.rby -
          (a.velocity.x - a.angularVelocity * contact.ray);
        relativeY =
          b.velocity.y + b.angularVelocity * contact.rbx -
          (a.velocity.y + a.angularVelocity * contact.rax);

        const normalSpeed = relativeX * normal.x + relativeY * normal.y;
        const desiredNormal =
          contact.normalImpulse - contact.normalMass * (normalSpeed - contact.velocityBias);
        const clampedNormal = Math.max(0, desiredNormal);
        const normalDelta = clampedNormal - contact.normalImpulse;
        contact.normalImpulse = clampedNormal;
        applyImpulse(a, b, contact, -normal.x * normalDelta, -normal.y * normalDelta);
      }
    }
  }

  /**
   * Позиционная коррекция отдельным проходом.
   *
   * Разделение скоростной и позиционной задач принципиально: если возвращать
   * тела на место импульсом (схема Баумгарта в скоростном проходе), лишняя
   * энергия остаётся в системе и глубоко вложенные тела выпрыгивают. Здесь
   * положение правится напрямую, а скорость не трогается.
   */
  private solvePositions(): void {
    for (const manifold of this.active) {
      const { a, b, normal } = manifold;
      if (a.invMass === 0 && b.invMass === 0) continue;

      for (const contact of manifold.points) {
        const pa = a.toWorld(contact.localAnchorA);
        const pb = b.toWorld(contact.localAnchorB);
        const separation = (pb.x - pa.x) * normal.x + (pb.y - pa.y) * normal.y;
        if (separation >= -PENETRATION_SLOP) continue;

        const rax = pa.x - a.position.x;
        const ray = pa.y - a.position.y;
        const rbx = pb.x - b.position.x;
        const rby = pb.y - b.position.y;

        const mass = effectiveMass(a, b, rax, ray, rbx, rby, normal.x, normal.y);
        const correction = Math.max(
          -MAXIMUM_CORRECTION,
          POSITION_CORRECTION * (separation + PENETRATION_SLOP),
        );
        const impulse = -mass * correction;

        if (!a.isStatic) {
          a.setPosition(
            a.position.x - normal.x * impulse * a.invMass,
            a.position.y - normal.y * impulse * a.invMass,
          );
          if (!a.fixedRotation) {
            a.setAngle(a.angle - a.invInertia * (rax * normal.y - ray * normal.x) * impulse);
          }
        }
        if (!b.isStatic) {
          b.setPosition(
            b.position.x + normal.x * impulse * b.invMass,
            b.position.y + normal.y * impulse * b.invMass,
          );
          if (!b.fixedRotation) {
            b.setAngle(b.angle + b.invInertia * (rbx * normal.y - rby * normal.x) * impulse);
          }
        }
      }
    }

    for (const body of this.bodies) if (!body.isStatic) body.updateTransform();
  }
}

const effectiveMass = (
  a: RigidBody,
  b: RigidBody,
  rax: number,
  ray: number,
  rbx: number,
  rby: number,
  nx: number,
  ny: number,
): number => {
  const crossA = rax * ny - ray * nx;
  const crossB = rbx * ny - rby * nx;
  const sum =
    a.invMass + b.invMass + a.invInertia * crossA * crossA + b.invInertia * crossB * crossB;
  return sum > 0 ? 1 / sum : 0;
};

const applyImpulse = (
  a: RigidBody,
  b: RigidBody,
  contact: ContactPoint,
  impulseX: number,
  impulseY: number,
): void => {
  if (!a.isStatic) {
    a.velocity.x += impulseX * a.invMass;
    a.velocity.y += impulseY * a.invMass;
    a.angularVelocity += a.invInertia * (contact.rax * impulseY - contact.ray * impulseX);
  }
  if (!b.isStatic) {
    b.velocity.x -= impulseX * b.invMass;
    b.velocity.y -= impulseY * b.invMass;
    b.angularVelocity -= b.invInertia * (contact.rbx * impulseY - contact.rby * impulseX);
  }
};

/**
 * Переносит накопленные импульсы со старого манифольда на новый.
 *
 * Точки сопоставляются по положению в локальной системе первого тела: за один
 * кадр контакт смещается на доли единицы, поэтому ближайшая точка — почти
 * наверняка та же самая. Порядковый номер для этого не годится: отсечение
 * встречной грани может выдать точки в другом порядке.
 */
const transferImpulses = (old: Manifold, next: Manifold): void => {
  const toleranceSquared = 4;
  for (const contact of next.points) {
    for (const previous of old.points) {
      const dx = previous.localAnchorA.x - contact.localAnchorA.x;
      const dy = previous.localAnchorA.y - contact.localAnchorA.y;
      if (dx * dx + dy * dy > toleranceSquared) continue;
      contact.normalImpulse = previous.normalImpulse;
      contact.tangentImpulse = previous.tangentImpulse;
      break;
    }
  }
};

import { plateConfig } from '../../app/GameConfig';
import { events } from '../../core/events/EventBus';
import { clamp, damp, easeOutCubic } from '../../core/math/Interpolation';
import type { Vector2 } from '../../core/math/Vector2';
import { boxBody, circleBody, type RigidBody } from '../../engine/physics/RigidBody';
import type { PhysicsWorld } from '../../engine/physics/PhysicsWorld';

export interface RigidBodySnapshot {
  x: number;
  y: number;
  angle: number;
}

export interface DynamicObject {
  readonly id: string;
  readonly body: RigidBody;
  snapshot(): RigidBodySnapshot;
  restore(snapshot: RigidBodySnapshot): void;
}

const restoreBody = (body: RigidBody, snapshot: RigidBodySnapshot): void => {
  body.setPosition(snapshot.x, snapshot.y);
  body.setAngle(snapshot.angle);
  body.setVelocity(0, 0);
  body.setAngularVelocity(0);
  body.force.x = 0;
  body.force.y = 0;
  body.torque = 0;
  body.updateTransform();
};

/** Лёгкий ящик: главный инструмент решения задачи с дверью. */
export class DynamicCrate implements DynamicObject {
  readonly body: RigidBody;
  readonly width: number;
  readonly height: number;
  private readonly initial: RigidBodySnapshot;

  constructor(
    readonly id: string,
    world: PhysicsWorld,
    x: number,
    y: number,
    width: number,
    height: number,
    mass: number,
  ) {
    this.width = width;
    this.height = height;
    this.body = world.add(
      boxBody(x, y, width, height, {
        mass,
        friction: 0.45,
        frictionAir: 0.012,
        restitution: 0.05,
        label: `crate:${id}`,
      }),
    );
    this.initial = { x, y, angle: 0 };
  }

  snapshot(): RigidBodySnapshot {
    return { x: this.body.position.x, y: this.body.position.y, angle: this.body.angle };
  }

  restore(snapshot: RigidBodySnapshot = this.initial): void {
    restoreBody(this.body, snapshot);
  }
}

/** Подвешенный груз: тяжелее ящика, изначально висит на сюжетной нити. */
export class HangingWeight implements DynamicObject {
  readonly body: RigidBody;
  readonly radius: number;
  readonly anchor: Vector2;
  readonly restLength: number;
  private readonly initial: RigidBodySnapshot;

  constructor(
    readonly id: string,
    world: PhysicsWorld,
    x: number,
    y: number,
    radius: number,
    mass: number,
    anchor: Vector2,
    restLength: number,
    /** Можно ли перерезать подвес — этим комната задаёт свою головоломку. */
    readonly cuttable = false,
  ) {
    this.radius = radius;
    this.anchor = anchor;
    this.restLength = restLength;
    this.body = world.add(
      circleBody(x, y, radius, {
        mass,
        friction: 0.5,
        frictionAir: 0.02,
        restitution: 0.02,
        label: `weight:${id}`,
      }),
    );
    this.initial = { x, y, angle: 0 };
  }

  snapshot(): RigidBodySnapshot {
    return { x: this.body.position.x, y: this.body.position.y, angle: this.body.angle };
  }

  restore(snapshot: RigidBodySnapshot = this.initial): void {
    restoreBody(this.body, snapshot);
  }
}

/**
 * Напольная кнопка: суммирует массу тел, лежащих на площадке.
 *
 * Задержки включения и выключения обязательны: без них подпрыгивающий на
 * пружине ящик заставляет дверь мигать несколько раз в секунду.
 */
export class PressurePlate {
  active = false;
  currentMass = 0;
  /** 0..1 — насколько площадка вдавлена; используется визуализацией. */
  depression = 0;

  private timerMs = 0;
  private readonly height = 18;

  constructor(
    readonly id: string,
    readonly x: number,
    /** Y верхней грани площадки. */
    readonly surfaceY: number,
    readonly width: number,
    readonly activationMass: number,
  ) {}

  fixedUpdate(deltaSeconds: number, bodies: readonly RigidBody[]): void {
    const halfWidth = this.width / 2;
    let mass = 0;

    for (const body of bodies) {
      if (body.isStatic) continue;
      const aabb = body.aabb;
      const overlapsX = aabb.maxX > this.x - halfWidth && aabb.minX < this.x + halfWidth;
      if (!overlapsX) continue;
      // Тело считается лежащим, если его низ находится у поверхности кнопки.
      const restingY = aabb.maxY;
      if (restingY < this.surfaceY - this.height - 6 || restingY > this.surfaceY + 26) continue;
      if (Math.abs(body.velocity.y) > 260) continue;
      mass += body.mass;
    }

    this.currentMass = mass;
    const shouldBeActive = mass >= this.activationMass;
    const deltaMs = deltaSeconds * 1000;

    if (shouldBeActive !== this.active) {
      this.timerMs += deltaMs;
      const threshold = shouldBeActive
        ? plateConfig.activationDelayMs
        : plateConfig.deactivationDelayMs;
      if (this.timerMs >= threshold) {
        this.active = shouldBeActive;
        this.timerMs = 0;
        events.emit('object:plate-changed', {
          plateId: this.id,
          active: this.active,
          mass,
        });
      }
    } else {
      this.timerMs = 0;
    }

    const target = clamp(mass / Math.max(this.activationMass, 0.001), 0, 1.2);
    this.depression = damp(this.depression, Math.min(1, target), 0.12, deltaSeconds);
  }

  isActive(): boolean {
    return this.active;
  }

  reset(): void {
    this.active = false;
    this.currentMass = 0;
    this.depression = 0;
    this.timerMs = 0;
  }
}

/**
 * Шёлковый бутон — необязательный сбор.
 *
 * Нужен ровно затем, чтобы у украшенных закоулков появилась причина туда
 * лезть: без цели декорации остаются фоном, мимо которого пробегают по
 * кратчайшей траектории. Физического тела у бутона нет — он собирается по
 * расстоянию до героини, и потому не влияет ни на решатель, ни на кнопки.
 */
export class SilkBloom {
  collected = false;
  /** 0..1 — раскрытие при сборе, для вспышки и растворения. */
  bloom = 0;
  readonly phase: number;

  constructor(
    readonly id: string,
    readonly x: number,
    readonly y: number,
    readonly radius = 30,
  ) {
    // Фаза покачивания берётся из координат: одинаковые бутоны, дышащие в
    // такт, сразу выдают, что их поставил цикл.
    this.phase = (x * 0.013 + y * 0.021) % (Math.PI * 2);
  }

  update(deltaSeconds: number): void {
    if (!this.collected || this.bloom >= 1) return;
    this.bloom = Math.min(1, this.bloom + deltaSeconds * 2.6);
  }

  /** Возвращает true только в тот кадр, когда бутон действительно собран. */
  tryCollect(position: Vector2): boolean {
    if (this.collected) return false;
    const dx = position.x - this.x;
    const dy = position.y - this.y;
    if (dx * dx + dy * dy > this.radius * this.radius) return false;
    this.collected = true;
    return true;
  }

  reset(): void {
    this.collected = false;
    this.bloom = 0;
  }
}

export type DoorState = 'Closed' | 'Opening' | 'Open' | 'Closing';

/**
 * Дверь прототипа. Коллайдер уезжает вместе с визуальной панелью, поэтому
 * промежуточные состояния физически честны: сквозь наполовину открытую
 * дверь пролезть нельзя.
 */
export class PrototypeDoor {
  state: DoorState = 'Closed';
  /** 0 — закрыта, 1 — полностью открыта. */
  openness = 0;

  readonly body: RigidBody;

  constructor(
    readonly id: string,
    world: PhysicsWorld,
    readonly x: number,
    readonly y: number,
    readonly width: number,
    readonly height: number,
    readonly controlledBy: string,
  ) {
    this.body = world.add(
      boxBody(x + width / 2, y + height / 2, width, height, {
        isStatic: true,
        label: `door:${id}`,
      }),
    );
  }

  fixedUpdate(deltaSeconds: number, shouldOpen: boolean): void {
    const speed = shouldOpen ? 1.35 : 1.9;
    const target = shouldOpen ? 1 : 0;
    const previous = this.openness;

    if (this.openness < target) this.openness = Math.min(target, this.openness + speed * deltaSeconds);
    else if (this.openness > target) this.openness = Math.max(target, this.openness - speed * deltaSeconds);

    const nextState: DoorState =
      this.openness >= 1 ? 'Open' : this.openness <= 0 ? 'Closed' : shouldOpen ? 'Opening' : 'Closing';

    if (nextState !== this.state) {
      this.state = nextState;
      events.emit('object:door-changed', { doorId: this.id, state: this.state });
    }

    if (previous !== this.openness) {
      const offset = easeOutCubic(this.openness) * (this.height + 6);
      this.body.setPosition(this.x + this.width / 2, this.y + this.height / 2 - offset);
      this.body.updateTransform();
    }
  }

  /** Смещение панели вверх для отрисовки. */
  get visualOffset(): number {
    return easeOutCubic(this.openness) * (this.height + 6);
  }

  reset(): void {
    this.openness = 0;
    this.state = 'Closed';
    this.body.setPosition(this.x + this.width / 2, this.y + this.height / 2);
    this.body.updateTransform();
  }
}

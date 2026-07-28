import Phaser from 'phaser';
import { plateConfig } from '../../app/GameConfig';
import { events } from '../../core/events/EventBus';
import { clamp, damp, easeOutCubic } from '../../core/math/Interpolation';
import type { Vector2 } from '../../core/math/Vector2';
import { MatterLib } from '../physics/MatterLib';
import { getVelocity } from '../physics/MatterUnits';

export interface RigidBodySnapshot {
  x: number;
  y: number;
  angle: number;
}

export interface DynamicObject {
  readonly id: string;
  readonly body: MatterJS.BodyType;
  snapshot(): RigidBodySnapshot;
  restore(snapshot: RigidBodySnapshot): void;
}

/** Лёгкий ящик: главный инструмент решения задачи с дверью. */
export class DynamicCrate implements DynamicObject {
  readonly body: MatterJS.BodyType;
  readonly width: number;
  readonly height: number;
  private readonly initial: RigidBodySnapshot;

  constructor(
    readonly id: string,
    world: Phaser.Physics.Matter.World,
    x: number,
    y: number,
    width: number,
    height: number,
    mass: number,
  ) {
    this.width = width;
    this.height = height;
    this.body = MatterLib.Bodies.rectangle(x, y, width, height, {
      friction: 0.45,
      frictionAir: 0.012,
      restitution: 0.05,
      label: `crate:${id}`,
      chamfer: { radius: 6 },
    });
    MatterLib.Body.setMass(this.body, mass);
    MatterLib.Composite.add(world.localWorld, this.body);
    this.initial = { x, y, angle: 0 };
  }

  snapshot(): RigidBodySnapshot {
    return { x: this.body.position.x, y: this.body.position.y, angle: this.body.angle };
  }

  restore(snapshot: RigidBodySnapshot = this.initial): void {
    MatterLib.Body.setPosition(this.body, { x: snapshot.x, y: snapshot.y });
    MatterLib.Body.setAngle(this.body, snapshot.angle);
    MatterLib.Body.setVelocity(this.body, { x: 0, y: 0 });
    MatterLib.Body.setAngularVelocity(this.body, 0);
  }
}

/** Подвешенный груз: тяжелее ящика, изначально висит на сюжетной нити. */
export class HangingWeight implements DynamicObject {
  readonly body: MatterJS.BodyType;
  readonly radius: number;
  readonly anchor: Vector2;
  readonly restLength: number;
  private readonly initial: RigidBodySnapshot;

  constructor(
    readonly id: string,
    world: Phaser.Physics.Matter.World,
    x: number,
    y: number,
    radius: number,
    mass: number,
    anchor: Vector2,
    restLength: number,
  ) {
    this.radius = radius;
    this.anchor = anchor;
    this.restLength = restLength;
    this.body = MatterLib.Bodies.circle(x, y, radius, {
      friction: 0.5,
      frictionAir: 0.02,
      restitution: 0.02,
      label: `weight:${id}`,
    });
    MatterLib.Body.setMass(this.body, mass);
    MatterLib.Composite.add(world.localWorld, this.body);
    this.initial = { x, y, angle: 0 };
  }

  snapshot(): RigidBodySnapshot {
    return { x: this.body.position.x, y: this.body.position.y, angle: this.body.angle };
  }

  restore(snapshot: RigidBodySnapshot = this.initial): void {
    MatterLib.Body.setPosition(this.body, { x: snapshot.x, y: snapshot.y });
    MatterLib.Body.setAngle(this.body, snapshot.angle);
    MatterLib.Body.setVelocity(this.body, { x: 0, y: 0 });
    MatterLib.Body.setAngularVelocity(this.body, 0);
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

  fixedUpdate(deltaSeconds: number, bodies: readonly MatterJS.BodyType[]): void {
    const halfWidth = this.width / 2;
    let mass = 0;

    for (const body of bodies) {
      if (body.isStatic) continue;
      const bounds = body.bounds;
      const overlapsX = bounds.max.x > this.x - halfWidth && bounds.min.x < this.x + halfWidth;
      if (!overlapsX) continue;
      // Тело считается лежащим, если его низ находится у поверхности кнопки.
      const restingY = bounds.max.y;
      if (restingY < this.surfaceY - this.height - 6 || restingY > this.surfaceY + 26) continue;
      const velocity = getVelocity(body);
      if (Math.abs(velocity.y) > 260) continue;
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

  readonly body: MatterJS.BodyType;

  constructor(
    readonly id: string,
    world: Phaser.Physics.Matter.World,
    readonly x: number,
    readonly y: number,
    readonly width: number,
    readonly height: number,
    readonly controlledBy: string,
  ) {
    this.body = MatterLib.Bodies.rectangle(
      x + width / 2,
      y + height / 2,
      width,
      height,
      { isStatic: true, label: `door:${id}` },
    );
    MatterLib.Composite.add(world.localWorld, this.body);
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
      MatterLib.Body.setPosition(this.body, {
        x: this.x + this.width / 2,
        y: this.y + this.height / 2 - offset,
      });
    }
  }

  /** Смещение панели вверх для отрисовки. */
  get visualOffset(): number {
    return easeOutCubic(this.openness) * (this.height + 6);
  }

  reset(): void {
    this.openness = 0;
    this.state = 'Closed';
    MatterLib.Body.setPosition(this.body, {
      x: this.x + this.width / 2,
      y: this.y + this.height / 2,
    });
  }
}

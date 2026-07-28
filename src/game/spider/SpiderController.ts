import {
  spiderBodyConfig,
  spiderMovementConfig,
  surfaceAttachmentConfig,
} from '../../app/GameConfig';
import { events } from '../../core/events/EventBus';
import { clamp, damp } from '../../core/math/Interpolation';
import { dot, length, normalize, type Vector2 } from '../../core/math/Vector2';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { MatterLib } from '../physics/MatterLib';
import { getVelocity, velocityToMatter } from '../physics/MatterUnits';
import type { InputFrame } from '../input/InputFrame';
import { SpiderStateMachine } from './SpiderStateMachine';
import { SpiderSurfaceSensor, type SurfaceContact } from './SpiderSurfaceSensor';

export interface SpiderControllerDeps {
  body: MatterJS.BodyType;
  world: CollisionWorld;
  state: SpiderStateMachine;
}

/**
 * Движение паучихи: сцепление с поверхностью, бег по любой стороне
 * геометрии, прыжок с помощью игроку и управление в воздухе.
 *
 * Скорость задаётся напрямую, а не через силы Matter. Для персонажа, которым
 * управляет игрок, это единственный способ получить одинаковый отклик на
 * камне, металле и потолке — интегратор Matter иначе размазывает ускорение
 * по-разному в зависимости от накопленной скорости.
 */
export class SpiderController {
  readonly sensor: SpiderSurfaceSensor;

  /** Скорость в единицах/с. Синхронизируется с телом на каждом шаге. */
  readonly velocity: Vector2 = { x: 0, y: 0 };

  attached = false;
  contact: SurfaceContact | null = null;

  /** Сглаженный визуальный угол корпуса. */
  visualAngle = 0;
  /** Точка крепления активной нити — задаётся сценой для ориентации корпуса. */
  tetherAnchor: Vector2 | null = null;
  /** Насколько герой «сжат» после удара, 0..1 — читает визуализация. */
  landingSquash = 0;
  /** Скорость последнего удара о поверхность. */
  lastImpactSpeed = 0;
  /** Мгновенное ускорение — визуализация наклоняет корпус по нему. */
  readonly smoothedAcceleration: Vector2 = { x: 0, y: 0 };

  private readonly body: MatterJS.BodyType;
  private readonly state: SpiderStateMachine;

  private coyoteMs = 0;
  private jumpBufferMs = 0;
  private jumpHoldMs = 0;
  private jumping = false;
  private detachCooldownMs = 0;
  private stunMs = 0;
  private controlLockMs = 0;
  private distanceTravelled = 0;
  private stepAccumulator = 0;
  /** Направление взгляда: +1 вправо вдоль касательной, -1 влево. */
  facing = 1;

  constructor(deps: SpiderControllerDeps) {
    this.body = deps.body;
    this.state = deps.state;
    this.sensor = new SpiderSurfaceSensor(deps.world);
    // Гравитация применяется вручную: так работают предельная скорость
    // падения, невесомость на стене и сохранение импульса на нити.
    this.body.ignoreGravity = true;
  }

  get position(): Vector2 {
    return { x: this.body.position.x, y: this.body.position.y };
  }

  get speed(): number {
    return length(this.velocity);
  }

  get isStunned(): boolean {
    return this.stunMs > 0;
  }

  get canControl(): boolean {
    return this.controlLockMs <= 0 && this.stunMs <= 0;
  }

  teleport(position: Vector2, normal: Vector2): void {
    MatterLib.Body.setPosition(this.body, { x: position.x, y: position.y });
    MatterLib.Body.setVelocity(this.body, { x: 0, y: 0 });
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.attached = true;
    this.contact = null;
    this.sensor.reset(normal);
    this.visualAngle = Math.atan2(normal.x, -normal.y);
    this.coyoteMs = spiderMovementConfig.coyoteTimeMs;
    this.jumpBufferMs = 0;
    this.jumping = false;
    this.detachCooldownMs = 0;
    this.stunMs = 0;
    this.controlLockMs = 0;
    this.landingSquash = 0;
  }

  setControlLock(ms: number): void {
    this.controlLockMs = Math.max(this.controlLockMs, ms);
  }

  /** Принудительный отрыв от поверхности — используется выпуском нити. */
  detachFromSurface(cooldownMs = spiderMovementConfig.jumpDetachCooldownMs): void {
    if (this.attached) {
      this.attached = false;
      events.emit('spider:detached', { position: this.position });
    }
    this.detachCooldownMs = Math.max(this.detachCooldownMs, cooldownMs);
    this.state.request('Airborne');
  }

  setVelocity(velocity: Vector2): void {
    this.velocity.x = velocity.x;
    this.velocity.y = velocity.y;
    MatterLib.Body.setVelocity(this.body, velocityToMatter(velocity));
  }

  /** Записывает текущую скорость в тело — после ручных правок вектора. */
  syncVelocityToBody(): void {
    MatterLib.Body.setVelocity(this.body, velocityToMatter(this.velocity));
  }

  /**
   * Сдвиг позиции без изменения скорости. Нужен проекционному ограничению
   * нити: маятник корректирует положение, но не гасит движение по дуге.
   */
  teleportRelative(dx: number, dy: number): void {
    MatterLib.Body.setPosition(this.body, {
      x: this.body.position.x + dx,
      y: this.body.position.y + dy,
    });
  }

  addVelocity(delta: Vector2): void {
    this.setVelocity({ x: this.velocity.x + delta.x, y: this.velocity.y + delta.y });
  }

  /** Основной шаг. Вызывается с фиксированным шагом до обновления Matter. */
  fixedUpdate(deltaSeconds: number, input: InputFrame, tethered: boolean): void {
    const deltaMs = deltaSeconds * 1000;
    const previousVelocity = { x: this.velocity.x, y: this.velocity.y };

    // Matter мог изменить скорость столкновением с ящиком — читаем актуальную.
    const current = getVelocity(this.body);
    this.velocity.x = current.x;
    this.velocity.y = current.y;

    this.detachCooldownMs = Math.max(0, this.detachCooldownMs - deltaMs);
    this.stunMs = Math.max(0, this.stunMs - deltaMs);
    this.controlLockMs = Math.max(0, this.controlLockMs - deltaMs);
    this.landingSquash = damp(this.landingSquash, 0, 0.09, deltaSeconds);

    const contact = this.sensor.update(this.position, this.attached, deltaSeconds);
    this.contact = contact;

    const allowAttach = this.detachCooldownMs <= 0 && !tethered;
    this.updateAttachment(contact, allowAttach, deltaMs);

    if (input.jumpPressed) this.jumpBufferMs = spiderMovementConfig.jumpBufferMs;
    else this.jumpBufferMs = Math.max(0, this.jumpBufferMs - deltaMs);

    if (this.attached && contact) {
      this.moveOnSurface(contact, input, deltaSeconds);
      this.coyoteMs = spiderMovementConfig.coyoteTimeMs;
    } else {
      this.moveInAir(input, deltaSeconds, tethered);
      this.coyoteMs = Math.max(0, this.coyoteMs - deltaMs);
    }

    this.tryJump(input, contact);
    this.updateJumpHold(input, deltaSeconds);

    this.applyVelocityToBody();
    this.resolvePenetration();
    this.updateVisualAngle(contact, deltaSeconds, tethered);
    this.updateStepEvents(deltaSeconds);

    // Сглаженное ускорение нужно визуализации: по нему корпус наклоняется
    // в сторону разгона, а ноги слегка отстают.
    const ax = (this.velocity.x - previousVelocity.x) / Math.max(deltaSeconds, 1e-4);
    const ay = (this.velocity.y - previousVelocity.y) / Math.max(deltaSeconds, 1e-4);
    this.smoothedAcceleration.x = damp(this.smoothedAcceleration.x, ax, 0.08, deltaSeconds);
    this.smoothedAcceleration.y = damp(this.smoothedAcceleration.y, ay, 0.08, deltaSeconds);
  }

  // ------------------------------------------------------------ сцепление

  private updateAttachment(
    contact: SurfaceContact | null,
    allowAttach: boolean,
    _deltaMs: number,
  ): void {
    if (!contact) {
      if (this.attached) {
        this.attached = false;
        this.state.request('Airborne');
      }
      return;
    }

    const gap = contact.distance - surfaceAttachmentConfig.targetDistance;

    if (this.attached) {
      if (gap > spiderMovementConfig.surfaceDetachDistance) {
        this.attached = false;
        this.state.request('Airborne');
      }
      return;
    }

    if (!allowAttach) return;
    if (gap > spiderMovementConfig.surfaceSnapDistance) return;

    // Направление подлёта: цепляемся, только если герой действительно
    // приближается к поверхности либо почти остановился рядом с ней.
    const approach = -dot(this.velocity, contact.rawNormal);
    if (length(this.velocity) > 60 && approach < -40) return;

    // Жёсткость приземления определяет только составляющая по нормали:
    // быстрый пробег вдоль стены — не удар.
    this.attach(contact, Math.max(0, approach));
  }

  private attach(contact: SurfaceContact, impactSpeed: number): void {
    this.attached = true;
    this.lastImpactSpeed = impactSpeed;

    // Нормальная составляющая гасится всегда, касательная сохраняется —
    // приземление на бегу не должно съедать разгон.
    const normalSpeed = dot(this.velocity, contact.rawNormal);
    this.velocity.x -= contact.rawNormal.x * normalSpeed;
    this.velocity.y -= contact.rawNormal.y * normalSpeed;

    const hard = impactSpeed > spiderMovementConfig.maxAttachSpeed;
    this.landingSquash = clamp(impactSpeed / 900, 0.15, 1);

    if (hard) {
      // Жёсткое столкновение: короткая потеря управления и заметная отдача
      // вместо полного отскока — иначе почти любое падение в комнате
      // превращалось бы в неудачу.
      const overshoot = impactSpeed - spiderMovementConfig.maxAttachSpeed;
      this.stunMs = clamp(100 + overshoot * 0.22, 100, 260);
      this.velocity.x *= 0.35;
      this.velocity.y *= 0.35;
      this.state.request('Stunned', { lockMs: this.stunMs });
      events.emit('camera:shake', {
        strength: clamp(overshoot / 900, 0.1, 0.6),
        durationMs: 220,
      });
    } else {
      this.state.request('SurfaceAttach', { lockMs: 40 });
    }

    this.jumping = false;
    events.emit('spider:landed', {
      position: this.position,
      normal: contact.rawNormal,
      impactSpeed,
    });
  }

  // ------------------------------------------------------------ по поверхности

  private moveOnSurface(contact: SurfaceContact, input: InputFrame, deltaSeconds: number): void {
    const friction = contact.material.surfaceFriction;
    const control = this.canControl ? 1 : 0;

    // Направление вдоль поверхности выбирается по горизонтали стика:
    // мир не поворачивается вместе с героем, поэтому «вправо» на стике
    // всегда означает «вправо на экране» (раздел 10.1 концепта).
    const desired: Vector2 = { x: input.moveX * control, y: input.moveY * control };
    const base = { x: -contact.normal.y, y: contact.normal.x };
    let along = dot(base, desired);

    // Стик задаёт направление на экране, а не относительно героя: движение —
    // это проекция стика на касательную. Особый случай один — стик направлен
    // прямо в поверхность. Тогда проекция нулевая, и удержание «вправо» у
    // стены не давало бы ничего; в этом случае герой продолжает идти в ту же
    // сторону и естественно въезжает на стену.
    const desiredLength = Math.hypot(desired.x, desired.y);
    if (desiredLength > 0.05) {
      const intoSurface = -dot(desired, contact.normal) / desiredLength;
      if (intoSurface > 0.3) {
        const carry = this.sensor.facing * desiredLength * intoSurface;
        if (Math.abs(carry) > Math.abs(along)) along = carry;
      }
    }
    along = clamp(along, -1, 1);

    if (Math.abs(along) > 0.02) {
      this.sensor.alignTangent({ x: base.x * Math.sign(along), y: base.y * Math.sign(along) });
      this.facing = base.x * Math.sign(along) >= 0 ? 1 : -1;
    }

    const tangent = { x: base.x, y: base.y };
    const tangentialSpeed = dot(this.velocity, tangent);
    const normalSpeed = dot(this.velocity, contact.normal);

    const targetSpeed = along * spiderMovementConfig.surfaceMaxSpeed * friction;

    let acceleration: number;
    if (Math.abs(along) < 0.02) {
      acceleration = spiderMovementConfig.surfaceDeceleration;
    } else if (tangentialSpeed * targetSpeed < 0) {
      acceleration = spiderMovementConfig.surfaceTurnAcceleration;
    } else {
      acceleration = spiderMovementConfig.surfaceAcceleration;
    }
    acceleration *= friction;

    const step = acceleration * deltaSeconds;
    let newTangential = tangentialSpeed;
    if (newTangential < targetSpeed) newTangential = Math.min(targetSpeed, newTangential + step);
    else if (newTangential > targetSpeed) newTangential = Math.max(targetSpeed, newTangential - step);

    // Сцепление: пружина с демпфером вдоль нормали (раздел 11.3 ТЗ).
    const error = contact.distance - surfaceAttachmentConfig.targetDistance;
    let normalAcceleration =
      -error * surfaceAttachmentConfig.snapStrength - normalSpeed * surfaceAttachmentConfig.snapDamping;
    normalAcceleration = clamp(
      normalAcceleration,
      -surfaceAttachmentConfig.maximumSnapForce,
      surfaceAttachmentConfig.maximumSnapForce,
    );
    const newNormal = normalSpeed + normalAcceleration * deltaSeconds;

    this.velocity.x = tangent.x * newTangential + contact.normal.x * newNormal;
    this.velocity.y = tangent.y * newTangential + contact.normal.y * newNormal;

    if (Math.abs(newTangential) > 12) this.state.request('SurfaceMove');
    else this.state.request('SurfaceIdle');
  }

  // ------------------------------------------------------------------ в воздухе

  private moveInAir(input: InputFrame, deltaSeconds: number, tethered: boolean): void {
    const control = this.canControl ? 1 : 0;

    this.velocity.y += spiderMovementConfig.gravity * deltaSeconds;
    if (this.velocity.y > spiderMovementConfig.maxFallSpeed) {
      this.velocity.y = spiderMovementConfig.maxFallSpeed;
    }

    const desired = input.moveX * control;
    if (Math.abs(desired) > 0.02) {
      const target = desired * spiderMovementConfig.airMaxSpeed;
      const step = spiderMovementConfig.airAcceleration * deltaSeconds;
      // Импульс раскачивания не срезается: разгон выше воздушного предела
      // сохраняется, ускорять сверх предела просто нельзя.
      if (Math.abs(this.velocity.x) <= spiderMovementConfig.airMaxSpeed || desired * this.velocity.x < 0) {
        if (this.velocity.x < target) this.velocity.x = Math.min(target, this.velocity.x + step);
        else if (this.velocity.x > target) this.velocity.x = Math.max(target, this.velocity.x - step);
      }
      this.facing = desired >= 0 ? 1 : -1;
    }

    if (!tethered) this.state.request('Airborne');
  }

  // ---------------------------------------------------------------- прыжок

  private tryJump(input: InputFrame, contact: SurfaceContact | null): void {
    if (this.jumpBufferMs <= 0) return;
    if (!this.canControl) return;
    const grounded = this.attached || this.coyoteMs > 0;
    if (!grounded) return;

    const normal = contact?.normal ?? { x: 0, y: -1 };
    const share = spiderMovementConfig.jumpNormalShare;
    const stick = normalize({ x: input.moveX, y: input.moveY });

    // С потолка «прыжок» — это отпускание, а не толчок: полный импульс вниз
    // превращал бы любой спуск в жёсткое падение. Множитель плавно меняется
    // от 1 на полу до 0.34 на потолке.
    const upness = -normal.y;
    const normalScale = 0.34 + 0.66 * ((upness + 1) / 2);

    const power = spiderMovementConfig.jumpVelocity;
    const jumpX = normal.x * share * power * normalScale + stick.x * (1 - share) * power;
    const jumpY = normal.y * share * power * normalScale + stick.y * (1 - share) * power;

    // Составляющая скорости вдоль нормали заменяется, касательная остаётся:
    // разбег переходит в дальность прыжка.
    const tangent = { x: -normal.y, y: normal.x };
    const tangentialSpeed = dot(this.velocity, tangent);
    this.velocity.x = tangent.x * tangentialSpeed + jumpX;
    this.velocity.y = tangent.y * tangentialSpeed + jumpY;

    this.jumpBufferMs = 0;
    this.coyoteMs = 0;
    this.jumping = true;
    this.jumpHoldMs = 0;
    this.attached = false;
    this.detachCooldownMs = spiderMovementConfig.jumpDetachCooldownMs;
    this.landingSquash = -0.35;
    this.state.request('JumpStart', { lockMs: 60 });

    events.emit('spider:jumped', { position: this.position, normal, power });
  }

  private updateJumpHold(input: InputFrame, deltaSeconds: number): void {
    if (!this.jumping) return;
    this.jumpHoldMs += deltaSeconds * 1000;

    if (input.jumpHeld && this.jumpHoldMs < spiderMovementConfig.jumpHoldDurationMs) {
      // Пока кнопка удерживается, часть гравитации компенсируется —
      // высота прыжка растёт плавно, без второго импульса.
      this.velocity.y -= spiderMovementConfig.gravity * 0.42 * deltaSeconds;
      return;
    }

    if (!input.jumpHeld) {
      if (this.velocity.y < 0) this.velocity.y *= spiderMovementConfig.jumpReleaseMultiplier;
      this.jumping = false;
    } else if (this.jumpHoldMs >= spiderMovementConfig.jumpHoldDurationMs) {
      this.jumping = false;
    }
  }

  // ------------------------------------------------------------------ прочее

  private applyVelocityToBody(): void {
    if (!Number.isFinite(this.velocity.x) || !Number.isFinite(this.velocity.y)) {
      this.velocity.x = 0;
      this.velocity.y = 0;
      console.warn('[SpiderController] Некорректная скорость сброшена');
    }
    MatterLib.Body.setVelocity(this.body, velocityToMatter(this.velocity));
  }

  /** Страховка от проникновения в геометрию на большой скорости. */
  private resolvePenetration(): void {
    const position = { x: this.body.position.x, y: this.body.position.y };
    const query = this.sensor.probeAttach(position, spiderBodyConfig.radius);
    if (!query || (!query.inside && query.distance >= spiderBodyConfig.radius - 0.5)) return;
    const push = query.inside
      ? spiderBodyConfig.radius + Math.abs(query.distance)
      : spiderBodyConfig.radius - query.distance;
    MatterLib.Body.setPosition(this.body, {
      x: position.x + query.normal.x * push,
      y: position.y + query.normal.y * push,
    });
  }

  /**
   * Ориентация корпуса.
   *
   * Угол задаётся так, чтобы локальная ось «вверх» (0, -1) совпала с опорной
   * нормалью: `atan2(n.x, -n.y)`. На полу это ноль, на левой стене −90°,
   * на потолке 180° — мир при этом не вращается, вращается только Люма.
   */
  private updateVisualAngle(
    contact: SurfaceContact | null,
    deltaSeconds: number,
    tethered: boolean,
  ): void {
    let up: Vector2;

    if (this.attached && contact) {
      up = contact.normal;
    } else if (tethered && this.tetherAnchor) {
      // На нити Люма висит «макушкой» к точке крепления.
      const dx = this.tetherAnchor.x - this.body.position.x;
      const dy = this.tetherAnchor.y - this.body.position.y;
      const len = Math.hypot(dx, dy) || 1;
      up = { x: dx / len, y: dy / len };
    } else {
      // В свободном падении герой разворачивается брюшком вниз, слегка
      // наклоняясь по направлению полёта.
      const speed = length(this.velocity);
      const tilt = speed > 40 ? clamp(this.velocity.x / 900, -0.4, 0.4) : 0;
      up = { x: tilt, y: -1 };
    }

    const targetAngle = Math.atan2(up.x, -up.y);
    const smoothTime = this.attached ? 0.06 : 0.16;
    const delta = wrapAngle(targetAngle - this.visualAngle);
    this.visualAngle = damp(this.visualAngle, this.visualAngle + delta, smoothTime, deltaSeconds);
  }

  private updateStepEvents(deltaSeconds: number): void {
    if (!this.attached) {
      this.stepAccumulator = 0;
      return;
    }
    const speed = length(this.velocity);
    if (speed < 25) return;
    this.distanceTravelled += speed * deltaSeconds;
    this.stepAccumulator += speed * deltaSeconds;
    if (this.stepAccumulator >= 46) {
      this.stepAccumulator = 0;
      events.emit('spider:step', { position: this.position, speed });
    }
  }

  get travelledDistance(): number {
    return this.distanceTravelled;
  }
}

const wrapAngle = (value: number): number => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

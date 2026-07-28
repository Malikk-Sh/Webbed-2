import {
  aimConfig,
  spiderBodyConfig,
  tetherConfig,
  webConfig,
} from '../../app/GameConfig';
import { events } from '../../core/events/EventBus';
import { clamp, clamp01 } from '../../core/math/Interpolation';
import {
  angleDelta,
  angleOf,
  distance,
  dot,
  length,
  normalize,
  type Vector2,
} from '../../core/math/Vector2';
import type { InputFrame } from '../input/InputFrame';
import type { AnchorPoint } from '../level/PrototypeLevelLoader';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { worldToBody } from '../physics/MatterUnits';
import type { WebSystem } from '../web/WebSystem';
import type { WebAttachmentTarget } from '../web/WebTypes';
import type { SpiderController } from './SpiderController';
import type { SpiderStateMachine } from './SpiderStateMachine';

export type AimTargetKind = 'anchor' | 'surface' | 'body' | 'none';

export interface AimPreview {
  active: boolean;
  origin: Vector2;
  direction: Vector2;
  /** Точка, к которой прикрепится нить. */
  target: Vector2 | null;
  kind: AimTargetKind;
  /** Крепление возможно. */
  valid: boolean;
  /** Цель найдена помощью прицеливания, а не прямым лучом. */
  assisted: boolean;
  distance: number;
  anchorId: string | null;
}

interface AimCandidate {
  point: Vector2;
  kind: AimTargetKind;
  score: number;
  assisted: boolean;
  anchorId: string | null;
  bodyId: number | null;
  distance: number;
}

export interface WebControllerDeps {
  web: WebSystem;
  spider: SpiderController;
  state: SpiderStateMachine;
  collision: CollisionWorld;
  anchors: AnchorPoint[];
  /** Динамические тела, к которым разрешено крепить нить. */
  getAttachableBodies: () => MatterJS.BodyType[];
  aimAssistStrength: () => number;
  slowMotionEnabled: () => boolean;
}

/**
 * Прицеливание, выпуск нити, раскачивание и работа с активной нитью.
 *
 * Активная нить героя удерживается жёстким проекционным ограничением, а не
 * пружиной. Это ключевое решение для ощущения: маятник сохраняет касательную
 * скорость точно, поэтому раскачивание предсказуемо и «читается» игроком, а
 * упругость остаётся у самой нити, которую рисует решатель.
 */
export class SpiderWebController {
  readonly preview: AimPreview = {
    active: false,
    origin: { x: 0, y: 0 },
    direction: { x: 1, y: 0 },
    target: null,
    kind: 'none',
    valid: false,
    assisted: false,
    distance: 0,
    anchorId: null,
  };

  /** Текущая длина активной нити (изменяется подтягиванием). */
  tetherLength = 0;
  /** Точка крепления активной нити. */
  anchorPosition: Vector2 | null = null;
  /** Прогресс «вылета» нити, 0..1 — визуальный эффект выстрела. */
  shootProgress = 1;

  private aiming = false;
  private aimHoldMs = 0;
  private detachCooldownMs = 0;
  private lastDirection: Vector2 = { x: 1, y: 0 };
  private swingTimeMs = 0;

  constructor(private readonly deps: WebControllerDeps) {}

  get isTethered(): boolean {
    return this.deps.web.activeStrandId !== null;
  }

  get isAiming(): boolean {
    return this.aiming;
  }

  get swingDurationMs(): number {
    return this.swingTimeMs;
  }

  /** Замедление времени во время точного прицеливания (раздел 22.1). */
  get timeScale(): number {
    if (!this.aiming || !this.deps.slowMotionEnabled()) return 1;
    return aimConfig.timeScale;
  }

  reset(): void {
    this.aiming = false;
    this.aimHoldMs = 0;
    this.tetherLength = 0;
    this.anchorPosition = null;
    this.preview.active = false;
    this.preview.target = null;
    this.swingTimeMs = 0;
    this.shootProgress = 1;
  }

  // ------------------------------------------------------------------ ввод

  update(deltaMs: number, input: InputFrame): void {
    this.detachCooldownMs = Math.max(0, this.detachCooldownMs - deltaMs);
    this.shootProgress = Math.min(1, this.shootProgress + deltaMs / 90);

    if (input.webHeld) {
      this.aimHoldMs += deltaMs;
      if (!this.aiming && this.aimHoldMs >= aimConfig.holdThresholdMs) {
        this.aiming = true;
        events.emit('aim:started', {});
      }
    }

    if (this.aiming || input.webHeld) this.updatePreview(input);
    else this.preview.active = false;

    if (input.webReleased) {
      if (this.aiming) {
        this.aiming = false;
        events.emit('aim:ended', {});
        this.fireAtPreview();
      } else if (this.aimHoldMs > 0) {
        this.quickFire(input);
      }
      this.aimHoldMs = 0;
      this.preview.active = false;
    }

    if (!input.webHeld) this.aimHoldMs = 0;

    if (input.cutPressed) this.cutNearest();
  }

  /** Вызывается с фиксированным шагом после движения героя. */
  fixedUpdate(deltaSeconds: number, input: InputFrame): void {
    const strandId = this.deps.web.activeStrandId;
    if (strandId === null) {
      this.anchorPosition = null;
      return;
    }

    const strand = this.deps.web.graph.getStrand(strandId);
    if (!strand) {
      this.deps.web.activeStrandId = null;
      this.anchorPosition = null;
      return;
    }

    // Узел, не принадлежащий пауку, и есть точка подвеса.
    const nodeA = this.deps.web.graph.getNode(strand.nodeAId);
    const nodeB = this.deps.web.graph.getNode(strand.nodeBId);
    const anchorNode = nodeA?.type === 'spider-anchor' ? nodeB : nodeA;
    if (!anchorNode) {
      this.release(false);
      return;
    }
    this.anchorPosition = { x: anchorNode.position.x, y: anchorNode.position.y };

    this.handleReeling(deltaSeconds, input);
    this.applyRopeConstraint(anchorNode.position, deltaSeconds, input);

    strand.restLength = this.tetherLength;
    this.swingTimeMs += deltaSeconds * 1000;
    this.deps.state.request('Tethered');
  }

  private handleReeling(deltaSeconds: number, input: InputFrame): void {
    if (!this.deps.spider.canControl) return;
    const vertical = input.moveY;
    if (vertical < -0.25) {
      // Стик вверх — подтягивание: нить укорачивается.
      this.tetherLength = Math.max(
        tetherConfig.minimumLength,
        this.tetherLength - tetherConfig.reelInSpeed * -vertical * deltaSeconds,
      );
    } else if (vertical > 0.25) {
      this.tetherLength = Math.min(
        tetherConfig.maximumLength,
        this.tetherLength + tetherConfig.reelOutSpeed * vertical * deltaSeconds,
      );
    }
  }

  /**
   * Жёсткое ограничение маятника.
   *
   * Позиция героя проецируется на окружность радиуса `tetherLength`, а из
   * скорости убирается только составляющая «наружу». Касательная скорость
   * сохраняется полностью — отсюда и берётся ощущение живого раскачивания.
   */
  private applyRopeConstraint(anchor: Vector2, deltaSeconds: number, input: InputFrame): void {
    const spider = this.deps.spider;
    const position = spider.position;
    const dx = position.x - anchor.x;
    const dy = position.y - anchor.y;
    const currentLength = Math.hypot(dx, dy);
    if (currentLength < 1e-4) return;

    const nx = dx / currentLength;
    const ny = dy / currentLength;

    // Помощь раскачиванию: небольшое ускорение вдоль дуги, когда игрок
    // отклоняет стик по ходу движения (раздел 24.3 ТЗ).
    if (spider.canControl && Math.abs(input.moveX) > 0.1) {
      const tangent = { x: -ny, y: nx };
      const along = dot(tangent, { x: input.moveX, y: 0 });
      const tangentialSpeed = dot(spider.velocity, tangent);
      if (Math.abs(tangentialSpeed) < 620) {
        const assist = tetherConfig.swingAssistAcceleration * along * deltaSeconds;
        spider.velocity.x += tangent.x * assist;
        spider.velocity.y += tangent.y * assist;
      }
    }

    if (currentLength <= this.tetherLength) return;

    const correction = currentLength - this.tetherLength;
    spider.teleportRelative(-nx * correction, -ny * correction);

    const outward = dot(spider.velocity, { x: nx, y: ny });
    if (outward > 0) {
      const absorbed = outward * (1 - tetherConfig.ropeAbsorption);
      spider.velocity.x -= nx * absorbed;
      spider.velocity.y -= ny * absorbed;
    }
    spider.syncVelocityToBody();
  }

  // ------------------------------------------------------------ прицеливание

  private aimDirection(input: InputFrame): Vector2 {
    if (Math.abs(input.aimX) > 0.001 || Math.abs(input.aimY) > 0.001) {
      this.lastDirection = normalize({ x: input.aimX, y: input.aimY });
      return this.lastDirection;
    }
    const velocity = this.deps.spider.velocity;
    if (length(velocity) > 40) {
      this.lastDirection = normalize(velocity);
      return this.lastDirection;
    }
    return this.lastDirection;
  }

  private updatePreview(input: InputFrame): void {
    const origin = this.deps.spider.position;
    const direction = this.aimDirection(input);

    this.preview.active = true;
    this.preview.origin = origin;
    this.preview.direction = direction;

    const candidate = this.findTarget(origin, direction);
    if (candidate) {
      this.preview.target = candidate.point;
      this.preview.kind = candidate.kind;
      this.preview.assisted = candidate.assisted;
      this.preview.anchorId = candidate.anchorId;
      this.preview.distance = candidate.distance;
      this.preview.valid = true;
    } else {
      this.preview.target = null;
      this.preview.kind = 'none';
      this.preview.assisted = false;
      this.preview.anchorId = null;
      this.preview.distance = webConfig.maximumShotDistance;
      this.preview.valid = false;
    }

    for (const anchor of this.deps.anchors) {
      anchor.highlight = this.preview.anchorId === anchor.id ? 1 : 0;
    }
  }

  /**
   * Поиск точки крепления (раздел 22.2–22.3 ТЗ).
   *
   * Сначала прямой луч, затем конус помощи. Кандидаты ранжируются по
   * совпадению с направлением прицела, удобству дистанции, типу цели и
   * видимости — так явная точка крепления почти всегда побеждает случайный
   * кусок стены рядом с ней.
   */
  private findTarget(origin: Vector2, direction: Vector2): AimCandidate | null {
    const maxDistance = webConfig.maximumShotDistance;
    const assistStrength = clamp01(this.deps.aimAssistStrength());
    const coneDeg =
      aimConfig.baseAssistAngleDeg +
      (aimConfig.maxAssistAngleDeg - aimConfig.baseAssistAngleDeg) * assistStrength;
    const coneRad = (coneDeg * Math.PI) / 180;
    const aimAngle = angleOf(direction);

    const candidates: AimCandidate[] = [];

    // 1. Прямой луч по статической геометрии.
    const rayEnd = {
      x: origin.x + direction.x * maxDistance,
      y: origin.y + direction.y * maxDistance,
    };
    const hit = this.deps.collision.raycast(origin, rayEnd);
    if (hit && hit.surface.material.webAttachable) {
      candidates.push({
        point: hit.point,
        kind: 'surface',
        assisted: false,
        anchorId: null,
        bodyId: null,
        distance: hit.distance,
        score: this.score(1, hit.distance, 0, 1),
      });
    }

    // 2. Явные точки крепления в конусе помощи.
    for (const anchor of this.deps.anchors) {
      const toAnchor = { x: anchor.position.x - origin.x, y: anchor.position.y - origin.y };
      const dist = length(toAnchor);
      if (dist > maxDistance || dist < webConfig.minimumStrandLength) continue;
      const offset = Math.abs(angleDelta(aimAngle, angleOf(toAnchor)));
      if (offset > coneRad) continue;
      if (this.deps.collision.isBlocked(origin, anchor.position)) continue;

      const alignment = 1 - offset / coneRad;
      candidates.push({
        point: { ...anchor.position },
        kind: 'anchor',
        assisted: offset > 0.02,
        anchorId: anchor.id,
        bodyId: null,
        // Явная точка получает заметный бонус: игрок целится «примерно туда»,
        // и попадание в неё почти всегда и есть намерение.
        distance: dist,
        score: this.score(alignment, dist, 1, 1),
      });
    }

    // 3. Динамические тела.
    for (const body of this.deps.getAttachableBodies()) {
      const toBody = { x: body.position.x - origin.x, y: body.position.y - origin.y };
      const dist = length(toBody);
      if (dist > maxDistance) continue;
      const offset = Math.abs(angleDelta(aimAngle, angleOf(toBody)));
      if (offset > coneRad * 1.1) continue;
      if (this.deps.collision.isBlocked(origin, body.position)) continue;

      const alignment = 1 - Math.min(1, offset / (coneRad * 1.1));
      candidates.push({
        point: { x: body.position.x, y: body.position.y },
        kind: 'body',
        assisted: offset > 0.02,
        anchorId: null,
        bodyId: body.id,
        distance: dist,
        score: this.score(alignment, dist, 0.6, 1),
      });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]!;
  }

  private score(
    alignment: number,
    dist: number,
    explicitBonus: number,
    visibility: number,
  ): number {
    // Комфортная дистанция — примерно половина максимальной: слишком короткие
    // нити не дают дуги, слишком длинные — контроля.
    const preference = 1 - Math.abs(dist / webConfig.maximumShotDistance - 0.55) * 1.4;
    return (
      alignment * 0.5 + clamp01(preference) * 0.2 + explicitBonus * 0.2 + visibility * 0.1
    );
  }

  // ---------------------------------------------------------------- выстрел

  private quickFire(input: InputFrame): void {
    const origin = this.deps.spider.position;
    const direction = this.aimDirection(input);
    const candidate = this.findTarget(origin, direction);
    if (!candidate) return;
    this.attachTo(candidate);
  }

  private fireAtPreview(): void {
    if (!this.preview.valid || !this.preview.target) return;
    this.attachTo({
      point: this.preview.target,
      kind: this.preview.kind,
      assisted: this.preview.assisted,
      anchorId: this.preview.anchorId,
      bodyId: null,
      distance: this.preview.distance,
      score: 0,
    });
  }

  /**
   * Ключевой момент управления: если Люма уже висит на нити и стоит на
   * поверхности, повторное нажатие закрепляет свободный конец здесь —
   * так строится постоянная связь между двумя точками (раздел 19.1 ТЗ).
   */
  private attachTo(candidate: AimCandidate): void {
    if (this.detachCooldownMs > 0) return;

    if (this.isTethered && this.deps.spider.attached) {
      this.anchorCurrentTether();
      return;
    }

    const target = this.buildTarget(candidate);
    if (!target) return;

    // Новая нить заменяет старую: переход между нитями должен быть мгновенным.
    if (this.isTethered) this.release(false);

    const result = this.deps.web.createStrand({
      start: { type: 'spider' },
      end: target,
      playerCreated: true,
    });

    if (!result.ok) return;

    this.deps.web.activeStrandId = result.strandId;
    this.tetherLength = Math.max(
      tetherConfig.minimumLength,
      distance(this.deps.spider.position, candidate.point),
    );
    this.anchorPosition = { ...candidate.point };
    this.shootProgress = 0;
    this.swingTimeMs = 0;
    this.deps.spider.detachFromSurface(0);
    this.deps.state.request('Tethered');
    this.deps.web.pluck(result.strandId, 0.5);

    events.emit('web:attached', { strandId: result.strandId, position: candidate.point });
  }

  private buildTarget(candidate: AimCandidate): WebAttachmentTarget | null {
    if (candidate.kind === 'body') {
      const body = this.deps
        .getAttachableBodies()
        .find((b) => b.id === candidate.bodyId) ?? null;
      if (!body) return null;
      return {
        type: 'body',
        bodyId: body.id,
        localOffset: worldToBody(body, candidate.point),
      };
    }
    return {
      type: 'world',
      point: { ...candidate.point },
      surfaceId: candidate.anchorId ?? 'surface',
      ...(candidate.anchorId ? { anchorId: candidate.anchorId } : {}),
    };
  }

  /** Превращает активную нить в постоянную, закрепив её конец на поверхности. */
  anchorCurrentTether(): boolean {
    const strandId = this.deps.web.activeStrandId;
    if (strandId === null) return false;
    const strand = this.deps.web.graph.getStrand(strandId);
    if (!strand) return false;

    const spiderNode =
      this.deps.web.graph.getNode(strand.nodeAId)?.type === 'spider-anchor'
        ? this.deps.web.graph.getNode(strand.nodeAId)
        : this.deps.web.graph.getNode(strand.nodeBId);
    const anchorNode =
      spiderNode?.id === strand.nodeAId
        ? this.deps.web.graph.getNode(strand.nodeBId)
        : this.deps.web.graph.getNode(strand.nodeAId);
    if (!spiderNode || !anchorNode) return false;

    const contact = this.deps.spider.contact;
    if (!contact || !contact.material.webAttachable) return false;

    const attachPoint = {
      x: contact.point.x + contact.normal.x * 2,
      y: contact.point.y + contact.normal.y * 2,
    };

    const span = distance(attachPoint, anchorNode.position);
    if (span < webConfig.minimumStrandLength) return false;

    this.deps.web.removeStrand(strandId, 'cleanup');
    const result = this.deps.web.createStrand({
      start: { type: 'existing-node', nodeId: anchorNode.id },
      end: { type: 'world', point: attachPoint, surfaceId: contact.surfaceId },
      // Чуть натянутая нить сразу держит вес и красиво звучит.
      requestedRestLength: span * 0.97,
      playerCreated: true,
    });

    this.deps.web.activeStrandId = null;
    this.anchorPosition = null;
    this.detachCooldownMs = tetherConfig.detachReattachCooldownMs;

    if (result.ok) {
      this.deps.web.pluck(result.strandId, 0.8);
      events.emit('web:attached', { strandId: result.strandId, position: attachPoint });
      return true;
    }
    return false;
  }

  /** Отпускает нить. `boost` добавляет небольшой управляемый импульс. */
  release(boost: boolean): void {
    const strandId = this.deps.web.activeStrandId;
    if (strandId === null) return;

    if (boost) {
      const velocity = this.deps.spider.velocity;
      const speed = length(velocity);
      if (speed > 1) {
        const direction = normalize(velocity);
        this.deps.spider.addVelocity({
          x: direction.x * tetherConfig.releaseBoost,
          y: direction.y * tetherConfig.releaseBoost - 40,
        });
      }
    }

    this.deps.web.removeStrand(strandId, 'cleanup');
    this.deps.web.activeStrandId = null;
    this.anchorPosition = null;
    this.detachCooldownMs = tetherConfig.detachReattachCooldownMs;
    this.deps.state.request('Airborne', { force: true });
    events.emit('web:released', { strandId });
  }

  cutNearest(): void {
    const position = this.deps.spider.position;
    const strandId = this.deps.web.findNearestStrand(
      position,
      webConfig.cutRadius + spiderBodyConfig.radius,
      true,
    );
    if (strandId === null) return;
    if (strandId === this.deps.web.activeStrandId) {
      this.release(false);
      return;
    }
    this.deps.web.removeStrand(strandId, 'cut');
  }

  /** Есть ли рядом нить, которую можно разрезать — для контекстной кнопки. */
  hasCuttableStrand(): boolean {
    return (
      this.deps.web.findNearestStrand(
        this.deps.spider.position,
        webConfig.cutRadius + spiderBodyConfig.radius,
        true,
      ) !== null
    );
  }

  /** Натяжение активной нити для звука и HUD. */
  get activeTension(): number {
    const strandId = this.deps.web.activeStrandId;
    if (strandId === null) return 0;
    return clamp(this.deps.web.graph.getStrand(strandId)?.tensionNormalized ?? 0, 0, 1);
  }
}

import { spiderBodyConfig, spiderMovementConfig } from '../../app/GameConfig';
import { dampAngle } from '../../core/math/Interpolation';
import { angleOf, fromAngle, perpendicular, type Vector2 } from '../../core/math/Vector2';
import type { CollisionWorld, SurfaceQuery } from '../physics/CollisionWorld';
import type { PhysicsMaterialDefinition } from '../physics/PhysicsMaterials';

export interface SurfaceContact {
  point: Vector2;
  /** Сглаженная нормаль, по которой строится ориентация героя. */
  normal: Vector2;
  /** Мгновенная нормаль ближайшей поверхности без сглаживания. */
  rawNormal: Vector2;
  tangent: Vector2;
  surfaceId: string;
  material: PhysicsMaterialDefinition;
  distance: number;
}

/**
 * Датчик поверхности.
 *
 * Вместо набора лучей (раздел 11.1 ТЗ) используется ближайшая точка границы
 * многоугольников. Это эквивалентно по смыслу, но заметно устойчивее в углах:
 * на выпуклой вершине нормаль поворачивается непрерывно, поэтому переход
 * «пол → стена → потолок» получается сам собой, без отдельной ветки кода и
 * без телепортаций.
 */
export class SpiderSurfaceSensor {
  private smoothedAngle = Math.PI / 2;
  private hasContact = false;
  /** Знак направления обхода: +1 — «вперёд» вправо относительно нормали. */
  private facingSign = 1;

  contact: SurfaceContact | null = null;

  constructor(private readonly world: CollisionWorld) {}

  reset(normal: Vector2): void {
    this.smoothedAngle = angleOf(normal);
    this.hasContact = false;
    this.contact = null;
    this.facingSign = 1;
  }

  /**
   * @param position центр коллайдера героя
   * @param attached находится ли герой в состоянии сцепления
   */
  update(position: Vector2, attached: boolean, deltaSeconds: number): SurfaceContact | null {
    const searchRadius = attached
      ? spiderBodyConfig.senseRadius
      : spiderBodyConfig.radius + spiderMovementConfig.surfaceSnapDistance;

    const query = this.world.queryClosest(position, searchRadius, (surface) =>
      surface.material.spiderWalkable,
    );

    if (!query) {
      this.hasContact = false;
      this.contact = null;
      return null;
    }

    const rawNormal = query.normal;
    const targetAngle = angleOf(rawNormal);

    if (!this.hasContact) {
      this.smoothedAngle = targetAngle;
      this.hasContact = true;
    } else {
      // Плавный поворот за 80–140 мс (раздел 11.3 ТЗ): без него герой на
      // прямом угле дёргается на один кадр.
      const smoothTime = spiderMovementConfig.cornerTransitionDurationMs / 1000;
      this.smoothedAngle = dampAngle(this.smoothedAngle, targetAngle, smoothTime, deltaSeconds);
    }

    const normal = fromAngle(this.smoothedAngle, 1);
    const tangent = perpendicular(normal);

    this.contact = {
      point: query.point,
      normal,
      rawNormal,
      tangent: { x: tangent.x * this.facingSign, y: tangent.y * this.facingSign },
      surfaceId: query.surface.id,
      material: query.surface.material,
      distance: query.distance,
    };
    return this.contact;
  }

  /** Обновляет знак касательной так, чтобы она указывала по ходу движения. */
  alignTangent(desiredDirection: Vector2): void {
    if (!this.contact) return;
    const base = perpendicular(this.contact.normal);
    const alignment = base.x * desiredDirection.x + base.y * desiredDirection.y;
    if (Math.abs(alignment) > 0.05) this.facingSign = alignment > 0 ? 1 : -1;
    this.contact.tangent = {
      x: base.x * this.facingSign,
      y: base.y * this.facingSign,
    };
  }

  get facing(): number {
    return this.facingSign;
  }

  /** Проверка, можно ли зацепиться за поверхность при подлёте. */
  probeAttach(position: Vector2, radius: number): SurfaceQuery | null {
    return this.world.queryClosest(position, radius, (surface) => surface.material.spiderWalkable);
  }
}

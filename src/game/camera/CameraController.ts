import Phaser from 'phaser';
import { cameraConfig, VIEW } from '../../app/GameConfig';
import { clamp, damp } from '../../core/math/Interpolation';
import { length, type Vector2 } from '../../core/math/Vector2';
import type { LevelRect } from '../level/LevelSchema';

/**
 * Камера комнаты.
 *
 * Камера следует не за героем, а за расчётной целью с упреждением по скорости
 * и прицелу (раздел 35.1 ТЗ). Мир при этом никогда не вращается: сколько бы
 * Люма ни бегала по потолку, «верх» экрана остаётся верхом.
 */
export class CameraController {
  private target: Vector2 = { x: 0, y: 0 };
  private current: Vector2 = { x: 0, y: 0 };
  private zoom = cameraConfig.baseZoom;
  private shakeStrength = 0;
  private shakeTimeMs = 0;
  private shakeDurationMs = 0;
  private shakeEnabled = true;
  private baseScale = 1;

  constructor(
    private readonly camera: Phaser.Cameras.Scene2D.Camera,
    private readonly bounds: LevelRect,
  ) {}

  setShakeEnabled(enabled: boolean): void {
    this.shakeEnabled = enabled;
    if (!enabled) this.shakeStrength = 0;
  }

  /** Пересчитывает базовый масштаб так, чтобы по высоте было ~720 единиц. */
  resize(width: number, height: number): void {
    this.baseScale = height / VIEW.referenceHeight;
    this.applyBounds(width, height);
  }

  snapTo(position: Vector2): void {
    this.current = { ...position };
    this.target = { ...position };
    this.camera.centerOn(position.x, position.y);
  }

  shake(strength: number, durationMs: number): void {
    if (!this.shakeEnabled) return;
    this.shakeStrength = Math.max(this.shakeStrength, strength);
    this.shakeDurationMs = Math.max(this.shakeDurationMs - this.shakeTimeMs, durationMs);
    this.shakeTimeMs = 0;
  }

  update(
    deltaSeconds: number,
    spiderPosition: Vector2,
    velocity: Vector2,
    aimDirection: Vector2 | null,
    tethered: boolean,
  ): void {
    const speed = length(velocity);

    // Упреждение по скорости: камера смотрит туда, куда летит герой.
    const velocityLead = Math.min(1, speed / 620) * cameraConfig.maximumVelocityLead;
    const leadX = speed > 1 ? (velocity.x / speed) * velocityLead : 0;
    const leadY = speed > 1 ? (velocity.y / speed) * velocityLead * 0.6 : 0;

    let aimLeadX = 0;
    let aimLeadY = 0;
    if (aimDirection) {
      aimLeadX = aimDirection.x * cameraConfig.maximumAimLead;
      aimLeadY = aimDirection.y * cameraConfig.maximumAimLead * 0.7;
    }

    this.target.x = spiderPosition.x + leadX + aimLeadX;
    this.target.y = spiderPosition.y + leadY + aimLeadY;

    const smoothTime = cameraConfig.positionSmoothTimeMs / 1000;
    this.current.x = damp(this.current.x, this.target.x, smoothTime, deltaSeconds);
    this.current.y = damp(this.current.y, this.target.y, smoothTime, deltaSeconds);

    // Отдаление на скорости и на длинной дуге раскачивания.
    const speedFactor = clamp(speed / 780, 0, 1);
    const targetZoom = tethered
      ? cameraConfig.minimumZoom + (1 - speedFactor) * 0.1
      : cameraConfig.maximumZoom - speedFactor * (cameraConfig.maximumZoom - cameraConfig.minimumZoom);
    this.zoom = damp(this.zoom, targetZoom, cameraConfig.zoomSmoothTimeMs / 1000, deltaSeconds);

    let offsetX = 0;
    let offsetY = 0;
    if (this.shakeStrength > 0) {
      this.shakeTimeMs += deltaSeconds * 1000;
      const progress = clamp(this.shakeTimeMs / Math.max(this.shakeDurationMs, 1), 0, 1);
      const falloff = (1 - progress) * (1 - progress);
      const amplitude = this.shakeStrength * 26 * falloff;
      offsetX = (Math.random() - 0.5) * 2 * amplitude;
      offsetY = (Math.random() - 0.5) * 2 * amplitude;
      if (progress >= 1) this.shakeStrength = 0;
    }

    this.camera.setZoom(this.baseScale * this.zoom);
    this.camera.centerOn(this.current.x + offsetX, this.current.y + offsetY);
  }

  private applyBounds(width: number, height: number): void {
    // Границы расширяются на половину экрана: иначе на широком мониторе
    // маленькая комната прижимает камеру к краю и герой уезжает из центра.
    const visibleWidth = width / (this.baseScale * cameraConfig.minimumZoom);
    const visibleHeight = height / (this.baseScale * cameraConfig.minimumZoom);
    const padX = Math.max(0, (visibleWidth - this.bounds.width) / 2);
    const padY = Math.max(0, (visibleHeight - this.bounds.height) / 2);
    this.camera.setBounds(
      this.bounds.x - padX,
      this.bounds.y - padY,
      this.bounds.width + padX * 2,
      this.bounds.height + padY * 2,
    );
  }

  get currentZoom(): number {
    return this.baseScale * this.zoom;
  }

  get scrollTarget(): Vector2 {
    return this.current;
  }
}

/**
 * Все настраиваемые числа игры собраны здесь.
 *
 * Правило из ТЗ: ни одна константа баланса не должна жить внутри логики —
 * отладочная панель меняет значения этого модуля прямо во время игры,
 * а `exportTuning()` выгружает результат в JSON.
 */

/** Логическое разрешение. Физика не зависит от плотности экрана. */
export const VIEW = {
  baseWidth: 1280,
  baseHeight: 720,
  /**
   * Сколько логических единиц по высоте видно при zoom = 1.
   *
   * ТЗ называет 720, но на телефоне в альбомной ориентации при таком масштабе
   * Люма занимает меньше двадцати пикселей и вся процедурная анимация ног
   * пропадает. 600 сохраняет ощущение огромного мира и возвращает герою
   * читаемый силуэт.
   */
  referenceHeight: 600,
} as const;

export const PHYSICS = {
  fixedDeltaMs: 1000 / 60,
  maxAccumulatedSteps: 4,
  /**
   * Matter при gravity.scale = 0.001 и шаге 1/60 даёт ускорение
   * gravity.y * 1000 единиц/с². Значение подобрано под gravity = 1750.
   */
  matterGravityScale: 0.001,
  gravity: 1750,
} as const;

export interface SpiderMovementConfig {
  surfaceMaxSpeed: number;
  surfaceAcceleration: number;
  surfaceDeceleration: number;
  surfaceTurnAcceleration: number;

  airMaxSpeed: number;
  airAcceleration: number;

  jumpVelocity: number;
  jumpHoldDurationMs: number;
  jumpReleaseMultiplier: number;
  /** Доля импульса прыжка вдоль нормали поверхности; остальное — по стику. */
  jumpNormalShare: number;

  gravity: number;
  maxFallSpeed: number;

  coyoteTimeMs: number;
  jumpBufferMs: number;

  surfaceSnapDistance: number;
  surfaceDetachDistance: number;
  maxAttachSpeed: number;

  cornerSearchRadius: number;
  cornerTransitionDurationMs: number;

  /** Время блокировки прилипания сразу после прыжка. */
  jumpDetachCooldownMs: number;
}

export const spiderMovementConfig: SpiderMovementConfig = {
  surfaceMaxSpeed: 270,
  surfaceAcceleration: 1900,
  surfaceDeceleration: 2300,
  surfaceTurnAcceleration: 2500,

  airMaxSpeed: 230,
  airAcceleration: 900,

  jumpVelocity: 520,
  jumpHoldDurationMs: 180,
  jumpReleaseMultiplier: 0.48,
  jumpNormalShare: 0.7,

  gravity: 1750,
  maxFallSpeed: 920,

  coyoteTimeMs: 100,
  jumpBufferMs: 130,

  surfaceSnapDistance: 24,
  surfaceDetachDistance: 32,
  maxAttachSpeed: 620,

  cornerSearchRadius: 34,
  cornerTransitionDurationMs: 110,

  jumpDetachCooldownMs: 120,
};

export const spiderBodyConfig = {
  radius: 17,
  /** Датчик поверхности чуть больше коллайдера — из раздела 10.1 ТЗ. */
  senseRadius: 46,
  mass: 0.8,
  friction: 0,
  frictionAir: 0.015,
  restitution: 0.05,
} as const;

export const surfaceAttachmentConfig = {
  targetDistance: 17,
  snapStrength: 70,
  snapDamping: 12,
  maximumSnapForce: 2400,
} as const;

export const webConfig = {
  maxPlayerStrands: 80,
  maxParticles: 520,

  particleSpacing: 24,
  minimumStrandLength: 30,
  maximumShotDistance: 520,

  stiffness: 0.72,
  damping: 0.08,

  breakStretchRatio: 1.52,
  breakDelayMs: 180,

  solverIterations: 6,
  gravityScale: 0.55,

  cutRadius: 48,

  sleepDelayMs: 1500,
  /**
   * Насколько нить вправе «дышать», продолжая считаться неподвижной.
   * ТЗ задаёт порог по скорости, но в позиционном решателе туго натянутая
   * нить долго несёт затухающую стоячую волну с ничтожной амплитудой —
   * порог по смещению описывает то же требование честнее.
   */
  sleepDriftThreshold: 2.5,
  sleepTensionDeltaThreshold: 0.01,

  /** Толщина физического сегмента при столкновении с геометрией. */
  segmentRadius: 3,

  /**
   * Ограничение силы, передаваемой одной нитью на твёрдое тело.
   * Величина выражена в «масса × единиц/с²»: груз массой 2.4 в поле 1750
   * весит 4200, поэтому предел из ТЗ (1600) поднят — там он записан в
   * единицах конкретного движка. Смысл ограничения прежний: страховка от
   * рывка при ошибке решателя, а не предел прочности нити (за него отвечает
   * breakStretchRatio).
   */
  maximumAttachmentForce: 12000,
  /** Жёсткость даёт провисание около 5–6 единиц на каждую единицу массы. */
  bodyAttachStiffness: 320,
  bodyAttachDamping: 10,

  /** Свободные концы растворяются, если ни к чему не привязаны. */
  freeEndLifetimeMs: 1500,
} as const;

export const tetherConfig = {
  reelInSpeed: 180,
  reelOutSpeed: 230,
  minimumLength: 36,
  maximumLength: 720,
  swingAssistAcceleration: 240,
  detachReattachCooldownMs: 80,
  /** Доля скорости, гасимая при натяжении троса. 0 — идеально упругий маятник. */
  ropeAbsorption: 0.06,
  /** Небольшой импульс при осознанном отпускании нити. */
  releaseBoost: 90,
} as const;

export const aimConfig = {
  holdThresholdMs: 140,
  timeScale: 0.35,
  /** Базовый конус помощи и расширенный при включённой помощи прицеливания. */
  baseAssistAngleDeg: 12,
  maxAssistAngleDeg: 22,
  maxScreenOffset: 36,
} as const;

export interface CameraConfig {
  baseZoom: number;
  minimumZoom: number;
  maximumZoom: number;
  positionSmoothTimeMs: number;
  zoomSmoothTimeMs: number;
  maximumVelocityLead: number;
  maximumAimLead: number;
}

export const cameraConfig: CameraConfig = {
  baseZoom: 1,
  minimumZoom: 0.82,
  maximumZoom: 1.08,
  positionSmoothTimeMs: 160,
  zoomSmoothTimeMs: 220,
  maximumVelocityLead: 140,
  maximumAimLead: 180,
};

export const inputConfig = {
  /** Радиусы в dp; переводятся в пиксели по devicePixelRatio-независимой шкале. */
  stickRadius: 72,
  stickMaxOffset: 86,
  stickDeadZone: 0.14,
  stickSmoothMs: 50,

  jumpButtonSize: 96,
  webButtonSize: 108,
  cutButtonSize: 72,
  minButtonSpacing: 112,
  /** Область нажатия больше визуальной кнопки — раздел 8.3 ТЗ. */
  touchPadding: 1.15,
} as const;

export const respawnConfig = {
  fadeOutMs: 120,
  restoreMs: 260,
  fadeInMs: 180,
  inputProtectionMs: 350,
} as const;

export const plateConfig = {
  activationMass: 1,
  activationDelayMs: 150,
  deactivationDelayMs: 100,
} as const;

/** Ярусы натяжения для визуальной и звуковой обратной связи (раздел 23.2). */
export const TENSION_STEPS = {
  calm: 0.6,
  bright: 0.8,
  pulsing: 0.95,
  critical: 1,
} as const;

export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualityProfile {
  bloom: boolean;
  maxParticles: number;
  backgroundParticles: number;
  godRays: boolean;
  rain: boolean;
  dewDrops: boolean;
  webGlowPasses: number;
  proceduralLegs: number;
  parallaxLayers: number;
}

export const qualityProfiles: Record<QualityLevel, QualityProfile> = {
  low: {
    bloom: false,
    maxParticles: 250,
    backgroundParticles: 30,
    godRays: false,
    rain: false,
    dewDrops: false,
    webGlowPasses: 1,
    proceduralLegs: 8,
    parallaxLayers: 2,
  },
  medium: {
    bloom: false,
    maxParticles: 600,
    backgroundParticles: 70,
    godRays: true,
    rain: true,
    dewDrops: true,
    webGlowPasses: 2,
    proceduralLegs: 8,
    parallaxLayers: 3,
  },
  high: {
    bloom: true,
    maxParticles: 1200,
    backgroundParticles: 130,
    godRays: true,
    rain: true,
    dewDrops: true,
    webGlowPasses: 3,
    proceduralLegs: 8,
    parallaxLayers: 4,
  },
};

/** Выгрузка текущих значений для отладочной панели. */
export const exportTuning = (): string =>
  JSON.stringify(
    {
      spiderMovementConfig,
      spiderBodyConfig,
      surfaceAttachmentConfig,
      webConfig,
      tetherConfig,
      aimConfig,
      cameraConfig,
    },
    null,
    2,
  );

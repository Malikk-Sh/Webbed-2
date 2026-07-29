import type { QualityLevel } from '../../app/GameConfig';

export interface GameSettings {
  schemaVersion: number;

  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;

  uiScale: number;
  uiOpacity: number;

  leftHanded: boolean;
  fixedStick: boolean;
  /**
   * Показ экранного стика и кнопок.
   * `auto` — по наличию сенсора у устройства; `on`/`off` — принудительно.
   */
  onScreenControls: 'auto' | 'on' | 'off';
  aimAssist: number;
  autoAim: boolean;

  cameraShake: boolean;
  reducedParticles: boolean;
  highContrastWeb: boolean;

  quality: QualityLevel;
  frameCap: 30 | 60;
  showFps: boolean;
  /** Живая панель состояния поверх игры — доступна без клавиатуры. */
  showDiagnostics: boolean;

  slowMotionAiming: boolean;
  hintsEnabled: boolean;
}

export const SETTINGS_SCHEMA_VERSION = 1;

export const defaultSettings: GameSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,

  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 0.85,

  uiScale: 1,
  uiOpacity: 0.9,

  leftHanded: false,
  fixedStick: false,
  onScreenControls: 'auto',
  aimAssist: 0.5,
  autoAim: false,

  cameraShake: true,
  reducedParticles: false,
  highContrastWeb: false,

  quality: 'medium',
  frameCap: 60,
  showFps: false,
  showDiagnostics: false,

  slowMotionAiming: true,
  hintsEnabled: true,
};

export interface PrototypeProgress {
  schemaVersion: number;
  /**
   * Лучшее время по кампании в целом — осталось от прототипа с одной
   * комнатой. Экран результатов сравнивает время уже по главам, но старую
   * запись незачем терять: она читается из хранилища у тех, кто играл раньше.
   */
  bestTimeMs: number | null;
  completions: number;
  seenHints: string[];

  /** Идентификаторы пройденных глав — по ним открывается следующая. */
  completedChapters: string[];
  /** Лучшее время по каждой главе, мс. */
  chapterBestMs: Record<string, number>;
  /** Больше всего собранных бутонов за один проход главы. */
  chapterBlooms: Record<string, number>;
}

export const defaultProgress: PrototypeProgress = {
  schemaVersion: 2,
  bestTimeMs: null,
  completions: 0,
  seenHints: [],
  completedChapters: [],
  chapterBestMs: {},
  chapterBlooms: {},
};

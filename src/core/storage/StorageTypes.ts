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
  aimAssist: number;
  autoAim: boolean;

  cameraShake: boolean;
  reducedParticles: boolean;
  highContrastWeb: boolean;

  quality: QualityLevel;
  frameCap: 30 | 60;
  showFps: boolean;

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
  aimAssist: 0.5,
  autoAim: false,

  cameraShake: true,
  reducedParticles: false,
  highContrastWeb: false,

  quality: 'medium',
  frameCap: 60,
  showFps: false,

  slowMotionAiming: true,
  hintsEnabled: true,
};

export interface PrototypeProgress {
  schemaVersion: number;
  bestTimeMs: number | null;
  completions: number;
  seenHints: string[];
}

export const defaultProgress: PrototypeProgress = {
  schemaVersion: 1,
  bestTimeMs: null,
  completions: 0,
  seenHints: [],
};

export type SpiderState =
  | 'Cutscene'
  | 'Spawn'
  | 'SurfaceIdle'
  | 'SurfaceMove'
  | 'JumpStart'
  | 'Airborne'
  | 'SurfaceAttach'
  | 'Tethered'
  | 'WebAim'
  | 'Stunned'
  | 'DeadOrLost'
  | 'Respawning';

/**
 * Приоритеты состояний из раздела 9.2 ТЗ. Чем больше число, тем выше
 * приоритет: состояние с меньшим весом не может перебить текущее.
 */
export const STATE_PRIORITY: Record<SpiderState, number> = {
  Cutscene: 100,
  Respawning: 90,
  DeadOrLost: 85,
  Stunned: 80,
  Spawn: 70,
  WebAim: 60,
  Tethered: 50,
  Airborne: 40,
  SurfaceAttach: 35,
  JumpStart: 30,
  SurfaceMove: 20,
  SurfaceIdle: 10,
};

/**
 * Визуальное состояние отделено от игрового: анимация может показывать
 * «быстрое падение» или «испуг», пока логика остаётся в Airborne.
 */
export type SpiderMood = 'calm' | 'focused' | 'strained' | 'scared' | 'happy' | 'hurt';

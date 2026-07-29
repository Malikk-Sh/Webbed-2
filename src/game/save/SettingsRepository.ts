import {
  defaultProgress,
  defaultSettings,
  SETTINGS_SCHEMA_VERSION,
  type GameSettings,
  type PrototypeProgress,
} from '../../core/storage/StorageTypes';
import { readRecord, readRecordSync, writeRecord } from '../../core/storage/IndexedDbStorage';

type Listener = (settings: GameSettings) => void;

/**
 * Хранилище настроек и прогресса прототипа.
 *
 * Значения читаются синхронно из localStorage при старте (интерфейс должен
 * появиться в правильном масштабе сразу), затем догружаются из IndexedDB.
 * Запись отложена на 250 мс: ползунки громкости иначе создают десятки
 * транзакций за секунду.
 */
export class SettingsRepository {
  private settings: GameSettings = { ...defaultSettings };
  private progress: PrototypeProgress = { ...defaultProgress };
  private readonly listeners = new Set<Listener>();
  private saveTimer: number | null = null;

  constructor() {
    const cached = readRecordSync<GameSettings>('settings', 'main');
    if (cached) this.settings = this.migrate(cached);
    const cachedProgress = readRecordSync<PrototypeProgress>('progress', 'prototype');
    if (cachedProgress) this.progress = migrateProgress(cachedProgress);
  }

  async load(): Promise<void> {
    const [stored, progress] = await Promise.all([
      readRecord<GameSettings>('settings', 'main'),
      readRecord<PrototypeProgress>('progress', 'prototype'),
    ]);
    if (stored) {
      this.settings = this.migrate(stored);
      this.notify();
    }
    if (progress) this.progress = migrateProgress(progress);
  }

  private migrate(stored: GameSettings): GameSettings {
    // Прототип живёт на первой версии схемы; неизвестные поля просто
    // перекрываются значениями по умолчанию, а лишние отбрасываются.
    const merged: GameSettings = { ...defaultSettings, ...stored };
    merged.schemaVersion = SETTINGS_SCHEMA_VERSION;
    merged.masterVolume = clamp01(merged.masterVolume);
    merged.musicVolume = clamp01(merged.musicVolume);
    merged.sfxVolume = clamp01(merged.sfxVolume);
    merged.aimAssist = clamp01(merged.aimAssist);
    merged.uiOpacity = Math.max(0.35, Math.min(1, merged.uiOpacity));
    merged.uiScale = Math.max(0.8, Math.min(1.4, merged.uiScale));
    if (!['low', 'medium', 'high'].includes(merged.quality)) merged.quality = 'medium';
    if (!['auto', 'on', 'off'].includes(merged.onScreenControls)) merged.onScreenControls = 'auto';
    if (merged.frameCap !== 30 && merged.frameCap !== 60) merged.frameCap = 60;
    return merged;
  }

  get current(): Readonly<GameSettings> {
    return this.settings;
  }

  get currentProgress(): Readonly<PrototypeProgress> {
    return this.progress;
  }

  patch(partial: Partial<GameSettings>): void {
    this.settings = this.migrate({ ...this.settings, ...partial });
    this.notify();
    this.scheduleSave();
  }

  reset(): void {
    this.settings = { ...defaultSettings };
    this.notify();
    this.scheduleSave();
  }

  /**
   * Итог прохождения главы.
   *
   * Записывается всё сразу — отметка о прохождении, время и сбор, — потому
   * что запись в хранилище идёт одной транзакцией, и разносить её по трём
   * вызовам значило бы трижды писать один и тот же объект.
   */
  recordCompletion(chapterId: string, timeMs: number, blooms: number): void {
    this.progress.completions += 1;
    if (this.progress.bestTimeMs === null || timeMs < this.progress.bestTimeMs) {
      this.progress.bestTimeMs = timeMs;
    }
    if (!this.progress.completedChapters.includes(chapterId)) {
      this.progress.completedChapters.push(chapterId);
    }
    const best = this.progress.chapterBestMs[chapterId];
    if (best === undefined || timeMs < best) this.progress.chapterBestMs[chapterId] = timeMs;
    const bestBlooms = this.progress.chapterBlooms[chapterId] ?? 0;
    if (blooms > bestBlooms) this.progress.chapterBlooms[chapterId] = blooms;

    void writeRecord('progress', 'prototype', this.progress);
  }

  isChapterCompleted(chapterId: string): boolean {
    return this.progress.completedChapters.includes(chapterId);
  }

  chapterBestTime(chapterId: string): number | null {
    return this.progress.chapterBestMs[chapterId] ?? null;
  }

  chapterBloomRecord(chapterId: string): number {
    return this.progress.chapterBlooms[chapterId] ?? 0;
  }

  markHintSeen(id: string): void {
    if (this.progress.seenHints.includes(id)) return;
    this.progress.seenHints.push(id);
    void writeRecord('progress', 'prototype', this.progress);
  }

  hasSeenHint(id: string): boolean {
    return this.progress.seenHints.includes(id);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.settings);
    return () => this.listeners.delete(listener);
  }

  /** Немедленная запись — вызывается при сворачивании вкладки. */
  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void writeRecord('settings', 'main', this.settings);
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void writeRecord('settings', 'main', this.settings);
    }, 250);
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.settings);
  }
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/**
 * Приведение старой записи прогресса к текущей схеме.
 *
 * У сохранений прототипа не было полей кампании, а `Object.assign` с
 * умолчаниями оставил бы `undefined` там, где лежало `null` или мусор из
 * ручной правки хранилища. Поэтому массивы и словари восстанавливаются
 * поимённо.
 */
const migrateProgress = (stored: Partial<PrototypeProgress>): PrototypeProgress => ({
  ...defaultProgress,
  ...stored,
  seenHints: Array.isArray(stored.seenHints) ? [...stored.seenHints] : [],
  completedChapters: Array.isArray(stored.completedChapters)
    ? [...stored.completedChapters]
    : [],
  chapterBestMs: { ...(stored.chapterBestMs ?? {}) },
  chapterBlooms: { ...(stored.chapterBlooms ?? {}) },
  schemaVersion: defaultProgress.schemaVersion,
});

export const settingsRepository = new SettingsRepository();

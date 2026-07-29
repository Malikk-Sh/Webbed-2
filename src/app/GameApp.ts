import { events } from '../core/events/EventBus';
import type { RunStats } from '../core/events/GameEvents';
import { Camera2D } from '../engine/Camera2D';
import { GameLoop } from '../engine/GameLoop';
import { Painter } from '../engine/Painter';
import { Surface } from '../engine/Surface';
import { textures } from '../engine/TextureStore';
import { audio } from '../game/audio/AudioEngine';
import { InputSystem } from '../game/input/InputSystem';
import { settingsRepository } from '../game/save/SettingsRepository';
import { PrototypeScene } from '../game/scenes/PrototypeScene';
import { PrototypeHud } from '../game/ui/PrototypeHud';
import { createRuntimeTextures } from '../game/render/TextureFactory';
import {
  CHAPTERS,
  getChapter,
  nextChapter,
  type Chapter,
} from '../game/level/LevelCatalog';
import { ShellUi, type ChapterEntry, type ShellAction } from './ShellUi';

/**
 * Точка сборки приложения: холст, цикл кадра, ввод, интерфейс и жизненный
 * цикл вкладки. Здесь же живёт правило «после сворачивания не продолжаем игру
 * автоматически, а показываем паузу» из раздела 36 ТЗ.
 */
export class GameApp {
  private surface: Surface | null = null;
  private painter: Painter | null = null;
  private loop: GameLoop | null = null;
  private scene: PrototypeScene | null = null;
  private input: InputSystem | null = null;
  private readonly camera = new Camera2D();
  private readonly hud = new PrototypeHud();
  private readonly shell = new ShellUi();
  private started = false;
  private paused = false;
  private chapter: Chapter = CHAPTERS[0]!;

  async boot(): Promise<void> {
    this.shell.setLoadingProgress(0.1, 'Пробуем нить на прочность…');
    await settingsRepository.load();
    this.applyDocumentSettings();

    this.shell.setLoadingProgress(0.35, 'Растягиваем каркас сети…');

    const parent = document.getElementById('game-root');
    if (!parent) throw new Error('Не найден контейнер #game-root');

    this.surface = new Surface(parent);
    const painter = new Painter(this.surface.ctx);
    painter.bind(this.surface.ctx);

    // Текстуры готовятся до первой отрисовки: ими пользуются и мир, и
    // интерфейс, и подставлять заглушку в первом кадре некуда.
    createRuntimeTextures(textures);
    this.shell.setLoadingProgress(0.7, 'Развешиваем капли росы…');

    this.input = new InputSystem(this.surface.canvas);
    this.camera.setViewport(this.surface.width, this.surface.height);

    this.loop = new GameLoop((deltaMs, timeMs) => this.scene?.frame(deltaMs, timeMs));
    this.loop.setFrameCap(settingsRepository.current.frameCap);

    // Кампания продолжается с первой непройденной главы: возвращаться каждый
    // раз в оранжерею после четвёртой комнаты было бы издевательством.
    this.chapter = this.firstUnfinishedChapter();

    this.hud.configure({
      input: this.input,
      getWebLoad: () => this.scene?.webLoad ?? 0,
      getCutAvailable: () => this.scene?.cutAvailable ?? false,
      getAiming: () => this.scene?.aiming ?? false,
      getTethered: () => this.scene?.tethered ?? false,
      getAnchorable: () => this.scene?.anchorable ?? false,
      getFps: () => this.loop?.fps ?? 0,
    });
    this.hud.resize(this.surface.width, this.surface.height);

    this.buildScene(painter);
    this.surface.onResize((surface) => this.camera.setViewport(surface.width, surface.height));

    this.bindShell();
    this.bindLifecycle();

    settingsRepository.onChange((settings) => {
      audio.setVolumes(settings.masterVolume, settings.musicVolume, settings.sfxVolume);
      this.applyDocumentSettings();
      this.loop?.setFrameCap(settings.frameCap);
      this.scene?.applyQuality();
    });

    // Цикл крутится всегда: в меню сцена не обновляет симуляцию, но продолжает
    // рисовать живой мир за полупрозрачным интерфейсом.
    this.loop.start();

    this.shell.setLoadingProgress(1, 'Готово');
    window.setTimeout(() => this.shell.show('menu'), 320);
  }

  /**
   * Пересоздание сцены под главу.
   *
   * Комнату проще собрать заново, чем перезаряжать: сцена держит собственный
   * физический мир, буферы фигур и подписки на события, и «очистить» их до
   * состояния новой комнаты — это тот же объём работы, только с риском забыть
   * одно поле. Пересборка идёт раз на главу и стоит доли секунды.
   */
  private buildScene(painter: Painter): void {
    this.scene?.destroy();
    this.scene = new PrototypeScene({
      surface: this.surface!,
      camera: this.camera,
      painter,
      input: this.input!,
      hud: this.hud,
      level: this.chapter.definition,
      getFps: () => this.loop?.fps ?? 0,
      onComplete: (stats) => this.handleComplete(stats),
      onPauseRequested: () => this.pause(false),
    });
    this.painter = painter;
    this.shell.setPlayNote(`Глава ${this.chapter.numeral} · ${this.chapter.title}`);
    const done = CHAPTERS.filter((item) => settingsRepository.isChapterCompleted(item.id)).length;
    this.shell.setChaptersNote(`Пройдено ${done} из ${CHAPTERS.length}`);
  }

  /** Первая непройденная глава, а если пройдены все — последняя. */
  private firstUnfinishedChapter(): Chapter {
    const found = CHAPTERS.find((chapter) => !settingsRepository.isChapterCompleted(chapter.id));
    return found ?? CHAPTERS[CHAPTERS.length - 1]!;
  }

  /**
   * Открытые главы.
   *
   * Открыта первая, любая пройденная и следующая за последней пройденной.
   * Проверка идёт по порядку в каталоге, а не по числу пройденных: если игрок
   * перепройдёт вторую главу, третья от этого закрыться не должна.
   */
  private chapterEntries(): ChapterEntry[] {
    let unlocked = true;
    return CHAPTERS.map((chapter) => {
      const completed = settingsRepository.isChapterCompleted(chapter.id);
      const entry: ChapterEntry = {
        index: chapter.index,
        numeral: chapter.numeral,
        title: chapter.title,
        subtitle: chapter.subtitle,
        unlocked,
        completed,
        current: chapter.index === this.chapter.index,
        bestTimeMs: settingsRepository.chapterBestTime(chapter.id),
        blooms: settingsRepository.chapterBloomRecord(chapter.id),
        bloomsTotal: chapter.definition.objects.filter((o) => o.prefab === 'silk-bloom').length,
      };
      unlocked = completed;
      return entry;
    });
  }

  private startChapter(index: number): void {
    const chapter = getChapter(index);
    const painter = this.painter;
    if (!painter) return;

    this.chapter = chapter;
    // Сцена перезапускает комнату сама при сборке — второй вызов только сбил
    // бы уже показанное название.
    this.buildScene(painter);
    this.started = true;
    const scene = this.scene;
    if (!scene) return;
    this.resume(scene);
  }

  private applyDocumentSettings(): void {
    const settings = settingsRepository.current;
    document.documentElement.style.setProperty('--ui-scale', String(settings.uiScale));
  }

  // ------------------------------------------------------------------ шелл

  private bindShell(): void {
    this.shell.onAction((action: ShellAction) => {
      const scene = this.scene;
      if (!scene) return;

      switch (action) {
        case 'play':
          void this.startGame(scene);
          break;
        case 'resume':
          this.resume(scene);
          break;
        case 'restart':
        case 'replay':
          scene.restartRoom();
          this.resume(scene);
          break;
        case 'next':
          void this.startNextChapter();
          break;
        case 'quit':
          this.stopGame(scene);
          break;
        default:
          break;
      }
    });

    this.shell.configureChapters(
      () => this.chapterEntries(),
      (index) => {
        void audio.unlock();
        this.startChapter(index);
      },
    );
  }

  private async startNextChapter(): Promise<void> {
    await audio.unlock();
    const next = nextChapter(this.chapter.index);
    if (!next) {
      this.shell.show('menu');
      return;
    }
    this.startChapter(next.index);
  }

  private async startGame(scene: PrototypeScene): Promise<void> {
    await audio.unlock();
    this.shell.show(null);
    if (!this.started) {
      this.started = true;
      scene.restartRoom();
    }
    this.resume(scene);
  }

  private resume(scene: PrototypeScene): void {
    this.shell.show(null);
    this.paused = false;
    this.loop?.resetTiming();
    scene.setRunning(true);
    this.input?.setEnabled(true);
    audio.resume();
    events.emit('game:resumed', {});
  }

  private pause(fromSystem: boolean): void {
    if (this.paused || !this.started) return;
    this.paused = true;
    this.scene?.setRunning(false);
    this.input?.setEnabled(false);
    settingsRepository.flush();
    if (fromSystem) audio.suspend();
    this.shell.show('pause');
    events.emit('game:paused', { fromSystem });
  }

  private stopGame(scene: PrototypeScene): void {
    this.paused = true;
    this.started = false;
    scene.setRunning(false);
    scene.restartRoom();
    this.input?.setEnabled(false);
    this.shell.show('menu');
  }

  private handleComplete(stats: RunStats): void {
    const chapter = this.chapter;
    settingsRepository.recordCompletion(chapter.id, stats.timeMs, stats.bloomsCollected);
    this.scene?.setRunning(false);
    this.paused = true;
    this.started = false;

    const following = nextChapter(chapter.index);
    this.shell.showResults(stats, {
      chapterNumeral: chapter.numeral,
      chapterTitle: chapter.title,
      bestTimeMs: settingsRepository.chapterBestTime(chapter.id),
      nextTitle: following ? `Глава ${following.numeral} · ${following.title}` : null,
    });
  }

  // ------------------------------------------------------- жизненный цикл

  private bindLifecycle(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pauseFromSystem();
      else this.resumeFromSystem();
    });

    window.addEventListener('pagehide', () => this.pauseFromSystem());
    window.addEventListener('blur', () => this.pauseFromSystem());

    // Первое касание разблокирует звук: браузеры не дают включить
    // AudioContext без жеста пользователя.
    const unlock = () => {
      void audio.unlock();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  pauseFromSystem(): void {
    if (!this.started || this.paused) return;
    this.pause(true);
  }

  resumeFromSystem(): void {
    // Игра сознательно не продолжается сама: игрок мог вернуться в опасный
    // момент, поэтому его встречает меню паузы.
    audio.resume();
    this.loop?.resetTiming();
    this.surface?.resize();
  }

  get shellUi(): ShellUi {
    return this.shell;
  }

  /** Переход к главе из консоли разработчика и браузерных тестов. */
  openChapterForTest(index: number): void {
    this.startChapter(index);
  }
}

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
import { ShellUi, type ShellAction } from './ShellUi';

/**
 * Точка сборки приложения: холст, цикл кадра, ввод, интерфейс и жизненный
 * цикл вкладки. Здесь же живёт правило «после сворачивания не продолжаем игру
 * автоматически, а показываем паузу» из раздела 36 ТЗ.
 */
export class GameApp {
  private surface: Surface | null = null;
  private loop: GameLoop | null = null;
  private scene: PrototypeScene | null = null;
  private input: InputSystem | null = null;
  private readonly camera = new Camera2D();
  private readonly hud = new PrototypeHud();
  private readonly shell = new ShellUi();
  private started = false;
  private paused = false;

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

    this.scene = new PrototypeScene({
      surface: this.surface,
      camera: this.camera,
      painter,
      input: this.input,
      hud: this.hud,
      getFps: () => this.loop?.fps ?? 0,
      onComplete: (stats) => this.handleComplete(stats),
      onPauseRequested: () => this.pause(false),
    });

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
        case 'quit':
          this.stopGame(scene);
          break;
        default:
          break;
      }
    });
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
    settingsRepository.recordCompletion(stats.timeMs);
    this.scene?.setRunning(false);
    this.paused = true;
    this.started = false;
    this.shell.showResults(stats, settingsRepository.currentProgress.bestTimeMs);
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
}

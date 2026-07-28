import Phaser from 'phaser';
import { events } from '../core/events/EventBus';
import type { RunStats } from '../core/events/GameEvents';
import { audio } from '../game/audio/AudioEngine';
import { InputSystem } from '../game/input/InputSystem';
import { settingsRepository } from '../game/save/SettingsRepository';
import { PrototypeScene } from '../game/scenes/PrototypeScene';
import { PrototypeHud } from '../game/ui/PrototypeHud';
import { ShellUi, type ShellAction } from './ShellUi';
import { PALETTE } from './Palette';
import { createRuntimeTextures } from '../game/render/TextureFactory';

/**
 * Точка сборки приложения: игра Phaser, ввод, интерфейс и жизненный цикл
 * вкладки. Здесь же живёт правило «после сворачивания не продолжаем игру
 * автоматически, а показываем паузу» из раздела 36 ТЗ.
 */
export class GameApp {
  private game: Phaser.Game | null = null;
  private input: InputSystem | null = null;
  private readonly shell = new ShellUi();
  private renderScale = 1;
  private started = false;
  private paused = false;
  private resizeRaf = 0;

  async boot(): Promise<void> {
    this.shell.setLoadingProgress(0.1, 'Пробуем нить на прочность…');
    await settingsRepository.load();
    this.applyDocumentSettings();

    this.shell.setLoadingProgress(0.35, 'Растягиваем каркас сети…');

    const parent = document.getElementById('game-root');
    if (!parent) throw new Error('Не найден контейнер #game-root');

    this.renderScale = this.computeRenderScale();

    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      backgroundColor: PALETTE.skyTop,
      scale: {
        mode: Phaser.Scale.NONE,
        width: Math.max(1, Math.floor(window.innerWidth * this.renderScale)),
        height: Math.max(1, Math.floor(window.innerHeight * this.renderScale)),
      },
      render: {
        antialias: true,
        roundPixels: false,
        powerPreference: 'high-performance',
      },
      physics: {
        default: 'matter',
        matter: {
          enableSleeping: true,
          gravity: { x: 0, y: 1.75 },
          // Отладочная отрисовка Matter не нужна: свой слой информативнее.
          debug: false,
        },
      },
      fps: {
        target: 60,
        min: 30,
        smoothStep: true,
      },
      // Сцены добавляются вручную после готовности игры: им нужны ссылки на
      // ввод и интерфейс ещё до первого `create()`.
      scene: [],
      audio: { noAudio: true },
      banner: false,
    });

    await this.waitForGameReady();
    // Текстуры готовятся до старта сцен: ими пользуется и HUD, и мир.
    createRuntimeTextures(this.game.textures);
    this.shell.setLoadingProgress(0.7, 'Развешиваем капли росы…');

    const canvas = this.game.canvas;
    this.applyCanvasStyle(canvas);
    this.input = new InputSystem(canvas);
    this.input.setRenderScale(this.renderScale);

    const scene = this.game.scene.add(
      'PrototypeScene',
      PrototypeScene,
      false,
    ) as unknown as PrototypeScene;
    const hud = this.game.scene.add(
      'PrototypeHud',
      PrototypeHud,
      false,
    ) as unknown as PrototypeHud;

    hud.configure({
      input: this.input,
      renderScale: this.renderScale,
      getWebLoad: () => scene.webLoad,
      getCutAvailable: () => scene.cutAvailable,
      getAiming: () => scene.aiming,
      getTethered: () => scene.tethered,
      getAnchorable: () => scene.anchorable,
    });

    scene.configure({
      input: this.input,
      hud,
      onComplete: (stats) => this.handleComplete(stats),
      onPauseRequested: () => this.pause(false),
    });

    // HUD запускается первым, чтобы его `create()` успел построить слои до
    // того, как игровая сцена начнёт обращаться к подсказкам и затемнению;
    // затем он поднимается наверх, поверх мира.
    this.game.scene.start('PrototypeHud');
    this.game.scene.start('PrototypeScene');
    this.game.scene.bringToTop('PrototypeHud');

    this.bindShell(scene);
    this.bindLifecycle(scene);

    settingsRepository.onChange((settings) => {
      audio.setVolumes(settings.masterVolume, settings.musicVolume, settings.sfxVolume);
      this.applyDocumentSettings();
      if (this.game) this.game.loop.targetFps = settings.frameCap;
    });

    this.shell.setLoadingProgress(1, 'Готово');
    window.setTimeout(() => this.shell.show('menu'), 320);
  }

  private waitForGameReady(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.game) {
        resolve();
        return;
      }
      this.game.events.once(Phaser.Core.Events.READY, () => resolve());
      // Страховка: если событие уже прошло, не подвисаем на загрузке.
      window.setTimeout(resolve, 3000);
    });
  }

  private computeRenderScale(): number {
    // Рендер в физических пикселях, но не выше 2× — на телефонах с DPR 3
    // третий множитель почти не виден, а стоит трети кадрового бюджета.
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  private applyCanvasStyle(canvas: HTMLCanvasElement): void {
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
  }

  private applyDocumentSettings(): void {
    const settings = settingsRepository.current;
    document.documentElement.style.setProperty('--ui-scale', String(settings.uiScale));
  }

  // ------------------------------------------------------------------ шелл

  private bindShell(scene: PrototypeScene): void {
    this.shell.onAction((action: ShellAction) => {
      switch (action) {
        case 'play':
          void this.startGame(scene);
          break;
        case 'resume':
          this.resume(scene);
          break;
        case 'restart':
          scene.restartRoom();
          this.resume(scene);
          break;
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
    scene.setRunning(true);
    this.input?.setEnabled(true);
    audio.resume();
    events.emit('game:resumed', {});
  }

  private pause(fromSystem: boolean): void {
    if (this.paused || !this.started) return;
    this.paused = true;
    const scene = this.game?.scene.getScene('PrototypeScene') as unknown as PrototypeScene | undefined;
    scene?.setRunning(false);
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
    const scene = this.game?.scene.getScene('PrototypeScene') as unknown as PrototypeScene | undefined;
    scene?.setRunning(false);
    this.paused = true;
    this.started = false;
    this.shell.showResults(stats, settingsRepository.currentProgress.bestTimeMs);
  }

  // ------------------------------------------------------- жизненный цикл

  private bindLifecycle(scene: PrototypeScene): void {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pauseFromSystem();
      else this.resumeFromSystem();
    });

    window.addEventListener('pagehide', () => this.pauseFromSystem());
    window.addEventListener('blur', () => this.pauseFromSystem());

    window.addEventListener('resize', () => this.scheduleResize());
    window.addEventListener('orientationchange', () => window.setTimeout(() => this.resize(), 180));

    // Первое касание разблокирует звук: браузеры не дают включить
    // AudioContext без жеста пользователя.
    const unlock = () => {
      void audio.unlock();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    void scene;
  }

  pauseFromSystem(): void {
    if (!this.started || this.paused) return;
    this.pause(true);
  }

  resumeFromSystem(): void {
    // Игра сознательно не продолжается сама: игрок мог вернуться в опасный
    // момент, поэтому его встречает меню паузы.
    audio.resume();
    this.resize();
  }

  private scheduleResize(): void {
    if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0;
      this.resize();
    });
  }

  private resize(): void {
    if (!this.game) return;
    this.renderScale = this.computeRenderScale();
    const width = Math.max(1, Math.floor(window.innerWidth * this.renderScale));
    const height = Math.max(1, Math.floor(window.innerHeight * this.renderScale));
    this.game.scale.resize(width, height);
    this.applyCanvasStyle(this.game.canvas);
    this.input?.setRenderScale(this.renderScale);
    this.input?.touch.invalidateRect();
    const hud = this.game.scene.getScene('PrototypeHud') as unknown as PrototypeHud | undefined;
    hud?.setRenderScale(this.renderScale);
  }

  get shellUi(): ShellUi {
    return this.shell;
  }
}

import type { RunStats } from '../core/events/GameEvents';
import { audio } from '../game/audio/AudioEngine';
import { settingsRepository } from '../game/save/SettingsRepository';
import type { GameSettings } from '../core/storage/StorageTypes';

export type ShellScreen =
  | 'loading'
  | 'menu'
  | 'pause'
  | 'settings'
  | 'howto'
  | 'chapters'
  | 'results'
  | null;

export type ShellAction =
  | 'play'
  | 'resume'
  | 'restart'
  | 'settings'
  | 'howto'
  | 'chapters'
  | 'next'
  | 'quit'
  | 'replay'
  | 'close'
  | 'install'
  | 'update'
  | 'settings-reset'
  | 'toast-dismiss';

/** Строка списка глав. Всё, что нужно нарисовать, приходит уже посчитанным. */
export interface ChapterEntry {
  index: number;
  numeral: string;
  title: string;
  subtitle: string;
  unlocked: boolean;
  completed: boolean;
  current: boolean;
  bestTimeMs: number | null;
  blooms: number;
  bloomsTotal: number;
}

/** Что показать на экране итогов, помимо самих цифр. */
export interface ResultsContext {
  chapterNumeral: string;
  chapterTitle: string;
  bestTimeMs: number | null;
  /** Название следующей главы или null, если это была последняя. */
  nextTitle: string | null;
}

/**
 * HTML-слой поверх игры: загрузка, меню, пауза, настройки, результаты.
 *
 * Меню сделаны на DOM, а не средствами Phaser, сознательно: полупрозрачное
 * стекло, плавные переходы, прокрутка длинного списка настроек и системная
 * доступность достаются здесь бесплатно, а игровой канвас в это время не
 * тратит ни одного draw call.
 */
export class ShellUi {
  private readonly screens = new Map<string, HTMLElement>();
  private current: ShellScreen = 'loading';
  private previousScreen: ShellScreen = null;
  private handler: (action: ShellAction) => void = () => {};
  private installPrompt: (() => void) | null = null;
  private chapterSource: () => ChapterEntry[] = () => [];
  private chapterPick: (index: number) => void = () => {};

  constructor() {
    for (const id of [
      'loading',
      'menu',
      'pause',
      'settings',
      'howto',
      'chapters',
      'results',
      'rotate',
    ]) {
      const element = document.getElementById(`screen-${id}`);
      if (element) this.screens.set(id, element);
    }

    document.getElementById('ui-root')?.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
      if (!target) return;
      const action = target.dataset.action as ShellAction;
      audio.playUi(action === 'quit' || action === 'close' ? 'back' : 'confirm');
      this.dispatch(action);
    });

    this.buildLoadingWeb();
    this.buildSettings();
    this.watchOrientation();
    this.watchInstall();
  }

  onAction(handler: (action: ShellAction) => void): void {
    this.handler = handler;
  }

  /**
   * Источник списка глав и обработчик выбора.
   *
   * Список пересобирается каждый раз при открытии экрана: прогресс меняется
   * прямо во время сессии, и хранить построенную разметку значило бы держать
   * её в согласии с прогрессом вручную.
   */
  configureChapters(source: () => ChapterEntry[], onPick: (index: number) => void): void {
    this.chapterSource = source;
    this.chapterPick = onPick;
  }

  /** Подпись под кнопкой «Играть»: какая глава продолжится. */
  setPlayNote(text: string): void {
    const element = document.getElementById('menu-play-note');
    if (element) element.textContent = text;
  }

  /** Подпись под кнопкой «Главы»: сколько уже пройдено. */
  setChaptersNote(text: string): void {
    const element = document.getElementById('menu-chapters-note');
    if (element) element.textContent = text;
  }

  private dispatch(action: ShellAction): void {
    if (action === 'settings') {
      this.previousScreen = this.current;
      this.show('settings');
      return;
    }
    if (action === 'howto') {
      this.previousScreen = this.current;
      this.show('howto');
      return;
    }
    if (action === 'chapters') {
      this.previousScreen = this.current;
      this.buildChapters();
      this.show('chapters');
      return;
    }
    if (action === 'close') {
      this.show(this.previousScreen ?? 'menu');
      return;
    }
    if (action === 'settings-reset') {
      settingsRepository.reset();
      this.buildSettings();
      return;
    }
    if (action === 'install') {
      this.installPrompt?.();
      return;
    }
    if (action === 'toast-dismiss') {
      document.getElementById('toast-update')?.setAttribute('hidden', '');
      return;
    }
    this.handler(action);
  }

  show(screen: ShellScreen): void {
    this.current = screen;
    for (const [id, element] of this.screens) {
      if (id === 'rotate') continue;
      element.classList.toggle('is-visible', id === screen);
    }
    document.getElementById('game-root')?.setAttribute(
      'aria-hidden',
      screen === null ? 'false' : 'true',
    );
  }

  get visibleScreen(): ShellScreen {
    return this.current;
  }

  setLoadingProgress(value: number, hint?: string): void {
    const fill = document.getElementById('loading-fill');
    if (fill) fill.style.width = `${Math.round(value * 100)}%`;
    if (hint) {
      const element = document.getElementById('loading-hint');
      if (element) element.textContent = hint;
    }
  }

  showResults(stats: RunStats, context: ResultsContext): void {
    const list = document.getElementById('results-stats');
    if (!list) return;

    const eyebrow = document.getElementById('results-eyebrow');
    if (eyebrow) eyebrow.textContent = `Глава ${context.chapterNumeral} пройдена`;
    const title = document.getElementById('results-title');
    if (title) title.textContent = context.chapterTitle;

    const rows: [string, string, boolean][] = [
      ['Время прохождения', formatTime(stats.timeMs), true],
      [
        'Лучшее время',
        context.bestTimeMs !== null ? formatTime(context.bestTimeMs) : '—',
        false,
      ],
      ['Шёлковые бутоны', `${stats.bloomsCollected} / ${stats.bloomsTotal}`, stats.bloomsTotal > 0],
      ['Падений', String(stats.falls), false],
      ['Создано нитей', String(stats.strandsCreated), false],
      ['Разрывов', String(stats.strandsBroken), false],
      ['Больше всего нитей сразу', String(stats.peakStrands), false],
      ['Прыжков', String(stats.jumps), false],
      ['На паутине', formatTime(stats.swingTimeMs), false],
    ];
    list.innerHTML = rows
      .map(
        ([label, value, highlight]) =>
          `<li class="${highlight ? 'is-highlight' : ''}"><span>${label}</span><b>${value}</b></li>`,
      )
      .join('');

    // Кнопка «Дальше» прячется на последней главе: вести оттуда некуда.
    const next = document.getElementById('btn-next-chapter');
    if (next) {
      if (context.nextTitle) {
        next.removeAttribute('hidden');
        const note = document.getElementById('next-chapter-note');
        if (note) note.textContent = context.nextTitle;
      } else {
        next.setAttribute('hidden', '');
        const note = document.getElementById('next-chapter-note');
        // Подпись стирается вместе с кнопкой: иначе на последней главе в
        // разметке остаётся название комнаты, которой дальше нет.
        if (note) note.textContent = '';
      }
    }

    this.show('results');
  }

  // ----------------------------------------------------------------- главы

  private buildChapters(): void {
    const container = document.getElementById('chapters-list');
    if (!container) return;
    container.innerHTML = '';

    for (const entry of this.chapterSource()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chapter';
      if (entry.current) button.classList.add('is-current');
      if (!entry.unlocked) button.disabled = true;

      const mark = entry.completed
        ? `<b>${entry.bestTimeMs !== null ? formatTime(entry.bestTimeMs) : 'пройдено'}</b>` +
          (entry.bloomsTotal > 0 ? `<span>${entry.blooms} / ${entry.bloomsTotal} ✿</span>` : '')
        : entry.unlocked
          ? '<span>открыта</span>'
          : '<span>закрыта</span>';

      button.innerHTML =
        `<span class="chapter__numeral">${entry.numeral}</span>` +
        `<span class="chapter__text"><b>${entry.title}</b><i>${entry.subtitle}</i></span>` +
        `<span class="chapter__mark">${mark}</span>`;

      if (entry.unlocked) {
        button.addEventListener('click', () => {
          audio.playUi('confirm');
          this.chapterPick(entry.index);
        });
      }
      container.append(button);
    }
  }

  showUpdateToast(onUpdate: () => void): void {
    const toast = document.getElementById('toast-update');
    if (!toast) return;
    toast.removeAttribute('hidden');
    toast.querySelector<HTMLElement>('[data-action="update"]')?.addEventListener(
      'click',
      onUpdate,
      { once: true },
    );
  }

  // -------------------------------------------------------------- настройки

  private buildSettings(): void {
    const body = document.getElementById('settings-body');
    if (!body) return;
    body.innerHTML = '';

    const settings = settingsRepository.current;

    const group = (title: string): HTMLElement => {
      const element = document.createElement('div');
      element.className = 'set-group';
      element.innerHTML = `<p class="set-group__title">${title}</p>`;
      body.append(element);
      return element;
    };

    const row = (parent: HTMLElement, label: string, note?: string): HTMLElement => {
      const element = document.createElement('div');
      element.className = 'set-row';
      element.innerHTML = `<div class="set-row__text"><b>${label}</b>${
        note ? `<i>${note}</i>` : ''
      }</div>`;
      parent.append(element);
      return element;
    };

    const toggle = (
      parent: HTMLElement,
      label: string,
      key: keyof GameSettings,
      note?: string,
    ): void => {
      const container = row(parent, label, note);
      const button = document.createElement('button');
      button.className = 'switch';
      button.type = 'button';
      button.setAttribute('role', 'switch');
      button.setAttribute('aria-checked', String(Boolean(settings[key])));
      button.setAttribute('aria-label', label);
      button.addEventListener('click', () => {
        const next = button.getAttribute('aria-checked') !== 'true';
        button.setAttribute('aria-checked', String(next));
        settingsRepository.patch({ [key]: next } as Partial<GameSettings>);
        audio.playUi('tap');
      });
      container.append(button);
    };

    const slider = (
      parent: HTMLElement,
      label: string,
      key: keyof GameSettings,
      min: number,
      max: number,
      step: number,
      format: (value: number) => string,
      note?: string,
    ): void => {
      const container = row(parent, label, note);
      const wrapper = document.createElement('div');
      wrapper.className = 'slider';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(settings[key]);
      input.setAttribute('aria-label', label);
      const output = document.createElement('output');
      output.textContent = format(Number(settings[key]));
      input.addEventListener('input', () => {
        const value = Number(input.value);
        output.textContent = format(value);
        settingsRepository.patch({ [key]: value } as Partial<GameSettings>);
      });
      wrapper.append(input, output);
      container.append(wrapper);
    };

    const segmented = <T extends string | number>(
      parent: HTMLElement,
      label: string,
      key: keyof GameSettings,
      options: [T, string][],
      note?: string,
    ): void => {
      const container = row(parent, label, note);
      const wrapper = document.createElement('div');
      wrapper.className = 'segmented';
      for (const [value, text] of options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.setAttribute('aria-pressed', String(settings[key] === value));
        button.addEventListener('click', () => {
          settingsRepository.patch({ [key]: value } as Partial<GameSettings>);
          for (const sibling of wrapper.children) {
            sibling.setAttribute('aria-pressed', String(sibling === button));
          }
          audio.playUi('tap');
        });
        wrapper.append(button);
      }
      container.append(wrapper);
    };

    const percent = (value: number) => `${Math.round(value * 100)}%`;

    const sound = group('Звук');
    slider(sound, 'Общая громкость', 'masterVolume', 0, 1, 0.05, percent);
    slider(sound, 'Музыка и окружение', 'musicVolume', 0, 1, 0.05, percent);
    slider(sound, 'Эффекты', 'sfxVolume', 0, 1, 0.05, percent);

    const screen = group('Экран');
    this.addFullscreenRow(row(screen, 'Полноэкранный режим', 'Убирает панели браузера'));

    const controls = group('Управление');
    segmented(
      controls,
      'Экранные кнопки',
      'onScreenControls',
      [
        ['auto', 'Авто'],
        ['on', 'Всегда'],
        ['off', 'Скрыть'],
      ],
      'Стик и кнопки поверх игры. «Авто» — по наличию сенсора',
    );
    toggle(controls, 'Леворукий режим', 'leftHanded', 'Стик справа, кнопки слева');
    toggle(controls, 'Фиксированный стик', 'fixedStick', 'Иначе стик появляется под пальцем');
    slider(
      controls,
      'Помощь при прицеливании',
      'aimAssist',
      0,
      1,
      0.1,
      percent,
      'Расширяет конус поиска точки крепления',
    );
    toggle(
      controls,
      'Замедление при прицеливании',
      'slowMotionAiming',
      'Время замедляется, пока удерживается паутина',
    );

    const display = group('Интерфейс');
    segmented(display, 'Размер интерфейса', 'uiScale', [
      [0.8, '80%'],
      [1, '100%'],
      [1.2, '120%'],
      [1.4, '140%'],
    ]);
    slider(display, 'Прозрачность', 'uiOpacity', 0.35, 1, 0.05, percent);
    toggle(display, 'Подсказки', 'hintsEnabled');
    toggle(display, 'Счётчик FPS', 'showFps');

    const graphics = group('Графика');
    segmented(graphics, 'Качество', 'quality', [
      ['low', 'Низкое'],
      ['medium', 'Среднее'],
      ['high', 'Высокое'],
    ]);
    segmented(graphics, 'Частота кадров', 'frameCap', [
      [30, '30 FPS'],
      [60, '60 FPS'],
    ]);
    toggle(graphics, 'Тряска камеры', 'cameraShake');
    toggle(graphics, 'Меньше частиц', 'reducedParticles');
    toggle(
      graphics,
      'Контрастная паутина',
      'highContrastWeb',
      'Толще и ярче на любом фоне',
    );

    const service = group('Диагностика');
    toggle(
      service,
      'Панель состояния',
      'showDiagnostics',
      'Живые значения ввода и физики поверх игры',
    );
    this.addVersionRow(row(service, 'Версия сборки', __BUILD_ID__));
  }

  /**
   * Строка сборки и принудительное обновление.
   *
   * Service worker держит игру офлайн, но из-за этого игрок может неделями
   * сидеть на старой версии, если пропустил уведомление. Кнопка сбрасывает
   * все кэши и перезагружает страницу — по номеру сборки сразу видно,
   * помогло ли.
   */
  private addVersionRow(container: HTMLElement): void {
    const button = document.createElement('button');
    button.className = 'btn btn--ghost';
    button.type = 'button';
    button.style.width = 'auto';
    button.innerHTML = '<span class="btn__label"><b>Обновить</b></span>';
    button.addEventListener('click', () => {
      void forceUpdate();
    });
    container.append(button);
  }

  /**
   * Переключатель полноэкранного режима.
   *
   * Значение не хранится в настройках: войти в полный экран можно только из
   * жеста пользователя, поэтому «восстановить» состояние при загрузке всё
   * равно нельзя. Переключатель отражает фактическое состояние документа и
   * слушает `fullscreenchange` — выход по Esc обязан вернуть его обратно.
   */
  private addFullscreenRow(container: HTMLElement): void {
    const button = document.createElement('button');
    button.className = 'switch';
    button.type = 'button';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-label', 'Полноэкранный режим');

    const supported =
      typeof document.documentElement.requestFullscreen === 'function' ||
      typeof (
        document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }
      ).webkitRequestFullscreen === 'function';

    const sync = () => button.setAttribute('aria-checked', String(isFullscreen()));
    sync();

    if (!supported) {
      // iOS Safari не умеет разворачивать произвольный элемент. Честно
      // говорим об этом вместо неработающей кнопки.
      button.disabled = true;
      button.style.opacity = '0.4';
      const note = container.querySelector('.set-row__text i');
      if (note) note.textContent = 'Браузер не поддерживает; добавьте игру на домашний экран';
    } else {
      button.addEventListener('click', () => {
        void toggleFullscreen();
        audio.playUi('tap');
      });
      document.addEventListener('fullscreenchange', sync);
      document.addEventListener('webkitfullscreenchange', sync);
    }

    container.append(button);
  }

  // -------------------------------------------------------------- служебное

  /** Рисует анимированную паутину на экране загрузки. */
  private buildLoadingWeb(): void {
    const radials = document.querySelector('.loading__radials');
    const spiral = document.querySelector('.loading__spiral');
    if (!radials || !spiral) return;

    const cx = 120;
    const cy = 120;
    const spokes = 10;
    const radius = 104;

    for (let i = 0; i < spokes; i++) {
      const angle = (i / spokes) * Math.PI * 2 - Math.PI / 2;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(cx));
      line.setAttribute('y1', String(cy));
      line.setAttribute('x2', String(cx + Math.cos(angle) * radius));
      line.setAttribute('y2', String(cy + Math.sin(angle) * radius));
      line.style.setProperty('--delay', `${i * 0.045}s`);
      radials.append(line);
    }

    for (let ring = 1; ring <= 4; ring++) {
      const r = (radius / 4.6) * ring + 14;
      let d = '';
      for (let i = 0; i <= spokes; i++) {
        const angle = (i / spokes) * Math.PI * 2 - Math.PI / 2;
        // Лёгкое провисание между лучами: настоящая паутина не круглая.
        const sag = r * 0.055;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) {
          d += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
        } else {
          const midAngle = angle - Math.PI / spokes;
          const mx = cx + Math.cos(midAngle) * (r - sag);
          const my = cy + Math.sin(midAngle) * (r - sag);
          d += ` Q ${mx.toFixed(1)} ${my.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
        }
      }
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      const perimeter = 2 * Math.PI * r * 1.05;
      path.style.setProperty('--len', String(Math.round(perimeter)));
      path.style.setProperty('--delay', `${0.35 + ring * 0.18}s`);
      spiral.append(path);
    }
  }

  private watchOrientation(): void {
    const rotate = this.screens.get('rotate');
    if (!rotate) return;
    const check = () => {
      // Экран-заглушка появляется только на узких портретных устройствах:
      // на планшете портретная ориентация играбельна.
      const portrait = window.innerHeight > window.innerWidth;
      const small = Math.min(window.innerWidth, window.innerHeight) < 560;
      rotate.classList.toggle('is-visible', portrait && small);
    };
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', () => setTimeout(check, 120));
    check();
  }

  private watchInstall(): void {
    const button = document.getElementById('btn-install');
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      const prompt = event as Event & { prompt: () => Promise<void> };
      this.installPrompt = () => void prompt.prompt();
      button?.removeAttribute('hidden');
    });
    window.addEventListener('appinstalled', () => {
      button?.setAttribute('hidden', '');
      this.installPrompt = null;
    });
  }
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void>;
};

export const isFullscreen = (): boolean => {
  const doc = document as FullscreenDocument;
  return Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);
};

/**
 * Вход и выход из полноэкранного режима с учётом префиксов Safari.
 * Ошибки гасятся: браузер вправе отказать (например, если жест «протух»),
 * и падать из-за этого игра не должна.
 */
export const toggleFullscreen = async (): Promise<void> => {
  const doc = document as FullscreenDocument;
  const root = document.documentElement as FullscreenElement;
  try {
    if (isFullscreen()) {
      await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
    } else {
      await (root.requestFullscreen?.({ navigationUI: 'hide' }) ?? root.webkitRequestFullscreen?.());
    }
  } catch (error) {
    console.warn('[Silkbound] Полноэкранный режим недоступен', error);
  }
};

/** Полный сброс кэшей и регистраций service worker с перезагрузкой. */
export const forceUpdate = async (): Promise<void> => {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.warn('[Silkbound] Не удалось очистить кэш', error);
  }
  location.reload();
};

export const formatTime = (ms: number): string => {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const hundredths = Math.floor((totalSeconds % 1) * 100);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
};

import Phaser from 'phaser';
import { inputConfig, webConfig } from '../../app/GameConfig';
import { PALETTE, mixColor } from '../../app/Palette';
import { clamp01, damp, easeOutBack, easeOutCubic } from '../../core/math/Interpolation';
import { events } from '../../core/events/EventBus';
import type { InputSystem } from '../input/InputSystem';
import type { TouchButtonLayout } from '../input/TouchInputAdapter';
import { settingsRepository } from '../save/SettingsRepository';
import { TEXTURES } from '../render/TextureFactory';

interface HintState {
  id: string;
  text: string;
  alpha: number;
  target: number;
  timer: number;
}

/**
 * Экранный интерфейс: стик, кнопки, индикатор сети, подсказки, затемнение.
 *
 * HUD живёт отдельной сценой поверх игровой, чтобы не зависеть от масштаба и
 * положения камеры мира. Постоянных элементов ровно столько, сколько требует
 * ТЗ, — стик, прыжок, паутина и мягкий индикатор нагрузки сети.
 */
export class PrototypeHud extends Phaser.Scene {
  private inputSystem!: InputSystem;
  private getWebLoad: () => number = () => 0;
  private getCutAvailable: () => boolean = () => false;
  private getAiming: () => boolean = () => false;
  private getTethered: () => boolean = () => false;
  private getAnchorable: () => boolean = () => false;

  private graphics!: Phaser.GameObjects.Graphics;
  private glow!: Phaser.GameObjects.Graphics;
  private vignette!: Phaser.GameObjects.Image;
  private grain!: Phaser.GameObjects.TileSprite;
  private fade!: Phaser.GameObjects.Rectangle;
  private hintText!: Phaser.GameObjects.Text;
  private titleText!: Phaser.GameObjects.Text;
  private fpsText!: Phaser.GameObjects.Text;

  private renderScale = 1;
  private uiScale = 1;
  private uiOpacity = 0.9;
  private leftHanded = false;
  private touchVisible = false;
  /** Пользовался ли игрок стиком — по этому признаку прячется подсказка. */
  private stickEverUsed = false;
  private hintPhase = 0;

  private hint: HintState | null = null;
  private titleTimer = 0;
  private cutPulse = 0;
  private webPulse = 0;
  private jumpPulse = 0;
  private loadValue = 0;
  private limitFlash = 0;
  private tensionAlert = 0;

  private layout: TouchButtonLayout[] = [];

  constructor() {
    super({ key: 'PrototypeHud', active: false });
  }

  configure(options: {
    input: InputSystem;
    renderScale: number;
    getWebLoad: () => number;
    getCutAvailable: () => boolean;
    getAiming: () => boolean;
    getTethered: () => boolean;
    getAnchorable: () => boolean;
  }): void {
    this.inputSystem = options.input;
    this.renderScale = options.renderScale;
    this.getWebLoad = options.getWebLoad;
    this.getCutAvailable = options.getCutAvailable;
    this.getAiming = options.getAiming;
    this.getTethered = options.getTethered;
    this.getAnchorable = options.getAnchorable;
  }

  create(): void {
    this.glow = this.add.graphics().setDepth(10).setBlendMode(Phaser.BlendModes.ADD);
    this.graphics = this.add.graphics().setDepth(11);

    this.vignette = this.add
      .image(0, 0, TEXTURES.vignette)
      .setOrigin(0, 0)
      .setDepth(5)
      .setAlpha(0.85);

    this.grain = this.add
      .tileSprite(0, 0, 100, 100, TEXTURES.grain)
      .setOrigin(0, 0)
      .setDepth(6)
      .setAlpha(0.5);

    this.hintText = this.add
      .text(0, 0, '', {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: '20px',
        color: '#e6f3f8',
        align: 'center',
      })
      .setOrigin(0.5, 0.5)
      .setDepth(14)
      .setAlpha(0);

    this.titleText = this.add
      .text(0, 0, '', {
        fontFamily: 'Georgia, serif',
        fontSize: '30px',
        color: '#f2f8fb',
        align: 'center',
      })
      .setOrigin(0.5, 0.5)
      .setDepth(14)
      .setAlpha(0);

    this.fpsText = this.add
      .text(0, 0, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#7fe6ff',
      })
      .setOrigin(0, 0)
      .setDepth(15)
      .setAlpha(0);

    this.fade = this.add
      .rectangle(0, 0, 10, 10, 0x04070a)
      .setOrigin(0, 0)
      .setDepth(20)
      .setAlpha(0);

    this.scale.on(Phaser.Scale.Events.RESIZE, this.layoutScreen, this);
    settingsRepository.onChange((settings) => {
      this.uiScale = settings.uiScale;
      this.uiOpacity = settings.uiOpacity;
      this.leftHanded = settings.leftHanded;
      this.fpsText.setAlpha(settings.showFps ? 0.8 : 0);
      this.layoutScreen();
    });

    events.on('hint:show', ({ id, text }) => this.showHint(id, text));
    events.on('hint:hide', ({ id }) => {
      if (this.hint?.id === id) this.hint.target = 0;
    });
    events.on('web:limit-reached', () => {
      this.limitFlash = 1;
    });
    events.on('web:tension-critical', () => {
      this.tensionAlert = 1;
    });

    this.layoutScreen();
  }

  setRenderScale(scale: number): void {
    this.renderScale = scale;
    if (this.vignette) this.layoutScreen();
  }

  showTitle(text: string): void {
    if (!this.titleText) return;
    this.titleText.setText(text);
    this.titleTimer = 3.4;
  }

  showHint(id: string, text: string): void {
    if (!this.hintText) return;
    this.hint = { id, text, alpha: 0, target: 1, timer: 5.5 };
    this.hintText.setText(text);
  }

  hideHint(): void {
    if (this.hint) this.hint.target = 0;
  }

  setFade(alpha: number): void {
    this.fade?.setAlpha(alpha);
  }

  private get dp(): number {
    return this.renderScale * this.uiScale;
  }

  private layoutScreen(): void {
    const width = this.scale.width;
    const height = this.scale.height;
    if (!this.vignette) return;

    this.vignette.setDisplaySize(width, height);
    this.grain.setSize(width, height);
    this.fade.setSize(width, height);

    this.hintText.setPosition(width / 2, height * 0.14);
    this.hintText.setFontSize(Math.round(19 * this.dp));
    this.hintText.setWordWrapWidth(width * 0.7);

    this.titleText.setPosition(width / 2, height * 0.3);
    this.titleText.setFontSize(Math.round(30 * this.dp));

    this.fpsText.setPosition(12 * this.renderScale, 10 * this.renderScale);
    this.fpsText.setFontSize(Math.round(13 * this.renderScale));

    this.buildLayout(width, height);
  }

  private buildLayout(width: number, height: number): void {
    const dp = this.dp;
    const margin = 34 * dp;
    const bottom = height - margin;
    const side = this.leftHanded ? -1 : 1;
    const anchorX = this.leftHanded ? margin : width - margin;

    const jumpRadius = (inputConfig.jumpButtonSize / 2) * dp;
    const webRadius = (inputConfig.webButtonSize / 2) * dp;
    const cutRadius = (inputConfig.cutButtonSize / 2) * dp;
    const spacing = inputConfig.minButtonSpacing * dp;

    // Прыжок ближе к большому пальцу, паутина — выше и левее (для правши).
    const jump = {
      x: anchorX - side * jumpRadius,
      y: bottom - jumpRadius,
    };
    const web = {
      x: jump.x - side * spacing * 0.86,
      y: jump.y - spacing * 0.52,
    };
    const cut = {
      x: web.x - side * spacing * 0.1,
      y: web.y - spacing * 0.78,
    };

    this.layout = [
      { id: 'jump', x: jump.x, y: jump.y, radius: jumpRadius, enabled: true },
      { id: 'web', x: web.x, y: web.y, radius: webRadius, enabled: true },
      { id: 'cut', x: cut.x, y: cut.y, radius: cutRadius, enabled: false },
      {
        id: 'pause',
        x: this.leftHanded ? width - 34 * dp : 34 * dp,
        y: 34 * dp,
        radius: 22 * dp,
        enabled: true,
      },
    ];

    if (this.inputSystem) {
      this.inputSystem.touch.setLayout(this.layout);
      this.inputSystem.touch.setFixedStickOrigin(
        this.leftHanded ? width - 150 * dp : 150 * dp,
        height - 150 * dp,
      );
      this.inputSystem.touch.invalidateRect();
    }
  }

  override update(_time: number, delta: number): void {
    const deltaSeconds = delta / 1000;
    const g = this.graphics;
    const glow = this.glow;
    g.clear();
    glow.clear();

    if (!this.inputSystem) return;

    const preference = settingsRepository.current.onScreenControls;
    this.touchVisible =
      preference === 'on'
        ? true
        : preference === 'off'
          ? false
          : this.inputSystem.touch.controlsVisible;
    const cutAvailable = this.getCutAvailable();
    const cutButton = this.layout.find((b) => b.id === 'cut');
    if (cutButton) cutButton.enabled = cutAvailable && this.touchVisible;

    this.cutPulse = damp(this.cutPulse, cutAvailable ? 1 : 0, 0.12, deltaSeconds);
    this.webPulse = damp(
      this.webPulse,
      this.inputSystem.touch.buttons.web.down ? 1 : 0,
      0.06,
      deltaSeconds,
    );
    this.jumpPulse = damp(
      this.jumpPulse,
      this.inputSystem.touch.buttons.jump.down ? 1 : 0,
      0.06,
      deltaSeconds,
    );
    this.loadValue = damp(this.loadValue, this.getWebLoad(), 0.2, deltaSeconds);
    this.limitFlash = Math.max(0, this.limitFlash - deltaSeconds * 1.6);
    this.tensionAlert = Math.max(0, this.tensionAlert - deltaSeconds * 1.2);

    if (this.touchVisible) {
      this.drawStick(g, glow);
      this.drawButtons(g, glow);
    }
    this.drawPauseButton(g);
    this.drawWebMeter(g, glow);
    this.drawTensionAlert(g);

    this.hintPhase += deltaSeconds;
    this.updateTexts(deltaSeconds);
    this.grain.tilePositionX += delta * 0.02;
    this.grain.tilePositionY -= delta * 0.013;
  }

  // ------------------------------------------------------------------ стик

  private drawStick(g: Phaser.GameObjects.Graphics, glow: Phaser.GameObjects.Graphics): void {
    const stick = this.inputSystem.touch.stick;
    const settings = settingsRepository.current;
    const dp = this.dp;
    const radius = (inputConfig.stickRadius / 2) * dp * 1.1;
    const maxOffset = inputConfig.stickMaxOffset * dp;

    if (stick.active) this.stickEverUsed = true;

    // Плавающий стик появляется под пальцем, поэтому до первого касания на
    // экране не было вообще ничего — игрок просто не догадывался, что левая
    // половина и есть управление. Пока стик не использовали ни разу, на его
    // месте дышит полупрозрачный «призрак» с подсказкой.
    const showGhost = !stick.active && !settings.fixedStick && !this.stickEverUsed;
    if (!stick.active && !settings.fixedStick && !showGhost) return;

    const originX = stick.active
      ? stick.originX
      : this.leftHanded
        ? this.scale.width - 150 * dp
        : 150 * dp;
    const originY = stick.active ? stick.originY : this.scale.height - 150 * dp;

    const breathe = showGhost ? 0.55 + 0.45 * Math.sin(this.hintPhase * 2.4) : 1;
    const alpha = (stick.active ? 0.9 : 0.42 * breathe) * this.uiOpacity;

    // Внешнее кольцо.
    g.lineStyle(2 * dp, PALETTE.uiSilk, 0.22 * alpha);
    g.strokeCircle(originX, originY, radius);
    g.lineStyle(1.2 * dp, PALETTE.uiAccent, 0.16 * alpha);
    g.strokeCircle(originX, originY, maxOffset);

    // Направляющий сектор — подсказывает, куда отклонён стик.
    const magnitude = Math.hypot(stick.valueX, stick.valueY);
    if (magnitude > 0.03) {
      const angle = Math.atan2(stick.valueY, stick.valueX);
      glow.fillStyle(PALETTE.uiAccent, 0.1 * alpha * magnitude);
      glow.slice(originX, originY, maxOffset, angle - 0.5, angle + 0.5, false);
      glow.fillPath();
    }

    if (showGhost) {
      // Две стрелки по горизонтали: главное движение в игре — влево-вправо.
      const reach = maxOffset * 0.72;
      const tip = radius * 0.3;
      g.lineStyle(2.2 * dp, PALETTE.uiSilk, 0.5 * alpha);
      for (const side of [-1, 1]) {
        const x = originX + side * reach;
        g.beginPath();
        g.moveTo(x - side * tip, originY - tip);
        g.lineTo(x, originY);
        g.lineTo(x - side * tip, originY + tip);
        g.strokePath();
      }
    }

    const knobX = originX + stick.valueX * maxOffset;
    const knobY = originY + stick.valueY * maxOffset;

    glow.fillStyle(PALETTE.uiAccent, 0.16 * alpha);
    glow.fillCircle(knobX, knobY, radius * 0.78);
    g.fillStyle(PALETTE.uiSilk, 0.26 * alpha);
    g.fillCircle(knobX, knobY, radius * 0.52);
    g.lineStyle(1.6 * dp, PALETTE.uiSilk, 0.6 * alpha);
    g.strokeCircle(knobX, knobY, radius * 0.52);
  }

  // ----------------------------------------------------------------- кнопки

  private drawButtons(g: Phaser.GameObjects.Graphics, glow: Phaser.GameObjects.Graphics): void {
    const dp = this.dp;

    for (const button of this.layout) {
      if (button.id === 'pause') continue;
      if (!button.enabled && button.id === 'cut') continue;

      const pressed =
        button.id === 'jump' ? this.jumpPulse : button.id === 'web' ? this.webPulse : 0;
      const scale = 1 - pressed * 0.08;
      const radius = button.radius * scale;

      let color: number = PALETTE.uiSilk;
      let label = '';
      let alpha = 0.85 * this.uiOpacity;

      if (button.id === 'jump') {
        color = PALETTE.ok;
        label = 'jump';
      } else if (button.id === 'web') {
        color = this.getAiming() ? PALETTE.uiWarn : PALETTE.uiAccent;
        label = 'web';
      } else {
        color = PALETTE.uiDanger;
        label = 'cut';
        alpha *= this.cutPulse;
      }

      if (alpha < 0.02) continue;

      glow.fillStyle(color, (0.08 + pressed * 0.18) * alpha);
      glow.fillCircle(button.x, button.y, radius * 1.5);

      g.fillStyle(PALETTE.uiInk, 0.42 * alpha);
      g.fillCircle(button.x, button.y, radius);
      g.lineStyle(2 * dp, color, (0.55 + pressed * 0.45) * alpha);
      g.strokeCircle(button.x, button.y, radius);

      this.drawGlyph(g, label, button.x, button.y, radius, color, alpha);

      // Кольцо прогресса удержания паутины — переход в режим прицеливания.
      if (button.id === 'web' && this.inputSystem.touch.buttons.web.down) {
        const progress = clamp01(this.inputSystem.touch.buttons.web.holdMs / 140);
        g.lineStyle(3 * dp, PALETTE.uiWarn, 0.9 * alpha);
        g.beginPath();
        g.arc(
          button.x,
          button.y,
          radius + 5 * dp,
          -Math.PI / 2,
          -Math.PI / 2 + progress * Math.PI * 2,
        );
        g.strokePath();
      }
    }

    // Подпись действия у кнопки паутины меняется по состоянию.
    const web = this.layout.find((b) => b.id === 'web');
    if (web) {
      const caption = this.getAnchorable()
        ? 'закрепить'
        : this.getTethered()
          ? 'сменить нить'
          : this.getAiming()
            ? 'выбор точки'
            : '';
      if (caption) {
        this.drawCaption(g, caption, web.x, web.y + web.radius + 15 * dp);
      }
    }
  }

  private drawGlyph(
    g: Phaser.GameObjects.Graphics,
    kind: string,
    x: number,
    y: number,
    radius: number,
    color: number,
    alpha: number,
  ): void {
    const s = radius * 0.42;
    g.lineStyle(Math.max(1.6, radius * 0.09), color, 0.95 * alpha);

    if (kind === 'jump') {
      // Стрелка вверх с подставкой.
      g.beginPath();
      g.moveTo(x, y - s);
      g.lineTo(x, y + s * 0.5);
      g.moveTo(x - s * 0.62, y - s * 0.25);
      g.lineTo(x, y - s);
      g.lineTo(x + s * 0.62, y - s * 0.25);
      g.strokePath();
      g.lineStyle(Math.max(1.4, radius * 0.07), color, 0.6 * alpha);
      g.beginPath();
      g.moveTo(x - s * 0.7, y + s * 0.85);
      g.lineTo(x + s * 0.7, y + s * 0.85);
      g.strokePath();
    } else if (kind === 'web') {
      // Мини-паутина: три радиуса и два витка.
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(angle) * s, y + Math.sin(angle) * s);
        g.strokePath();
      }
      for (const ring of [0.45, 0.85]) {
        g.beginPath();
        for (let i = 0; i <= 6; i++) {
          const angle = (i / 6) * Math.PI * 2;
          const px = x + Math.cos(angle) * s * ring;
          const py = y + Math.sin(angle) * s * ring;
          if (i === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.strokePath();
      }
    } else {
      // Ножницы.
      g.beginPath();
      g.moveTo(x - s * 0.7, y - s * 0.7);
      g.lineTo(x + s * 0.5, y + s * 0.5);
      g.moveTo(x + s * 0.7, y - s * 0.7);
      g.lineTo(x - s * 0.5, y + s * 0.5);
      g.strokePath();
      g.fillStyle(color, 0.9 * alpha);
      g.fillCircle(x - s * 0.62, y + s * 0.66, s * 0.24);
      g.fillCircle(x + s * 0.62, y + s * 0.66, s * 0.24);
    }
  }

  private drawCaption(
    g: Phaser.GameObjects.Graphics,
    text: string,
    x: number,
    y: number,
  ): void {
    // Подпись рисуется как «псевдотекст»: короткие штрихи вместо букв были бы
    // нечитаемы, поэтому используется настоящий текстовый объект из пула.
    const key = `caption:${text}`;
    let label = this.children.getByName(key) as Phaser.GameObjects.Text | null;
    if (!label) {
      label = this.add
        .text(0, 0, text, {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: `${Math.round(11 * this.dp)}px`,
          color: '#9fb8c4',
        })
        .setName(key)
        .setOrigin(0.5, 0.5)
        .setDepth(13);
    }
    label.setPosition(x, y);
    label.setAlpha(0.8 * this.uiOpacity);
    label.setVisible(true);
    void g;

    // Прячем остальные подписи.
    for (const child of this.children.list) {
      const name = (child as Phaser.GameObjects.GameObject).name;
      if (name.startsWith('caption:') && name !== key) {
        (child as Phaser.GameObjects.Text).setVisible(false);
      }
    }
  }

  private drawPauseButton(g: Phaser.GameObjects.Graphics): void {
    const button = this.layout.find((b) => b.id === 'pause');
    if (!button) return;
    const dp = this.dp;
    const alpha = 0.55 * this.uiOpacity;

    g.fillStyle(PALETTE.uiInk, 0.4 * alpha);
    g.fillCircle(button.x, button.y, button.radius);
    g.lineStyle(1.6 * dp, PALETTE.uiSilk, 0.5 * alpha);
    g.strokeCircle(button.x, button.y, button.radius);

    const bar = button.radius * 0.36;
    g.fillStyle(PALETTE.uiSilk, 0.85 * alpha);
    g.fillRect(button.x - bar * 0.7, button.y - bar, bar * 0.5, bar * 2);
    g.fillRect(button.x + bar * 0.22, button.y - bar, bar * 0.5, bar * 2);
  }

  /**
   * Индикатор сложности сети: четыре состояния без точных чисел
   * (раздел 53.2 ТЗ) — свободно, нагрузка, почти предел, предел.
   */
  private drawWebMeter(g: Phaser.GameObjects.Graphics, glow: Phaser.GameObjects.Graphics): void {
    const web = this.layout.find((b) => b.id === 'web');
    if (!web) return;
    const dp = this.dp;
    const load = this.loadValue;

    const color =
      load > 0.98
        ? PALETTE.uiDanger
        : load > 0.8
          ? PALETTE.uiWarn
          : load > 0.55
            ? mixColor(PALETTE.uiAccent, PALETTE.uiWarn, 0.5)
            : PALETTE.uiAccent;

    const alpha = (0.3 + load * 0.5) * this.uiOpacity;

    if (this.touchVisible) {
      // Дуга вокруг кнопки паутины — палец всё время рядом с ней.
      const radius = web.radius + 12 * dp;
      const sweep = Math.PI * 1.25;
      const start = Math.PI * 0.62;

      g.lineStyle(3 * dp, PALETTE.uiSilk, 0.12 * this.uiOpacity);
      g.beginPath();
      g.arc(web.x, web.y, radius, start, start + sweep);
      g.strokePath();

      if (load > 0.004) {
        g.lineStyle(3 * dp, color, alpha);
        g.beginPath();
        g.arc(web.x, web.y, radius, start, start + sweep * load);
        g.strokePath();
      }

      if (this.limitFlash > 0) {
        const flash = easeOutCubic(this.limitFlash);
        glow.lineStyle(5 * dp, PALETTE.uiDanger, flash * 0.7);
        glow.beginPath();
        glow.arc(web.x, web.y, radius + 4 * dp * (1 - flash), start, start + sweep);
        glow.strokePath();
      }
      return;
    }

    // Без сенсорных кнопок дуга висела бы в пустоте, поэтому на клавиатуре и
    // геймпаде индикатор превращается в компактную полоску в углу.
    const barWidth = 96 * dp;
    const barHeight = 4 * dp;
    const x = this.scale.width - barWidth - 28 * dp;
    const y = 30 * dp;

    g.fillStyle(PALETTE.uiSilk, 0.12 * this.uiOpacity);
    g.fillRoundedRect(x, y, barWidth, barHeight, barHeight / 2);
    if (load > 0.004) {
      g.fillStyle(color, Math.max(alpha, 0.5) * this.uiOpacity);
      g.fillRoundedRect(x, y, Math.max(barHeight, barWidth * load), barHeight, barHeight / 2);
    }
    if (this.limitFlash > 0) {
      const flash = easeOutCubic(this.limitFlash);
      glow.fillStyle(PALETTE.uiDanger, flash * 0.5);
      glow.fillRoundedRect(x - 3 * dp, y - 3 * dp, barWidth + 6 * dp, barHeight + 6 * dp, 4 * dp);
    }
    void webConfig;
  }

  /** Красная кайма экрана, когда нить вот-вот порвётся. */
  private drawTensionAlert(g: Phaser.GameObjects.Graphics): void {
    if (this.tensionAlert <= 0.01) return;
    const width = this.scale.width;
    const height = this.scale.height;
    const alpha = this.tensionAlert * 0.28;
    const thickness = 26 * this.renderScale;
    g.fillStyle(PALETTE.uiDanger, alpha);
    g.fillRect(0, 0, width, thickness);
    g.fillRect(0, height - thickness, width, thickness);
    g.fillRect(0, 0, thickness, height);
    g.fillRect(width - thickness, 0, thickness, height);
  }

  private updateTexts(deltaSeconds: number): void {
    if (this.hint) {
      this.hint.timer -= deltaSeconds;
      if (this.hint.timer <= 0) this.hint.target = 0;
      this.hint.alpha = damp(this.hint.alpha, this.hint.target, 0.18, deltaSeconds);
      this.hintText.setAlpha(this.hint.alpha);
      // Лёгкий подъём при появлении делает подсказку заметной без вспышки.
      this.hintText.setY(
        this.scale.height * 0.14 + (1 - easeOutCubic(this.hint.alpha)) * 14 * this.dp,
      );
      if (this.hint.alpha < 0.01 && this.hint.target === 0) this.hint = null;
    }

    if (this.titleTimer > 0) {
      this.titleTimer -= deltaSeconds;
      const t = this.titleTimer;
      const alpha = t > 2.6 ? easeOutBack(clamp01((3.4 - t) / 0.8)) : clamp01(t / 1.1);
      this.titleText.setAlpha(clamp01(alpha) * 0.95);
    } else {
      this.titleText.setAlpha(0);
    }

    if (settingsRepository.current.showFps) {
      this.fpsText.setText(`${Math.round(this.game.loop.actualFps)} FPS`);
    }
  }
}

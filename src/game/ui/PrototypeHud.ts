import { aimConfig, inputConfig } from '../../app/GameConfig';
import { PALETTE, mixColor } from '../../app/Palette';
import { clamp01, damp, easeOutBack, easeOutCubic } from '../../core/math/Interpolation';
import { events } from '../../core/events/EventBus';
import { cssColor } from '../../engine/Color';
import type { Painter } from '../../engine/Painter';
import { textures } from '../../engine/TextureStore';
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

const SANS = 'Inter, system-ui, sans-serif';
const SERIF = 'Georgia, serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * Экранный интерфейс: стик, кнопки, индикатор сети, подсказки, затемнение.
 *
 * Интерфейс рисуется в экранных координатах поверх мира и не зависит ни от
 * камеры, ни от плотности пикселей: холст уже приведён к CSS-пикселям, поэтому
 * размеры кнопок из настроек означают ровно то, что написано, на любом
 * телефоне. Постоянных элементов ровно столько, сколько требует ТЗ, — стик,
 * прыжок, паутина и мягкий индикатор нагрузки сети.
 */
export class PrototypeHud {
  private inputSystem: InputSystem | null = null;
  private getWebLoad: () => number = () => 0;
  private getCutAvailable: () => boolean = () => false;
  private getAiming: () => boolean = () => false;
  private getTethered: () => boolean = () => false;
  private getAnchorable: () => boolean = () => false;
  private getFps: () => number = () => 0;
  /** Поставщик живых значений для панели диагностики. */
  private diagnostics: (() => string) | null = null;

  private width = 1;
  private height = 1;
  private uiScale = 1;
  private uiOpacity = 0.9;
  private leftHanded = false;
  private touchVisible = false;
  /** Пользовался ли игрок стиком — по этому признаку прячется подсказка. */
  private stickEverUsed = false;
  private hintPhase = 0;

  private hint: HintState | null = null;
  private hintLines: string[] = [];
  private hintSource = '';
  private title = '';
  private titleTimer = 0;
  private cutPulse = 0;
  private webPulse = 0;
  private jumpPulse = 0;
  private loadValue = 0;
  private limitFlash = 0;
  private tensionAlert = 0;
  private fadeAlpha = 0;
  private grainOffsetX = 0;
  private grainOffsetY = 0;
  private grainPattern: CanvasPattern | null = null;

  private layout: TouchButtonLayout[] = [];
  private readonly disposers: (() => void)[] = [];

  configure(options: {
    input: InputSystem;
    getWebLoad: () => number;
    getCutAvailable: () => boolean;
    getAiming: () => boolean;
    getTethered: () => boolean;
    getAnchorable: () => boolean;
    getFps: () => number;
  }): void {
    this.inputSystem = options.input;
    this.getWebLoad = options.getWebLoad;
    this.getCutAvailable = options.getCutAvailable;
    this.getAiming = options.getAiming;
    this.getTethered = options.getTethered;
    this.getAnchorable = options.getAnchorable;
    this.getFps = options.getFps;

    this.disposers.push(
      events.on('hint:show', ({ id, text }) => this.showHint(id, text)),
      events.on('hint:hide', ({ id }) => {
        if (this.hint?.id === id) this.hint.target = 0;
      }),
      events.on('web:limit-reached', () => {
        this.limitFlash = 1;
      }),
      events.on('web:tension-critical', () => {
        this.tensionAlert = 1;
      }),
    );

    settingsRepository.onChange((settings) => {
      this.uiScale = settings.uiScale;
      this.uiOpacity = settings.uiOpacity;
      this.leftHanded = settings.leftHanded;
      this.resize(this.width, this.height);
    });

    const settings = settingsRepository.current;
    this.uiScale = settings.uiScale;
    this.uiOpacity = settings.uiOpacity;
    this.leftHanded = settings.leftHanded;
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  /** Сцена передаёт сюда сборщик диагностики; интерфейс только рисует результат. */
  setDiagnosticsSource(source: () => string): void {
    this.diagnostics = source;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.hintLines = [];
    this.buildLayout();
  }

  showTitle(text: string): void {
    this.title = text;
    this.titleTimer = 3.4;
  }

  showHint(id: string, text: string): void {
    this.hint = { id, text, alpha: 0, target: 1, timer: 5.5 };
    this.hintLines = [];
  }

  hideHint(): void {
    if (this.hint) this.hint.target = 0;
  }

  setFade(alpha: number): void {
    this.fadeAlpha = alpha;
  }

  private get dp(): number {
    return this.uiScale;
  }

  private buildLayout(): void {
    const dp = this.dp;
    const width = this.width;
    const height = this.height;
    const margin = 34 * dp;
    const bottom = height - margin;
    const side = this.leftHanded ? -1 : 1;
    const anchorX = this.leftHanded ? margin : width - margin;

    const jumpRadius = (inputConfig.jumpButtonSize / 2) * dp;
    const webRadius = (inputConfig.webButtonSize / 2) * dp;
    const cutRadius = (inputConfig.cutButtonSize / 2) * dp;
    const spacing = inputConfig.minButtonSpacing * dp;

    // Прыжок ближе к большому пальцу, паутина — выше и левее (для правши).
    const jump = { x: anchorX - side * jumpRadius, y: bottom - jumpRadius };
    const web = { x: jump.x - side * spacing * 0.86, y: jump.y - spacing * 0.52 };
    const cut = { x: web.x - side * spacing * 0.1, y: web.y - spacing * 0.78 };

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

    const input = this.inputSystem;
    if (input) {
      input.touch.setLayout(this.layout);
      input.touch.setFixedStickOrigin(
        this.leftHanded ? width - 150 * dp : 150 * dp,
        height - 150 * dp,
      );
      input.touch.invalidateRect();
    }
  }

  // ------------------------------------------------------------- симуляция

  update(deltaSeconds: number): void {
    const input = this.inputSystem;
    if (!input) return;

    const preference = settingsRepository.current.onScreenControls;
    this.touchVisible =
      preference === 'on' ? true : preference === 'off' ? false : input.touch.controlsVisible;

    const cutAvailable = this.getCutAvailable();
    const cutButton = this.layout.find((b) => b.id === 'cut');
    if (cutButton) cutButton.enabled = cutAvailable && this.touchVisible;

    this.cutPulse = damp(this.cutPulse, cutAvailable ? 1 : 0, 0.12, deltaSeconds);
    this.webPulse = damp(this.webPulse, input.touch.buttons.web.down ? 1 : 0, 0.06, deltaSeconds);
    this.jumpPulse = damp(this.jumpPulse, input.touch.buttons.jump.down ? 1 : 0, 0.06, deltaSeconds);
    this.loadValue = damp(this.loadValue, this.getWebLoad(), 0.2, deltaSeconds);
    this.limitFlash = Math.max(0, this.limitFlash - deltaSeconds * 1.6);
    this.tensionAlert = Math.max(0, this.tensionAlert - deltaSeconds * 1.2);
    this.hintPhase += deltaSeconds;

    this.grainOffsetX += deltaSeconds * 20;
    this.grainOffsetY -= deltaSeconds * 13;

    if (this.hint) {
      this.hint.timer -= deltaSeconds;
      if (this.hint.timer <= 0) this.hint.target = 0;
      this.hint.alpha = damp(this.hint.alpha, this.hint.target, 0.18, deltaSeconds);
      if (this.hint.alpha < 0.01 && this.hint.target === 0) this.hint = null;
    }
    if (this.titleTimer > 0) this.titleTimer -= deltaSeconds;
  }

  // ------------------------------------------------------------- отрисовка

  draw(painter: Painter): void {
    this.drawPostEffects(painter);
    if (!this.inputSystem) return;

    if (this.touchVisible) {
      this.drawStick(painter);
      this.drawButtons(painter);
    }
    this.drawPauseButton(painter);
    this.drawWebMeter(painter);
    this.drawTensionAlert(painter);
    this.drawTexts(painter);

    if (this.fadeAlpha > 0.001) {
      painter.fillStyle(0x04070a, Math.min(1, this.fadeAlpha));
      painter.fillRect(0, 0, this.width, this.height);
    }
  }

  /** Виньетка и зерно: две дешёвые текстуры вместо полноэкранного шейдера. */
  private drawPostEffects(painter: Painter): void {
    const vignette = textures.get(TEXTURES.vignette);
    painter.setAlpha(0.85);
    painter.drawTextureRect(vignette.canvas, 0, 0, this.width, this.height);
    painter.setAlpha(1);

    if (!this.grainPattern) {
      this.grainPattern = painter.ctx.createPattern(textures.get(TEXTURES.grain).canvas, 'repeat');
    }
    if (!this.grainPattern) return;

    const ctx = painter.ctx;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.translate(this.grainOffsetX % 256, this.grainOffsetY % 256);
    ctx.fillStyle = this.grainPattern;
    ctx.fillRect(-256, -256, this.width + 512, this.height + 512);
    ctx.restore();
  }

  private drawStick(painter: Painter): void {
    const stick = this.inputSystem!.touch.stick;
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
        ? this.width - 150 * dp
        : 150 * dp;
    const originY = stick.active ? stick.originY : this.height - 150 * dp;

    const breathe = showGhost ? 0.55 + 0.45 * Math.sin(this.hintPhase * 2.4) : 1;
    const alpha = (stick.active ? 0.9 : 0.42 * breathe) * this.uiOpacity;

    // Направляющий сектор — подсказывает, куда отклонён стик.
    const magnitude = Math.hypot(stick.valueX, stick.valueY);
    if (magnitude > 0.03) {
      const angle = Math.atan2(stick.valueY, stick.valueX);
      painter.setBlendMode('add');
      painter.fillStyle(PALETTE.uiAccent, 0.1 * alpha * magnitude);
      painter.slice(originX, originY, maxOffset, angle - 0.5, angle + 0.5, false);
      painter.fillPath();
      painter.setBlendMode('normal');
    }

    // Внешнее кольцо.
    painter.lineStyle(2 * dp, PALETTE.uiSilk, 0.22 * alpha);
    painter.strokeCircle(originX, originY, radius);
    painter.lineStyle(1.2 * dp, PALETTE.uiAccent, 0.16 * alpha);
    painter.strokeCircle(originX, originY, maxOffset);

    if (showGhost) {
      // Две стрелки по горизонтали: главное движение в игре — влево-вправо.
      const reach = maxOffset * 0.72;
      const tip = radius * 0.3;
      painter.lineStyle(2.2 * dp, PALETTE.uiSilk, 0.5 * alpha);
      for (const side of [-1, 1]) {
        const x = originX + side * reach;
        painter.beginPath();
        painter.moveTo(x - side * tip, originY - tip);
        painter.lineTo(x, originY);
        painter.lineTo(x - side * tip, originY + tip);
        painter.strokePath();
      }
    }

    const knobX = originX + stick.valueX * maxOffset;
    const knobY = originY + stick.valueY * maxOffset;

    painter.setBlendMode('add');
    painter.fillStyle(PALETTE.uiAccent, 0.16 * alpha);
    painter.fillCircle(knobX, knobY, radius * 0.78);
    painter.setBlendMode('normal');
    painter.fillStyle(PALETTE.uiSilk, 0.26 * alpha);
    painter.fillCircle(knobX, knobY, radius * 0.52);
    painter.lineStyle(1.6 * dp, PALETTE.uiSilk, 0.6 * alpha);
    painter.strokeCircle(knobX, knobY, radius * 0.52);
  }

  private drawButtons(painter: Painter): void {
    const dp = this.dp;

    for (const button of this.layout) {
      if (button.id === 'pause') continue;
      if (!button.enabled && button.id === 'cut') continue;

      const pressed =
        button.id === 'jump' ? this.jumpPulse : button.id === 'web' ? this.webPulse : 0;
      const radius = button.radius * (1 - pressed * 0.08);

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

      painter.setBlendMode('add');
      painter.fillStyle(color, (0.08 + pressed * 0.18) * alpha);
      painter.fillCircle(button.x, button.y, radius * 1.5);
      painter.setBlendMode('normal');

      painter.fillStyle(PALETTE.uiInk, 0.42 * alpha);
      painter.fillCircle(button.x, button.y, radius);
      painter.lineStyle(2 * dp, color, (0.55 + pressed * 0.45) * alpha);
      painter.strokeCircle(button.x, button.y, radius);

      this.drawGlyph(painter, label, button.x, button.y, radius, color, alpha);

      if (button.id === 'web') this.drawAimDrag(painter, button, radius, alpha);
    }

    // Подпись действия у кнопки паутины меняется по состоянию.
    const web = this.layout.find((b) => b.id === 'web');
    if (!web) return;
    const caption = this.getAnchorable()
      ? 'закрепить'
      : this.getTethered()
        ? 'сменить нить'
        : this.getAiming()
          ? 'выбор точки'
          : '';
    if (!caption) return;

    painter.setFont(`${Math.round(11 * dp)}px ${SANS}`);
    painter.setTextAlign('center', 'middle');
    painter.fillStyle(0x9fb8c4, 0.8 * this.uiOpacity);
    painter.fillText(caption, web.x, web.y + web.radius + 15 * dp);
  }

  /**
   * Протяжка прицела на кнопке паутины.
   *
   * Приём неочевиден по одному виду кнопки, поэтому он показан явно: пока
   * идёт удержание — растущее кольцо, как только палец потянули — стрелка в
   * выбранную сторону и «поводок» до пальца. Без этого игрок не догадается,
   * что кнопку можно тянуть.
   */
  private drawAimDrag(
    painter: Painter,
    button: TouchButtonLayout,
    radius: number,
    alpha: number,
  ): void {
    const touch = this.inputSystem!.touch;
    if (!touch.buttons.web.down) return;
    const dp = this.dp;
    const aim = touch.aimStick;

    if (aim.magnitude <= 0) {
      // Кольцо прогресса удержания — второй способ войти в прицеливание.
      const progress = clamp01(touch.buttons.web.holdMs / aimConfig.holdThresholdMs);
      painter.lineStyle(3 * dp, PALETTE.uiWarn, 0.9 * alpha);
      painter.beginPath();
      painter.arc(
        button.x,
        button.y,
        radius + 5 * dp,
        -Math.PI / 2,
        -Math.PI / 2 + progress * Math.PI * 2,
      );
      painter.strokePath();
      return;
    }

    const reach = inputConfig.aimStickReach * dp;
    const pull = radius + 6 * dp + aim.magnitude * reach * 0.45;
    const tipX = button.x + aim.directionX * pull;
    const tipY = button.y + aim.directionY * pull;

    // Поводок от кнопки к пальцу.
    painter.lineStyle(3 * dp, PALETTE.uiWarn, (0.35 + aim.magnitude * 0.45) * alpha);
    painter.beginPath();
    painter.moveTo(button.x + aim.directionX * radius, button.y + aim.directionY * radius);
    painter.lineTo(tipX, tipY);
    painter.strokePath();

    // Наконечник стрелки: направление читается даже боковым зрением.
    const wing = 8 * dp;
    const nx = -aim.directionY;
    const ny = aim.directionX;
    painter.fillStyle(PALETTE.uiWarn, (0.55 + aim.magnitude * 0.4) * alpha);
    painter.beginPath();
    painter.moveTo(tipX + aim.directionX * wing, tipY + aim.directionY * wing);
    painter.lineTo(tipX - aim.directionX * wing * 0.4 + nx * wing * 0.7, tipY - aim.directionY * wing * 0.4 + ny * wing * 0.7);
    painter.lineTo(tipX - aim.directionX * wing * 0.4 - nx * wing * 0.7, tipY - aim.directionY * wing * 0.4 - ny * wing * 0.7);
    painter.closePath();
    painter.fillPath();

    // Дуга уверенности вокруг кнопки.
    painter.lineStyle(2.6 * dp, PALETTE.uiWarn, 0.7 * alpha * aim.magnitude);
    const angle = Math.atan2(aim.directionY, aim.directionX);
    const spread = 0.55;
    painter.beginPath();
    painter.arc(button.x, button.y, radius + 5 * dp, angle - spread, angle + spread);
    painter.strokePath();
  }

  private drawGlyph(
    painter: Painter,
    kind: string,
    x: number,
    y: number,
    radius: number,
    color: number,
    alpha: number,
  ): void {
    const s = radius * 0.42;
    painter.lineStyle(Math.max(1.6, radius * 0.09), color, 0.95 * alpha);

    if (kind === 'jump') {
      // Стрелка вверх с подставкой.
      painter.beginPath();
      painter.moveTo(x, y - s);
      painter.lineTo(x, y + s * 0.5);
      painter.moveTo(x - s * 0.62, y - s * 0.25);
      painter.lineTo(x, y - s);
      painter.lineTo(x + s * 0.62, y - s * 0.25);
      painter.strokePath();
      painter.lineStyle(Math.max(1.4, radius * 0.07), color, 0.6 * alpha);
      painter.beginPath();
      painter.moveTo(x - s * 0.7, y + s * 0.85);
      painter.lineTo(x + s * 0.7, y + s * 0.85);
      painter.strokePath();
    } else if (kind === 'web') {
      // Мини-паутина: шесть радиусов и два витка.
      painter.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        painter.moveTo(x, y);
        painter.lineTo(x + Math.cos(angle) * s, y + Math.sin(angle) * s);
      }
      painter.strokePath();
      for (const ring of [0.45, 0.85]) {
        painter.beginPath();
        for (let i = 0; i <= 6; i++) {
          const angle = (i / 6) * Math.PI * 2;
          const px = x + Math.cos(angle) * s * ring;
          const py = y + Math.sin(angle) * s * ring;
          if (i === 0) painter.moveTo(px, py);
          else painter.lineTo(px, py);
        }
        painter.strokePath();
      }
    } else {
      // Ножницы.
      painter.beginPath();
      painter.moveTo(x - s * 0.7, y - s * 0.7);
      painter.lineTo(x + s * 0.5, y + s * 0.5);
      painter.moveTo(x + s * 0.7, y - s * 0.7);
      painter.lineTo(x - s * 0.5, y + s * 0.5);
      painter.strokePath();
      painter.fillStyle(color, 0.9 * alpha);
      painter.fillCircle(x - s * 0.62, y + s * 0.66, s * 0.24);
      painter.fillCircle(x + s * 0.62, y + s * 0.66, s * 0.24);
    }
  }

  private drawPauseButton(painter: Painter): void {
    const button = this.layout.find((b) => b.id === 'pause');
    if (!button) return;
    const dp = this.dp;
    const alpha = 0.55 * this.uiOpacity;

    painter.fillStyle(PALETTE.uiInk, 0.4 * alpha);
    painter.fillCircle(button.x, button.y, button.radius);
    painter.lineStyle(1.6 * dp, PALETTE.uiSilk, 0.5 * alpha);
    painter.strokeCircle(button.x, button.y, button.radius);

    const bar = button.radius * 0.36;
    painter.fillStyle(PALETTE.uiSilk, 0.85 * alpha);
    painter.fillRect(button.x - bar * 0.7, button.y - bar, bar * 0.5, bar * 2);
    painter.fillRect(button.x + bar * 0.22, button.y - bar, bar * 0.5, bar * 2);
  }

  /**
   * Индикатор сложности сети: четыре состояния без точных чисел
   * (раздел 53.2 ТЗ) — свободно, нагрузка, почти предел, предел.
   */
  private drawWebMeter(painter: Painter): void {
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

      painter.lineStyle(3 * dp, PALETTE.uiSilk, 0.12 * this.uiOpacity);
      painter.beginPath();
      painter.arc(web.x, web.y, radius, start, start + sweep);
      painter.strokePath();

      if (load > 0.004) {
        painter.lineStyle(3 * dp, color, alpha);
        painter.beginPath();
        painter.arc(web.x, web.y, radius, start, start + sweep * load);
        painter.strokePath();
      }

      if (this.limitFlash > 0) {
        const flash = easeOutCubic(this.limitFlash);
        painter.setBlendMode('add');
        painter.lineStyle(5 * dp, PALETTE.uiDanger, flash * 0.7);
        painter.beginPath();
        painter.arc(web.x, web.y, radius + 4 * dp * (1 - flash), start, start + sweep);
        painter.strokePath();
        painter.setBlendMode('normal');
      }
      return;
    }

    // Без сенсорных кнопок дуга висела бы в пустоте, поэтому на клавиатуре и
    // геймпаде индикатор превращается в компактную полоску в углу.
    const barWidth = 96 * dp;
    const barHeight = 4 * dp;
    const x = this.width - barWidth - 28 * dp;
    const y = 30 * dp;

    painter.fillStyle(PALETTE.uiSilk, 0.12 * this.uiOpacity);
    painter.fillRoundedRect(x, y, barWidth, barHeight, barHeight / 2);
    if (load > 0.004) {
      painter.fillStyle(color, Math.max(alpha, 0.5) * this.uiOpacity);
      painter.fillRoundedRect(
        x,
        y,
        Math.max(barHeight, barWidth * load),
        barHeight,
        barHeight / 2,
      );
    }
    if (this.limitFlash > 0) {
      const flash = easeOutCubic(this.limitFlash);
      painter.setBlendMode('add');
      painter.fillStyle(PALETTE.uiDanger, flash * 0.5);
      painter.fillRoundedRect(
        x - 3 * dp,
        y - 3 * dp,
        barWidth + 6 * dp,
        barHeight + 6 * dp,
        4 * dp,
      );
      painter.setBlendMode('normal');
    }
  }

  /** Красная кайма экрана, когда нить вот-вот порвётся. */
  private drawTensionAlert(painter: Painter): void {
    if (this.tensionAlert <= 0.01) return;
    const alpha = this.tensionAlert * 0.28;
    const thickness = 26;
    painter.fillStyle(PALETTE.uiDanger, alpha);
    painter.fillRect(0, 0, this.width, thickness);
    painter.fillRect(0, this.height - thickness, this.width, thickness);
    painter.fillRect(0, 0, thickness, this.height);
    painter.fillRect(this.width - thickness, 0, thickness, this.height);
  }

  private drawTexts(painter: Painter): void {
    const dp = this.dp;

    if (this.hint && this.hint.alpha > 0.01) {
      const size = Math.round(19 * dp);
      painter.setFont(`${size}px ${SANS}`);
      painter.setTextAlign('center', 'middle');
      if (this.hintLines.length === 0 || this.hintSource !== this.hint.text) {
        this.hintSource = this.hint.text;
        this.hintLines = painter.wrapText(this.hint.text, this.width * 0.7);
      }
      // Лёгкий подъём при появлении делает подсказку заметной без вспышки.
      const baseY =
        this.height * 0.14 + (1 - easeOutCubic(this.hint.alpha)) * 14 * dp;
      painter.fillStyle(0xe6f3f8, clamp01(this.hint.alpha));
      const lineHeight = size * 1.35;
      const top = baseY - ((this.hintLines.length - 1) * lineHeight) / 2;
      for (let i = 0; i < this.hintLines.length; i++) {
        painter.fillText(this.hintLines[i]!, this.width / 2, top + i * lineHeight);
      }
    }

    if (this.titleTimer > 0 && this.title) {
      const t = this.titleTimer;
      const alpha = t > 2.6 ? easeOutBack(clamp01((3.4 - t) / 0.8)) : clamp01(t / 1.1);
      painter.setFont(`${Math.round(30 * dp)}px ${SERIF}`);
      painter.setTextAlign('center', 'middle');
      painter.fillStyle(0xf2f8fb, clamp01(alpha) * 0.95);
      painter.fillText(this.title, this.width / 2, this.height * 0.3);
    }

    if (settingsRepository.current.showFps) {
      painter.setFont(`13px ${MONO}`);
      painter.setTextAlign('left', 'top');
      painter.fillStyle(0x7fe6ff, 0.8);
      painter.fillText(`${Math.round(this.getFps())} FPS`, 12, 10);
    }

    if (settingsRepository.current.showDiagnostics && this.diagnostics) {
      this.drawDiagnostics(painter, this.diagnostics());
    }
  }

  /** Панель диагностики: моноширинный блок на затемнённой подложке. */
  private drawDiagnostics(painter: Painter, text: string): void {
    const lines = text.split('\n');
    const size = 12;
    const lineHeight = size + 4;
    const padding = 8;

    painter.setFont(`${size}px ${MONO}`);
    painter.setTextAlign('left', 'top');

    let widest = 0;
    for (const line of lines) widest = Math.max(widest, painter.measureWidth(line));

    const x = 12;
    const y = 34;
    painter.fillStyle(0x04080c, 0.78);
    painter.fillRect(
      x,
      y,
      widest + padding * 2,
      lines.length * lineHeight + padding * 2,
    );

    painter.ctx.fillStyle = cssColor(0x9ff5ff, 1);
    for (let i = 0; i < lines.length; i++) {
      painter.fillText(lines[i]!, x + padding, y + padding + i * lineHeight);
    }
  }
}

import { inputConfig } from '../../app/GameConfig';
import { clamp01 } from '../../core/math/Interpolation';

export interface TouchButtonLayout {
  id: 'jump' | 'web' | 'cut' | 'pause';
  x: number;
  y: number;
  radius: number;
  enabled: boolean;
}

export interface TouchButtonState {
  down: boolean;
  pressedAt: number;
  /** Стал ли нажатым в этом кадре — читается и сбрасывается InputSystem. */
  justPressed: boolean;
  justReleased: boolean;
  holdMs: number;
}

export interface StickState {
  active: boolean;
  /** Центр стика в координатах полотна. */
  originX: number;
  originY: number;
  /** Текущая позиция пальца. */
  pointerX: number;
  pointerY: number;
  /** Нормализованное отклонение [-1, 1]. */
  valueX: number;
  valueY: number;
}

const emptyButton = (): TouchButtonState => ({
  down: false,
  pressedAt: 0,
  justPressed: false,
  justReleased: false,
  holdMs: 0,
});

/**
 * Есть ли у устройства сенсорный ввод.
 *
 * Проверяются оба признака: `maxTouchPoints` знают все современные браузеры,
 * а `pointer: coarse` дополнительно ловит планшеты и телевизоры, где
 * основное устройство ввода — палец или пульт, а не точная мышь.
 */
const detectTouchCapableDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  if (navigator.maxTouchPoints > 0) return true;
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
};

/**
 * Сенсорный ввод на «сырых» Pointer Events.
 *
 * Phaser-овский ввод здесь не используется намеренно: игре нужен полноценный
 * мультитач (стик и две кнопки одновременно) и минимальная задержка, а также
 * возможность продолжать вести стик, когда палец ушёл за пределы своей
 * половины экрана.
 */
export class TouchInputAdapter {
  readonly stick: StickState = {
    active: false,
    originX: 0,
    originY: 0,
    pointerX: 0,
    pointerY: 0,
    valueX: 0,
    valueY: 0,
  };

  readonly buttons: Record<TouchButtonLayout['id'], TouchButtonState> = {
    jump: emptyButton(),
    web: emptyButton(),
    cut: emptyButton(),
    pause: emptyButton(),
  };

  /**
   * Показывать ли экранные органы управления.
   *
   * Раньше здесь стояло «было ли хоть одно касание по холсту», и это было
   * ошибкой: первое касание игрока приходится на кнопку «Играть» в HTML-меню,
   * а не на холст, поэтому игра начиналась вообще без видимых стика и кнопок.
   * Теперь наличие сенсора определяется заранее по возможностям устройства,
   * а любое нажатие по холсту лишь подтверждает догадку.
   */
  controlsVisible = detectTouchCapableDevice();

  private layout: TouchButtonLayout[] = [];
  private readonly pointerOwners = new Map<number, 'stick' | TouchButtonLayout['id']>();
  private renderScale = 1;
  private canvasRect: DOMRect | null = null;
  private leftHanded = false;
  private fixedStick = false;
  private fixedStickOrigin = { x: 0, y: 0 };
  private enabled = true;

  private readonly onPointerDown = (event: PointerEvent) => this.handleDown(event);
  private readonly onPointerMove = (event: PointerEvent) => this.handleMove(event);
  private readonly onPointerUp = (event: PointerEvent) => this.handleUp(event);

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp, { passive: false });
    window.addEventListener('pointercancel', this.onPointerUp, { passive: false });
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  setRenderScale(scale: number): void {
    this.renderScale = scale;
    this.canvasRect = null;
  }

  setPreferences(leftHanded: boolean, fixedStick: boolean): void {
    this.leftHanded = leftHanded;
    this.fixedStick = fixedStick;
  }

  setFixedStickOrigin(x: number, y: number): void {
    this.fixedStickOrigin.x = x;
    this.fixedStickOrigin.y = y;
    if (this.fixedStick && !this.stick.active) {
      this.stick.originX = x;
      this.stick.originY = y;
    }
  }

  setLayout(layout: TouchButtonLayout[]): void {
    this.layout = layout;
  }

  /** Полная остановка ввода: пауза, респаун, завершение комнаты. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  releaseAll(): void {
    this.pointerOwners.clear();
    this.stick.active = false;
    this.stick.valueX = 0;
    this.stick.valueY = 0;
    for (const key of Object.keys(this.buttons) as TouchButtonLayout['id'][]) {
      const button = this.buttons[key];
      if (button.down) button.justReleased = true;
      button.down = false;
      button.holdMs = 0;
    }
  }

  update(deltaMs: number): void {
    for (const key of Object.keys(this.buttons) as TouchButtonLayout['id'][]) {
      const button = this.buttons[key];
      if (button.down) button.holdMs += deltaMs;
    }
  }

  consumeEdges(): void {
    for (const key of Object.keys(this.buttons) as TouchButtonLayout['id'][]) {
      this.buttons[key].justPressed = false;
      this.buttons[key].justReleased = false;
    }
  }

  private rect(): DOMRect {
    if (!this.canvasRect) this.canvasRect = this.canvas.getBoundingClientRect();
    return this.canvasRect;
  }

  invalidateRect(): void {
    this.canvasRect = null;
  }

  private toCanvas(event: PointerEvent): { x: number; y: number } {
    const rect = this.rect();
    return {
      x: (event.clientX - rect.left) * this.renderScale,
      y: (event.clientY - rect.top) * this.renderScale,
    };
  }

  private hitButton(x: number, y: number): TouchButtonLayout | null {
    // Кнопки проверяются в обратном порядке: последняя в списке рисуется
    // сверху, значит и нажатие должна получать она.
    for (let i = this.layout.length - 1; i >= 0; i--) {
      const button = this.layout[i]!;
      if (!button.enabled) continue;
      const dx = x - button.x;
      const dy = y - button.y;
      const radius = button.radius * inputConfig.touchPadding;
      if (dx * dx + dy * dy <= radius * radius) return button;
    }
    return null;
  }

  private isStickHalf(x: number): boolean {
    const half = (this.rect().width * this.renderScale) / 2;
    return this.leftHanded ? x > half : x < half;
  }

  private handleDown(event: PointerEvent): void {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') this.controlsVisible = true;
    if (!this.enabled) return;
    // Правая и средняя кнопки мыши заняты прицеливанием — стик ведёт левая.
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const point = this.toCanvas(event);
    const button = this.hitButton(point.x, point.y);

    if (button) {
      event.preventDefault();
      this.pointerOwners.set(event.pointerId, button.id);
      const state = this.buttons[button.id];
      state.down = true;
      state.justPressed = true;
      state.holdMs = 0;
      state.pressedAt = performance.now();
      return;
    }

    if (this.isStickHalf(point.x) && !this.stick.active) {
      event.preventDefault();
      this.pointerOwners.set(event.pointerId, 'stick');
      this.stick.active = true;
      if (this.fixedStick) {
        this.stick.originX = this.fixedStickOrigin.x;
        this.stick.originY = this.fixedStickOrigin.y;
      } else {
        this.stick.originX = point.x;
        this.stick.originY = point.y;
      }
      this.stick.pointerX = point.x;
      this.stick.pointerY = point.y;
      this.updateStickValue();
    }
  }

  private handleMove(event: PointerEvent): void {
    const owner = this.pointerOwners.get(event.pointerId);
    if (!owner) return;
    if (owner !== 'stick') return;

    const point = this.toCanvas(event);
    this.stick.pointerX = point.x;
    this.stick.pointerY = point.y;
    this.updateStickValue();
    event.preventDefault();
  }

  private handleUp(event: PointerEvent): void {
    const owner = this.pointerOwners.get(event.pointerId);
    if (!owner) return;
    this.pointerOwners.delete(event.pointerId);

    if (owner === 'stick') {
      this.stick.active = false;
      this.stick.valueX = 0;
      this.stick.valueY = 0;
      return;
    }

    const state = this.buttons[owner];
    if (state.down) {
      state.down = false;
      state.justReleased = true;
    }
  }

  private updateStickValue(): void {
    const maxOffset = inputConfig.stickMaxOffset * this.renderScale;
    let dx = this.stick.pointerX - this.stick.originX;
    let dy = this.stick.pointerY - this.stick.originY;
    const dist = Math.hypot(dx, dy);

    if (this.fixedStick && dist > maxOffset) {
      // Фиксированный стик просто упирается в границу.
      dx = (dx / dist) * maxOffset;
      dy = (dy / dist) * maxOffset;
    } else if (!this.fixedStick && dist > maxOffset) {
      // Плавающий стик «едет» за пальцем: центр подтягивается, чтобы палец
      // всегда оставался на краю круга. Это заметно приятнее на длинных
      // проводках, когда игрок начинает движение у самого угла экрана.
      const pull = dist - maxOffset;
      this.stick.originX += (dx / dist) * pull;
      this.stick.originY += (dy / dist) * pull;
      dx = (dx / dist) * maxOffset;
      dy = (dy / dist) * maxOffset;
    }

    const normalized = dist > 0 ? Math.min(dist, maxOffset) / maxOffset : 0;
    const dead = inputConfig.stickDeadZone;
    if (normalized <= dead) {
      this.stick.valueX = 0;
      this.stick.valueY = 0;
      return;
    }

    // Мёртвая зона убирается с перенормировкой, иначе на её границе
    // возникает скачок скорости.
    const magnitude = clamp01((normalized - dead) / (1 - dead));
    const invDist = dist > 0 ? 1 / dist : 0;
    this.stick.valueX = dx * invDist * magnitude;
    this.stick.valueY = dy * invDist * magnitude;
  }
}

import { aimConfig, inputConfig } from '../../app/GameConfig';
import { damp } from '../../core/math/Interpolation';
import { normalize } from '../../core/math/Vector2';
import { settingsRepository } from '../save/SettingsRepository';
import { createInputFrame, resetEdges, type InputFrame } from './InputFrame';
import { TouchInputAdapter } from './TouchInputAdapter';

interface KeyState {
  down: boolean;
  justPressed: boolean;
  justReleased: boolean;
}

const KEY_CODES = [
  'KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyQ', 'KeyE', 'KeyR',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Space', 'Escape', 'ShiftLeft',
] as const;

type TrackedKey = (typeof KEY_CODES)[number];

/**
 * Сводит сенсор, клавиатуру, мышь и геймпад в один `InputFrame`.
 *
 * Все источники складываются, а не переключаются: на планшете с клавиатурой
 * можно вести персонажа стиком и одновременно нажать пробел, ничего при этом
 * не «переучивая».
 */
export class InputSystem {
  readonly frame: InputFrame = createInputFrame();
  readonly touch: TouchInputAdapter;

  private readonly keys = new Map<TrackedKey, KeyState>();
  private mouseRightDown = false;
  private mouseRightEdge: 'none' | 'pressed' | 'released' = 'none';
  private mousePointer: { x: number; y: number } | null = null;
  private webHoldMs = 0;
  private webWasHeld = false;
  private smoothMoveX = 0;
  private smoothMoveY = 0;
  private lastAim = { x: 1, y: 0 };
  private gamepadIndex: number | null = null;
  private prevGamepadButtons: boolean[] = [];
  private enabled = true;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const code = event.code as TrackedKey;
    if (!KEY_CODES.includes(code)) return;
    if (code === 'Space' || code.startsWith('Arrow')) event.preventDefault();
    const state = this.keyState(code);
    if (!state.down) state.justPressed = true;
    state.down = true;
    this.frame.source = 'keyboard';
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    const code = event.code as TrackedKey;
    if (!KEY_CODES.includes(code)) return;
    const state = this.keyState(code);
    if (state.down) state.justReleased = true;
    state.down = false;
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button !== 2) return;
    event.preventDefault();
    if (!this.mouseRightDown) this.mouseRightEdge = 'pressed';
    this.mouseRightDown = true;
    this.frame.source = 'keyboard';
  };

  private readonly onMouseUp = (event: MouseEvent) => {
    if (event.button !== 2) return;
    if (this.mouseRightDown) this.mouseRightEdge = 'released';
    this.mouseRightDown = false;
  };

  private readonly onMouseMove = (event: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.mousePointer = {
      x: (event.clientX - rect.left) * this.renderScale,
      y: (event.clientY - rect.top) * this.renderScale,
    };
  };

  private readonly onContextMenu = (event: Event) => event.preventDefault();
  private readonly onBlur = () => this.releaseAll();

  private renderScale = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.touch = new TouchInputAdapter(canvas);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', this.onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.onGamepadDisconnected);
  }

  private readonly onGamepadConnected = (event: GamepadEvent) => {
    this.gamepadIndex = event.gamepad.index;
  };

  private readonly onGamepadDisconnected = () => {
    this.gamepadIndex = null;
  };

  destroy(): void {
    this.touch.destroy();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('gamepadconnected', this.onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected);
  }

  setRenderScale(scale: number): void {
    this.renderScale = scale;
    this.touch.setRenderScale(scale);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.touch.setEnabled(enabled);
    if (!enabled) this.releaseAll();
  }

  releaseAll(): void {
    for (const state of this.keys.values()) {
      if (state.down) state.justReleased = true;
      state.down = false;
    }
    this.mouseRightDown = false;
    this.touch.releaseAll();
    this.webHoldMs = 0;
    this.webWasHeld = false;
    this.smoothMoveX = 0;
    this.smoothMoveY = 0;
  }

  private keyState(code: TrackedKey): KeyState {
    let state = this.keys.get(code);
    if (!state) {
      state = { down: false, justPressed: false, justReleased: false };
      this.keys.set(code, state);
    }
    return state;
  }

  private key(code: TrackedKey): KeyState {
    return this.keys.get(code) ?? { down: false, justPressed: false, justReleased: false };
  }

  /** Собирает кадр ввода. Вызывается один раз за отрисованный кадр. */
  update(deltaMs: number): InputFrame {
    const frame = this.frame;
    resetEdges(frame);
    this.touch.update(deltaMs);

    const settings = settingsRepository.current;
    this.touch.setPreferences(settings.leftHanded, settings.fixedStick);

    const pad = this.readGamepad();

    // --- направление ---------------------------------------------------
    let rawX = 0;
    let rawY = 0;
    let usingTouch = false;

    if (this.touch.stick.active) {
      rawX = this.touch.stick.valueX;
      rawY = this.touch.stick.valueY;
      usingTouch = true;
    }

    const keyX =
      (this.key('KeyD').down || this.key('ArrowRight').down ? 1 : 0) -
      (this.key('KeyA').down || this.key('ArrowLeft').down ? 1 : 0);
    const keyY =
      (this.key('KeyS').down || this.key('ArrowDown').down ? 1 : 0) -
      (this.key('KeyW').down || this.key('ArrowUp').down ? 1 : 0);

    if (keyX !== 0 || keyY !== 0) {
      rawX = keyX;
      rawY = keyY;
      frame.source = 'keyboard';
    } else if (pad && (Math.abs(pad.axisX) > 0.001 || Math.abs(pad.axisY) > 0.001)) {
      rawX = pad.axisX;
      rawY = pad.axisY;
      frame.source = 'gamepad';
    } else if (usingTouch) {
      frame.source = 'touch';
    }

    // Сглаживание 40–60 мс из раздела 8.2: убирает дребезг пальца, но
    // остаётся достаточно быстрым, чтобы резкий разворот читался мгновенно.
    const smoothSeconds = inputConfig.stickSmoothMs / 1000;
    const dt = deltaMs / 1000;
    this.smoothMoveX = damp(this.smoothMoveX, rawX, smoothSeconds, dt);
    this.smoothMoveY = damp(this.smoothMoveY, rawY, smoothSeconds, dt);
    frame.moveX = Math.abs(this.smoothMoveX) < 0.008 ? 0 : this.smoothMoveX;
    frame.moveY = Math.abs(this.smoothMoveY) < 0.008 ? 0 : this.smoothMoveY;

    // --- прыжок --------------------------------------------------------
    const jumpDown =
      this.touch.buttons.jump.down || this.key('Space').down || (pad?.jump ?? false);
    const jumpEdge =
      this.touch.buttons.jump.justPressed ||
      this.key('Space').justPressed ||
      (pad?.jumpPressed ?? false);
    const jumpUp =
      this.touch.buttons.jump.justReleased ||
      this.key('Space').justReleased ||
      (pad?.jumpReleased ?? false);

    frame.jumpPressed = jumpEdge;
    frame.jumpHeld = jumpDown;
    frame.jumpReleased = jumpUp;

    // --- паутина -------------------------------------------------------
    const webDown =
      this.touch.buttons.web.down ||
      this.key('KeyE').down ||
      this.mouseRightDown ||
      (pad?.web ?? false);

    if (webDown) {
      this.webHoldMs += deltaMs;
    }
    frame.webPressed = webDown && !this.webWasHeld;
    frame.webReleased = !webDown && this.webWasHeld;
    frame.webHeld = webDown;
    frame.webHoldMs = webDown ? this.webHoldMs : 0;
    if (frame.webPressed) this.webHoldMs = 0;
    if (!webDown) this.webHoldMs = 0;
    this.webWasHeld = webDown;

    if (this.mouseRightEdge === 'pressed') frame.webPressed = true;
    if (this.mouseRightEdge === 'released') frame.webReleased = true;
    this.mouseRightEdge = 'none';

    // --- прочие команды -------------------------------------------------
    frame.cutPressed =
      this.touch.buttons.cut.justPressed ||
      this.key('KeyQ').justPressed ||
      (pad?.cutPressed ?? false);
    frame.restartPressed = this.key('KeyR').justPressed;
    frame.pausePressed =
      this.key('Escape').justPressed ||
      this.touch.buttons.pause.justPressed ||
      (pad?.pausePressed ?? false);

    // --- прицел ---------------------------------------------------------
    // Приоритет из раздела 22.1: явный жест → стик → инерция движения.
    let aimX = 0;
    let aimY = 0;
    let explicit = false;

    if (Math.abs(rawX) > 0.12 || Math.abs(rawY) > 0.12) {
      const n = normalize({ x: rawX, y: rawY });
      aimX = n.x;
      aimY = n.y;
      explicit = true;
    }

    if (explicit) {
      this.lastAim.x = aimX;
      this.lastAim.y = aimY;
    }

    frame.aimX = explicit ? aimX : this.lastAim.x;
    frame.aimY = explicit ? aimY : this.lastAim.y;
    frame.aimExplicit = explicit;

    frame.pointerWorldX = this.mousePointer ? this.mousePointer.x : null;
    frame.pointerWorldY = this.mousePointer ? this.mousePointer.y : null;

    if (!this.enabled) {
      frame.moveX = 0;
      frame.moveY = 0;
      frame.jumpPressed = false;
      frame.jumpHeld = false;
      frame.webPressed = false;
      frame.webHeld = false;
      frame.webReleased = false;
      frame.cutPressed = false;
    }

    this.consumeKeyEdges();
    this.touch.consumeEdges();
    return frame;
  }

  /** Прицеливание активно, если кнопка удерживается дольше порога. */
  isAiming(frame: InputFrame): boolean {
    return frame.webHeld && frame.webHoldMs >= aimConfig.holdThresholdMs;
  }

  /** Последнее известное направление прицела — для быстрого выстрела. */
  get lastAimDirection(): { x: number; y: number } {
    return this.lastAim;
  }

  setLastAim(x: number, y: number): void {
    const n = normalize({ x, y });
    if (n.x !== 0 || n.y !== 0) {
      this.lastAim.x = n.x;
      this.lastAim.y = n.y;
    }
  }

  private consumeKeyEdges(): void {
    for (const state of this.keys.values()) {
      state.justPressed = false;
      state.justReleased = false;
    }
  }

  private readGamepad(): {
    axisX: number;
    axisY: number;
    jump: boolean;
    jumpPressed: boolean;
    jumpReleased: boolean;
    web: boolean;
    cutPressed: boolean;
    pausePressed: boolean;
  } | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    if (this.gamepadIndex !== null) pad = pads[this.gamepadIndex] ?? null;
    if (!pad) {
      for (const candidate of pads) {
        if (candidate) {
          pad = candidate;
          this.gamepadIndex = candidate.index;
          break;
        }
      }
    }
    if (!pad) return null;

    const dead = 0.18;
    const applyDead = (value: number) =>
      Math.abs(value) < dead ? 0 : (value - Math.sign(value) * dead) / (1 - dead);

    const pressed = pad.buttons.map((b) => b.pressed);
    const wasPressed = this.prevGamepadButtons;
    const edge = (index: number) => (pressed[index] ?? false) && !(wasPressed[index] ?? false);
    const release = (index: number) => !(pressed[index] ?? false) && (wasPressed[index] ?? false);
    this.prevGamepadButtons = pressed;

    return {
      axisX: applyDead(pad.axes[0] ?? 0),
      axisY: applyDead(pad.axes[1] ?? 0),
      jump: pressed[0] ?? false,
      jumpPressed: edge(0),
      jumpReleased: release(0),
      // Правый триггер или X — выпуск паутины.
      web: (pressed[7] ?? false) || (pressed[2] ?? false),
      cutPressed: edge(1),
      pausePressed: edge(9),
    };
  }
}

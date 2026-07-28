/**
 * Единый кадр ввода.
 *
 * Ни один игровой модуль не проверяет клавиши и координаты касаний напрямую —
 * они видят только эту структуру (раздел 8.1 ТЗ). Благодаря этому сенсор,
 * клавиатура и геймпад полностью взаимозаменяемы.
 */
export interface InputFrame {
  moveX: number;
  moveY: number;

  jumpPressed: boolean;
  jumpHeld: boolean;
  jumpReleased: boolean;

  webPressed: boolean;
  webHeld: boolean;
  webReleased: boolean;
  /** Длительность текущего удержания кнопки паутины, мс. */
  webHoldMs: number;

  cutPressed: boolean;
  restartPressed: boolean;
  pausePressed: boolean;

  /** Направление прицеливания, единичный вектор; нули — не задано. */
  aimX: number;
  aimY: number;
  /** Игрок задал прицел явно (стик или палец), а не по инерции движения. */
  aimExplicit: boolean;

  /** Мировые координаты указателя, если ввод позиционный (мышь). */
  pointerWorldX: number | null;
  pointerWorldY: number | null;

  /** Активное устройство — нужно интерфейсу, чтобы прятать сенсорные кнопки. */
  source: 'touch' | 'keyboard' | 'gamepad';
}

export const createInputFrame = (): InputFrame => ({
  moveX: 0,
  moveY: 0,
  jumpPressed: false,
  jumpHeld: false,
  jumpReleased: false,
  webPressed: false,
  webHeld: false,
  webReleased: false,
  webHoldMs: 0,
  cutPressed: false,
  restartPressed: false,
  pausePressed: false,
  aimX: 0,
  aimY: 0,
  aimExplicit: false,
  pointerWorldX: null,
  pointerWorldY: null,
  source: 'keyboard',
});

export const resetEdges = (frame: InputFrame): void => {
  frame.jumpPressed = false;
  frame.jumpReleased = false;
  frame.webPressed = false;
  frame.webReleased = false;
  frame.cutPressed = false;
  frame.restartPressed = false;
  frame.pausePressed = false;
};

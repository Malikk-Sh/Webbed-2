/**
 * Палитра «Детского сада» — первого района оранжереи.
 * Из концепт-документа: зелёный, бирюзовый, золотой; тёмный фон и светлая
 * паутина, мягкое объёмное освещение, контрастные силуэты.
 */
export const PALETTE = {
  /** Небо за стеклом: от грозового к глубокому подводному зелёному. */
  skyTop: 0x0a1c26,
  skyMid: 0x0e2a2f,
  skyLow: 0x11333a,
  skyHorizon: 0x2c6a63,

  /** Дальние силуэты растений. */
  farFoliage: 0x0b1d22,
  midFoliage: 0x0e2a2c,
  nearFoliage: 0x102f2e,

  /** Тёплый свет, падающий сквозь разбитое стекло. */
  sunWarm: 0xffd18a,
  sunCore: 0xfff0cf,
  sunHaze: 0x8fd6b4,

  /** Геометрия уровня. */
  stoneBase: 0x202b34,
  stoneTop: 0x33434e,
  stoneEdge: 0x5b7684,
  woodBase: 0x2e2119,
  woodTop: 0x4b3628,
  woodEdge: 0x7d5a3d,
  metalBase: 0x212832,
  metalTop: 0x37424f,
  metalEdge: 0x7d8b9e,
  slipperyBase: 0x1c2e3b,
  slipperyTop: 0x2c4a5e,
  slipperyEdge: 0x6ca4c8,

  /** Растительность на кромках платформ. */
  moss: 0x4f9b6a,
  mossDark: 0x2c6647,
  mossLight: 0x87d69a,
  vine: 0x336b52,

  /** Паучиха Люма. */
  spiderBody: 0x2b2038,
  spiderBodyLight: 0x4a3660,
  spiderMark: 0xffca7a,
  spiderLeg: 0x3d2c53,
  spiderLegLight: 0x8e72b8,
  spiderEye: 0x9ff5ff,
  spiderEyeGlow: 0x5fd6ff,

  /** Паутина. */
  silk: 0xdcf2ff,
  silkGlow: 0x7fe6ff,
  silkSlack: 0x9ec4d4,
  silkTense: 0xfff2c8,
  silkCritical: 0xff8a63,
  dew: 0xcdf3ff,

  /** Объекты. */
  crate: 0x6b4a2f,
  crateLight: 0x8f6740,
  crateEdge: 0xc09462,
  weight: 0x4a5560,
  weightLight: 0x6f8090,
  plateOff: 0x4c5a66,
  plateOn: 0x76e2b0,
  doorFrame: 0x33414d,
  doorPanel: 0x54402c,
  anchorIdle: 0x8fe3c8,
  anchorActive: 0xfff0b8,
  exitGlow: 0xa9ffdc,

  /** Интерфейс и подсветки. */
  uiInk: 0x0a1118,
  uiSilk: 0xdfeef5,
  uiMuted: 0x6d8494,
  uiAccent: 0x7fe6ff,
  uiWarn: 0xffc46b,
  uiDanger: 0xff7a6a,
  ok: 0x63c9a0,
} as const;

/** Смешивание двух цветов 0xRRGGBB. */
export const mixColor = (a: number, b: number, t: number): number => {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
};

export const shade = (color: number, amount: number): number =>
  amount >= 0 ? mixColor(color, 0xffffff, amount) : mixColor(color, 0x000000, -amount);

/** Цвет нити по нормализованному натяжению — читается без цифр (раздел 11.3). */
export const tensionColor = (tension: number): number => {
  if (tension < 0.6) return mixColor(PALETTE.silkSlack, PALETTE.silk, tension / 0.6);
  if (tension < 0.9) return mixColor(PALETTE.silk, PALETTE.silkTense, (tension - 0.6) / 0.3);
  return mixColor(PALETTE.silkTense, PALETTE.silkCritical, (tension - 0.9) / 0.1);
};

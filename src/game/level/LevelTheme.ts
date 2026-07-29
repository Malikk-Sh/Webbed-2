import { PALETTE } from '../../app/Palette';

/**
 * Тема локации.
 *
 * Комнаты рисуются одним и тем же кодом, но выглядеть одинаково не должны.
 * Тема задаёт всё, что отличает одно место от другого: цвет воздуха, форму
 * дальнего каркаса, силу дождя и то, кто летает в темноте. Геометрия и
 * механика уровня о теме ничего не знают — она чисто про атмосферу.
 */
export interface LevelTheme {
  id: string;
  /** Что стоит на дальнем плане: стеклянная крыша, своды, кроны, колоннада. */
  structure: 'greenhouse' | 'vault' | 'canopy' | 'ruins';

  skyTop: number;
  skyMid: number;
  skyLow: number;
  /** Цвет зарева — единственного источника света в кадре. */
  skyHorizon: number;
  /** Где сидит центр зарева: 0 — верх кадра, 1 — низ. */
  horizonHeight: number;
  /** Яркость зарева в центре. */
  horizonStrength: number;

  farFoliage: number;
  midFoliage: number;
  nearFoliage: number;

  /** Цвет объёмного света и его сердцевины. */
  lightWarm: number;
  lightCore: number;
  /** Насколько заметны лучи; 0 — комната без прямого света. */
  rayIntensity: number;

  /** Дымка между планами: главный инструмент глубины в тёмной сцене. */
  haze: number;
  hazeColor: number;

  /** Сила осадков за окном, 0..1. */
  rain: number;
  /** Цвет и направление парящей взвеси: минус — падает, плюс — всплывает. */
  moteColor: number;
  moteRise: number;

  /** Живность фона: бабочки у света, светлячки, споры или пустота. */
  life: 'moths' | 'fireflies' | 'spores' | 'none';
  lifeColor: number;
  lifeCount: number;

  /** Растительность на кромках платформ. */
  moss: number;
  mossDark: number;
  mossLight: number;
  vine: number;

  /**
   * Подмес к цветам материалов.
   *
   * Камень остаётся камнем во всех комнатах, но освещён везде по-разному.
   * Общий подмес дешевле отдельного набора материалов на локацию и не даёт
   * геометрии выпасть из атмосферы: подвал холодный, закат тёплый.
   */
  tint: number;
  tintStrength: number;
}

const greenhouse: LevelTheme = {
  id: 'greenhouse',
  structure: 'greenhouse',

  skyTop: PALETTE.skyTop,
  skyMid: PALETTE.skyMid,
  skyLow: PALETTE.skyLow,
  skyHorizon: PALETTE.skyHorizon,
  horizonHeight: 0.8,
  horizonStrength: 0.3,

  farFoliage: PALETTE.farFoliage,
  midFoliage: PALETTE.midFoliage,
  nearFoliage: PALETTE.nearFoliage,

  lightWarm: PALETTE.sunWarm,
  lightCore: PALETTE.sunCore,
  rayIntensity: 1,

  haze: 0.16,
  hazeColor: 0x1a4a49,

  rain: 1,
  moteColor: PALETTE.sunWarm,
  moteRise: 1,

  life: 'moths',
  lifeColor: 0xffe2ad,
  lifeCount: 10,

  moss: PALETTE.moss,
  mossDark: PALETTE.mossDark,
  mossLight: PALETTE.mossLight,
  vine: PALETTE.vine,

  tint: 0x1a4a49,
  tintStrength: 0,
};

/**
 * Подвальные ярусы: света снаружи нет вовсе, всё держится на биолюминесценции.
 * Небо здесь — не небо, а сырая тьма под сводами, поэтому зарево уведено вниз
 * и окрашено в холодный сине-фиолетовый.
 */
const vault: LevelTheme = {
  id: 'vault',
  structure: 'vault',

  skyTop: 0x080d18,
  skyMid: 0x0c1424,
  skyLow: 0x121b2e,
  skyHorizon: 0x2e4d84,
  horizonHeight: 0.94,
  horizonStrength: 0.22,

  farFoliage: 0x0a1020,
  midFoliage: 0x111a2c,
  nearFoliage: 0x16203a,

  lightWarm: 0x74d8ff,
  lightCore: 0xd6f6ff,
  rayIntensity: 0.34,

  haze: 0.3,
  hazeColor: 0x1b2c4c,

  rain: 0,
  moteColor: 0x8fe6ff,
  moteRise: 1.4,

  life: 'spores',
  lifeColor: 0x9ff0d8,
  lifeCount: 14,

  moss: 0x3f7f8e,
  mossDark: 0x27505f,
  mossLight: 0x74c6c9,
  vine: 0x2c5a63,

  tint: 0x24406e,
  tintStrength: 0.24,
};

/**
 * Верхний ярус на закате: единственная комната, где света в избытке. Тёплые
 * тона и сильные лучи нужны как передышка после подвала — контраст между
 * главами делает обе выразительнее.
 */
const canopy: LevelTheme = {
  id: 'canopy',
  structure: 'canopy',

  skyTop: 0x1b2540,
  skyMid: 0x3d3350,
  skyLow: 0x7a4a4a,
  skyHorizon: 0xffb070,
  horizonHeight: 0.86,
  horizonStrength: 0.46,

  farFoliage: 0x241f34,
  midFoliage: 0x2d2438,
  nearFoliage: 0x1d1828,

  lightWarm: 0xffc27a,
  lightCore: 0xfff3d8,
  rayIntensity: 1.5,

  haze: 0.26,
  hazeColor: 0x6b4a55,

  rain: 0,
  moteColor: 0xffd9a0,
  moteRise: 0.6,

  life: 'fireflies',
  lifeColor: 0xffe08a,
  lifeCount: 16,

  moss: 0x8fae52,
  mossDark: 0x4b7a3e,
  mossLight: 0xc6d977,
  vine: 0x5c7a3c,

  tint: 0x6b4a30,
  tintStrength: 0.2,
};

/**
 * Затопленный неф: буря снаружи в самом разгаре, вода стоит внизу. Здесь
 * максимум дождя и дымки и совсем нет живности — место читается как мёртвое.
 */
const ruins: LevelTheme = {
  id: 'ruins',
  structure: 'ruins',

  skyTop: 0x0b1218,
  skyMid: 0x142028,
  skyLow: 0x1d2f38,
  skyHorizon: 0x4d8ba0,
  horizonHeight: 0.72,
  horizonStrength: 0.26,

  farFoliage: 0x0e1a20,
  midFoliage: 0x152530,
  nearFoliage: 0x0f1c24,

  lightWarm: 0xa8d8ee,
  lightCore: 0xe6f7ff,
  rayIntensity: 0.7,

  haze: 0.42,
  hazeColor: 0x2b4a5c,

  rain: 1.7,
  moteColor: 0xbfe6ff,
  moteRise: -0.4,

  life: 'none',
  lifeColor: 0xbfe6ff,
  lifeCount: 0,

  moss: 0x4a8f7d,
  mossDark: 0x2b5c53,
  mossLight: 0x7ec4ae,
  vine: 0x336159,

  tint: 0x2b4a5c,
  tintStrength: 0.22,
};

export const THEMES: Record<string, LevelTheme> = {
  greenhouse,
  vault,
  canopy,
  ruins,
};

export const isThemeId = (id: string): boolean => Object.hasOwn(THEMES, id);

export const getTheme = (id: string | undefined): LevelTheme =>
  THEMES[id ?? 'greenhouse'] ?? greenhouse;

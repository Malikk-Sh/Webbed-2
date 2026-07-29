import canopyDusk from '../../content/levels/canopy-dusk.json';
import cellarShaft from '../../content/levels/cellar-shaft.json';
import floodedNave from '../../content/levels/flooded-nave.json';
import prototypeRoom from '../../content/levels/prototype-room.json';
import type { LevelDefinition } from './LevelSchema';

/**
 * Глава кампании.
 *
 * Комната знает только про свою геометрию; порядок, название и подпись живут
 * здесь. Благодаря этому добавление главы — это новый JSON и одна строка в
 * списке, а не правка сцены или интерфейса.
 */
export interface Chapter {
  id: string;
  /** Позиция в кампании, с нуля. */
  index: number;
  /** Номер главы для списка: «I», «II», «III», «IV». */
  numeral: string;
  /** Место действия. */
  title: string;
  /** Одна строка о том, чему глава учит и чем запоминается. */
  subtitle: string;
  definition: LevelDefinition;
}

const asLevel = (data: unknown): LevelDefinition => data as LevelDefinition;

const entries: Omit<Chapter, 'index'>[] = [
  {
    id: 'prototype-room',
    numeral: 'I',
    title: 'Оранжерея',
    subtitle: 'Ходить по любой поверхности, прыгать и плести первую нить',
    definition: asLevel(prototypeRoom),
  },
  {
    id: 'cellar-shaft',
    numeral: 'II',
    title: 'Нижние ярусы',
    subtitle: 'Спуск в темноту: грибница, провал и груз на подвесе',
    definition: asLevel(cellarShaft),
  },
  {
    id: 'canopy-dusk',
    numeral: 'III',
    title: 'Верхний ярус',
    subtitle: 'Закат над кронами: шесть пролётов, которые берутся только раскачкой',
    definition: asLevel(canopyDusk),
  },
  {
    id: 'flooded-nave',
    numeral: 'IV',
    title: 'Затопленный неф',
    subtitle: 'Буря, вода внизу и колокол, который сам откроет дорогу',
    definition: asLevel(floodedNave),
  },
];

export const CHAPTERS: readonly Chapter[] = entries.map((entry, index) => ({
  ...entry,
  index,
}));

export const chapterCount = CHAPTERS.length;

/** Глава по номеру; вне диапазона — первая. */
export const getChapter = (index: number): Chapter =>
  CHAPTERS[Math.max(0, Math.min(chapterCount - 1, index))]!;

export const findChapter = (id: string): Chapter | null =>
  CHAPTERS.find((chapter) => chapter.id === id) ?? null;

/** Следующая глава или null, если кампания пройдена. */
export const nextChapter = (index: number): Chapter | null =>
  index + 1 < chapterCount ? CHAPTERS[index + 1]! : null;

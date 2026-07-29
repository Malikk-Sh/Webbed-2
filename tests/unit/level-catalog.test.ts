import { describe, expect, it } from 'vitest';
import { spiderBodyConfig } from '../../src/app/GameConfig';
import { CHAPTERS, findChapter, getChapter, nextChapter } from '../../src/game/level/LevelCatalog';
import type { LevelDefinition, LevelGeometry } from '../../src/game/level/LevelSchema';
import { THEMES, getTheme } from '../../src/game/level/LevelTheme';
import { validateLevel } from '../../src/game/level/LevelValidator';

interface Box {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const boxes = (level: LevelDefinition): Box[] =>
  level.geometry
    .filter((item): item is LevelGeometry & { type: 'rectangle' } => item.type === 'rectangle')
    .map((item) => ({
      id: item.id,
      minX: item.x ?? 0,
      minY: item.y ?? 0,
      maxX: (item.x ?? 0) + (item.width ?? 0),
      maxY: (item.y ?? 0) + (item.height ?? 0),
    }));

const inside = (box: Box, x: number, y: number): boolean =>
  x > box.minX && x < box.maxX && y > box.minY && y < box.maxY;

/** Высота центра героини, когда она стоит на поверхности. */
const stanceOffset = spiderBodyConfig.radius;

describe('каталог глав', () => {
  it('главы уникальны и совпадают с комнатами', () => {
    const ids = new Set(CHAPTERS.map((chapter) => chapter.id));
    expect(ids.size).toBe(CHAPTERS.length);
    for (const chapter of CHAPTERS) {
      expect(chapter.definition.id).toBe(chapter.id);
      expect(chapter.title.length).toBeGreaterThan(0);
      expect(chapter.subtitle.length).toBeGreaterThan(0);
    }
  });

  it('порядок и переходы', () => {
    expect(getChapter(0)).toBe(CHAPTERS[0]);
    // Выход за границы не должен ронять кампанию: берётся крайняя глава.
    expect(getChapter(-5)).toBe(CHAPTERS[0]);
    expect(getChapter(999)).toBe(CHAPTERS[CHAPTERS.length - 1]);
    expect(nextChapter(0)).toBe(CHAPTERS[1]);
    expect(nextChapter(CHAPTERS.length - 1)).toBeNull();
    expect(findChapter(CHAPTERS[1]!.id)).toBe(CHAPTERS[1]);
    expect(findChapter('нет такой')).toBeNull();
  });

  for (const chapter of CHAPTERS) {
    describe(`глава ${chapter.numeral} · ${chapter.title}`, () => {
      const level = chapter.definition;

      it('проходит валидацию', () => {
        expect(() => validateLevel(level)).not.toThrow();
      });

      it('тема существует', () => {
        expect(level.theme).toBeDefined();
        expect(getTheme(level.theme).id).toBe(level.theme);
      });

      it('точки появления стоят на поверхности', () => {
        for (const spawn of level.spawnPoints) {
          // Проверяются только «напольные» точки: у стен и потолка смещение
          // считается по другой оси, и общей формулы для них нет.
          if (spawn.surfaceNormal.y !== -1) continue;
          const support = boxes(level).find(
            (box) =>
              spawn.x > box.minX &&
              spawn.x < box.maxX &&
              Math.abs(box.minY - spawn.y - stanceOffset) < 2,
          );
          expect(support, `${spawn.id} висит в воздухе`).toBeDefined();
        }
      });

      it('у выхода есть пол', () => {
        const exit = level.triggers.find((trigger) => trigger.action === 'complete-prototype')!;
        const support = boxes(level).find((box) => {
          const stance = box.minY - stanceOffset;
          return (
            box.maxX > exit.x &&
            box.minX < exit.x + exit.width &&
            stance >= exit.y &&
            stance <= exit.y + exit.height
          );
        });
        expect(support, 'до выхода нельзя дойти по полу').toBeDefined();
      });

      it('над дверью нет щели', () => {
        // Дверь перекрывает проход только если упирается в свод. Зазор в
        // полсотни единиц героиня проходит по потолку, и головоломка
        // обесценивается — такую ошибку глазами в редакторе не видно.
        for (const door of level.objects) {
          if (door.prefab !== 'prototype-door') continue;
          const width = Number(door.properties?.width ?? 60);
          const lintel = boxes(level).find(
            (box) =>
              Math.abs(box.maxY - door.y) < 2 &&
              box.minX <= door.x &&
              box.maxX >= door.x + width,
          );
          expect(lintel, `над дверью «${door.id}» щель`).toBeDefined();
        }
      });

      it('бутоны и точки крепления не замурованы', () => {
        const solids = boxes(level);
        for (const anchor of level.anchors) {
          const hit = solids.find((box) => inside(box, anchor.x, anchor.y));
          expect(hit?.id, `точка «${anchor.id}» внутри «${hit?.id}»`).toBeUndefined();
        }
        for (const object of level.objects) {
          if (object.prefab !== 'silk-bloom') continue;
          const hit = solids.find((box) => inside(box, object.x, object.y));
          expect(hit?.id, `бутон «${object.id}» внутри «${hit?.id}»`).toBeUndefined();
        }
      });

      it('зона падения лежит ниже всей геометрии', () => {
        const death = level.triggers.find((trigger) => trigger.action === 'respawn')!;
        for (const box of boxes(level)) {
          expect(box.minY, `«${box.id}» тонет в зоне падения`).toBeLessThan(death.y);
        }
      });
    });
  }
});

describe('темы локаций', () => {
  it('у каждой темы свой идентификатор и осмысленные значения', () => {
    for (const [key, theme] of Object.entries(THEMES)) {
      expect(theme.id).toBe(key);
      expect(theme.horizonHeight).toBeGreaterThanOrEqual(0);
      expect(theme.horizonHeight).toBeLessThanOrEqual(1);
      expect(theme.haze).toBeGreaterThanOrEqual(0);
      expect(theme.rain).toBeGreaterThanOrEqual(0);
      expect(theme.lifeCount).toBeGreaterThanOrEqual(0);
      // «Нет живности» и «ноль особей» обязаны совпадать, иначе фон молча
      // потратит память на пустой массив или, наоборот, ничего не покажет.
      expect(theme.lifeCount === 0).toBe(theme.life === 'none');
      for (const colour of [theme.skyTop, theme.moss, theme.tint, theme.moteColor]) {
        expect(colour).toBeGreaterThanOrEqual(0);
        expect(colour).toBeLessThanOrEqual(0xffffff);
      }
    }
  });

  it('неизвестная тема откатывается к оранжерее', () => {
    expect(getTheme(undefined).id).toBe('greenhouse');
    expect(getTheme('нет такой').id).toBe('greenhouse');
  });
});

import { describe, expect, it } from 'vitest';
import levelData from '../../src/content/levels/prototype-room.json';
import type { LevelDefinition } from '../../src/game/level/LevelSchema';
import { LevelValidationError, validateLevel } from '../../src/game/level/LevelValidator';

const level = levelData as unknown as LevelDefinition;
const clone = (): LevelDefinition => JSON.parse(JSON.stringify(level)) as LevelDefinition;

describe('LevelValidator', () => {
  it('принимает комнату прототипа', () => {
    expect(() => validateLevel(level)).not.toThrow();
  });

  it('ловит повторяющиеся идентификаторы', () => {
    const broken = clone();
    broken.geometry.push({ ...broken.geometry[0]! });
    expect(() => validateLevel(broken)).toThrow(LevelValidationError);
  });

  it('ловит неизвестный материал и называет объект', () => {
    const broken = clone();
    broken.geometry[0]!.material = 'lava';
    try {
      validateLevel(broken);
      throw new Error('Ожидалась ошибка валидации');
    } catch (error) {
      expect(error).toBeInstanceOf(LevelValidationError);
      expect((error as LevelValidationError).objectId).toBe(broken.geometry[0]!.id);
    }
  });

  it('ловит дверь без управляющего объекта', () => {
    const broken = clone();
    const door = broken.objects.find((o) => o.prefab === 'prototype-door')!;
    door.properties = { ...door.properties, controlledBy: 'missing-plate' };
    expect(() => validateLevel(broken)).toThrow(/управляется отсутствующим/);
  });

  it('требует зону падения', () => {
    const broken = clone();
    broken.triggers = broken.triggers.filter((t) => t.action !== 'respawn');
    expect(() => validateLevel(broken)).toThrow(/зоны падения/);
  });

  it('требует выход', () => {
    const broken = clone();
    broken.triggers = broken.triggers.filter((t) => t.action !== 'complete-prototype');
    expect(() => validateLevel(broken)).toThrow(/выход/);
  });

  it('ловит контрольную точку с несуществующей точкой появления', () => {
    const broken = clone();
    broken.checkpoints[1]!.spawnPointId = 'nowhere';
    expect(() => validateLevel(broken)).toThrow(/отсутствующую точку появления/);
  });

  it('ловит отрицательную массу', () => {
    const broken = clone();
    broken.objects[0]!.properties = { ...broken.objects[0]!.properties, mass: -1 };
    expect(() => validateLevel(broken)).toThrow(/масса/);
  });

  it('все триггеры контрольных точек ссылаются на существующие точки', () => {
    const ids = new Set(level.checkpoints.map((c) => c.id));
    for (const trigger of level.triggers) {
      if (trigger.action !== 'checkpoint') continue;
      expect(ids.has(trigger.checkpointId!)).toBe(true);
    }
  });
});

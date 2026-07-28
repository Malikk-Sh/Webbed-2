import { isMaterialId } from '../physics/PhysicsMaterials';
import type { LevelDefinition } from './LevelSchema';

export class LevelValidationError extends Error {
  constructor(
    message: string,
    readonly objectId: string | null,
  ) {
    super(message);
    this.name = 'LevelValidationError';
  }
}

/**
 * Проверки уровня из раздела 31 ТЗ.
 *
 * Комната с ошибкой не запускается частично: половина загруженного уровня
 * выглядит как баг физики и уводит отладку в сторону, поэтому валидатор
 * останавливает загрузку и называет проблемный ID.
 */
export const validateLevel = (level: LevelDefinition): void => {
  const seen = new Set<string>();
  const requireUniqueId = (id: string, what: string) => {
    if (!id) throw new LevelValidationError(`${what} без идентификатора`, null);
    if (seen.has(id)) throw new LevelValidationError(`Повторяющийся ID: ${id}`, id);
    seen.add(id);
  };

  const bounds = level.worldBounds;
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new LevelValidationError('worldBounds отсутствует или имеет нулевой размер', null);
  }
  if (!level.cameraBounds || level.cameraBounds.width <= 0) {
    throw new LevelValidationError('cameraBounds отсутствует', null);
  }

  const insideWorld = (x: number, y: number, id: string) => {
    // Допуск нужен для триггеров, намеренно выходящих за нижнюю кромку мира.
    const margin = 400;
    if (
      x < bounds.x - margin ||
      x > bounds.x + bounds.width + margin ||
      y < bounds.y - margin ||
      y > bounds.y + bounds.height + margin
    ) {
      throw new LevelValidationError(`Объект "${id}" находится далеко за границами мира`, id);
    }
  };

  if (level.spawnPoints.length === 0) {
    throw new LevelValidationError('В комнате нет ни одной точки появления', null);
  }
  for (const spawn of level.spawnPoints) {
    requireUniqueId(spawn.id, 'Точка появления');
    insideWorld(spawn.x, spawn.y, spawn.id);
    const n = spawn.surfaceNormal;
    if (!n || (n.x === 0 && n.y === 0)) {
      throw new LevelValidationError(`У точки "${spawn.id}" нулевая нормаль`, spawn.id);
    }
  }

  const spawnIds = new Set(level.spawnPoints.map((s) => s.id));
  if (level.checkpoints.length === 0) {
    throw new LevelValidationError('В комнате нет контрольных точек', null);
  }
  let hasAutomatic = false;
  for (const checkpoint of level.checkpoints) {
    requireUniqueId(checkpoint.id, 'Контрольная точка');
    if (checkpoint.activation === 'automatic') hasAutomatic = true;
    if (checkpoint.spawnPointId && !spawnIds.has(checkpoint.spawnPointId)) {
      throw new LevelValidationError(
        `Контрольная точка "${checkpoint.id}" ссылается на отсутствующую точку появления "${checkpoint.spawnPointId}"`,
        checkpoint.id,
      );
    }
    if (!checkpoint.spawnPointId && (checkpoint.x === undefined || checkpoint.y === undefined)) {
      throw new LevelValidationError(
        `Контрольная точка "${checkpoint.id}" не имеет ни ссылки, ни координат`,
        checkpoint.id,
      );
    }
  }
  if (!hasAutomatic) {
    throw new LevelValidationError('Нет стартовой контрольной точки с activation = automatic', null);
  }

  for (const geometry of level.geometry) {
    requireUniqueId(geometry.id, 'Геометрия');
    if (!isMaterialId(geometry.material)) {
      throw new LevelValidationError(
        `Неизвестный материал "${geometry.material}" у "${geometry.id}"`,
        geometry.id,
      );
    }
    if (geometry.type === 'rectangle') {
      if (!geometry.width || !geometry.height || geometry.width <= 0 || geometry.height <= 0) {
        throw new LevelValidationError(`Некорректный размер у "${geometry.id}"`, geometry.id);
      }
      insideWorld(geometry.x ?? 0, geometry.y ?? 0, geometry.id);
    } else {
      if (!geometry.points || geometry.points.length < 3) {
        throw new LevelValidationError(
          `Многоугольник "${geometry.id}" должен иметь минимум три вершины`,
          geometry.id,
        );
      }
    }
  }

  for (const anchor of level.anchors) {
    requireUniqueId(anchor.id, 'Точка крепления');
    insideWorld(anchor.x, anchor.y, anchor.id);
  }

  const objectIds = new Set<string>();
  for (const object of level.objects) {
    requireUniqueId(object.id, 'Объект');
    objectIds.add(object.id);
    insideWorld(object.x, object.y, object.id);
    const mass = object.properties?.mass;
    if (typeof mass === 'number' && mass <= 0) {
      throw new LevelValidationError(`Отрицательная или нулевая масса у "${object.id}"`, object.id);
    }
  }

  // Дверь обязана ссылаться на существующий управляющий объект.
  for (const object of level.objects) {
    if (object.prefab !== 'prototype-door') continue;
    const controlledBy = object.properties?.controlledBy;
    if (typeof controlledBy !== 'string' || !objectIds.has(controlledBy)) {
      throw new LevelValidationError(
        `Дверь "${object.id}" управляется отсутствующим объектом "${String(controlledBy)}"`,
        object.id,
      );
    }
  }

  const checkpointIds = new Set(level.checkpoints.map((c) => c.id));
  let hasDeathZone = false;
  let hasExit = false;
  for (const trigger of level.triggers) {
    requireUniqueId(trigger.id, 'Триггер');
    if (trigger.width <= 0 || trigger.height <= 0) {
      throw new LevelValidationError(`Нулевой размер триггера "${trigger.id}"`, trigger.id);
    }
    if (trigger.action === 'respawn') hasDeathZone = true;
    if (trigger.action === 'complete-prototype') hasExit = true;
    if (trigger.action === 'checkpoint') {
      if (!trigger.checkpointId || !checkpointIds.has(trigger.checkpointId)) {
        throw new LevelValidationError(
          `Триггер "${trigger.id}" ссылается на отсутствующую контрольную точку`,
          trigger.id,
        );
      }
    }
    if (trigger.action === 'hint' && !trigger.hintText) {
      throw new LevelValidationError(`У подсказки "${trigger.id}" нет текста`, trigger.id);
    }
  }

  if (!hasDeathZone) throw new LevelValidationError('В комнате нет зоны падения', null);
  if (!hasExit) throw new LevelValidationError('В комнате нет выхода', null);
};

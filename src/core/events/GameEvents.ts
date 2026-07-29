import type { Vector2 } from '../math/Vector2';

/**
 * Единый словарь игровых событий.
 *
 * Системы не держат ссылок друг на друга: звук, интерфейс, подсказки и
 * статистика подписываются на этот список. Благодаря этому отключение любой
 * из них не ломает игровой цикл.
 */
export interface GameEventMap {
  'spider:spawned': { position: Vector2 };
  'spider:jumped': { position: Vector2; normal: Vector2; power: number };
  'spider:landed': { position: Vector2; normal: Vector2; impactSpeed: number };
  'spider:detached': { position: Vector2 };
  'spider:step': { position: Vector2; speed: number };
  'spider:died': { position: Vector2; reason: 'fall' };
  'spider:respawned': { checkpointId: string };

  'web:created': { strandId: number; length: number; playerCreated: boolean; position: Vector2 };
  'web:broken': { strandId: number; position: Vector2; cause: 'tension' | 'cut' | 'cleanup' };
  'web:attached': { strandId: number; position: Vector2 };
  'web:released': { strandId: number };
  'web:pluck': { strandId: number; frequency: number; amplitude: number; position: Vector2 };
  'web:limit-reached': { count: number; max: number };
  'web:tension-critical': { strandId: number; position: Vector2 };
  'web:cleared': Record<string, never>;

  'aim:started': Record<string, never>;
  'aim:ended': Record<string, never>;

  'object:plate-changed': { plateId: string; active: boolean; mass: number };
  'object:door-changed': { doorId: string; state: string };
  'object:impact': { position: Vector2; strength: number };
  'object:bloom-collected': { bloomId: string; position: Vector2; collected: number; total: number };

  'level:checkpoint': { checkpointId: string; position: Vector2 };
  'level:completed': { stats: RunStats };
  'level:restarted': Record<string, never>;

  'hint:show': { id: string; text: string };
  'hint:hide': { id: string };

  'game:paused': { fromSystem: boolean };
  'game:resumed': Record<string, never>;

  'camera:shake': { strength: number; durationMs: number };
}

export interface RunStats {
  timeMs: number;
  falls: number;
  strandsCreated: number;
  strandsBroken: number;
  peakStrands: number;
  jumps: number;
  swingTimeMs: number;
  /** Собрано шёлковых бутонов и сколько их было в комнате. */
  bloomsCollected: number;
  bloomsTotal: number;
}

export type GameEventName = keyof GameEventMap;

export interface LevelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LevelPoint {
  x: number;
  y: number;
}

export interface LevelSpawnPoint {
  id: string;
  x: number;
  y: number;
  surfaceNormal: LevelPoint;
}

export interface LevelCheckpoint {
  id: string;
  spawnPointId?: string;
  x?: number;
  y?: number;
  surfaceNormal?: LevelPoint;
  activation: 'automatic' | 'trigger';
  /** Радиус срабатывания для activation = "trigger". */
  radius?: number;
}

export interface LevelGeometry {
  id: string;
  type: 'rectangle' | 'polygon';
  /** Для rectangle. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  /** Для polygon — вершины по часовой стрелке. */
  points?: LevelPoint[];
  material: string;
  /** Декоративная геометрия не участвует в столкновениях. */
  decorative?: boolean;
}

export interface LevelAnchor {
  id: string;
  x: number;
  y: number;
  type: 'explicit';
  /** Подсказывающая надпись у первой точки крепления. */
  hint?: string;
}

export interface LevelObject {
  id: string;
  prefab: 'dynamic-crate' | 'hanging-weight' | 'pressure-plate' | 'prototype-door';
  x: number;
  y: number;
  properties?: Record<string, number | string | boolean>;
}

export interface LevelTrigger {
  id: string;
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  action: 'respawn' | 'complete-prototype' | 'checkpoint' | 'hint';
  /** Для action = "checkpoint" — какая точка активируется. */
  checkpointId?: string;
  /** Для action = "hint". */
  hintId?: string;
  hintText?: string;
  once?: boolean;
}

export interface LevelDecor {
  id: string;
  type: 'plant' | 'vine' | 'pot' | 'glass-pane' | 'root' | 'lamp' | 'grass';
  x: number;
  y: number;
  scale?: number;
  angle?: number;
  seed?: number;
  /** Слой параллакса: 0 — фон, 1 — уровень, 2 — передний план. */
  layer?: 0 | 1 | 2;
}

export interface LevelDefinition {
  id: string;
  version: number;
  title: string;
  worldBounds: LevelRect;
  cameraBounds: LevelRect;
  spawnPoints: LevelSpawnPoint[];
  checkpoints: LevelCheckpoint[];
  geometry: LevelGeometry[];
  anchors: LevelAnchor[];
  objects: LevelObject[];
  triggers: LevelTrigger[];
  decor?: LevelDecor[];
}

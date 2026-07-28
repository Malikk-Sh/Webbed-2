import type { Vector2 } from '../../core/math/Vector2';

export type WebNodeType = 'world-anchor' | 'body-anchor' | 'spider-anchor' | 'junction';

export interface WebNode {
  id: number;
  type: WebNodeType;

  position: Vector2;
  previousPosition: Vector2;

  pinned: boolean;
  sleeping: boolean;

  /** Для body-anchor: идентификатор тела Matter и локальное смещение. */
  bodyId?: number;
  localOffset?: Vector2;

  /** Точка крепления уровня, если узел создан на явном якоре. */
  anchorId?: string;

  connectedStrandIds: number[];

  /** Свободный конец после разрыва — растворяется по таймеру. */
  freeSince?: number;
}

export interface WebParticle {
  id: number;

  position: Vector2;
  previousPosition: Vector2;
  acceleration: Vector2;

  inverseMass: number;

  pinned: boolean;
  sleeping: boolean;
}

export interface WebStrand {
  id: number;

  nodeAId: number;
  nodeBId: number;

  restLength: number;
  currentLength: number;

  stiffness: number;
  damping: number;

  breakStretchRatio: number;
  breakDelayMs: number;
  overloadTimeMs: number;

  particleIds: number[];

  tensionNormalized: number;
  /** Натяжение прошлого шага — по нему определяется засыпание. */
  previousTension: number;

  sleeping: boolean;
  sleepTimerMs: number;
  /** Опорный снимок средней частицы: по нему измеряется «нить не менялась». */
  sleepAnchor?: Vector2;
  active: boolean;
  playerCreated: boolean;

  /** Нить создана уровнем и восстанавливается при перезапуске. */
  scripted: boolean;

  /** Бегущий световой импульс: положение вдоль нити 0..1 и яркость. */
  pulsePosition: number;
  pulseEnergy: number;

  /** Возраст в мс — используется для анимации появления. */
  ageMs: number;

  /** Собственная нота нити, Гц. Пересчитывается при изменении длины. */
  frequency: number;
}

export interface SavedWebNode {
  id: number;
  type: WebNodeType;
  x: number;
  y: number;
  pinned: boolean;
  bodyId?: number;
  localOffset?: { x: number; y: number };
  anchorId?: string;
}

export interface SavedWebStrand {
  id: number;
  a: number;
  b: number;
  restLength: number;
  playerCreated: boolean;
  scripted: boolean;
}

export interface SavedWebGraph {
  version: number;
  nodes: SavedWebNode[];
  strands: SavedWebStrand[];
}

export interface WebRuntimeStats {
  strands: number;
  playerStrands: number;
  particles: number;
  nodes: number;
  sleepingStrands: number;
  maxTension: number;
  solveMs: number;
}

export type WebAttachmentTarget =
  | { type: 'world'; point: Vector2; surfaceId: string; anchorId?: string }
  | { type: 'body'; bodyId: number; localOffset: Vector2 }
  | { type: 'spider' }
  | { type: 'existing-node'; nodeId: number };

export interface CreateStrandRequest {
  start: WebAttachmentTarget;
  end: WebAttachmentTarget;
  requestedRestLength?: number;
  playerCreated: boolean;
  scripted?: boolean;
}

export type CreateStrandFailure =
  | 'limit-reached'
  | 'too-short'
  | 'too-long'
  | 'invalid-target'
  | 'duplicate'
  | 'surface-forbidden';

export type CreateStrandResult =
  | { ok: true; strandId: number; startNodeId: number; endNodeId: number }
  | { ok: false; reason: CreateStrandFailure };

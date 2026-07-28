import { PALETTE } from '../../app/Palette';

export interface PhysicsMaterialDefinition {
  id: string;
  spiderWalkable: boolean;
  webAttachable: boolean;
  surfaceFriction: number;
  attachmentStrength: number;
  /** Базовый цвет заливки. */
  color: number;
  /** Освещённая верхняя грань. */
  topColor: number;
  /** Контурная подсветка кромок. */
  edgeColor: number;
  /** Насколько охотно на кромке прорастает мох, 0..1. */
  mossiness: number;
}

export const materials: Record<string, PhysicsMaterialDefinition> = {
  stone: {
    id: 'stone',
    spiderWalkable: true,
    webAttachable: true,
    surfaceFriction: 1,
    attachmentStrength: 1,
    color: PALETTE.stoneBase,
    topColor: PALETTE.stoneTop,
    edgeColor: PALETTE.stoneEdge,
    mossiness: 0.85,
  },
  wood: {
    id: 'wood',
    spiderWalkable: true,
    webAttachable: true,
    surfaceFriction: 1.1,
    attachmentStrength: 1.2,
    color: PALETTE.woodBase,
    topColor: PALETTE.woodTop,
    edgeColor: PALETTE.woodEdge,
    mossiness: 0.6,
  },
  metal: {
    id: 'metal',
    spiderWalkable: true,
    webAttachable: true,
    surfaceFriction: 0.8,
    attachmentStrength: 0.9,
    color: PALETTE.metalBase,
    topColor: PALETTE.metalTop,
    edgeColor: PALETTE.metalEdge,
    mossiness: 0.15,
  },
  /**
   * Мокрое стекло: ходить можно, но паутина не держится. Даёт головоломке
   * читаемое ограничение — игрок сразу видит, куда цепляться нельзя.
   */
  slippery: {
    id: 'slippery',
    spiderWalkable: true,
    webAttachable: false,
    surfaceFriction: 0.4,
    attachmentStrength: 0,
    color: PALETTE.slipperyBase,
    topColor: PALETTE.slipperyTop,
    edgeColor: PALETTE.slipperyEdge,
    mossiness: 0.05,
  },
};

export const getMaterial = (id: string | undefined): PhysicsMaterialDefinition =>
  materials[id ?? 'stone'] ?? materials.stone!;

export const isMaterialId = (id: string): boolean => Object.hasOwn(materials, id);

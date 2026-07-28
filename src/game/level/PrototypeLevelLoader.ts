import { rectanglePolygon, type Polygon } from '../../core/math/Geometry';
import type { Vector2 } from '../../core/math/Vector2';
import {
  DynamicCrate,
  HangingWeight,
  PressurePlate,
  PrototypeDoor,
} from '../objects/LevelObjects';
import { CollisionWorld } from '../physics/CollisionWorld';
import { getMaterial } from '../physics/PhysicsMaterials';
import type { PhysicsWorld } from '../../engine/physics/PhysicsWorld';
import { boxBody, polygonBody, type RigidBody } from '../../engine/physics/RigidBody';
import type { LevelDefinition } from './LevelSchema';
import { validateLevel } from './LevelValidator';

export interface AnchorPoint {
  id: string;
  position: Vector2;
  /** Пульсация подсветки; растёт, когда прицел рядом. */
  highlight: number;
  /** Сколько нитей уже держится на этой точке. */
  strandCount: number;
}

export interface LoadedLevel {
  definition: LevelDefinition;
  collision: CollisionWorld;
  staticBodies: RigidBody[];
  crates: DynamicCrate[];
  weights: HangingWeight[];
  plates: PressurePlate[];
  doors: PrototypeDoor[];
  anchors: AnchorPoint[];
  polygons: { polygon: Polygon; materialId: string; id: string }[];
}

/**
 * Загрузка комнаты.
 *
 * Геометрия попадает сразу в два мира: собственный `CollisionWorld` для
 * запросов паучихи и паутины и статические тела мира — чтобы ящики и груз
 * честно лежали на полу и сталкивались со стенами.
 */
export const loadLevel = (
  definition: LevelDefinition,
  world: PhysicsWorld,
): LoadedLevel => {
  validateLevel(definition);

  const collision = CollisionWorld.fromLevelGeometry(definition.geometry);
  const staticBodies: RigidBody[] = [];
  const polygons: LoadedLevel['polygons'] = [];

  for (const item of definition.geometry) {
    if (item.decorative) continue;
    const material = getMaterial(item.material);

    if (item.type === 'rectangle') {
      const x = item.x ?? 0;
      const y = item.y ?? 0;
      const width = item.width ?? 0;
      const height = item.height ?? 0;
      const angle = ((item.angle ?? 0) * Math.PI) / 180;
      const body = world.add(
        boxBody(x + width / 2, y + height / 2, width, height, {
          isStatic: true,
          angle,
          friction: material.surfaceFriction,
          label: `surface:${item.id}`,
        }),
      );
      staticBodies.push(body);
      polygons.push({
        polygon: rectanglePolygon(x, y, width, height, angle),
        materialId: item.material,
        id: item.id,
      });
    } else {
      const points = (item.points ?? []).map((p) => ({ x: p.x, y: p.y }));
      const body = world.add(
        polygonBody(points, {
          isStatic: true,
          friction: material.surfaceFriction,
          label: `surface:${item.id}`,
        }),
      );
      staticBodies.push(body);
      const found = collision.surfaces.find((s) => s.id === item.id);
      if (found) polygons.push({ polygon: found.polygon, materialId: item.material, id: item.id });
    }
  }

  const crates: DynamicCrate[] = [];
  const weights: HangingWeight[] = [];
  const plates: PressurePlate[] = [];
  const doors: PrototypeDoor[] = [];

  for (const object of definition.objects) {
    const props = object.properties ?? {};
    switch (object.prefab) {
      case 'dynamic-crate':
        crates.push(
          new DynamicCrate(
            object.id,
            world,
            object.x,
            object.y,
            num(props.width, 74),
            num(props.height, 74),
            num(props.mass, 1.05),
          ),
        );
        break;

      case 'hanging-weight':
        weights.push(
          new HangingWeight(
            object.id,
            world,
            object.x,
            object.y,
            num(props.radius, 38),
            num(props.mass, 2.4),
            { x: num(props.anchorX, object.x), y: num(props.anchorY, object.y - 160) },
            num(props.restLength, 160),
          ),
        );
        break;

      case 'pressure-plate':
        plates.push(
          new PressurePlate(
            object.id,
            object.x,
            object.y,
            num(props.width, 110),
            num(props.activationMass, 1),
          ),
        );
        break;

      case 'prototype-door':
        doors.push(
          new PrototypeDoor(
            object.id,
            world,
            object.x,
            object.y,
            num(props.width, 60),
            num(props.height, 320),
            String(props.controlledBy ?? ''),
          ),
        );
        break;
    }
  }

  const anchors: AnchorPoint[] = definition.anchors.map((anchor) => ({
    id: anchor.id,
    position: { x: anchor.x, y: anchor.y },
    highlight: 0,
    strandCount: 0,
  }));

  return {
    definition,
    collision,
    staticBodies,
    crates,
    weights,
    plates,
    doors,
    anchors,
    polygons,
  };
};

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

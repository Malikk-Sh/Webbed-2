import Phaser from 'phaser';

/**
 * Типизированный доступ к пространству имён Matter.js внутри Phaser.
 *
 * Phaser отдаёт оригинальный Matter через `Phaser.Physics.Matter.Matter`, но
 * в поставляемых типах этого поля нет. Один аккуратный каст здесь избавляет
 * от `any` во всех остальных модулях и заодно фиксирует ровно тот набор
 * функций, которым пользуется игра.
 */
type MatterComposite = MatterJS.CompositeType | Phaser.Physics.Matter.World['localWorld'];

interface MatterNamespace {
  Bodies: {
    rectangle(
      x: number,
      y: number,
      width: number,
      height: number,
      options?: Record<string, unknown>,
    ): MatterJS.BodyType;
    circle(
      x: number,
      y: number,
      radius: number,
      options?: Record<string, unknown>,
      maxSides?: number,
    ): MatterJS.BodyType;
    fromVertices(
      x: number,
      y: number,
      vertexSets: { x: number; y: number }[][],
      options?: Record<string, unknown>,
    ): MatterJS.BodyType;
  };
  Body: {
    setPosition(body: MatterJS.BodyType, position: { x: number; y: number }): void;
    setVelocity(body: MatterJS.BodyType, velocity: { x: number; y: number }): void;
    setAngle(body: MatterJS.BodyType, angle: number): void;
    setAngularVelocity(body: MatterJS.BodyType, velocity: number): void;
    setMass(body: MatterJS.BodyType, mass: number): void;
    applyForce(
      body: MatterJS.BodyType,
      position: { x: number; y: number },
      force: { x: number; y: number },
    ): void;
  };
  Composite: {
    // Phaser передаёт сюда свой `World`, который для Matter и есть композит.
    add(composite: MatterComposite, body: MatterJS.BodyType): MatterComposite;
    allBodies(composite: MatterComposite): MatterJS.BodyType[];
  };
}

export const MatterLib = (
  Phaser.Physics.Matter as unknown as { Matter: MatterNamespace }
).Matter;

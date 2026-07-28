import { describe, expect, it, vi } from 'vitest';
import { SpiderStateMachine } from '../../src/game/spider/SpiderStateMachine';
import { STATE_PRIORITY } from '../../src/game/spider/SpiderState';
import { EventBus } from '../../src/core/events/EventBus';
import {
  FORCE_TO_ACCELERATION,
  accelerationToForce,
  bodyToWorld,
  getVelocity,
  pointVelocity,
  velocityToMatter,
  worldToBody,
} from '../../src/game/physics/MatterUnits';
import { PHYSICS } from '../../src/app/GameConfig';

describe('SpiderStateMachine', () => {
  it('стартует в Spawn', () => {
    const machine = new SpiderStateMachine();
    expect(machine.current).toBe('Spawn');
  });

  it('не даёт состоянию с меньшим приоритетом перебить текущее', () => {
    const machine = new SpiderStateMachine();
    machine.request('Tethered', { force: true });
    expect(machine.request('SurfaceIdle')).toBe(false);
    expect(machine.current).toBe('Tethered');
  });

  it('пропускает переход вверх по приоритету', () => {
    const machine = new SpiderStateMachine();
    machine.request('SurfaceIdle', { force: true });
    expect(machine.request('Airborne')).toBe(true);
    expect(machine.current).toBe('Airborne');
  });

  it('блокировка удерживает состояние заданное время', () => {
    const machine = new SpiderStateMachine();
    machine.request('Stunned', { force: true, lockMs: 200 });
    expect(machine.request('Cutscene')).toBe(false);
    machine.update(120);
    expect(machine.request('Cutscene')).toBe(false);
    machine.update(120);
    expect(machine.request('Cutscene')).toBe(true);
  });

  it('force игнорирует и приоритет, и блокировку', () => {
    const machine = new SpiderStateMachine();
    machine.request('Cutscene', { force: true, lockMs: 999 });
    expect(machine.request('SurfaceIdle', { force: true })).toBe(true);
    expect(machine.current).toBe('SurfaceIdle');
  });

  it('сообщает о смене состояния подписчикам', () => {
    const machine = new SpiderStateMachine();
    const seen: string[] = [];
    machine.onChange((change) => seen.push(`${change.from}->${change.to}`));
    machine.request('Airborne');
    expect(seen).toEqual(['Spawn->Airborne']);
  });

  it('Cutscene имеет наивысший приоритет', () => {
    const values = Object.values(STATE_PRIORITY);
    expect(STATE_PRIORITY.Cutscene).toBe(Math.max(...values));
  });
});

describe('EventBus', () => {
  it('позволяет отписаться внутри обработчика', () => {
    const bus = new EventBus();
    const calls: number[] = [];
    const off = bus.on('web:cleared', () => {
      calls.push(1);
      off();
    });
    bus.on('web:cleared', () => calls.push(2));
    bus.emit('web:cleared', {});
    bus.emit('web:cleared', {});
    expect(calls).toEqual([1, 2, 2]);
  });

  it('не роняет игру на ошибке подписчика', () => {
    const bus = new EventBus();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let reached = false;
    bus.on('web:cleared', () => {
      throw new Error('boom');
    });
    bus.on('web:cleared', () => {
      reached = true;
    });
    bus.emit('web:cleared', {});
    expect(reached).toBe(true);
    spy.mockRestore();
  });
});

describe('MatterUnits', () => {
  it('переводит скорость в единицы в секунду и обратно', () => {
    const body = {
      position: { x: 0, y: 0 },
      velocity: { x: 2, y: -3 },
      mass: 1,
      force: { x: 0, y: 0 },
      angle: 0,
      angularVelocity: 0,
    };
    expect(getVelocity(body)).toEqual({ x: 120, y: -180 });
    expect(velocityToMatter({ x: 120, y: -180 })).toEqual({ x: 2, y: -3 });
  });

  it('константа силы согласована с гравитацией из конфигурации', () => {
    // Matter добавляет телу силу mass · gravity.y · gravity.scale.
    // Через FORCE_TO_ACCELERATION она обязана дать ровно PHYSICS.gravity.
    const gravityY = PHYSICS.gravity / 1000;
    const forcePerMass = gravityY * PHYSICS.matterGravityScale;
    expect(forcePerMass * FORCE_TO_ACCELERATION).toBeCloseTo(PHYSICS.gravity, 6);
  });

  it('переводит ускорение в силу с учётом массы', () => {
    const force = accelerationToForce({ x: 0, y: PHYSICS.gravity }, 2.4);
    expect((force.y * FORCE_TO_ACCELERATION) / 2.4).toBeCloseTo(PHYSICS.gravity, 6);
  });

  it('переводит локальные координаты тела в мировые и обратно', () => {
    const body = {
      position: { x: 100, y: 50 },
      velocity: { x: 0, y: 0 },
      mass: 1,
      force: { x: 0, y: 0 },
      angle: Math.PI / 2,
      angularVelocity: 0,
    };
    const world = bodyToWorld(body, { x: 10, y: 0 });
    expect(world.x).toBeCloseTo(100, 5);
    expect(world.y).toBeCloseTo(60, 5);
    const local = worldToBody(body, world);
    expect(local.x).toBeCloseTo(10, 5);
    expect(local.y).toBeCloseTo(0, 5);
  });

  it('учитывает вращение в скорости точки тела', () => {
    const body = {
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      mass: 1,
      force: { x: 0, y: 0 },
      angle: 0,
      angularVelocity: 1 / 60,
    };
    // Точка на 10 единиц правее центра при вращении 1 рад/с движется вниз.
    const velocity = pointVelocity(body, { x: 10, y: 0 });
    expect(velocity.x).toBeCloseTo(0, 5);
    expect(velocity.y).toBeCloseTo(10, 5);
  });
});

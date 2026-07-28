import { describe, expect, it, vi } from 'vitest';
import { SpiderStateMachine } from '../../src/game/spider/SpiderStateMachine';
import { STATE_PRIORITY } from '../../src/game/spider/SpiderState';
import { EventBus } from '../../src/core/events/EventBus';

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

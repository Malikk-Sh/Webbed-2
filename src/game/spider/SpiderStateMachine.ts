import { STATE_PRIORITY, type SpiderState } from './SpiderState';

export interface StateChange {
  from: SpiderState;
  to: SpiderState;
}

/**
 * Конечный автомат героя.
 *
 * Автомат сознательно «мягкий»: он не запрещает переходы, а расставляет
 * приоритеты. Ввод игрока рождает много одновременных намерений (прыжок в
 * момент выпуска нити, разрыв нити во время оглушения), и жёсткая таблица
 * переходов быстро превращается в набор исключений.
 */
export class SpiderStateMachine {
  private state: SpiderState = 'Spawn';
  private timeInStateMs = 0;
  private previous: SpiderState = 'Spawn';
  private readonly listeners = new Set<(change: StateChange) => void>();
  /** Состояние удерживается принудительно до истечения таймера. */
  private lockMs = 0;
  /** Наибольший приоритет, победивший в текущем кадре. */
  private frameWinner = 0;

  get current(): SpiderState {
    return this.state;
  }

  get previousState(): SpiderState {
    return this.previous;
  }

  get elapsedMs(): number {
    return this.timeInStateMs;
  }

  get locked(): boolean {
    return this.lockMs > 0;
  }

  onChange(listener: (change: StateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(deltaMs: number): void {
    this.timeInStateMs += deltaMs;
    if (this.lockMs > 0) this.lockMs = Math.max(0, this.lockMs - deltaMs);
    // Приоритет разрешает конкуренцию внутри одного кадра и обнуляется на
    // следующем. Иначе однажды занятое высокоприоритетное состояние (Spawn,
    // SurfaceAttach) навсегда закрывало бы вход обычным состояниям движения.
    this.frameWinner = 0;
  }

  /**
   * Пытается перейти в новое состояние.
   *
   * За кадр побеждает самый приоритетный запрос; между кадрами состояние
   * меняется свободно, а удержание обеспечивает `lockMs` — так оглушение,
   * респаун и кат-сцена остаются неперебиваемыми ровно столько, сколько нужно.
   *
   * @param force игнорировать и приоритет, и блокировку.
   */
  request(next: SpiderState, options: { force?: boolean; lockMs?: number } = {}): boolean {
    const priority = STATE_PRIORITY[next];

    if (next === this.state) {
      if (options.lockMs) this.lockMs = Math.max(this.lockMs, options.lockMs);
      this.frameWinner = Math.max(this.frameWinner, priority);
      return false;
    }

    if (!options.force) {
      if (this.lockMs > 0) return false;
      if (priority < this.frameWinner) return false;
    }

    const change: StateChange = { from: this.state, to: next };
    this.previous = this.state;
    this.state = next;
    this.timeInStateMs = 0;
    this.lockMs = options.lockMs ?? 0;
    this.frameWinner = Math.max(this.frameWinner, priority);
    for (const listener of this.listeners) listener(change);
    return true;
  }

  /** Понижение до состояния с меньшим приоритетом (окончание прыжка и т. п.). */
  release(next: SpiderState): void {
    this.request(next, { force: true });
  }

  isOnSurface(): boolean {
    return (
      this.state === 'SurfaceIdle' ||
      this.state === 'SurfaceMove' ||
      this.state === 'SurfaceAttach' ||
      this.state === 'Spawn'
    );
  }

  isAirborne(): boolean {
    return this.state === 'Airborne' || this.state === 'JumpStart' || this.state === 'Tethered';
  }
}

import type { GameEventMap, GameEventName } from './GameEvents';

type Handler<K extends GameEventName> = (payload: GameEventMap[K]) => void;

/**
 * Типизированная шина событий.
 *
 * Обработчики копируются перед вызовом: подписчик вправе отписаться прямо
 * внутри обработчика (так делают, например, одноразовые подсказки), и без
 * копии это привело бы к пропуску следующего слушателя.
 */
export class EventBus {
  private readonly handlers = new Map<GameEventName, Set<(payload: unknown) => void>>();

  on<K extends GameEventName>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: unknown) => void);
    return () => this.off(event, handler);
  }

  once<K extends GameEventName>(event: K, handler: Handler<K>): () => void {
    const dispose = this.on(event, (payload) => {
      dispose();
      handler(payload);
    });
    return dispose;
  }

  off<K extends GameEventName>(event: K, handler: Handler<K>): void {
    this.handlers.get(event)?.delete(handler as (payload: unknown) => void);
  }

  emit<K extends GameEventName>(event: K, payload: GameEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[EventBus] Ошибка обработчика "${String(event)}"`, error);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** Общая шина игры. Прототип живёт в одной вкладке, поэтому синглтон уместен. */
export const events = new EventBus();

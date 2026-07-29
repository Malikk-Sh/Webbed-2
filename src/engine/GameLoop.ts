/**
 * Кадровый цикл на requestAnimationFrame.
 *
 * Собственный цикл вместо цикла движка даёт три вещи, которых игре не хватало:
 * честное ограничение кадровой частоты (для настройки «30 fps» на слабых
 * телефонах), остановку при скрытой вкладке и предсказуемый `delta` — он
 * обрезается сверху, поэтому возврат из фона не приводит к скачку симуляции
 * на несколько секунд вперёд.
 *
 * Аккумулятор фиксированного шага живёт не здесь, а в сцене: ей нужно уметь
 * замедлять время прицеливания и пошагово прокручивать физику из отладчика,
 * а цикл про это знать не должен.
 */
export class GameLoop {
  private handle = 0;
  private lastTimeMs = 0;
  private accumulatedFrameMs = 0;
  private minimumFrameMs = 0;
  private smoothedFps = 60;
  private running = false;

  /** Длительность последнего кадра, мс — для панели диагностики. */
  lastDeltaMs = 16.7;

  constructor(private readonly onFrame: (deltaMs: number, timeMs: number) => void) {}

  /** Ограничение кадровой частоты; 0 снимает ограничение. */
  setFrameCap(fps: number): void {
    // Порог чуть ниже целевого интервала: иначе кадр, пришедший на доли
    // миллисекунды раньше, отбрасывается целиком и частота проседает вдвое.
    this.minimumFrameMs = fps > 0 ? 1000 / fps - 1.5 : 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = performance.now();
    this.handle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.handle) cancelAnimationFrame(this.handle);
    this.handle = 0;
  }

  /** Сбрасывает отсчёт времени — после паузы или возврата из фона. */
  resetTiming(): void {
    this.lastTimeMs = performance.now();
    this.accumulatedFrameMs = 0;
  }

  get fps(): number {
    return this.smoothedFps;
  }

  private readonly tick = (timeMs: number): void => {
    if (!this.running) return;
    this.handle = requestAnimationFrame(this.tick);

    const rawDelta = timeMs - this.lastTimeMs;
    this.lastTimeMs = timeMs;

    // Кадры длиннее 100 мс — это переключение вкладки или подвисание системы.
    // Догонять такое время симуляцией нельзя, поэтому оно просто теряется.
    const delta = Math.min(Math.max(rawDelta, 0), 100);

    if (this.minimumFrameMs > 0) {
      this.accumulatedFrameMs += delta;
      if (this.accumulatedFrameMs < this.minimumFrameMs) return;
      this.lastDeltaMs = this.accumulatedFrameMs;
      this.accumulatedFrameMs = 0;
    } else {
      this.lastDeltaMs = delta;
    }

    if (this.lastDeltaMs > 0) {
      const instant = 1000 / this.lastDeltaMs;
      this.smoothedFps += (instant - this.smoothedFps) * 0.08;
    }

    this.onFrame(this.lastDeltaMs, timeMs);
  };
}

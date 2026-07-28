import { clamp, clamp01 } from '../../core/math/Interpolation';

interface Bus {
  gain: GainNode;
  volume: number;
}

type BusName = 'music' | 'ambient' | 'effects' | 'web' | 'ui';

/**
 * Полностью процедурный звук на Web Audio API.
 *
 * В прототипе нет ни одного аудиофайла: тон нити должен зависеть от её длины
 * и натяжения непрерывно (раздел 29.1 ТЗ), а сэмплами такое не сыграть — их
 * пришлось бы натягивать по высоте и терять характер. Синтез заодно снимает
 * вопрос веса офлайн-кэша.
 */
export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private readonly buses = new Map<BusName, Bus>();

  private masterVolume = 0.8;
  private musicVolume = 0.6;
  private sfxVolume = 0.85;

  private ambientStarted = false;
  private musicNodes: { osc: OscillatorNode; gain: GainNode }[] = [];
  private musicTimer: number | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  /** Одновременно звучащие голоса нитей — ограничение из раздела 29.4. */
  private webVoices = 0;
  private readonly maxWebVoices = 12;
  private activeVoices = 0;
  private readonly maxVoices = 32;

  private suspended = false;
  private intensity = 0;

  get ready(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  /** Создаёт контекст. Должно вызываться из обработчика жеста пользователя. */
  async unlock(): Promise<void> {
    if (!this.context) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.context = new Ctor();
      this.buildGraph();
    }
    if (this.context.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        /* Браузер ещё не считает жест достаточным — повторим при следующем. */
      }
    }
    this.startAmbient();
  }

  private buildGraph(): void {
    const ctx = this.context;
    if (!ctx) return;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 5;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.22;

    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;

    // Общий срез инфранизких частот. Динамик телефона их не воспроизводит,
    // зато они съедают запас громкости и на любой колонке превращаются в
    // грязный гул. Крутизна 12 дБ/окт. на 48 Гц убирает его, не трогая
    // ни ноты нитей, ни удары.
    const rumbleGuard = ctx.createBiquadFilter();
    rumbleGuard.type = 'highpass';
    rumbleGuard.frequency.value = 48;
    rumbleGuard.Q.value = 0.7;

    this.compressor.connect(rumbleGuard);
    rumbleGuard.connect(this.master);
    this.master.connect(ctx.destination);

    for (const name of ['music', 'ambient', 'effects', 'web', 'ui'] as BusName[]) {
      const gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(this.compressor);
      this.buses.set(name, { gain, volume: 1 });
    }

    this.applyVolumes();

    // Общий буфер шума: он нужен многим эффектам, а генерировать его
    // на каждый удар — заметная нагрузка на слабом устройстве.
    const length = Math.floor(ctx.sampleRate * 1.4);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
  }

  setVolumes(master: number, music: number, sfx: number): void {
    this.masterVolume = clamp01(master);
    this.musicVolume = clamp01(music);
    this.sfxVolume = clamp01(sfx);
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (this.master) this.master.gain.value = this.masterVolume;
    const set = (name: BusName, value: number) => {
      const bus = this.buses.get(name);
      if (bus) bus.gain.gain.value = value;
    };
    set('music', this.musicVolume * 0.5);
    set('ambient', this.musicVolume * 0.55);
    set('effects', this.sfxVolume);
    set('web', this.sfxVolume * 0.9);
    set('ui', this.sfxVolume * 0.7);
  }

  suspend(): void {
    this.suspended = true;
    if (this.context && this.context.state === 'running') void this.context.suspend();
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.context && this.context.state === 'suspended') void this.context.resume();
    if (this.ambientStarted && this.musicTimer === null) this.scheduleMusic();
  }

  destroy(): void {
    if (this.musicTimer !== null) clearInterval(this.musicTimer);
    for (const node of this.musicNodes) {
      try {
        node.osc.stop();
      } catch {
        /* уже остановлен */
      }
    }
    this.musicNodes = [];
    void this.context?.close();
    this.context = null;
  }

  /** Общая «взволнованность» сцены: скорость, натяжение, опасность. */
  setIntensity(value: number): void {
    this.intensity = clamp01(value);
  }

  private bus(name: BusName): GainNode | null {
    return this.buses.get(name)?.gain ?? null;
  }

  private claimVoice(): boolean {
    if (this.activeVoices >= this.maxVoices) return false;
    this.activeVoices++;
    return true;
  }

  private releaseVoice(delayMs: number): void {
    window.setTimeout(() => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    }, delayMs);
  }

  // ------------------------------------------------------------- окружение

  private startAmbient(): void {
    if (this.ambientStarted || !this.context) return;
    const ctx = this.context;
    const target = this.bus('ambient');
    if (!target || !this.noiseBuffer) return;
    this.ambientStarted = true;

    // Далёкий дождь: розоватый шум через мягкий фильтр.
    const rain = ctx.createBufferSource();
    rain.buffer = this.noiseBuffer;
    rain.loop = true;
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'bandpass';
    rainFilter.frequency.value = 780;
    rainFilter.Q.value = 0.55;
    const rainGain = ctx.createGain();
    rainGain.gain.value = 0.05;
    rain.connect(rainFilter).connect(rainGain).connect(target);
    rain.start();

    // Гул вентиляции: две слегка расстроенные волны. Частота поднята со
    // «звучащих» 55 Гц: на телефоне такой бас неслышен, но забивает микс.
    for (const [frequency, detune] of [
      [110, 0],
      [111.2, 8],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      osc.detune.value = detune;
      const gain = ctx.createGain();
      gain.gain.value = 0.045;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07 + Math.random() * 0.05;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.02;
      lfo.connect(lfoGain).connect(gain.gain);
      lfo.start();
      osc.connect(gain).connect(target);
      osc.start();
      this.musicNodes.push({ osc, gain });
    }

    this.scheduleMusic();
    this.scheduleDrips();
  }

  /**
   * Адаптивная музыка: редкие ноты пентатоники, плотность которых растёт
   * вместе с интенсивностью сцены (раздел 52 ТЗ в упрощённом виде).
   */
  private scheduleMusic(): void {
    if (this.musicTimer !== null) clearInterval(this.musicTimer);
    const scale = [196, 220, 261.63, 293.66, 349.23, 392, 440];
    this.musicTimer = window.setInterval(() => {
      if (!this.context || this.suspended) return;
      const chance = 0.2 + this.intensity * 0.42;
      if (Math.random() > chance) return;
      const note = scale[Math.floor(Math.random() * scale.length)]!;
      const octave = Math.random() > 0.72 ? 2 : 1;
      this.playPad(note * octave, 2.4 + Math.random() * 2.2, 0.05 + this.intensity * 0.03);
    }, 1400);
  }

  private scheduleDrips(): void {
    const schedule = () => {
      if (!this.context) return;
      window.setTimeout(
        () => {
          if (!this.suspended) this.playDrip();
          schedule();
        },
        2600 + Math.random() * 6200,
      );
    };
    schedule();
  }

  private playPad(frequency: number, duration: number, volume: number): void {
    const ctx = this.context;
    const target = this.bus('music');
    if (!ctx || !target || !this.claimVoice()) return;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = frequency;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = frequency * 3.2;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + duration * 0.28);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(filter).connect(gain).connect(target);
    osc.start(now);
    osc.stop(now + duration + 0.05);
    this.releaseVoice(duration * 1000 + 100);
  }

  private playDrip(): void {
    const ctx = this.context;
    const target = this.bus('ambient');
    if (!ctx || !target || !this.claimVoice()) return;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const now = ctx.currentTime;
    const base = 620 + Math.random() * 900;
    osc.frequency.setValueAtTime(base, now);
    osc.frequency.exponentialRampToValueAtTime(base * 0.35, now + 0.14);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.09, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);

    osc.connect(gain).connect(target);
    osc.start(now);
    osc.stop(now + 0.28);
    this.releaseVoice(300);
  }

  // ------------------------------------------------------------------ нити

  /**
   * Щипок нити: аддитивный синтез из нескольких затухающих обертонов.
   *
   * Здесь раньше стояла модель Карплуса — Стронга с линией задержки в
   * обратной связи. Она красиво звучит на бумаге, но коэффициент петли у неё
   * складывался из усиления обратной связи (до 0.985) и резонансного подъёма
   * фильтра нижних частот, и на длинных нитях с низкой нотой произведение
   * переваливало за единицу. Петля вместо затухания раскачивалась — отсюда
   * нарастающий низкочастотный гул при каждом выпуске паутины.
   *
   * Сумма затухающих синусов не имеет обратной связи вообще, поэтому
   * разогнаться не может ни при каких параметрах, звучит так же «струнно»
   * и обходится дешевле.
   */
  playStrandPluck(frequency: number, amplitude: number, brightness = 0.5): void {
    const ctx = this.context;
    const target = this.bus('web');
    if (!ctx || !target) return;
    if (this.webVoices >= this.maxWebVoices || !this.claimVoice()) return;

    this.webVoices++;
    const now = ctx.currentTime;
    // Нижняя граница держит ноту в слышимом диапазоне: ниже ~140 Гц телефонный
    // динамик всё равно отдаёт только неприятное гудение.
    const root = clamp(frequency, 140, 1600);
    const level = clamp01(amplitude) * 0.22;

    const voice = ctx.createGain();
    voice.gain.value = 1;
    voice.connect(target);

    // Обертоны слегка расстроены и затухают тем быстрее, чем выше —
    // так ведёт себя реальная струна.
    const partials: [number, number, number][] = [
      [1, 1, 1.5],
      [2.01, 0.42 + brightness * 0.2, 0.9],
      [3.04, 0.2 + brightness * 0.18, 0.55],
      [4.98, 0.08 + brightness * 0.12, 0.34],
    ];

    let longest = 0;
    for (const [ratio, weight, decay] of partials) {
      const partialFrequency = root * ratio;
      if (partialFrequency > 12000) continue;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = partialFrequency;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(level * weight, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

      osc.connect(gain).connect(voice);
      osc.start(now);
      osc.stop(now + decay + 0.05);
      longest = Math.max(longest, decay);
    }

    // Короткий шумовой призвук — «касание» по нити.
    if (this.noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = clamp(root * 4, 400, 6000);
      filter.Q.value = 1.2;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(level * 0.5, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
      noise.connect(filter).connect(gain).connect(voice);
      noise.start(now);
      noise.stop(now + 0.08);
    }

    const lifetimeMs = (longest + 0.1) * 1000;
    window.setTimeout(() => {
      this.webVoices = Math.max(0, this.webVoices - 1);
      try {
        voice.disconnect();
      } catch {
        /* уже отключено */
      }
    }, lifetimeMs);
    this.releaseVoice(lifetimeMs);
  }

  playWebShoot(): void {
    const ctx = this.context;
    const target = this.bus('web');
    if (!ctx || !target || !this.noiseBuffer || !this.claimVoice()) return;

    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1600, now);
    filter.frequency.exponentialRampToValueAtTime(4800, now + 0.12);
    filter.Q.value = 3.2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    noise.connect(filter).connect(gain).connect(target);
    noise.start(now);
    noise.stop(now + 0.2);
    this.releaseVoice(240);
  }

  playWebBreak(strength = 1): void {
    const ctx = this.context;
    const target = this.bus('web');
    if (!ctx || !target || !this.noiseBuffer || !this.claimVoice()) return;

    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1800;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2 * strength, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
    noise.connect(filter).connect(gain).connect(target);
    noise.start(now);
    noise.stop(now + 0.14);

    // Низкий «оборвавшийся» призвук снизу.
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.2);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.1 * strength, now);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    osc.connect(oscGain).connect(target);
    osc.start(now);
    osc.stop(now + 0.26);

    this.releaseVoice(300);
  }

  // ------------------------------------------------------------- персонаж

  playJump(): void {
    this.playBlip(340, 620, 0.1, 0.12, 'effects', 'triangle');
  }

  playLand(strength: number): void {
    const ctx = this.context;
    const target = this.bus('effects');
    if (!ctx || !target || !this.noiseBuffer || !this.claimVoice()) return;

    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 340 + strength * 700;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.08 + strength * 0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16 + strength * 0.14);
    noise.connect(filter).connect(gain).connect(target);
    noise.start(now);
    noise.stop(now + 0.4);
    this.releaseVoice(420);
  }

  playStep(speed: number): void {
    const ctx = this.context;
    const target = this.bus('effects');
    if (!ctx || !target || !this.noiseBuffer) return;
    if (this.activeVoices > this.maxVoices - 6) return;
    if (!this.claimVoice()) return;

    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.playbackRate.value = 1.5 + Math.random() * 0.7;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2400 + Math.random() * 1800;
    filter.Q.value = 5;
    const gain = ctx.createGain();
    const volume = 0.012 + clamp01(speed / 300) * 0.022;
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    noise.connect(filter).connect(gain).connect(target);
    noise.start(now);
    noise.stop(now + 0.08);
    this.releaseVoice(100);
  }

  playImpact(strength: number): void {
    const ctx = this.context;
    const target = this.bus('effects');
    if (!ctx || !target || !this.claimVoice()) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.18);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.1 + strength * 0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(gain).connect(target);
    osc.start(now);
    osc.stop(now + 0.3);
    this.releaseVoice(340);
  }

  playMechanism(open: boolean): void {
    const ctx = this.context;
    const target = this.bus('effects');
    if (!ctx || !target || !this.claimVoice()) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(open ? 90 : 150, now);
    osc.frequency.linearRampToValueAtTime(open ? 190 : 70, now + 0.5);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.09, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    osc.connect(filter).connect(gain).connect(target);
    osc.start(now);
    osc.stop(now + 0.62);
    this.releaseVoice(680);
  }

  playSuccess(): void {
    const notes = [392, 493.88, 587.33, 783.99];
    notes.forEach((note, index) => {
      window.setTimeout(() => this.playPad(note, 1.6, 0.07), index * 130);
    });
  }

  playUi(kind: 'tap' | 'confirm' | 'back'): void {
    if (kind === 'tap') this.playBlip(660, 660, 0.05, 0.05, 'ui', 'sine');
    else if (kind === 'confirm') this.playBlip(523.25, 784, 0.16, 0.06, 'ui', 'triangle');
    else this.playBlip(440, 294, 0.16, 0.05, 'ui', 'sine');
  }

  playWarning(): void {
    this.playBlip(220, 180, 0.22, 0.07, 'effects', 'sawtooth');
  }

  private playBlip(
    from: number,
    to: number,
    duration: number,
    volume: number,
    busName: BusName,
    type: OscillatorType,
  ): void {
    const ctx = this.context;
    const target = this.bus(busName);
    if (!ctx || !target || !this.claimVoice()) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, now);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain).connect(target);
    osc.start(now);
    osc.stop(now + duration + 0.02);
    this.releaseVoice(duration * 1000 + 60);
  }
}

export const audio = new AudioEngine();

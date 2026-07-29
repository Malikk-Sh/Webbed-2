import {
  PHYSICS,
  qualityProfiles,
  respawnConfig,
  spiderBodyConfig,
} from '../../app/GameConfig';
import { PALETTE } from '../../app/Palette';
import { events } from '../../core/events/EventBus';
import type { RunStats } from '../../core/events/GameEvents';
import { clamp, clamp01, damp } from '../../core/math/Interpolation';
import { rectContains } from '../../core/math/Geometry';
import { length, type Vector2 } from '../../core/math/Vector2';
import type { Camera2D } from '../../engine/Camera2D';
import type { Painter } from '../../engine/Painter';
import type { Surface } from '../../engine/Surface';
import { cssColor } from '../../engine/Color';
import { PhysicsWorld } from '../../engine/physics/PhysicsWorld';
import { circleBody, type RigidBody } from '../../engine/physics/RigidBody';
import { audio } from '../audio/AudioEngine';
import { CameraController } from '../camera/CameraController';
import type { InputSystem } from '../input/InputSystem';
import type { LevelDefinition } from '../level/LevelSchema';
import { getTheme } from '../level/LevelTheme';
import { loadLevel, type LoadedLevel } from '../level/PrototypeLevelLoader';
import type { RigidBodySnapshot } from '../objects/LevelObjects';
import { BackgroundRenderer } from '../render/BackgroundRenderer';
import { ObjectRenderer } from '../render/ObjectRenderer';
import { ParticleField } from '../render/ParticleField';
import { WorldRenderer } from '../render/WorldRenderer';
import { settingsRepository } from '../save/SettingsRepository';
import { SpiderController } from '../spider/SpiderController';
import { SpiderStateMachine } from '../spider/SpiderStateMachine';
import { SpiderVisual } from '../spider/SpiderVisual';
import { SpiderWebController } from '../spider/SpiderWebController';
import type { SpiderMood } from '../spider/SpiderState';
import { WebRenderer } from '../web/WebRenderer';
import { WebSystem } from '../web/WebSystem';
import type { PrototypeHud } from '../ui/PrototypeHud';
import { AimOverlay } from '../render/AimOverlay';
import { DebugOverlay } from '../../core/debug/DebugOverlay';

interface CheckpointState {
  checkpointId: string;
  position: Vector2;
  normal: Vector2;
  crates: Record<string, RigidBodySnapshot>;
  weights: Record<string, RigidBodySnapshot>;
}

export interface SceneDeps {
  surface: Surface;
  camera: Camera2D;
  painter: Painter;
  input: InputSystem;
  hud: PrototypeHud;
  /** Комната, которую играет сцена. Кампанию ведёт вызывающая сторона. */
  level: LevelDefinition;
  getFps: () => number;
  onComplete: (stats: RunStats) => void;
  onPauseRequested: () => void;
}

/**
 * Основная игровая сцена.
 *
 * Здесь собирается порядок кадра из раздела 6.2 ТЗ: ввод → герой → шаг физики →
 * крепления паутины → решатель → триггеры → камера → отрисовка. Симуляция
 * идёт фиксированным шагом 1/60 с ограничением накопления, поэтому просадка
 * кадров замедляет картинку, но не меняет физику.
 *
 * Порядок слоёв больше не задаётся числами глубины: рисование идёт сверху вниз
 * по коду метода `render`, и что вызвано позже — то и лежит выше.
 */
export class PrototypeScene {
  private readonly surface: Surface;
  private readonly camera: Camera2D;
  private readonly painter: Painter;
  private readonly inputSystem: InputSystem;
  private readonly hud: PrototypeHud;
  private readonly getFps: () => number;

  private readonly physics: PhysicsWorld;
  private readonly level: LoadedLevel;
  private readonly web: WebSystem;
  private readonly spider: SpiderController;
  private readonly webController: SpiderWebController;
  private readonly stateMachine = new SpiderStateMachine();

  private readonly cameraController: CameraController;
  private readonly background: BackgroundRenderer;
  private readonly worldRenderer: WorldRenderer;
  private readonly objectRenderer: ObjectRenderer;
  private readonly webRenderer: WebRenderer;
  private readonly spiderVisual: SpiderVisual;
  private readonly particles = new ParticleField();
  private readonly aimOverlay = new AimOverlay();
  private readonly debugOverlay = new DebugOverlay();

  private readonly spiderBody: RigidBody;
  private accumulatorMs = 0;
  private running = false;
  private completed = false;
  private completionTimerMs = -1;

  private checkpoint: CheckpointState | null = null;
  private activatedTriggers = new Set<string>();
  private respawnPhase: 'none' | 'out' | 'restore' | 'in' = 'none';
  private respawnTimerMs = 0;
  private inputProtectionMs = 0;

  private stats: RunStats = emptyStats();
  private readonly foregroundView = { x: 0, y: 0, width: 0, height: 0 };

  private timeScale = 1;
  private smoothedTimeScale = 1;
  private readonly onComplete: (stats: RunStats) => void;
  private readonly onPauseRequested: () => void;
  private disposers: (() => void)[] = [];

  constructor(deps: SceneDeps) {
    this.surface = deps.surface;
    this.camera = deps.camera;
    this.painter = deps.painter;
    this.inputSystem = deps.input;
    this.hud = deps.hud;
    this.getFps = deps.getFps;
    this.onComplete = deps.onComplete;
    this.onPauseRequested = deps.onPauseRequested;

    this.physics = new PhysicsWorld({
      gravityY: PHYSICS.gravity,
      velocityIterations: PHYSICS.velocityIterations,
      positionIterations: PHYSICS.positionIterations,
    });

    this.level = loadLevel(deps.level, this.physics);

    this.spiderBody = this.physics.add(
      circleBody(0, 0, spiderBodyConfig.radius, {
        mass: spiderBodyConfig.mass,
        friction: spiderBodyConfig.friction,
        frictionAir: spiderBodyConfig.frictionAir,
        restitution: spiderBodyConfig.restitution,
        label: 'spider',
        // Персонаж не вращается: «верх» ему задаёт опорная нормаль, а не
        // угловая скорость, накопленная от столкновений.
        fixedRotation: true,
      }),
    );

    this.spider = new SpiderController({
      body: this.spiderBody,
      world: this.level.collision,
      state: this.stateMachine,
    });

    this.web = new WebSystem(
      this.level.collision,
      {
        getBody: (bodyId) => this.findBody(bodyId),
        applyForce: (bodyId, point, force) => this.findBody(bodyId)?.applyForce(point, force),
      },
      { getSpiderPosition: () => this.spider.position },
    );

    this.webController = new SpiderWebController({
      web: this.web,
      spider: this.spider,
      state: this.stateMachine,
      collision: this.level.collision,
      anchors: this.level.anchors,
      getAttachableBodies: () => this.attachableBodies(),
      aimAssistStrength: () => settingsRepository.current.aimAssist,
      slowMotionEnabled: () => settingsRepository.current.slowMotionAiming,
    });

    this.background = new BackgroundRenderer(this.level.definition);
    this.worldRenderer = new WorldRenderer(this.level);
    this.objectRenderer = new ObjectRenderer(this.level);
    this.webRenderer = new WebRenderer(this.web);
    this.spiderVisual = new SpiderVisual(this.spider, this.level.collision);

    this.cameraController = new CameraController(
      this.camera,
      this.level.definition.cameraBounds,
    );

    this.bindEvents();
    this.applyQuality();
    this.disposers.push(this.surface.onResize((surface) => this.handleResize(surface)));
    this.handleResize(this.surface);

    this.hud.setDiagnosticsSource(() => this.buildDiagnostics());

    this.restartRoom();

    // Доступ к сцене из консоли разработчика и из браузерных тестов.
    (window as unknown as { silkboundScene?: PrototypeScene }).silkboundScene = this;
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.debugOverlay.destroy();
  }

  // ---------------------------------------------------------------- события

  private bindEvents(): void {
    this.disposers.push(
      events.on('spider:landed', ({ position, normal, impactSpeed }) => {
        const strength = clamp01(impactSpeed / 700);
        if (strength > 0.05) {
          this.particles.burstLanding(position, normal, strength);
          audio.playLand(strength);
        }
        // Приземление будит спящие нити поблизости.
        this.web.solver.wake(position.x, position.y, 160);
      }),

      events.on('spider:jumped', ({ position, normal }) => {
        this.stats.jumps++;
        this.particles.burstJump(position, normal);
        audio.playJump();
      }),

      events.on('spider:step', ({ position, speed }) => {
        audio.playStep(speed);
        // Пыль из-под лапы: без неё быстрый бег читается как скольжение
        // силуэта по поверхности, а не как шаги по ней.
        const normal = this.spider.contact?.normal;
        if (normal && speed > 60) this.particles.puffStep(position, normal, speed);
      }),

      events.on('web:created', ({ playerCreated, position }) => {
        if (!playerCreated) return;
        this.stats.strandsCreated++;
        this.particles.burstAttach(position);
        this.spiderVisual.flashSpinneret();
        audio.playWebShoot();
      }),

      events.on('web:broken', ({ position, cause }) => {
        if (cause === 'cleanup') return;
        this.stats.strandsBroken++;
        this.particles.burstSilk(position, cause === 'tension' ? 1.2 : 0.7);
        audio.playWebBreak(cause === 'tension' ? 1 : 0.6);
        if (cause === 'tension') {
          this.cameraController.shake(0.18, 180);
        }
      }),

      events.on('web:pluck', ({ frequency, amplitude }) => {
        audio.playStrandPluck(frequency, amplitude, 0.4 + amplitude * 0.4);
      }),

      events.on('object:plate-changed', ({ active, plateId }) => {
        audio.playMechanism(active);
        const plate = this.level.plates.find((p) => p.id === plateId);
        if (plate && active) {
          this.particles.burstSparkle({ x: plate.x, y: plate.surfaceY - 20 }, PALETTE.plateOn, 18);
        }
      }),

      events.on('object:door-changed', ({ state }) => {
        if (state === 'Open') {
          const door = this.level.doors[0];
          if (door) {
            this.particles.burstSparkle(
              { x: door.x + door.width / 2, y: door.y + door.height },
              PALETTE.exitGlow,
              26,
            );
          }
          this.cameraController.shake(0.12, 260);
        }
      }),

      events.on('camera:shake', ({ strength, durationMs }) =>
        this.cameraController.shake(strength, durationMs),
      ),

      events.on('web:limit-reached', () => audio.playWarning()),
    );
  }

  private findBody(bodyId: number): RigidBody | null {
    for (const crate of this.level.crates) if (crate.body.id === bodyId) return crate.body;
    for (const weight of this.level.weights) if (weight.body.id === bodyId) return weight.body;
    return null;
  }

  private attachableBodies(): RigidBody[] {
    const bodies: RigidBody[] = [];
    for (const crate of this.level.crates) bodies.push(crate.body);
    for (const weight of this.level.weights) bodies.push(weight.body);
    return bodies;
  }

  applyQuality(): void {
    const settings = settingsRepository.current;
    const profile = qualityProfiles[settings.quality];
    const particleBudget = settings.reducedParticles
      ? Math.round(profile.maxParticles * 0.4)
      : profile.maxParticles;

    this.background.setQuality(
      profile.parallaxLayers,
      profile.godRays,
      profile.rain,
      settings.reducedParticles ? 20 : profile.backgroundParticles,
    );
    this.worldRenderer.setQuality(profile.parallaxLayers);
    this.webRenderer.setQuality(profile.webGlowPasses, profile.dewDrops, settings.highContrastWeb);
    this.spiderVisual.setQuality(profile.proceduralLegs);
    this.particles.setBudget(particleBudget);
    this.cameraController.setShakeEnabled(settings.cameraShake);
  }

  private handleResize(surface: Surface): void {
    this.cameraController.resize(surface.width, surface.height);
    this.hud.resize(surface.width, surface.height);
  }

  // ------------------------------------------------------------- жизненный цикл

  setRunning(running: boolean): void {
    this.running = running;
    if (!running) {
      this.accumulatorMs = 0;
      this.inputSystem.releaseAll();
    }
  }

  restartRoom(): void {
    this.hud.resetTransient();
    this.web.reset();
    this.webController.reset();
    this.particles.clear();
    this.activatedTriggers.clear();
    this.completed = false;
    this.completionTimerMs = -1;
    this.stats = emptyStats();

    for (const crate of this.level.crates) crate.restore();
    for (const weight of this.level.weights) weight.restore();
    for (const plate of this.level.plates) plate.reset();
    for (const door of this.level.doors) door.reset();
    for (const bloom of this.level.blooms) bloom.reset();
    this.stats.bloomsTotal = this.level.blooms.length;

    this.createScriptedWeb();

    const spawn = this.level.definition.spawnPoints[0]!;
    this.checkpoint = {
      checkpointId: 'checkpoint-start',
      position: { x: spawn.x, y: spawn.y },
      normal: { x: spawn.surfaceNormal.x, y: spawn.surfaceNormal.y },
      crates: this.snapshotCrates(),
      weights: this.snapshotWeights(),
    };

    this.placeAtCheckpoint();
    this.cameraController.snapTo(this.spider.position);
    this.hud.setFade(0);
    this.respawnPhase = 'none';
    // Название комнаты показывается именно отсюда: и при первом входе, и при
    // перезапуске игрок должен видеть, где он.
    this.hud.showTitle(this.level.definition.title);
    events.emit('level:restarted', {});
  }

  /** Сюжетные нити комнаты: подвешенный груз держится на них с самого начала. */
  private createScriptedWeb(): void {
    for (const weight of this.level.weights) {
      this.web.createStrand({
        start: { type: 'world', point: weight.anchor, surfaceId: 'beam' },
        end: { type: 'body', bodyId: weight.body.id, localOffset: { x: 0, y: -weight.radius } },
        requestedRestLength: weight.restLength,
        playerCreated: false,
        scripted: true,
        cuttable: weight.cuttable,
      });
    }
  }

  private snapshotCrates(): Record<string, RigidBodySnapshot> {
    const result: Record<string, RigidBodySnapshot> = {};
    for (const crate of this.level.crates) result[crate.id] = crate.snapshot();
    return result;
  }

  private snapshotWeights(): Record<string, RigidBodySnapshot> {
    const result: Record<string, RigidBodySnapshot> = {};
    for (const weight of this.level.weights) result[weight.id] = weight.snapshot();
    return result;
  }

  private placeAtCheckpoint(): void {
    const checkpoint = this.checkpoint;
    if (!checkpoint) return;
    this.spider.teleport(checkpoint.position, checkpoint.normal);
    this.stateMachine.request('Spawn', { force: true });
    events.emit('spider:spawned', { position: checkpoint.position });
  }

  private triggerRespawn(): void {
    if (this.respawnPhase !== 'none') return;
    this.respawnPhase = 'out';
    this.respawnTimerMs = 0;
    this.stats.falls++;
    this.stateMachine.request('DeadOrLost', { force: true });
    this.inputSystem.setEnabled(false);
    events.emit('spider:died', { position: this.spider.position, reason: 'fall' });
    audio.playWarning();
  }

  private updateRespawn(deltaMs: number): void {
    if (this.respawnPhase === 'none') {
      if (this.inputProtectionMs > 0) this.inputProtectionMs -= deltaMs;
      return;
    }

    this.respawnTimerMs += deltaMs;

    if (this.respawnPhase === 'out') {
      this.hud.setFade(clamp01(this.respawnTimerMs / respawnConfig.fadeOutMs));
      if (this.respawnTimerMs >= respawnConfig.fadeOutMs) {
        this.respawnPhase = 'restore';
        this.respawnTimerMs = 0;
        this.restoreCheckpoint();
      }
      return;
    }

    if (this.respawnPhase === 'restore') {
      this.hud.setFade(1);
      if (this.respawnTimerMs >= respawnConfig.restoreMs) {
        this.respawnPhase = 'in';
        this.respawnTimerMs = 0;
        this.inputSystem.setEnabled(true);
        this.inputProtectionMs = respawnConfig.inputProtectionMs;
      }
      return;
    }

    this.hud.setFade(1 - clamp01(this.respawnTimerMs / respawnConfig.fadeInMs));
    if (this.respawnTimerMs >= respawnConfig.fadeInMs) {
      this.respawnPhase = 'none';
      this.hud.setFade(0);
      this.stateMachine.request('SurfaceIdle', { force: true });
    }
  }

  private restoreCheckpoint(): void {
    const checkpoint = this.checkpoint;
    if (!checkpoint) return;

    // Пользовательская паутина при неудаче очищается (раздел 27 ТЗ),
    // а сюжетные нити восстанавливаются вместе с грузом.
    this.web.reset();
    this.webController.reset();
    this.particles.clear();

    for (const crate of this.level.crates) {
      const snapshot = checkpoint.crates[crate.id];
      if (snapshot) crate.restore(snapshot);
    }
    for (const weight of this.level.weights) {
      const snapshot = checkpoint.weights[weight.id];
      if (snapshot) weight.restore(snapshot);
    }
    for (const plate of this.level.plates) plate.reset();
    for (const door of this.level.doors) door.reset();
    // Собранные бутоны при падении не теряются: это награда за исследование,
    // а не ресурс, которым игрока наказывают за ошибку.

    this.createScriptedWeb();
    this.placeAtCheckpoint();
    this.cameraController.snapTo(this.spider.position);
    events.emit('spider:respawned', { checkpointId: checkpoint.checkpointId });
  }

  // -------------------------------------------------------------- игровой цикл

  frame(deltaMs: number, timeMs: number): void {
    const frameDelta = Math.min(deltaMs, 100);

    if (!this.running) {
      this.render(frameDelta / 1000, timeMs);
      return;
    }

    const input = this.inputSystem.update(frameDelta);

    if (input.pausePressed) {
      this.onPauseRequested();
      return;
    }
    if (input.restartPressed && this.respawnPhase === 'none') {
      this.triggerRespawn();
    }

    this.debugOverlay.handleKeys(this);

    // Прицеливание замедляет мир, но не останавливает его.
    this.timeScale = this.webController.timeScale;
    this.smoothedTimeScale = damp(this.smoothedTimeScale, this.timeScale, 0.08, frameDelta / 1000);

    this.webController.update(frameDelta, input);

    const scaledDelta = frameDelta * this.smoothedTimeScale;
    this.accumulatorMs += this.debugOverlay.physicsPaused ? 0 : scaledDelta;
    if (this.debugOverlay.consumeStepRequest()) this.accumulatorMs = PHYSICS.fixedDeltaMs;

    const maxAccumulated = PHYSICS.fixedDeltaMs * PHYSICS.maxAccumulatedSteps;
    if (this.accumulatorMs > maxAccumulated) this.accumulatorMs = maxAccumulated;

    let steps = 0;
    while (this.accumulatorMs >= PHYSICS.fixedDeltaMs && steps < PHYSICS.maxAccumulatedSteps) {
      this.fixedStep(PHYSICS.fixedDeltaMs / 1000, input);
      this.accumulatorMs -= PHYSICS.fixedDeltaMs;
      steps++;
    }

    if (!this.completed) this.stats.timeMs += frameDelta;
    if (this.webController.isTethered) this.stats.swingTimeMs += frameDelta;
    this.stats.peakStrands = Math.max(this.stats.peakStrands, this.web.peakStrandCount);

    this.updateRespawn(frameDelta);
    this.updateCompletion(frameDelta);
    this.updateCamera(frameDelta / 1000, input);
    this.render(frameDelta / 1000, timeMs);
    this.updateAudioMix();
  }

  private fixedStep(deltaSeconds: number, input: ReturnType<InputSystem['update']>): void {
    const controlled = this.inputProtectionMs <= 0 && this.respawnPhase === 'none';
    const effectiveInput = controlled ? input : this.neutralInput(input);

    // 1. Герой: ввод → силы и скорость.
    this.spider.tetherAnchor = this.webController.anchorPosition;
    this.spider.fixedUpdate(deltaSeconds, effectiveInput, this.webController.isTethered);

    // Отпускание нити прыжком сохраняет импульс (раздел 24.4 ТЗ).
    if (this.webController.isTethered && effectiveInput.jumpPressed) {
      this.webController.release(true);
    }

    // 2. Шаг физики: столкновения тел и переноска ящиков.
    this.physics.step(deltaSeconds);

    // 3. Паутина: крепления, решатель, натяжение, разрывы.
    this.web.fixedUpdate(deltaSeconds);

    // 4. Активная нить героя: маятник и подтягивание.
    this.webController.fixedUpdate(deltaSeconds, effectiveInput);

    // 5. Механизмы уровня.
    for (const plate of this.level.plates) plate.fixedUpdate(deltaSeconds, this.physics.bodies);
    for (const door of this.level.doors) {
      const plate = this.level.plates.find((p) => p.id === door.controlledBy);
      door.fixedUpdate(deltaSeconds, plate?.isActive() ?? false);
    }

    // 6. Сбор бутонов и триггеры комнаты.
    this.updateBlooms();
    this.updateTriggers();
    this.stateMachine.update(deltaSeconds * 1000);
  }

  private neutralInput(input: ReturnType<InputSystem['update']>): ReturnType<InputSystem['update']> {
    return {
      ...input,
      moveX: 0,
      moveY: 0,
      jumpPressed: false,
      jumpHeld: false,
      webPressed: false,
      webHeld: false,
      webReleased: false,
      cutPressed: false,
    };
  }

  /**
   * Сбор бутонов идёт в фиксированном шаге вместе с триггерами: на быстрой
   * дуге маятника кадр может перекрыть весь радиус подбора, и в отрисовке
   * бутон было бы легко пролететь насквозь.
   */
  private updateBlooms(): void {
    if (this.respawnPhase !== 'none') return;
    const position = this.spider.position;

    for (const bloom of this.level.blooms) {
      if (!bloom.tryCollect(position)) continue;
      this.stats.bloomsCollected++;
      this.particles.burstSparkle({ x: bloom.x, y: bloom.y }, PALETTE.anchorIdle, 22);
      audio.playUi('confirm');
      events.emit('object:bloom-collected', {
        bloomId: bloom.id,
        position: { x: bloom.x, y: bloom.y },
        collected: this.stats.bloomsCollected,
        total: this.stats.bloomsTotal,
      });
    }
  }

  private updateTriggers(): void {
    if (this.respawnPhase !== 'none' || this.completed) return;
    const position = this.spider.position;

    for (const trigger of this.level.definition.triggers) {
      const rect = {
        x: trigger.x,
        y: trigger.y,
        width: trigger.width,
        height: trigger.height,
      };
      if (!rectContains(rect, position)) continue;
      if (trigger.once && this.activatedTriggers.has(trigger.id)) continue;

      switch (trigger.action) {
        case 'respawn':
          this.triggerRespawn();
          return;

        case 'checkpoint': {
          if (this.activatedTriggers.has(trigger.id)) break;
          this.activatedTriggers.add(trigger.id);
          this.setCheckpoint(trigger.checkpointId!);
          break;
        }

        case 'hint': {
          if (this.activatedTriggers.has(trigger.id)) break;
          this.activatedTriggers.add(trigger.id);
          if (settingsRepository.current.hintsEnabled && trigger.hintText) {
            events.emit('hint:show', {
              id: trigger.hintId ?? trigger.id,
              text: trigger.hintText,
            });
          }
          break;
        }

        case 'complete-prototype':
          this.completeRoom();
          return;
      }
    }
  }

  private setCheckpoint(checkpointId: string): void {
    const definition = this.level.definition.checkpoints.find((c) => c.id === checkpointId);
    if (!definition) return;

    let position: Vector2;
    let normal: Vector2 = { x: 0, y: -1 };
    if (definition.spawnPointId) {
      const spawn = this.level.definition.spawnPoints.find(
        (s) => s.id === definition.spawnPointId,
      );
      if (!spawn) return;
      position = { x: spawn.x, y: spawn.y };
      normal = { x: spawn.surfaceNormal.x, y: spawn.surfaceNormal.y };
    } else {
      position = { x: definition.x ?? 0, y: definition.y ?? 0 };
      if (definition.surfaceNormal) normal = { ...definition.surfaceNormal };
    }

    this.checkpoint = {
      checkpointId,
      position,
      normal,
      crates: this.snapshotCrates(),
      weights: this.snapshotWeights(),
    };

    this.particles.burstSparkle(this.spider.position, PALETTE.ok, 16);
    audio.playUi('confirm');
    events.emit('level:checkpoint', { checkpointId, position });
  }

  private completeRoom(): void {
    if (this.completed) return;
    this.completed = true;
    this.stats.peakStrands = Math.max(this.stats.peakStrands, this.web.peakStrandCount);
    this.inputSystem.setEnabled(false);
    this.stateMachine.request('Cutscene', { force: true });
    this.particles.burstSparkle(this.spider.position, PALETTE.exitGlow, 46);
    audio.playSuccess();
    this.cameraController.shake(0.08, 260);
    events.emit('level:completed', { stats: this.stats });
    // Пауза перед итогами: искры успевают долететь, а игрок — увидеть выход.
    this.completionTimerMs = 900;
  }

  private updateCompletion(deltaMs: number): void {
    if (this.completionTimerMs < 0) return;
    this.completionTimerMs -= deltaMs;
    if (this.completionTimerMs > 0) return;
    this.completionTimerMs = -1;
    this.onComplete(this.stats);
  }

  private updateCamera(deltaSeconds: number, input: ReturnType<InputSystem['update']>): void {
    const aiming = this.webController.isAiming;
    const aimDirection = aiming ? { x: input.aimX, y: input.aimY } : null;
    this.cameraController.update(
      deltaSeconds,
      this.spider.position,
      this.spider.velocity,
      aimDirection,
      this.webController.isTethered,
    );
  }

  // ------------------------------------------------------------- отрисовка

  /**
   * Кадр целиком: фон со своими планами, мир, объекты, паутина, герой,
   * частицы, прицел, отладка — и поверх всего экранный интерфейс.
   */
  private render(deltaSeconds: number, time: number): void {
    const painter = this.painter;
    const ratio = this.surface.pixelRatio;

    this.surface.clear(cssColor(this.background.clearColor, 1));
    painter.bind(this.surface.ctx);

    // --- фон со своими множителями параллакса ---------------------------
    this.background.update(deltaSeconds, time);
    this.background.draw(
      painter,
      this.camera,
      ratio,
      time,
      this.surface.width,
      this.surface.height,
    );

    // --- мир --------------------------------------------------------------
    this.camera.applyTo(painter.ctx, ratio, 1);
    const view = this.camera.worldView;

    this.worldRenderer.update(deltaSeconds, time);
    this.worldRenderer.drawStaticLayers(painter, view);
    this.worldRenderer.drawGrass(painter, view);
    painter.setBlendMode('add');
    this.worldRenderer.drawGlow(painter, time, view);
    painter.setBlendMode('normal');

    // --- объекты ----------------------------------------------------------
    for (const bloom of this.level.blooms) bloom.update(deltaSeconds);
    this.objectRenderer.draw(painter, time);

    // --- паутина ----------------------------------------------------------
    this.webRenderer.render(painter, time, view);
    this.webRenderer.pruneCache();

    // --- герой ------------------------------------------------------------
    this.spiderVisual.setMood(this.currentMood());
    this.spiderVisual.lookAt(this.lookDirection());
    this.spiderVisual.update(deltaSeconds);
    this.spiderVisual.draw(painter, time);

    // --- частицы и прицел --------------------------------------------------
    this.particles.update(deltaSeconds);
    this.particles.draw(painter);
    this.aimOverlay.render(
      painter,
      this.webController.preview,
      this.webController.isAiming,
      time,
      this.spiderVisual.getSpinneretWorld(),
    );

    // --- передний план ------------------------------------------------------
    // Идёт после героини и своей матрицей: он обгоняет мир и должен её
    // перекрывать, иначе никакой глубины не получится.
    if (this.worldRenderer.hasForeground) {
      const scroll = WorldRenderer.foregroundScroll;
      this.camera.applyTo(painter.ctx, ratio, scroll);
      this.worldRenderer.drawForeground(painter, this.camera.viewFor(scroll, this.foregroundView));
      this.camera.applyTo(painter.ctx, ratio, 1);
    }

    this.debugOverlay.drawWorld(painter, {
      spider: this.spider,
      state: this.stateMachine.current,
      web: this.web,
      level: this.level,
      physics: this.physics,
      timeScale: this.smoothedTimeScale,
      particles: this.particles.count,
    });

    // --- экранный слой -----------------------------------------------------
    this.surface.resetTransform();
    const velocity = this.spider.velocity;
    const speed = length(velocity);
    this.hud.setAmbience(
      speed,
      speed > 1 ? velocity.x / speed : 1,
      speed > 1 ? velocity.y / speed : 0,
      getTheme(this.level.definition.theme).rain,
    );
    this.hud.update(deltaSeconds);
    this.hud.draw(painter);
    this.debugOverlay.drawScreen(painter);
  }

  /**
   * Компактный срез состояния для панели диагностики.
   *
   * Панель включается в настройках и работает без клавиатуры — на телефоне
   * отладочные F1–F10 недоступны, а понять, доходит ли ввод до героя и
   * двигается ли тело, нужно именно там.
   */
  private buildDiagnostics(): string {
    const input = this.inputSystem.frame;
    const contact = this.spider.contact;
    const velocity = this.spider.velocity;
    const body = this.spiderBody;
    const round = (value: number) => Math.round(value);

    return [
      `build ${__BUILD_ID__}`,
      `fps ${round(this.getFps())}  acc ${this.accumulatorMs.toFixed(1)}  run ${this.running}`,
      `input src ${input.source}  move ${input.moveX.toFixed(2)},${input.moveY.toFixed(2)}  jump ${input.jumpHeld ? 1 : 0}  web ${input.webHeld ? 1 : 0}`,
      `stick ${this.inputSystem.touch.stick.active ? 'on' : 'off'} ${this.inputSystem.touch.stick.valueX.toFixed(2)},${this.inputSystem.touch.stick.valueY.toFixed(2)}`,
      `pos ${round(body.position.x)},${round(body.position.y)}  vel ${round(velocity.x)},${round(velocity.y)}`,
      `bodies ${this.physics.bodies.length}  contacts ${this.physics.contactCount}`,
      `state ${this.stateMachine.current}  att ${this.spider.attached}  ctrl ${this.spider.canControl}`,
      `surf ${contact?.surfaceId ?? '—'}  n ${contact ? `${contact.normal.x.toFixed(2)},${contact.normal.y.toFixed(2)}` : '—'}`,
      `respawn ${this.respawnPhase}  prot ${round(this.inputProtectionMs)}  ts ${this.smoothedTimeScale.toFixed(2)}`,
    ].join('\n');
  }

  private currentMood(): SpiderMood {
    const state = this.stateMachine.current;
    if (state === 'Stunned' || state === 'DeadOrLost') return 'hurt';
    if (this.webController.activeTension > 0.85) return 'strained';
    if (!this.spider.attached && this.spider.velocity.y > 620) return 'scared';
    if (this.webController.isAiming) return 'focused';
    if (this.completed) return 'happy';
    return 'calm';
  }

  private lookDirection(): Vector2 {
    if (this.webController.preview.active && this.webController.preview.target) {
      const target = this.webController.preview.target;
      const position = this.spider.position;
      return { x: target.x - position.x, y: target.y - position.y };
    }
    const velocity = this.spider.velocity;
    if (length(velocity) > 30) return velocity;
    return { x: this.spider.facing, y: 0 };
  }

  private updateAudioMix(): void {
    const speed = length(this.spider.velocity);
    const intensity = clamp(
      speed / 620 + this.webController.activeTension * 0.5 + this.web.getLoad() * 0.3,
      0,
      1,
    );
    audio.setIntensity(intensity);
  }

  // ---------------------------------------------------------------- доступ

  get webLoad(): number {
    return this.web.getLoad();
  }

  get cutAvailable(): boolean {
    return this.webController.hasCuttableStrand();
  }

  get aiming(): boolean {
    return this.webController.isAiming;
  }

  get tethered(): boolean {
    return this.webController.isTethered;
  }

  /** Можно ли закрепить свободный конец нити прямо сейчас. */
  get anchorable(): boolean {
    return (
      this.webController.isTethered &&
      this.spider.attached &&
      (this.spider.contact?.material.webAttachable ?? false)
    );
  }

  get runStats(): RunStats {
    return this.stats;
  }

  // Доступ для браузерных тестов: они проверяют физику и головоломку через
  // те же объекты, с которыми работает игра, а не через отдельный макет.

  get spiderPositionForTest(): Vector2 {
    return this.spider.position;
  }

  get diagnosticsForTest(): string {
    return this.buildDiagnostics();
  }

  get levelForTest(): LoadedLevel {
    return this.level;
  }

  get webForTest(): WebSystem {
    return this.web;
  }

  /** Центр и масштаб камеры — по ним измеряется плавность хода. */
  get cameraStateForTest(): { x: number; y: number; zoom: number } {
    return { x: this.camera.centerX, y: this.camera.centerY, zoom: this.camera.zoom };
  }

  /** Состояние раскачивания: длина нити, скорость, натяжение. */
  get tetherStateForTest(): {
    tethered: boolean;
    length: number;
    speed: number;
    x: number;
    y: number;
  } {
    const velocity = this.spider.velocity;
    return {
      tethered: this.webController.isTethered,
      length: +this.webController.tetherLength.toFixed(1),
      speed: +length(velocity).toFixed(1),
      x: +this.spider.position.x.toFixed(1),
      y: +this.spider.position.y.toFixed(1),
    };
  }

  cameraSnapForTest(position: Vector2): void {
    this.cameraController.snapTo(position);
  }

  /** Ставит героя на поверхность с заданной нормалью. */
  testPlace(position: Vector2, normal: Vector2): void {
    this.spider.teleport(position, normal);
    this.stateMachine.request('SurfaceIdle', { force: true });
    this.cameraController.snapTo(position);
  }

  /** Роняет героя с заданной точки — проверка позы в полёте. */
  testDrop(position: Vector2): void {
    this.spider.teleport(position, { x: 0, y: -1 });
    this.spider.detachFromSurface(400);
    this.cameraController.snapTo(position);
  }

  get orientationForTest(): { angle: number; facing: number } {
    return { angle: this.spider.visualAngle, facing: this.spider.facing };
  }

  get aimForTest(): {
    moveX: number;
    aimX: number;
    aimY: number;
    strength: number;
    aiming: boolean;
    previewValid: boolean;
    previewTarget: { x: number; y: number } | null;
  } {
    const frame = this.inputSystem.frame;
    const preview = this.webController.preview;
    return {
      moveX: +frame.moveX.toFixed(2),
      aimX: +frame.aimX.toFixed(2),
      aimY: +frame.aimY.toFixed(2),
      strength: +frame.aimStrength.toFixed(2),
      aiming: this.webController.isAiming,
      previewValid: preview.valid,
      previewTarget: preview.target
        ? { x: Math.round(preview.target.x), y: Math.round(preview.target.y) }
        : null,
    };
  }

  /** Положения стоп относительно тела — по ним измеряется дрожание позы. */
  get legOffsetsForTest(): { x: number; y: number }[] {
    return this.spiderVisual.footOffsets(this.spider.position);
  }

  /** Ставит героя в воздух и цепляет нить к якорю — проверка раскачивания. */
  testTether(anchorId: string, from: Vector2, velocity: Vector2): boolean {
    const anchor = this.level.anchors.find((a) => a.id === anchorId);
    if (!anchor) return false;
    this.spider.teleport(from, { x: 0, y: -1 });
    this.spider.detachFromSurface(0);
    this.spider.setVelocity(velocity);
    return this.webController.testAttachToAnchor(anchor);
  }

  /** Отладочная команда: создать несколько тестовых нитей. */
  spawnTestStrands(count: number): void {
    const origin = this.spider.position;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const radius = 120 + (i % 5) * 40;
      const target = {
        x: origin.x + Math.cos(angle) * radius,
        y: origin.y + Math.sin(angle) * radius,
      };
      this.web.createStrand({
        start: { type: 'world', point: origin, surfaceId: 'debug' },
        end: { type: 'world', point: target, surfaceId: 'debug' },
        playerCreated: true,
      });
    }
  }

  clearWeb(): void {
    this.web.clearPlayerWeb();
  }
}

const emptyStats = (): RunStats => ({
  timeMs: 0,
  falls: 0,
  strandsCreated: 0,
  strandsBroken: 0,
  peakStrands: 0,
  jumps: 0,
  swingTimeMs: 0,
  bloomsCollected: 0,
  bloomsTotal: 0,
});

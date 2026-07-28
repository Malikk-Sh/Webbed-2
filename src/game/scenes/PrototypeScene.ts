import Phaser from 'phaser';
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
import { audio } from '../audio/AudioEngine';
import { CameraController } from '../camera/CameraController';
import { MatterLib } from '../physics/MatterLib';
import type { InputSystem } from '../input/InputSystem';
import levelData from '../../content/levels/prototype-room.json';
import type { LevelDefinition } from '../level/LevelSchema';
import { loadLevel, type LoadedLevel } from '../level/PrototypeLevelLoader';
import type { RigidBodySnapshot } from '../objects/LevelObjects';
import { BackgroundRenderer } from '../render/BackgroundRenderer';
import { ObjectRenderer } from '../render/ObjectRenderer';
import { ParticleField } from '../render/ParticleField';
import { createRuntimeTextures } from '../render/TextureFactory';
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

const DEPTH = {
  background: -1000,
  worldBack: -100,
  objects: 0,
  webBack: 40,
  spider: 60,
  particles: 90,
  aim: 120,
} as const;

interface CheckpointState {
  checkpointId: string;
  position: Vector2;
  normal: Vector2;
  crates: Record<string, RigidBodySnapshot>;
  weights: Record<string, RigidBodySnapshot>;
}

/**
 * Основная игровая сцена.
 *
 * Здесь собирается порядок кадра из раздела 6.2 ТЗ: ввод → герой → шаг Matter →
 * крепления паутины → решатель → триггеры → камера → отрисовка. Симуляция
 * идёт фиксированным шагом 1/60 с ограничением накопления, поэтому просадка
 * кадров замедляет картинку, но не меняет физику.
 */
export class PrototypeScene extends Phaser.Scene {
  private inputSystem!: InputSystem;
  private hud!: PrototypeHud;

  private level!: LoadedLevel;
  private web!: WebSystem;
  private spider!: SpiderController;
  private webController!: SpiderWebController;
  private stateMachine = new SpiderStateMachine();

  private cameraController!: CameraController;
  private background!: BackgroundRenderer;
  private worldRenderer!: WorldRenderer;
  private objectRenderer!: ObjectRenderer;
  private webRenderer!: WebRenderer;
  private spiderVisual!: SpiderVisual;
  private particles!: ParticleField;
  private aimOverlay!: AimOverlay;
  private debugOverlay!: DebugOverlay;

  private spiderBody!: MatterJS.BodyType;
  private accumulatorMs = 0;
  private simulatedTimeMs = 0;
  private running = false;
  private completed = false;

  private checkpoint: CheckpointState | null = null;
  private activatedTriggers = new Set<string>();
  private respawnPhase: 'none' | 'out' | 'restore' | 'in' = 'none';
  private respawnTimerMs = 0;
  private inputProtectionMs = 0;

  private stats: RunStats = {
    timeMs: 0,
    falls: 0,
    strandsCreated: 0,
    strandsBroken: 0,
    peakStrands: 0,
    jumps: 0,
    swingTimeMs: 0,
  };

  private timeScale = 1;
  private smoothedTimeScale = 1;
  private onComplete: (stats: RunStats) => void = () => {};
  private onPauseRequested: () => void = () => {};
  private disposers: (() => void)[] = [];

  constructor() {
    super({ key: 'PrototypeScene', active: false });
  }

  configure(options: {
    input: InputSystem;
    hud: PrototypeHud;
    onComplete: (stats: RunStats) => void;
    onPauseRequested: () => void;
  }): void {
    this.inputSystem = options.input;
    this.hud = options.hud;
    this.onComplete = options.onComplete;
    this.onPauseRequested = options.onPauseRequested;
  }

  create(): void {
    createRuntimeTextures(this.textures);

    this.matter.world.setGravity(0, PHYSICS.gravity / 1000, PHYSICS.matterGravityScale);
    // Свой аккумулятор: Phaser не даёт гарантий по числу шагов за кадр,
    // а физике паутины нужен ровный 1/60 и ограничение догоняющих шагов.
    this.matter.world.autoUpdate = false;

    this.level = loadLevel(levelData as unknown as LevelDefinition, this.matter.world);

    this.spiderBody = MatterLib.Bodies.circle(0, 0, spiderBodyConfig.radius, {
      friction: spiderBodyConfig.friction,
      frictionAir: spiderBodyConfig.frictionAir,
      restitution: spiderBodyConfig.restitution,
      label: 'spider',
      inertia: Infinity,
      // Персонажем управляет игрок, и заснуть он не вправе никогда. Порог
      // задан на самом теле, чтобы гарантия пережила любые изменения
      // общей настройки засыпания в конфигурации мира.
      sleepThreshold: Infinity,
    });
    MatterLib.Body.setMass(this.spiderBody, spiderBodyConfig.mass);
    MatterLib.Composite.add(this.matter.world.localWorld, this.spiderBody);

    this.spider = new SpiderController({
      body: this.spiderBody,
      world: this.level.collision,
      state: this.stateMachine,
    });

    this.web = new WebSystem(
      this.level.collision,
      {
        getBody: (bodyId) => this.findBody(bodyId),
        applyForce: (bodyId, point, force) => {
          const body = this.findBody(bodyId);
          if (body) MatterLib.Body.applyForce(body as MatterJS.BodyType, point, force);
        },
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

    this.background = new BackgroundRenderer(this, this.level.definition, DEPTH.background);
    this.worldRenderer = new WorldRenderer(this, this.level, DEPTH.worldBack);
    this.objectRenderer = new ObjectRenderer(this, this.level, DEPTH.objects);
    this.webRenderer = new WebRenderer(this, this.web, DEPTH.webBack);
    this.spiderVisual = new SpiderVisual(this, this.spider, this.level.collision, DEPTH.spider);
    this.particles = new ParticleField(this, DEPTH.particles);
    this.aimOverlay = new AimOverlay(this, DEPTH.aim);
    this.debugOverlay = new DebugOverlay(this, DEPTH.aim + 10);

    this.cameraController = new CameraController(
      this.cameras.main,
      this.level.definition.cameraBounds,
    );
    this.cameras.main.setBackgroundColor(PALETTE.skyTop);

    this.bindEvents();
    this.applyQuality();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.handleResize();

    this.hud.setDiagnosticsSource(() => this.buildDiagnostics());

    this.restartRoom();
    this.hud.showTitle(this.level.definition.title);

    // Доступ к сцене из консоли разработчика и из браузерных тестов.
    (window as unknown as { silkboundScene?: PrototypeScene }).silkboundScene = this;
  }

  shutdown(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.background.destroy();
    this.worldRenderer.destroy();
    this.objectRenderer.destroy();
    this.webRenderer.destroy();
    this.spiderVisual.destroy();
    this.particles.destroy();
    this.aimOverlay.destroy();
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

      events.on('spider:step', ({ speed }) => audio.playStep(speed)),

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

  private findBody(bodyId: number): MatterJS.BodyType | null {
    for (const crate of this.level.crates) if (crate.body.id === bodyId) return crate.body;
    for (const weight of this.level.weights) if (weight.body.id === bodyId) return weight.body;
    return null;
  }

  private attachableBodies(): MatterJS.BodyType[] {
    const bodies: MatterJS.BodyType[] = [];
    for (const crate of this.level.crates) bodies.push(crate.body);
    for (const weight of this.level.weights) bodies.push(weight.body);
    return bodies;
  }

  private applyQuality(): void {
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
    this.webRenderer.setQuality(profile.webGlowPasses, profile.dewDrops, settings.highContrastWeb);
    this.spiderVisual.setQuality(profile.proceduralLegs);
    this.particles.setBudget(particleBudget);
    this.cameraController.setShakeEnabled(settings.cameraShake);
  }

  private handleResize(): void {
    this.cameraController.resize(this.scale.width, this.scale.height);
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
    this.web.reset();
    this.webController.reset();
    this.particles.clear();
    this.activatedTriggers.clear();
    this.completed = false;
    this.stats = {
      timeMs: 0,
      falls: 0,
      strandsCreated: 0,
      strandsBroken: 0,
      peakStrands: 0,
      jumps: 0,
      swingTimeMs: 0,
    };

    for (const crate of this.level.crates) crate.restore();
    for (const weight of this.level.weights) weight.restore();
    for (const plate of this.level.plates) plate.reset();
    for (const door of this.level.doors) door.reset();

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

    this.createScriptedWeb();
    this.placeAtCheckpoint();
    this.cameraController.snapTo(this.spider.position);
    events.emit('spider:respawned', { checkpointId: checkpoint.checkpointId });
  }

  // -------------------------------------------------------------- игровой цикл

  override update(time: number, delta: number): void {
    const frameDelta = Math.min(delta, 100);

    if (!this.running) {
      this.renderVisuals(frameDelta / 1000, time);
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
      this.simulatedTimeMs += PHYSICS.fixedDeltaMs;
      steps++;
    }

    if (!this.completed) this.stats.timeMs += frameDelta;
    if (this.webController.isTethered) this.stats.swingTimeMs += frameDelta;
    this.stats.peakStrands = Math.max(this.stats.peakStrands, this.web.peakStrandCount);

    this.updateRespawn(frameDelta);
    this.updateCamera(frameDelta / 1000, input);
    this.renderVisuals(frameDelta / 1000, time);
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

    // 2. Шаг Matter: столкновения тел и переноска ящиков.
    // Именно `step`, а не `update`: последний уважает `autoUpdate` и при
    // выключенном автообновлении молча ничего не делает.
    this.matter.world.step(PHYSICS.fixedDeltaMs);

    // 3. Паутина: крепления, решатель, натяжение, разрывы.
    this.web.fixedUpdate(deltaSeconds);

    // 4. Активная нить героя: маятник и подтягивание.
    this.webController.fixedUpdate(deltaSeconds, effectiveInput);

    // 5. Механизмы уровня.
    const bodies = MatterLib.Composite.allBodies(
      this.matter.world.localWorld,
    ) as MatterJS.BodyType[];
    for (const plate of this.level.plates) plate.fixedUpdate(deltaSeconds, bodies);
    for (const door of this.level.doors) {
      const plate = this.level.plates.find((p) => p.id === door.controlledBy);
      door.fixedUpdate(deltaSeconds, plate?.isActive() ?? false);
    }

    // 6. Триггеры комнаты.
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
    this.time.delayedCall(900, () => this.onComplete(this.stats));
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

  private renderVisuals(deltaSeconds: number, time: number): void {
    const camera = this.cameras.main;
    this.background.update(deltaSeconds, time, camera);
    this.worldRenderer.update(deltaSeconds, time, camera);
    this.worldRenderer.renderAnchors(time);
    this.objectRenderer.update(time);
    this.webRenderer.render(time, camera.worldView);
    this.webRenderer.pruneCache();

    this.spiderVisual.setMood(this.currentMood());
    this.spiderVisual.lookAt(this.lookDirection());
    this.spiderVisual.update(deltaSeconds, time);

    this.particles.update(deltaSeconds);
    this.aimOverlay.render(
      this.webController.preview,
      this.webController.isAiming,
      time,
      this.spiderVisual.getSpinneretWorld(),
    );
    this.debugOverlay.render(this, {
      spider: this.spider,
      state: this.stateMachine.current,
      web: this.web,
      level: this.level,
      timeScale: this.smoothedTimeScale,
      particles: this.particles.count,
    });
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
      `fps ${round(this.game.loop.actualFps)}  dt ${this.game.loop.delta.toFixed(1)}ms  acc ${this.accumulatorMs.toFixed(1)}  run ${this.running}`,
      `input src ${input.source}  move ${input.moveX.toFixed(2)},${input.moveY.toFixed(2)}  jump ${input.jumpHeld ? 1 : 0}  web ${input.webHeld ? 1 : 0}`,
      `stick ${this.inputSystem.touch.stick.active ? 'on' : 'off'} ${this.inputSystem.touch.stick.valueX.toFixed(2)},${this.inputSystem.touch.stick.valueY.toFixed(2)}`,
      `pos ${round(body.position.x)},${round(body.position.y)}  vel ${round(velocity.x)},${round(velocity.y)}`,
      `body.v ${body.velocity.x.toFixed(2)},${body.velocity.y.toFixed(2)}  sleep ${body.isSleeping}  static ${body.isStatic}`,
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

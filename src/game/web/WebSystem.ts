import { webConfig } from '../../app/GameConfig';
import { events } from '../../core/events/EventBus';
import { clamp } from '../../core/math/Interpolation';
import { distance, type Vector2 } from '../../core/math/Vector2';
import { closestPointOnSegment } from '../../core/math/Geometry';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { WebGraph } from './WebGraph';
import { WebSolver } from './WebSolver';
import type {
  CreateStrandRequest,
  CreateStrandResult,
  SavedWebGraph,
  WebAttachmentTarget,
  WebNode,
  WebRuntimeStats,
  WebStrand,
} from './WebTypes';

/** Оборванный конец нити: короткая живая лента, растворяющаяся за 1,5 с. */
export interface SeveredRibbon {
  points: { x: number; y: number; px: number; py: number }[];
  ageMs: number;
  lifetimeMs: number;
}

/**
 * Минимум, который паутине нужен от твёрдого тела. Интерфейс намеренно уже
 * реального `RigidBody`: тесты подставляют сюда простую заглушку.
 */
export interface WebAttachableBody {
  readonly position: Vector2;
  readonly mass: number;
  toWorld(local: Vector2): Vector2;
  velocityAt(world: Vector2): Vector2;
}

export interface WebBodyProvider {
  getBody(bodyId: number): WebAttachableBody | null;
  applyForce(bodyId: number, worldPoint: Vector2, force: Vector2): void;
}

export interface SpiderAnchorProvider {
  getSpiderPosition(): Vector2;
}

/**
 * Владелец всей паутины комнаты: граф, решатель, крепления к твёрдым телам,
 * лимиты, разрывы и сериализация.
 */
export class WebSystem {
  readonly graph = new WebGraph();
  readonly solver: WebSolver;
  readonly severed: SeveredRibbon[] = [];

  /** Нить, за которую сейчас держится Люма. Ей владеет SpiderWebController. */
  activeStrandId: number | null = null;

  private stats: WebRuntimeStats = {
    strands: 0,
    playerStrands: 0,
    particles: 0,
    nodes: 0,
    sleepingStrands: 0,
    maxTension: 0,
    solveMs: 0,
  };

  private spiderNodeId: number | null = null;
  private totalCreated = 0;
  private totalBroken = 0;
  private peakStrands = 0;

  constructor(
    private readonly collision: CollisionWorld,
    private readonly bodies: WebBodyProvider,
    private readonly spider: SpiderAnchorProvider,
  ) {
    this.solver = new WebSolver(this.graph, this.collision);
  }

  get createdCount(): number {
    return this.totalCreated;
  }

  get brokenCount(): number {
    return this.totalBroken;
  }

  get peakStrandCount(): number {
    return this.peakStrands;
  }

  // ------------------------------------------------------------ создание

  createStrand(request: CreateStrandRequest): CreateStrandResult {
    const playerStrands = this.graph.countPlayerStrands();
    if (request.playerCreated && playerStrands >= webConfig.maxPlayerStrands) {
      events.emit('web:limit-reached', {
        count: playerStrands,
        max: webConfig.maxPlayerStrands,
      });
      return { ok: false, reason: 'limit-reached' };
    }

    const startNode = this.resolveTarget(request.start);
    const endNode = this.resolveTarget(request.end);
    if (!startNode || !endNode) return { ok: false, reason: 'invalid-target' };
    if (startNode.id === endNode.id) return { ok: false, reason: 'too-short' };

    const span = distance(startNode.position, endNode.position);
    if (span < webConfig.minimumStrandLength) {
      this.pruneOrphan(startNode);
      this.pruneOrphan(endNode);
      return { ok: false, reason: 'too-short' };
    }

    // Дубликат между теми же узлами создавать бессмысленно — он лишь
    // удваивает нагрузку решателя, ничего не меняя визуально.
    for (const strandId of startNode.connectedStrandIds) {
      const existing = this.graph.getStrand(strandId);
      if (!existing) continue;
      if (existing.nodeAId === endNode.id || existing.nodeBId === endNode.id) {
        this.pruneOrphan(startNode);
        this.pruneOrphan(endNode);
        return { ok: false, reason: 'duplicate' };
      }
    }

    const restLength = request.requestedRestLength ?? span;
    const segments = Math.max(
      1,
      Math.min(24, Math.round(restLength / webConfig.particleSpacing)),
    );

    const particleIds: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const position = {
        x: startNode.position.x + (endNode.position.x - startNode.position.x) * t,
        y: startNode.position.y + (endNode.position.y - startNode.position.y) * t,
      };
      const isEndpoint = i === 0 || i === segments;
      const particle = this.graph.createParticle(position, isEndpoint ? 0 : 1, isEndpoint);
      particleIds.push(particle.id);
    }

    const strand: WebStrand = {
      id: this.graph.allocateStrandId(),
      nodeAId: startNode.id,
      nodeBId: endNode.id,
      restLength,
      currentLength: span,
      stiffness: webConfig.stiffness,
      damping: webConfig.damping,
      breakStretchRatio: webConfig.breakStretchRatio,
      breakDelayMs: webConfig.breakDelayMs,
      overloadTimeMs: 0,
      particleIds,
      tensionNormalized: 0,
      previousTension: 0,
      sleeping: false,
      sleepTimerMs: 0,
      sleepAnchor: undefined,
      active: true,
      playerCreated: request.playerCreated,
      scripted: request.scripted ?? false,
      cuttable: request.cuttable ?? request.playerCreated,
      pulsePosition: 0,
      pulseEnergy: 0,
      ageMs: 0,
      frequency: 0,
    };

    this.graph.addStrand(strand);
    this.totalCreated++;
    this.peakStrands = Math.max(this.peakStrands, this.graph.strandCount);

    events.emit('web:created', {
      strandId: strand.id,
      length: restLength,
      playerCreated: request.playerCreated,
      position: { ...endNode.position },
    });

    return { ok: true, strandId: strand.id, startNodeId: startNode.id, endNodeId: endNode.id };
  }

  private pruneOrphan(node: WebNode): void {
    if (node.connectedStrandIds.length === 0 && node.type !== 'spider-anchor' && !node.anchorId) {
      this.graph.removeNode(node.id);
    }
  }

  private resolveTarget(target: WebAttachmentTarget): WebNode | null {
    switch (target.type) {
      case 'existing-node':
        return this.graph.getNode(target.nodeId) ?? null;

      case 'spider': {
        const position = this.spider.getSpiderPosition();
        if (this.spiderNodeId !== null) {
          const existing = this.graph.getNode(this.spiderNodeId);
          if (existing) {
            existing.position.x = position.x;
            existing.position.y = position.y;
            return existing;
          }
        }
        const node = this.graph.createNode('spider-anchor', position, true);
        this.spiderNodeId = node.id;
        return node;
      }

      case 'body': {
        const body = this.bodies.getBody(target.bodyId);
        if (!body) return null;
        const world = body.toWorld(target.localOffset);
        const node = this.graph.createNode('body-anchor', world, true);
        node.bodyId = target.bodyId;
        node.localOffset = { ...target.localOffset };
        return node;
      }

      case 'world': {
        // Крепление на уже существующем якоре уровня переиспользует его узел,
        // чтобы несколько нитей действительно сходились в одной точке.
        if (target.anchorId) {
          for (const node of this.graph.allNodes) {
            if (node.anchorId === target.anchorId) return node;
          }
        }
        const node = this.graph.createNode('world-anchor', target.point, true);
        if (target.anchorId) node.anchorId = target.anchorId;
        return node;
      }
    }
  }

  // -------------------------------------------------------------- удаление

  removeStrand(strandId: number, cause: 'tension' | 'cut' | 'cleanup' = 'cleanup'): void {
    const strand = this.graph.getStrand(strandId);
    if (!strand) return;

    const midpoint = this.strandMidpoint(strand);
    if (cause !== 'cleanup' || strand.playerCreated) this.spawnSeveredRibbons(strand);

    this.graph.removeStrand(strandId);
    if (this.activeStrandId === strandId) this.activeStrandId = null;
    if (cause !== 'cleanup') this.totalBroken++;

    events.emit('web:broken', { strandId, position: midpoint, cause });
  }

  /** Разрезает ближайшую к точке нить. Возвращает её ID. */
  cutNearestStrand(position: Vector2, radius: number = webConfig.cutRadius): number | null {
    const found = this.findNearestStrand(position, radius, true);
    if (found === null) return null;
    this.removeStrand(found, 'cut');
    return found;
  }

  /**
   * Ближайшая нить к точке.
   *
   * `cuttableOnly` оставляет нити игрока и те сюжетные, которые комната сама
   * объявила частью задачи: подвес груза резать можно, декоративную растяжку —
   * нет.
   */
  findNearestStrand(position: Vector2, radius: number, cuttableOnly: boolean): number | null {
    let bestId: number | null = null;
    let bestDist = radius;

    for (const strand of this.graph.allStrands) {
      if (cuttableOnly && !strand.cuttable) continue;
      const ids = strand.particleIds;
      for (let i = 0; i < ids.length - 1; i++) {
        const a = this.graph.getParticle(ids[i]!);
        const b = this.graph.getParticle(ids[i + 1]!);
        if (!a || !b) continue;
        const closest = closestPointOnSegment(a.position, b.position, position);
        const dist = distance(closest, position);
        if (dist < bestDist) {
          bestDist = dist;
          bestId = strand.id;
        }
      }
    }
    return bestId;
  }

  clearPlayerWeb(): void {
    const ids: number[] = [];
    for (const strand of this.graph.allStrands) {
      if (strand.playerCreated) ids.push(strand.id);
    }
    for (const id of ids) this.graph.removeStrand(id);
    this.activeStrandId = null;
    events.emit('web:cleared', {});
  }

  reset(): void {
    this.graph.clear();
    this.severed.length = 0;
    this.activeStrandId = null;
    this.spiderNodeId = null;
  }

  // ------------------------------------------------------------- симуляция

  fixedUpdate(deltaSeconds: number): void {
    this.syncPinnedNodes();
    this.syncEndpointParticles();

    const broken = this.solver.step(deltaSeconds, webConfig.solverIterations);
    for (const strandId of broken) {
      const strand = this.graph.getStrand(strandId);
      if (strand) {
        events.emit('web:tension-critical', {
          strandId,
          position: this.strandMidpoint(strand),
        });
      }
      this.removeStrand(strandId, 'tension');
    }

    this.applyBodyForces(deltaSeconds);
    this.updateSevered(deltaSeconds);
    this.updateStats();
  }

  /** Позиции закреплённых узлов задаются извне: телами и паучихой. */
  private syncPinnedNodes(): void {
    for (const node of this.graph.allNodes) {
      node.previousPosition.x = node.position.x;
      node.previousPosition.y = node.position.y;

      if (node.type === 'body-anchor' && node.bodyId !== undefined && node.localOffset) {
        const body = this.bodies.getBody(node.bodyId);
        if (body) {
          const world = body.toWorld(node.localOffset);
          node.position.x = world.x;
          node.position.y = world.y;
        }
      } else if (node.type === 'spider-anchor') {
        const position = this.spider.getSpiderPosition();
        node.position.x = position.x;
        node.position.y = position.y;
      }
    }
  }

  private syncEndpointParticles(): void {
    for (const strand of this.graph.allStrands) {
      const ids = strand.particleIds;
      if (ids.length < 2) continue;
      const nodeA = this.graph.getNode(strand.nodeAId);
      const nodeB = this.graph.getNode(strand.nodeBId);
      const first = this.graph.getParticle(ids[0]!);
      const last = this.graph.getParticle(ids[ids.length - 1]!);
      if (nodeA && first) {
        first.previousPosition.x = first.position.x;
        first.previousPosition.y = first.position.y;
        first.position.x = nodeA.position.x;
        first.position.y = nodeA.position.y;
      }
      if (nodeB && last) {
        last.previousPosition.x = last.position.x;
        last.previousPosition.y = last.position.y;
        last.position.x = nodeB.position.x;
        last.position.y = nodeB.position.y;
      }
    }
  }

  /**
   * Передача нагрузки твёрдым телам (раздел 20.2 ТЗ).
   *
   * Нить моделируется как односторонняя пружина с демпфером: она тянет, но
   * никогда не толкает. Суммарная сила на тело ограничивается — без этого
   * ошибка решателя на один кадр разгоняет лёгкий ящик до нефизичных скоростей.
   */
  private applyBodyForces(deltaSeconds: number): void {
    if (deltaSeconds <= 0) return;
    const accumulated = new Map<number, { fx: number; fy: number; px: number; py: number; n: number }>();

    for (const strand of this.graph.allStrands) {
      if (!strand.active) continue;
      const nodeA = this.graph.getNode(strand.nodeAId);
      const nodeB = this.graph.getNode(strand.nodeBId);
      if (!nodeA || !nodeB) continue;

      const stretch = strand.currentLength - strand.restLength;
      if (stretch <= 0) continue;

      const dx = nodeB.position.x - nodeA.position.x;
      const dy = nodeB.position.y - nodeA.position.y;
      const len = strand.currentLength;
      if (len < 1e-6) continue;
      const nx = dx / len;
      const ny = dy / len;

      for (const [node, sign] of [
        [nodeA, 1],
        [nodeB, -1],
      ] as const) {
        if (node.type !== 'body-anchor' || node.bodyId === undefined) continue;
        const body = this.bodies.getBody(node.bodyId);
        if (!body) continue;

        const other = node === nodeA ? nodeB : nodeA;
        const velocity = body.velocityAt(node.position);
        const otherVelX = (other.position.x - other.previousPosition.x) * 60;
        const otherVelY = (other.position.y - other.previousPosition.y) * 60;

        // Скорость удлинения нити: положительная — концы расходятся.
        // Демпфируется только эта составляющая, поперечное качание груза
        // остаётся свободным. Множитель `-sign` приводит обе стороны нити
        // к одному знаку: n направлен от A к B, а тянет нить оба конца внутрь.
        const separationRate =
          -sign * ((velocity.x - otherVelX) * nx + (velocity.y - otherVelY) * ny);

        const magnitudeAlongStrand =
          stretch * webConfig.bodyAttachStiffness + separationRate * webConfig.bodyAttachDamping;

        let fx = sign * nx * magnitudeAlongStrand;
        let fy = sign * ny * magnitudeAlongStrand;

        const magnitude = Math.hypot(fx, fy);
        if (magnitude > webConfig.maximumAttachmentForce) {
          const s = webConfig.maximumAttachmentForce / magnitude;
          fx *= s;
          fy *= s;
        }

        const entry = accumulated.get(node.bodyId) ?? {
          fx: 0,
          fy: 0,
          px: 0,
          py: 0,
          n: 0,
        };
        entry.fx += fx;
        entry.fy += fy;
        entry.px += node.position.x;
        entry.py += node.position.y;
        entry.n += 1;
        accumulated.set(node.bodyId, entry);
      }
    }

    for (const [bodyId, entry] of accumulated) {
      const body = this.bodies.getBody(bodyId);
      if (!body) continue;
      // Общий импульс на тело ограничивается по ускорению: тяжёлый груз
      // получает мягкий отклик, а не рывок.
      const maxTotal = webConfig.maximumAttachmentForce * 1.6;
      let { fx, fy } = entry;
      const magnitude = Math.hypot(fx, fy);
      if (magnitude > maxTotal) {
        const s = maxTotal / magnitude;
        fx *= s;
        fy *= s;
      }
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
        console.warn('[WebSystem] NaN в силе крепления, нити тела удалены', bodyId);
        this.removeBodyStrands(bodyId);
        continue;
      }
      const point = { x: entry.px / entry.n, y: entry.py / entry.n };
      this.bodies.applyForce(bodyId, point, { x: fx, y: fy });
    }
  }

  private removeBodyStrands(bodyId: number): void {
    const ids: number[] = [];
    for (const node of this.graph.allNodes) {
      if (node.bodyId === bodyId) {
        for (const strandId of node.connectedStrandIds) ids.push(strandId);
      }
    }
    for (const id of ids) this.removeStrand(id, 'cleanup');
  }

  // ------------------------------------------------------ оборванные концы

  private spawnSeveredRibbons(strand: WebStrand): void {
    if (this.severed.length > 14) this.severed.shift();

    // Нить рвётся у сегмента с наибольшей ошибкой длины (раздел 23.3).
    const ids = strand.particleIds;
    if (ids.length < 3) return;
    const target = strand.restLength / (ids.length - 1);
    let worstIndex = Math.floor((ids.length - 1) / 2);
    let worstError = -Infinity;
    for (let i = 0; i < ids.length - 1; i++) {
      const a = this.graph.getParticle(ids[i]!);
      const b = this.graph.getParticle(ids[i + 1]!);
      if (!a || !b) continue;
      const error = distance(a.position, b.position) - target;
      if (error > worstError) {
        worstError = error;
        worstIndex = i;
      }
    }

    const collect = (from: number, to: number) => {
      const points: SeveredRibbon['points'] = [];
      const step = from <= to ? 1 : -1;
      for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
        const particle = this.graph.getParticle(ids[i]!);
        if (!particle) continue;
        points.push({
          x: particle.position.x,
          y: particle.position.y,
          px: particle.previousPosition.x,
          py: particle.previousPosition.y,
        });
      }
      if (points.length >= 2) {
        this.severed.push({ points, ageMs: 0, lifetimeMs: webConfig.freeEndLifetimeMs });
      }
    };

    collect(0, worstIndex);
    collect(ids.length - 1, worstIndex + 1);
  }

  private updateSevered(deltaSeconds: number): void {
    const dt2 = deltaSeconds * deltaSeconds;
    const gravity = webConfig.gravityScale * 1750 * 1.4;

    for (let i = this.severed.length - 1; i >= 0; i--) {
      const ribbon = this.severed[i]!;
      ribbon.ageMs += deltaSeconds * 1000;
      if (ribbon.ageMs >= ribbon.lifetimeMs) {
        this.severed.splice(i, 1);
        continue;
      }

      // Первая точка остаётся на месте — она и была креплением.
      for (let p = 1; p < ribbon.points.length; p++) {
        const point = ribbon.points[p]!;
        const vx = (point.x - point.px) * 0.965;
        const vy = (point.y - point.py) * 0.965;
        point.px = point.x;
        point.py = point.y;
        point.x += vx;
        point.y += vy + gravity * dt2;
      }

      const rest = 20;
      for (let iteration = 0; iteration < 3; iteration++) {
        for (let p = 0; p < ribbon.points.length - 1; p++) {
          const a = ribbon.points[p]!;
          const b = ribbon.points[p + 1]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 1;
          const error = (dist - rest) / dist;
          const shift = p === 0 ? 1 : 0.5;
          if (p !== 0) {
            a.x += dx * error * 0.5;
            a.y += dy * error * 0.5;
          }
          b.x -= dx * error * shift;
          b.y -= dy * error * shift;
        }
      }
    }
  }

  // ----------------------------------------------------------------- прочее

  strandMidpoint(strand: WebStrand): Vector2 {
    const nodeA = this.graph.getNode(strand.nodeAId);
    const nodeB = this.graph.getNode(strand.nodeBId);
    if (!nodeA || !nodeB) return { x: 0, y: 0 };
    return {
      x: (nodeA.position.x + nodeB.position.x) / 2,
      y: (nodeA.position.y + nodeB.position.y) / 2,
    };
  }

  /** Щипок: отправляет по нити световой импульс и звуковую ноту. */
  pluck(strandId: number, amplitude = 1): void {
    const strand = this.graph.getStrand(strandId);
    if (!strand) return;
    strand.sleeping = false;
    strand.sleepTimerMs = 0;
    strand.pulseEnergy = Math.min(1.4, strand.pulseEnergy + amplitude);
    strand.pulsePosition = 0;

    // Простая струнная модель: частота растёт с натяжением и падает с длиной.
    const base = 196;
    const frequency =
      base * Math.sqrt(0.35 + strand.tensionNormalized * 1.8) * (260 / Math.max(strand.restLength, 60));
    // Нижняя граница поднята до 140 Гц: ниже нота всё равно не звучит,
    // а на динамике превращается в гул.
    strand.frequency = clamp(frequency, 140, 1400);

    events.emit('web:pluck', {
      strandId,
      frequency: strand.frequency,
      amplitude: clamp(amplitude, 0, 1),
      position: this.strandMidpoint(strand),
    });
  }

  private updateStats(): void {
    let sleeping = 0;
    let maxTension = 0;
    let playerStrands = 0;
    for (const strand of this.graph.allStrands) {
      if (strand.sleeping) sleeping++;
      if (strand.playerCreated) playerStrands++;
      if (strand.tensionNormalized > maxTension) maxTension = strand.tensionNormalized;
    }
    this.stats = {
      strands: this.graph.strandCount,
      playerStrands,
      particles: this.graph.particleCount,
      nodes: this.graph.nodeCount,
      sleepingStrands: sleeping,
      maxTension,
      solveMs: this.solver.lastSolveMs,
    };
    this.peakStrands = Math.max(this.peakStrands, this.graph.strandCount);
  }

  getStats(): WebRuntimeStats {
    return this.stats;
  }

  /** Доля использованного бюджета сети — для индикатора в HUD. */
  getLoad(): number {
    return clamp(this.graph.countPlayerStrands() / webConfig.maxPlayerStrands, 0, 1);
  }

  // ------------------------------------------------------- сериализация

  serialize(): SavedWebGraph {
    const nodes = [];
    for (const node of this.graph.allNodes) {
      nodes.push({
        id: node.id,
        type: node.type,
        x: node.position.x,
        y: node.position.y,
        pinned: node.pinned,
        ...(node.bodyId !== undefined ? { bodyId: node.bodyId } : {}),
        ...(node.localOffset ? { localOffset: { ...node.localOffset } } : {}),
        ...(node.anchorId ? { anchorId: node.anchorId } : {}),
      });
    }
    const strands = [];
    for (const strand of this.graph.allStrands) {
      strands.push({
        id: strand.id,
        a: strand.nodeAId,
        b: strand.nodeBId,
        restLength: strand.restLength,
        playerCreated: strand.playerCreated,
        scripted: strand.scripted,
        cuttable: strand.cuttable,
      });
    }
    return { version: 1, nodes, strands };
  }

  restore(data: SavedWebGraph): void {
    this.reset();
    const nodeMap = new Map<number, number>();

    for (const saved of data.nodes) {
      const node = this.graph.createNode(saved.type, { x: saved.x, y: saved.y }, saved.pinned);
      if (saved.bodyId !== undefined) node.bodyId = saved.bodyId;
      if (saved.localOffset) node.localOffset = { ...saved.localOffset };
      if (saved.anchorId) node.anchorId = saved.anchorId;
      if (saved.type === 'spider-anchor') this.spiderNodeId = node.id;
      nodeMap.set(saved.id, node.id);
    }

    for (const saved of data.strands) {
      const a = nodeMap.get(saved.a);
      const b = nodeMap.get(saved.b);
      if (a === undefined || b === undefined) continue;
      // Промежуточные частицы создаются заново — их состояние не сохраняется.
      this.createStrand({
        start: { type: 'existing-node', nodeId: a },
        end: { type: 'existing-node', nodeId: b },
        requestedRestLength: saved.restLength,
        playerCreated: saved.playerCreated,
        scripted: saved.scripted,
        cuttable: saved.cuttable,
      });
    }
  }
}

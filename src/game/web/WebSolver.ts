import { webConfig } from '../../app/GameConfig';
import { clamp } from '../../core/math/Interpolation';
import type { CollisionWorld } from '../physics/CollisionWorld';
import type { WebGraph } from './WebGraph';
import type { WebStrand } from './WebTypes';

/**
 * Решатель паутины: стабилизированный Verlet с проекционными ограничениями
 * длины (позиционная схема в духе XPBD).
 *
 * Позиционный решатель выбран вместо пружин на силах по трём причинам:
 * он не взрывается при большой жёсткости, у него предсказуемое число итераций
 * (а значит и предсказуемый бюджет кадра), и растяжение нити ограничивается
 * явно — именно то, что нужно системе натяжения и разрыва.
 */
export class WebSolver {
  /** Время последнего шага решателя в мс — для отладочной панели. */
  lastSolveMs = 0;

  constructor(
    private readonly graph: WebGraph,
    private readonly collision: CollisionWorld,
  ) {}

  /** Полный шаг симуляции. Возвращает список нитей, подлежащих разрыву. */
  step(deltaSeconds: number, iterations: number): number[] {
    const started = performance.now();

    this.integrate(deltaSeconds);

    for (let i = 0; i < iterations; i++) {
      this.solveDistanceConstraints();
      // Столкновения решаются в середине прохода: если делать их последними,
      // финальная коррекция длины снова вгоняет частицы в геометрию.
      if (i === Math.floor(iterations / 2)) this.solveCollisions();
    }

    const broken = this.updateTension(deltaSeconds * 1000);

    this.lastSolveMs = performance.now() - started;
    return broken;
  }

  private integrate(deltaSeconds: number): void {
    const gravity = webConfig.gravityScale * 1750;
    const damping = 1 - webConfig.damping;
    const dt2 = deltaSeconds * deltaSeconds;

    for (const particle of this.graph.allParticles) {
      if (particle.pinned || particle.sleeping) {
        particle.previousPosition.x = particle.position.x;
        particle.previousPosition.y = particle.position.y;
        particle.acceleration.x = 0;
        particle.acceleration.y = 0;
        continue;
      }

      const vx = (particle.position.x - particle.previousPosition.x) * damping;
      const vy = (particle.position.y - particle.previousPosition.y) * damping;

      const ax = particle.acceleration.x;
      const ay = particle.acceleration.y + gravity;

      particle.previousPosition.x = particle.position.x;
      particle.previousPosition.y = particle.position.y;
      particle.position.x += vx + ax * dt2;
      particle.position.y += vy + ay * dt2;

      particle.acceleration.x = 0;
      particle.acceleration.y = 0;
    }
  }

  private solveDistanceConstraints(): void {
    for (const strand of this.graph.allStrands) {
      if (strand.sleeping || !strand.active) continue;
      const ids = strand.particleIds;
      const segments = ids.length - 1;
      if (segments < 1) continue;

      const target = strand.restLength / segments;
      // Жёсткость управляет долей исправляемой ошибки за итерацию: 1.0 —
      // абсолютно нерастяжимая нить, меньшие значения дают живую упругость.
      const stiffness = strand.stiffness;

      for (let i = 0; i < segments; i++) {
        const a = this.graph.getParticle(ids[i]!);
        const b = this.graph.getParticle(ids[i + 1]!);
        if (!a || !b) continue;

        const invA = a.pinned ? 0 : a.inverseMass;
        const invB = b.pinned ? 0 : b.inverseMass;
        const invSum = invA + invB;
        if (invSum <= 0) continue;

        const dx = b.position.x - a.position.x;
        const dy = b.position.y - a.position.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < 1e-12) continue;

        const dist = Math.sqrt(distSq);
        const error = (dist - target) * stiffness;
        const scale = error / (dist * invSum);
        const cx = dx * scale;
        const cy = dy * scale;

        if (invA > 0) {
          a.position.x += cx * invA;
          a.position.y += cy * invA;
        }
        if (invB > 0) {
          b.position.x -= cx * invB;
          b.position.y -= cy * invB;
        }
      }
    }
  }

  private solveCollisions(): void {
    const radius = webConfig.segmentRadius;
    for (const particle of this.graph.allParticles) {
      if (particle.pinned || particle.sleeping) continue;
      this.collision.resolvePoint(particle.position, radius);
    }
  }

  /**
   * Пересчёт натяжения, накопление перегрузки и решение о разрыве
   * (разделы 17 и 23 ТЗ).
   */
  private updateTension(deltaMs: number): number[] {
    const broken: number[] = [];

    for (const strand of this.graph.allStrands) {
      if (!strand.active) continue;

      const nodeA = this.graph.getNode(strand.nodeAId);
      const nodeB = this.graph.getNode(strand.nodeBId);
      if (!nodeA || !nodeB) continue;

      const dx = nodeB.position.x - nodeA.position.x;
      const dy = nodeB.position.y - nodeA.position.y;
      strand.currentLength = Math.sqrt(dx * dx + dy * dy);

      const stretchRatio = strand.restLength > 1e-6 ? strand.currentLength / strand.restLength : 1;
      strand.previousTension = strand.tensionNormalized;
      strand.tensionNormalized = clamp(
        (stretchRatio - 1) / (strand.breakStretchRatio - 1),
        0,
        1,
      );

      if (stretchRatio >= strand.breakStretchRatio) {
        strand.overloadTimeMs += deltaMs;
      } else {
        // Разгрузка идёт вдвое быстрее накопления: короткий рывок нить
        // переживает, а долгая перегрузка — нет.
        strand.overloadTimeMs = Math.max(0, strand.overloadTimeMs - deltaMs * 2);
      }

      if (strand.overloadTimeMs >= strand.breakDelayMs) {
        broken.push(strand.id);
        continue;
      }

      this.updateSleep(strand, deltaMs);
      this.updatePulse(strand, deltaMs);
      strand.ageMs += deltaMs;
    }

    return broken;
  }

  private updateSleep(strand: WebStrand, deltaMs: number): void {
    const nodeA = this.graph.getNode(strand.nodeAId);
    const nodeB = this.graph.getNode(strand.nodeBId);
    // Нить, привязанная к пауку или к подвижному телу, не засыпает никогда:
    // её крепление двигают снаружи, и решатель обязан это отработать.
    if (
      nodeA?.type === 'spider-anchor' ||
      nodeB?.type === 'spider-anchor' ||
      nodeA?.type === 'body-anchor' ||
      nodeB?.type === 'body-anchor'
    ) {
      strand.sleeping = false;
      strand.sleepTimerMs = 0;
      return;
    }

    // Критерий сна — «форма не менялась заданное время», а не мгновенная
    // скорость. Туго натянутая нить в позиционном решателе бесконечно долго
    // несёт затухающую стоячую волну: её мгновенная скорость периодически
    // проскакивает любой разумный порог, хотя нить визуально неподвижна.
    // Поэтому смещение считается от опорного снимка средней частицы.
    const midIndex = strand.particleIds[Math.floor(strand.particleIds.length / 2)];
    const mid = midIndex !== undefined ? this.graph.getParticle(midIndex) : undefined;
    if (!mid) return;

    if (strand.sleepAnchor === undefined) {
      strand.sleepAnchor = { x: mid.position.x, y: mid.position.y };
    }

    const drift = Math.hypot(
      mid.position.x - strand.sleepAnchor.x,
      mid.position.y - strand.sleepAnchor.y,
    );
    const tensionDelta = Math.abs(strand.tensionNormalized - strand.previousTension);

    const calm =
      drift < webConfig.sleepDriftThreshold &&
      tensionDelta < webConfig.sleepTensionDeltaThreshold &&
      strand.pulseEnergy < 0.02;

    if (calm) {
      strand.sleepTimerMs += deltaMs;
      if (strand.sleepTimerMs >= webConfig.sleepDelayMs) this.setStrandSleeping(strand, true);
    } else {
      strand.sleepTimerMs = 0;
      this.setStrandSleeping(strand, false);
      strand.sleepAnchor.x = mid.position.x;
      strand.sleepAnchor.y = mid.position.y;
    }
  }

  /**
   * Усыпление обязано затрагивать и частицы.
   *
   * Решатель пропускает спящую нить в ограничениях длины, поэтому если
   * частицы продолжат интегрироваться, гравитация утащит их вниз без всякого
   * противодействия — нить провиснет и тут же проснётся. Флаги обязаны идти
   * парой.
   */
  private setStrandSleeping(strand: WebStrand, sleeping: boolean): void {
    if (strand.sleeping === sleeping) return;
    strand.sleeping = sleeping;
    for (const id of strand.particleIds) {
      const particle = this.graph.getParticle(id);
      if (particle && !particle.pinned) particle.sleeping = sleeping;
    }
  }

  /** Бегущий импульс по нити: визуальный и звуковой отклик на щипок. */
  private updatePulse(strand: WebStrand, deltaMs: number): void {
    if (strand.pulseEnergy <= 0.001) {
      strand.pulseEnergy = 0;
      return;
    }
    const speed = 900 / Math.max(strand.restLength, 1);
    strand.pulsePosition += speed * (deltaMs / 1000);
    if (strand.pulsePosition > 1) strand.pulsePosition -= 1;
    strand.pulseEnergy *= Math.exp(-deltaMs / 520);
  }

  /** Расталкивает спящие нити рядом с точкой — например, при приземлении. */
  wake(x: number, y: number, radius: number): void {
    const radiusSq = radius * radius;
    for (const strand of this.graph.allStrands) {
      if (!strand.sleeping) continue;
      const nodeA = this.graph.getNode(strand.nodeAId);
      const nodeB = this.graph.getNode(strand.nodeBId);
      if (!nodeA || !nodeB) continue;
      const midX = (nodeA.position.x + nodeB.position.x) / 2;
      const midY = (nodeA.position.y + nodeB.position.y) / 2;
      const dx = midX - x;
      const dy = midY - y;
      if (dx * dx + dy * dy > radiusSq + strand.currentLength * strand.currentLength) continue;
      strand.sleeping = false;
      strand.sleepTimerMs = 0;
      for (const id of strand.particleIds) {
        const particle = this.graph.getParticle(id);
        if (particle) particle.sleeping = false;
      }
    }
  }
}

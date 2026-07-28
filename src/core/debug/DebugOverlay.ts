import { PALETTE } from '../../app/Palette';
import type { Painter } from '../../engine/Painter';
import type { PhysicsWorld } from '../../engine/physics/PhysicsWorld';
import type { LoadedLevel } from '../../game/level/PrototypeLevelLoader';
import type { SpiderController } from '../../game/spider/SpiderController';
import type { WebSystem } from '../../game/web/WebSystem';

interface DebugContext {
  spider: SpiderController;
  state: string;
  web: WebSystem;
  level: LoadedLevel;
  physics: PhysicsWorld;
  timeScale: number;
  particles: number;
}

interface SceneCommands {
  spawnTestStrands(count: number): void;
  clearWeb(): void;
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * Отладочный слой из разделов 37–38 ТЗ.
 *
 * Панель и все переключатели живут в одном месте и полностью выключены по
 * умолчанию: ни одна отладочная отрисовка не должна стоить ничего, пока её
 * не включили клавишей.
 */
export class DebugOverlay {
  physicsPaused = false;

  private visible = false;
  private showColliders = false;
  private showNormals = false;
  private showParticles = false;
  private showTension = false;
  private stepRequested = false;

  private readonly keys = new Map<string, boolean>();
  private readonly frameTimes: number[] = [];
  private lastTime = performance.now();
  private lines: string[] = [];

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const handled = [
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10',
    ];
    if (!handled.includes(event.key)) return;
    event.preventDefault();
    this.keys.set(event.key, true);
  };

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
  }

  consumeStepRequest(): boolean {
    if (!this.stepRequested) return false;
    this.stepRequested = false;
    return true;
  }

  handleKeys(scene: SceneCommands): void {
    const take = (key: string): boolean => {
      if (!this.keys.get(key)) return false;
      this.keys.set(key, false);
      return true;
    };

    if (take('F1')) this.visible = !this.visible;
    if (take('F2')) this.showColliders = !this.showColliders;
    if (take('F3')) this.showNormals = !this.showNormals;
    if (take('F4')) this.showParticles = !this.showParticles;
    if (take('F5')) this.showTension = !this.showTension;
    if (take('F6')) this.physicsPaused = !this.physicsPaused;
    if (take('F7')) this.stepRequested = true;
    if (take('F8')) scene.spawnTestStrands(1);
    if (take('F9')) scene.spawnTestStrands(40);
    if (take('F10')) scene.clearWeb();
  }

  /** Мировой слой: коллайдеры, нормали, частицы, натяжение. */
  drawWorld(painter: Painter, context: DebugContext): void {
    const now = performance.now();
    this.frameTimes.push(now - this.lastTime);
    this.lastTime = now;
    if (this.frameTimes.length > 60) this.frameTimes.shift();

    if (!this.visible) return;

    if (this.showColliders) {
      painter.lineStyle(1.5, PALETTE.uiAccent, 0.7);
      for (const surface of context.level.collision.surfaces) {
        const points = surface.polygon.points;
        painter.beginPath();
        painter.moveTo(points[0]!.x, points[0]!.y);
        for (let i = 1; i < points.length; i++) painter.lineTo(points[i]!.x, points[i]!.y);
        painter.closePath();
        painter.strokePath();
      }
      // Тела решателя рисуются отдельным цветом: расхождение между ними и
      // поверхностями сразу видно глазом.
      painter.lineStyle(1.2, PALETTE.ok, 0.5);
      for (const body of context.physics.bodies) {
        if (body.shape.kind === 'circle') {
          painter.strokeCircle(body.position.x, body.position.y, body.shape.radius);
          continue;
        }
        const vertices = body.worldVertices;
        painter.beginPath();
        painter.moveTo(vertices[0]!.x, vertices[0]!.y);
        for (let i = 1; i < vertices.length; i++) painter.lineTo(vertices[i]!.x, vertices[i]!.y);
        painter.closePath();
        painter.strokePath();
      }
      painter.lineStyle(1.5, PALETTE.uiWarn, 0.8);
      painter.strokeCircle(context.spider.position.x, context.spider.position.y, 17);
    }

    if (this.showNormals) {
      const contact = context.spider.contact;
      if (contact) {
        painter.lineStyle(2, PALETTE.uiDanger, 0.9);
        painter.beginPath();
        painter.moveTo(contact.point.x, contact.point.y);
        painter.lineTo(
          contact.point.x + contact.normal.x * 40,
          contact.point.y + contact.normal.y * 40,
        );
        painter.strokePath();
        painter.lineStyle(2, PALETTE.ok, 0.9);
        painter.beginPath();
        painter.moveTo(contact.point.x, contact.point.y);
        painter.lineTo(
          contact.point.x + contact.tangent.x * 40,
          contact.point.y + contact.tangent.y * 40,
        );
        painter.strokePath();
      }
    }

    if (this.showParticles) {
      painter.fillStyle(PALETTE.uiWarn, 0.9);
      for (const particle of context.web.graph.allParticles) {
        painter.fillCircle(particle.position.x, particle.position.y, particle.pinned ? 2.6 : 1.6);
      }
    }

    if (this.showTension) {
      for (const strand of context.web.graph.allStrands) {
        const a = context.web.graph.getNode(strand.nodeAId);
        const b = context.web.graph.getNode(strand.nodeBId);
        if (!a || !b) continue;
        const t = strand.tensionNormalized;
        const color = t > 0.8 ? PALETTE.uiDanger : t > 0.5 ? PALETTE.uiWarn : PALETTE.ok;
        painter.lineStyle(3, color, 0.8);
        painter.beginPath();
        painter.moveTo(a.position.x, a.position.y);
        painter.lineTo(b.position.x, b.position.y);
        painter.strokePath();
      }
    }

    this.buildLines(context);
  }

  /** Экранный слой: текстовая панель. Рисуется без матрицы камеры. */
  drawScreen(painter: Painter): void {
    if (!this.visible || this.lines.length === 0) return;

    const size = 12;
    const lineHeight = size + 4;
    const padding = 8;

    painter.setFont(`${size}px ${MONO}`);
    painter.setTextAlign('left', 'top');

    let widest = 0;
    for (const line of this.lines) widest = Math.max(widest, painter.measureWidth(line));

    painter.fillStyle(0x04080c, 0.72);
    painter.fillRect(10, 10, widest + padding * 2, this.lines.length * lineHeight + padding * 2);
    painter.fillStyle(0x9ff5ff, 1);
    for (let i = 0; i < this.lines.length; i++) {
      painter.fillText(this.lines[i]!, 10 + padding, 10 + padding + i * lineHeight);
    }
  }

  private buildLines(context: DebugContext): void {
    const stats = context.web.getStats();
    const average =
      this.frameTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, this.frameTimes.length);
    const worst = Math.max(...this.frameTimes);
    const velocity = context.spider.velocity;
    const contact = context.spider.contact;

    this.lines = [
      'PERFORMANCE',
      `  fps ${(1000 / Math.max(average, 0.001)).toFixed(0)}  frame ${average.toFixed(1)}ms  1% low ${(1000 / Math.max(worst, 0.001)).toFixed(0)}`,
      `  web solver ${stats.solveMs.toFixed(2)}ms  particles(fx) ${context.particles}`,
      `  bodies ${context.physics.bodies.length}  contacts ${context.physics.contactCount}`,
      '',
      'SPIDER',
      `  state ${context.state}${this.physicsPaused ? '  [PHYSICS PAUSED]' : ''}`,
      `  pos ${context.spider.position.x.toFixed(0)}, ${context.spider.position.y.toFixed(0)}`,
      `  vel ${velocity.x.toFixed(0)}, ${velocity.y.toFixed(0)}  speed ${context.spider.speed.toFixed(0)}`,
      `  surface ${contact?.surfaceId ?? '—'}  material ${contact?.material.id ?? '—'}`,
      `  normal ${contact ? `${contact.normal.x.toFixed(2)}, ${contact.normal.y.toFixed(2)}` : '—'}`,
      `  attached ${context.spider.attached}  timeScale ${context.timeScale.toFixed(2)}`,
      '',
      'WEB',
      `  strands ${stats.strands} (player ${stats.playerStrands}/80)  sleeping ${stats.sleepingStrands}`,
      `  nodes ${stats.nodes}  particles ${stats.particles}  maxTension ${stats.maxTension.toFixed(2)}`,
      `  active ${context.web.activeStrandId ?? '—'}`,
      '',
      'LEVEL',
      `  plate ${context.level.plates.map((p) => `${p.id}:${p.active ? 'ON' : 'off'}(${p.currentMass.toFixed(2)})`).join(' ')}`,
      `  door ${context.level.doors.map((d) => `${d.id}:${d.state}`).join(' ')}`,
      '',
      'F1 panel · F2 colliders · F3 normals · F4 particles · F5 tension',
      'F6 pause · F7 step · F8/F9 strands · F10 clear',
    ];
  }
}

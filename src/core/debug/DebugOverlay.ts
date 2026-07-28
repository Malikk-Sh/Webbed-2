import Phaser from 'phaser';
import { PALETTE } from '../../app/Palette';
import type { LoadedLevel } from '../../game/level/PrototypeLevelLoader';
import { MatterLib } from '../../game/physics/MatterLib';
import type { SpiderController } from '../../game/spider/SpiderController';
import type { WebSystem } from '../../game/web/WebSystem';

interface DebugContext {
  spider: SpiderController;
  state: string;
  web: WebSystem;
  level: LoadedLevel;
  timeScale: number;
  particles: number;
}

interface SceneCommands {
  spawnTestStrands(count: number): void;
  clearWeb(): void;
}

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

  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly text: Phaser.GameObjects.Text;
  private readonly keys = new Map<string, boolean>();
  private frameTimes: number[] = [];
  private lastTime = performance.now();

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const handled = [
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10',
    ];
    if (!handled.includes(event.key)) return;
    event.preventDefault();
    this.keys.set(event.key, true);
  };

  constructor(scene: Phaser.Scene, depth: number) {
    this.graphics = scene.add.graphics().setDepth(depth).setVisible(false);
    this.text = scene.add
      .text(0, 0, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        color: '#9ff5ff',
        backgroundColor: 'rgba(4,8,12,0.72)',
        padding: { x: 8, y: 6 },
      })
      .setScrollFactor(0)
      .setDepth(depth + 1)
      .setVisible(false);

    window.addEventListener('keydown', this.onKeyDown);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.graphics.destroy();
    this.text.destroy();
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

    if (take('F1')) {
      this.visible = !this.visible;
      this.graphics.setVisible(this.visible);
      this.text.setVisible(this.visible);
    }
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

  render(scene: Phaser.Scene, context: DebugContext): void {
    const now = performance.now();
    const frameTime = now - this.lastTime;
    this.lastTime = now;
    this.frameTimes.push(frameTime);
    if (this.frameTimes.length > 60) this.frameTimes.shift();

    if (!this.visible) return;

    const g = this.graphics;
    g.clear();

    if (this.showColliders) {
      g.lineStyle(1.5, PALETTE.uiAccent, 0.7);
      for (const surface of context.level.collision.surfaces) {
        const points = surface.polygon.points;
        g.beginPath();
        g.moveTo(points[0]!.x, points[0]!.y);
        for (let i = 1; i < points.length; i++) g.lineTo(points[i]!.x, points[i]!.y);
        g.closePath();
        g.strokePath();
      }
      g.lineStyle(1.5, PALETTE.uiWarn, 0.8);
      g.strokeCircle(context.spider.position.x, context.spider.position.y, 17);
    }

    if (this.showNormals) {
      const contact = context.spider.contact;
      if (contact) {
        g.lineStyle(2, PALETTE.uiDanger, 0.9);
        g.beginPath();
        g.moveTo(contact.point.x, contact.point.y);
        g.lineTo(contact.point.x + contact.normal.x * 40, contact.point.y + contact.normal.y * 40);
        g.strokePath();
        g.lineStyle(2, PALETTE.ok, 0.9);
        g.beginPath();
        g.moveTo(contact.point.x, contact.point.y);
        g.lineTo(
          contact.point.x + contact.tangent.x * 40,
          contact.point.y + contact.tangent.y * 40,
        );
        g.strokePath();
      }
    }

    if (this.showParticles) {
      g.fillStyle(PALETTE.uiWarn, 0.9);
      for (const particle of context.web.graph.allParticles) {
        g.fillCircle(particle.position.x, particle.position.y, particle.pinned ? 2.6 : 1.6);
      }
    }

    if (this.showTension) {
      for (const strand of context.web.graph.allStrands) {
        const a = context.web.graph.getNode(strand.nodeAId);
        const b = context.web.graph.getNode(strand.nodeBId);
        if (!a || !b) continue;
        const t = strand.tensionNormalized;
        const color = t > 0.8 ? PALETTE.uiDanger : t > 0.5 ? PALETTE.uiWarn : PALETTE.ok;
        g.lineStyle(3, color, 0.8);
        g.beginPath();
        g.moveTo(a.position.x, a.position.y);
        g.lineTo(b.position.x, b.position.y);
        g.strokePath();
      }
    }

    const stats = context.web.getStats();
    const average =
      this.frameTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, this.frameTimes.length);
    const worst = Math.max(...this.frameTimes);
    const velocity = context.spider.velocity;
    const contact = context.spider.contact;

    this.text.setPosition(10, 10);
    this.text.setText(
      [
        'PERFORMANCE',
        `  fps ${(1000 / Math.max(average, 0.001)).toFixed(0)}  frame ${average.toFixed(1)}ms  1% low ${(1000 / Math.max(worst, 0.001)).toFixed(0)}`,
        `  web solver ${stats.solveMs.toFixed(2)}ms  particles(fx) ${context.particles}`,
        `  matter bodies ${MatterLib.Composite.allBodies(scene.matter.world.localWorld).length}`,
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
      ].join('\n'),
    );
  }
}

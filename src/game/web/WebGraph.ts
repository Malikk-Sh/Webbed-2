import type { Vector2 } from '../../core/math/Vector2';
import type { WebNode, WebNodeType, WebParticle, WebStrand } from './WebTypes';

/**
 * Граф паутины: узлы, нити и физические частицы между ними.
 *
 * Частицы живут в отдельном пуле и переиспользуются: за игру создаются и
 * рвутся сотни нитей, и постоянное выделение объектов в кадре быстро
 * превращается в заметные паузы сборщика мусора на мобильном устройстве.
 */
export class WebGraph {
  private readonly nodes = new Map<number, WebNode>();
  private readonly strands = new Map<number, WebStrand>();
  private readonly particles = new Map<number, WebParticle>();

  private readonly particlePool: WebParticle[] = [];

  private nextNodeId = 1;
  private nextStrandId = 1;
  private nextParticleId = 1;

  get nodeCount(): number {
    return this.nodes.size;
  }

  get strandCount(): number {
    return this.strands.size;
  }

  get particleCount(): number {
    return this.particles.size;
  }

  get allNodes(): IterableIterator<WebNode> {
    return this.nodes.values();
  }

  get allStrands(): IterableIterator<WebStrand> {
    return this.strands.values();
  }

  get allParticles(): IterableIterator<WebParticle> {
    return this.particles.values();
  }

  createNode(type: WebNodeType, position: Vector2, pinned: boolean): WebNode {
    const node: WebNode = {
      id: this.nextNodeId++,
      type,
      position: { x: position.x, y: position.y },
      previousPosition: { x: position.x, y: position.y },
      pinned,
      sleeping: false,
      connectedStrandIds: [],
    };
    this.nodes.set(node.id, node);
    return node;
  }

  addNode(node: WebNode): void {
    this.nodes.set(node.id, node);
    if (node.id >= this.nextNodeId) this.nextNodeId = node.id + 1;
  }

  getNode(id: number): WebNode | undefined {
    return this.nodes.get(id);
  }

  getStrand(id: number): WebStrand | undefined {
    return this.strands.get(id);
  }

  getParticle(id: number): WebParticle | undefined {
    return this.particles.get(id);
  }

  createParticle(position: Vector2, inverseMass: number, pinned: boolean): WebParticle {
    const recycled = this.particlePool.pop();
    const particle: WebParticle = recycled ?? {
      id: 0,
      position: { x: 0, y: 0 },
      previousPosition: { x: 0, y: 0 },
      acceleration: { x: 0, y: 0 },
      inverseMass: 1,
      pinned: false,
      sleeping: false,
    };
    particle.id = this.nextParticleId++;
    particle.position.x = position.x;
    particle.position.y = position.y;
    particle.previousPosition.x = position.x;
    particle.previousPosition.y = position.y;
    particle.acceleration.x = 0;
    particle.acceleration.y = 0;
    particle.inverseMass = inverseMass;
    particle.pinned = pinned;
    particle.sleeping = false;
    this.particles.set(particle.id, particle);
    return particle;
  }

  addStrand(strand: WebStrand): void {
    this.strands.set(strand.id, strand);
    if (strand.id >= this.nextStrandId) this.nextStrandId = strand.id + 1;
    this.getNode(strand.nodeAId)?.connectedStrandIds.push(strand.id);
    this.getNode(strand.nodeBId)?.connectedStrandIds.push(strand.id);
  }

  allocateStrandId(): number {
    return this.nextStrandId++;
  }

  /**
   * Удаляет нить, её частицы и осиротевшие узлы.
   * Узлы на явных якорях уровня сохраняются: они принадлежат комнате, а не нити.
   */
  removeStrand(strandId: number): WebStrand | null {
    const strand = this.strands.get(strandId);
    if (!strand) return null;

    for (const particleId of strand.particleIds) {
      const particle = this.particles.get(particleId);
      if (particle) {
        this.particles.delete(particleId);
        if (this.particlePool.length < 512) this.particlePool.push(particle);
      }
    }
    strand.particleIds.length = 0;
    this.strands.delete(strandId);

    for (const nodeId of [strand.nodeAId, strand.nodeBId]) {
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      const index = node.connectedStrandIds.indexOf(strandId);
      if (index >= 0) node.connectedStrandIds.splice(index, 1);
      if (node.connectedStrandIds.length === 0 && node.type !== 'spider-anchor' && !node.anchorId) {
        this.nodes.delete(nodeId);
      }
    }

    return strand;
  }

  removeNode(nodeId: number): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    for (const strandId of [...node.connectedStrandIds]) this.removeStrand(strandId);
    this.nodes.delete(nodeId);
  }

  getConnectedStrands(nodeId: number): WebStrand[] {
    const node = this.nodes.get(nodeId);
    if (!node) return [];
    const result: WebStrand[] = [];
    for (const id of node.connectedStrandIds) {
      const strand = this.strands.get(id);
      if (strand) result.push(strand);
    }
    return result;
  }

  /** Обход связной компоненты в ширину — нужен для засыпания и удаления сетей. */
  getConnectedComponent(nodeId: number): { nodeIds: number[]; strandIds: number[] } {
    const visitedNodes = new Set<number>();
    const visitedStrands = new Set<number>();
    const queue: number[] = [nodeId];
    visitedNodes.add(nodeId);

    while (queue.length > 0) {
      const current = queue.pop()!;
      const node = this.nodes.get(current);
      if (!node) continue;
      for (const strandId of node.connectedStrandIds) {
        if (visitedStrands.has(strandId)) continue;
        visitedStrands.add(strandId);
        const strand = this.strands.get(strandId);
        if (!strand) continue;
        const other = strand.nodeAId === current ? strand.nodeBId : strand.nodeAId;
        if (!visitedNodes.has(other)) {
          visitedNodes.add(other);
          queue.push(other);
        }
      }
    }

    return { nodeIds: [...visitedNodes], strandIds: [...visitedStrands] };
  }

  countPlayerStrands(): number {
    let count = 0;
    for (const strand of this.strands.values()) {
      if (strand.playerCreated) count++;
    }
    return count;
  }

  clear(): void {
    for (const particle of this.particles.values()) {
      if (this.particlePool.length < 512) this.particlePool.push(particle);
    }
    this.nodes.clear();
    this.strands.clear();
    this.particles.clear();
  }
}

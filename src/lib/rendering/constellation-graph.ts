import type { StarConnection } from "../interaction/types";

/** Construye una red local; los extremos siempre son índices de estrellas. */
export class ConstellationGraph {
  readonly connections: StarConnection[] = [];
  private readonly connectionKeys = new Set<string>();
  private readonly degrees: Uint8Array;
  private readonly nextParticle: Int32Array;
  private cellHeads = new Int32Array(0);
  private columns = 0;
  private rows = 0;
  private cellSize = 0;

  constructor(
    particleCapacity: number,
    private readonly maximumConnections: number,
    private readonly maximumDegree: number,
  ) {
    if (
      !Number.isInteger(particleCapacity) ||
      particleCapacity < 1 ||
      !Number.isInteger(maximumConnections) ||
      maximumConnections < 1 ||
      !Number.isInteger(maximumDegree) ||
      maximumDegree < 1
    ) {
      throw new Error("Constellation graph limits must be positive integers.");
    }
    this.degrees = new Uint8Array(particleCapacity);
    this.nextParticle = new Int32Array(particleCapacity);
  }

  get isAtCapacity() {
    return this.connections.length >= this.maximumConnections;
  }

  rebuildSpatialIndex(
    x: Float32Array,
    y: Float32Array,
    lifecycle: Uint8Array,
    particleCount: number,
    width: number,
    height: number,
    cellSize: number,
  ) {
    if (
      !Number.isFinite(cellSize) ||
      cellSize <= 0 ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error("Constellation spatial index requires finite positive dimensions.");
    }
    const columns = Math.max(1, Math.ceil(width / cellSize));
    const rows = Math.max(1, Math.ceil(height / cellSize));
    if (columns !== this.columns || rows !== this.rows) {
      this.columns = columns;
      this.rows = rows;
      this.cellHeads = new Int32Array(columns * rows);
    }
    this.cellSize = cellSize;
    this.cellHeads.fill(-1);
    for (let id = 0; id < particleCount; id += 1) {
      if (lifecycle[id] !== 0) {
        this.nextParticle[id] = -1;
        continue;
      }
      const column = Math.max(0, Math.min(columns - 1, Math.floor(x[id] / cellSize)));
      const row = Math.max(0, Math.min(rows - 1, Math.floor(y[id] / cellSize)));
      const cell = row * columns + column;
      this.nextParticle[id] = this.cellHeads[cell];
      this.cellHeads[cell] = id;
    }
  }

  /**
   * Selecciona estrellas activas cercanas y enlaza pocas vecinas locales.
   * Cada par conserva índices estables y nunca se regenera ni se recorta.
   */
  discover(
    centerX: number,
    centerY: number,
    radius: number,
    x: Float32Array,
    y: Float32Array,
    lifecycle: Uint8Array,
    particleCount: number,
    selectedCount: number,
    neighborsPerStar: number,
    minimumLength: number,
    maximumLength: number,
  ) {
    if (this.isAtCapacity) return 0;
    const radiusSquared = radius * radius;
    const candidateIds: number[] = [];
    const candidateDistances: number[] = [];
    const candidateLimit = Math.max(selectedCount + neighborsPerStar, 8);

    const consider = (id: number) => {
      if (lifecycle[id] !== 0) return;
      const dx = x[id] - centerX;
      const dy = y[id] - centerY;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > radiusSquared) return;
      let insertion = candidateDistances.findIndex((value) => distanceSquared < value);
      if (insertion === -1) insertion = candidateIds.length;
      if (insertion >= candidateLimit) return;
      candidateIds.splice(insertion, 0, id);
      candidateDistances.splice(insertion, 0, distanceSquared);
      if (candidateIds.length > candidateLimit) {
        candidateIds.pop();
        candidateDistances.pop();
      }
    };

    if (this.cellSize > 0) {
      const firstColumn = Math.max(0, Math.floor((centerX - radius) / this.cellSize));
      const lastColumn = Math.min(this.columns - 1, Math.floor((centerX + radius) / this.cellSize));
      const firstRow = Math.max(0, Math.floor((centerY - radius) / this.cellSize));
      const lastRow = Math.min(this.rows - 1, Math.floor((centerY + radius) / this.cellSize));
      for (let row = firstRow; row <= lastRow; row += 1) {
        for (let column = firstColumn; column <= lastColumn; column += 1) {
          for (
            let id = this.cellHeads[row * this.columns + column];
            id !== -1;
            id = this.nextParticle[id]
          ) {
            consider(id);
          }
        }
      }
    } else {
      for (let id = 0; id < particleCount; id += 1) consider(id);
    }

    let added = 0;
    const anchors = Math.min(selectedCount, candidateIds.length);
    for (let anchorIndex = 0; anchorIndex < anchors; anchorIndex += 1) {
      const anchorId = candidateIds[anchorIndex];
      let neighbors = 0;
      for (let candidateIndex = 0; candidateIndex < candidateIds.length; candidateIndex += 1) {
        const neighborId = candidateIds[candidateIndex];
        if (neighborId === anchorId) continue;
        const dx = x[neighborId] - x[anchorId];
        const dy = y[neighborId] - y[anchorId];
        const distanceSquared = dx * dx + dy * dy;
        if (
          distanceSquared < minimumLength * minimumLength ||
          distanceSquared > maximumLength * maximumLength
        ) continue;
        if (this.connect(anchorId, neighborId)) added += 1;
        if (this.degrees[anchorId] >= this.maximumDegree) break;
        neighbors += 1;
        if (neighbors >= neighborsPerStar) break;
      }
      if (this.isAtCapacity) break;
    }
    return added;
  }

  clear() {
    this.connections.length = 0;
    this.connectionKeys.clear();
    this.degrees.fill(0);
  }

  private connect(firstId: number, secondId: number) {
    if (
      firstId === secondId ||
      firstId < 0 ||
      secondId < 0 ||
      firstId >= this.degrees.length ||
      secondId >= this.degrees.length ||
      this.degrees[firstId] >= this.maximumDegree ||
      this.degrees[secondId] >= this.maximumDegree ||
      this.connections.length >= this.maximumConnections
    ) {
      return false;
    }
    const starAId = Math.min(firstId, secondId);
    const starBId = Math.max(firstId, secondId);
    const key = `${starAId}:${starBId}`;
    if (this.connectionKeys.has(key)) return false;
    this.connectionKeys.add(key);
    this.connections.push({ starAId, starBId });
    this.degrees[starAId] += 1;
    this.degrees[starBId] += 1;
    return true;
  }
}

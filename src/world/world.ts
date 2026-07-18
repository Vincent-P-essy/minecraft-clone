import { BlockId } from "./blocks";
import { Chunk } from "./chunk";
import { chunkKey, worldToChunk, worldToLocal } from "./coords";
import type { NeighborLookup } from "../render/mesher";
import { generateChunk } from "./terrain";

/** Owns every loaded chunk and answers block queries across chunk borders —
 * this is the NeighborLookup the mesher needs, and the source of truth for
 * gameplay code (physics, raycasting) that just wants "what's at (x, y, z)"
 * without caring which chunk that happens to fall in. */
export class World implements NeighborLookup {
  readonly seed: number;
  private readonly chunks = new Map<string, Chunk>();

  constructor(seed: number) {
    this.seed = seed;
  }

  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  setChunk(chunk: Chunk): void {
    this.chunks.set(chunkKey(chunk.cx, chunk.cz), chunk);
  }

  removeChunk(cx: number, cz: number): void {
    this.chunks.delete(chunkKey(cx, cz));
  }

  /** Chunk at (cx, cz), generating it synchronously and caching it if it
   * isn't loaded yet. Callers that stream chunks in via a worker (see
   * ChunkMeshManager) should prefer setChunk with an already-generated
   * chunk; this exists for gameplay code that needs an answer right now
   * (physics, raycasting) and would rather generate on demand than crash. */
  ensureChunk(cx: number, cz: number): Chunk {
    const existing = this.getChunk(cx, cz);
    if (existing) return existing;
    const chunk = generateChunk(cx, cz, this.seed);
    this.setChunk(chunk);
    return chunk;
  }

  getBlock(worldX: number, worldY: number, worldZ: number): BlockId {
    const cx = worldToChunk(worldX);
    const cz = worldToChunk(worldZ);
    const chunk = this.getChunk(cx, cz);
    if (!chunk) return BlockId.AIR; // ungenerated chunks read as air, not a crash
    return chunk.getBlock(worldToLocal(worldX), worldY, worldToLocal(worldZ));
  }

  setBlock(worldX: number, worldY: number, worldZ: number, id: BlockId): void {
    const cx = worldToChunk(worldX);
    const cz = worldToChunk(worldZ);
    const chunk = this.ensureChunk(cx, cz);
    chunk.setBlock(worldToLocal(worldX), worldY, worldToLocal(worldZ), id);
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  loadedChunkCoords(): { cx: number; cz: number }[] {
    return Array.from(this.chunks.values(), (c) => ({ cx: c.cx, cz: c.cz }));
  }
}

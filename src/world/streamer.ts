import { Chunk } from "./chunk";
import { type ChunkCoord, chunkKey, worldToChunk } from "./coords";
import type { EditStore } from "./edit-store";
import { generateChunk } from "./terrain";
import type { World } from "./world";

/** How generated chunk data comes back from wherever generation runs. */
export type ChunkReceiver = (cx: number, cz: number, buffer: Uint8Array) => void;

/** Something that generates chunks asynchronously (a Web Worker in the real
 * game, a synchronous fake in tests). Results arrive via the receiver given
 * at construction time. */
export interface ChunkGenerator {
  request(cx: number, cz: number): void;
  dispose(): void;
}

const MAX_REQUESTS_PER_UPDATE = 6;

export interface StreamerOptions {
  readonly radius: number;
  readonly editStore?: EditStore;
  readonly onUnload?: (cx: number, cz: number) => void;
}

/** Keeps the set of loaded chunks tracking the player: requests missing
 * chunks (nearest first) from the generator, applies the edit overlay when
 * they arrive, unloads chunks left behind, and queues every chunk whose
 * mesh went stale. Rendering is someone else's job — this class only says
 * *which* chunks are dirty; main drains that queue with a per-frame budget. */
export class ChunkStreamer {
  private readonly world: World;
  private readonly radius: number;
  private readonly editStore: EditStore | undefined;
  private readonly onUnload: ((cx: number, cz: number) => void) | undefined;
  private generator: ChunkGenerator | undefined;
  private readonly pending = new Set<string>();
  private readonly dirty: ChunkCoord[] = [];
  private readonly dirtyKeys = new Set<string>();

  constructor(world: World, options: StreamerOptions) {
    this.world = world;
    this.radius = options.radius;
    this.editStore = options.editStore;
    this.onUnload = options.onUnload;
  }

  /** The generator needs the streamer's receive() as its callback, so it's
   * attached after construction rather than passed in. */
  attachGenerator(generator: ChunkGenerator): void {
    this.generator = generator;
  }

  /** Synchronously generates (with edits applied) everything within `radius`
   * chunks of the spawn point, so the player never spawns over ungenerated
   * void. Used once at startup; everything after streams in async. */
  warmUp(worldX: number, worldZ: number, radius: number): void {
    const pcx = worldToChunk(worldX);
    const pcz = worldToChunk(worldZ);
    for (let cx = pcx - radius; cx <= pcx + radius; cx++) {
      for (let cz = pcz - radius; cz <= pcz + radius; cz++) {
        this.loadSync(cx, cz);
      }
    }
  }

  private loadSync(cx: number, cz: number): void {
    if (this.world.hasChunk(cx, cz)) return;
    const chunk = generateChunk(cx, cz, this.world.seed);
    this.editStore?.applyTo(chunk);
    this.world.setChunk(chunk);
    this.pending.delete(chunkKey(cx, cz));
    this.markDirtyWithNeighbors(cx, cz);
  }

  /** Called by the generator when a chunk's block data is ready. */
  receive(cx: number, cz: number, buffer: Uint8Array): void {
    this.pending.delete(chunkKey(cx, cz));
    if (this.world.hasChunk(cx, cz)) return; // e.g. loadSync raced ahead of the worker
    const chunk = new Chunk(cx, cz, buffer);
    this.editStore?.applyTo(chunk);
    this.world.setChunk(chunk);
    this.markDirtyWithNeighbors(cx, cz);
  }

  /** Once per frame: keep the loaded set centered on the player. */
  update(playerX: number, playerZ: number): void {
    const pcx = worldToChunk(playerX);
    const pcz = worldToChunk(playerZ);

    // The player's own chunk can never wait on the worker — physics needs it.
    this.loadSync(pcx, pcz);

    this.requestMissing(pcx, pcz);
    this.unloadFar(pcx, pcz);
  }

  private requestMissing(pcx: number, pcz: number): void {
    if (!this.generator) return;
    const missing: { cx: number; cz: number; d2: number }[] = [];
    for (let cx = pcx - this.radius; cx <= pcx + this.radius; cx++) {
      for (let cz = pcz - this.radius; cz <= pcz + this.radius; cz++) {
        const key = chunkKey(cx, cz);
        if (this.world.hasChunk(cx, cz) || this.pending.has(key)) continue;
        const dx = cx - pcx;
        const dz = cz - pcz;
        missing.push({ cx, cz, d2: dx * dx + dz * dz });
      }
    }
    missing.sort((a, b) => a.d2 - b.d2);
    for (const { cx, cz } of missing.slice(0, MAX_REQUESTS_PER_UPDATE)) {
      this.pending.add(chunkKey(cx, cz));
      this.generator.request(cx, cz);
    }
  }

  private unloadFar(pcx: number, pcz: number): void {
    // +1 of hysteresis so pacing back and forth over a border doesn't
    // load/unload the same ring every few steps.
    const dropBeyond = this.radius + 1;
    for (const { cx, cz } of this.world.loadedChunkCoords()) {
      if (Math.abs(cx - pcx) <= dropBeyond && Math.abs(cz - pcz) <= dropBeyond) continue;
      this.world.removeChunk(cx, cz);
      this.dirtyKeys.delete(chunkKey(cx, cz));
      this.onUnload?.(cx, cz);
    }
  }

  private markDirty(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (this.dirtyKeys.has(key)) return;
    this.dirtyKeys.add(key);
    this.dirty.push({ cx, cz });
  }

  /** A new chunk dirties itself and any already-loaded neighbor: the
   * neighbor's border faces were meshed against "air" while this chunk
   * didn't exist and may now be occluded (or newly exposed). */
  private markDirtyWithNeighbors(cx: number, cz: number): void {
    this.markDirty(cx, cz);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (this.world.hasChunk(cx + dx, cz + dz)) this.markDirty(cx + dx, cz + dz);
    }
  }

  /** Hands out up to `max` chunks needing a (re)mesh, nearest-queued first. */
  drainDirty(max: number): ChunkCoord[] {
    const out: ChunkCoord[] = [];
    while (out.length < max && this.dirty.length > 0) {
      const coord = this.dirty.shift();
      if (!coord) break;
      const key = chunkKey(coord.cx, coord.cz);
      if (!this.dirtyKeys.has(key)) continue; // unloaded while queued
      this.dirtyKeys.delete(key);
      if (!this.world.hasChunk(coord.cx, coord.cz)) continue;
      out.push(coord);
    }
    return out;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get dirtyCount(): number {
    return this.dirtyKeys.size;
  }
}

interface WorkerResult {
  cx: number;
  cz: number;
  buffer: Uint8Array;
}

/** Production ChunkGenerator: a module Web Worker running generateChunk off
 * the main thread, block buffers coming back as transferables (zero copy). */
export function createWorkerGenerator(seed: number, receive: ChunkReceiver): ChunkGenerator {
  const worker = new Worker(new URL("./generation-worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<WorkerResult>) => {
    const { cx, cz, buffer } = event.data;
    receive(cx, cz, buffer);
  };
  return {
    request(cx: number, cz: number): void {
      worker.postMessage({ cx, cz, seed });
    },
    dispose(): void {
      worker.terminate();
    },
  };
}

/** Test/fallback ChunkGenerator: generates immediately on the calling thread. */
export function createSyncGenerator(seed: number, receive: ChunkReceiver): ChunkGenerator {
  return {
    request(cx: number, cz: number): void {
      receive(cx, cz, generateChunk(cx, cz, seed).buffer);
    },
    dispose(): void {
      // nothing to clean up
    },
  };
}

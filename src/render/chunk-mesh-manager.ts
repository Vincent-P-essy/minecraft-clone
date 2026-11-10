import * as THREE from "three";
import { Chunk } from "../world/chunk";
import { CHUNK_SIZE, chunkKey } from "../world/coords";
import type { World } from "../world/world";
import type { MeshWorkerRequest, MeshWorkerResult } from "./mesh-worker";
import { type MeshData, meshChunk, quadCount } from "./mesher";
import { SHADOW_LAYER } from "./shadow-pass";

/** Every chunk draws with the same index pattern (two triangles per quad),
 * so one index buffer is shared by all of them instead of being rebuilt
 * and uploaded per chunk. */
const SHARED_QUADS = 16384; // 65536 vertices: the 16-bit index limit

function buildQuadIndices(quads: number): THREE.BufferAttribute {
  const wide = quads * 4 > 65536;
  const array = wide ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  for (let q = 0; q < quads; q++) {
    const v = q * 4;
    array.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
  }
  return new THREE.BufferAttribute(array, 1);
}

interface ChunkMeshes {
  opaque: THREE.Mesh | null;
  /** Cave interiors: same vertex buffer as `opaque`, a different range. */
  cave: THREE.Mesh | null;
  water: THREE.Mesh | null;
  cx: number;
  cz: number;
}

/** Cave interiors are only drawn this close to the player (in chunks).
 * Farther off they're unlit rock behind solid ground — 70% of a typical
 * chunk's triangles that nobody can see. */
const CAVE_DRAW_CHUNKS = 4.5;

interface Job {
  cx: number;
  cz: number;
  key: string;
  /** Edits jump the queue: the player is looking right at them. */
  urgent: boolean;
}

interface PoolWorker {
  worker: Worker;
  busy: number;
}

export interface ChunkMaterials {
  terrain: THREE.Material;
  water: THREE.Material;
}

/** Keeps the chunk meshes in sync with World's block data. Meshing itself
 * (mesher.ts) is pure and Three.js-free; the heavy part — lighting plus
 * the greedy pass — runs in a small pool of Web Workers so it never stalls
 * a frame, with a synchronous fallback where workers aren't available.
 * Requests are queued here and handed out nearest-first, so the ground
 * under the player always meshes before the horizon does. */
export class ChunkMeshManager {
  private readonly meshes = new Map<string, ChunkMeshes>();
  private readonly scene: THREE.Scene;
  private readonly world: World;
  private materials: ChunkMaterials;

  private readonly pool: PoolWorker[] = [];
  /** Per-chunk request generation, so meshes that finish after the chunk
   * was re-edited or unloaded are dropped instead of shown stale. */
  private readonly generation = new Map<string, number>();
  private readonly queue = new Map<string, Job>();
  private readonly index16 = buildQuadIndices(SHARED_QUADS);
  private index32: THREE.BufferAttribute | null = null;
  private focusX = 0;
  private focusZ = 0;
  private syncBudget = 0;

  constructor(scene: THREE.Scene, world: World, materials: ChunkMaterials, workerCount = 2) {
    this.scene = scene;
    this.world = world;
    this.materials = materials;

    try {
      if (typeof Worker !== "undefined") {
        for (let i = 0; i < workerCount; i++) {
          const worker = new Worker(new URL("./mesh-worker.ts", import.meta.url), {
            type: "module",
          });
          const entry: PoolWorker = { worker, busy: 0 };
          worker.onmessage = (e: MessageEvent<MeshWorkerResult>) => {
            entry.busy = Math.max(0, entry.busy - 1);
            this.onMeshResult(e.data);
            this.pump();
          };
          this.pool.push(entry);
        }
      }
    } catch {
      for (const entry of this.pool) entry.worker.terminate();
      this.pool.length = 0; // fall back to synchronous meshing
    }
  }

  private broadcast(message: MeshWorkerRequest): void {
    for (const entry of this.pool) entry.worker.postMessage(message);
  }

  /** A chunk's blocks became available: mirror them into every worker. */
  chunkLoaded(cx: number, cz: number): void {
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk) return;
    // Structured clone copies the buffer; the main thread keeps its own.
    this.broadcast({ type: "set", cx, cz, buffer: chunk.buffer });
  }

  /** One block changed: patch the workers' copies instead of resending
   * the whole chunk. */
  blockChanged(worldX: number, worldY: number, worldZ: number, id: number): void {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    const lx = worldX - cx * CHUNK_SIZE;
    const lz = worldZ - cz * CHUNK_SIZE;
    this.broadcast({ type: "edit", cx, cz, index: Chunk.index(lx, worldY, lz), id });
    // Light reaches up to 15 cells, so the edit can change the look of
    // every chunk in the 3x3 around it. The edited chunk goes first.
    this.updateChunk(cx, cz, true);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        if (this.meshes.has(chunkKey(cx + dx, cz + dz))) this.updateChunk(cx + dx, cz + dz);
      }
    }
  }

  /** Where "nearest first" is measured from (the player), in chunk units. */
  setFocus(worldX: number, worldZ: number): void {
    this.focusX = worldX / CHUNK_SIZE - 0.5;
    this.focusZ = worldZ / CHUNK_SIZE - 0.5;
    for (const entry of this.meshes.values()) {
      if (entry.cave) entry.cave.visible = this.caveVisible(entry.cx, entry.cz);
    }
  }

  /** (Re)builds the mesh for one loaded chunk. Safe to call again after a
   * block edit — the stale mesh stays up until the new one is ready. */
  updateChunk(cx: number, cz: number, urgent = false): void {
    if (!this.world.hasChunk(cx, cz)) {
      this.removeChunkMesh(cx, cz);
      return;
    }
    const key = chunkKey(cx, cz);
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    const queued = this.queue.get(key);
    if (queued) queued.urgent = queued.urgent || urgent;
    else this.queue.set(key, { cx, cz, key, urgent });
  }

  /** Hands queued work to idle workers. Call once per frame. */
  pump(): void {
    if (this.queue.size === 0) return;
    if (this.pool.length === 0) {
      // No workers: mesh a little each frame, nearest first.
      this.syncBudget = 1;
      while (this.syncBudget > 0 && this.queue.size > 0) {
        const job = this.takeNearest();
        if (!job) break;
        const chunk = this.world.getChunk(job.cx, job.cz);
        if (!chunk) continue;
        this.applyMesh(
          job.cx,
          job.cz,
          this.generation.get(job.key) ?? 0,
          meshChunk(chunk, this.world),
        );
        this.syncBudget--;
      }
      return;
    }
    for (const entry of this.pool) {
      // Two in flight per worker keeps it busy across the message hop
      // without burying it under work that can no longer be re-prioritized.
      while (entry.busy < 2 && this.queue.size > 0) {
        const job = this.takeNearest();
        if (!job) break;
        entry.busy++;
        entry.worker.postMessage({
          type: "mesh",
          cx: job.cx,
          cz: job.cz,
          id: this.generation.get(job.key) ?? 0,
        } satisfies MeshWorkerRequest);
      }
    }
  }

  private takeNearest(): Job | undefined {
    let best: Job | undefined;
    let bestScore = Infinity;
    for (const job of this.queue.values()) {
      const dx = job.cx - this.focusX;
      const dz = job.cz - this.focusZ;
      const score = (job.urgent ? -1e6 : 0) + dx * dx + dz * dz;
      if (score < bestScore) {
        bestScore = score;
        best = job;
      }
    }
    if (best) this.queue.delete(best.key);
    return best;
  }

  private onMeshResult(msg: MeshWorkerResult): void {
    const key = chunkKey(msg.cx, msg.cz);
    if (this.generation.get(key) !== msg.id) return; // superseded or unloaded
    if (!this.world.hasChunk(msg.cx, msg.cz)) return;
    this.applyMesh(msg.cx, msg.cz, msg.id, msg);
  }

  private indexFor(quads: number): THREE.BufferAttribute {
    if (quads <= SHARED_QUADS) return this.index16;
    if (!this.index32 || this.index32.count < quads * 6) {
      this.index32 = buildQuadIndices(Math.ceil(quads / 4096) * 4096);
    }
    return this.index32;
  }

  private buildMesh(
    attribute: THREE.BufferAttribute,
    firstQuad: number,
    quads: number,
    material: THREE.Material,
    cx: number,
    cz: number,
    minY: number,
    maxY: number,
  ): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("aData", attribute);
    geometry.setIndex(this.indexFor(firstQuad + quads));
    geometry.setDrawRange(firstQuad * 6, quads * 6);
    // Positions are packed, so Three.js can't derive bounds: state them.
    const half = CHUNK_SIZE / 2;
    const midY = (minY + maxY) / 2;
    const halfY = (maxY - minY) / 2 + 1;
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1, minY - 1, -1),
      new THREE.Vector3(CHUNK_SIZE + 1, maxY + 1, CHUNK_SIZE + 1),
    );
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(half, midY, half),
      Math.hypot(half + 1, halfY, half + 1),
    );

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    // Chunk meshes never move once placed — skip the per-frame matrix
    // recompute Three.js would otherwise do for every one of them.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  private applyMesh(cx: number, cz: number, gen: number, data: MeshData): void {
    const key = chunkKey(cx, cz);
    if (this.generation.get(key) !== gen) return;
    this.disposeMeshes(key);
    const entry: ChunkMeshes = { opaque: null, cave: null, water: null, cx, cz };
    const { minY, maxY } = data;
    const opaqueQuads = quadCount(data.opaque);
    if (opaqueQuads > 0) {
      const attribute = new THREE.BufferAttribute(data.opaque, 2);
      const surfaceQuads = Math.min(data.caveStart, opaqueQuads);
      if (surfaceQuads > 0) {
        entry.opaque = this.buildMesh(
          attribute,
          0,
          surfaceQuads,
          this.materials.terrain,
          cx,
          cz,
          minY,
          maxY,
        );
        entry.opaque.layers.enable(SHADOW_LAYER);
        this.scene.add(entry.opaque);
      }
      if (opaqueQuads > surfaceQuads) {
        entry.cave = this.buildMesh(
          attribute,
          surfaceQuads,
          opaqueQuads - surfaceQuads,
          this.materials.terrain,
          cx,
          cz,
          minY,
          maxY,
        );
        entry.cave.visible = this.caveVisible(cx, cz);
        this.scene.add(entry.cave);
      }
    }
    if (data.water.length > 0) {
      entry.water = this.buildMesh(
        new THREE.BufferAttribute(data.water, 2),
        0,
        quadCount(data.water),
        this.materials.water,
        cx,
        cz,
        minY,
        maxY,
      );
      // Water blends: draw it after the terrain, far chunks first.
      entry.water.renderOrder = 10;
      this.scene.add(entry.water);
    }
    if (entry.opaque || entry.cave || entry.water) this.meshes.set(key, entry);
  }

  private caveVisible(cx: number, cz: number): boolean {
    const dx = cx - this.focusX;
    const dz = cz - this.focusZ;
    return dx * dx + dz * dz <= CAVE_DRAW_CHUNKS * CAVE_DRAW_CHUNKS;
  }

  /** Swaps materials on every live mesh (after a quality change). */
  setMaterials(materials: ChunkMaterials): void {
    this.materials = materials;
    for (const entry of this.meshes.values()) {
      if (entry.opaque) entry.opaque.material = materials.terrain;
      if (entry.cave) entry.cave.material = materials.terrain;
      if (entry.water) entry.water.material = materials.water;
    }
  }

  removeChunkMesh(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    // Bump the generation so any in-flight mesh for this chunk is dropped.
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.queue.delete(key);
    this.disposeMeshes(key);
  }

  /** The chunk left the world entirely: forget it everywhere. */
  chunkUnloaded(cx: number, cz: number): void {
    this.removeChunkMesh(cx, cz);
    this.generation.delete(chunkKey(cx, cz));
    this.broadcast({ type: "remove", cx, cz });
  }

  private disposeOne(mesh: THREE.Mesh | null): void {
    if (!mesh) return;
    this.scene.remove(mesh);
    // The index buffer is shared — detach it so disposing this geometry
    // doesn't delete it out from under every other chunk.
    mesh.geometry.setIndex(null);
    mesh.geometry.dispose();
  }

  private disposeMeshes(key: string): void {
    const entry = this.meshes.get(key);
    if (!entry) return;
    this.disposeOne(entry.opaque);
    this.disposeOne(entry.cave);
    this.disposeOne(entry.water);
    this.meshes.delete(key);
  }

  get meshedChunkCount(): number {
    return this.meshes.size;
  }

  get queuedCount(): number {
    return this.queue.size;
  }

  /** Total quads on screen-capable meshes, for the debug HUD. */
  get quadTotal(): number {
    let total = 0;
    for (const entry of this.meshes.values()) {
      total += (entry.opaque?.geometry.drawRange.count ?? 0) / 6;
      if (entry.cave?.visible) total += entry.cave.geometry.drawRange.count / 6;
      total += (entry.water?.geometry.drawRange.count ?? 0) / 6;
    }
    return total;
  }

  dispose(): void {
    for (const key of [...this.meshes.keys()]) this.disposeMeshes(key);
    for (const entry of this.pool) entry.worker.terminate();
  }
}

import * as THREE from "three";
import { chunkKey } from "../world/coords";
import type { World } from "../world/world";
import { type MeshData, meshChunk } from "./mesher";

export { createChunkMaterial } from "./chunk-material";

interface MeshResult {
  type: "mesh";
  cx: number;
  cz: number;
  id: number;
  empty?: boolean;
  positions?: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  colors?: Float32Array;
  layers?: Float32Array;
  indices?: Uint32Array;
}

const NEIGHBOR_OFFSETS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function buildGeometry(data: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
  geometry.setAttribute("shadeColor", new THREE.BufferAttribute(data.colors, 3));
  geometry.setAttribute("layer", new THREE.BufferAttribute(data.layers, 1));
  // 16-bit indices halve the index buffer's size and upload cost; greedy
  // meshing keeps almost every chunk comfortably under the 65536-vertex
  // limit, so this is nearly always the path taken.
  const vertexCount = data.positions.length / 3;
  const index =
    vertexCount <= 65536
      ? new THREE.BufferAttribute(Uint16Array.from(data.indices), 1)
      : new THREE.BufferAttribute(data.indices, 1);
  geometry.setIndex(index);
  return geometry;
}

/** Keeps one Three.js Mesh per loaded chunk in sync with World's block
 * data. Meshing itself (mesher.ts) is pure and Three.js-free; the heavy
 * greedy pass runs in a Web Worker so it never stalls the frame, with a
 * synchronous fallback for environments without workers. */
export class ChunkMeshManager {
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly scene: THREE.Scene;
  private readonly world: World;
  private readonly material: THREE.Material;

  private readonly worker: Worker | null;
  /** Which chunk buffers the worker currently holds a copy of. */
  private readonly workerHas = new Set<string>();
  /** Per-chunk request generation, so meshes that finish after the chunk
   * was re-edited or unloaded are dropped instead of shown stale. */
  private readonly generation = new Map<string, number>();

  constructor(scene: THREE.Scene, world: World, material: THREE.Material) {
    this.scene = scene;
    this.world = world;
    this.material = material;

    let worker: Worker | null = null;
    try {
      if (typeof Worker !== "undefined") {
        worker = new Worker(new URL("./mesh-worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (e: MessageEvent<MeshResult>) => {
          this.onMeshResult(e.data);
        };
      }
    } catch {
      worker = null; // fall back to synchronous meshing
    }
    this.worker = worker;
  }

  /** (Re)builds and displays the mesh for one loaded chunk. Off-thread when
   * a worker is available; synchronous otherwise. Safe to call again after
   * a block edit — the stale mesh is replaced when the new one is ready. */
  updateChunk(cx: number, cz: number): void {
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk) {
      this.removeChunkMesh(cx, cz);
      return;
    }
    const key = chunkKey(cx, cz);
    const gen = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, gen);

    if (!this.worker) {
      const meshData = meshChunk(chunk, this.world);
      this.applyMesh(cx, cz, gen, meshData);
      return;
    }

    // The worker needs this chunk (it may have just been edited) and its
    // four neighbors (for border faces and AO) before it can mesh.
    this.worker.postMessage({ type: "set", cx, cz, buffer: chunk.buffer });
    this.workerHas.add(key);
    for (const [dx, dz] of NEIGHBOR_OFFSETS) {
      const nKey = chunkKey(cx + dx, cz + dz);
      if (this.workerHas.has(nKey)) continue;
      const neighbor = this.world.getChunk(cx + dx, cz + dz);
      if (!neighbor) continue;
      this.worker.postMessage({ type: "set", cx: cx + dx, cz: cz + dz, buffer: neighbor.buffer });
      this.workerHas.add(nKey);
    }
    this.worker.postMessage({ type: "mesh", cx, cz, id: gen });
  }

  private onMeshResult(msg: MeshResult): void {
    const key = chunkKey(msg.cx, msg.cz);
    if (this.generation.get(key) !== msg.id) return; // superseded or unloaded
    if (!this.world.hasChunk(msg.cx, msg.cz)) return;
    if (msg.empty || !msg.positions || !msg.indices) {
      this.disposeMesh(key);
      return;
    }
    this.applyMesh(msg.cx, msg.cz, msg.id, {
      positions: msg.positions,
      normals: msg.normals ?? new Float32Array(0),
      uvs: msg.uvs ?? new Float32Array(0),
      colors: msg.colors ?? new Float32Array(0),
      layers: msg.layers ?? new Float32Array(0),
      indices: msg.indices,
    });
  }

  private applyMesh(cx: number, cz: number, gen: number, data: MeshData): void {
    const key = chunkKey(cx, cz);
    if (this.generation.get(key) !== gen) return;
    this.disposeMesh(key);
    if (data.indices.length === 0) return;

    const mesh = new THREE.Mesh(buildGeometry(data), this.material);
    mesh.position.set(cx * 16, 0, cz * 16);
    // Chunk meshes never move once placed — skip the per-frame matrix
    // recompute Three.js would otherwise do for every one of them.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    this.meshes.set(key, mesh);
  }

  removeChunkMesh(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    // Bump the generation so any in-flight mesh for this chunk is dropped.
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.disposeMesh(key);
    if (this.worker && this.workerHas.delete(key)) {
      this.worker.postMessage({ type: "remove", cx, cz });
    }
  }

  private disposeMesh(key: string): void {
    const mesh = this.meshes.get(key);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.meshes.delete(key);
  }

  get meshedChunkCount(): number {
    return this.meshes.size;
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();
    this.worker?.terminate();
  }
}

import * as THREE from "three";
import { chunkKey } from "../world/coords";
import type { World } from "../world/world";
import { type MeshData, meshChunk } from "./mesher";

export { createChunkMaterial } from "./chunk-material";

function buildGeometry(data: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
  geometry.setAttribute("shadeColor", new THREE.BufferAttribute(data.colors, 3));
  geometry.setAttribute("layer", new THREE.BufferAttribute(data.layers, 1));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  return geometry;
}

/** Keeps one Three.js Mesh per loaded chunk in sync with World's block
 * data. Meshing itself (mesher.ts) is pure and Three.js-free; this is the
 * thin layer that turns that plain data into scene objects. */
export class ChunkMeshManager {
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly scene: THREE.Scene;
  private readonly world: World;
  private readonly material: THREE.Material;

  constructor(scene: THREE.Scene, world: World, material: THREE.Material) {
    this.scene = scene;
    this.world = world;
    this.material = material;
  }

  /** (Re)builds and displays the mesh for one loaded chunk. Safe to call
   * again after a block edit — the old mesh is disposed first. */
  updateChunk(cx: number, cz: number): void {
    const chunk = this.world.getChunk(cx, cz);
    this.removeChunkMesh(cx, cz);
    if (!chunk) return;

    const meshData = meshChunk(chunk, this.world);
    if (meshData.indices.length === 0) return;

    const mesh = new THREE.Mesh(buildGeometry(meshData), this.material);
    mesh.position.set(chunk.worldOriginX, 0, chunk.worldOriginZ);
    // Chunk meshes never move once placed — skip the per-frame matrix
    // recompute Three.js would otherwise do for every one of them.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    this.meshes.set(chunkKey(cx, cz), mesh);
  }

  removeChunkMesh(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
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
  }
}

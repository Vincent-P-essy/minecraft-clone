import * as THREE from "three";
import { createNoise2D } from "simplex-noise";
import { deriveSeed, mulberry32 } from "../world/rng";

export const CLOUD_ALTITUDE = 86;
export const CLOUD_CELL_SIZE = 16;
export const CLOUD_DRIFT_SPEED = 1.2; // blocks per second, along +X
const CLOUD_SALT = 0xc10d;
const CLOUD_THRESHOLD = 0.45;
const MAX_CLOUD_TILES = 400;

export interface CloudCell {
  readonly x: number;
  readonly z: number;
}

/** Which cloud tiles exist near the player. The cloud field is anchored in
 * its own drifting space (world position minus drift), so tiles glide
 * smoothly eastward while their pattern stays deterministic per seed —
 * pure, and testable without WebGL. */
export function cloudCellsAround(
  seed: number,
  playerX: number,
  playerZ: number,
  radiusCells: number,
  drift: number,
): CloudCell[] {
  const noise = createNoise2D(mulberry32(deriveSeed(seed, CLOUD_SALT)));
  const anchorX = playerX - drift;
  const cellMinX = Math.floor(anchorX / CLOUD_CELL_SIZE) - radiusCells;
  const cellMinZ = Math.floor(playerZ / CLOUD_CELL_SIZE) - radiusCells;

  const cells: CloudCell[] = [];
  for (let cx = cellMinX; cx <= cellMinX + radiusCells * 2; cx++) {
    for (let cz = cellMinZ; cz <= cellMinZ + radiusCells * 2; cz++) {
      if (noise(cx * 0.35, cz * 0.35) <= CLOUD_THRESHOLD) continue;
      cells.push({ x: cx * CLOUD_CELL_SIZE + drift, z: cz * CLOUD_CELL_SIZE });
      if (cells.length >= MAX_CLOUD_TILES) return cells;
    }
  }
  return cells;
}

/** Thin, slightly translucent boxes drifting high above the terrain — one
 * InstancedMesh, matrices rebuilt only when the visible tile set can have
 * changed (drift or player movement beyond a fraction of a cell). */
export class Clouds {
  private readonly mesh: THREE.InstancedMesh;
  private readonly seed: number;
  private lastKey = "";

  constructor(scene: THREE.Scene, seed: number) {
    this.seed = seed;
    const geometry = new THREE.BoxGeometry(CLOUD_CELL_SIZE - 2, 3, CLOUD_CELL_SIZE - 2);
    const material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_CLOUD_TILES);
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  update(playerX: number, playerZ: number, timeSeconds: number): void {
    const drift = timeSeconds * CLOUD_DRIFT_SPEED;
    const key = `${Math.round(drift * 2).toString()}|${Math.round(playerX / 8).toString()}|${Math.round(playerZ / 8).toString()}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const cells = cloudCellsAround(this.seed, playerX, playerZ, 10, drift);
    const matrix = new THREE.Matrix4();
    cells.forEach((cell, i) => {
      matrix.setPosition(cell.x, CLOUD_ALTITUDE, cell.z);
      this.mesh.setMatrixAt(i, matrix);
    });
    this.mesh.count = cells.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

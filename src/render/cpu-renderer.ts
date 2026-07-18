import * as THREE from "three";
import { createNoise2D } from "simplex-noise";
import { BlockId } from "../world/blocks";
import { CHUNK_HEIGHT } from "../world/coords";
import { deriveSeed, mulberry32 } from "../world/rng";
import type { World } from "../world/world";
import { BLOCK_COLORS } from "./block-colors";

/** A complete software renderer for the voxel world: one DDA ray per pixel
 * on a low-resolution 2D canvas, upscaled with crisp pixels. It exists so
 * the game still runs — and still looks like itself — on machines where
 * WebGL is unavailable entirely (the reason this project has it: a real
 * player hit exactly that). Three.js is used only as camera math here;
 * nothing touches the GPU. */

const MAX_DISTANCE = 52;
const FOG_START = 26;
const FOG_END = 50;
const WATER_ALPHA = 0.55;
const CLOUD_ALTITUDE = 86;
const CLOUD_CELL = 16;
const CLOUD_DRIFT_SPEED = 1.2;
const CLOUD_SALT = 0xc10d;

/** Internal render width in pixels; height follows the display aspect.
 * Adapts to keep frame time playable on whatever CPU this lands on. */
const START_WIDTH = 300;
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
const FRAME_SLOW_MS = 70;
const FRAME_FAST_MS = 30;

// Face brightness, matching the WebGL mesher's directional shading.
const SHADE_TOP = 1.0;
const SHADE_BOTTOM = 0.5;
const SHADE_X = 0.85;
const SHADE_Z = 0.75;

export interface CpuSkyState {
  readonly skyColor: readonly [number, number, number];
  readonly sunIntensity: number;
  readonly ambientIntensity: number;
  readonly sunAngle: number;
}

export class CpuRenderer {
  readonly camera: THREE.PerspectiveCamera;
  readonly domElement: HTMLCanvasElement;

  private readonly world: World;
  private readonly display: CanvasRenderingContext2D;
  private readonly cloudNoise: (x: number, y: number) => number;

  private buffer: HTMLCanvasElement;
  private bufferCtx: CanvasRenderingContext2D;
  private image: ImageData;
  private width = START_WIDTH;
  private height = Math.round((START_WIDTH * 9) / 16);
  private frameMsAverage = 33;

  private sky: CpuSkyState = {
    skyColor: [135 / 255, 206 / 255, 235 / 255],
    sunIntensity: 1.7,
    ambientIntensity: 0.55,
    sunAngle: Math.PI / 2,
  };

  constructor(parent: HTMLElement, world: World, seed: number) {
    this.world = world;
    this.cloudNoise = createNoise2D(mulberry32(deriveSeed(seed, CLOUD_SALT)));

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      MAX_DISTANCE,
    );

    this.domElement = document.createElement("canvas");
    this.domElement.width = window.innerWidth;
    this.domElement.height = window.innerHeight;
    this.domElement.style.width = "100%";
    this.domElement.style.height = "100%";
    this.domElement.style.imageRendering = "pixelated";
    parent.prepend(this.domElement);
    const display = this.domElement.getContext("2d");
    if (!display) throw new Error("2D canvas context is unavailable");
    this.display = display;

    this.buffer = document.createElement("canvas");
    const setup = this.allocateBuffer();
    this.bufferCtx = setup.ctx;
    this.image = setup.image;
  }

  private allocateBuffer(): { ctx: CanvasRenderingContext2D; image: ImageData } {
    this.height = Math.max(
      80,
      Math.round((this.width * this.domElement.height) / Math.max(1, this.domElement.width)),
    );
    this.buffer.width = this.width;
    this.buffer.height = this.height;
    const ctx = this.buffer.getContext("2d");
    if (!ctx) throw new Error("2D canvas context is unavailable");
    return { ctx, image: ctx.createImageData(this.width, this.height) };
  }

  resize(displayWidth: number, displayHeight: number): void {
    this.domElement.width = displayWidth;
    this.domElement.height = displayHeight;
    this.camera.aspect = displayWidth / displayHeight;
    this.camera.updateProjectionMatrix();
    const setup = this.allocateBuffer();
    this.bufferCtx = setup.ctx;
    this.image = setup.image;
  }

  applySky(state: CpuSkyState): void {
    this.sky = state;
  }

  private adaptResolution(frameMs: number): void {
    this.frameMsAverage = this.frameMsAverage * 0.8 + frameMs * 0.2;
    let next = this.width;
    if (this.frameMsAverage > FRAME_SLOW_MS) next = Math.max(MIN_WIDTH, this.width - 20);
    else if (this.frameMsAverage < FRAME_FAST_MS) next = Math.min(MAX_WIDTH, this.width + 20);
    if (next !== this.width) {
      this.width = next;
      const setup = this.allocateBuffer();
      this.bufferCtx = setup.ctx;
      this.image = setup.image;
    }
  }

  render(elapsedSeconds: number): void {
    const started = performance.now();
    const data = this.image.data;
    const W = this.width;
    const H = this.height;

    // Camera basis, once per frame.
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const tanHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.camera.aspect;
    const ox = this.camera.position.x;
    const oy = this.camera.position.y;
    const oz = this.camera.position.z;

    // Day/night: block colors dim with the sun, sky comes pre-keyframed.
    const light = Math.min(1, 0.3 + (0.7 * this.sky.sunIntensity) / 1.7);
    const [skyR, skyG, skyB] = this.sky.skyColor;
    const horizonR = Math.min(1, skyR * 1.12 + 0.03) * 255;
    const horizonG = Math.min(1, skyG * 1.12 + 0.03) * 255;
    const horizonB = Math.min(1, skyB * 1.1 + 0.03) * 255;
    const zenithR = skyR * 0.82 * 255;
    const zenithG = skyG * 0.86 * 255;
    const zenithB = skyB * 255;
    const drift = elapsedSeconds * CLOUD_DRIFT_SPEED;

    // Chunk cache: rays revisit the same chunk for many steps in a row.
    let cacheCx = Number.NaN;
    let cacheCz = Number.NaN;
    let cacheBuffer: Uint8Array | null = null;
    const blockAt = (x: number, y: number, z: number): number => {
      if (y < 0 || y >= CHUNK_HEIGHT) return BlockId.AIR;
      const cx = x >> 4;
      const cz = z >> 4;
      if (cx !== cacheCx || cz !== cacheCz) {
        cacheCx = cx;
        cacheCz = cz;
        cacheBuffer = this.world.getChunk(cx, cz)?.buffer ?? null;
      }
      if (!cacheBuffer) return BlockId.AIR;
      return cacheBuffer[((y << 4) | (z & 15)) * 16 + (x & 15)] ?? BlockId.AIR;
    };

    // When the eye itself is underwater every ray gets the tint, including
    // ones that reach a solid block without crossing another water boundary.
    const eyeInWater =
      blockAt(Math.floor(ox), Math.floor(oy), Math.floor(oz)) === (BlockId.WATER as number);

    let k = 0;
    for (let j = 0; j < H; j++) {
      const v = 1 - ((j + 0.5) / H) * 2;
      for (let i = 0; i < W; i++) {
        const u = ((i + 0.5) / W) * 2 - 1;

        let dx = forward.x + u * tanHalf * aspect * right.x + v * tanHalf * up.x;
        let dy = forward.y + u * tanHalf * aspect * right.y + v * tanHalf * up.y;
        let dz = forward.z + u * tanHalf * aspect * right.z + v * tanHalf * up.z;
        const invLen = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx *= invLen;
        dy *= invLen;
        dz *= invLen;

        // --- DDA march ---
        let voxelX = Math.floor(ox);
        let voxelY = Math.floor(oy);
        let voxelZ = Math.floor(oz);
        const stepX = dx > 0 ? 1 : -1;
        const stepY = dy > 0 ? 1 : -1;
        const stepZ = dz > 0 ? 1 : -1;
        const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
        const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
        const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
        let tMaxX =
          dx > 0 ? (voxelX + 1 - ox) * (1 / dx) : dx < 0 ? (voxelX - ox) * (1 / dx) : Infinity;
        let tMaxY =
          dy > 0 ? (voxelY + 1 - oy) * (1 / dy) : dy < 0 ? (voxelY - oy) * (1 / dy) : Infinity;
        let tMaxZ =
          dz > 0 ? (voxelZ + 1 - oz) * (1 / dz) : dz < 0 ? (voxelZ - oz) * (1 / dz) : Infinity;

        let hitId = 0;
        let hitT = MAX_DISTANCE;
        // 0=x, 1=y, 2=z — the face the ray entered through, and the step
        // sign on that axis. The first DDA iteration always assigns both
        // before anything reads them (hence the definite-assignment `!`).
        let axis!: number;
        let entered!: number;
        let waterT = eyeInWater ? 0 : -1;

        for (;;) {
          let t: number;
          if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
            t = tMaxX;
            voxelX += stepX;
            tMaxX += tDeltaX;
            axis = 0;
            entered = stepX;
          } else if (tMaxY <= tMaxZ) {
            t = tMaxY;
            voxelY += stepY;
            tMaxY += tDeltaY;
            axis = 1;
            entered = stepY;
          } else {
            t = tMaxZ;
            voxelZ += stepZ;
            tMaxZ += tDeltaZ;
            axis = 2;
            entered = stepZ;
          }
          if (t > MAX_DISTANCE) break;
          if (voxelY >= CHUNK_HEIGHT && stepY > 0) break; // into open sky
          if (voxelY < 0) break; // under the world

          const id = blockAt(voxelX, voxelY, voxelZ);
          if (id === BlockId.AIR) continue;
          if (id === BlockId.WATER) {
            if (waterT < 0) waterT = t; // remember the surface, keep going
            continue;
          }
          hitId = id;
          hitT = t;
          break;
        }

        // --- shade the pixel ---
        let r: number;
        let g: number;
        let b: number;

        if (hitId === 0) {
          // Sky gradient, with a cloud plane crossing.
          const grad = Math.min(1, Math.max(0, dy * 1.6 + 0.12));
          r = horizonR + (zenithR - horizonR) * grad;
          g = horizonG + (zenithG - horizonG) * grad;
          b = horizonB + (zenithB - horizonB) * grad;
          if (dy > 0.004 && oy < CLOUD_ALTITUDE) {
            const tc = (CLOUD_ALTITUDE - oy) / dy;
            if (tc < 500) {
              const cellX = Math.floor((ox + dx * tc - drift) / CLOUD_CELL);
              const cellZ = Math.floor((oz + dz * tc) / CLOUD_CELL);
              if (this.cloudNoise(cellX * 0.35, cellZ * 0.35) > 0.45) {
                const fade = Math.max(0.25, 1 - tc / 500);
                const cloud = 235 * light;
                r += (cloud - r) * 0.85 * fade;
                g += (cloud - g) * 0.85 * fade;
                b += (cloud - b) * 0.85 * fade;
              }
            }
          }
        } else {
          const colors = BLOCK_COLORS[hitId as BlockId];
          const face = axis === 1 && entered < 0 ? colors.top : colors.side;
          const shade =
            axis === 1 ? (entered < 0 ? SHADE_TOP : SHADE_BOTTOM) : axis === 0 ? SHADE_X : SHADE_Z;
          // Cheap per-voxel speckle so surfaces read as textured, not flat.
          const hash = ((voxelX * 73856093) ^ (voxelY * 19349663) ^ (voxelZ * 83492791)) >>> 0;
          const speckle = ((hash & 7) - 3) * 3;
          const lit = shade * light;
          r = (face[0] + speckle) * lit;
          g = (face[1] + speckle) * lit;
          b = (face[2] + speckle) * lit;

          // Fog toward the horizon color.
          const fog = Math.min(1, Math.max(0, (hitT - FOG_START) / (FOG_END - FOG_START)));
          r += (horizonR - r) * fog;
          g += (horizonG - g) * fog;
          b += (horizonB - b) * fog;
        }

        if (waterT >= 0) {
          // Blend the water surface over whatever was behind it.
          const depth = Math.min(1, (hitT - waterT) / 8);
          const alpha = WATER_ALPHA + 0.3 * depth;
          const water = BLOCK_COLORS[BlockId.WATER].top;
          const wr = water[0] * light;
          const wg = water[1] * light;
          const wb = water[2] * light;
          r += (wr - r) * alpha;
          g += (wg - g) * alpha;
          b += (wb - b) * alpha;
        }

        data[k++] = r;
        data[k++] = g;
        data[k++] = b;
        data[k++] = 255;
      }
    }

    this.bufferCtx.putImageData(this.image, 0, 0);
    this.display.imageSmoothingEnabled = false;
    this.display.drawImage(
      this.buffer,
      0,
      0,
      W,
      H,
      0,
      0,
      this.domElement.width,
      this.domElement.height,
    );

    this.adaptResolution(performance.now() - started);
  }

  /** Exposed for the HUD: current internal resolution, for the curious. */
  get internalWidth(): number {
    return this.width;
  }
}

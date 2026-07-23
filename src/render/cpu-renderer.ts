import * as THREE from "three";
import { createNoise2D } from "simplex-noise";
import { BlockId } from "../world/blocks";
import { CHUNK_HEIGHT } from "../world/coords";
import { deriveSeed, mulberry32 } from "../world/rng";
import type { World } from "../world/world";
import { BLOCK_COLORS } from "./block-colors";

/** A complete software renderer for the voxel world on a 2D canvas,
 * smoothly upscaled. It exists so the game still runs — and still looks
 * like itself — on machines where WebGL is unavailable entirely (the
 * reason this project has it: a real player hit exactly that). Three.js is
 * used only as camera math here; nothing touches the GPU.
 *
 * Faces get sun-direction diffuse lighting, per-pixel ambient occlusion,
 * a world-stable texel pattern, fog, depth-blended water, soft clouds, a
 * sun disc and night stars.
 *
 * Performance model — edge-adaptive sampling: real DDA rays are traced on
 * a half-resolution grid; each traced ray records a compact hit signature
 * (block id, face, water crossing) and depth. The in-between pixels
 * compare their neighbors' signatures: across a flat surface, sky, or
 * open water they interpolate (a quarter of the rays for identical-looking
 * output); wherever the signature or depth disagrees — silhouettes, face
 * boundaries, shorelines — the real ray is traced. Crispness lands
 * exactly where the eye checks for it. */

const MAX_DISTANCE = 52;
const FOG_START = 26;
const FOG_END = 50;
const WATER_ALPHA = 0.55;
const CLOUD_ALTITUDE = 86;
const CLOUD_CELL = 16;
const CLOUD_DRIFT_SPEED = 1.2;
const CLOUD_SALT = 0xc10d;

/** Internal render width in pixels; height follows the display aspect.
 * Adapts to keep frame time at a fluid clip on whatever CPU this lands on. */
const START_WIDTH = 420;
const MIN_WIDTH = 240;
const MAX_WIDTH = 720;
// Tuned toward frame rate: the adaptive controller seeks the internal
// resolution that keeps a frame under ~20ms (~50fps), dropping resolution
// before it drops below that rather than holding a crisp-but-choppy image.
const FRAME_SLOW_MS = 20;
const FRAME_FAST_MS = 11;

/** Traced neighbors must agree in signature and sit within this many
 * blocks of depth of each other for the pixel between them to interpolate. */
const REFINE_DEPTH_GAP = 2;

/** How far (in face-fraction units) the edge/corner AO darkening reaches. */
const AO_REACH = 0.34;
const AO_STRENGTH = 0.42;

const TEXEL_GRID = 8;

/** The chunk lookup table spans this many chunks on a side, centered on
 * the camera — comfortably past MAX_DISTANCE in every direction. */
const TABLE_SPAN = 11;
const TABLE_REACH = 5;

export interface CpuSkyState {
  readonly skyColor: readonly [number, number, number];
  readonly sunIntensity: number;
  readonly ambientIntensity: number;
  readonly sunAngle: number;
}

export interface CpuHighlight {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The 12 edges of a unit cube, as index pairs into its 8 corners. */
const CUBE_EDGES: readonly [number, number][] = [
  [0, 1],
  [1, 3],
  [3, 2],
  [2, 0],
  [4, 5],
  [5, 7],
  [7, 6],
  [6, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

export class CpuRenderer {
  readonly camera: THREE.PerspectiveCamera;
  readonly domElement: HTMLCanvasElement;

  private readonly world: World;
  private readonly display: CanvasRenderingContext2D;
  private readonly cloudNoise: (x: number, y: number) => number;
  private readonly corners: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());
  private readonly chunkTable: (Uint8Array | null)[] = new Array<Uint8Array | null>(
    TABLE_SPAN * TABLE_SPAN,
  ).fill(null);

  private buffer: HTMLCanvasElement;
  private bufferCtx: CanvasRenderingContext2D;
  private image: ImageData;
  private width = START_WIDTH;
  private height = Math.round((START_WIDTH * 9) / 16);
  private sigGrid = new Int32Array(0);
  private depthGrid = new Float32Array(0);
  private frameMsEma = 33;
  private highlight: CpuHighlight | null = null;

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
    const coarseW = (this.width + 1) >> 1;
    const coarseH = (this.height + 1) >> 1;
    this.sigGrid = new Int32Array(coarseW * coarseH);
    this.depthGrid = new Float32Array(coarseW * coarseH);
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

  /** The block the crosshair targets, outlined on top of the render. */
  setHighlight(target: CpuHighlight | null): void {
    this.highlight = target;
  }

  private adaptResolution(frameMs: number): void {
    this.frameMsEma = this.frameMsEma * 0.8 + frameMs * 0.2;
    let next = this.width;
    if (this.frameMsEma > FRAME_SLOW_MS) next = Math.max(MIN_WIDTH, this.width - 40);
    else if (this.frameMsEma < FRAME_FAST_MS) next = Math.min(MAX_WIDTH, this.width + 40);
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
    const coarseW = (W + 1) >> 1;
    const sigGrid = this.sigGrid;
    const depthGrid = this.depthGrid;

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
    const fwX = forward.x;
    const fwY = forward.y;
    const fwZ = forward.z;
    const rtX = tanHalf * aspect * right.x;
    const rtY = tanHalf * aspect * right.y;
    const rtZ = tanHalf * aspect * right.z;
    const upX = tanHalf * up.x;
    const upY = tanHalf * up.y;
    const upZ = tanHalf * up.z;

    // Ray-start voxel and in-voxel fractions, hoisted out of the pixel loop.
    const startVX = Math.floor(ox);
    const startVY = Math.floor(oy);
    const startVZ = Math.floor(oz);
    const fracX = ox - startVX;
    const fracY = oy - startVY;
    const fracZ = oz - startVZ;

    // Chunk lookup table: plain array indexing in the hot loop, no map keys.
    const baseCx = (startVX >> 4) - TABLE_REACH;
    const baseCz = (startVZ >> 4) - TABLE_REACH;
    const chunkTable = this.chunkTable;
    for (let ci = 0; ci < TABLE_SPAN; ci++) {
      for (let cj = 0; cj < TABLE_SPAN; cj++) {
        chunkTable[ci * TABLE_SPAN + cj] =
          this.world.getChunk(baseCx + ci, baseCz + cj)?.buffer ?? null;
      }
    }
    const sampleBlock = (x: number, y: number, z: number): number => {
      if (y < 0 || y >= CHUNK_HEIGHT) return 0;
      const ci = (x >> 4) - baseCx;
      const cj = (z >> 4) - baseCz;
      if (ci < 0 || ci >= TABLE_SPAN || cj < 0 || cj >= TABLE_SPAN) return 0;
      const buf = chunkTable[ci * TABLE_SPAN + cj];
      return buf ? (buf[((y << 4) | (z & 15)) * 16 + (x & 15)] ?? 0) : 0;
    };
    const occludes = (x: number, y: number, z: number): boolean => {
      const id = sampleBlock(x, y, z);
      return id !== BlockId.AIR && id !== BlockId.WATER && id !== BlockId.LEAVES;
    };

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

    // Sun direction along its arc; the six face-normal light factors follow
    // it through the day, so east walls glow in the morning and west walls
    // in the evening.
    const sunLen = Math.hypot(
      Math.cos(this.sky.sunAngle),
      Math.max(Math.sin(this.sky.sunAngle), 0.12),
      0.28,
    );
    const sunX = Math.cos(this.sky.sunAngle) / sunLen;
    const sunY = Math.max(Math.sin(this.sky.sunAngle), 0.12) / sunLen;
    const sunZ = 0.28 / sunLen;
    const faceLight = (nx: number, ny: number, nz: number): number =>
      0.4 + 0.62 * Math.max(0, nx * sunX + ny * sunY + nz * sunZ);
    const lightXPos = faceLight(1, 0, 0);
    const lightXNeg = faceLight(-1, 0, 0);
    const lightYPos = faceLight(0, 1, 0);
    const lightYNeg = 0.4; // straight-down faces only ever see ambient
    const lightZPos = faceLight(0, 0, 1);
    const lightZNeg = faceLight(0, 0, -1);
    const sunVisibility = Math.min(1, Math.max(0, Math.sin(this.sky.sunAngle) * 3));
    const starAmount = 1 - Math.min(1, sunVisibility * 2 + light * 0.6);

    const eyeInWater = sampleBlock(startVX, startVY, startVZ) === (BlockId.WATER as number);

    const waterTop = BLOCK_COLORS[BlockId.WATER].top;
    const waterR = waterTop[0] * light;
    const waterG = waterTop[1] * light;
    const waterB = waterTop[2] * light;

    /** Traces the real ray for pixel (i, j), writes its color into the
     * image, and returns the packed hit signature (depth goes to lastT). */
    let lastT = 0;
    const trace = (i: number, j: number): number => {
      const u = ((i + 0.5) / W) * 2 - 1;
      const v = 1 - ((j + 0.5) / H) * 2;

      let dx = fwX + u * rtX + v * upX;
      let dy = fwY + u * rtY + v * upY;
      let dz = fwZ + u * rtZ + v * upZ;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      dx *= invLen;
      dy *= invLen;
      dz *= invLen;

      // --- DDA march ---
      let voxelX = startVX;
      let voxelY = startVY;
      let voxelZ = startVZ;
      const stepX = dx > 0 ? 1 : -1;
      const stepY = dy > 0 ? 1 : -1;
      const stepZ = dz > 0 ? 1 : -1;
      const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
      const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
      const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
      let tMaxX = dx > 0 ? (1 - fracX) / dx : dx < 0 ? -fracX / dx : Infinity;
      let tMaxY = dy > 0 ? (1 - fracY) / dy : dy < 0 ? -fracY / dy : Infinity;
      let tMaxZ = dz > 0 ? (1 - fracZ) / dz : dz < 0 ? -fracZ / dz : Infinity;

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

        // Inline chunk-table block sampling — this is the hottest read in
        // the whole renderer.
        let id = 0;
        if (voxelY >= 0 && voxelY < CHUNK_HEIGHT) {
          const ci = (voxelX >> 4) - baseCx;
          const cj = (voxelZ >> 4) - baseCz;
          if (ci >= 0 && ci < TABLE_SPAN && cj >= 0 && cj < TABLE_SPAN) {
            const buf = chunkTable[ci * TABLE_SPAN + cj];
            if (buf) id = buf[((voxelY << 4) | (voxelZ & 15)) * 16 + (voxelX & 15)] ?? 0;
          }
        }

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
        // Sky gradient, stars, sun, and a cloud plane crossing.
        const grad = Math.min(1, Math.max(0, dy * 1.6 + 0.12));
        r = horizonR + (zenithR - horizonR) * grad;
        g = horizonG + (zenithG - horizonG) * grad;
        b = horizonB + (zenithB - horizonB) * grad;

        if (starAmount > 0.05 && dy > -0.05) {
          const qx = (dx * 190) | 0;
          const qy = (dy * 190) | 0;
          const qz = (dz * 190) | 0;
          let sh =
            (Math.imul(qx, 374761393) ^ Math.imul(qy, 668265263) ^ Math.imul(qz, 2246822519)) >>> 0;
          sh ^= sh >>> 13;
          sh = Math.imul(sh, 0x5bd1e995) >>> 0;
          if ((sh & 255) < 3) {
            const twinkle = 120 + ((sh >>> 8) & 127);
            const star = starAmount * (twinkle / 255);
            r += (255 - r) * star;
            g += (255 - g) * star;
            b += (255 - b) * star;
          }
        }

        if (sunVisibility > 0) {
          const sunDot = dx * sunX + dy * sunY + dz * sunZ;
          if (sunDot > 0.97) {
            const glow = Math.min(1, (sunDot - 0.97) / 0.03);
            const halo = glow * glow * 0.55 * sunVisibility;
            r += (255 - r) * halo;
            g += (244 - g) * halo * 0.92;
            b += (200 - b) * halo * 0.8;
            if (sunDot > 0.9992) {
              const disc = Math.min(1, (sunDot - 0.9992) / 0.0006) * sunVisibility;
              r += (255 - r) * disc;
              g += (250 - g) * disc;
              b += (225 - b) * disc;
            }
          }
        }

        if (dy > 0.004 && oy < CLOUD_ALTITUDE) {
          const tc = (CLOUD_ALTITUDE - oy) / dy;
          if (tc < 500) {
            const cellX = Math.floor((ox + dx * tc - drift) / CLOUD_CELL);
            const cellZ = Math.floor((oz + dz * tc) / CLOUD_CELL);
            const n = this.cloudNoise(cellX * 0.35, cellZ * 0.35);
            if (n > 0.4) {
              // Soft coverage instead of a hard cell threshold.
              const s = Math.min(1, (n - 0.4) / 0.22);
              const cover = s * s * (3 - 2 * s);
              const fade = Math.max(0.25, 1 - tc / 500);
              const cloud = 235 * light;
              const alpha = cover * 0.88 * fade;
              r += (cloud - r) * alpha;
              g += (cloud - g) * alpha;
              b += (cloud - b) * alpha;
            }
          }
        }
      } else {
        const colors = BLOCK_COLORS[hitId as BlockId];
        const face = axis === 1 && entered < 0 ? colors.top : colors.side;
        const shade =
          axis === 0
            ? entered < 0
              ? lightXPos
              : lightXNeg
            : axis === 1
              ? entered < 0
                ? lightYPos
                : lightYNeg
              : entered < 0
                ? lightZPos
                : lightZNeg;

        // Fractional position on the face (in the open cell the ray came
        // from), along the face's two tangent axes.
        const px = ox + dx * hitT;
        const py = oy + dy * hitT;
        const pz = oz + dz * hitT;
        let fu: number;
        let fv: number;
        if (axis === 0) {
          fu = py - Math.floor(py);
          fv = pz - Math.floor(pz);
        } else if (axis === 1) {
          fu = px - Math.floor(px);
          fv = pz - Math.floor(pz);
        } else {
          fu = px - Math.floor(px);
          fv = py - Math.floor(py);
        }

        const fog = Math.min(1, Math.max(0, (hitT - FOG_START) / (FOG_END - FOG_START)));

        // World-stable 8x8 texel pattern, fading into the fog.
        const tu = Math.min(TEXEL_GRID - 1, (fu * TEXEL_GRID) | 0);
        const tv = Math.min(TEXEL_GRID - 1, (fv * TEXEL_GRID) | 0);
        let hash =
          (Math.imul(voxelX, 73856093) ^
            Math.imul(voxelY, 19349663) ^
            Math.imul(voxelZ, 83492791) ^
            Math.imul(tu * TEXEL_GRID + tv + axis * 64 + 1, 2654435761)) >>>
          0;
        // Murmur-style finalizer: without it, neighboring texel indices
        // correlate and flat surfaces develop a checkerboard.
        hash ^= hash >>> 13;
        hash = Math.imul(hash, 0x5bd1e995) >>> 0;
        hash ^= hash >>> 15;
        const texel = ((hash & 15) - 7.5) * 1.3 * (1 - fog);

        // Per-pixel ambient occlusion: the same edge/corner occluders the
        // WebGL mesher samples, evaluated smoothly against the distance
        // from this pixel to the face's edges.
        let aoAmount = 0;
        if (hitT < FOG_END) {
          const openX = voxelX - (axis === 0 ? entered : 0);
          const openY = voxelY - (axis === 1 ? entered : 0);
          const openZ = voxelZ - (axis === 2 ? entered : 0);
          const su = fu > 0.5 ? 1 : -1;
          const sv = fv > 0.5 ? 1 : -1;
          const du = fu > 0.5 ? 1 - fu : fu;
          const dvv = fv > 0.5 ? 1 - fv : fv;
          let side1: boolean;
          let side2: boolean;
          let cornerOcc: boolean;
          if (axis === 0) {
            side1 = occludes(openX, openY + su, openZ);
            side2 = occludes(openX, openY, openZ + sv);
            cornerOcc = occludes(openX, openY + su, openZ + sv);
          } else if (axis === 1) {
            side1 = occludes(openX + su, openY, openZ);
            side2 = occludes(openX, openY, openZ + sv);
            cornerOcc = occludes(openX + su, openY, openZ + sv);
          } else {
            side1 = occludes(openX + su, openY, openZ);
            side2 = occludes(openX, openY + sv, openZ);
            cornerOcc = occludes(openX + su, openY + sv, openZ);
          }
          const rampU = du < AO_REACH ? 1 - du / AO_REACH : 0;
          const rampV = dvv < AO_REACH ? 1 - dvv / AO_REACH : 0;
          if (side1) aoAmount = rampU * rampU;
          if (side2) aoAmount = Math.max(aoAmount, rampV * rampV);
          if (cornerOcc && !side1 && !side2) {
            const rc = rampU * rampV;
            aoAmount = Math.max(aoAmount, rc * rc);
          }
        }

        const lit = shade * light * (1 - AO_STRENGTH * aoAmount);
        r = (face[0] + texel) * lit;
        g = (face[1] + texel) * lit;
        b = (face[2] + texel) * lit;

        // Fog toward the horizon color.
        r += (horizonR - r) * fog;
        g += (horizonG - g) * fog;
        b += (horizonB - b) * fog;
      }

      if (waterT >= 0) {
        // Blend the water surface over whatever was behind it.
        const depth = Math.min(1, (hitT - waterT) / 8);
        const alpha = WATER_ALPHA + 0.3 * depth;
        r += (waterR - r) * alpha;
        g += (waterG - g) * alpha;
        b += (waterB - b) * alpha;
      }

      const k = (j * W + i) * 4;
      data[k] = r;
      data[k + 1] = g;
      data[k + 2] = b;
      data[k + 3] = 255;

      lastT = hitT;
      // Signature: block id (4b) | face axis (2b) | face sign (1b) | water (1b).
      return hitId | (axis << 4) | ((entered > 0 ? 1 : 0) << 6) | ((waterT >= 0 ? 1 : 0) << 7);
    };

    // --- Pass 1: trace the half-resolution grid ---
    for (let j = 0; j < H; j += 2) {
      const jc = j >> 1;
      for (let i = 0; i < W; i += 2) {
        const sig = trace(i, j);
        const c = jc * coarseW + (i >> 1);
        sigGrid[c] = sig;
        depthGrid[c] = lastT;
      }
    }

    // --- Pass 2: interpolate flat regions, re-trace edges ---
    const maxIc = coarseW - 1;
    const maxJc = (H - 1) >> 1;
    for (let j = 0; j < H; j++) {
      const jOdd = j & 1;
      const jc0 = j >> 1;
      const jc1 = jOdd ? Math.min(jc0 + 1, maxJc) : jc0;
      for (let i = 0; i < W; i++) {
        const iOdd = i & 1;
        if (!iOdd && !jOdd) continue; // traced in pass 1

        const ic0 = i >> 1;
        const ic1 = iOdd ? Math.min(ic0 + 1, maxIc) : ic0;

        // Gather the traced neighbors this pixel sits between.
        const cA = jc0 * coarseW + ic0;
        const cB = jc0 * coarseW + ic1;
        const cC = jc1 * coarseW + ic0;
        const cD = jc1 * coarseW + ic1;
        const sigA = sigGrid[cA] ?? 0;
        const dA = depthGrid[cA] ?? 0;
        let same = true;
        let minT = dA;
        let maxT = dA;
        if (cB !== cA) {
          if (sigGrid[cB] !== sigA) same = false;
          const d = depthGrid[cB] ?? 0;
          if (d < minT) minT = d;
          if (d > maxT) maxT = d;
        }
        if (same && cC !== cA) {
          if (sigGrid[cC] !== sigA) same = false;
          const d = depthGrid[cC] ?? 0;
          if (d < minT) minT = d;
          if (d > maxT) maxT = d;
        }
        if (same && cD !== cA && cD !== cB && cD !== cC) {
          if (sigGrid[cD] !== sigA) same = false;
          const d = depthGrid[cD] ?? 0;
          if (d < minT) minT = d;
          if (d > maxT) maxT = d;
        }

        if (same && maxT - minT < REFINE_DEPTH_GAP) {
          // Flat region: average the traced neighbors' colors.
          const pA = (jc0 * 2 * W + ic0 * 2) * 4;
          const pB = (jc0 * 2 * W + ic1 * 2) * 4;
          const pC = (jc1 * 2 * W + ic0 * 2) * 4;
          const pD = (jc1 * 2 * W + ic1 * 2) * 4;
          const k = (j * W + i) * 4;
          data[k] =
            (((data[pA] ?? 0) + (data[pB] ?? 0) + (data[pC] ?? 0) + (data[pD] ?? 0)) / 4) | 0;
          data[k + 1] =
            (((data[pA + 1] ?? 0) +
              (data[pB + 1] ?? 0) +
              (data[pC + 1] ?? 0) +
              (data[pD + 1] ?? 0)) /
              4) |
            0;
          data[k + 2] =
            (((data[pA + 2] ?? 0) +
              (data[pB + 2] ?? 0) +
              (data[pC + 2] ?? 0) +
              (data[pD + 2] ?? 0)) /
              4) |
            0;
          data[k + 3] = 255;
        } else {
          trace(i, j);
        }
      }
    }

    this.bufferCtx.putImageData(this.image, 0, 0);
    // Smooth upscale: the browser's bilinear filter is the final
    // anti-aliasing pass — crisp enough to read blocks, soft enough to
    // kill stair-steps.
    this.display.imageSmoothingEnabled = true;
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

    this.drawHighlight();

    this.adaptResolution(performance.now() - started);
  }

  /** Projects the targeted block's edges onto the display canvas — the CPU
   * path has no scene graph, so the outline is plain 2D line drawing. */
  private drawHighlight(): void {
    const target = this.highlight;
    if (!target) return;
    const w = this.domElement.width;
    const h = this.domElement.height;

    for (let c = 0; c < 8; c++) {
      const corner = this.corners[c];
      if (!corner) return;
      corner.set(target.x + (c & 1), target.y + ((c >> 1) & 1), target.z + ((c >> 2) & 1));
      corner.project(this.camera);
      if (corner.z > 1 || corner.z < -1) return; // clipped: skip the outline
    }

    this.display.strokeStyle = "rgba(10, 10, 10, 0.8)";
    this.display.lineWidth = Math.max(1.5, w / 700);
    this.display.beginPath();
    for (const [a, b] of CUBE_EDGES) {
      const ca = this.corners[a];
      const cb = this.corners[b];
      if (!ca || !cb) continue;
      this.display.moveTo((ca.x * 0.5 + 0.5) * w, (0.5 - ca.y * 0.5) * h);
      this.display.lineTo((cb.x * 0.5 + 0.5) * w, (0.5 - cb.y * 0.5) * h);
    }
    this.display.stroke();
  }

  /** Exposed for the HUD and the visual-check harness. */
  get internalWidth(): number {
    return this.width;
  }

  get frameMs(): number {
    return this.frameMsEma;
  }
}

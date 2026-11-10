import * as THREE from "three";
import { BlockId } from "../world/blocks";
import { mulberry32 } from "../world/rng";
import { tileForBlockFace } from "./atlas-layout";
import { OUTPUT } from "./shaders/common";
import { paintTile } from "./tile-painter";

/** A small pool of point sprites: debris when a block breaks, droplets on
 * a splash, and fireflies that drift over the grass at night. Simulated on
 * the CPU (a few hundred points at most) and drawn in one call. */

const CAPACITY = 640;

const VERTEX = /* glsl */ `
  attribute vec4 aColor;
  attribute float aSize;
  uniform float uPixelsPerUnit;
  varying vec4 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vColor = aColor;
    gl_PointSize = aSize * uPixelsPerUnit / max(-mv.z, 0.1);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  ${OUTPUT}
  uniform vec3 uParticleLight;
  varying vec4 vColor;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    // alpha > 1 marks a glowing particle: soft, round and unlit.
    if (vColor.a > 1.0) {
      float d = length(p) * 2.0;
      float glow = exp(-d * d * 4.0);
      if (glow < 0.02) discard;
      gl_FragColor = outputColor(vColor.rgb * glow * 6.0, glow * (vColor.a - 1.0));
    } else {
      gl_FragColor = outputColor(vColor.rgb * uParticleLight, vColor.a);
    }
  }
`;

/** The average colour of each block's side texture, for its debris. */
function buildBlockColors(seed: number): Map<BlockId, [number, number, number]> {
  const colors = new Map<BlockId, [number, number, number]>();
  const toLinear = (v: number): number => Math.pow(v / 255, 2.2);
  for (const id of Object.values(BlockId)) {
    if (id === BlockId.AIR) continue;
    const pixels = paintTile(tileForBlockFace(id, "north"), seed);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if ((pixels[i + 3] ?? 0) < 128) continue;
      r += pixels[i] ?? 0;
      g += pixels[i + 1] ?? 0;
      b += pixels[i + 2] ?? 0;
      n++;
    }
    if (n > 0) colors.set(id, [toLinear(r / n), toLinear(g / n), toLinear(b / n)]);
  }
  return colors;
}

export class Particles {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly position = new Float32Array(CAPACITY * 3);
  private readonly color = new Float32Array(CAPACITY * 4);
  private readonly size = new Float32Array(CAPACITY);
  private readonly velocity = new Float32Array(CAPACITY * 3);
  private readonly life = new Float32Array(CAPACITY);
  private readonly maxLife = new Float32Array(CAPACITY);
  /** 0 = debris (falls, fades), 1 = firefly (wanders, pulses). */
  private readonly kind = new Uint8Array(CAPACITY);
  private readonly phase = new Float32Array(CAPACITY);
  private readonly blockColors: Map<BlockId, [number, number, number]>;
  private readonly rng: () => number;
  private cursor = 0;
  private fireflies = 0;
  private clock = 0;

  constructor(scene: THREE.Scene, seed: number, direct: boolean) {
    this.blockColors = buildBlockColors(seed);
    this.rng = mulberry32(seed ^ 0x9a17);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.position, 3));
    geometry.setAttribute("aColor", new THREE.BufferAttribute(this.color, 4));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelsPerUnit: { value: 600 },
        uParticleLight: { value: new THREE.Vector3(1, 1, 1) },
        uExposure: { value: 1 },
      },
      defines: direct ? { DIRECT_OUTPUT: "" } : {},
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    scene.add(this.points);
  }

  /** Match the renderer's output mode after a quality change. */
  setDirect(direct: boolean): void {
    this.material.defines = direct ? { DIRECT_OUTPUT: "" } : {};
    this.material.needsUpdate = true;
  }

  private spawn(): number {
    // Reuse the oldest slot; never overwrite a living firefly with debris.
    for (let tries = 0; tries < CAPACITY; tries++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % CAPACITY;
      if ((this.life[i] ?? 0) <= 0 || this.kind[i] === 0) return i;
    }
    return this.cursor;
  }

  private emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    rgb: readonly [number, number, number],
    alpha: number,
    size: number,
    life: number,
    kind: number,
  ): void {
    const i = this.spawn();
    if (this.kind[i] === 1 && (this.life[i] ?? 0) > 0) this.fireflies--;
    this.position.set([x, y, z], i * 3);
    this.velocity.set([vx, vy, vz], i * 3);
    this.color.set([rgb[0], rgb[1], rgb[2], alpha], i * 4);
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.kind[i] = kind;
    this.phase[i] = this.rng() * 6.283;
    if (kind === 1) this.fireflies++;
  }

  /** Debris flying out of a broken block. */
  burst(x: number, y: number, z: number, block: BlockId, count = 16): void {
    const base = this.blockColors.get(block) ?? [0.5, 0.5, 0.5];
    const r = this.rng;
    for (let n = 0; n < count; n++) {
      const tone = 0.7 + r() * 0.6;
      this.emit(
        x + 0.15 + r() * 0.7,
        y + 0.15 + r() * 0.7,
        z + 0.15 + r() * 0.7,
        (r() - 0.5) * 3.2,
        1.2 + r() * 3.2,
        (r() - 0.5) * 3.2,
        [base[0] * tone, base[1] * tone, base[2] * tone],
        1,
        0.11 + r() * 0.09,
        0.45 + r() * 0.5,
        0,
      );
    }
  }

  /** Droplets where the player hits the water. */
  splash(x: number, y: number, z: number): void {
    const r = this.rng;
    for (let n = 0; n < 22; n++) {
      const angle = r() * 6.283;
      const speed = 1 + r() * 2.6;
      this.emit(
        x + Math.cos(angle) * 0.3,
        y,
        z + Math.sin(angle) * 0.3,
        Math.cos(angle) * speed,
        2.2 + r() * 3,
        Math.sin(angle) * speed,
        [0.55, 0.75, 0.9],
        0.8,
        0.07 + r() * 0.06,
        0.5 + r() * 0.4,
        0,
      );
    }
  }

  /** Keeps a few fireflies drifting near the player while it's dark and
   * they're out in the open. `groundY` is the terrain height nearby. */
  private tendFireflies(x: number, z: number, groundY: (x: number, z: number) => number): void {
    if (this.fireflies >= 36) return;
    const r = this.rng;
    const fx = x + (r() - 0.5) * 44;
    const fz = z + (r() - 0.5) * 44;
    const ground = groundY(fx, fz);
    if (ground < 0) return;
    this.emit(
      fx,
      ground + 1.2 + r() * 2.6,
      fz,
      0,
      0,
      0,
      [0.8, 1.0, 0.35],
      1.9,
      0.5,
      9 + r() * 10,
      1,
    );
  }

  update(
    dt: number,
    player: { x: number; y: number; z: number },
    night: number,
    light: readonly [number, number, number],
    viewportHeight: number,
    fovDegrees: number,
    exposure: number,
    groundY: (x: number, z: number) => number,
  ): void {
    this.clock += dt;
    const u = this.material.uniforms;
    if (u.uPixelsPerUnit) {
      u.uPixelsPerUnit.value = viewportHeight / (2 * Math.tan((fovDegrees * Math.PI) / 360));
    }
    (u.uParticleLight?.value as THREE.Vector3).set(light[0], light[1], light[2]);
    if (u.uExposure) u.uExposure.value = exposure;

    if (night > 0.6 && this.rng() < dt * 6) this.tendFireflies(player.x, player.z, groundY);

    let alive = 0;
    for (let i = 0; i < CAPACITY; i++) {
      let life = this.life[i] ?? 0;
      if (life <= 0) {
        this.size[i] = 0;
        continue;
      }
      life -= dt;
      const p = i * 3;
      if (this.kind[i] === 1) {
        // Fireflies wander on lazy sine paths and wink in and out; they
        // die off at dawn or when the player leaves them behind.
        const t = this.clock * 0.7 + (this.phase[i] ?? 0);
        this.position[p] = (this.position[p] ?? 0) + Math.sin(t * 1.3) * dt * 0.9;
        this.position[p + 1] = (this.position[p + 1] ?? 0) + Math.sin(t * 0.9 + 1.7) * dt * 0.35;
        this.position[p + 2] = (this.position[p + 2] ?? 0) + Math.cos(t * 1.1) * dt * 0.9;
        const pulse = 0.5 + 0.5 * Math.sin(t * 3.1);
        const fade = Math.min(1, life, ((this.maxLife[i] ?? 1) - life) * 0.7);
        this.color[i * 4 + 3] = 1 + pulse * pulse * fade * night;
        const dx = (this.position[p] ?? 0) - player.x;
        const dz = (this.position[p + 2] ?? 0) - player.z;
        if (night < 0.4 || dx * dx + dz * dz > 40 * 40) life = Math.min(life, 0.5);
        if (life <= 0) this.fireflies--;
      } else {
        this.velocity[p + 1] = (this.velocity[p + 1] ?? 0) - 16 * dt;
        this.position[p] = (this.position[p] ?? 0) + (this.velocity[p] ?? 0) * dt;
        this.position[p + 1] = (this.position[p + 1] ?? 0) + (this.velocity[p + 1] ?? 0) * dt;
        this.position[p + 2] = (this.position[p + 2] ?? 0) + (this.velocity[p + 2] ?? 0) * dt;
        this.color[i * 4 + 3] = Math.min(1, life * 4);
      }
      this.life[i] = life;
      if (life <= 0) this.size[i] = 0;
      else alive++;
    }

    this.points.visible = alive > 0;
    if (alive === 0) return;
    const g = this.points.geometry;
    (g.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
  }
}

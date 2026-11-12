import * as THREE from "three";
import { BLOCKS } from "../world/blocks";
import { CHUNK_HEIGHT, CHUNK_SIZE } from "../world/coords";
import type { World } from "../world/world";
import { OUTPUT } from "./shaders/common";

/** Rain and snow: a box of streaks (or flakes) that follows the camera,
 * drawn as one instanced mesh. The drops are world-anchored and wrap
 * around the box, so walking through the rain feels like walking through
 * it rather than carrying it along.
 *
 * Nothing falls indoors: a small map of "how high is the roof here" is
 * kept around the player and each drop hides below it. The map is
 * addressed by world position modulo its size, so entries stay valid as
 * the player moves, and it's refreshed a strip at a time. */

const MAX_DROPS = 2600;
const ROOF_SIZE = 32;
const ROOF_COLUMNS_PER_FRAME = 128;

const VERTEX = /* glsl */ `
  in vec3 aSeed;
  uniform float uClock;
  uniform float uSnow;
  uniform vec3 uCamPos;
  uniform vec3 uCamRight;
  uniform vec2 uWind;
  uniform sampler2D uRoof;
  out float vAlpha;

  const vec3 BOX = vec3(28.0, 22.0, 28.0);

  void main() {
    float speed = mix(21.0, 2.6, uSnow) * (0.8 + 0.4 * fract(aSeed.x * 7.31));
    vec3 base = aSeed * BOX;
    base.y -= uClock * speed;
    base.xz += uWind * uClock * mix(1.0, 0.35, uSnow);
    // Flakes wander as they fall.
    base.xz += uSnow * 0.4 * vec2(
      sin(uClock * 1.3 + aSeed.y * 40.0),
      cos(uClock * 1.1 + aSeed.z * 40.0)
    );
    vec3 rel = mod(base - uCamPos, BOX) - BOX * 0.5;
    vec3 center = uCamPos + rel;

    float roof = texelFetch(uRoof, ivec2(mod(floor(center.xz), ${ROOF_SIZE.toFixed(1)})), 0).r * 255.0;
    float open = step(roof, center.y);
    vAlpha = open * (1.0 - smoothstep(10.0, 13.5, length(rel.xz)));

    // A streak leans with the wind; a flake is a small square.
    vec3 fall = normalize(vec3(uWind.x, -speed, uWind.y));
    float len = mix(0.75, 0.07, uSnow);
    float width = mix(0.022, 0.07, uSnow);
    vec3 p = center + uCamRight * (position.x * width) - fall * (position.y * len);
    gl_Position = vAlpha > 0.0 ? projectionMatrix * viewMatrix * vec4(p, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  ${OUTPUT}
  uniform vec3 uDropColor;
  uniform float uOpacity;
  in float vAlpha;
  out vec4 fragColor;
  void main() {
    fragColor = outputColor(uDropColor, vAlpha * uOpacity);
  }
`;

/** 1 for anything a raindrop lands on (everything but air and plants). */
const STOPS_RAIN = new Uint8Array(256);
for (const def of Object.values(BLOCKS)) {
  STOPS_RAIN[def.id] = def.shape === "none" || def.shape === "cross" ? 0 : 1;
}

/** The y just above the highest block at a column, scanning down from
 * `fromY`; 0 if the column is open all the way down or not loaded. */
export function roofHeight(world: World, x: number, z: number, fromY: number): number {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  const buffer = world.getChunkBuffer(cx, cz);
  if (!buffer) return 0;
  const lx = x - cx * CHUNK_SIZE;
  const lz = z - cz * CHUNK_SIZE;
  for (let y = Math.min(CHUNK_HEIGHT - 1, Math.floor(fromY)); y >= 0; y--) {
    const id = buffer[(y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx] ?? 0;
    if (STOPS_RAIN[id] === 1) return y + 1;
  }
  return 0;
}

export class Rain {
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly roof = new Uint8Array(ROOF_SIZE * ROOF_SIZE);
  private readonly roofTexture: THREE.DataTexture;
  private readonly right = new THREE.Vector3();
  private cursor = 0;
  private primed = false;
  private clock = 0;
  private snow = 0;

  constructor(scene: THREE.Scene, direct: boolean) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(MAX_DROPS * 3);
    // A fixed low-discrepancy scatter: evenly spread, identical every run.
    for (let i = 0; i < MAX_DROPS; i++) {
      seeds[i * 3] = (i * 0.754877666) % 1;
      seeds[i * 3 + 1] = (i * 0.569840291) % 1;
      seeds[i * 3 + 2] = (i * 0.362459832) % 1;
    }
    geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 3));
    geometry.instanceCount = 0;
    this.geometry = geometry;

    this.roofTexture = new THREE.DataTexture(
      this.roof,
      ROOF_SIZE,
      ROOF_SIZE,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.roofTexture.minFilter = THREE.NearestFilter;
    this.roofTexture.magFilter = THREE.NearestFilter;
    this.roofTexture.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uClock: { value: 0 },
        uSnow: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uWind: { value: new THREE.Vector2(2.4, 0.9) },
        uRoof: { value: this.roofTexture },
        uDropColor: { value: new THREE.Vector3(1, 1, 1) },
        uOpacity: { value: 0.4 },
        uExposure: { value: 1 },
      },
      defines: direct ? { DIRECT_OUTPUT: "" } : {},
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 25;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Match the renderer's output mode after a quality change. */
  setDirect(direct: boolean): void {
    this.material.defines = direct ? { DIRECT_OUTPUT: "" } : {};
    this.material.needsUpdate = true;
  }

  /** Refreshes a strip of the roof map around the camera. */
  private scanRoof(world: World, camera: THREE.Vector3, columns: number): void {
    const baseX = Math.floor(camera.x) - ROOF_SIZE / 2;
    const baseZ = Math.floor(camera.z) - ROOF_SIZE / 2;
    const fromY = camera.y + 40;
    for (let n = 0; n < columns; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % (ROOF_SIZE * ROOF_SIZE);
      const x = baseX + (i % ROOF_SIZE);
      const z = baseZ + Math.floor(i / ROOF_SIZE);
      const tx = ((x % ROOF_SIZE) + ROOF_SIZE) % ROOF_SIZE;
      const tz = ((z % ROOF_SIZE) + ROOF_SIZE) % ROOF_SIZE;
      this.roof[tz * ROOF_SIZE + tx] = Math.min(255, roofHeight(world, x, z, fromY));
    }
    this.roofTexture.needsUpdate = true;
  }

  /** Whether the camera has a roof (or a canopy) over it. */
  sheltered(camera: THREE.Vector3): boolean {
    const tx = ((Math.floor(camera.x) % ROOF_SIZE) + ROOF_SIZE) % ROOF_SIZE;
    const tz = ((Math.floor(camera.z) % ROOF_SIZE) + ROOF_SIZE) % ROOF_SIZE;
    return (this.roof[tz * ROOF_SIZE + tx] ?? 0) > camera.y;
  }

  update(
    dt: number,
    camera: THREE.PerspectiveCamera,
    world: World,
    /** 0..1; nothing is drawn (or scanned) at 0. */
    intensity: number,
    snowing: boolean,
    light: readonly [number, number, number],
    exposure: number,
  ): void {
    this.clock = (this.clock + dt) % 600;
    this.snow += ((snowing ? 1 : 0) - this.snow) * (1 - Math.exp(-dt * 1.5));
    const active = intensity > 0.01;
    this.mesh.visible = active;
    if (!active) {
      this.primed = false;
      return;
    }
    // The first frame of a shower fills the whole map; after that a strip.
    this.scanRoof(
      world,
      camera.position,
      this.primed ? ROOF_COLUMNS_PER_FRAME : ROOF_SIZE * ROOF_SIZE,
    );
    this.primed = true;

    this.geometry.instanceCount = Math.round(MAX_DROPS * Math.min(1, intensity));
    const u = this.material.uniforms;
    if (u.uClock) u.uClock.value = this.clock;
    if (u.uSnow) u.uSnow.value = this.snow;
    (u.uCamPos?.value as THREE.Vector3).copy(camera.position);
    this.right.setFromMatrixColumn(camera.matrixWorld, 0);
    (u.uCamRight?.value as THREE.Vector3).copy(this.right);
    // Rain is a translucent grey-blue; snow is bright and nearly opaque.
    const tint = 0.55 + 0.45 * this.snow;
    (u.uDropColor?.value as THREE.Vector3).set(
      (light[0] + 0.04) * tint * 0.95,
      (light[1] + 0.04) * tint,
      (light[2] + 0.05) * tint * 1.08,
    );
    if (u.uOpacity) u.uOpacity.value = 0.32 + 0.55 * this.snow;
    if (u.uExposure) u.uExposure.value = exposure;
  }
}

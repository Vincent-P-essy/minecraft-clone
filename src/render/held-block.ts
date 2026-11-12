import * as THREE from "three";
import { BLOCKS, type BlockId } from "../world/blocks";
import { type Face, tileForBlockFace } from "./atlas-layout";
import { OUTPUT } from "./shaders/common";
import type { UniformMap } from "./terrain-material";

/** The block in the player's hand: a small textured cube (or a plant
 * sprite) in the corner of the view that swings when it's used and dips
 * when it's swapped. It's parented to the camera and drawn last, without
 * a depth test, so it can never poke into a wall. */

const VERTEX = /* glsl */ `
  in float layer;
  out vec2 vUv;
  out float vLayer;
  out vec3 vNormal;
  void main() {
    vUv = vec2(uv.x, 1.0 - uv.y);
    vLayer = layer;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;
  uniform sampler2DArray uAtlas;
  uniform vec3 uHandLight;
  uniform float uOpaqueGaps;
  uniform float uGlow;
  ${OUTPUT}
  in vec2 vUv;
  in float vLayer;
  in vec3 vNormal;
  out vec4 fragColor;
  void main() {
    vec4 tex = texture(uAtlas, vec3(vUv, vLayer));
    if (tex.a < 0.5) {
      if (uOpaqueGaps > 0.5) tex.rgb *= 0.28;
      else discard;
    }
    // A fixed key light from the upper left, in view space: the hand is
    // lit like a prop, in the colour and strength of the world's light.
    float key = max(dot(normalize(vNormal), normalize(vec3(-0.45, 0.8, 0.4))), 0.0);
    vec3 color = tex.rgb * uHandLight * (0.5 + 0.65 * key);
    color += tex.rgb * smoothstep(0.75, 1.0, tex.a) * uGlow;
    fragColor = outputColor(color, 1.0);
  }
`;

const BOX_FACES: readonly Face[] = ["east", "west", "top", "bottom", "south", "north"];
const SWING_SECONDS = 0.24;
const SWAP_SECONDS = 0.2;

function cubeGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.setAttribute("layer", new THREE.BufferAttribute(new Float32Array(24), 1));
  return geometry;
}

function crossGeometry(): THREE.BufferGeometry {
  // Two upright quads crossing at the center.
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  for (const [ax, az] of [
    [0.5, 0.5],
    [0.5, -0.5],
  ] as const) {
    positions.push(-ax, -0.5, -az, ax, -0.5, az, ax, 0.5, az, -ax, 0.5, -az);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) normals.push(0, 0.6, 0.8);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("layer", new THREE.BufferAttribute(new Float32Array(8), 1));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return geometry;
}

export class HeldBlock {
  private readonly material: THREE.ShaderMaterial;
  private readonly cube: THREE.Mesh;
  private readonly cross: THREE.Mesh;
  private readonly group = new THREE.Group();
  private readonly camera: THREE.PerspectiveCamera;
  private block: BlockId | null = null;
  private pending: BlockId | null = null;
  private swing = 0;
  private swap = 0;

  constructor(camera: THREE.PerspectiveCamera, shared: UniformMap, direct: boolean) {
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uAtlas: shared.uAtlas ?? { value: null },
        uExposure: shared.uExposure ?? { value: 1 },
        uHandLight: { value: new THREE.Vector3(1, 1, 1) },
        uOpaqueGaps: { value: 0 },
        uGlow: { value: 0 },
      },
      defines: direct ? { DIRECT_OUTPUT: "" } : {},
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.cube = new THREE.Mesh(cubeGeometry(), this.material);
    this.cross = new THREE.Mesh(crossGeometry(), this.material.clone());
    (this.cross.material as THREE.ShaderMaterial).uniforms = this.material.uniforms;
    (this.cross.material as THREE.ShaderMaterial).side = THREE.DoubleSide;
    for (const mesh of [this.cube, this.cross]) {
      mesh.frustumCulled = false;
      mesh.renderOrder = 40;
      mesh.visible = false;
      this.group.add(mesh);
    }
    camera.add(this.group);
  }

  /** Match the renderer's output mode after a quality change. */
  setDirect(direct: boolean): void {
    for (const mesh of [this.cube, this.cross]) {
      const material = mesh.material as THREE.ShaderMaterial;
      material.defines = direct ? { DIRECT_OUTPUT: "" } : {};
      material.needsUpdate = true;
    }
  }

  /** Changes the block shown; the old one dips out and the new one rises. */
  setBlock(block: BlockId): void {
    if (block === this.block || block === this.pending) return;
    if (this.block === null) {
      this.apply(block);
      return;
    }
    this.pending = block;
    this.swap = SWAP_SECONDS * 2;
  }

  private apply(block: BlockId): void {
    this.block = block;
    const def = BLOCKS[block];
    const isCross = def.shape === "cross";
    this.cube.visible = !isCross;
    this.cross.visible = isCross;
    const mesh = isCross ? this.cross : this.cube;
    const layers = mesh.geometry.getAttribute("layer") as THREE.BufferAttribute;
    if (isCross) {
      for (let i = 0; i < 8; i++) layers.setX(i, tileForBlockFace(block, "north"));
    } else {
      BOX_FACES.forEach((face, f) => {
        for (let i = 0; i < 4; i++) layers.setX(f * 4 + i, tileForBlockFace(block, face));
      });
    }
    layers.needsUpdate = true;
    const u = this.material.uniforms;
    if (u.uOpaqueGaps) u.uOpaqueGaps.value = def.sway === "leaves" ? 1 : 0;
    if (u.uGlow) u.uGlow.value = def.emission > 0 ? 2.2 : 0;
  }

  /** Plays the use animation (a block was broken or placed). */
  use(): void {
    this.swing = SWING_SECONDS;
  }

  update(
    dt: number,
    bob: { x: number; y: number },
    light: readonly [number, number, number],
    visible: boolean,
  ): void {
    this.group.visible = visible && this.block !== null;
    if (!this.group.visible) return;
    (this.material.uniforms.uHandLight?.value as THREE.Vector3).set(light[0], light[1], light[2]);

    this.swing = Math.max(0, this.swing - dt);
    let dip = 0;
    if (this.swap > 0) {
      const before = this.swap;
      this.swap = Math.max(0, this.swap - dt);
      // Halfway through, out of sight, the block actually changes.
      if (before > SWAP_SECONDS && this.swap <= SWAP_SECONDS && this.pending !== null) {
        this.apply(this.pending);
        this.pending = null;
      }
      dip = 1 - Math.abs(this.swap - SWAP_SECONDS) / SWAP_SECONDS;
    }

    const arc = Math.sin((1 - this.swing / SWING_SECONDS) * Math.PI) * (this.swing > 0 ? 1 : 0);
    // Tuck the hand in on narrow (portrait) screens so it stays in view.
    const x = Math.max(0.2, Math.min(0.74, 0.42 * this.camera.aspect));
    this.group.position.set(
      x + bob.x * 0.6 - arc * 0.12,
      -0.4 + bob.y * 0.6 - dip * 0.55 - arc * 0.06,
      -0.95 - arc * 0.22,
    );
    this.group.rotation.set(0.12 - arc * 0.95, 0.62 + arc * 0.25, 0.04);
    this.group.scale.setScalar(0.3);
  }
}

import * as THREE from "three";
import type { Environment, Vec3Tuple } from "./environment";
import { PostPipeline } from "./post";
import { ShadowPass } from "./shadow-pass";
import { createSkyDome } from "./sky-dome";
import {
  createDepthMaterial,
  createTerrainMaterial,
  createWaterMaterial,
  type UniformMap,
} from "./terrain-material";
import { createBlockTextureArray, createNoiseTexture } from "./texture-atlas";
import { CHUNK_SIZE } from "../world/coords";

export type QualityLevel = "low" | "medium" | "high" | "ultra";

export const QUALITY_LEVELS: readonly QualityLevel[] = ["low", "medium", "high", "ultra"];

/** What each tier turns on. The low tier draws straight to the screen with
 * no extra full-screen passes at all — that's the one for weak phones. */
export interface QualityProfile {
  readonly post: boolean;
  readonly bloom: boolean;
  readonly godRays: boolean;
  readonly msaa: number;
  readonly fxaa: boolean;
  /** Shadow map resolution; 0 disables shadow mapping. */
  readonly shadowSize: number;
  /** Half-width of the shadowed area around the player, in blocks. */
  readonly shadowExtent: number;
  readonly maxPixelRatio: number;
  readonly anisotropy: number;
}

export const QUALITY_PROFILES: Readonly<Record<QualityLevel, QualityProfile>> = {
  low: {
    post: false,
    bloom: false,
    godRays: false,
    msaa: 0,
    fxaa: false,
    shadowSize: 0,
    shadowExtent: 0,
    maxPixelRatio: 1.5,
    anisotropy: 1,
  },
  medium: {
    post: true,
    bloom: true,
    godRays: false,
    msaa: 0,
    fxaa: true,
    shadowSize: 1024,
    shadowExtent: 40,
    maxPixelRatio: 1.5,
    anisotropy: 2,
  },
  high: {
    post: true,
    bloom: true,
    godRays: true,
    msaa: 4,
    fxaa: false,
    shadowSize: 2048,
    shadowExtent: 64,
    maxPixelRatio: 2,
    anisotropy: 4,
  },
  ultra: {
    post: true,
    bloom: true,
    godRays: true,
    msaa: 4,
    fxaa: false,
    shadowSize: 4096,
    shadowExtent: 96,
    maxPixelRatio: 2,
    anisotropy: 8,
  },
};

/** Render-scale ladder for the adaptive quality controller, as fractions
 * of the tier's pixel ratio. */
const SCALE_LADDER = [0.5, 0.6, 0.72, 0.85, 1.0] as const;
const ADAPT_WINDOW_FRAMES = 90;
// Biased toward frame rate: step the render scale down before frames drift
// past ~20ms (~50fps), so phones stay fluid.
const ADAPT_SLOW_MS = 20;
const ADAPT_FAST_MS = 11.5;

const WATER_SHALLOW: Vec3Tuple = [0.07, 0.36, 0.4];
const WATER_DEEP: Vec3Tuple = [0.012, 0.085, 0.2];
const BLOCK_LIGHT: Vec3Tuple = [1.55, 1.2, 0.86];
const CLOUD_DRIFT: readonly [number, number] = [3.2, 1.1]; // blocks per second

function setVec(uniform: THREE.IUniform | undefined, v: Vec3Tuple): void {
  (uniform?.value as THREE.Vector3 | undefined)?.set(v[0], v[1], v[2]);
}

/** Owns the WebGL renderer, the scene, the materials and the frame's pass
 * structure: shadow map -> world (into an HDR target when the tier has
 * post-processing) -> post chain. No voxel-specific knowledge lives here —
 * ChunkMeshManager adds and removes chunk meshes into `scene`. */
export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly uniforms: UniformMap;

  terrainMaterial: THREE.ShaderMaterial;
  waterMaterial: THREE.ShaderMaterial;
  private depthMaterial: THREE.ShaderMaterial;
  private sky: THREE.Mesh | null = null;
  private post: PostPipeline | null = null;
  private shadow: ShadowPass | null = null;

  private quality: QualityLevel;
  private profile: QualityProfile;
  private readonly hdrCapable: boolean;
  private viewDistance: number;
  private width: number;
  private height: number;

  private scaleIndex = SCALE_LADDER.length - 1;
  private frameMsEma = 16;
  private framesSinceChange = 0;
  /** Lets a caller pin the render scale (screenshots, benchmarks). */
  adaptive = true;

  private time = 0;
  private underwater = false;
  private environment: Environment | null = null;
  private readonly lightDir = new THREE.Vector3(0.3, 0.8, 0.5);
  private readonly sunScreen = new THREE.Vector2(0.5, 0.5);
  private readonly sunColor = new THREE.Color();
  private readonly scratch = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private sunFacing = 0;

  /** Called after materials are rebuilt (quality change) so chunk meshes
   * can be pointed at the new ones. */
  onMaterialsChanged: (() => void) | undefined;

  constructor(parent: HTMLElement, seed: number, quality: QualityLevel, viewDistance: number) {
    this.quality = quality;
    this.profile = QUALITY_PROFILES[quality];
    this.viewDistance = viewDistance;
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: "high-performance",
      failIfMajorPerformanceCaveat: false,
    });
    // WebGL1-only devices take the CPU renderer path instead: everything
    // here (texture arrays, integer attributes) needs WebGL2.
    if (!context) throw new Error("WebGL2 is not available");
    this.renderer = new THREE.WebGLRenderer({ canvas, context });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false;
    this.hdrCapable =
      this.renderer.extensions.has("EXT_color_buffer_float") ||
      this.renderer.extensions.has("EXT_color_buffer_half_float");
    parent.prepend(canvas);

    this.camera = new THREE.PerspectiveCamera(75, this.width / this.height, 0.08, 600);

    const vec3 = (): THREE.IUniform => ({ value: new THREE.Vector3() });
    this.uniforms = {
      uTime: { value: 0 },
      uAtlas: {
        value: createBlockTextureArray(
          seed,
          Math.min(this.profile.anisotropy, this.renderer.capabilities.getMaxAnisotropy()),
        ),
      },
      uNoise: { value: createNoiseTexture(seed) },
      uSunDir: vec3(),
      uMoonDir: vec3(),
      uSunColor: vec3(),
      uSkyZenith: vec3(),
      uSkyHorizon: vec3(),
      uSunGlow: vec3(),
      uFogTint: vec3(),
      uFogDensity: { value: 0.01 },
      uFogStart: { value: 80 },
      uFogEnd: { value: 140 },
      uUnderwater: { value: 0 },
      uCave: { value: 0 },
      uWet: { value: 0 },
      uExposure: { value: 1 },
      uLightDir: vec3(),
      uLightColor: vec3(),
      uAmbientSky: vec3(),
      uAmbientGround: vec3(),
      uBlockLight: { value: new THREE.Vector3(...BLOCK_LIGHT) },
      uMinAmbient: { value: 0.018 },
      uShadowStrength: { value: 1 },
      uShadowMap: { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uShadowTexel: { value: 1 / 2048 },
      uCloudOffset: { value: new THREE.Vector2() },
      uCloudCover: { value: 0.46 },
      uWaterShallow: { value: new THREE.Vector3(...WATER_SHALLOW) },
      uWaterDeep: { value: new THREE.Vector3(...WATER_DEEP) },
      uInvProjection: { value: new THREE.Matrix4() },
      uCameraWorld: { value: new THREE.Matrix4() },
      uStars: { value: 0 },
      uCloudLit: vec3(),
      uCloudDark: vec3(),
    };

    this.depthMaterial = createDepthMaterial(this.uniforms);
    const options = { direct: this.direct, shadows: this.profile.shadowSize > 0 };
    this.terrainMaterial = createTerrainMaterial(this.uniforms, options);
    this.waterMaterial = createWaterMaterial(this.uniforms, options);
    this.applyProfile(false);
    this.applyViewDistance();
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get qualityLevel(): QualityLevel {
    return this.quality;
  }

  /** Whether this device can run the tiers that need an HDR target. */
  get supportsPost(): boolean {
    return this.hdrCapable;
  }

  private get direct(): boolean {
    return !this.profile.post || !this.hdrCapable;
  }

  private pixelRatio(): number {
    const base = Math.min(window.devicePixelRatio || 1, this.profile.maxPixelRatio);
    return base * (SCALE_LADDER[this.scaleIndex] ?? 1);
  }

  /** (Re)builds everything that depends on the quality tier. */
  private applyProfile(rebuildMaterials = true): void {
    const direct = this.direct;
    const shadows = this.profile.shadowSize > 0;

    if (rebuildMaterials) {
      this.terrainMaterial.dispose();
      this.waterMaterial.dispose();
      this.terrainMaterial = createTerrainMaterial(this.uniforms, { direct, shadows });
      this.waterMaterial = createWaterMaterial(this.uniforms, { direct, shadows });
    }

    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky.geometry.dispose();
      (this.sky.material as THREE.Material).dispose();
    }
    this.sky = createSkyDome(this.uniforms, direct);
    this.scene.add(this.sky);

    this.shadow?.dispose();
    this.shadow = shadows
      ? new ShadowPass(
          Math.min(this.profile.shadowSize, this.renderer.capabilities.maxTextureSize),
          this.profile.shadowExtent,
        )
      : null;
    if (this.uniforms.uShadowMap) this.uniforms.uShadowMap.value = this.shadow?.texture ?? null;
    if (this.uniforms.uShadowTexel && this.shadow) {
      this.uniforms.uShadowTexel.value = this.shadow.texelSize;
    }

    const atlas = this.uniforms.uAtlas?.value as THREE.Texture | undefined;
    if (atlas) {
      atlas.anisotropy = Math.min(
        this.profile.anisotropy,
        this.renderer.capabilities.getMaxAnisotropy(),
      );
      atlas.needsUpdate = true;
    }

    this.applySize();
    this.onMaterialsChanged?.();
  }

  /** Sizes the canvas and (re)allocates the post chain to match. */
  private applySize(): void {
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(this.width, this.height);
    this.post?.dispose();
    this.post = null;
    if (!this.direct) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.post = new PostPipeline(size.x, size.y, {
        samples: this.profile.msaa,
        bloom: this.profile.bloom,
        godRays: this.profile.godRays,
        fxaa: this.profile.fxaa,
      });
    }
  }

  private applyViewDistance(): void {
    const end = (this.viewDistance - 0.5) * CHUNK_SIZE;
    if (this.uniforms.uFogEnd) this.uniforms.uFogEnd.value = end;
    if (this.uniforms.uFogStart) this.uniforms.uFogStart.value = end * 0.66;
    this.baseFogDensity = 1.1 / end;
    if (this.uniforms.uFogDensity) {
      this.uniforms.uFogDensity.value = this.baseFogDensity * this.fogThickening;
    }
    this.camera.far = Math.max(end + 48, 320);
    this.camera.updateProjectionMatrix();
  }

  setQuality(level: QualityLevel): void {
    if (level === this.quality) return;
    this.quality = level;
    this.profile = QUALITY_PROFILES[level];
    this.scaleIndex = SCALE_LADDER.length - 1;
    this.framesSinceChange = 0;
    this.applyProfile();
  }

  /** Visible distance in chunks; fog closes just inside it. */
  setViewDistance(chunks: number): void {
    this.viewDistance = chunks;
    this.applyViewDistance();
  }

  setFov(degrees: number): void {
    if (Math.abs(this.camera.fov - degrees) < 0.01) return;
    this.camera.fov = degrees;
    this.camera.updateProjectionMatrix();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.applySize();
  }

  /** Feed each frame's duration; the render scale steps up and down a
   * ladder to hold a fluid frame rate on fill-rate-bound (mobile) GPUs. */
  tickAdaptive(frameMs: number): void {
    if (!this.adaptive) return;
    this.frameMsEma = this.frameMsEma * 0.92 + frameMs * 0.08;
    this.framesSinceChange++;
    if (this.framesSinceChange < ADAPT_WINDOW_FRAMES) return;
    if (this.frameMsEma > ADAPT_SLOW_MS && this.scaleIndex > 0) {
      this.scaleIndex--;
    } else if (this.frameMsEma < ADAPT_FAST_MS && this.scaleIndex < SCALE_LADDER.length - 1) {
      this.scaleIndex++;
    } else {
      return;
    }
    this.framesSinceChange = 0;
    this.applySize();
  }

  /** Pins the render scale to full resolution. */
  lockFullResolution(): void {
    this.adaptive = false;
    if (this.scaleIndex !== SCALE_LADDER.length - 1) {
      this.scaleIndex = SCALE_LADDER.length - 1;
      this.applySize();
    }
  }

  get renderScale(): number {
    return SCALE_LADDER[this.scaleIndex] ?? 1;
  }

  private baseFogDensity = 0.007;
  private fogThickening = 1;

  /** Cloud cover, rain haze and wet ground for the current weather. */
  setWeather(overcast: number, rain: number): void {
    const u = this.uniforms;
    if (u.uCloudCover) u.uCloudCover.value = 0.46 + 0.42 * overcast;
    this.fogThickening = 1 + 1.7 * rain + 0.3 * overcast;
    if (u.uFogDensity) u.uFogDensity.value = this.baseFogDensity * this.fogThickening;
    if (u.uWet) u.uWet.value = rain;
  }

  /** 0 = open air, 1 = deep underground (see the fog in shaders/common.ts). */
  setCaveFactor(factor: number): void {
    if (this.uniforms.uCave) this.uniforms.uCave.value = factor;
  }

  /** Copies the time of day into the shared uniforms. */
  setEnvironment(env: Environment, timeSeconds: number, underwater: boolean): void {
    const u = this.uniforms;
    this.environment = env;
    this.time = timeSeconds;
    this.underwater = underwater;

    if (u.uTime) u.uTime.value = timeSeconds % 3600;
    setVec(u.uSunDir, env.sunDir);
    setVec(u.uMoonDir, env.moonDir);
    setVec(u.uSunColor, env.sunColor);
    setVec(u.uSkyZenith, env.skyZenith);
    setVec(u.uSkyHorizon, env.skyHorizon);
    setVec(u.uSunGlow, env.sunGlow);
    setVec(u.uLightDir, env.lightDir);
    setVec(u.uLightColor, env.lightColor);
    setVec(u.uAmbientSky, env.ambientSky);
    setVec(u.uAmbientGround, env.ambientGround);
    if (u.uShadowStrength) u.uShadowStrength.value = env.shadowStrength;
    if (u.uExposure) u.uExposure.value = env.exposure;
    if (u.uStars) u.uStars.value = env.starVisibility;
    if (u.uUnderwater) u.uUnderwater.value = underwater ? 1 : 0;

    // Underwater, the fog is the water itself, lit by whatever is above.
    const glow = 0.25 + (env.ambientSky[1] + env.lightColor[1] * 0.25) * 0.9;
    setVec(u.uFogTint, [0.02 * glow, 0.2 * glow, 0.3 * glow]);

    // Clouds catch the light on top and the sky's colour underneath.
    const lit: Vec3Tuple = [
      env.lightColor[0] * 0.42 + env.ambientSky[0] * 0.5,
      env.lightColor[1] * 0.42 + env.ambientSky[1] * 0.5,
      env.lightColor[2] * 0.42 + env.ambientSky[2] * 0.5,
    ];
    const dark: Vec3Tuple = [
      env.ambientSky[0] * 0.55 + env.skyHorizon[0] * 0.2 + 0.004,
      env.ambientSky[1] * 0.55 + env.skyHorizon[1] * 0.2 + 0.005,
      env.ambientSky[2] * 0.55 + env.skyHorizon[2] * 0.2 + 0.008,
    ];
    setVec(u.uCloudLit, lit);
    setVec(u.uCloudDark, dark);
    (u.uCloudOffset?.value as THREE.Vector2).set(
      timeSeconds * CLOUD_DRIFT[0],
      timeSeconds * CLOUD_DRIFT[1],
    );

    this.lightDir.set(env.lightDir[0], env.lightDir[1], env.lightDir[2]);
    this.sunColor.setRGB(env.sunColor[0], env.sunColor[1], env.sunColor[2]);
  }

  render(): void {
    const { renderer, camera, uniforms: u } = this;
    renderer.info.reset();
    camera.updateMatrixWorld();
    (u.uInvProjection?.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uCameraWorld?.value as THREE.Matrix4).copy(camera.matrixWorld);

    const env = this.environment;
    if (this.shadow && env && env.shadowStrength > 0.01 && !this.underwater) {
      this.shadow.update(this.lightDir, camera);
      (u.uShadowMatrix?.value as THREE.Matrix4).copy(this.shadow.matrix);
      this.shadow.render(renderer, this.scene, this.depthMaterial);
    }

    if (!this.post) {
      renderer.setRenderTarget(null);
      renderer.render(this.scene, camera);
      return;
    }

    renderer.setRenderTarget(this.post.sceneTarget);
    renderer.render(this.scene, camera);

    // Where the sun sits on screen, for the god rays.
    this.sunFacing = 0;
    if (env) {
      camera.getWorldDirection(this.forward);
      const facing = this.forward.dot(
        this.scratch.set(env.sunDir[0], env.sunDir[1], env.sunDir[2]),
      );
      if (facing > 0) {
        this.scratch.multiplyScalar(500).add(camera.position).project(camera);
        this.sunScreen.set(this.scratch.x * 0.5 + 0.5, this.scratch.y * 0.5 + 0.5);
        this.sunFacing = Math.min(1, facing * 1.6) * (1 - env.night);
      }
    }
    this.post.render(renderer, {
      time: this.time % 3600,
      exposure: env?.exposure ?? 1,
      underwater: this.underwater,
      sunScreen: this.sunScreen,
      sunFacing: this.sunFacing,
      sunColor: this.sunColor,
    });
  }

  /** Draw calls and triangles of the last frame, for the debug HUD. */
  stats(): { calls: number; triangles: number } {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  dispose(): void {
    this.post?.dispose();
    this.shadow?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

import * as THREE from "three";
import { createFullscreenGeometry } from "./sky-dome";
import { FULLSCREEN_VERTEX, OUTPUT } from "./shaders/common";

/** The HDR post-processing chain, hand-rolled so each tier pays only for
 * what it uses:
 *
 *   scene (linear HDR, optionally MSAA)
 *     -> bloom: bright-pass, dual-filter down/up chain
 *     -> god rays: radial blur of the visible sky toward the sun
 *     -> composite: add both, underwater treatment, ACES tone map, grade,
 *        vignette, dither
 *     -> FXAA (only when the scene target isn't multisampled)
 */

export interface PostOptions {
  readonly samples: number;
  readonly bloom: boolean;
  readonly godRays: boolean;
  readonly fxaa: boolean;
}

export interface PostFrame {
  readonly time: number;
  readonly exposure: number;
  readonly underwater: boolean;
  /** Sun position in screen UV space, and how much of it faces the camera. */
  readonly sunScreen: THREE.Vector2;
  readonly sunFacing: number;
  readonly sunColor: THREE.Color;
}

const BLOOM_LEVELS = 5;

const PREFILTER_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uSource;
  uniform vec2 uTexel;
  in vec2 vUv;
  out vec4 fragColor;
  void main() {
    vec3 c = texture(uSource, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
    c += texture(uSource, vUv + uTexel * vec2(0.5, -0.5)).rgb;
    c += texture(uSource, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
    c += texture(uSource, vUv + uTexel * vec2(0.5, 0.5)).rgb;
    c *= 0.25;
    // Soft knee: only what's brighter than paper white blooms, and it
    // ramps in instead of switching on.
    float brightness = max(c.r, max(c.g, c.b));
    float knee = clamp((brightness - 1.25) / 1.75, 0.0, 1.0);
    fragColor = vec4(min(c * knee * knee, vec3(24.0)), 1.0);
  }
`;

const DOWN_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uSource;
  uniform vec2 uTexel;
  in vec2 vUv;
  out vec4 fragColor;
  void main() {
    vec3 c = texture(uSource, vUv).rgb * 4.0;
    c += texture(uSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    c += texture(uSource, vUv + uTexel * vec2(1.0, -1.0)).rgb;
    c += texture(uSource, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
    c += texture(uSource, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    fragColor = vec4(c / 8.0, 1.0);
  }
`;

const UP_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uSource;
  uniform sampler2D uBase;
  uniform vec2 uTexel;
  in vec2 vUv;
  out vec4 fragColor;
  void main() {
    vec3 c = texture(uSource, vUv + uTexel * vec2(-2.0, 0.0)).rgb;
    c += texture(uSource, vUv + uTexel * vec2(2.0, 0.0)).rgb;
    c += texture(uSource, vUv + uTexel * vec2(0.0, -2.0)).rgb;
    c += texture(uSource, vUv + uTexel * vec2(0.0, 2.0)).rgb;
    c += texture(uSource, vUv + uTexel * vec2(-1.0, 1.0)).rgb * 2.0;
    c += texture(uSource, vUv + uTexel * vec2(1.0, 1.0)).rgb * 2.0;
    c += texture(uSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb * 2.0;
    c += texture(uSource, vUv + uTexel * vec2(1.0, -1.0)).rgb * 2.0;
    fragColor = vec4(c / 12.0 + texture(uBase, vUv).rgb, 1.0);
  }
`;

const RAYS_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene;
  uniform sampler2D uDepth;
  uniform vec2 uSun;
  uniform float uStrength;
  uniform vec3 uSunColor;
  in vec2 vUv;
  out vec4 fragColor;

  const int STEPS = 28;

  void main() {
    vec2 delta = (uSun - vUv) / float(STEPS) * 0.92;
    vec2 uv = vUv;
    float decay = 1.0;
    float sum = 0.0;
    for (int i = 0; i < STEPS; i++) {
      // Only open sky lets light through; terrain and trees cut the shafts.
      float sky = step(0.99999, texture(uDepth, uv).r);
      // Only the sun and its halo are bright enough to throw shafts.
      float glow = max(dot(texture(uScene, uv).rgb, vec3(0.3, 0.5, 0.2)) - 1.4, 0.0);
      sum += sky * min(glow, 6.0) * decay;
      decay *= 0.955;
      uv += delta;
    }
    float falloff = exp(-distance(vUv, uSun) * 1.5);
    fragColor = vec4(uSunColor * (sum / float(STEPS)) * uStrength * falloff, 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform sampler2D uRays;
  uniform float uBloomStrength;
  uniform float uRayStrength;
  uniform float uUnderwater;
  uniform float uTime;
  ${OUTPUT}
  in vec2 vUv;
  out vec4 fragColor;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec2 uv = vUv;
    if (uUnderwater > 0.5) {
      uv += vec2(sin(uv.y * 34.0 + uTime * 2.1), cos(uv.x * 29.0 + uTime * 1.7)) * 0.0014;
    }
    vec3 hdr = texture(uScene, uv).rgb;
    hdr += texture(uBloom, uv).rgb * uBloomStrength;
    hdr += texture(uRays, uv).rgb * uRayStrength;
    if (uUnderwater > 0.5) hdr *= vec3(0.62, 0.88, 1.0);

    vec3 col = toDisplay(hdr);

    vec2 q = vUv - 0.5;
    col *= 1.0 - smoothstep(0.25, 1.1, dot(q, q) * 2.2) * 0.42;
    col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
    fragColor = vec4(col, 1.0);
  }
`;

/** FXAA 3.11, the compact console variant: cheap edge smoothing for tiers
 * that skip MSAA. */
const FXAA_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uSource;
  uniform vec2 uTexel;
  in vec2 vUv;
  out vec4 fragColor;

  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  void main() {
    vec3 rgbM = texture(uSource, vUv).rgb;
    float lumaNW = luma(texture(uSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb);
    float lumaNE = luma(texture(uSource, vUv + uTexel * vec2(1.0, -1.0)).rgb);
    float lumaSW = luma(texture(uSource, vUv + uTexel * vec2(-1.0, 1.0)).rgb);
    float lumaSE = luma(texture(uSource, vUv + uTexel * vec2(1.0, 1.0)).rgb);
    float lumaM = luma(rgbM);
    float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
    float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));

    vec2 dir = vec2(
      -((lumaNW + lumaNE) - (lumaSW + lumaSE)),
      (lumaNW + lumaSW) - (lumaNE + lumaSE)
    );
    float reduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.03125, 1.0 / 128.0);
    float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
    dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * uTexel;

    vec3 a = 0.5 * (
      texture(uSource, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
      texture(uSource, vUv + dir * (2.0 / 3.0 - 0.5)).rgb
    );
    vec3 b = a * 0.5 + 0.25 * (
      texture(uSource, vUv + dir * -0.5).rgb +
      texture(uSource, vUv + dir * 0.5).rgb
    );
    float lumaB = luma(b);
    fragColor = vec4((lumaB < lumaMin || lumaB > lumaMax) ? a : b, 1.0);
  }
`;

function pass(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
}

function hdrTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
}

export class PostPipeline {
  /** Render the world into this. */
  readonly sceneTarget: THREE.WebGLRenderTarget;
  private readonly options: PostOptions;
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.Camera();

  private readonly down: THREE.WebGLRenderTarget[] = [];
  private readonly up: THREE.WebGLRenderTarget[] = [];
  private readonly raysTarget: THREE.WebGLRenderTarget;
  private readonly ldrTarget: THREE.WebGLRenderTarget | null;
  private readonly black: THREE.DataTexture;

  private readonly prefilter = pass(PREFILTER_FRAGMENT, {
    uSource: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
  private readonly downPass = pass(DOWN_FRAGMENT, {
    uSource: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
  private readonly upPass = pass(UP_FRAGMENT, {
    uSource: { value: null },
    uBase: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
  private readonly raysPass = pass(RAYS_FRAGMENT, {
    uScene: { value: null },
    uDepth: { value: null },
    uSun: { value: new THREE.Vector2() },
    uStrength: { value: 0 },
    uSunColor: { value: new THREE.Color() },
  });
  private readonly composite = pass(COMPOSITE_FRAGMENT, {
    uScene: { value: null },
    uBloom: { value: null },
    uRays: { value: null },
    uBloomStrength: { value: 0.55 },
    uRayStrength: { value: 1 },
    uUnderwater: { value: 0 },
    uTime: { value: 0 },
    uExposure: { value: 1 },
  });
  private readonly fxaa = pass(FXAA_FRAGMENT, {
    uSource: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });

  constructor(width: number, height: number, options: PostOptions) {
    this.options = options;
    this.quad = new THREE.Mesh(createFullscreenGeometry(), this.composite);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    const depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    this.sceneTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture,
      samples: options.samples,
      generateMipmaps: false,
    });

    let w = width;
    let h = height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      w = Math.max(2, w >> 1);
      h = Math.max(2, h >> 1);
      this.down.push(hdrTarget(w, h));
      this.up.push(hdrTarget(w, h));
    }
    this.raysTarget = hdrTarget(width >> 2, height >> 2);
    this.ldrTarget = options.fxaa
      ? new THREE.WebGLRenderTarget(width, height, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: false,
          generateMipmaps: false,
        })
      : null;

    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;
  }

  private draw(
    renderer: THREE.WebGLRenderer,
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | null,
  ): void {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.quadScene, this.quadCamera);
  }

  /** Runs the chain on whatever was rendered into `sceneTarget` and
   * presents the result to the screen. */
  render(renderer: THREE.WebGLRenderer, frame: PostFrame): void {
    const scene = this.sceneTarget.texture;
    let bloomTexture: THREE.Texture = this.black;
    let raysTexture: THREE.Texture = this.black;

    if (this.options.bloom) {
      const first = this.down[0];
      if (first) {
        const u = this.prefilter.uniforms;
        if (u.uSource) u.uSource.value = scene;
        (u.uTexel?.value as THREE.Vector2).set(
          1 / this.sceneTarget.width,
          1 / this.sceneTarget.height,
        );
        this.draw(renderer, this.prefilter, first);
      }
      for (let i = 1; i < BLOOM_LEVELS; i++) {
        const source = this.down[i - 1];
        const target = this.down[i];
        if (!source || !target) continue;
        const u = this.downPass.uniforms;
        if (u.uSource) u.uSource.value = source.texture;
        (u.uTexel?.value as THREE.Vector2).set(1 / source.width, 1 / source.height);
        this.draw(renderer, this.downPass, target);
      }
      let previous = this.down[BLOOM_LEVELS - 1];
      for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
        const base = this.down[i];
        const target = this.up[i];
        if (!previous || !base || !target) continue;
        const u = this.upPass.uniforms;
        if (u.uSource) u.uSource.value = previous.texture;
        if (u.uBase) u.uBase.value = base.texture;
        (u.uTexel?.value as THREE.Vector2).set(0.5 / previous.width, 0.5 / previous.height);
        this.draw(renderer, this.upPass, target);
        previous = target;
      }
      if (previous) bloomTexture = previous.texture;
    }

    if (this.options.godRays && frame.sunFacing > 0.01 && !frame.underwater) {
      const u = this.raysPass.uniforms;
      if (u.uScene) u.uScene.value = scene;
      if (u.uDepth) u.uDepth.value = this.sceneTarget.depthTexture;
      (u.uSun?.value as THREE.Vector2).copy(frame.sunScreen);
      if (u.uStrength) u.uStrength.value = frame.sunFacing * 0.5;
      (u.uSunColor?.value as THREE.Color).copy(frame.sunColor);
      this.draw(renderer, this.raysPass, this.raysTarget);
      raysTexture = this.raysTarget.texture;
    }

    const c = this.composite.uniforms;
    if (c.uScene) c.uScene.value = scene;
    if (c.uBloom) c.uBloom.value = bloomTexture;
    if (c.uRays) c.uRays.value = raysTexture;
    if (c.uUnderwater) c.uUnderwater.value = frame.underwater ? 1 : 0;
    if (c.uTime) c.uTime.value = frame.time;
    if (c.uExposure) c.uExposure.value = frame.exposure;

    if (this.ldrTarget) {
      this.draw(renderer, this.composite, this.ldrTarget);
      const f = this.fxaa.uniforms;
      if (f.uSource) f.uSource.value = this.ldrTarget.texture;
      (f.uTexel?.value as THREE.Vector2).set(1 / this.ldrTarget.width, 1 / this.ldrTarget.height);
      this.draw(renderer, this.fxaa, null);
    } else {
      this.draw(renderer, this.composite, null);
    }
  }

  dispose(): void {
    this.sceneTarget.depthTexture?.dispose();
    this.sceneTarget.dispose();
    for (const target of [...this.down, ...this.up]) target.dispose();
    this.raysTarget.dispose();
    this.ldrTarget?.dispose();
    this.black.dispose();
    this.quad.geometry.dispose();
    for (const material of [
      this.prefilter,
      this.downPass,
      this.upPass,
      this.raysPass,
      this.composite,
      this.fxaa,
    ]) {
      material.dispose();
    }
  }
}

import * as THREE from "three";
import { FOG_FAR, FOG_NEAR } from "./scene";
import type { CpuSkyState } from "./cpu-renderer";

/** The chunk shader: samples a WebGL2 texture array (one layer per tile)
 * with a repeating UV so greedy-merged quads tile correctly, then applies
 * the baked per-vertex directional shade × AO, a sun-direction diffuse
 * term that tracks the day/night cycle, and linear distance fog. One draw
 * call per chunk, no atlas bleeding, far fewer triangles than per-face
 * meshing. */

const vertexShader = /* glsl */ `
  in float layer;
  in vec3 shadeColor;
  out vec2 vUv;
  out float vLayer;
  out vec3 vShade;
  out vec3 vNormal;
  out float vFogDepth;

  void main() {
    vUv = uv;
    vLayer = layer;
    vShade = shadeColor;
    // Chunk meshes are translation-only, so the object-space normal is
    // already the world normal.
    vNormal = normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;

  uniform sampler2DArray uAtlas;
  uniform vec3 uSunDir;
  uniform float uSunIntensity;
  uniform float uAmbient;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  in vec2 vUv;
  in float vLayer;
  in vec3 vShade;
  in vec3 vNormal;
  in float vFogDepth;

  out vec4 fragColor;

  void main() {
    vec4 tex = texture(uAtlas, vec3(fract(vUv), vLayer));
    if (tex.a < 0.05) discard;
    float diffuse = uAmbient + uSunIntensity * max(dot(normalize(vNormal), uSunDir), 0.0);
    vec3 rgb = tex.rgb * vShade * diffuse;
    float fog = clamp((vFogDepth - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
    rgb = mix(rgb, uFogColor, fog);
    fragColor = vec4(rgb, tex.a);
  }
`;

export function createChunkMaterial(atlasArray: THREE.DataArrayTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    uniforms: {
      uAtlas: { value: atlasArray },
      uSunDir: { value: new THREE.Vector3(0.4, 0.85, 0.28).normalize() },
      uSunIntensity: { value: 0.85 },
      uAmbient: { value: 0.55 },
      uFogColor: { value: new THREE.Color(0x87ceeb) },
      uFogNear: { value: FOG_NEAR },
      uFogFar: { value: FOG_FAR },
    },
    vertexShader,
    fragmentShader,
  });
}

/** Feeds the day/night sky state into the chunk shader each frame — sun
 * direction along its arc, sun/ambient strength, and the fog color that
 * matches the sky. Mirrors the CPU renderer's lighting so the two look
 * alike. */
export function updateChunkMaterial(material: THREE.ShaderMaterial, sky: CpuSkyState): void {
  const u = material.uniforms;
  const angle = sky.sunAngle;
  const dir = u.uSunDir?.value as THREE.Vector3 | undefined;
  dir?.set(Math.cos(angle), Math.max(Math.sin(angle), 0.12), 0.28).normalize();
  // The baked shade already carries most of the face lighting; the sun term
  // adds the moving directional highlight on top, scaled down so faces
  // never blow out at noon.
  const day = sky.sunIntensity / 1.7;
  if (u.uSunIntensity) u.uSunIntensity.value = 0.3 + 0.22 * day;
  if (u.uAmbient) u.uAmbient.value = 0.5 + 0.28 * day;
  const fog = u.uFogColor?.value as THREE.Color | undefined;
  fog?.setRGB(sky.skyColor[0], sky.skyColor[1], sky.skyColor[2]);
}

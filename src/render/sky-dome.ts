import * as THREE from "three";
import type { UniformMap } from "./terrain-material";
import { ATMOSPHERE, CLOUDS, FULLSCREEN_VERTEX, OUTPUT } from "./shaders/common";

/** The sky, drawn as one full-screen triangle behind everything: the
 * analytic gradient the fog and water also use, a sun and moon, twinkling
 * stars, and a layer of soft clouds lit from the sun's side. No geometry
 * to cull, no skybox textures to ship. */

const SKY_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform mat4 uInvProjection;
  uniform mat4 uCameraWorld;
  uniform float uTime;
  uniform float uStars;
  uniform vec3 uLightDir;
  uniform vec3 uCloudLit;
  uniform vec3 uCloudDark;

  ${ATMOSPHERE}
  ${CLOUDS}
  ${OUTPUT}

  in vec2 vUv;
  out vec4 fragColor;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec4 viewPos = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dir = normalize((uCameraWorld * vec4(viewPos.xyz / viewPos.w, 0.0)).xyz);

    vec3 col = skyGradient(dir);

    if (uStars > 0.01 && dir.y > -0.03) {
      vec3 p = dir * 150.0;
      vec3 cell = floor(p);
      float h = hash13(cell);
      float star = step(0.9962, h) * smoothstep(0.4, 0.04, length(fract(p) - 0.5));
      float twinkle = 0.72 + 0.28 * sin(uTime * 2.3 + h * 870.0);
      float bright = 1.2 + 6.0 * fract(h * 71.3);
      col += vec3(0.86, 0.92, 1.0) * star * twinkle * bright * uStars * smoothstep(-0.03, 0.2, dir.y);
    }

    float sunDot = dot(dir, uSunDir);
    col += uSunColor * smoothstep(0.99935, 0.99972, sunDot) * 24.0;

    float moonDot = dot(dir, uMoonDir);
    float moon = smoothstep(0.99915, 0.9995, moonDot);
    // A soft terminator so the moon reads as a lit sphere, not a sticker.
    vec3 moonSide = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    float phase = smoothstep(-0.018, 0.012, dot(dir - uMoonDir, moonSide));
    col += vec3(0.72, 0.8, 1.0) * moon * (0.25 + 1.6 * phase) * uStars;
    col += vec3(0.3, 0.4, 0.65) * pow(max(moonDot, 0.0), 220.0) * 0.12 * uStars;

    if (dir.y > 0.01) {
      float t = (CLOUD_ALTITUDE - cameraPosition.y) / dir.y;
      vec2 xz = cameraPosition.xz + dir.xz * t;
      float density = cloudDensity(xz);
      if (density > 0.002) {
        // Thicker cloud between here and the light means a darker underside.
        float toward = cloudField(xz + uLightDir.xz * 46.0);
        float edge = 1.0 - uCloudCover;
        float lit = 1.0 - smoothstep(edge - 0.05, edge + 0.4, toward) * 0.8;
        vec3 cloud = uCloudDark + uCloudLit * lit;
        cloud += uSunColor * pow(max(sunDot, 0.0), 10.0) * (1.0 - density) * 1.6;
        float fade = exp(-t * 0.00062);
        col = mix(col, cloud, density * fade * 0.96);
      }
    }

    col = mix(col, vec3(0.003, 0.004, 0.006), uCave);
    fragColor = outputColor(col, 1.0);
  }
`;

export function createFullscreenGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  return geometry;
}

export function createSkyDome(uniforms: UniformMap, direct: boolean): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    defines: direct ? { DIRECT_OUTPUT: "" } : {},
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(createFullscreenGeometry(), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

import * as THREE from "three";
import { TileKind } from "./atlas-layout";
import { ATMOSPHERE, CLOUDS, OUTPUT, UNPACK_VERTEX } from "./shaders/common";

/** The three materials every chunk is drawn with:
 *
 *  - terrain: cubes, cut-out foliage and plants. Voxel light (sky + block),
 *    baked ambient occlusion, a shadow-mapped sun, drifting cloud shadows,
 *    wind, and aerial-perspective fog.
 *  - water: an animated, Fresnel-reflective surface that reflects the same
 *    analytic sky the dome draws, with depth-tinted shallows and shore foam.
 *  - depth: the shadow pass's view of the terrain (same wind, same cut-outs).
 *
 * All three decode the mesher's packed vertices, and all share one set of
 * uniform objects, so the renderer updates the time of day once. */

export type UniformMap = Record<string, THREE.IUniform>;

export interface MaterialOptions {
  /** Tone-map in the material (no post pipeline). */
  readonly direct: boolean;
  readonly shadows: boolean;
}

function definesFor(options: MaterialOptions): Record<string, string> {
  const defines: Record<string, string> = {};
  if (options.direct) defines.DIRECT_OUTPUT = "";
  if (options.shadows) defines.USE_SHADOWS = "";
  return defines;
}

const TERRAIN_VERTEX = /* glsl */ `
  ${UNPACK_VERTEX}

  out vec3 vRel;
  out vec3 vLocal;
  out vec3 vLight;
  flat out int vFace;
  flat out int vTile;
  flat out int vFlags;

  void main() {
    Vert v = unpackVertex();
    vec3 pos = v.pos;
    if (v.swayOn) {
      vec3 world = (modelMatrix * vec4(pos, 1.0)).xyz;
      pos += windOffset(world, v.sway);
    }
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    // Camera-relative world position: exact even far from the origin,
    // because the model-view product is formed in double precision on the CPU.
    vRel = transpose(mat3(viewMatrix)) * mv.xyz;
    vLocal = v.pos;
    vLight = vec3(v.sky, v.blk, 0.4 + 0.2 * v.ao);
    vFace = v.cross ? 6 : v.face;
    vTile = v.tile;
    vFlags = (v.emissive ? 1 : 0) | (v.sway != 0 ? 2 : 0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SHADOW_SAMPLING = /* glsl */ `
  #ifdef USE_SHADOWS
    uniform highp sampler2DShadow uShadowMap;
    uniform mat4 uShadowMatrix;
    uniform float uShadowTexel;

    float sampleShadow(vec3 rel, vec3 n, float fallback) {
      // Offset along the normal instead of biasing depth: no acne on
      // sunlit faces, no peter-panning where a wall meets the ground.
      vec4 sc = uShadowMatrix * vec4(rel + n * 0.07, 1.0);
      vec3 c = sc.xyz;
      vec2 edge = abs(c.xy - 0.5) * 2.0;
      float outside = max(max(edge.x, edge.y), step(1.0, c.z));
      if (outside >= 1.0) return fallback;
      float z = c.z - 0.0009;
      float t = uShadowTexel;
      float s = texture(uShadowMap, vec3(c.xy + vec2(-0.75, -0.35) * t, z));
      s += texture(uShadowMap, vec3(c.xy + vec2(0.35, -0.75) * t, z));
      s += texture(uShadowMap, vec3(c.xy + vec2(0.75, 0.35) * t, z));
      s += texture(uShadowMap, vec3(c.xy + vec2(-0.35, 0.75) * t, z));
      s *= 0.25;
      return mix(s, fallback, smoothstep(0.86, 1.0, outside));
    }
  #endif
`;

const TERRAIN_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;

  uniform sampler2DArray uAtlas;
  uniform float uTime;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uAmbientSky;
  uniform vec3 uAmbientGround;
  uniform vec3 uBlockLight;
  uniform float uMinAmbient;
  uniform float uShadowStrength;

  ${ATMOSPHERE}
  ${CLOUDS}
  ${OUTPUT}
  ${SHADOW_SAMPLING}

  in vec3 vRel;
  in vec3 vLocal;
  in vec3 vLight;
  flat in int vFace;
  flat in int vTile;
  flat in int vFlags;

  out vec4 fragColor;

  const vec3 NORMALS[7] = vec3[7](
    vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0),
    vec3(0.0, 0.0, -1.0), vec3(0.0, 0.0, 1.0),
    vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
    vec3(0.0, 1.0, 0.0)
  );

  void main() {
    // Texture coordinates come straight from the position: the tile
    // repeats once per block however far a greedy quad stretches.
    vec2 uv;
    if (vFace < 2) uv = vLocal.xz;
    else if (vFace < 4 || vFace == 6) uv = vec2(vLocal.x, -vLocal.y);
    else uv = vec2(vLocal.z, -vLocal.y);
    vec3 world = vRel + cameraPosition;
    bool foliage = (vFlags & 2) != 0;
    vec2 duvdx = dFdx(uv);
    vec2 duvdy = dFdy(uv);
    // Canopies rustle by sliding their texture a fraction of a texel, so
    // leaf blocks stay static geometry and merge like any other block.
    if (foliage && vFace != 6) {
      uv += vec2(
        sin(uTime * 1.7 + world.x * 0.9 + world.y * 0.7),
        cos(uTime * 1.3 + world.z * 0.8 + world.y * 0.5)
      ) * 0.034;
    }
    vec4 tex = textureGrad(uAtlas, vec3(fract(uv), float(vTile)), duvdx, duvdy);
    if (tex.a < 0.5) {
      // Canopies are hollow, so a real hole would show bright sky right
      // through the tree. Gaps between leaves are drawn as the dark inside
      // of the crown instead — which also keeps leaf blocks free of
      // 'discard' and its early-depth-test penalty.
      if (foliage && vFace != 6) tex.rgb *= 0.28;
      else discard;
    }

    vec3 n = NORMALS[vFace];
    vec3 albedo = tex.rgb;

    // Meadows aren't one flat green: a slow noise warms and cools them.
    if (foliage || vTile == ${TileKind.GRASS_TOP} || vTile == ${TileKind.TALL_GRASS}) {
      float tintNoise = texture(uNoise, world.xz * 0.0031).g;
      albedo *= mix(vec3(0.84, 0.95, 0.84), vec3(1.06, 1.0, 0.86), tintNoise);
    }

    float skyL = vLight.x;
    float blkL = vLight.y;
    float ao = vLight.z;
    float skyVis = skyL * skyL;

    vec3 ambient = mix(uAmbientGround, uAmbientSky, n.y * 0.5 + 0.5) * skyVis;

    float ndl = max(dot(n, uLightDir), 0.0);
    // Leaves and blades scatter light instead of facing it.
    if (foliage || vFace == 6) ndl = mix(ndl, 0.75, 0.6);

    // Where no shadow map reaches, sky light stands in for it: a cell that
    // sees little sky is in shade.
    float skyShade = smoothstep(0.6, 1.0, skyL);
    #ifdef USE_SHADOWS
      float shadow = sampleShadow(vRel, n, skyShade);
    #else
      float shadow = skyShade;
    #endif
    shadow *= smoothstep(0.08, 0.45, skyL);
    shadow = mix(1.0, shadow, uShadowStrength) * cloudShadow(world, uLightDir);

    vec3 direct = uLightColor * ndl * shadow;
    // Steep falloff: a pool of light around each source, darkness between.
    vec3 torch = uBlockLight * (blkL * blkL * blkL * 1.7 + blkL * 0.05);

    vec3 color = albedo * ((ambient + uMinAmbient) * ao + direct + torch * mix(ao, 1.0, 0.35));
    // Emissive blocks mark their glowing texels with full alpha.
    if ((vFlags & 1) != 0) color += albedo * smoothstep(0.75, 1.0, tex.a) * 2.8;

    color = applyFog(color, vRel);
    fragColor = outputColor(color, 1.0);
  }
`;

const DEPTH_VERTEX = /* glsl */ `
  ${UNPACK_VERTEX}

  out vec3 vLocal;
  flat out int vFace;
  flat out int vTile;

  void main() {
    Vert v = unpackVertex();
    vec3 pos = v.pos;
    if (v.swayOn) {
      vec3 world = (modelMatrix * vec4(pos, 1.0)).xyz;
      pos += windOffset(world, v.sway);
    }
    vLocal = v.pos;
    vFace = v.cross ? 6 : v.face;
    // Only plants and glass have holes to cut; everything else (leaf
    // blocks included) casts a solid shadow and skips the texture fetch.
    vTile = (v.cross || v.tile == ${TileKind.GLASS}) ? v.tile : -1;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const DEPTH_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;

  uniform sampler2DArray uAtlas;

  in vec3 vLocal;
  flat in int vFace;
  flat in int vTile;

  out vec4 fragColor;

  void main() {
    vec2 uv;
    if (vFace < 2) uv = vLocal.xz;
    else if (vFace < 4 || vFace == 6) uv = vec2(vLocal.x, -vLocal.y);
    else uv = vec2(vLocal.z, -vLocal.y);
    if (vTile >= 0 && textureLod(uAtlas, vec3(fract(uv), float(vTile)), 0.0).a < 0.5) discard;
    fragColor = vec4(1.0);
  }
`;

const WATER_VERTEX = /* glsl */ `
  ${UNPACK_VERTEX}

  out vec3 vRel;
  out vec3 vLight;
  flat out int vFace;

  void main() {
    Vert v = unpackVertex();
    vec3 pos = v.pos;
    if (v.surface) pos.y -= 0.12;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vRel = transpose(mat3(viewMatrix)) * mv.xyz;
    vLight = vec3(v.sky, v.blk, v.depth);
    vFace = v.face;
    gl_Position = projectionMatrix * mv;
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform vec3 uAmbientSky;
  uniform vec3 uBlockLight;
  uniform vec3 uWaterShallow;
  uniform vec3 uWaterDeep;
  uniform float uShadowStrength;

  ${ATMOSPHERE}
  ${CLOUDS}
  ${OUTPUT}
  ${SHADOW_SAMPLING}

  in vec3 vRel;
  in vec3 vLight;
  flat in int vFace;

  out vec4 fragColor;

  const vec3 NORMALS[6] = vec3[6](
    vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0),
    vec3(0.0, 0.0, -1.0), vec3(0.0, 0.0, 1.0),
    vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0)
  );

  void main() {
    vec3 world = vRel + cameraPosition;
    float dist = length(vRel);
    vec3 view = -vRel / max(dist, 1e-4);
    bool top = vFace == 0;
    float depth = vLight.z;
    float skyVis = vLight.x * vLight.x;

    vec3 n = NORMALS[vFace];
    if (top) {
      // Two layers of ripples sliding across each other; they flatten with
      // distance so the far ocean doesn't shimmer.
      vec2 a = texture(uNoise, world.xz * 0.043 + uTime * vec2(0.011, 0.006)).ba - 0.5;
      vec2 b = texture(uNoise, world.xz * 0.117 - uTime * vec2(0.008, 0.014)).ba - 0.5;
      vec2 slope = (a * 1.6 + b * 0.9) / (1.0 + dist * 0.035);
      n = normalize(vec3(slope.x, 0.55, slope.y));
    }

    vec3 lightIn = uAmbientSky * skyVis + uLightColor * max(uLightDir.y, 0.0) * 0.45 * skyVis;
    lightIn += uBlockLight * vLight.y * vLight.y;
    vec3 body = mix(uWaterShallow, uWaterDeep, smoothstep(0.0, 0.85, depth)) * lightIn;

    vec3 color;
    float alpha;
    if (!gl_FrontFacing) {
      // Seen from underneath: the bright window of the sky above.
      color = mix(body * 2.0, skyGradient(vec3(0.0, 1.0, 0.0)) * skyVis, 0.45);
      alpha = 0.72;
    } else {
      float facing = max(dot(n, view), 0.0);
      float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);

      vec3 r = reflect(-view, n);
      r.y = abs(r.y) + 0.02;
      r = normalize(r);
      vec3 sky = skyGradient(r);
      // Clouds in the mirror.
      float t = (CLOUD_ALTITUDE - world.y) / max(r.y, 0.06);
      float cloud = cloudDensity(world.xz + r.xz * t) * exp(-t * 0.0006);
      sky = mix(sky, uAmbientSky * 1.1 + uLightColor * 0.28, cloud * 0.8);
      sky *= mix(0.25, 1.0, skyVis);

      float skyShade = smoothstep(0.6, 1.0, vLight.x);
      #ifdef USE_SHADOWS
        float shadow = sampleShadow(vRel, vec3(0.0, 1.0, 0.0), skyShade);
      #else
        float shadow = skyShade;
      #endif
      shadow = mix(1.0, shadow, uShadowStrength) * cloudShadow(world, uLightDir);

      float toLight = max(dot(r, uLightDir), 0.0);
      vec3 glint = uLightColor * (pow(toLight, 700.0) * 28.0 + pow(toLight, 90.0) * 0.5) * shadow;

      color = mix(body, sky, fresnel) + (top ? glint : vec3(0.0));
      alpha = mix(mix(0.42, 0.93, smoothstep(0.0, 0.9, depth)), 1.0, fresnel);

      if (top) {
        // Foam where the water thins out against a shore.
        float shore = 1.0 - smoothstep(0.0, 0.34, depth);
        float churn = texture(uNoise, world.xz * 0.21 + uTime * vec2(0.017, -0.012)).g;
        float foam = smoothstep(0.62, 0.8, churn + shore * 0.55) * shore;
        color = mix(color, (uAmbientSky + uLightColor * 0.5 * shadow) * 0.85, foam * 0.85);
        alpha = max(alpha, foam * 0.9);
      }
    }

    color = applyFog(color, vRel);
    fragColor = outputColor(color, alpha);
  }
`;

export function createTerrainMaterial(
  uniforms: UniformMap,
  options: MaterialOptions,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    defines: definesFor(options),
    vertexShader: TERRAIN_VERTEX,
    fragmentShader: TERRAIN_FRAGMENT,
  });
}

export function createWaterMaterial(
  uniforms: UniformMap,
  options: MaterialOptions,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    defines: definesFor(options),
    vertexShader: WATER_VERTEX,
    fragmentShader: WATER_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function createDepthMaterial(uniforms: UniformMap): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: DEPTH_VERTEX,
    fragmentShader: DEPTH_FRAGMENT,
    colorWrite: false,
  });
}

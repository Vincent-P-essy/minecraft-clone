/** GLSL shared by every material: the packed-vertex decoder, the analytic
 * sky (so fog, water reflections and the sky dome all agree on what colour
 * the horizon is), fog, and the output transform. Kept as template strings
 * so the materials stay ordinary Three.js ShaderMaterials with no build
 * step. */

/** Decodes the mesher's two-word vertex (see mesher.ts for the layout). */
export const UNPACK_VERTEX = /* glsl */ `
  in uvec2 aData;

  const vec3 FACE_NORMALS[6] = vec3[6](
    vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0),
    vec3(0.0, 0.0, -1.0), vec3(0.0, 0.0, 1.0),
    vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0)
  );

  struct Vert {
    vec3 pos;
    int face;
    float ao;
    float sky;
    float blk;
    int tile;
    int sway;
    bool swayOn;
    bool emissive;
    bool cross;
    float depth;
    bool surface;
  };

  Vert unpackVertex() {
    uint a = aData.x;
    uint b = aData.y;
    Vert v;
    v.pos = vec3(float(a & 31u), float((a >> 5u) & 255u), float((a >> 13u) & 31u));
    v.face = int((a >> 18u) & 7u);
    v.ao = float((a >> 21u) & 3u);
    v.sky = float((a >> 23u) & 15u) / 15.0;
    v.blk = float((a >> 27u) & 15u) / 15.0;
    v.tile = int(b & 255u);
    v.sway = int((b >> 8u) & 3u);
    v.swayOn = ((b >> 10u) & 1u) == 1u;
    v.emissive = ((b >> 11u) & 1u) == 1u;
    v.cross = ((b >> 12u) & 1u) == 1u;
    v.depth = float((b >> 13u) & 15u) / 7.0;
    v.surface = ((b >> 17u) & 1u) == 1u;
    return v;
  }

  uniform float uTime;

  /** Wind on plants: they lean from the root, in slow gusts. A pure
   * function of world position, so neighbouring tufts move together. */
  vec3 windOffset(vec3 world, int sway) {
    float gust = sin(uTime * 0.6 + world.x * 0.07 + world.z * 0.05) * 0.5 + 0.5;
    float phase = uTime * (1.4 + gust * 0.8);
    return vec3(
      sin(phase + world.x * 0.9 + world.z * 0.6) * 0.11,
      0.0,
      cos(phase * 0.8 + world.z * 1.1 + world.x * 0.4) * 0.09
    ) * (0.5 + gust);
  }
`;

/** Sky model + fog. The sky is a three-stop vertical gradient with a
 * forward-scattering glow around the sun, all driven by a handful of
 * uniforms computed on the CPU from the time of day (environment.ts). */
export const ATMOSPHERE = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyZenith;
  uniform vec3 uSkyHorizon;
  uniform vec3 uSunGlow;
  uniform vec3 uFogTint;
  uniform float uFogDensity;
  uniform float uFogStart;
  uniform float uFogEnd;
  uniform float uUnderwater;
  /** 0 in the open, 1 deep underground: the fog closes in and goes black. */
  uniform float uCave;

  vec3 skyGradient(vec3 dir) {
    float up = clamp(dir.y, 0.0, 1.0);
    // Most of the colour change happens in the first few degrees above the
    // horizon, like a real atmosphere seen edge-on.
    float t = pow(1.0 - up, 3.2);
    vec3 col = mix(uSkyZenith, uSkyHorizon, t);
    float toSun = max(dot(dir, uSunDir), 0.0);
    // A broad warm lobe plus a tighter one hugging the sun.
    float lowBand = pow(1.0 - up, 2.0);
    col += uSunGlow * (pow(toSun, 6.0) * 0.42 * lowBand + pow(toSun, 48.0) * 0.38);
    // Below the horizon the "sky" is distant haze: darker, flatter.
    float below = clamp(-dir.y * 4.0, 0.0, 1.0);
    return mix(col, uSkyHorizon * 0.72, below);
  }

  /** Aerial perspective: exponential haze that picks up the colour of the
   * sky behind it, closing completely just before the loaded world ends. */
  vec3 applyFog(vec3 color, vec3 rel) {
    float dist = length(rel);
    vec3 dir = rel / max(dist, 1e-4);
    if (uUnderwater > 0.5) {
      float f = 1.0 - exp(-dist * 0.085);
      return mix(color, uFogTint, clamp(f, 0.0, 1.0));
    }
    float haze = 1.0 - exp(-dist * uFogDensity);
    float wall = smoothstep(mix(uFogStart, 24.0, uCave), mix(uFogEnd, 62.0, uCave), dist);
    float f = clamp(max(haze * haze * 0.7, wall), 0.0, 1.0);
    vec3 fogColor = skyGradient(normalize(vec3(dir.x, max(dir.y, 0.0) * 0.35 + 0.02, dir.z)));
    // Underground there is no sky to fade into — distance fades to darkness.
    fogColor = mix(fogColor, vec3(0.003, 0.004, 0.006), uCave);
    return mix(color, fogColor, f);
  }
`;

/** Final output. With the post-processing pipeline on, materials write
 * linear HDR and the composite pass tone-maps; without it (the low tier)
 * each material tone-maps for itself and the frame goes straight to the
 * screen with no extra full-screen passes. */
export const OUTPUT = /* glsl */ `
  uniform float uExposure;

  vec3 acesFilm(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  vec3 linearToSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  vec3 toDisplay(vec3 hdr) {
    vec3 mapped = acesFilm(hdr * uExposure);
    // A touch of saturation back after the filmic curve.
    float luma = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
    mapped = mix(vec3(luma), mapped, 1.12);
    return linearToSrgb(clamp(mapped, 0.0, 1.0));
  }

  vec4 outputColor(vec3 hdr, float alpha) {
    #ifdef DIRECT_OUTPUT
      return vec4(toDisplay(hdr), alpha);
    #else
      return vec4(hdr, alpha);
    #endif
  }
`;

/** Vertex shader for every post pass: one oversized triangle covering the
 * screen (positions are already in clip space). */
export const FULLSCREEN_VERTEX = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Cloud cover as a function of world position — sampled by the sky dome
 * to draw the clouds, by the terrain to drop their shadows on the ground,
 * and by the water to reflect them, so all three line up. */
export const CLOUDS = /* glsl */ `
  uniform sampler2D uNoise;
  uniform vec2 uCloudOffset;
  uniform float uCloudCover;

  const float CLOUD_ALTITUDE = 210.0;

  float cloudField(vec2 xz) {
    vec2 uv = (xz + uCloudOffset) * 0.00085;
    return texture(uNoise, uv).r * 0.64 + texture(uNoise, uv * 2.9 + 0.37).r * 0.36;
  }

  float cloudDensity(vec2 xz) {
    float n = cloudField(xz);
    float edge = 1.0 - uCloudCover;
    return smoothstep(edge, edge + 0.2, n);
  }

  /** How much direct light the clouds above a point let through. */
  float cloudShadow(vec3 world, vec3 lightDir) {
    float t = (CLOUD_ALTITUDE - world.y) / max(lightDir.y, 0.08);
    vec2 xz = world.xz + lightDir.xz * t;
    float n = texture(uNoise, (xz + uCloudOffset) * 0.00085).r;
    float edge = 1.0 - uCloudCover;
    return 1.0 - smoothstep(edge - 0.04, edge + 0.22, n) * 0.6;
  }
`;

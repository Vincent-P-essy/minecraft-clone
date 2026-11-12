import type { Environment, Vec3Tuple } from "./environment";

/** The weather, as a slow deterministic function of the clock: fronts
 * roll in over a few minutes, the sky closes over, and if the front is
 * strong enough it rains. Pure, so a given world at a given time always
 * has the same weather and the whole thing is unit-testable. */

export interface Weather {
  /** 0 = clear sky, 1 = fully overcast. */
  readonly overcast: number;
  /** 0 = dry, 1 = downpour. Rain only falls once the sky has closed. */
  readonly rain: number;
}

export const CLEAR: Weather = { overcast: 0, rain: 0 };

/** Seconds between the control points the weather drifts through. */
const FRONT_SECONDS = 300;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function frontStrength(seed: number, index: number): number {
  // The first fronts of any world are calm: nobody should arrive in a storm.
  if (index <= 1) return 0.2;
  let h = Math.imul(seed ^ 0x77ea7e2, 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ index, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function weatherAt(seed: number, timeSeconds: number): Weather {
  const position = Math.max(0, timeSeconds) / FRONT_SECONDS;
  const index = Math.floor(position);
  const t = position - index;
  const eased = t * t * (3 - 2 * t);
  const strength =
    frontStrength(seed, index) * (1 - eased) + frontStrength(seed, index + 1) * eased;
  return {
    overcast: smoothstep(0.5, 0.7, strength),
    rain: smoothstep(0.66, 0.84, strength),
  };
}

function luma(c: Vec3Tuple): number {
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}

function mix3(a: Vec3Tuple, b: Vec3Tuple, t: number): Vec3Tuple {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scale3(a: Vec3Tuple, s: number): Vec3Tuple {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** A flat, slightly cool grey of the colour's own brightness. */
function overcastGrey(c: Vec3Tuple, dim: number): Vec3Tuple {
  const l = luma(c) * dim;
  return [l * 0.92, l * 0.97, l * 1.05];
}

/** What the weather does to the light: clouds flatten the sky to grey,
 * hide the sun and the stars, take most of the direct light and nearly
 * all of the shadows. `flash` (0..1) is a lightning strike in progress. */
export function applyWeather(env: Environment, weather: Weather, flash = 0): Environment {
  const o = weather.overcast;
  if (o <= 0 && flash <= 0) return env;
  const clear = 1 - o;
  const ambient = mix3(env.ambientSky, overcastGrey(env.ambientSky, 0.85), o * 0.7);
  const strike: Vec3Tuple = [0.85 * flash * 2.4, 0.92 * flash * 2.4, 1.15 * flash * 2.4];
  return {
    ...env,
    lightColor: scale3(env.lightColor, 1 - 0.74 * o),
    sunColor: scale3(env.sunColor, clear * clear),
    sunGlow: scale3(env.sunGlow, 1 - 0.85 * o),
    skyZenith: mix3(env.skyZenith, overcastGrey(env.skyZenith, 1.15), o * 0.88),
    skyHorizon: mix3(env.skyHorizon, overcastGrey(env.skyHorizon, 0.62), o * 0.88),
    ambientSky: [ambient[0] + strike[0], ambient[1] + strike[1], ambient[2] + strike[2]],
    ambientGround: scale3(env.ambientGround, 1 - 0.3 * o),
    shadowStrength: env.shadowStrength * (1 - 0.82 * o),
    starVisibility: env.starVisibility * clear,
  };
}

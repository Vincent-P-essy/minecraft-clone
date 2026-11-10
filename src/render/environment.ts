import { DAY_LENGTH_SECONDS } from "./sky";

/** Everything the shaders need to know about the time of day, as plain
 * numbers: where the sun and moon are, what colour the light and the sky
 * are, how thick the haze is. A pure function of the clock, so the whole
 * look of the day is unit-testable and the renderer just copies values
 * into uniforms. All colours are linear HDR. */

export type Vec3Tuple = [number, number, number];

export interface Environment {
  /** Position in the day cycle, 0..1 (0 = sunrise, 0.3 = noon, 0.6 = sunset). */
  readonly phase: number;
  /** Unit vector pointing at the sun (below the horizon at night). */
  readonly sunDir: Vec3Tuple;
  readonly moonDir: Vec3Tuple;
  /** The light that casts shadows right now: the sun by day, the moon by night. */
  readonly lightDir: Vec3Tuple;
  readonly lightColor: Vec3Tuple;
  /** Colour of the sun's disc and its glow in the sky. */
  readonly sunColor: Vec3Tuple;
  readonly skyZenith: Vec3Tuple;
  readonly skyHorizon: Vec3Tuple;
  readonly sunGlow: Vec3Tuple;
  /** Light arriving from the sky dome, and the dimmer bounce from below. */
  readonly ambientSky: Vec3Tuple;
  readonly ambientGround: Vec3Tuple;
  /** 0 by day, 1 in the dead of night. */
  readonly night: number;
  readonly starVisibility: number;
  /** How strongly shadows read; fades to nothing as the light reaches the horizon. */
  readonly shadowStrength: number;
  readonly exposure: number;
}

/** Phases the sun is above the horizon: [0, DAYTIME_END] of each cycle. */
export const DAYTIME_END = 0.6;
/** Tilt of the sun's path away from straight overhead, so noon still
 * throws shadows with a direction. */
const PATH_TILT = 0.5;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix3(a: Vec3Tuple, b: Vec3Tuple, t: number): Vec3Tuple {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scale3(a: Vec3Tuple, s: number): Vec3Tuple {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function add3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

const ZENITH_DAY: Vec3Tuple = [0.105, 0.3, 0.82];
const HORIZON_DAY: Vec3Tuple = [0.5, 0.7, 0.95];
const ZENITH_DUSK: Vec3Tuple = [0.11, 0.13, 0.36];
const HORIZON_DUSK: Vec3Tuple = [1.0, 0.44, 0.17];
const ZENITH_NIGHT: Vec3Tuple = [0.0035, 0.007, 0.022];
const HORIZON_NIGHT: Vec3Tuple = [0.012, 0.02, 0.05];
const SUN_LOW: Vec3Tuple = [1.0, 0.4, 0.14];
const SUN_HIGH: Vec3Tuple = [1.0, 0.95, 0.85];
const MOON_LIGHT: Vec3Tuple = [0.34, 0.47, 0.8];

/** Sun angle along its path for a day phase: 0 at sunrise, PI at sunset,
 * continuing under the world through the night. */
export function sunAngleAt(phase: number): number {
  return phase <= DAYTIME_END
    ? (phase / DAYTIME_END) * Math.PI
    : Math.PI + ((phase - DAYTIME_END) / (1 - DAYTIME_END)) * Math.PI;
}

export function dayPhase(timeSeconds: number): number {
  return (((timeSeconds / DAY_LENGTH_SECONDS) % 1) + 1) % 1;
}

export function environmentAt(timeSeconds: number): Environment {
  const phase = dayPhase(timeSeconds);
  const angle = sunAngleAt(phase);
  const sunDir: Vec3Tuple = [
    Math.cos(angle),
    Math.sin(angle) * Math.cos(PATH_TILT),
    Math.sin(angle) * Math.sin(PATH_TILT),
  ];
  const moonDir: Vec3Tuple = [-sunDir[0], -sunDir[1], -sunDir[2]];
  const elevation = sunDir[1];

  const day = smoothstep(-0.08, 0.2, elevation);
  const night = 1 - smoothstep(-0.24, 0.0, elevation);
  // Peaks while the sun sits on the horizon, at both ends of the day.
  const twilight = Math.exp(-(elevation * elevation) / 0.035);

  let skyZenith = mix3(ZENITH_NIGHT, ZENITH_DAY, day);
  let skyHorizon = mix3(HORIZON_NIGHT, HORIZON_DAY, day);
  skyZenith = mix3(skyZenith, ZENITH_DUSK, twilight * 0.75);
  skyHorizon = mix3(skyHorizon, HORIZON_DUSK, twilight * 0.85);

  const sunTint = mix3(SUN_LOW, SUN_HIGH, smoothstep(0.02, 0.42, elevation));
  const sunPower = 2.6 * smoothstep(-0.03, 0.22, elevation);
  const moonPower = 0.26 * smoothstep(0.0, 0.25, moonDir[1]);

  const sunUp = elevation > -0.03;
  const lightDir = sunUp ? sunDir : moonDir;
  const lightColor = sunUp ? scale3(sunTint, sunPower) : scale3(MOON_LIGHT, moonPower);
  const lightElevation = Math.abs(lightDir[1]);

  const sunGlow = add3(scale3(HORIZON_DUSK, twilight * 1.5), scale3(SUN_HIGH, day * 0.22));

  // Skylight is blue, but surfaces lit only by it shouldn't turn teal:
  // pull the ambient term halfway back toward neutral.
  const rawAmbient = add3(
    add3(scale3(skyZenith, 0.7), scale3(skyHorizon, 0.3)),
    scale3(MOON_LIGHT, 0.035 * night),
  );
  const ambientLuma = rawAmbient[0] * 0.2126 + rawAmbient[1] * 0.7152 + rawAmbient[2] * 0.0722;
  const ambientSky = mix3([ambientLuma, ambientLuma, ambientLuma], rawAmbient, 0.5);
  const ambientGround = add3(scale3(ambientSky, 0.32), scale3(sunTint, 0.07 * day));

  return {
    phase,
    sunDir,
    moonDir,
    lightDir,
    lightColor,
    sunColor: scale3(sunTint, 1 - night),
    skyZenith,
    skyHorizon,
    sunGlow,
    ambientSky,
    ambientGround,
    night,
    starVisibility: smoothstep(0.35, 0.95, night),
    shadowStrength: smoothstep(0.04, 0.2, lightElevation),
    exposure: 0.92 + night * 0.85,
  };
}

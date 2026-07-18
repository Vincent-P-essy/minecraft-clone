/** The day/night cycle as a pure function of elapsed time — no Three.js in
 * here, so the whole cycle (colors, intensities, sun arc) is unit-testable.
 * The scene just applies whatever this returns each frame. */

export const DAY_LENGTH_SECONDS = 240;

/** The game starts partway into the morning rather than at the sunrise
 * keyframe, so first load shows the world in full daylight. */
export const STARTUP_PHASE = 0.15;

export interface SkyState {
  /** RGB in 0..1, used for the sky background and the fog. */
  readonly skyColor: readonly [number, number, number];
  readonly sunIntensity: number;
  readonly ambientIntensity: number;
  /** Sun arc position: 0 = rising on the horizon, PI/2 = overhead, PI = set.
   * Held at the ends during the night portion of the cycle. */
  readonly sunAngle: number;
}

interface Keyframe {
  readonly phase: number;
  readonly sky: readonly [number, number, number]; // 0-255
  readonly sun: number;
  readonly ambient: number;
}

/** Phases the sun is actually in the sky: [0, DAYTIME_END] of each cycle. */
const DAYTIME_END = 0.6;

const KEYFRAMES: readonly Keyframe[] = [
  { phase: 0.0, sky: [255, 177, 110], sun: 0.7, ambient: 0.42 }, // sunrise
  { phase: 0.1, sky: [135, 206, 235], sun: 1.7, ambient: 0.55 }, // morning
  { phase: 0.45, sky: [135, 206, 235], sun: 1.7, ambient: 0.55 }, // afternoon
  { phase: 0.55, sky: [255, 140, 90], sun: 0.7, ambient: 0.4 }, // sunset
  { phase: 0.62, sky: [40, 42, 80], sun: 0.15, ambient: 0.24 }, // dusk
  { phase: 0.75, sky: [12, 14, 34], sun: 0.05, ambient: 0.18 }, // night
  { phase: 0.92, sky: [12, 14, 34], sun: 0.05, ambient: 0.18 }, // late night
  { phase: 1.0, sky: [255, 177, 110], sun: 0.7, ambient: 0.42 }, // wraps to sunrise
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function bracketingKeyframes(phase: number): readonly [Keyframe, Keyframe] {
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    const a = KEYFRAMES[i];
    const b = KEYFRAMES[i + 1];
    if (a && b && phase >= a.phase && phase <= b.phase) return [a, b];
  }
  const first = KEYFRAMES[0];
  if (!first) throw new Error("sky keyframes are empty");
  return [first, first];
}

export function skyStateAt(timeSeconds: number): SkyState {
  const phase = (((timeSeconds / DAY_LENGTH_SECONDS) % 1) + 1) % 1;
  const [before, after] = bracketingKeyframes(phase);

  const span = after.phase - before.phase;
  const t = span === 0 ? 0 : (phase - before.phase) / span;

  const skyColor: [number, number, number] = [
    lerp(before.sky[0], after.sky[0], t) / 255,
    lerp(before.sky[1], after.sky[1], t) / 255,
    lerp(before.sky[2], after.sky[2], t) / 255,
  ];

  const arcT = Math.min(phase / DAYTIME_END, 1);

  return {
    skyColor,
    sunIntensity: lerp(before.sun, after.sun, t),
    ambientIntensity: lerp(before.ambient, after.ambient, t),
    sunAngle: arcT * Math.PI,
  };
}

import type { QualityLevel } from "./render/renderer";

/** Player-tunable options, persisted between sessions. One plain object
 * that the renderer, controller, audio and UI all read; `onChange`
 * listeners apply a new value the moment a slider moves. */
export interface Settings {
  quality: QualityLevel;
  /** Visible distance in chunks. */
  viewDistance: number;
  fov: number;
  /** Look sensitivity multiplier (1 = default). */
  sensitivity: number;
  invertY: boolean;
  autoJump: boolean;
  viewBob: boolean;
  /** Master volume, 0..1. */
  volume: number;
  showStats: boolean;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "voxel-world:settings:v1";

export const VIEW_DISTANCE_RANGE = { min: 4, max: 16 } as const;
export const FOV_RANGE = { min: 55, max: 100 } as const;

/** Defaults sized to the device: phones start on a lighter tier and a
 * shorter view distance, and get auto-jump because there's no spare thumb. */
export function defaultSettings(device: { touch: boolean; cores: number }): Settings {
  const strong = device.cores >= 8;
  return {
    quality: device.touch ? (strong ? "medium" : "low") : "high",
    viewDistance: device.touch ? (strong ? 7 : 6) : 10,
    fov: 75,
    sensitivity: 1,
    invertY: false,
    autoJump: device.touch,
    viewBob: true,
    volume: 0.7,
    showStats: false,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Merges stored values over defaults, discarding anything malformed —
 * a hand-edited or stale payload can't put the game in a broken state. */
export function sanitizeSettings(raw: unknown, defaults: Settings): Settings {
  if (typeof raw !== "object" || raw === null) return { ...defaults };
  const r = raw as Partial<Record<keyof Settings, unknown>>;
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : fallback;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  const quality =
    r.quality === "low" || r.quality === "medium" || r.quality === "high" || r.quality === "ultra"
      ? r.quality
      : defaults.quality;
  return {
    quality,
    viewDistance: Math.round(
      num(r.viewDistance, defaults.viewDistance, VIEW_DISTANCE_RANGE.min, VIEW_DISTANCE_RANGE.max),
    ),
    fov: Math.round(num(r.fov, defaults.fov, FOV_RANGE.min, FOV_RANGE.max)),
    sensitivity: num(r.sensitivity, defaults.sensitivity, 0.2, 3),
    invertY: bool(r.invertY, defaults.invertY),
    autoJump: bool(r.autoJump, defaults.autoJump),
    viewBob: bool(r.viewBob, defaults.viewBob),
    volume: num(r.volume, defaults.volume, 0, 1),
    showStats: bool(r.showStats, defaults.showStats),
  };
}

export class SettingsStore {
  readonly values: Settings;
  private readonly storage: KeyValueStore | null;
  private readonly listeners = new Set<(settings: Settings, key: keyof Settings) => void>();

  constructor(storage: KeyValueStore | null, defaults: Settings) {
    this.storage = storage;
    let stored: unknown;
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      stored = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      stored = null;
    }
    this.values = sanitizeSettings(stored, defaults);
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.values[key] === value) return;
    this.values[key] = value;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
      // Storage full or blocked: the setting still applies for this session.
    }
    for (const listener of this.listeners) listener(this.values, key);
  }

  onChange(listener: (settings: Settings, key: keyof Settings) => void): void {
    this.listeners.add(listener);
  }
}

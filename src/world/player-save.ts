import type { KeyValueStorage } from "./edit-store";

/** Where the player was, which way they were looking, what time it was
 * and what was on their hotbar — saved per world so coming back picks up
 * exactly where they left off. */
export interface PlayerSave {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly flying: boolean;
  /** Seconds into the day/night cycle. */
  readonly time: number;
  readonly hotbar: readonly number[];
  readonly slot: number;
  /** "creative" (everything, unlimited) or "adventure" (gather and craft). */
  readonly mode?: "creative" | "adventure";
  /** Raw saved bag and journal; validated by the classes that own them. */
  readonly bag?: unknown;
  readonly journal?: unknown;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function playerSaveKey(seed: number): string {
  return `voxel-world:player:v2:${seed.toString()}`;
}

export function loadPlayerSave(storage: KeyValueStorage, seed: number): PlayerSave | null {
  try {
    const raw = storage.getItem(playerSaveKey(seed));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Record<keyof PlayerSave, unknown>>;
    if (!finite(p.x) || !finite(p.y) || !finite(p.z) || !finite(p.yaw) || !finite(p.pitch)) {
      return null;
    }
    if (!finite(p.time)) return null;
    const hotbar = Array.isArray(p.hotbar) ? p.hotbar.filter(finite) : [];
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      pitch: p.pitch,
      flying: p.flying === true,
      time: p.time,
      hotbar,
      slot: finite(p.slot) ? Math.max(0, Math.min(8, Math.floor(p.slot))) : 0,
      mode: p.mode === "adventure" ? "adventure" : "creative",
      bag: p.bag,
      journal: p.journal,
    };
  } catch {
    return null; // a corrupt save just means a fresh start
  }
}

export function storePlayerSave(storage: KeyValueStorage, seed: number, save: PlayerSave): void {
  try {
    storage.setItem(playerSaveKey(seed), JSON.stringify(save));
  } catch {
    // Storage full or unavailable: nothing to do but carry on.
  }
}

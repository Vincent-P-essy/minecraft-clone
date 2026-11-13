import { BlockId } from "../world/blocks";
import { Biome } from "../world/terrain";

/** The discovery journal: a list of small things to find, see and do.
 * It gives a sandbox a direction without ever blocking anything — there's
 * no order, no timer and nothing to lose. The tracker is pure: feed it
 * what the player just did, and it says what that unlocked. */

export type DiscoveryId =
  | `biome-${number}`
  | "first-dig"
  | "first-build"
  | "builder"
  | "architect"
  | "lumen"
  | "glowshroom"
  | "coal"
  | "gold"
  | "light"
  | "deep"
  | "summit"
  | "swim"
  | "night"
  | "rain"
  | "snow"
  | "storm"
  | "craft"
  | "fly";

export interface Discovery {
  readonly id: DiscoveryId;
  /** A single glyph shown next to the name. */
  readonly icon: string;
}

const BIOME_ICONS: Record<number, string> = {
  [Biome.OCEAN]: "🌊",
  [Biome.BEACH]: "🏖️",
  [Biome.PLAINS]: "🌼",
  [Biome.FOREST]: "🌳",
  [Biome.AUTUMN]: "🍂",
  [Biome.PINE]: "🌲",
  [Biome.DESERT]: "🌵",
  [Biome.TUNDRA]: "❄️",
  [Biome.MOUNTAIN]: "⛰️",
  [Biome.SNOW_PEAK]: "🏔️",
};

export const DISCOVERIES: readonly Discovery[] = [
  ...Object.values(Biome).map((biome) => ({
    id: `biome-${biome}` as DiscoveryId,
    icon: BIOME_ICONS[biome] ?? "🧭",
  })),
  { id: "first-dig", icon: "⛏️" },
  { id: "first-build", icon: "🧱" },
  { id: "builder", icon: "🏠" },
  { id: "architect", icon: "🏰" },
  { id: "light", icon: "🏮" },
  { id: "lumen", icon: "💎" },
  { id: "glowshroom", icon: "🍄" },
  { id: "coal", icon: "⚫" },
  { id: "gold", icon: "🟡" },
  { id: "deep", icon: "🕳️" },
  { id: "summit", icon: "🚩" },
  { id: "swim", icon: "🏊" },
  { id: "night", icon: "🌙" },
  { id: "rain", icon: "🌧️" },
  { id: "snow", icon: "🌨️" },
  { id: "storm", icon: "⚡" },
  { id: "craft", icon: "🛠️" },
  { id: "fly", icon: "🕊️" },
];

const KNOWN = new Set<string>(DISCOVERIES.map((d) => d.id));

/** A snapshot of where the player is and what's going on around them. */
export interface Surroundings {
  readonly biome: number;
  /** Feet height in blocks. */
  readonly y: number;
  readonly underground: boolean;
  readonly swimming: boolean;
  readonly flying: boolean;
  /** 0 by day, 1 at night. */
  readonly night: number;
  /** 0..1, and whether it's cold enough to fall as snow. */
  readonly rain: number;
  readonly snowing: boolean;
}

export class Journal {
  private readonly found = new Set<DiscoveryId>();
  private placed = 0;

  constructor(saved?: { found?: unknown; placed?: unknown }) {
    if (Array.isArray(saved?.found)) {
      for (const id of saved.found) {
        if (typeof id === "string" && KNOWN.has(id)) this.found.add(id as DiscoveryId);
      }
    }
    if (typeof saved?.placed === "number" && Number.isFinite(saved.placed)) {
      this.placed = Math.max(0, Math.floor(saved.placed));
    }
  }

  has(id: DiscoveryId): boolean {
    return this.found.has(id);
  }

  get count(): number {
    return this.found.size;
  }

  get total(): number {
    return DISCOVERIES.length;
  }

  get blocksPlaced(): number {
    return this.placed;
  }

  private unlock(id: DiscoveryId, out: DiscoveryId[]): void {
    if (this.found.has(id) || !KNOWN.has(id)) return;
    this.found.add(id);
    out.push(id);
  }

  /** The player broke a block. */
  dug(block: BlockId): DiscoveryId[] {
    const out: DiscoveryId[] = [];
    this.unlock("first-dig", out);
    if (block === BlockId.CRYSTAL) this.unlock("lumen", out);
    if (block === BlockId.GLOWSHROOM) this.unlock("glowshroom", out);
    if (block === BlockId.COAL_ORE) this.unlock("coal", out);
    if (block === BlockId.GOLD_ORE) this.unlock("gold", out);
    return out;
  }

  /** The player placed a block. */
  built(block: BlockId): DiscoveryId[] {
    const out: DiscoveryId[] = [];
    this.placed++;
    this.unlock("first-build", out);
    if (this.placed >= 50) this.unlock("builder", out);
    if (this.placed >= 500) this.unlock("architect", out);
    if (block === BlockId.LANTERN) this.unlock("light", out);
    return out;
  }

  crafted(): DiscoveryId[] {
    const out: DiscoveryId[] = [];
    this.unlock("craft", out);
    return out;
  }

  /** Called now and then with where the player is. */
  observe(s: Surroundings): DiscoveryId[] {
    const out: DiscoveryId[] = [];
    if (!s.underground && !s.flying) this.unlock(`biome-${s.biome}`, out);
    if (s.underground && s.y < 16) this.unlock("deep", out);
    if (!s.flying && s.y >= 100) this.unlock("summit", out);
    if (s.swimming) this.unlock("swim", out);
    if (s.flying) this.unlock("fly", out);
    if (s.night > 0.9 && !s.underground) this.unlock("night", out);
    if (s.rain > 0.5 && !s.underground) {
      this.unlock(s.snowing ? "snow" : "rain", out);
      if (s.rain > 0.9 && !s.snowing) this.unlock("storm", out);
    }
    return out;
  }

  toJSON(): { found: DiscoveryId[]; placed: number } {
    return { found: [...this.found], placed: this.placed };
  }
}

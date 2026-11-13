import { BLOCKS, BlockId, INVENTORY_BLOCKS } from "../world/blocks";

/** What the player carries in Adventure mode: a count per block. Pure data
 * with validation on the way in, so a saved bag can't hold blocks that
 * don't exist or counts that make no sense. */

export const STACK_LIMIT = 999;

const HOLDABLE = new Set<number>(INVENTORY_BLOCKS);

/** What breaking a block gives you (nothing for AIR). Rock comes away as
 * cobblestone and turf as dirt; everything else drops itself. */
export function dropFor(block: BlockId): BlockId {
  switch (block) {
    case BlockId.STONE:
      return BlockId.COBBLE;
    case BlockId.GRASS:
    case BlockId.FROSTED_GRASS:
      return BlockId.DIRT;
    default:
      return HOLDABLE.has(block) ? block : BlockId.AIR;
  }
}

/** Seconds of digging to break a block by hand in Adventure mode. */
export function digSeconds(block: BlockId): number {
  const def = BLOCKS[block];
  if (!def.breakable) return Infinity;
  if (def.shape === "cross") return 0.08;
  switch (block) {
    case BlockId.LEAVES:
    case BlockId.AUTUMN_LEAVES:
    case BlockId.PINE_LEAVES:
      return 0.25;
    case BlockId.GLASS:
    case BlockId.LANTERN:
      return 0.35;
    case BlockId.DIRT:
    case BlockId.GRASS:
    case BlockId.FROSTED_GRASS:
    case BlockId.SAND:
    case BlockId.GRAVEL:
    case BlockId.SNOW:
    case BlockId.CLAY:
      return 0.5;
    case BlockId.ICE:
    case BlockId.CACTUS:
      return 0.6;
    case BlockId.WOOD:
    case BlockId.PALE_WOOD:
    case BlockId.PINE_WOOD:
    case BlockId.PLANKS:
      return 0.9;
    case BlockId.COAL_ORE:
    case BlockId.GOLD_ORE:
      return 1.6;
    case BlockId.CRYSTAL:
      return 1.9;
    default:
      return 1.3; // stone and everything built from it
  }
}

export class Bag {
  private readonly counts = new Map<BlockId, number>();
  /** Fired whenever a count changes. */
  onChange: (() => void) | undefined;

  constructor(saved?: unknown) {
    if (typeof saved !== "object" || saved === null) return;
    for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
      const id = Number(key);
      if (!HOLDABLE.has(id) || typeof value !== "number" || !Number.isFinite(value)) continue;
      const count = Math.min(STACK_LIMIT, Math.floor(value));
      if (count > 0) this.counts.set(id as BlockId, count);
    }
  }

  count(block: BlockId): number {
    return this.counts.get(block) ?? 0;
  }

  /** Adds up to `amount`; returns how many actually fit. */
  add(block: BlockId, amount = 1): number {
    if (!HOLDABLE.has(block) || amount <= 0) return 0;
    const before = this.count(block);
    const after = Math.min(STACK_LIMIT, before + Math.floor(amount));
    if (after === before) return 0;
    this.counts.set(block, after);
    this.onChange?.();
    return after - before;
  }

  /** Takes `amount` out if (and only if) that many are there. */
  remove(block: BlockId, amount = 1): boolean {
    const before = this.count(block);
    if (amount <= 0 || before < amount) return false;
    if (before === amount) this.counts.delete(block);
    else this.counts.set(block, before - amount);
    this.onChange?.();
    return true;
  }

  /** The blocks held, in inventory order. */
  owned(): BlockId[] {
    return INVENTORY_BLOCKS.filter((block) => this.count(block) > 0);
  }

  toJSON(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [block, count] of this.counts) out[block.toString()] = count;
    return out;
  }
}

export interface Recipe {
  readonly id: string;
  readonly output: BlockId;
  readonly amount: number;
  readonly needs: readonly (readonly [BlockId, number])[];
}

/** What can be made by hand. Deliberately few and obvious: a child should
 * be able to guess each one. */
export const RECIPES: readonly Recipe[] = [
  { id: "planks-oak", output: BlockId.PLANKS, amount: 4, needs: [[BlockId.WOOD, 1]] },
  { id: "planks-pale", output: BlockId.PLANKS, amount: 4, needs: [[BlockId.PALE_WOOD, 1]] },
  { id: "planks-pine", output: BlockId.PLANKS, amount: 4, needs: [[BlockId.PINE_WOOD, 1]] },
  {
    id: "stone",
    output: BlockId.STONE,
    amount: 2,
    needs: [
      [BlockId.COBBLE, 2],
      [BlockId.COAL_ORE, 1],
    ],
  },
  { id: "stone-bricks", output: BlockId.STONE_BRICK, amount: 4, needs: [[BlockId.COBBLE, 4]] },
  {
    id: "bricks",
    output: BlockId.BRICK,
    amount: 4,
    needs: [
      [BlockId.CLAY, 4],
      [BlockId.COAL_ORE, 1],
    ],
  },
  {
    id: "glass",
    output: BlockId.GLASS,
    amount: 2,
    needs: [
      [BlockId.SAND, 2],
      [BlockId.COAL_ORE, 1],
    ],
  },
  { id: "sandstone", output: BlockId.SANDSTONE, amount: 2, needs: [[BlockId.SAND, 4]] },
  { id: "ice", output: BlockId.ICE, amount: 1, needs: [[BlockId.SNOW, 2]] },
  {
    id: "lantern",
    output: BlockId.LANTERN,
    amount: 1,
    needs: [
      [BlockId.CRYSTAL, 1],
      [BlockId.PLANKS, 2],
    ],
  },
  {
    id: "lantern-gold",
    output: BlockId.LANTERN,
    amount: 2,
    needs: [
      [BlockId.GOLD_ORE, 1],
      [BlockId.COAL_ORE, 1],
    ],
  },
];

export function canCraft(bag: Bag, recipe: Recipe): boolean {
  return (
    recipe.needs.every(([block, amount]) => bag.count(block) >= amount) &&
    bag.count(recipe.output) + recipe.amount <= STACK_LIMIT
  );
}

/** Spends the ingredients and adds the result; false (and no change) if
 * the bag doesn't hold what the recipe needs. */
export function craft(bag: Bag, recipe: Recipe): boolean {
  if (!canCraft(bag, recipe)) return false;
  for (const [block, amount] of recipe.needs) bag.remove(block, amount);
  bag.add(recipe.output, recipe.amount);
  return true;
}

import { describe, expect, it } from "vitest";
import { BLOCKS, BlockId, INVENTORY_BLOCKS } from "../world/blocks";
import { Biome } from "../world/terrain";
import { DISCOVERIES, Journal, type Surroundings } from "./discoveries";
import { Bag, canCraft, craft, digSeconds, dropFor, RECIPES, STACK_LIMIT } from "./items";

describe("dropFor", () => {
  it("turns rock into cobblestone and turf into dirt", () => {
    expect(dropFor(BlockId.STONE)).toBe(BlockId.COBBLE);
    expect(dropFor(BlockId.GRASS)).toBe(BlockId.DIRT);
    expect(dropFor(BlockId.FROSTED_GRASS)).toBe(BlockId.DIRT);
  });

  it("drops the block itself otherwise, and nothing for what can't be held", () => {
    expect(dropFor(BlockId.PLANKS)).toBe(BlockId.PLANKS);
    expect(dropFor(BlockId.CRYSTAL)).toBe(BlockId.CRYSTAL);
    expect(dropFor(BlockId.WATER)).toBe(BlockId.AIR);
    expect(dropFor(BlockId.BEDROCK)).toBe(BlockId.AIR);
  });

  it("only ever drops something the inventory can show", () => {
    for (const def of Object.values(BLOCKS)) {
      const drop = dropFor(def.id);
      if (drop !== BlockId.AIR) expect(INVENTORY_BLOCKS).toContain(drop);
    }
  });
});

describe("digSeconds", () => {
  it("is quick for plants, slower for soil, slowest for rock and ore", () => {
    expect(digSeconds(BlockId.TALL_GRASS)).toBeLessThan(digSeconds(BlockId.DIRT));
    expect(digSeconds(BlockId.DIRT)).toBeLessThan(digSeconds(BlockId.WOOD));
    expect(digSeconds(BlockId.WOOD)).toBeLessThan(digSeconds(BlockId.STONE));
    expect(digSeconds(BlockId.STONE)).toBeLessThan(digSeconds(BlockId.CRYSTAL));
  });

  it("never lets bedrock break, and never asks for more than a couple of seconds", () => {
    expect(digSeconds(BlockId.BEDROCK)).toBe(Infinity);
    for (const def of Object.values(BLOCKS)) {
      if (!def.breakable) continue;
      expect(digSeconds(def.id)).toBeGreaterThan(0);
      expect(digSeconds(def.id)).toBeLessThanOrEqual(2);
    }
  });
});

describe("Bag", () => {
  it("counts what goes in and out", () => {
    const bag = new Bag();
    expect(bag.add(BlockId.DIRT, 3)).toBe(3);
    expect(bag.count(BlockId.DIRT)).toBe(3);
    expect(bag.remove(BlockId.DIRT, 2)).toBe(true);
    expect(bag.count(BlockId.DIRT)).toBe(1);
  });

  it("refuses to take out more than it holds, changing nothing", () => {
    const bag = new Bag();
    bag.add(BlockId.SAND, 1);
    expect(bag.remove(BlockId.SAND, 2)).toBe(false);
    expect(bag.count(BlockId.SAND)).toBe(1);
    expect(bag.remove(BlockId.STONE)).toBe(false);
  });

  it("caps a stack and reports how many fit", () => {
    const bag = new Bag();
    bag.add(BlockId.COBBLE, STACK_LIMIT - 1);
    expect(bag.add(BlockId.COBBLE, 5)).toBe(1);
    expect(bag.count(BlockId.COBBLE)).toBe(STACK_LIMIT);
  });

  it("won't hold what isn't an inventory block", () => {
    const bag = new Bag();
    expect(bag.add(BlockId.WATER)).toBe(0);
    expect(bag.add(BlockId.BEDROCK)).toBe(0);
    expect(bag.owned()).toEqual([]);
  });

  it("lists what's owned in inventory order and forgets emptied stacks", () => {
    const bag = new Bag();
    bag.add(BlockId.SAND);
    bag.add(BlockId.DIRT);
    expect(bag.owned()).toEqual([BlockId.DIRT, BlockId.SAND]);
    bag.remove(BlockId.DIRT);
    expect(bag.owned()).toEqual([BlockId.SAND]);
  });

  it("round-trips through JSON", () => {
    const bag = new Bag();
    bag.add(BlockId.PLANKS, 12);
    bag.add(BlockId.CRYSTAL, 2);
    const copy = new Bag(JSON.parse(JSON.stringify(bag)) as unknown);
    expect(copy.count(BlockId.PLANKS)).toBe(12);
    expect(copy.count(BlockId.CRYSTAL)).toBe(2);
  });

  it("drops anything invalid from a saved bag", () => {
    const bag = new Bag({ "2": 5, "5": 9, "999": 3, "3": -4, "14": "many", "4": 1e9, x: 1 });
    expect(bag.count(BlockId.DIRT)).toBe(5);
    expect(bag.count(BlockId.WATER)).toBe(0);
    expect(bag.count(BlockId.STONE)).toBe(0);
    expect(bag.count(BlockId.PLANKS)).toBe(0);
    expect(bag.count(BlockId.SAND)).toBe(STACK_LIMIT);
    expect(new Bag("nonsense").owned()).toEqual([]);
  });

  it("tells a listener about every change, and only real ones", () => {
    const bag = new Bag();
    let calls = 0;
    bag.onChange = () => calls++;
    bag.add(BlockId.DIRT);
    bag.remove(BlockId.DIRT);
    bag.remove(BlockId.DIRT);
    expect(calls).toBe(2);
  });
});

describe("recipes", () => {
  it("have unique ids, real ingredients and something to show for it", () => {
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    for (const recipe of RECIPES) {
      expect(INVENTORY_BLOCKS).toContain(recipe.output);
      expect(recipe.amount).toBeGreaterThan(0);
      expect(recipe.needs.length).toBeGreaterThan(0);
      for (const [block, amount] of recipe.needs) {
        expect(INVENTORY_BLOCKS).toContain(block);
        expect(amount).toBeGreaterThan(0);
        expect(block).not.toBe(recipe.output);
      }
    }
  });

  it("can all be reached from what the world drops", () => {
    // Everything you can dig up, then everything craftable from that, and so on.
    const reachable = new Set<BlockId>();
    for (const def of Object.values(BLOCKS)) {
      if (def.breakable && def.id !== BlockId.LANTERN && def.id !== BlockId.PLANKS) {
        const drop = dropFor(def.id);
        const crafted: readonly BlockId[] = [
          BlockId.STONE_BRICK,
          BlockId.BRICK,
          BlockId.GLASS,
          BlockId.SANDSTONE,
        ];
        const natural = !crafted.includes(def.id);
        if (drop !== BlockId.AIR && natural) reachable.add(drop);
      }
    }
    for (let pass = 0; pass < 5; pass++) {
      for (const recipe of RECIPES) {
        if (recipe.needs.every(([block]) => reachable.has(block))) reachable.add(recipe.output);
      }
    }
    for (const recipe of RECIPES) expect(reachable.has(recipe.output)).toBe(true);
    expect(reachable.has(BlockId.LANTERN)).toBe(true);
    expect(reachable.has(BlockId.GLASS)).toBe(true);
  });

  it("crafting spends the ingredients and adds the result", () => {
    const bag = new Bag();
    bag.add(BlockId.WOOD, 2);
    const planks = RECIPES.find((r) => r.id === "planks-oak");
    if (!planks) throw new Error("recipe missing");
    expect(canCraft(bag, planks)).toBe(true);
    expect(craft(bag, planks)).toBe(true);
    expect(bag.count(BlockId.WOOD)).toBe(1);
    expect(bag.count(BlockId.PLANKS)).toBe(4);
  });

  it("refuses without the ingredients and leaves the bag alone", () => {
    const bag = new Bag();
    bag.add(BlockId.CRYSTAL, 1);
    bag.add(BlockId.PLANKS, 1);
    const lantern = RECIPES.find((r) => r.id === "lantern");
    if (!lantern) throw new Error("recipe missing");
    expect(craft(bag, lantern)).toBe(false);
    expect(bag.count(BlockId.CRYSTAL)).toBe(1);
    expect(bag.count(BlockId.PLANKS)).toBe(1);
    expect(bag.count(BlockId.LANTERN)).toBe(0);
  });

  it("refuses when the result wouldn't fit", () => {
    const bag = new Bag();
    bag.add(BlockId.WOOD, 1);
    bag.add(BlockId.PLANKS, STACK_LIMIT - 1);
    const planks = RECIPES.find((r) => r.id === "planks-oak");
    if (!planks) throw new Error("recipe missing");
    expect(craft(bag, planks)).toBe(false);
    expect(bag.count(BlockId.WOOD)).toBe(1);
  });
});

describe("Journal", () => {
  const meadow: Surroundings = {
    biome: Biome.PLAINS,
    y: 55,
    underground: false,
    swimming: false,
    flying: false,
    night: 0,
    rain: 0,
    snowing: false,
  };

  it("has a discovery for every biome, all with unique ids", () => {
    const ids = DISCOVERIES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const biome of Object.values(Biome)) expect(ids).toContain(`biome-${biome}`);
  });

  it("unlocks a biome the first time the player stands in it, once", () => {
    const journal = new Journal();
    expect(journal.observe(meadow)).toEqual([`biome-${Biome.PLAINS}`]);
    expect(journal.observe(meadow)).toEqual([]);
    expect(journal.count).toBe(1);
  });

  it("doesn't count a biome flown over or tunnelled under", () => {
    const journal = new Journal();
    expect(journal.observe({ ...meadow, underground: true })).toEqual([]);
    expect(journal.observe({ ...meadow, flying: true })).toEqual(["fly"]);
  });

  it("notices depth, height, swimming, night and weather", () => {
    const journal = new Journal();
    expect(journal.observe({ ...meadow, underground: true, y: 10 })).toContain("deep");
    expect(journal.observe({ ...meadow, biome: Biome.SNOW_PEAK, y: 104 })).toContain("summit");
    expect(journal.observe({ ...meadow, swimming: true })).toContain("swim");
    expect(journal.observe({ ...meadow, night: 1 })).toContain("night");
    expect(journal.observe({ ...meadow, rain: 0.7 })).toEqual(["rain"]);
    expect(journal.observe({ ...meadow, rain: 0.7, snowing: true })).toEqual(["snow"]);
    expect(journal.observe({ ...meadow, rain: 1 })).toEqual(["storm"]);
  });

  it("tracks digging finds and building milestones", () => {
    const journal = new Journal();
    expect(journal.dug(BlockId.DIRT)).toEqual(["first-dig"]);
    expect(journal.dug(BlockId.CRYSTAL)).toEqual(["lumen"]);
    expect(journal.built(BlockId.PLANKS)).toEqual(["first-build"]);
    for (let i = 0; i < 48; i++) expect(journal.built(BlockId.PLANKS)).toEqual([]);
    expect(journal.built(BlockId.LANTERN).sort()).toEqual(["builder", "light"]);
    expect(journal.blocksPlaced).toBe(50);
  });

  it("round-trips through JSON and ignores unknown or malformed entries", () => {
    const journal = new Journal();
    journal.observe(meadow);
    journal.built(BlockId.STONE);
    const copy = new Journal(JSON.parse(JSON.stringify(journal)) as { found: unknown });
    expect(copy.has(`biome-${Biome.PLAINS}`)).toBe(true);
    expect(copy.blocksPlaced).toBe(1);
    const odd = new Journal({ found: ["night", "made-up", 7, null], placed: -3 });
    expect(odd.count).toBe(1);
    expect(odd.blocksPlaced).toBe(0);
    expect(new Journal({ found: "night" }).count).toBe(0);
  });

  it("reports progress out of the full list", () => {
    const journal = new Journal();
    expect(journal.total).toBe(DISCOVERIES.length);
    journal.crafted();
    expect(journal.count).toBe(1);
  });
});

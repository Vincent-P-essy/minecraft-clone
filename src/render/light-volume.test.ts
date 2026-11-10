import { describe, expect, it } from "vitest";
import { BLOCKS, BlockId } from "../world/blocks";
import { Chunk } from "../world/chunk";
import { World } from "../world/world";
import { buildLightVolume, type LightVolume, ORIGIN, STRIDE_Y, STRIDE_Z } from "./light-volume";

function solve(world: World, cx = 0, cz = 0): LightVolume {
  const chunk = world.getChunk(cx, cz);
  if (!chunk) throw new Error("chunk missing");
  return buildLightVolume(chunk.buffer, cx, cz, world);
}

const at = (x: number, y: number, z: number): number => ORIGIN + y * STRIDE_Y + z * STRIDE_Z + x;

function worldWith(build: (chunk: Chunk) => void): World {
  const world = new World(1);
  const chunk = new Chunk(0, 0);
  build(chunk);
  world.setChunk(chunk);
  return world;
}

describe("sky light", () => {
  it("falls unattenuated down an open column and stops at the ground", () => {
    const v = solve(
      worldWith((c) => {
        for (let x = 0; x < 16; x++)
          for (let z = 0; z < 16; z++) c.setBlock(x, 10, z, BlockId.STONE);
      }),
    );
    // Only rows up to one above the highest block are solved — nothing
    // higher is ever read by the mesher.
    expect(v.sky[at(8, 11, 8)]).toBe(15);
    expect(v.sky[at(3, 11, 12)]).toBe(15);
    expect(v.sky[at(8, 10, 8)]).toBe(0); // inside the stone
  });

  it("creeps sideways under a roof, losing one level per block", () => {
    // A floor at y=10 and a roof at y=13 over the whole chunk, open on one edge.
    const v = solve(
      worldWith((c) => {
        for (let x = 0; x < 16; x++) {
          for (let z = 0; z < 16; z++) {
            c.setBlock(x, 10, z, BlockId.STONE);
            c.setBlock(x, 13, z, BlockId.STONE);
          }
        }
      }),
    );
    // x = -1 is open sky (the neighboring chunk is empty air).
    expect(v.sky[at(-1, 11, 8)]).toBe(15);
    expect(v.sky[at(0, 11, 8)]).toBe(14);
    expect(v.sky[at(1, 11, 8)]).toBe(13);
    expect(v.sky[at(5, 11, 8)]).toBe(9);
    // The middle of the room is lit from the nearest edge.
    expect(v.sky[at(8, 11, 8)]).toBe(7);
  });

  it("thins through leaves and faster through water", () => {
    const v = solve(
      worldWith((c) => {
        for (let x = 0; x < 16; x++) {
          for (let z = 0; z < 16; z++) {
            c.setBlock(x, 5, z, BlockId.STONE);
            for (let y = 6; y <= 12; y++) c.setBlock(x, y, z, BlockId.WATER);
            c.setBlock(x, 30, z, BlockId.LEAVES);
          }
        }
      }),
    );
    expect(v.sky[at(8, 31, 8)]).toBe(15);
    expect(v.sky[at(8, 30, 8)]).toBe(14); // one leaf layer
    expect(v.sky[at(8, 20, 8)]).toBe(14); // air below keeps what's left
    expect(v.sky[at(8, 12, 8)]).toBe(12); // first water cell
    expect(v.sky[at(8, 11, 8)]).toBe(10);
    expect(v.sky[at(8, 6, 8)]).toBe(0); // deep water is dark
  });

  it("is never brighter underground than at the surface that feeds it", () => {
    const v = solve(
      worldWith((c) => {
        for (let x = 0; x < 16; x++) {
          for (let z = 0; z < 16; z++) {
            for (let y = 0; y <= 20; y++) c.setBlock(x, y, z, BlockId.STONE);
          }
        }
        // A shaft down from the surface, then a tunnel.
        for (let y = 12; y <= 20; y++) c.setBlock(8, y, 8, BlockId.AIR);
        for (let x = 8; x < 14; x++) c.setBlock(x, 12, 8, BlockId.AIR);
      }),
    );
    expect(v.sky[at(8, 20, 8)]).toBe(15);
    expect(v.sky[at(8, 12, 8)]).toBe(15); // straight down the shaft
    expect(v.sky[at(9, 12, 8)]).toBe(14);
    expect(v.sky[at(13, 12, 8)]).toBe(10);
  });
});

describe("block light", () => {
  it("spreads from a lantern, one level per block, and stops at walls", () => {
    const v = solve(
      worldWith((c) => {
        c.setBlock(8, 30, 8, BlockId.LANTERN);
        // A wall three blocks east of it.
        for (let y = 25; y <= 35; y++)
          for (let z = 3; z <= 13; z++) c.setBlock(11, y, z, BlockId.STONE);
      }),
    );
    expect(v.blk[at(8, 30, 8)]).toBe(15);
    expect(v.blk[at(9, 30, 8)]).toBe(14);
    expect(v.blk[at(10, 30, 8)]).toBe(13);
    expect(v.blk[at(11, 30, 8)]).toBe(0); // the wall itself
    expect(v.blk[at(5, 30, 8)]).toBe(12);
    expect(v.blk[at(8, 33, 8)]).toBe(12);
    // Behind the wall, light has to travel around it: dimmer than a straight line.
    expect(v.blk[at(12, 30, 8)] ?? 0).toBeLessThan(11);
  });

  it("is zero everywhere when nothing emits", () => {
    const v = solve(
      worldWith((c) => {
        c.setBlock(8, 30, 8, BlockId.STONE);
      }),
    );
    expect(v.blk[at(9, 30, 8)]).toBe(0);
    expect(v.blk[at(8, 31, 8)]).toBe(0);
  });

  it("crosses chunk borders: a lantern next door lights this chunk", () => {
    const world = new World(1);
    const here = new Chunk(0, 0);
    here.setBlock(0, 5, 8, BlockId.STONE);
    const next = new Chunk(-1, 0);
    next.setBlock(14, 30, 8, BlockId.LANTERN); // world x = -2
    world.setChunk(here);
    world.setChunk(next);
    const v = solve(world);
    expect(v.blk[at(-1, 30, 8)]).toBe(14);
    expect(v.blk[at(0, 30, 8)]).toBe(13);
    expect(v.blk[at(4, 30, 8)]).toBe(9);
  });

  it("dimmer emitters reach less far", () => {
    const v = solve(
      worldWith((c) => {
        c.setBlock(8, 30, 8, BlockId.CRYSTAL);
      }),
    );
    const emission = BLOCKS[BlockId.CRYSTAL].emission;
    expect(emission).toBeLessThan(BLOCKS[BlockId.LANTERN].emission);
    expect(v.blk[at(8, 30, 8)]).toBe(emission);
    expect(v.blk[at(9, 30, 8)]).toBe(emission - 1);
    expect(v.blk[at(8 + emission, 30, 8)]).toBe(0);
  });
});

describe("buildLightVolume bookkeeping", () => {
  it("reports the highest occupied row", () => {
    const v = solve(
      worldWith((c) => {
        c.setBlock(3, 77, 3, BlockId.STONE);
      }),
    );
    expect(v.top).toBe(78); // row = world y + 1
  });

  it("gives the same answer when called again (scratch buffers are fully reset)", () => {
    const lit = worldWith((c) => {
      c.setBlock(8, 30, 8, BlockId.LANTERN);
    });
    const dark = worldWith((c) => {
      c.setBlock(8, 30, 8, BlockId.STONE);
    });
    expect(solve(lit).blk[at(9, 30, 8)]).toBe(14);
    expect(solve(dark).blk[at(9, 30, 8)]).toBe(0);
    expect(solve(lit).blk[at(9, 30, 8)]).toBe(14);
  });
});

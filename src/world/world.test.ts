import { describe, expect, it } from "vitest";
import { BlockId } from "./blocks";
import { Chunk } from "./chunk";
import { CHUNK_SIZE } from "./coords";
import { World } from "./world";

describe("chunk bookkeeping", () => {
  it("has no chunks initially", () => {
    const world = new World(1);
    expect(world.hasChunk(0, 0)).toBe(false);
    expect(world.getChunk(0, 0)).toBeUndefined();
    expect(world.loadedChunkCount).toBe(0);
  });

  it("stores and retrieves a chunk by its own coordinates", () => {
    const world = new World(1);
    const chunk = new Chunk(2, -3);
    world.setChunk(chunk);
    expect(world.hasChunk(2, -3)).toBe(true);
    expect(world.getChunk(2, -3)).toBe(chunk);
    expect(world.loadedChunkCoords()).toEqual([{ cx: 2, cz: -3 }]);
  });

  it("forgets a chunk after removeChunk", () => {
    const world = new World(1);
    world.setChunk(new Chunk(0, 0));
    world.removeChunk(0, 0);
    expect(world.hasChunk(0, 0)).toBe(false);
  });
});

describe("ensureChunk", () => {
  it("generates a chunk on first access", () => {
    const world = new World(42);
    expect(world.hasChunk(0, 0)).toBe(false);
    const chunk = world.ensureChunk(0, 0);
    expect(chunk.cx).toBe(0);
    expect(chunk.cz).toBe(0);
    expect(world.hasChunk(0, 0)).toBe(true);
  });

  it("returns the same cached instance on repeated access, not a fresh regeneration", () => {
    const world = new World(42);
    const first = world.ensureChunk(1, 1);
    const second = world.ensureChunk(1, 1);
    expect(second).toBe(first);
  });
});

describe("getBlock", () => {
  it("reads air for a chunk that has never been generated", () => {
    const world = new World(1);
    expect(world.getBlock(0, 10, 0)).toBe(BlockId.AIR);
    expect(world.hasChunk(0, 0)).toBe(false); // getBlock must not silently generate
  });

  it("reads back a block set directly on a loaded chunk", () => {
    const world = new World(1);
    const chunk = new Chunk(0, 0);
    chunk.setBlock(3, 5, 7, BlockId.STONE);
    world.setChunk(chunk);
    expect(world.getBlock(3, 5, 7)).toBe(BlockId.STONE);
  });

  it("resolves negative world coordinates into the correct chunk and local position", () => {
    const world = new World(1);
    const chunk = new Chunk(-1, -1);
    chunk.setBlock(CHUNK_SIZE - 1, 0, CHUNK_SIZE - 1, BlockId.SAND); // local (15, 0, 15)
    world.setChunk(chunk);
    expect(world.getBlock(-1, 0, -1)).toBe(BlockId.SAND); // world (-1,-1) -> chunk (-1,-1) local (15,15)
  });
});

describe("setBlock", () => {
  it("auto-generates the target chunk if it isn't loaded yet", () => {
    const world = new World(1);
    expect(world.hasChunk(0, 0)).toBe(false);
    world.setBlock(0, 10, 0, BlockId.WOOD);
    expect(world.hasChunk(0, 0)).toBe(true);
    expect(world.getBlock(0, 10, 0)).toBe(BlockId.WOOD);
  });

  it("round-trips through a chunk boundary correctly", () => {
    const world = new World(1);
    world.setBlock(CHUNK_SIZE, 20, 0, BlockId.LEAVES); // world x=16 -> chunk cx=1, local 0
    expect(world.getBlock(CHUNK_SIZE, 20, 0)).toBe(BlockId.LEAVES);
    expect(world.getChunk(1, 0)?.getBlock(0, 20, 0)).toBe(BlockId.LEAVES);
  });
});

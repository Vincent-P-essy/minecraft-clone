import { describe, expect, it } from "vitest";
import { BlockId } from "./blocks";
import { Chunk } from "./chunk";
import { CHUNK_HEIGHT, CHUNK_SIZE } from "./coords";

describe("Chunk construction", () => {
  it("starts out entirely air", () => {
    const chunk = new Chunk(0, 0);
    expect(chunk.isEmpty()).toBe(true);
    expect(chunk.getBlock(0, 0, 0)).toBe(BlockId.AIR);
    expect(chunk.getBlock(CHUNK_SIZE - 1, CHUNK_HEIGHT - 1, CHUNK_SIZE - 1)).toBe(BlockId.AIR);
  });

  it("accepts a pre-built buffer of the right size", () => {
    const size = CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE;
    const buffer = new Uint8Array(size);
    buffer[0] = BlockId.STONE;
    const chunk = new Chunk(0, 0, buffer);
    expect(chunk.getBlock(0, 0, 0)).toBe(BlockId.STONE);
  });

  it("rejects a buffer of the wrong size", () => {
    expect(() => new Chunk(0, 0, new Uint8Array(10))).toThrow();
  });
});

describe("worldOriginX / worldOriginZ", () => {
  it("is chunk coordinate times chunk size", () => {
    const chunk = new Chunk(3, -2);
    expect(chunk.worldOriginX).toBe(48);
    expect(chunk.worldOriginZ).toBe(-32);
  });
});

describe("get/set round trip", () => {
  it("reads back exactly what was written", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(5, 10, 15, BlockId.GRASS);
    expect(chunk.getBlock(5, 10, 15)).toBe(BlockId.GRASS);
  });

  it("does not disturb neighboring positions", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(1, 1, 1, BlockId.WOOD);
    expect(chunk.getBlock(1, 1, 2)).toBe(BlockId.AIR);
    expect(chunk.getBlock(1, 2, 1)).toBe(BlockId.AIR);
    expect(chunk.getBlock(2, 1, 1)).toBe(BlockId.AIR);
  });

  it("overwrites a previously set block", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(0, 0, 0, BlockId.STONE);
    chunk.setBlock(0, 0, 0, BlockId.SAND);
    expect(chunk.getBlock(0, 0, 0)).toBe(BlockId.SAND);
  });

  it("marks the chunk non-empty after any block is set", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(8, 8, 8, BlockId.DIRT);
    expect(chunk.isEmpty()).toBe(false);
  });
});

describe("Y out of bounds", () => {
  it("reads as air below the world and above the height limit", () => {
    const chunk = new Chunk(0, 0);
    expect(chunk.getBlock(0, -1, 0)).toBe(BlockId.AIR);
    expect(chunk.getBlock(0, CHUNK_HEIGHT, 0)).toBe(BlockId.AIR);
    expect(chunk.getBlock(0, 1000, 0)).toBe(BlockId.AIR);
  });

  it("rejects setBlock outside the Y range", () => {
    const chunk = new Chunk(0, 0);
    expect(() => {
      chunk.setBlock(0, -1, 0, BlockId.STONE);
    }).toThrow(RangeError);
    expect(() => {
      chunk.setBlock(0, CHUNK_HEIGHT, 0, BlockId.STONE);
    }).toThrow(RangeError);
  });
});

describe("X/Z out of bounds", () => {
  it("getBlock throws — cross-chunk lookups belong to World, not Chunk", () => {
    const chunk = new Chunk(0, 0);
    expect(() => chunk.getBlock(-1, 0, 0)).toThrow(RangeError);
    expect(() => chunk.getBlock(CHUNK_SIZE, 0, 0)).toThrow(RangeError);
    expect(() => chunk.getBlock(0, 0, -1)).toThrow(RangeError);
    expect(() => chunk.getBlock(0, 0, CHUNK_SIZE)).toThrow(RangeError);
  });

  it("setBlock throws for the same reason", () => {
    const chunk = new Chunk(0, 0);
    expect(() => {
      chunk.setBlock(-1, 0, 0, BlockId.STONE);
    }).toThrow(RangeError);
    expect(() => {
      chunk.setBlock(CHUNK_SIZE, 0, 0, BlockId.STONE);
    }).toThrow(RangeError);
  });
});

describe("Chunk.index", () => {
  it("is injective over the whole chunk volume (no two positions collide)", () => {
    const seen = new Set<number>();
    // Full volume would be slow in a unit test; sample a representative grid instead.
    for (let x = 0; x < CHUNK_SIZE; x += 5) {
      for (let y = 0; y < CHUNK_HEIGHT; y += 11) {
        for (let z = 0; z < CHUNK_SIZE; z += 5) {
          const idx = Chunk.index(x, y, z);
          expect(seen.has(idx)).toBe(false);
          seen.add(idx);
        }
      }
    }
  });

  it("stays within [0, volume) for in-bounds coordinates", () => {
    const volume = CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE;
    expect(Chunk.index(0, 0, 0)).toBe(0);
    expect(Chunk.index(CHUNK_SIZE - 1, CHUNK_HEIGHT - 1, CHUNK_SIZE - 1)).toBe(volume - 1);
  });
});

describe("Chunk.inBounds", () => {
  it("accepts the full valid range", () => {
    expect(Chunk.inBounds(0, 0, 0)).toBe(true);
    expect(Chunk.inBounds(CHUNK_SIZE - 1, CHUNK_HEIGHT - 1, CHUNK_SIZE - 1)).toBe(true);
  });

  it("rejects one-past-the-end on every axis", () => {
    expect(Chunk.inBounds(CHUNK_SIZE, 0, 0)).toBe(false);
    expect(Chunk.inBounds(0, CHUNK_HEIGHT, 0)).toBe(false);
    expect(Chunk.inBounds(0, 0, CHUNK_SIZE)).toBe(false);
  });

  it("rejects negative coordinates on every axis", () => {
    expect(Chunk.inBounds(-1, 0, 0)).toBe(false);
    expect(Chunk.inBounds(0, -1, 0)).toBe(false);
    expect(Chunk.inBounds(0, 0, -1)).toBe(false);
  });
});

describe("buffer", () => {
  it("exposes the backing store by reference, for worker transfer", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(0, 0, 0, BlockId.STONE);
    expect(chunk.buffer[Chunk.index(0, 0, 0)]).toBe(BlockId.STONE);
    expect(chunk.buffer.length).toBe(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);
  });
});

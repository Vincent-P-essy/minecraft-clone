import { describe, expect, it } from "vitest";
import {
  affectedChunkCoords,
  CHUNK_SIZE,
  chunkDistanceSquared,
  chunkKey,
  worldToChunk,
  worldToChunkCoord,
  worldToLocal,
} from "./coords";

describe("worldToChunk", () => {
  it("maps positive coordinates within chunk 0", () => {
    expect(worldToChunk(0)).toBe(0);
    expect(worldToChunk(15)).toBe(0);
  });

  it("rolls over to the next chunk at the boundary", () => {
    expect(worldToChunk(16)).toBe(1);
    expect(worldToChunk(31)).toBe(1);
    expect(worldToChunk(32)).toBe(2);
  });

  it("floors toward negative infinity, not toward zero", () => {
    expect(worldToChunk(-1)).toBe(-1);
    expect(worldToChunk(-16)).toBe(-1);
    expect(worldToChunk(-17)).toBe(-2);
  });
});

describe("worldToLocal", () => {
  it("matches worldCoord for positive in-chunk coordinates", () => {
    expect(worldToLocal(0)).toBe(0);
    expect(worldToLocal(5)).toBe(5);
    expect(worldToLocal(15)).toBe(15);
  });

  it("wraps at the chunk boundary", () => {
    expect(worldToLocal(16)).toBe(0);
    expect(worldToLocal(31)).toBe(15);
  });

  it("stays positive for negative world coordinates", () => {
    expect(worldToLocal(-1)).toBe(15);
    expect(worldToLocal(-16)).toBe(0);
    expect(worldToLocal(-17)).toBe(15);
  });

  it("always returns a value in [0, CHUNK_SIZE)", () => {
    for (let x = -50; x <= 50; x++) {
      const local = worldToLocal(x);
      expect(local).toBeGreaterThanOrEqual(0);
      expect(local).toBeLessThan(CHUNK_SIZE);
    }
  });
});

describe("worldToChunk / worldToLocal round-trip", () => {
  it("reconstructs the original world coordinate", () => {
    for (let x = -40; x <= 40; x++) {
      const rebuilt = worldToChunk(x) * CHUNK_SIZE + worldToLocal(x);
      expect(rebuilt).toBe(x);
    }
  });
});

describe("chunkKey", () => {
  it("is stable for the same coordinates", () => {
    expect(chunkKey(3, -2)).toBe(chunkKey(3, -2));
  });

  it("distinguishes different coordinates, including sign", () => {
    expect(chunkKey(1, 2)).not.toBe(chunkKey(2, 1));
    expect(chunkKey(-1, 0)).not.toBe(chunkKey(1, 0));
  });
});

describe("worldToChunkCoord", () => {
  it("combines both axes independently", () => {
    expect(worldToChunkCoord(20, -5)).toEqual({ cx: 1, cz: -1 });
  });
});

describe("chunkDistanceSquared", () => {
  it("is zero for the same chunk", () => {
    expect(chunkDistanceSquared({ cx: 2, cz: 3 }, { cx: 2, cz: 3 })).toBe(0);
  });

  it("matches squared Euclidean distance on the chunk grid", () => {
    expect(chunkDistanceSquared({ cx: 0, cz: 0 }, { cx: 3, cz: 4 })).toBe(25);
  });
});

describe("affectedChunkCoords", () => {
  it("is just the owning chunk for an edit in the chunk's interior", () => {
    expect(affectedChunkCoords(8, 8)).toEqual([{ cx: 0, cz: 0 }]);
  });

  it("also touches the -X neighbor when the edit is on the chunk's west edge", () => {
    const coords = affectedChunkCoords(0, 8); // local x = 0
    expect(coords).toContainEqual({ cx: 0, cz: 0 });
    expect(coords).toContainEqual({ cx: -1, cz: 0 });
    expect(coords).toHaveLength(2);
  });

  it("also touches the +X neighbor when the edit is on the chunk's east edge", () => {
    const coords = affectedChunkCoords(CHUNK_SIZE - 1, 8);
    expect(coords).toContainEqual({ cx: 0, cz: 0 });
    expect(coords).toContainEqual({ cx: 1, cz: 0 });
    expect(coords).toHaveLength(2);
  });

  it("also touches the -Z and +Z neighbors on the corresponding edges", () => {
    expect(affectedChunkCoords(8, 0)).toContainEqual({ cx: 0, cz: -1 });
    expect(affectedChunkCoords(8, CHUNK_SIZE - 1)).toContainEqual({ cx: 0, cz: 1 });
  });

  it("touches both X and Z neighbors (but not the diagonal) at a corner", () => {
    const coords = affectedChunkCoords(0, 0); // local (0, 0): the chunk's NW-most cell
    expect(coords).toContainEqual({ cx: 0, cz: 0 });
    expect(coords).toContainEqual({ cx: -1, cz: 0 });
    expect(coords).toContainEqual({ cx: 0, cz: -1 });
    expect(coords).not.toContainEqual({ cx: -1, cz: -1 });
    expect(coords).toHaveLength(3);
  });

  it("resolves negative world coordinates into the right chunk edges too", () => {
    // world x = -1 is local x = 15 (CHUNK_SIZE - 1) of chunk cx = -1.
    const coords = affectedChunkCoords(-1, 8);
    expect(coords).toContainEqual({ cx: -1, cz: 0 });
    expect(coords).toContainEqual({ cx: 0, cz: 0 });
  });
});

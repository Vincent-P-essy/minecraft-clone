import { describe, expect, it } from "vitest";
import type { SolidQuery } from "./physics";
import { raycastVoxels } from "./raycast";

const singleBlock = (bx: number, by: number, bz: number): SolidQuery => {
  return (x, y, z) => x === bx && y === by && z === bz;
};

describe("raycastVoxels basics", () => {
  it("returns null for a zero-length direction", () => {
    expect(raycastVoxels({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 10, () => false)).toBeNull();
  });

  it("returns null when nothing solid is within range", () => {
    expect(raycastVoxels({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 5, () => false)).toBeNull();
  });

  it("returns null when the target is just beyond maxDistance", () => {
    const isSolid = singleBlock(0, 0, 0);
    const hit = raycastVoxels({ x: 0.5, y: 10.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, 5, isSolid);
    expect(hit).toBeNull();
  });

  it("hits the degenerate case of starting inside solid geometry at distance 0", () => {
    const isSolid = singleBlock(0, 0, 0);
    const hit = raycastVoxels({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 5, isSolid);
    expect(hit).not.toBeNull();
    expect(hit?.distance).toBe(0);
    expect(hit).toMatchObject({ blockX: 0, blockY: 0, blockZ: 0 });
  });
});

describe("raycastVoxels axis-aligned faces", () => {
  it("looking straight down hits the top face", () => {
    const isSolid = singleBlock(0, 4, 0);
    const hit = raycastVoxels({ x: 0.5, y: 10.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, 20, isSolid);
    expect(hit).toMatchObject({ blockX: 0, blockY: 4, blockZ: 0, face: "top" });
    expect(hit?.distance).toBeCloseTo(10.5 - 5); // travels down to y=5 (block top)
    expect(hit).toMatchObject({ placeX: 0, placeY: 5, placeZ: 0 });
  });

  it("looking straight up hits the bottom face", () => {
    const isSolid = singleBlock(0, 10, 0);
    const hit = raycastVoxels({ x: 0.5, y: 5.5, z: 0.5 }, { x: 0, y: 1, z: 0 }, 20, isSolid);
    expect(hit).toMatchObject({ blockX: 0, blockY: 10, blockZ: 0, face: "bottom" });
    expect(hit).toMatchObject({ placeX: 0, placeY: 9, placeZ: 0 });
  });

  it("looking down +X hits the west face", () => {
    const isSolid = singleBlock(5, 0, 0);
    const hit = raycastVoxels({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 20, isSolid);
    expect(hit).toMatchObject({ blockX: 5, blockY: 0, blockZ: 0, face: "west" });
    expect(hit).toMatchObject({ placeX: 4, placeY: 0, placeZ: 0 });
  });

  it("looking down -X hits the east face", () => {
    const isSolid = singleBlock(-5, 0, 0);
    const hit = raycastVoxels({ x: 0.5, y: 0.5, z: 0.5 }, { x: -1, y: 0, z: 0 }, 20, isSolid);
    expect(hit).toMatchObject({ blockX: -5, blockY: 0, blockZ: 0, face: "east" });
    expect(hit).toMatchObject({ placeX: -4, placeY: 0, placeZ: 0 });
  });

  it("looking down +Z hits the north face", () => {
    const isSolid = singleBlock(0, 0, 5);
    const hit = raycastVoxels({ x: 0.5, y: 0.5, z: 0.5 }, { x: 0, y: 0, z: 1 }, 20, isSolid);
    expect(hit).toMatchObject({ blockX: 0, blockY: 0, blockZ: 5, face: "north" });
    expect(hit).toMatchObject({ placeX: 0, placeY: 0, placeZ: 4 });
  });

  it("looking down -Z hits the south face", () => {
    const isSolid = singleBlock(0, 0, -5);
    const hit = raycastVoxels({ x: 0.5, y: 0.5, z: 0.5 }, { x: 0, y: 0, z: -1 }, 20, isSolid);
    expect(hit).toMatchObject({ blockX: 0, blockY: 0, blockZ: -5, face: "south" });
    expect(hit).toMatchObject({ placeX: 0, placeY: 0, placeZ: -4 });
  });
});

describe("raycastVoxels diagonal rays", () => {
  it("walks every intervening voxel rather than skipping over a thin obstacle", () => {
    // A single-block-thick wall diagonally offset from the origin. A naive
    // fixed-step sampler could jump clean over it; DDA must not.
    const isSolid = singleBlock(3, 3, 3);
    const hit = raycastVoxels({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 1, z: 1 }, 20, isSolid);
    expect(hit).not.toBeNull();
    expect(hit).toMatchObject({ blockX: 3, blockY: 3, blockZ: 3 });
  });

  it("reports a placeX/Y/Z that is itself non-solid and adjacent to the hit", () => {
    const isSolid = singleBlock(3, 3, 3);
    const hit = raycastVoxels({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 1, z: 1 }, 20, isSolid);
    expect(hit).not.toBeNull();
    if (!hit) throw new Error("expected a hit");
    expect(isSolid(hit.placeX, hit.placeY, hit.placeZ)).toBe(false);
    const dx = Math.abs(hit.placeX - hit.blockX);
    const dy = Math.abs(hit.placeY - hit.blockY);
    const dz = Math.abs(hit.placeZ - hit.blockZ);
    // Exactly one axis differs by 1, the others by 0 — a face-adjacent cell.
    expect([dx, dy, dz].filter((d) => d === 1).length).toBe(1);
    expect([dx, dy, dz].filter((d) => d === 0).length).toBe(2);
  });

  it("stops at the first solid voxel along the path, not a farther one", () => {
    const nearAndFar: SolidQuery = (x, y, z) =>
      (x === 2 && y === 2 && z === 2) || (x === 5 && y === 5 && z === 5);
    const hit = raycastVoxels({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 1, z: 1 }, 20, nearAndFar);
    expect(hit).toMatchObject({ blockX: 2, blockY: 2, blockZ: 2 });
  });
});

describe("raycastVoxels normalizes direction", () => {
  it("gives the same hit for a normalized and an unnormalized direction", () => {
    const isSolid = singleBlock(0, 4, 0);
    const a = raycastVoxels({ x: 0.5, y: 10.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, 20, isSolid);
    const b = raycastVoxels({ x: 0.5, y: 10.5, z: 0.5 }, { x: 0, y: -100, z: 0 }, 20, isSolid);
    expect(a).toEqual(b);
  });
});

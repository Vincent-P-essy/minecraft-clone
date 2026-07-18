import { describe, expect, it } from "vitest";
import { CLOUD_CELL_SIZE, cloudCellsAround } from "./clouds";

describe("cloudCellsAround", () => {
  it("is deterministic per seed", () => {
    expect(cloudCellsAround(42, 0, 0, 6, 0)).toEqual(cloudCellsAround(42, 0, 0, 6, 0));
  });

  it("different seeds give different cloud patterns", () => {
    const a = cloudCellsAround(1, 0, 0, 8, 0);
    const b = cloudCellsAround(2, 0, 0, 8, 0);
    expect(a).not.toEqual(b);
  });

  it("covers some but not all of the sky", () => {
    const cells = cloudCellsAround(2026, 0, 0, 8, 0);
    const totalCells = 17 * 17;
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(totalCells);
  });

  it("drift translates the same tiles instead of re-rolling them", () => {
    const before = cloudCellsAround(7, 0, 0, 6, 0);
    const after = cloudCellsAround(7, 0, 0, 6, 5);
    // Compare in drift-anchored space: subtracting the drift must recover
    // the same underlying tile set (modulo tiles entering/leaving the edge).
    const anchored = (cells: { x: number; z: number }[], drift: number): Set<string> =>
      new Set(cells.map((c) => `${(c.x - drift).toString()},${c.z.toString()}`));
    const a = anchored(before, 0);
    const b = anchored(after, 5);
    let common = 0;
    for (const key of a) if (b.has(key)) common++;
    expect(common).toBeGreaterThan(Math.min(a.size, b.size) * 0.8);
  });

  it("tiles snap to the cloud grid in drift-anchored space", () => {
    for (const cell of cloudCellsAround(9, 100, -50, 5, 12.5)) {
      expect((cell.x - 12.5) % CLOUD_CELL_SIZE).toBeCloseTo(0);
      expect(cell.z % CLOUD_CELL_SIZE).toBeCloseTo(0);
    }
  });
});

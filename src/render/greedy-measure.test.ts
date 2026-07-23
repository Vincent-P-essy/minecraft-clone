import { describe, expect, it } from "vitest";
import { BlockId } from "../world/blocks";
import { generateChunk } from "../world/terrain";
import { World } from "../world/world";
import { meshChunk, shouldRenderFace } from "./mesher";

/** Measures — and guards — the greedy-meshing win: how many quads the
 * greedy mesher emits versus the naive count of exposed faces, over a patch
 * of actual generated terrain. A regression that stops faces merging would
 * blow past the ratio and fail here. */
describe("greedy meshing measurement", () => {
  it("emits meaningfully fewer quads than exposed faces over real terrain", () => {
    const seed = 2026;
    const world = new World(seed);
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) {
        world.setChunk(generateChunk(cx, cz, seed));
      }
    }

    let naiveFaces = 0;
    let greedyQuads = 0;
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) {
        const chunk = world.getChunk(cx, cz);
        if (!chunk) continue;
        greedyQuads += meshChunk(chunk, world).indices.length / 6;

        const ox = cx * 16;
        const oz = cz * 16;
        for (let x = 0; x < 16; x++) {
          for (let z = 0; z < 16; z++) {
            for (let y = 0; y < 96; y++) {
              const self = world.getBlock(ox + x, y, oz + z);
              if (self === BlockId.AIR) continue;
              const dirs: [number, number, number][] = [
                [1, 0, 0],
                [-1, 0, 0],
                [0, 1, 0],
                [0, -1, 0],
                [0, 0, 1],
                [0, 0, -1],
              ];
              for (const [dx, dy, dz] of dirs) {
                const nb = world.getBlock(ox + x + dx, y + dy, oz + z + dz);
                if (shouldRenderFace(self, nb)) naiveFaces++;
              }
            }
          }
        }
      }
    }

    const pct = (100 * (1 - greedyQuads / naiveFaces)).toFixed(1);
    console.log(
      `greedy meshing: ${naiveFaces.toString()} exposed faces -> ${greedyQuads.toString()} quads (${pct}% fewer)`,
    );
    expect(greedyQuads).toBeLessThan(naiveFaces * 0.85); // at least ~15% fewer
    expect(greedyQuads).toBeGreaterThan(0);
  });
});

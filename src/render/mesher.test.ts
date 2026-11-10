import { describe, expect, it } from "vitest";
import { BlockId } from "../world/blocks";
import { Chunk } from "../world/chunk";
import { generateChunk } from "../world/terrain";
import { World } from "../world/world";
import { FACE_ORDER, tileForBlockFace } from "./atlas-layout";
import {
  FACES,
  type MeshData,
  type NeighborLookup,
  meshChunk,
  quadCount,
  quadIndexOrder,
  shouldRenderFace,
  SWAY_LEAVES,
  SWAY_PLANT,
  type UnpackedVertex,
  unpackVertex,
  vertexAOLevel,
} from "./mesher";

const allAir: NeighborLookup = { getBlock: () => BlockId.AIR };

type Quad = readonly [UnpackedVertex, UnpackedVertex, UnpackedVertex, UnpackedVertex];

function quadsOf(vertices: Uint32Array): Quad[] {
  const quads: Quad[] = [];
  for (let q = 0; q < quadCount(vertices); q++) {
    const at = (n: number): UnpackedVertex =>
      unpackVertex(vertices[q * 8 + n * 2] ?? 0, vertices[q * 8 + n * 2 + 1] ?? 0);
    quads.push([at(0), at(1), at(2), at(3)]);
  }
  return quads;
}

function faceIndex(name: (typeof FACE_ORDER)[number]): number {
  return FACE_ORDER.indexOf(name);
}

function withFace(mesh: MeshData, name: (typeof FACE_ORDER)[number]): Quad[] {
  return quadsOf(mesh.opaque).filter((q) => !q[0].cross && q[0].face === faceIndex(name));
}

/** The geometric normal of the quad's first triangle (vertices 0, 1, 2). */
function windingNormal(quad: Quad): [number, number, number] {
  const [a, b, c] = quad;
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function chunkWith(...blocks: readonly (readonly [number, number, number, BlockId])[]): Chunk {
  const chunk = new Chunk(0, 0);
  for (const [x, y, z, id] of blocks) chunk.setBlock(x, y, z, id);
  return chunk;
}

function slab(size: number, y: number, id: BlockId = BlockId.STONE): Chunk {
  const chunk = new Chunk(0, 0);
  for (let x = 0; x < size; x++) {
    for (let z = 0; z < size; z++) chunk.setBlock(x, y, z, id);
  }
  return chunk;
}

describe("shouldRenderFace", () => {
  it("air never renders a face", () => {
    expect(shouldRenderFace(BlockId.AIR, BlockId.AIR)).toBe(false);
    expect(shouldRenderFace(BlockId.AIR, BlockId.STONE)).toBe(false);
  });

  it("a solid block against air renders", () => {
    expect(shouldRenderFace(BlockId.STONE, BlockId.AIR)).toBe(true);
  });

  it("a solid block against an opaque neighbor is fully hidden", () => {
    expect(shouldRenderFace(BlockId.STONE, BlockId.DIRT)).toBe(false);
  });

  it("a solid block against a transparent neighbor renders", () => {
    expect(shouldRenderFace(BlockId.STONE, BlockId.WATER)).toBe(true);
    expect(shouldRenderFace(BlockId.STONE, BlockId.GLASS)).toBe(true);
    expect(shouldRenderFace(BlockId.GRASS, BlockId.TALL_GRASS)).toBe(true);
  });

  it("two blocks of the same transparent kind don't render an interior face", () => {
    expect(shouldRenderFace(BlockId.WATER, BlockId.WATER)).toBe(false);
    expect(shouldRenderFace(BlockId.LEAVES, BlockId.LEAVES)).toBe(false);
    expect(shouldRenderFace(BlockId.GLASS, BlockId.GLASS)).toBe(false);
  });

  it("two different transparent kinds still render a face between them", () => {
    expect(shouldRenderFace(BlockId.WATER, BlockId.LEAVES)).toBe(true);
  });
});

describe("meshChunk on an empty chunk", () => {
  it("produces no geometry at all", () => {
    const mesh = meshChunk(new Chunk(0, 0), allAir);
    expect(mesh.opaque).toHaveLength(0);
    expect(mesh.water).toHaveLength(0);
    expect(mesh.caveStart).toBe(0);
  });
});

describe("meshChunk on a single isolated block", () => {
  const mesh = meshChunk(chunkWith([5, 10, 5, BlockId.STONE]), allAir);
  const quads = quadsOf(mesh.opaque);

  it("emits exactly 6 faces, one per side of the cube", () => {
    expect(quads).toHaveLength(6);
    expect(new Set(quads.map((q) => q[0].face)).size).toBe(6);
  });

  it("packs two words per vertex, four vertices per quad", () => {
    expect(mesh.opaque).toHaveLength(6 * 4 * 2);
  });

  it("places every vertex on the block's corners", () => {
    for (const quad of quads) {
      for (const v of quad) {
        expect([5, 6]).toContain(v.x);
        expect([10, 11]).toContain(v.y);
        expect([5, 6]).toContain(v.z);
      }
    }
  });

  it("every quad's winding matches the normal of its face", () => {
    for (const quad of quads) {
      const spec = FACES[quad[0].face];
      if (!spec) throw new Error("unknown face");
      const [nx, ny, nz] = windingNormal(quad);
      const dot = nx * spec.normal[0] + ny * spec.normal[1] + nz * spec.normal[2];
      expect(dot).toBeGreaterThan(0);
    }
  });

  it("is fully open: no ambient occlusion, full sky light, no block light", () => {
    for (const quad of quads) {
      for (const v of quad) {
        expect(v.ao).toBe(3);
        expect(v.sky).toBe(15);
        expect(v.block).toBe(0);
      }
    }
  });

  it("reports the block's vertical extent for culling", () => {
    expect(mesh.minY).toBe(10);
    expect(mesh.maxY).toBe(11);
  });

  it("assigns every quad the tile for its block face", () => {
    for (const quad of quads) {
      const face = FACE_ORDER[quad[0].face];
      if (!face) throw new Error("unknown face");
      expect(quad[0].tile).toBe(tileForBlockFace(BlockId.STONE, face));
    }
  });
});

describe("meshChunk never draws the underside of the world", () => {
  it("skips bottom faces at y = 0", () => {
    const mesh = meshChunk(chunkWith([3, 0, 3, BlockId.BEDROCK]), allAir);
    expect(quadsOf(mesh.opaque)).toHaveLength(5);
    expect(withFace(mesh, "bottom")).toHaveLength(0);
  });
});

describe("greedy meshing", () => {
  it("culls the shared interior face and merges the coplanar rest of two neighbors", () => {
    const mesh = meshChunk(chunkWith([5, 10, 5, BlockId.STONE], [6, 10, 5, BlockId.STONE]), allAir);
    // 2 end caps + 4 long sides, each merged into one quad.
    expect(quadsOf(mesh.opaque)).toHaveLength(6);
  });

  it("merges a flat NxN slab's top into a single quad spanning it", () => {
    const mesh = meshChunk(slab(8, 20), allAir);
    const tops = withFace(mesh, "top");
    expect(tops).toHaveLength(1);
    const xs = tops[0]?.map((v) => v.x) ?? [];
    const zs = tops[0]?.map((v) => v.z) ?? [];
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(8);
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBe(8);
  });

  it("keeps faces separate where ambient occlusion varies (a block on the slab)", () => {
    const chunk = slab(8, 20);
    chunk.setBlock(4, 21, 4, BlockId.STONE);
    const slabTops = withFace(meshChunk(chunk, allAir), "top").filter((q) => q[0].y === 21);
    expect(slabTops.length).toBeGreaterThan(1);
  });

  it("does not merge across different tiles", () => {
    const chunk = slab(4, 20);
    chunk.setBlock(1, 20, 1, BlockId.DIRT);
    expect(withFace(meshChunk(chunk, allAir), "top").length).toBeGreaterThan(1);
  });

  it("merges leaves like any block, flagged as foliage but not displaced", () => {
    const mesh = meshChunk(slab(3, 20, BlockId.LEAVES), allAir);
    const tops = withFace(mesh, "top");
    expect(tops).toHaveLength(1);
    for (const v of tops[0] ?? []) {
      expect(v.sway).toBe(SWAY_LEAVES);
      expect(v.swayOn).toBe(false);
    }
  });

  it("the always-drawn (sunlit) range is a small fraction of all exposed faces on real terrain", () => {
    const seed = 2026;
    const world = new World(seed);
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) world.setChunk(generateChunk(cx, cz, seed));
    }
    let naive = 0;
    let surface = 0;
    let total = 0;
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) {
        const chunk = world.getChunk(cx, cz);
        if (!chunk) continue;
        const mesh = meshChunk(chunk, world);
        surface += mesh.caveStart + quadCount(mesh.water);
        total += quadCount(mesh.opaque) + quadCount(mesh.water);
        for (let x = 0; x < 16; x++) {
          for (let z = 0; z < 16; z++) {
            for (let y = 0; y < 128; y++) {
              const self = world.getBlock(cx * 16 + x, y, cz * 16 + z);
              if (self === BlockId.AIR) continue;
              for (const spec of FACES) {
                if (y === 0 && spec.face === "bottom") continue;
                const nb = world.getBlock(
                  cx * 16 + x + spec.normal[0],
                  y + spec.normal[1],
                  cz * 16 + z + spec.normal[2],
                );
                if (shouldRenderFace(self, nb)) naive++;
              }
            }
          }
        }
      }
    }
    expect(total).toBeGreaterThan(0);
    // Everything the mesher emits is fewer quads than there are faces...
    expect(total).toBeLessThan(naive);
    // ...and what's drawn out to the horizon is well under half of them.
    expect(surface).toBeLessThan(naive * 0.5);
  });
});

describe("meshChunk across a chunk boundary", () => {
  const edge = chunkWith([15, 10, 5, BlockId.STONE]);

  it("hides the face against a solid block in the neighboring chunk", () => {
    const neighbors: NeighborLookup = {
      getBlock: (x, y, z) => (x === 16 && y === 10 && z === 5 ? BlockId.STONE : BlockId.AIR),
    };
    expect(withFace(meshChunk(edge, neighbors), "east")).toHaveLength(0);
  });

  it("shows the face when the neighboring chunk is air at that position", () => {
    expect(withFace(meshChunk(edge, allAir), "east")).toHaveLength(1);
  });

  it("reads neighbors through the chunk-buffer fast path too", () => {
    const world = new World(1);
    world.setChunk(edge);
    const next = new Chunk(1, 0);
    next.setBlock(0, 10, 5, BlockId.STONE);
    world.setChunk(next);
    expect(withFace(meshChunk(edge, world), "east")).toHaveLength(0);
  });
});

describe("vertexAOLevel", () => {
  it("is fully open with no occluders", () => {
    expect(vertexAOLevel(false, false, false)).toBe(3);
  });

  it("drops one level per single occluder", () => {
    expect(vertexAOLevel(true, false, false)).toBe(2);
    expect(vertexAOLevel(false, true, false)).toBe(2);
    expect(vertexAOLevel(false, false, true)).toBe(2);
  });

  it("is fully pinched when both edge neighbors occlude, regardless of the corner", () => {
    expect(vertexAOLevel(true, true, false)).toBe(0);
    expect(vertexAOLevel(true, true, true)).toBe(0);
  });

  it("one side plus the corner gives level 1", () => {
    expect(vertexAOLevel(true, false, true)).toBe(1);
  });
});

describe("quadIndexOrder", () => {
  it("keeps the 0-2 diagonal when that pair is at least as bright", () => {
    expect(quadIndexOrder([3, 3, 3, 3])).toEqual([0, 1, 2, 0, 2, 3]);
    expect(quadIndexOrder([3, 1, 3, 1])).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("flips to the 1-3 diagonal when that pair is brighter", () => {
    expect(quadIndexOrder([1, 3, 1, 3])).toEqual([1, 2, 3, 1, 3, 0]);
  });

  it("both orderings reference each vertex of the quad", () => {
    expect(new Set(quadIndexOrder([3, 3, 3, 3])).size).toBe(4);
    expect(new Set(quadIndexOrder([0, 3, 0, 3])).size).toBe(4);
  });
});

describe("meshChunk ambient occlusion", () => {
  it("a block standing on a slab darkens exactly the slab vertices at its foot", () => {
    const chunk = slab(8, 20);
    chunk.setBlock(4, 21, 4, BlockId.STONE);
    const tops = withFace(meshChunk(chunk, allAir), "top").filter((q) => q[0].y === 21);
    const darkened = new Set<string>();
    for (const quad of tops) {
      for (const v of quad) {
        if (v.ao < 3) darkened.add(`${v.x.toString()},${v.z.toString()}`);
      }
    }
    // The four corners of the block's footprint.
    expect([...darkened].sort()).toEqual(["4,4", "4,5", "5,4", "5,5"]);
  });

  it("winding still matches normals when shading flips the quad diagonal", () => {
    const chunk = slab(8, 20);
    chunk.setBlock(4, 21, 4, BlockId.STONE);
    chunk.setBlock(2, 21, 5, BlockId.STONE);
    for (const quad of quadsOf(meshChunk(chunk, allAir).opaque)) {
      const spec = FACES[quad[0].face];
      if (!spec) throw new Error("unknown face");
      const [nx, ny, nz] = windingNormal(quad);
      expect(nx * spec.normal[0] + ny * spec.normal[1] + nz * spec.normal[2]).toBeGreaterThan(0);
    }
  });

  it("glass and plants don't darken the faces around them", () => {
    const chunk = slab(8, 20);
    chunk.setBlock(4, 21, 4, BlockId.GLASS);
    chunk.setBlock(2, 21, 2, BlockId.TALL_GRASS);
    const tops = withFace(meshChunk(chunk, allAir), "top").filter((q) => q[0].y === 21);
    for (const quad of tops) {
      for (const v of quad) expect(v.ao).toBe(3);
    }
  });
});

describe("meshChunk lighting", () => {
  it("lights faces under open sky fully and faces inside a sealed room not at all", () => {
    // A hollow 5x5x5 stone box: the inside never sees the sky.
    const chunk = new Chunk(0, 0);
    for (let x = 2; x <= 6; x++) {
      for (let y = 10; y <= 14; y++) {
        for (let z = 2; z <= 6; z++) {
          const shell = x === 2 || x === 6 || y === 10 || y === 14 || z === 2 || z === 6;
          if (shell) chunk.setBlock(x, y, z, BlockId.STONE);
        }
      }
    }
    const mesh = meshChunk(chunk, allAir);
    const roofTop = withFace(mesh, "top").filter((q) => q[0].y === 15);
    const floorInside = withFace(mesh, "top").filter((q) => q[0].y === 11);
    expect(roofTop.length).toBeGreaterThan(0);
    expect(floorInside.length).toBeGreaterThan(0);
    for (const quad of roofTop) for (const v of quad) expect(v.sky).toBe(15);
    for (const quad of floorInside) for (const v of quad) expect(v.sky).toBe(0);
  });

  it("a lantern lights the floor around it, brightest right beside it", () => {
    const chunk = slab(12, 20);
    // A roof so the sky doesn't wash the floor.
    for (let x = 0; x < 12; x++)
      for (let z = 0; z < 12; z++) chunk.setBlock(x, 24, z, BlockId.STONE);
    chunk.setBlock(6, 21, 6, BlockId.LANTERN);
    const floor = withFace(meshChunk(chunk, allAir), "top").filter((q) => q[0].y === 21);
    let near = 0;
    let far = 15;
    for (const quad of floor) {
      for (const v of quad) {
        const distance = Math.abs(v.x - 6.5) + Math.abs(v.z - 6.5);
        if (distance <= 1.5) near = Math.max(near, v.block);
        if (distance >= 9) far = Math.min(far, v.block);
      }
    }
    expect(near).toBeGreaterThanOrEqual(12);
    expect(far).toBeLessThan(near - 5);
  });

  it("marks the lantern's own faces as emissive", () => {
    const mesh = meshChunk(chunkWith([5, 10, 5, BlockId.LANTERN]), allAir);
    for (const quad of quadsOf(mesh.opaque)) expect(quad[0].emissive).toBe(true);
    const stone = meshChunk(chunkWith([5, 10, 5, BlockId.STONE]), allAir);
    for (const quad of quadsOf(stone.opaque)) expect(quad[0].emissive).toBe(false);
  });
});

describe("meshChunk water", () => {
  // A 6x6 pond, two deep, in a stone basin.
  function pond(): Chunk {
    const chunk = new Chunk(0, 0);
    for (let x = 0; x < 10; x++) {
      for (let z = 0; z < 10; z++) {
        const inside = x >= 2 && x < 8 && z >= 2 && z < 8;
        chunk.setBlock(x, 18, z, BlockId.STONE);
        chunk.setBlock(x, 19, z, inside ? BlockId.WATER : BlockId.STONE);
        chunk.setBlock(x, 20, z, inside ? BlockId.WATER : BlockId.STONE);
      }
    }
    return chunk;
  }
  const mesh = meshChunk(pond(), allAir);
  const water = quadsOf(mesh.water);

  it("puts water in its own buffer, and nothing else there", () => {
    expect(water.length).toBeGreaterThan(0);
    for (const quad of water) expect(quad[0].tile).toBe(tileForBlockFace(BlockId.WATER, "top"));
    for (const quad of quadsOf(mesh.opaque)) {
      expect(quad[0].tile).not.toBe(tileForBlockFace(BlockId.WATER, "top"));
    }
  });

  it("only draws the surface: no faces between water cells or against the basin", () => {
    for (const quad of water) expect(quad[0].face).toBe(faceIndex("top"));
  });

  it("flags surface vertices so the shader can lower them", () => {
    for (const quad of water) for (const v of quad) expect(v.surface).toBe(true);
  });

  it("reports zero depth along the shore and the full depth in the middle", () => {
    const depths = new Map<string, number>();
    for (const quad of water) {
      for (const v of quad) depths.set(`${v.x.toString()},${v.z.toString()}`, v.depth);
    }
    expect(depths.get("2,2")).toBe(0); // a corner of the pond touches rock
    expect(depths.get("2,3")).toBe(0); // so does its edge
    expect(depths.get("3,3")).toBe(2); // one cell in: open water, two deep
    expect(depths.get("7,7")).toBe(2);
    expect(depths.get("8,8")).toBe(0);
  });

  it("the basin floor under the water is still drawn (water doesn't hide it)", () => {
    const floor = withFace(mesh, "top").filter((q) => q[0].y === 19);
    expect(floor.length).toBeGreaterThan(0);
  });
});

describe("meshChunk plants", () => {
  const chunk = slab(4, 20, BlockId.GRASS);
  chunk.setBlock(1, 21, 1, BlockId.TALL_GRASS);
  const crossQuads = quadsOf(meshChunk(chunk, allAir).opaque).filter((q) => q[0].cross);

  it("draws a plant as two crossed planes, both sides", () => {
    expect(crossQuads).toHaveLength(4);
  });

  it("anchors the roots and lets only the tips sway", () => {
    for (const quad of crossQuads) {
      for (const v of quad) {
        expect(v.sway).toBe(SWAY_PLANT);
        expect(v.swayOn).toBe(v.y === 22);
      }
    }
  });

  it("the two sides of each plane face opposite ways", () => {
    const normals = crossQuads.map((q) => windingNormal(q));
    const a = normals[0];
    const b = normals[1];
    if (!a || !b) throw new Error("missing quads");
    expect(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).toBeLessThan(0);
  });

  it("a plant doesn't hide the top of the block it stands on", () => {
    const mesh = meshChunk(chunk, allAir);
    const covered = withFace(mesh, "top").some((quad) => {
      const xs = quad.map((v) => v.x);
      const zs = quad.map((v) => v.z);
      return (
        Math.min(...xs) <= 1 && Math.max(...xs) >= 2 && Math.min(...zs) <= 1 && Math.max(...zs) >= 2
      );
    });
    expect(covered).toBe(true);
  });
});

describe("meshChunk surface / cave split", () => {
  // Solid ground with a sealed cavity inside it.
  const chunk = new Chunk(0, 0);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      for (let y = 0; y <= 30; y++) chunk.setBlock(x, y, z, BlockId.STONE);
    }
  }
  for (let x = 5; x <= 9; x++) {
    for (let z = 5; z <= 9; z++) {
      for (let y = 10; y <= 13; y++) chunk.setBlock(x, y, z, BlockId.AIR);
    }
  }
  const mesh = meshChunk(chunk, allAir);
  const quads = quadsOf(mesh.opaque);

  it("orders sunlit quads first and sunless ones after caveStart", () => {
    expect(mesh.caveStart).toBeGreaterThan(0);
    expect(mesh.caveStart).toBeLessThan(quads.length);
    quads.forEach((quad, i) => {
      const sunless = quad.every((v) => v.sky === 0);
      expect(sunless).toBe(i >= mesh.caveStart);
    });
  });

  it("puts every face of the sealed cavity in the cave range", () => {
    const cave = quads.slice(mesh.caveStart);
    for (const quad of cave) {
      for (const v of quad) {
        expect(v.y).toBeGreaterThanOrEqual(10);
        expect(v.y).toBeLessThanOrEqual(14);
      }
    }
    // Pitch-dark walls drop their AO pattern and merge: 6 quads for the box.
    expect(cave).toHaveLength(6);
  });

  it("an open-air chunk has no cave range at all", () => {
    const open = meshChunk(slab(8, 20), allAir);
    expect(open.caveStart).toBe(quadCount(open.opaque));
  });
});

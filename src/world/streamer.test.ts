import { describe, expect, it } from "vitest";
import { BlockId } from "./blocks";
import { CHUNK_HEIGHT, CHUNK_SIZE, chunkKey } from "./coords";
import { EditStore, type KeyValueStorage } from "./edit-store";
import { type ChunkGenerator, ChunkStreamer, createSyncGenerator } from "./streamer";
import { World } from "./world";

const SEED = 2026;

function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

function makeStreamer(options: {
  radius?: number;
  editStore?: EditStore;
  onUnload?: (cx: number, cz: number) => void;
}): { world: World; streamer: ChunkStreamer } {
  const world = new World(SEED);
  const streamer = new ChunkStreamer(world, {
    radius: options.radius ?? 2,
    ...(options.editStore ? { editStore: options.editStore } : {}),
    ...(options.onUnload ? { onUnload: options.onUnload } : {}),
  });
  streamer.attachGenerator(
    createSyncGenerator(SEED, (cx, cz, buffer) => {
      streamer.receive(cx, cz, buffer);
    }),
  );
  return { world, streamer };
}

describe("warmUp", () => {
  it("synchronously loads the full spawn square", () => {
    const { world, streamer } = makeStreamer({});
    streamer.warmUp(8, 8, 1);
    expect(world.loadedChunkCount).toBe(9);
    expect(world.hasChunk(0, 0)).toBe(true);
    expect(world.hasChunk(-1, -1)).toBe(true);
    expect(world.hasChunk(1, 1)).toBe(true);
  });

  it("marks warmed chunks dirty for meshing", () => {
    const { streamer } = makeStreamer({});
    streamer.warmUp(8, 8, 1);
    expect(streamer.dirtyCount).toBeGreaterThanOrEqual(9);
  });
});

describe("update", () => {
  it("loads the player's own chunk synchronously even with no generator ticks", () => {
    const { world, streamer } = makeStreamer({});
    streamer.update(8, 8);
    expect(world.hasChunk(0, 0)).toBe(true);
  });

  it("eventually fills the whole radius through repeated updates", () => {
    const { world, streamer } = makeStreamer({ radius: 2 });
    for (let i = 0; i < 20; i++) streamer.update(8, 8);
    // radius 2 -> a 5x5 square
    expect(world.loadedChunkCount).toBe(25);
    expect(streamer.pendingCount).toBe(0);
  });

  it("unloads chunks left behind when the player moves far away", () => {
    const unloaded: string[] = [];
    const { world, streamer } = makeStreamer({
      radius: 2,
      onUnload: (cx, cz) => unloaded.push(chunkKey(cx, cz)),
    });
    for (let i = 0; i < 20; i++) streamer.update(8, 8);
    expect(world.hasChunk(-2, -2)).toBe(true);

    // Move 10 chunks away: everything around the origin is out of range.
    for (let i = 0; i < 20; i++) streamer.update(8 + 160, 8);
    expect(world.hasChunk(-2, -2)).toBe(false);
    expect(unloaded).toContain(chunkKey(-2, -2));
  });

  it("keeps the ring just outside the radius as hysteresis", () => {
    const { world, streamer } = makeStreamer({ radius: 2 });
    for (let i = 0; i < 20; i++) streamer.update(8, 8);
    // One chunk step to the east: the far-west column at cx=-2 is now at
    // distance 3 (radius+1) and must survive; distance radius+2 would not.
    for (let i = 0; i < 20; i++) streamer.update(8 + 16, 8);
    expect(world.hasChunk(-2, 0)).toBe(true);
  });
});

describe("receive", () => {
  it("applies the edit overlay to chunks arriving from the generator", () => {
    const store = new EditStore(memoryStorage(), SEED);
    store.record(20, 50, 8, BlockId.WOOD); // chunk (1, 0)
    const { world, streamer } = makeStreamer({ radius: 2, editStore: store });
    for (let i = 0; i < 20; i++) streamer.update(8, 8);
    expect(world.getBlock(20, 50, 8)).toBe(BlockId.WOOD);
  });

  it("re-applies edits when a chunk is unloaded and later streams back in", () => {
    const store = new EditStore(memoryStorage(), SEED);
    store.record(8, 50, 8, BlockId.STONE); // chunk (0, 0)
    const { world, streamer } = makeStreamer({ radius: 2, editStore: store });
    for (let i = 0; i < 20; i++) streamer.update(8, 8);
    expect(world.getBlock(8, 50, 8)).toBe(BlockId.STONE);

    for (let i = 0; i < 20; i++) streamer.update(8 + 300, 8); // far away: (0,0) unloads
    expect(world.hasChunk(0, 0)).toBe(false);

    for (let i = 0; i < 20; i++) streamer.update(8, 8); // come back
    expect(world.getBlock(8, 50, 8)).toBe(BlockId.STONE);
  });

  it("ignores a late worker result for a chunk already loaded synchronously", () => {
    const { world, streamer } = makeStreamer({});
    streamer.update(8, 8); // loads (0,0) synchronously
    const before = world.getChunk(0, 0);
    streamer.receive(0, 0, new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE)); // stale all-air result
    expect(world.getChunk(0, 0)).toBe(before);
  });
});

describe("drainDirty", () => {
  it("hands out each dirty chunk exactly once, respecting the budget", () => {
    const { streamer } = makeStreamer({});
    streamer.warmUp(8, 8, 1); // 9 dirty chunks
    const first = streamer.drainDirty(4);
    expect(first).toHaveLength(4);
    const rest = [...streamer.drainDirty(100)];
    expect(rest.length).toBeGreaterThanOrEqual(5);
    const seen = new Set([...first, ...rest].map((c) => chunkKey(c.cx, c.cz)));
    expect(seen.size).toBe(first.length + rest.length); // no duplicates
    expect(streamer.drainDirty(100)).toHaveLength(0);
  });

  it("a new chunk also dirties its already-loaded neighbors (border faces went stale)", () => {
    // No generator attached: update() only sync-loads the player's own
    // chunk, leaving (1,0) genuinely missing until receive() delivers it.
    const world = new World(SEED);
    const streamer = new ChunkStreamer(world, { radius: 2 });
    streamer.update(8, 8); // loads (0,0)
    streamer.drainDirty(100); // clear the queue
    streamer.receive(1, 0, new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE)); // neighbor arrives
    const dirty = streamer.drainDirty(100).map((c) => chunkKey(c.cx, c.cz));
    expect(dirty).toContain(chunkKey(1, 0));
    expect(dirty).toContain(chunkKey(0, 0));
  });

  it("skips chunks that were unloaded while sitting in the queue", () => {
    const { world, streamer } = makeStreamer({ radius: 1 });
    streamer.warmUp(8, 8, 1);
    world.removeChunk(1, 1);
    const drained = streamer.drainDirty(100);
    expect(drained.some((c) => c.cx === 1 && c.cz === 1)).toBe(false);
  });
});

describe("generator throttling", () => {
  it("issues at most a bounded number of requests per update", () => {
    const world = new World(SEED);
    const requests: string[] = [];
    const streamer = new ChunkStreamer(world, { radius: 5 });
    const generator: ChunkGenerator = {
      request: (cx, cz) => requests.push(chunkKey(cx, cz)),
      dispose: () => undefined,
    };
    streamer.attachGenerator(generator);
    streamer.update(8, 8);
    // A radius-5 square is 121 chunks; one update must not request them all.
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.length).toBeLessThanOrEqual(6);
  });

  it("requests nearest chunks first", () => {
    const world = new World(SEED);
    const requests: { cx: number; cz: number }[] = [];
    const streamer = new ChunkStreamer(world, { radius: 5 });
    streamer.attachGenerator({
      request: (cx, cz) => requests.push({ cx, cz }),
      dispose: () => undefined,
    });
    streamer.update(8, 8);
    const first = requests[0];
    expect(first).toBeDefined();
    if (first) {
      expect(Math.abs(first.cx) + Math.abs(first.cz)).toBeLessThanOrEqual(1);
    }
  });
});

describe("meshWhenSurrounded", () => {
  function surroundedStreamer(): { world: World; streamer: ChunkStreamer } {
    const world = new World(SEED);
    const streamer = new ChunkStreamer(world, { radius: 3, meshWhenSurrounded: true });
    return { world, streamer };
  }
  const blank = (): Uint8Array => new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);

  it("holds a chunk back until all eight neighbors are loaded", () => {
    const { streamer } = surroundedStreamer();
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) {
        if (cx === 1 && cz === 1) continue; // one corner still missing
        streamer.receive(cx, cz, blank());
      }
    }
    expect(streamer.isSurrounded(0, 0)).toBe(false);
    expect(streamer.drainDirty(100)).toHaveLength(0);

    streamer.receive(1, 1, blank());
    expect(streamer.isSurrounded(0, 0)).toBe(true);
    expect(streamer.drainDirty(100)).toEqual([{ cx: 0, cz: 0 }]);
  });

  it("queues each interior chunk exactly once as a block of chunks fills in", () => {
    const { streamer } = surroundedStreamer();
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) streamer.receive(cx, cz, blank());
    }
    const keys = streamer.drainDirty(100).map((c) => chunkKey(c.cx, c.cz));
    // The 3x3 interior of the 5x5 block is surrounded; the outer ring isn't.
    expect(keys).toHaveLength(9);
    expect(new Set(keys).size).toBe(9);
    expect(keys).not.toContain(chunkKey(2, 2));
  });
});

describe("disc-shaped loading", () => {
  it("loads fewer chunks than a square of the same radius, and nothing beyond it", () => {
    const world = new World(SEED);
    const streamer = new ChunkStreamer(world, { radius: 4, shape: "disc" });
    streamer.attachGenerator(
      createSyncGenerator(SEED, (cx, cz, buffer) => {
        streamer.receive(cx, cz, buffer);
      }),
    );
    for (let i = 0; i < 40; i++) streamer.update(8, 8);
    expect(world.loadedChunkCount).toBeLessThan(9 * 9);
    expect(world.loadedChunkCount).toBeGreaterThan(40);
    for (const { cx, cz } of world.loadedChunkCoords()) {
      expect(cx * cx + cz * cz).toBeLessThanOrEqual(4.5 * 4.5);
    }
    expect(world.hasChunk(4, 0)).toBe(true);
    expect(world.hasChunk(4, 4)).toBe(false);
  });

  it("setRadius shrinks the loaded set on the next update", () => {
    const world = new World(SEED);
    const streamer = new ChunkStreamer(world, { radius: 3 });
    streamer.attachGenerator(
      createSyncGenerator(SEED, (cx, cz, buffer) => {
        streamer.receive(cx, cz, buffer);
      }),
    );
    for (let i = 0; i < 20; i++) streamer.update(8, 8);
    expect(world.hasChunk(3, 3)).toBe(true);
    streamer.setRadius(1);
    streamer.update(8, 8);
    expect(world.hasChunk(3, 3)).toBe(false);
    expect(world.hasChunk(1, 1)).toBe(true);
  });
});

describe("settled world", () => {
  it("stops scanning once everything in range is loaded, and resumes when the player moves", () => {
    const world = new World(SEED);
    let requests = 0;
    const streamer = new ChunkStreamer(world, { radius: 2 });
    const sync = createSyncGenerator(SEED, (cx, cz, buffer) => {
      streamer.receive(cx, cz, buffer);
    });
    streamer.attachGenerator({
      request: (cx, cz) => {
        requests++;
        sync.request(cx, cz);
      },
      dispose: () => undefined,
    });
    for (let i = 0; i < 20; i++) streamer.update(8, 8);
    const settled = requests;
    expect(world.loadedChunkCount).toBe(25);

    // Standing still (or moving within the chunk) asks for nothing more...
    for (let i = 0; i < 50; i++) streamer.update(8 + (i % 7), 8);
    expect(requests).toBe(settled);

    // ...even if a chunk goes missing behind its back, until the player
    // crosses a chunk border and the set is re-examined.
    streamer.update(8 + 16, 8);
    for (let i = 0; i < 20; i++) streamer.update(8 + 16, 8);
    expect(requests).toBeGreaterThan(settled);
    expect(world.hasChunk(3, 0)).toBe(true);
  });
});

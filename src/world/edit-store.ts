import type { BlockId } from "./blocks";
import { Chunk } from "./chunk";
import { chunkKey, worldToChunk, worldToLocal } from "./coords";

/** The subset of Storage this store needs — injectable so tests run against
 * a plain in-memory stub instead of a browser's localStorage. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type SerializedEdits = Record<string, Record<string, number>>;

/** Player edits as a sparse overlay: chunk key -> (flat block index -> block
 * id). Chunks themselves are never persisted — they're always regenerated
 * from the seed and the overlay is re-applied on top, so a whole explored
 * world costs only as much storage as the blocks the player actually
 * changed. Keyed by seed: two worlds never see each other's edits. */
export class EditStore {
  private readonly storage: KeyValueStorage;
  private readonly key: string;
  private readonly edits = new Map<string, Map<number, BlockId>>();

  constructor(storage: KeyValueStorage, seed: number) {
    this.storage = storage;
    this.key = EditStore.storageKey(seed);
    this.load();
  }

  static storageKey(seed: number): string {
    return `minecraft-clone:edits:${seed.toString()}`;
  }

  record(worldX: number, worldY: number, worldZ: number, id: BlockId): void {
    const key = chunkKey(worldToChunk(worldX), worldToChunk(worldZ));
    let chunkEdits = this.edits.get(key);
    if (!chunkEdits) {
      chunkEdits = new Map();
      this.edits.set(key, chunkEdits);
    }
    chunkEdits.set(Chunk.index(worldToLocal(worldX), worldY, worldToLocal(worldZ)), id);
    this.save();
  }

  /** Re-applies recorded edits onto a freshly generated chunk. */
  applyTo(chunk: Chunk): void {
    const chunkEdits = this.edits.get(chunkKey(chunk.cx, chunk.cz));
    if (!chunkEdits) return;
    for (const [index, id] of chunkEdits) {
      chunk.buffer[index] = id;
    }
  }

  get editedChunkCount(): number {
    return this.edits.size;
  }

  get totalEdits(): number {
    let total = 0;
    for (const chunkEdits of this.edits.values()) total += chunkEdits.size;
    return total;
  }

  private load(): void {
    const raw = this.storage.getItem(this.key);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as SerializedEdits;
      for (const [key, cells] of Object.entries(parsed)) {
        const chunkEdits = new Map<number, BlockId>();
        for (const [index, id] of Object.entries(cells)) {
          chunkEdits.set(Number(index), id as BlockId);
        }
        this.edits.set(key, chunkEdits);
      }
    } catch {
      // A corrupt payload silently resets the overlay — losing edits beats
      // wedging the game on startup forever.
    }
  }

  private save(): void {
    const out: SerializedEdits = {};
    for (const [key, chunkEdits] of this.edits) {
      const cells: Record<string, number> = {};
      for (const [index, id] of chunkEdits) {
        cells[index.toString()] = id;
      }
      out[key] = cells;
    }
    this.storage.setItem(this.key, JSON.stringify(out));
  }
}

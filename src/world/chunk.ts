import { BlockId } from "./blocks";
import { CHUNK_HEIGHT, CHUNK_SIZE } from "./coords";

/** One 16x96x16 vertical column of the world, block ids stored one byte each. */
export class Chunk {
  readonly cx: number;
  readonly cz: number;
  private readonly blocks: Uint8Array;

  constructor(cx: number, cz: number, blocks?: Uint8Array) {
    this.cx = cx;
    this.cz = cz;
    const size = CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE;
    if (blocks) {
      if (blocks.length !== size) {
        throw new Error(
          `chunk buffer must have length ${size.toString()}, got ${blocks.length.toString()}`,
        );
      }
      this.blocks = blocks;
    } else {
      this.blocks = new Uint8Array(size);
    }
  }

  get worldOriginX(): number {
    return this.cx * CHUNK_SIZE;
  }

  get worldOriginZ(): number {
    return this.cz * CHUNK_SIZE;
  }

  /** Flat array index for a position local to this chunk (0..CHUNK_SIZE-1 / 0..CHUNK_HEIGHT-1). */
  static index(lx: number, ly: number, lz: number): number {
    return (ly * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
  }

  static inBounds(lx: number, ly: number, lz: number): boolean {
    return lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE && ly >= 0 && ly < CHUNK_HEIGHT;
  }

  /** Block at local coordinates. Out-of-bounds Y reads as air; out-of-bounds X/Z throws
   * (that's a cross-chunk lookup, which is World's job, not Chunk's). */
  getBlock(lx: number, ly: number, lz: number): BlockId {
    if (ly < 0 || ly >= CHUNK_HEIGHT) return BlockId.AIR;
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) {
      throw new RangeError(`(${lx.toString()}, ${lz.toString()}) is outside this chunk`);
    }
    return this.blocks[Chunk.index(lx, ly, lz)] as BlockId;
  }

  setBlock(lx: number, ly: number, lz: number, id: BlockId): void {
    if (!Chunk.inBounds(lx, ly, lz)) {
      throw new RangeError(
        `(${lx.toString()}, ${ly.toString()}, ${lz.toString()}) is outside this chunk`,
      );
    }
    this.blocks[Chunk.index(lx, ly, lz)] = id;
  }

  /** The raw backing buffer, for transferring to/from a Web Worker or persistence. */
  get buffer(): Uint8Array {
    return this.blocks;
  }

  isEmpty(): boolean {
    return this.blocks.every((b) => b === 0);
  }
}

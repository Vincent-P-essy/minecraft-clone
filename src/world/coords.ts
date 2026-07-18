export const CHUNK_SIZE = 16;
export const CHUNK_HEIGHT = 96;

/** Which chunk a world coordinate falls in. Floor division, correct for negative inputs. */
export function worldToChunk(worldCoord: number): number {
  return Math.floor(worldCoord / CHUNK_SIZE);
}

/** Position within a chunk (0..CHUNK_SIZE-1), correct for negative world coordinates. */
export function worldToLocal(worldCoord: number): number {
  return ((worldCoord % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}

export interface ChunkCoord {
  readonly cx: number;
  readonly cz: number;
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx.toString()},${cz.toString()}`;
}

export function worldToChunkCoord(worldX: number, worldZ: number): ChunkCoord {
  return { cx: worldToChunk(worldX), cz: worldToChunk(worldZ) };
}

/** Squared distance in chunk-grid units — cheap and enough for radius comparisons. */
export function chunkDistanceSquared(a: ChunkCoord, b: ChunkCoord): number {
  const dx = a.cx - b.cx;
  const dz = a.cz - b.cz;
  return dx * dx + dz * dz;
}

/** Every chunk whose mesh could change from an edit at this world position —
 * always the chunk itself, plus any neighbor sharing the edge the edit sits
 * on, since face culling reads across chunk borders. */
export function affectedChunkCoords(worldX: number, worldZ: number): ChunkCoord[] {
  const cx = worldToChunk(worldX);
  const cz = worldToChunk(worldZ);
  const lx = worldToLocal(worldX);
  const lz = worldToLocal(worldZ);

  const coords: ChunkCoord[] = [{ cx, cz }];
  if (lx === 0) coords.push({ cx: cx - 1, cz });
  if (lx === CHUNK_SIZE - 1) coords.push({ cx: cx + 1, cz });
  if (lz === 0) coords.push({ cx, cz: cz - 1 });
  if (lz === CHUNK_SIZE - 1) coords.push({ cx, cz: cz + 1 });
  return coords;
}

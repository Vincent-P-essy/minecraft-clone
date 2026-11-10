import { BlockId } from "../world/blocks";
import { Chunk } from "../world/chunk";
import { CHUNK_HEIGHT, CHUNK_SIZE, chunkKey } from "../world/coords";
import { meshChunk, type NeighborLookup } from "./mesher";

/** Meshes chunks off the main thread. It keeps a resident cache of block
 * buffers (mirroring the loaded world) so it can read across chunk borders
 * for face culling, ambient occlusion and light without the main thread
 * shipping neighbor data on every request. The expensive part — solving
 * light over a 3x3 chunk neighborhood, then greedy meshing — runs here;
 * only the finished packed geometry (transferred, not copied) crosses
 * back. Several of these run side by side as a pool. */

export interface SetMessage {
  type: "set";
  cx: number;
  cz: number;
  buffer: Uint8Array;
}
export interface EditMessage {
  type: "edit";
  cx: number;
  cz: number;
  index: number;
  id: number;
}
export interface RemoveMessage {
  type: "remove";
  cx: number;
  cz: number;
}
export interface MeshMessage {
  type: "mesh";
  cx: number;
  cz: number;
  id: number;
}
export type MeshWorkerRequest = SetMessage | EditMessage | RemoveMessage | MeshMessage;

export interface MeshWorkerResult {
  type: "mesh";
  cx: number;
  cz: number;
  id: number;
  empty: boolean;
  opaque: Uint32Array;
  caveStart: number;
  water: Uint32Array;
  minY: number;
  maxY: number;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<MeshWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const buffers = new Map<string, Uint8Array>();

const neighbors: NeighborLookup = {
  getBlock(worldX, worldY, worldZ) {
    if (worldY < 0 || worldY >= CHUNK_HEIGHT) return BlockId.AIR;
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    const buf = buffers.get(chunkKey(cx, cz));
    if (!buf) return BlockId.AIR;
    const lx = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    return (buf[(worldY * CHUNK_SIZE + lz) * CHUNK_SIZE + lx] ?? BlockId.AIR) as BlockId;
  },
  getChunkBuffer(cx, cz) {
    return buffers.get(chunkKey(cx, cz));
  },
};

scope.onmessage = (event) => {
  const m = event.data;
  if (m.type === "set") {
    buffers.set(chunkKey(m.cx, m.cz), m.buffer);
    return;
  }
  if (m.type === "edit") {
    const buffer = buffers.get(chunkKey(m.cx, m.cz));
    if (buffer) buffer[m.index] = m.id;
    return;
  }
  if (m.type === "remove") {
    buffers.delete(chunkKey(m.cx, m.cz));
    return;
  }
  const buffer = buffers.get(chunkKey(m.cx, m.cz));
  if (!buffer) {
    const none: MeshWorkerResult = {
      type: "mesh",
      cx: m.cx,
      cz: m.cz,
      id: m.id,
      empty: true,
      opaque: new Uint32Array(0),
      caveStart: 0,
      water: new Uint32Array(0),
      minY: 0,
      maxY: 0,
    };
    scope.postMessage(none);
    return;
  }
  const data = meshChunk(new Chunk(m.cx, m.cz, buffer), neighbors);
  const result: MeshWorkerResult = {
    type: "mesh",
    cx: m.cx,
    cz: m.cz,
    id: m.id,
    empty: data.opaque.length === 0 && data.water.length === 0,
    opaque: data.opaque,
    caveStart: data.caveStart,
    water: data.water,
    minY: data.minY,
    maxY: data.maxY,
  };
  scope.postMessage(result, [data.opaque.buffer, data.water.buffer]);
};

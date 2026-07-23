import { BlockId } from "../world/blocks";
import { Chunk } from "../world/chunk";
import { CHUNK_HEIGHT, CHUNK_SIZE, chunkKey } from "../world/coords";
import { meshChunk, type NeighborLookup } from "./mesher";

/** Meshes chunks off the main thread. It keeps a resident cache of block
 * buffers (mirroring the loaded world) so it can read across chunk borders
 * for face culling and ambient occlusion without the main thread shipping
 * neighbor data on every request. The expensive greedy meshing runs here;
 * only the finished geometry (typed arrays, transferred) crosses back. */

interface SetMessage {
  type: "set";
  cx: number;
  cz: number;
  buffer: Uint8Array;
}
interface RemoveMessage {
  type: "remove";
  cx: number;
  cz: number;
}
interface MeshMessage {
  type: "mesh";
  cx: number;
  cz: number;
  id: number;
}
type InMessage = SetMessage | RemoveMessage | MeshMessage;

interface WorkerScope {
  onmessage: ((event: MessageEvent<InMessage>) => void) | null;
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
    return (buf[((worldY << 4) | lz) * CHUNK_SIZE + lx] ?? BlockId.AIR) as BlockId;
  },
};

scope.onmessage = (event) => {
  const m = event.data;
  if (m.type === "set") {
    buffers.set(chunkKey(m.cx, m.cz), m.buffer);
    return;
  }
  if (m.type === "remove") {
    buffers.delete(chunkKey(m.cx, m.cz));
    return;
  }
  const buffer = buffers.get(chunkKey(m.cx, m.cz));
  if (!buffer) {
    scope.postMessage({ type: "mesh", cx: m.cx, cz: m.cz, id: m.id, empty: true });
    return;
  }
  const data = meshChunk(new Chunk(m.cx, m.cz, buffer), neighbors);
  scope.postMessage(
    {
      type: "mesh",
      cx: m.cx,
      cz: m.cz,
      id: m.id,
      positions: data.positions,
      normals: data.normals,
      uvs: data.uvs,
      colors: data.colors,
      layers: data.layers,
      indices: data.indices,
    },
    [
      data.positions.buffer,
      data.normals.buffer,
      data.uvs.buffer,
      data.colors.buffer,
      data.layers.buffer,
      data.indices.buffer,
    ],
  );
};

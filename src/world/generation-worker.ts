import { generateChunk } from "./terrain";

/** Web Worker entry point: terrain generation off the main thread. One
 * message in ({cx, cz, seed}), one chunk buffer out, transferred (not
 * copied) back to the main thread. */

interface GenerateRequest {
  cx: number;
  cz: number;
  seed: number;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<GenerateRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { cx, cz, seed } = event.data;
  const chunk = generateChunk(cx, cz, seed);
  const buffer = chunk.buffer;
  scope.postMessage({ cx, cz, buffer }, [buffer.buffer]);
};

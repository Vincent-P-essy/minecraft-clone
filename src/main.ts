import "./style.css";
import * as THREE from "three";
import { ChunkMeshManager, createChunkMaterial } from "./render/chunk-mesh-manager";
import { Clouds } from "./render/clouds";
import { createGameScene } from "./render/scene";
import { DAY_LENGTH_SECONDS, STARTUP_PHASE, skyStateAt } from "./render/sky";
import { createTextureAtlas } from "./render/texture-atlas";
import { PlayerController } from "./player/controller";
import { BlockInteraction } from "./player/interaction";
import { Hotbar } from "./ui/hotbar";
import { Hud } from "./ui/hud";
import { EditStore } from "./world/edit-store";
import { findPleasantSpawn } from "./world/spawn";
import {
  type ChunkGenerator,
  ChunkStreamer,
  createSyncGenerator,
  createWorkerGenerator,
} from "./world/streamer";
import { World } from "./world/world";

const DEFAULT_SEED = 2026;
const STREAM_RADIUS_CHUNKS = 7;
const WARMUP_RADIUS_CHUNKS = 2;
const MESH_BUDGET_PER_FRAME = 3;

// Read-only debug handle for the visual-check harness (scripts/visual-check.mjs):
// lets an automated browser assert on game state instead of guessing from pixels.
declare global {
  interface Window {
    __mc?: {
      position: () => { x: number; y: number; z: number };
      blockAt: (x: number, y: number, z: number) => number;
      target: () => { x: number; y: number; z: number } | null;
      pitch: () => number;
      mode: () => string;
      loadedChunks: () => number;
      meshedChunks: () => number;
      pendingChunks: () => number;
      seed: number;
    };
  }
}

/** A dead "Click to play" button is the worst failure mode a browser game
 * can have. If anything at all goes wrong during boot — WebGL unavailable,
 * a worker that won't start, storage blocked — say so, visibly, in the
 * overlay the player is already looking at. */
function showFatalError(error: unknown): void {
  const content = document.querySelector("#overlay-content");
  if (!content) return;
  const message = error instanceof Error ? error.message : String(error);
  content.innerHTML = "";
  const title = document.createElement("h1");
  title.textContent = "the game couldn't start";
  const detail = document.createElement("p");
  detail.textContent = message;
  const hint = document.createElement("p");
  hint.textContent =
    "Usually this means WebGL is unavailable. Try a hard refresh (Ctrl+Shift+R), " +
    "another browser (Chrome/Firefox), or enabling hardware acceleration in your " +
    "browser's settings.";
  content.append(title, detail, hint);
}

function boot(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("#app not found");
  const hotbarContainer = document.querySelector<HTMLDivElement>("#hotbar");
  if (!hotbarContainer) throw new Error("#hotbar not found");

  // A shareable world: ?seed=1234 loads the same terrain for everyone.
  const seedParam = new URLSearchParams(window.location.search).get("seed");
  const parsedSeed = seedParam === null ? NaN : Number.parseInt(seedParam, 10);
  const SEED = Number.isFinite(parsedSeed) ? parsedSeed : DEFAULT_SEED;

  const world = new World(SEED);
  const { scene, camera, renderer, render, resize, applySky } = createGameScene(app);
  const atlas = createTextureAtlas(SEED);
  const material = createChunkMaterial(atlas.texture);
  const chunkMeshes = new ChunkMeshManager(scene, world, material);
  const editStore = new EditStore(window.localStorage, SEED);

  const streamer = new ChunkStreamer(world, {
    radius: STREAM_RADIUS_CHUNKS,
    editStore,
    onUnload: (cx, cz) => {
      chunkMeshes.removeChunkMesh(cx, cz);
    },
  });
  const receive = (cx: number, cz: number, buffer: Uint8Array): void => {
    streamer.receive(cx, cz, buffer);
  };
  let generator: ChunkGenerator;
  try {
    if (typeof Worker === "undefined") throw new Error("workers unavailable");
    generator = createWorkerGenerator(SEED, receive);
  } catch {
    // No module workers? Generate on the main thread — slower on chunk
    // arrival, but the game works everywhere.
    generator = createSyncGenerator(SEED, receive);
  }
  streamer.attachGenerator(generator);

  const spawn = findPleasantSpawn(SEED);
  // Ground under the player's feet before the first frame; the rest streams in.
  streamer.warmUp(spawn.x, spawn.z, WARMUP_RADIUS_CHUNKS);

  const player = new PlayerController(camera, renderer.domElement, world, spawn.x, spawn.z);
  const hotbar = new Hotbar(hotbarContainer, atlas.canvas);
  const interaction = new BlockInteraction(
    camera,
    renderer.domElement,
    world,
    chunkMeshes,
    hotbar,
    player,
  );
  interaction.onEdit = (x, y, z, id) => {
    editStore.record(x, y, z, id);
  };

  const clouds = new Clouds(scene, SEED);
  const hud = new Hud(app);

  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
    new THREE.LineBasicMaterial({ color: 0x000000 }),
  );
  highlight.visible = false;
  scene.add(highlight);

  window.addEventListener("resize", () => {
    resize(window.innerWidth, window.innerHeight);
  });

  window.__mc = {
    position: () => ({ ...player.position }),
    blockAt: (x, y, z) => world.getBlock(x, y, z),
    target: () => {
      const hit = interaction.raycastFromCamera();
      return hit ? { x: hit.blockX, y: hit.blockY, z: hit.blockZ } : null;
    },
    pitch: () => player.eyePitch,
    mode: () => player.mode,
    loadedChunks: () => world.loadedChunkCount,
    meshedChunks: () => chunkMeshes.meshedChunkCount,
    pendingChunks: () => streamer.pendingCount,
    seed: SEED,
  };

  const startedAt = performance.now();
  let lastTime = startedAt;
  renderer.setAnimationLoop((time: number) => {
    const dt = Math.min((time - lastTime) / 1000, 0.1); // clamp to avoid a huge step after a tab switch
    lastTime = time;
    const elapsed = (time - startedAt) / 1000 + STARTUP_PHASE * DAY_LENGTH_SECONDS;

    streamer.update(player.position.x, player.position.z);
    player.update(dt);

    for (const { cx, cz } of streamer.drainDirty(MESH_BUDGET_PER_FRAME)) {
      chunkMeshes.updateChunk(cx, cz);
    }

    applySky(skyStateAt(elapsed));
    clouds.update(player.position.x, player.position.z, elapsed);

    const hit = interaction.raycastFromCamera();
    highlight.visible = hit !== null;
    if (hit) {
      highlight.position.set(hit.blockX + 0.5, hit.blockY + 0.5, hit.blockZ + 0.5);
    }

    hud.frame(time, {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      chunks: world.loadedChunkCount,
      seed: SEED,
    });

    render();
  });
}

try {
  boot();
} catch (error) {
  console.error(error);
  showFatalError(error);
}

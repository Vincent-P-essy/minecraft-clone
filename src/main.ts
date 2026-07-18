import "./style.css";
import * as THREE from "three";
import { ChunkMeshManager, createChunkMaterial } from "./render/chunk-mesh-manager";
import { Clouds } from "./render/clouds";
import { CpuRenderer } from "./render/cpu-renderer";
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
const STREAM_RADIUS_WEBGL = 7;
const STREAM_RADIUS_CPU = 4; // rays reach ~52 blocks; a tighter ring is plenty
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
      renderer: () => "webgl" | "cpu";
      loadedChunks: () => number;
      meshedChunks: () => number;
      pendingChunks: () => number;
      seed: number;
    };
  }
}

/** A dead "Click to play" button is the worst failure mode a browser game
 * can have. If anything at all goes wrong during boot — and the WebGL and
 * worker paths already have their own fallbacks — say so, visibly, in the
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
    "Try a hard refresh (Ctrl+Shift+R) or another browser (Chrome/Firefox). " +
    "If it keeps happening, please open an issue with this exact message.";
  content.append(title, detail, hint);
}

/** What the game loop needs from a renderer — satisfied by the Three.js
 * scene when WebGL exists, and by the CPU raycaster when it doesn't. */
interface GameView {
  readonly kind: "webgl" | "cpu";
  readonly camera: THREE.PerspectiveCamera;
  readonly domElement: HTMLElement;
  render(elapsedSeconds: number): void;
  resize(width: number, height: number): void;
  applySky(state: ReturnType<typeof skyStateAt>): void;
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
  const atlas = createTextureAtlas(SEED);

  // The renderer: WebGL when the browser can, an in-house CPU raycaster
  // when it can't. Same world, same physics, same controls either way.
  let view: GameView;
  let chunkMeshes: ChunkMeshManager | null = null;
  let clouds: Clouds | null = null;
  let highlight: THREE.LineSegments | null = null;
  try {
    const gameScene = createGameScene(app);
    view = {
      kind: "webgl",
      camera: gameScene.camera,
      domElement: gameScene.renderer.domElement,
      render: () => {
        gameScene.render();
      },
      resize: gameScene.resize,
      applySky: gameScene.applySky,
    };
    chunkMeshes = new ChunkMeshManager(gameScene.scene, world, createChunkMaterial(atlas.texture));
    clouds = new Clouds(gameScene.scene, SEED);
    highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
      new THREE.LineBasicMaterial({ color: 0x000000 }),
    );
    highlight.visible = false;
    gameScene.scene.add(highlight);
  } catch (webglError) {
    console.warn("WebGL unavailable, switching to the CPU raycaster:", webglError);
    const cpu = new CpuRenderer(app, world, SEED);
    view = {
      kind: "cpu",
      camera: cpu.camera,
      domElement: cpu.domElement,
      render: (elapsed) => {
        cpu.render(elapsed);
      },
      resize: (w, h) => {
        cpu.resize(w, h);
      },
      applySky: (state) => {
        cpu.applySky(state);
      },
    };
  }

  const editStore = new EditStore(window.localStorage, SEED);
  const streamer = new ChunkStreamer(world, {
    radius: view.kind === "webgl" ? STREAM_RADIUS_WEBGL : STREAM_RADIUS_CPU,
    editStore,
    onUnload: (cx, cz) => {
      chunkMeshes?.removeChunkMesh(cx, cz);
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

  const player = new PlayerController(view.camera, view.domElement, world, spawn.x, spawn.z);
  const hotbar = new Hotbar(hotbarContainer, atlas.canvas);
  const interaction = new BlockInteraction(
    view.camera,
    view.domElement,
    world,
    chunkMeshes ?? { updateChunk: () => undefined },
    hotbar,
    player,
  );
  interaction.onEdit = (x, y, z, id) => {
    editStore.record(x, y, z, id);
  };

  const hud = new Hud(app);

  window.addEventListener("resize", () => {
    view.resize(window.innerWidth, window.innerHeight);
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
    renderer: () => view.kind,
    loadedChunks: () => world.loadedChunkCount,
    meshedChunks: () => chunkMeshes?.meshedChunkCount ?? world.loadedChunkCount,
    pendingChunks: () => streamer.pendingCount,
    seed: SEED,
  };

  const startedAt = performance.now();
  let lastTime = startedAt;
  const frame = (time: number): void => {
    const dt = Math.min((time - lastTime) / 1000, 0.1); // clamp to avoid a huge step after a tab switch
    lastTime = time;
    const elapsed = (time - startedAt) / 1000 + STARTUP_PHASE * DAY_LENGTH_SECONDS;

    streamer.update(player.position.x, player.position.z);
    player.update(dt);

    for (const { cx, cz } of streamer.drainDirty(MESH_BUDGET_PER_FRAME)) {
      chunkMeshes?.updateChunk(cx, cz);
    }

    view.applySky(skyStateAt(elapsed));
    clouds?.update(player.position.x, player.position.z, elapsed);

    if (highlight) {
      const hit = interaction.raycastFromCamera();
      highlight.visible = hit !== null;
      if (hit) {
        highlight.position.set(hit.blockX + 0.5, hit.blockY + 0.5, hit.blockZ + 0.5);
      }
    }

    hud.frame(time, {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      chunks: world.loadedChunkCount,
      seed: SEED,
      ...(view.kind === "cpu" ? { note: "cpu renderer" } : {}),
    });

    view.render(elapsed);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

try {
  boot();
} catch (error) {
  console.error(error);
  showFatalError(error);
}

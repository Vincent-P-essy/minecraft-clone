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
import { ChunkStreamer, createSyncGenerator, createWorkerGenerator } from "./world/streamer";
import { World } from "./world/world";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app not found");
const hotbarContainer = document.querySelector<HTMLDivElement>("#hotbar");
if (!hotbarContainer) throw new Error("#hotbar not found");

const DEFAULT_SEED = 2026;
const STREAM_RADIUS_CHUNKS = 7;
const WARMUP_RADIUS_CHUNKS = 2;
const MESH_BUDGET_PER_FRAME = 3;
const SPAWN_X = 8;
const SPAWN_Z = 8;

// A shareable world: ?seed=1234 loads the same terrain for everyone.
const seedParam = new URLSearchParams(window.location.search).get("seed");
const parsedSeed = seedParam === null ? NaN : Number.parseInt(seedParam, 10);
const SEED = Number.isFinite(parsedSeed) ? parsedSeed : DEFAULT_SEED;

const world = new World(SEED);
const gameScene = createGameScene(app);
const { scene, camera, renderer, render, resize, applySky } = gameScene;
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
const generator =
  typeof Worker === "undefined"
    ? createSyncGenerator(SEED, (cx, cz, buffer) => {
        streamer.receive(cx, cz, buffer);
      })
    : createWorkerGenerator(SEED, (cx, cz, buffer) => {
        streamer.receive(cx, cz, buffer);
      });
streamer.attachGenerator(generator);

// Ground under the player's feet before the first frame; the rest streams in.
streamer.warmUp(SPAWN_X, SPAWN_Z, WARMUP_RADIUS_CHUNKS);

const player = new PlayerController(camera, renderer.domElement, world, SPAWN_X, SPAWN_Z);
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

import "./style.css";
import * as THREE from "three";
import { ChunkMeshManager } from "./render/chunk-mesh-manager";
import { CpuRenderer } from "./render/cpu-renderer";
import { environmentAt } from "./render/environment";
import { WorldRenderer } from "./render/renderer";
import { DAY_LENGTH_SECONDS, STARTUP_PHASE, skyStateAt } from "./render/sky";
import { createTextureAtlas } from "./render/texture-atlas";
import { PlayerController } from "./player/controller";
import { BlockInteraction } from "./player/interaction";
import { defaultSettings, SettingsStore } from "./settings";
import { Hotbar } from "./ui/hotbar";
import { Hud } from "./ui/hud";
import { isTouchDevice, TouchControls } from "./ui/touch-controls";
import { EditStore } from "./world/edit-store";
import { findPleasantSpawn } from "./world/spawn";
import { createColumnSampler } from "./world/terrain";
import {
  type ChunkGenerator,
  ChunkStreamer,
  createSyncGenerator,
  createWorkerGenerator,
} from "./world/streamer";
import { World } from "./world/world";

const DEFAULT_SEED = 2026;
const STREAM_RADIUS_CPU = 4;
const WARMUP_RADIUS_CHUNKS = 2;

declare global {
  interface Window {
    __mc?: {
      position: () => { x: number; y: number; z: number };
      blockAt: (x: number, y: number, z: number) => number;
      target: () => { x: number; y: number; z: number } | null;
      pitch: () => number;
      mode: () => string;
      renderer: () => "webgl" | "cpu";
      touch: () => boolean;
      loadedChunks: () => number;
      meshedChunks: () => number;
      pendingChunks: () => number;
      seed: number;
      setTime?: (phase: number) => void;
      setQuality?: (q: string) => void;
      teleport?: (x: number, y: number, z: number, yaw: number, pitch: number) => void;
      stats?: () => unknown;
      groundAt?: (x: number, z: number) => number;
      locate?: (biome: number, skip?: number) => { x: number; z: number; h: number } | null;
    };
  }
}

function showFatalError(error: unknown): void {
  const content = document.querySelector("#overlay-content");
  if (!content) return;
  const message = error instanceof Error ? error.message : String(error);
  content.innerHTML = "";
  const title = document.createElement("h1");
  title.textContent = "the game couldn't start";
  const detail = document.createElement("p");
  detail.textContent = message;
  content.append(title, detail);
}

function boot(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("#app not found");
  const hotbarContainer = document.querySelector<HTMLDivElement>("#hotbar");
  if (!hotbarContainer) throw new Error("#hotbar not found");

  const params = new URLSearchParams(window.location.search);
  const seedParam = params.get("seed");
  const parsedSeed = seedParam === null ? NaN : Number.parseInt(seedParam, 10);
  const SEED = Number.isFinite(parsedSeed) ? parsedSeed : DEFAULT_SEED;

  const touch = isTouchDevice();
  const settings = new SettingsStore(
    window.localStorage,
    defaultSettings({ touch, cores: navigator.hardwareConcurrency || 4 }),
  );
  const q = params.get("quality");
  if (q === "low" || q === "medium" || q === "high" || q === "ultra") settings.values.quality = q;
  const viewParam = Number.parseInt(params.get("view") ?? "", 10);
  if (Number.isFinite(viewParam))
    settings.values.viewDistance = Math.max(2, Math.min(16, viewParam));

  const world = new World(SEED);
  const atlas = createTextureAtlas(SEED);

  let webgl: WorldRenderer | null = null;
  let cpu: CpuRenderer | null = null;
  let chunkMeshes: ChunkMeshManager | null = null;
  let highlight: THREE.LineSegments | null = null;
  try {
    webgl = new WorldRenderer(app, SEED, settings.values.quality, settings.values.viewDistance);
    const cores = navigator.hardwareConcurrency || 4;
    chunkMeshes = new ChunkMeshManager(
      webgl.scene,
      world,
      { terrain: webgl.terrainMaterial, water: webgl.waterMaterial },
      Math.max(1, Math.min(3, cores - 2)),
    );
    const r = webgl;
    const m = chunkMeshes;
    webgl.onMaterialsChanged = () => {
      m.setMaterials({ terrain: r.terrainMaterial, water: r.waterMaterial });
    };
    highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.7 }),
    );
    highlight.visible = false;
    webgl.scene.add(highlight);
  } catch (webglError) {
    console.warn("WebGL2 unavailable, switching to the CPU raycaster:", webglError);
    cpu = new CpuRenderer(app, world, SEED);
  }
  const view = webgl ?? cpu;
  if (!view) throw new Error("no renderer could be created");
  const { camera, domElement } = view;

  const editStore = new EditStore(window.localStorage, SEED);
  const streamer = new ChunkStreamer(world, {
    radius: webgl ? settings.values.viewDistance + 1 : STREAM_RADIUS_CPU,
    editStore,
    shape: webgl ? "disc" : "square",
    meshWhenSurrounded: webgl !== null,
    onLoad: (cx, cz) => {
      chunkMeshes?.chunkLoaded(cx, cz);
    },
    onUnload: (cx, cz) => {
      chunkMeshes?.chunkUnloaded(cx, cz);
    },
  });
  const receive = (cx: number, cz: number, buffer: Uint8Array): void => {
    streamer.receive(cx, cz, buffer);
  };
  let generator: ChunkGenerator;
  try {
    if (typeof Worker === "undefined") throw new Error("workers unavailable");
    generator = createWorkerGenerator(SEED, receive, 2);
  } catch {
    generator = createSyncGenerator(SEED, receive);
  }
  streamer.attachGenerator(generator);

  const spawn = findPleasantSpawn(SEED);
  streamer.warmUp(spawn.x, spawn.z, WARMUP_RADIUS_CHUNKS);

  const player = new PlayerController(camera, domElement, world, spawn.x, spawn.z, {
    sensitivity: settings.values.sensitivity,
    invertY: settings.values.invertY,
    autoJump: settings.values.autoJump,
    viewBob: settings.values.viewBob,
    fov: settings.values.fov,
  });
  const hotbar = new Hotbar(hotbarContainer, atlas.canvas);
  const interaction = new BlockInteraction(
    camera,
    domElement,
    world,
    chunkMeshes ?? { blockChanged: () => undefined },
    hotbar,
    player,
  );
  interaction.onEdit = (edit) => {
    editStore.record(edit.x, edit.y, edit.z, edit.id);
  };

  const touchControls = touch
    ? new TouchControls(app, {
        isActive: () => player.isActive,
        onInput: (input) => {
          player.setExternalInput(input);
        },
        onLook: (dx, dy) => {
          player.lookBy(dx, dy);
        },
        onBreak: () => {
          interaction.breakTargetedBlock();
        },
        onPlace: () => {
          interaction.placeTargetedBlock();
        },
      })
    : null;
  let touchVisible = false;

  const hud = new Hud(app);

  window.addEventListener("resize", () => {
    webgl?.resize(window.innerWidth, window.innerHeight);
    cpu?.resize(window.innerWidth, window.innerHeight);
  });

  let timeOffset = STARTUP_PHASE * DAY_LENGTH_SECONDS;
  let frozenTime: number | null = null;

  window.__mc = {
    position: () => ({ ...player.position }),
    blockAt: (x, y, z) => world.getBlock(x, y, z),
    target: () => {
      const hit = interaction.raycastFromCamera();
      return hit ? { x: hit.blockX, y: hit.blockY, z: hit.blockZ } : null;
    },
    pitch: () => player.eyePitch,
    mode: () => player.mode,
    renderer: () => (webgl ? "webgl" : "cpu"),
    touch: () => touchControls !== null,
    loadedChunks: () => world.loadedChunkCount,
    meshedChunks: () => chunkMeshes?.meshedChunkCount ?? world.loadedChunkCount,
    pendingChunks: () => streamer.pendingCount,
    seed: SEED,
    setTime: (phase) => {
      frozenTime = phase * DAY_LENGTH_SECONDS;
    },
    setQuality: (level) => {
      if (level === "low" || level === "medium" || level === "high" || level === "ultra") {
        webgl?.setQuality(level);
      }
    },
    teleport: (x, y, z, yaw, pitch) => {
      player.restore({ x, y, z, yaw, pitch, flying: true });
    },
    groundAt: (x, z) => createColumnSampler(SEED)(x, z).terrainHeight,
    locate: (biome, skip = 0) => {
      const sample = createColumnSampler(SEED);
      let found = 0;
      for (let radius = 0; radius < 4000; radius += 24) {
        for (let i = -radius; i <= radius; i += 24) {
          for (const [x, z] of [
            [i, -radius],
            [i, radius],
            [-radius, i],
            [radius, i],
          ] as const) {
            const p = sample(x, z);
            if (p.biome === biome && found++ >= skip) return { x, z, h: p.terrainHeight };
          }
        }
      }
      return null;
    },
    stats: () => ({
      ...webgl?.stats(),
      quads: chunkMeshes?.quadTotal,
      queued: chunkMeshes?.queuedCount,
      scale: webgl?.renderScale,
    }),
  };
  if (params.has("fullres")) webgl?.lockFullResolution();

  const startedAt = performance.now();
  let lastTime = startedAt;
  const frame = (time: number): void => {
    const frameDelta = time - lastTime;
    const dt = Math.min(frameDelta / 1000, 0.1);
    lastTime = time;
    const elapsed = frozenTime ?? (time - startedAt) / 1000 + timeOffset;
    timeOffset += 0;

    webgl?.tickAdaptive(frameDelta);

    if (touchControls && player.isActive !== touchVisible) {
      touchVisible = player.isActive;
      touchControls.setVisible(touchVisible);
    }

    streamer.update(player.position.x, player.position.z);
    player.update(dt);

    if (chunkMeshes) {
      chunkMeshes.setFocus(player.position.x, player.position.z);
      for (const { cx, cz } of streamer.drainDirty(64)) chunkMeshes.updateChunk(cx, cz);
      chunkMeshes.pump();
    }

    const hit = interaction.raycastFromCamera();
    if (highlight) {
      highlight.visible = hit !== null;
      if (hit) highlight.position.set(hit.blockX + 0.5, hit.blockY + 0.5, hit.blockZ + 0.5);
    }
    cpu?.setHighlight(hit ? { x: hit.blockX, y: hit.blockY, z: hit.blockZ } : null);

    hud.frame(time, {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      chunks: world.loadedChunkCount,
      seed: SEED,
      note: webgl
        ? `${webgl.qualityLevel} ${Math.round(webgl.renderScale * 100)}%`
        : `cpu ${(cpu?.internalWidth ?? 0).toString()}p`,
    });

    if (webgl) {
      webgl.setEnvironment(environmentAt(elapsed), (time - startedAt) / 1000, player.eyeInWater);
      webgl.render();
    } else if (cpu) {
      cpu.applySky(skyStateAt(elapsed));
      cpu.render(elapsed);
    }
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

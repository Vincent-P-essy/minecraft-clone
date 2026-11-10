import "./style.css";
import * as THREE from "three";
import { SoundEngine } from "./audio/sound";
import { GAME_NAME } from "./branding";
import { ChunkMeshManager } from "./render/chunk-mesh-manager";
import { CpuRenderer } from "./render/cpu-renderer";
import { environmentAt } from "./render/environment";
import { Particles } from "./render/particles";
import { QUALITY_PROFILES, WorldRenderer } from "./render/renderer";
import { DAY_LENGTH_SECONDS, STARTUP_PHASE, skyStateAt } from "./render/sky";
import { createTextureAtlas } from "./render/texture-atlas";
import { PlayerController } from "./player/controller";
import { BlockInteraction } from "./player/interaction";
import { aabbFromFeetPosition, aabbIntersectsSolid } from "./player/physics";
import { defaultSettings, type Settings, SettingsStore } from "./settings";
import { Hotbar, sanitizeHotbar } from "./ui/hotbar";
import { Hud } from "./ui/hud";
import { Inventory } from "./ui/inventory";
import { Menu } from "./ui/menu";
import { isTouchDevice, TouchControls } from "./ui/touch-controls";
import { BLOCKS, BlockId, isSolid } from "./world/blocks";
import { CHUNK_HEIGHT } from "./world/coords";
import { EditStore } from "./world/edit-store";
import { loadPlayerSave, storePlayerSave } from "./world/player-save";
import { findPleasantSpawn } from "./world/spawn";
import {
  type ChunkGenerator,
  ChunkStreamer,
  createSyncGenerator,
  createWorkerGenerator,
} from "./world/streamer";
import { Biome, createColumnSampler, SEA_LEVEL } from "./world/terrain";
import { World } from "./world/world";

const DEFAULT_SEED = 2026;
const LAST_SEED_KEY = "voxel-world:last-seed";
const STREAM_RADIUS_CPU = 4;
const WARMUP_RADIUS_CHUNKS = 2;
const SAVE_INTERVAL_MS = 4000;

// Debug handle for the end-to-end harness (scripts/visual-check.mjs): lets
// an automated browser assert on game state instead of guessing from
// pixels, and stage a shot (time of day, vantage point) for screenshots.
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
      /** Freezes the clock at a day phase (0..1); null lets it run again. */
      setTime: (phase: number | null) => void;
      setQuality: (level: string) => void;
      teleport: (x: number, y: number, z: number, yaw: number, pitch: number) => void;
      groundAt: (x: number, z: number) => number;
      locate: (biome: number, skip?: number) => { x: number; z: number; h: number } | null;
      stats: () => Record<string, number | undefined>;
      hotbar: () => number[];
      flying: () => boolean;
      inventoryOpen: () => boolean;
      settings: () => Record<string, string | number | boolean>;
    };
  }
}

/** A dead "Play" button is the worst failure mode a browser game can
 * have. If anything at all goes wrong during boot — and the WebGL and
 * worker paths already have their own fallbacks — say so, visibly, in the
 * menu the player is already looking at. */
function showFatalError(error: unknown): void {
  const content = document.querySelector("#overlay-content");
  if (!content) return;
  const message = error instanceof Error ? error.message : String(error);
  const screen = document.createElement("div");
  screen.className = "menu-screen";
  const title = document.createElement("h2");
  title.textContent = `${GAME_NAME} couldn't start`;
  const detail = document.createElement("p");
  detail.textContent = message;
  const hint = document.createElement("p");
  hint.className = "panel-hint";
  hint.textContent =
    "Try a hard refresh or another browser. If it keeps happening, please report this exact message.";
  screen.append(title, detail, hint);
  content.replaceChildren(screen);
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function boot(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("#app not found");
  const hotbarContainer = document.querySelector<HTMLDivElement>("#hotbar");
  if (!hotbarContainer) throw new Error("#hotbar not found");
  const menuRoot = document.querySelector<HTMLElement>("#overlay-content");
  if (!menuRoot) throw new Error("#overlay-content not found");

  // A shareable world: ?seed=1234 loads the same terrain for everyone.
  // Without one, return to the world played last.
  const params = new URLSearchParams(window.location.search);
  const parseSeed = (text: string | null): number =>
    text === null ? NaN : Number.parseInt(text, 10);
  const fromUrl = parseSeed(params.get("seed"));
  const fromLast = parseSeed(readStorage(LAST_SEED_KEY));
  const SEED = Number.isFinite(fromUrl)
    ? fromUrl
    : Number.isFinite(fromLast)
      ? fromLast
      : DEFAULT_SEED;
  try {
    window.localStorage.setItem(LAST_SEED_KEY, SEED.toString());
  } catch {
    // Private browsing: the world just won't be remembered.
  }

  const touch = isTouchDevice();
  const cores = navigator.hardwareConcurrency || 4;
  const settings = new SettingsStore(window.localStorage, defaultSettings({ touch, cores }));
  // URL overrides, for benchmarks and the screenshot harness.
  const qualityParam = params.get("quality");
  if (
    qualityParam === "low" ||
    qualityParam === "medium" ||
    qualityParam === "high" ||
    qualityParam === "ultra"
  ) {
    settings.values.quality = qualityParam;
  }
  const viewParam = Number.parseInt(params.get("view") ?? "", 10);
  if (Number.isFinite(viewParam)) {
    settings.values.viewDistance = Math.max(2, Math.min(16, viewParam));
  }

  const world = new World(SEED);
  const atlas = createTextureAtlas(SEED);
  const sampleColumn = createColumnSampler(SEED);
  const sound = new SoundEngine();
  sound.setVolume(settings.values.volume);

  // The renderer: WebGL2 when the browser can, an in-house CPU raycaster
  // when it can't. Same world, same physics, same controls either way.
  let webgl: WorldRenderer | null = null;
  let cpu: CpuRenderer | null = null;
  let chunkMeshes: ChunkMeshManager | null = null;
  let particles: Particles | null = null;
  let highlight: THREE.LineSegments | null = null;
  try {
    const renderer = new WorldRenderer(
      app,
      SEED,
      settings.values.quality,
      settings.values.viewDistance,
    );
    const meshes = new ChunkMeshManager(
      renderer.scene,
      world,
      { terrain: renderer.terrainMaterial, water: renderer.waterMaterial },
      Math.max(1, Math.min(3, cores - 2)),
    );
    const directOutput = (): boolean =>
      !QUALITY_PROFILES[renderer.qualityLevel].post || !renderer.supportsPost;
    const sparks = new Particles(renderer.scene, SEED, directOutput());
    renderer.onMaterialsChanged = () => {
      meshes.setMaterials({ terrain: renderer.terrainMaterial, water: renderer.waterMaterial });
      sparks.setDirect(directOutput());
    };
    highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.75 }),
    );
    highlight.visible = false;
    highlight.renderOrder = 15;
    renderer.scene.add(highlight);
    if (params.has("fullres")) renderer.lockFullResolution();
    webgl = renderer;
    chunkMeshes = meshes;
    particles = sparks;
  } catch (webglError) {
    console.warn("WebGL2 unavailable, switching to the CPU raycaster:", webglError);
    cpu = new CpuRenderer(app, world, SEED);
  }
  const view = webgl ?? cpu;
  if (!view) throw new Error("no renderer could be created");
  const { camera, domElement } = view;

  const editStore = new EditStore(window.localStorage, SEED);
  const streamer = new ChunkStreamer(world, {
    // One extra ring of data beyond what's drawn: lighting a chunk reads
    // all eight of its neighbors.
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
    generator = createWorkerGenerator(SEED, receive, cores >= 6 ? 2 : 1);
  } catch {
    // No module workers? Generate on the main thread — slower on chunk
    // arrival, but the game works everywhere.
    generator = createSyncGenerator(SEED, receive);
  }
  streamer.attachGenerator(generator);

  // Start where the player left off, or somewhere pleasant.
  const saved = loadPlayerSave(window.localStorage, SEED);
  const spawn = findPleasantSpawn(SEED);
  const startX = saved?.x ?? spawn.x;
  const startZ = saved?.z ?? spawn.z;
  // Ground under the player's feet before the first frame; the rest streams in.
  streamer.warmUp(startX, startZ, WARMUP_RADIUS_CHUNKS);

  const player = new PlayerController(camera, domElement, world, startX, startZ, {
    sensitivity: settings.values.sensitivity,
    invertY: settings.values.invertY,
    autoJump: settings.values.autoJump,
    viewBob: settings.values.viewBob,
    fov: settings.values.fov,
  });
  if (saved) {
    // Only trust a saved position that isn't inside rock (the world
    // generator may have changed since it was written).
    const stuck = aabbIntersectsSolid(aabbFromFeetPosition(saved), (x, y, z) =>
      isSolid(world.getBlock(x, y, z)),
    );
    if (!stuck && saved.y > 0 && saved.y < CHUNK_HEIGHT + 64) player.restore(saved);
  }

  const hotbar = new Hotbar(hotbarContainer, atlas.canvas, sanitizeHotbar(saved?.hotbar));
  if (saved) hotbar.select(saved.slot);
  const inventory = new Inventory(app, atlas.canvas);
  const hud = new Hud(app);
  hud.setStatsVisible(settings.values.showStats);

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
    if (edit.id === BlockId.AIR) {
      sound.breakBlock(edit.previous);
      particles?.burst(edit.x, edit.y, edit.z, edit.previous);
    } else {
      sound.placeBlock(edit.id);
    }
  };
  interaction.onPick = (id) => {
    hotbar.pick(id);
  };

  // ---- time of day ----
  let gameTime = saved?.time ?? STARTUP_PHASE * DAY_LENGTH_SECONDS;
  let frozenTime: number | null = null;

  const persist = (): void => {
    storePlayerSave(window.localStorage, SEED, {
      ...player.pose(),
      time: gameTime % DAY_LENGTH_SECONDS,
      hotbar: [...hotbar.contents],
      slot: hotbar.selectedSlot,
    });
  };

  hotbar.onChange = () => {
    hud.announce(BLOCKS[hotbar.selectedBlock].name);
    sound.select();
  };

  // ---- inventory ----
  const setInventory = (open: boolean): void => {
    if (open === inventory.isOpen) return;
    if (open && !player.isActive) return;
    inventory.setOpen(open);
    interaction.enabled = !open;
    if (open) player.openUi();
    else player.closeUi();
    sound.click();
  };
  inventory.onChoose = (block) => {
    hotbar.assign(block);
    setInventory(false);
  };
  inventory.onClose = () => {
    setInventory(false);
  };

  // ---- on-screen controls for touch devices ----
  const touchControls = touch
    ? new TouchControls(app, {
        isActive: () => player.isActive && !inventory.isOpen,
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
        onPause: () => {
          player.releaseControl();
        },
        onInventory: () => {
          setInventory(true);
        },
        onToggleFly: () => {
          player.toggleFlight();
        },
      })
    : null;
  let touchVisible = false;
  touchControls?.setFlying(player.isFlying);

  // ---- menu and settings ----
  const menu = new Menu(menuRoot, settings, {
    seed: SEED,
    touch,
    canUsePost: webgl?.supportsPost ?? false,
    onClick: () => {
      sound.unlock();
      sound.click();
    },
    onOpenWorld: (seed) => {
      persist();
      const url = new URL(window.location.href);
      url.searchParams.set("seed", seed.toString());
      window.location.href = url.toString();
    },
    onResetWorld: () => {
      editStore.clear();
      window.location.reload();
    },
  });

  const applySetting = (values: Settings, key: keyof Settings): void => {
    switch (key) {
      case "quality":
        webgl?.setQuality(values.quality);
        break;
      case "viewDistance":
        webgl?.setViewDistance(values.viewDistance);
        if (webgl) streamer.setRadius(values.viewDistance + 1);
        break;
      case "fov":
        player.options.fov = values.fov;
        break;
      case "sensitivity":
        player.options.sensitivity = values.sensitivity;
        break;
      case "invertY":
        player.options.invertY = values.invertY;
        break;
      case "autoJump":
        player.options.autoJump = values.autoJump;
        break;
      case "viewBob":
        player.options.viewBob = values.viewBob;
        break;
      case "volume":
        sound.setVolume(values.volume);
        break;
      case "showStats":
        hud.setStatsVisible(values.showStats);
        break;
    }
  };
  settings.onChange(applySetting);

  player.onResume = () => {
    sound.unlock();
    sound.setPaused(false);
    menu.markStarted();
  };
  player.onPause = () => {
    inventory.setOpen(false);
    interaction.enabled = true;
    menu.show("main");
    sound.setPaused(true);
    persist();
  };
  player.onFlightChange = (flying) => {
    hud.announce(flying ? "Flying" : "Walking");
    touchControls?.setFlying(flying);
  };
  player.events = {
    onStep: (block) => {
      sound.step(block);
    },
    onJump: () => {
      sound.jump();
    },
    onLand: (fallSpeed, block) => {
      sound.land(fallSpeed, block);
    },
    onSplash: (entering) => {
      sound.splash(entering);
      const p = player.position;
      if (entering) particles?.splash(p.x, Math.floor(p.y) + 0.9, p.z);
    },
  };

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code === "KeyE") {
      setInventory(!inventory.isOpen);
    } else if (e.code === "Escape" && inventory.isOpen) {
      // Escape already released the pointer; leave play cleanly.
      player.releaseControl();
    } else if (e.code === "F3") {
      e.preventDefault();
      settings.set("showStats", !settings.values.showStats);
    }
  });

  window.addEventListener("resize", () => {
    webgl?.resize(window.innerWidth, window.innerHeight);
    cpu?.resize(window.innerWidth, window.innerHeight);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      persist();
      sound.setPaused(true);
    } else if (player.isActive) {
      sound.setPaused(false);
    }
  });
  window.addEventListener("pagehide", persist);

  // ---- how far underground is the camera? ----
  let caveFactor = 0;
  let caveColumnKey = "";
  let caveColumnHeight = 0;
  const caveTarget = (): number => {
    const c = camera.position;
    const bx = Math.floor(c.x);
    const bz = Math.floor(c.z);
    const key = `${bx.toString()},${bz.toString()}`;
    if (key !== caveColumnKey) {
      caveColumnKey = key;
      caveColumnHeight = sampleColumn(bx, bz).terrainHeight;
    }
    if (c.y > caveColumnHeight - 5) return 0;
    // Under the natural surface: a cave only if there's a roof overhead.
    const from = Math.floor(c.y) + 1;
    for (let y = from; y < Math.min(CHUNK_HEIGHT, from + 48); y++) {
      if (isSolid(world.getBlock(bx, y, bz))) return 1;
    }
    return 0;
  };

  /** Where fireflies may appear: over grass, on dry land. */
  const fireflyGround = (x: number, z: number): number => {
    const profile = sampleColumn(Math.floor(x), Math.floor(z));
    const meadow =
      profile.biome === Biome.PLAINS ||
      profile.biome === Biome.FOREST ||
      profile.biome === Biome.AUTUMN;
    return meadow && profile.terrainHeight > SEA_LEVEL ? profile.terrainHeight : -1;
  };

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
      frozenTime = phase === null ? null : phase * DAY_LENGTH_SECONDS;
    },
    setQuality: (level) => {
      if (level === "low" || level === "medium" || level === "high" || level === "ultra") {
        settings.set("quality", level);
      }
    },
    teleport: (x, y, z, yaw, pitch) => {
      player.restore({ x, y, z, yaw, pitch, flying: true });
    },
    groundAt: (x, z) => sampleColumn(x, z).terrainHeight,
    locate: (biome, skip = 0) => {
      let found = 0;
      for (let radius = 0; radius < 4000; radius += 24) {
        for (let i = -radius; i <= radius; i += 24) {
          for (const [x, z] of [
            [i, -radius],
            [i, radius],
            [-radius, i],
            [radius, i],
          ] as const) {
            const p = sampleColumn(x, z);
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
      fps: hud.fps,
    }),
    hotbar: () => [...hotbar.contents],
    flying: () => player.isFlying,
    inventoryOpen: () => inventory.isOpen,
    settings: () => ({ ...settings.values }),
  };

  // Installable and playable offline (production builds only).
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  }

  let lastTime = performance.now();
  let lastSave = lastTime;
  const frame = (time: number): void => {
    const frameDelta = time - lastTime;
    const dt = Math.min(frameDelta / 1000, 0.1); // clamp to avoid a huge step after a tab switch
    lastTime = time;
    gameTime += dt;
    const clock = frozenTime ?? gameTime;

    // Adaptive quality: feed the real frame cadence so the renderer can
    // trade resolution for a fluid frame rate on weaker (mobile) hardware.
    webgl?.tickAdaptive(frameDelta);

    const controlsVisible = player.isActive && !inventory.isOpen;
    if (touchControls && controlsVisible !== touchVisible) {
      touchVisible = controlsVisible;
      touchControls.setVisible(touchVisible);
    }
    hotbar.enabled = player.isActive && !inventory.isOpen;

    streamer.update(player.position.x, player.position.z);
    player.update(dt);

    if (chunkMeshes) {
      chunkMeshes.setFocus(player.position.x, player.position.z);
      for (const { cx, cz } of streamer.drainDirty(64)) chunkMeshes.updateChunk(cx, cz);
      chunkMeshes.pump();
    }

    const hit = player.isActive && !inventory.isOpen ? interaction.raycastFromCamera() : null;
    if (highlight) {
      highlight.visible = hit !== null;
      if (hit) highlight.position.set(hit.blockX + 0.5, hit.blockY + 0.5, hit.blockZ + 0.5);
    }
    cpu?.setHighlight(hit ? { x: hit.blockX, y: hit.blockY, z: hit.blockZ } : null);

    caveFactor += (caveTarget() - caveFactor) * (1 - Math.exp(-dt * 1.6));
    const underwater = player.eyeInWater;
    const environment = environmentAt(clock);

    sound.update({
      night: environment.night,
      underwater,
      cave: caveFactor,
      speed: Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z),
    });

    if (time - lastSave > SAVE_INTERVAL_MS && player.isActive) {
      lastSave = time;
      persist();
    }

    hud.frame(time, {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      chunks: world.loadedChunkCount,
      seed: SEED,
      note: webgl
        ? `${webgl.qualityLevel} ${Math.round(webgl.renderScale * 100).toString()}%`
        : `cpu ${(cpu?.internalWidth ?? 0).toString()}p`,
    });

    if (webgl) {
      const open = 1 - caveFactor;
      particles?.update(
        dt,
        player.position,
        environment.night * open,
        [
          environment.ambientSky[0] * open + environment.lightColor[0] * 0.5 * open + 0.02,
          environment.ambientSky[1] * open + environment.lightColor[1] * 0.5 * open + 0.02,
          environment.ambientSky[2] * open + environment.lightColor[2] * 0.5 * open + 0.02,
        ],
        window.innerHeight * webgl.renderer.getPixelRatio(),
        camera.fov,
        environment.exposure,
        fireflyGround,
      );
      webgl.setCaveFactor(caveFactor);
      webgl.setEnvironment(environment, time / 1000, underwater);
      webgl.render();
    } else if (cpu) {
      cpu.applySky(skyStateAt(clock));
      cpu.render(clock);
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

/**
 * Captures the README screenshots from the real running game in headless
 * Chromium (SwiftShader). Each scene is staged through the game's debug
 * handle — a time of day, a vantage point, and for the cabin shots a small
 * house built block by block — so the gallery can be regenerated after any
 * visual change.
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/screenshot.mjs [--url http://localhost:4173/] [--out docs/screenshots]
 *                               [--only hero-dusk,menu]
 *
 * Set PUPPETEER_EXECUTABLE_PATH to use an already-installed Chromium.
 * Software rendering is slow: allow a couple of minutes per scene.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const BASE_URL = argValue("--url", "http://localhost:4173/");
const OUT_DIR = argValue("--out", "docs/screenshots");
const ONLY = argValue("--only", "").split(",").filter(Boolean);
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs in the page: builds a lantern-lit cabin on the nearest meadow and
 * parks the camera in front of it. */
function buildCabin() {
  const m = window.__mc;
  const meadow = m.locate(2) ?? { x: 0, z: 0 };
  const ox = meadow.x - 20 + 4;
  const oz = meadow.z - 24 - 9;
  const g = m.groundAt(ox + 3, oz + 3);
  const set = (x, y, z, id) => m.setBlock(ox + x, g + y, oz + z, id);
  const [AIR, GRASS, LOG, PLANKS, COBBLE, BRICKS_STONE, GLASS, LANTERN, BRICK] = [
    0, 1, 6, 14, 15, 16, 17, 18, 29,
  ];
  // Level the plot.
  for (let x = -1; x <= 7; x++) {
    for (let z = -1; z <= 7; z++) {
      for (let y = 1; y <= 9; y++) set(x, y, z, AIR);
      set(x, 0, z, x < 0 || z < 0 || x > 6 || z > 6 ? GRASS : COBBLE);
    }
  }
  // Walls: log corners, plank infill over a stone footing, glass windows, a door.
  for (let x = 0; x <= 6; x++) {
    for (let z = 0; z <= 6; z++) {
      const edge = x === 0 || z === 0 || x === 6 || z === 6;
      const corner = (x === 0 || x === 6) && (z === 0 || z === 6);
      set(x, 0, z, PLANKS);
      if (!edge) continue;
      for (let y = 1; y <= 4; y++) {
        let id = corner ? LOG : PLANKS;
        const windowBand = y === 2 || y === 3;
        if (!corner && windowBand && [2, 3, 4].some((n) => n === x || n === z)) id = GLASS;
        if (!corner && y === 1) id = BRICKS_STONE;
        if (z === 6 && x === 3 && y <= 2) id = AIR;
        set(x, y, z, id);
      }
    }
  }
  // A stepped brick roof.
  for (let layer = 0; layer <= 3; layer++) {
    for (let x = -1 + layer; x <= 7 - layer; x++) {
      for (let z = -1 + layer; z <= 7 - layer; z++) set(x, 5 + layer, z, BRICK);
    }
  }
  for (const [x, y, z] of [
    [3, 4, 3],
    [1, 1, 1],
    [5, 1, 5],
    [2, 1, 8],
    [4, 1, 8],
    [-2, 1, 3],
    [8, 1, 3],
  ]) {
    set(x, y, z, LANTERN);
  }
  m.teleport(ox + 9.5, g + 4.2, oz + 15.5, 0.42, -0.16);
}

/** Runs in the page: finds a lumen crystal deep underground with open cave
 * beside it and stands the camera a few blocks back, looking at it. */
function findCrystalCave() {
  const m = window.__mc;
  const p = m.position();
  const px = Math.floor(p.x);
  const pz = Math.floor(p.z);
  for (let r = 0; r < 70; r++) {
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== r) continue;
        for (let y = 6; y < 26; y++) {
          if (m.blockAt(px + x, y, pz + z) !== 21) continue;
          for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const open = [1, 2, 3, 4].every(
              (n) =>
                m.blockAt(px + x + dx * n, y, pz + z + dz * n) === 0 &&
                m.blockAt(px + x + dx * n, y + 1, pz + z + dz * n) === 0,
            );
            if (!open) continue;
            m.teleport(
              px + x + dx * 4 + 0.5,
              y - 0.3,
              pz + z + dz * 4 + 0.5,
              Math.atan2(dx, dz),
              0.05,
            );
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** time: day phase 0..1 (0 sunrise, 0.3 noon, 0.6 sunset, 0.8 midnight). */
const SCENES = [
  { name: "hero-dusk", time: 0.6, stage: buildCabin },
  { name: "night-lanterns", time: 0.8, stage: buildCabin },
  { name: "vista", time: 0.2, at: { x: 0.5, y: 80, z: 0.5, yaw: 0.6, pitch: -0.25 } },
  { name: "forest", time: 0.22, biome: 3, lift: 2, yaw: 0.5, pitch: -0.08 },
  { name: "sunset-shore", time: 0.575, biome: 1, skip: 2, lift: 4, yaw: 1.57, pitch: -0.02 },
  {
    name: "cave-crystals",
    time: 0.25,
    at: { x: 0.5, y: 80, z: 0.5, yaw: 0, pitch: 0 },
    stage: findCrystalCave,
  },
  { name: "rain", time: 0.3, biome: 3, lift: 2, yaw: 0.5, pitch: -0.02, weather: [1, 1] },
  { name: "snow", time: 0.3, biome: 7, skip: 6, lift: 9, yaw: 1.0, pitch: -0.3, weather: [1, 1] },
  { name: "menu", time: 0.2, biome: 3, lift: 6, yaw: 0.5, pitch: -0.1, keepMenu: true },
  {
    name: "mobile",
    time: 0.32,
    biome: 2,
    lift: 3,
    yaw: 2.2,
    pitch: -0.12,
    play: true,
    viewport: { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    query: "quality=medium&view=7&fullres=1&lang=en",
  },
];

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

/** Waits until no chunks are being generated or meshed. */
async function settle(page) {
  const started = Date.now();
  await sleep(1500);
  while (Date.now() - started < 180_000) {
    const busy = await page.evaluate(
      () => window.__mc.pendingChunks() + (window.__mc.stats().queued ?? 0),
    );
    if (busy === 0) break;
    await sleep(1000);
  }
}

try {
  for (const scene of SCENES) {
    if (ONLY.length > 0 && !ONLY.includes(scene.name)) continue;
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport(scene.viewport ?? { width: 1280, height: 720 });
    const query = scene.query ?? "quality=high&view=9&fullres=1&lang=en";
    await page.goto(`${BASE_URL}?seed=2026&${query}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForFunction(() => window.__mc && window.__mc.meshedChunks() >= 9, {
      timeout: 180_000,
      polling: 500,
    });

    await page.evaluate((s) => {
      const m = window.__mc;
      m.setTime(s.time);
      if (s.weather) m.setWeather(s.weather[0], s.weather[1]);
      else m.setWeather(0, 0);
      if (s.at) {
        m.teleport(s.at.x, s.at.y, s.at.z, s.at.yaw, s.at.pitch);
      } else if (s.biome !== undefined) {
        const spot = m.locate(s.biome, s.skip ?? 0);
        if (spot) {
          m.teleport(
            spot.x + 0.5,
            m.groundAt(spot.x, spot.z) + s.lift,
            spot.z + 0.5,
            s.yaw,
            s.pitch,
          );
        }
      }
    }, scene);
    await settle(page);
    if (scene.stage) {
      await page.evaluate(scene.stage);
      await settle(page);
    }
    if (scene.play) {
      await page.click("#play-button");
      await sleep(1500);
    } else if (!scene.keepMenu) {
      await page.evaluate(() => document.querySelector("#overlay")?.classList.add("hidden"));
    }
    await sleep(6000); // let the last meshes upload and a few frames render

    const file = path.join(OUT_DIR, `${scene.name}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 90 });
    console.log(`saved ${file}`);
    await context.close();
  }
} finally {
  await browser.close();
}

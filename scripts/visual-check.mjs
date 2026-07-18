/**
 * Drives the real game in a headless Chromium (SwiftShader software WebGL —
 * works on machines with no GPU at all) and verifies it end to end:
 * terrain renders, pointer lock engages, movement moves, breaking breaks.
 * Screenshots land in the directory given by --out (default: ./visual-check).
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/visual-check.mjs [--url http://localhost:4173/] [--out dir]
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const URL_UNDER_TEST = argValue("--url", "http://localhost:4173/");
const OUT_DIR = argValue("--out", "visual-check");
mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function report(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--window-size=1280,720"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(URL_UNDER_TEST, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // ---- world generates and meshes ----
  await page.waitForFunction(() => window.__mc && window.__mc.meshedChunks() >= 60, {
    timeout: 120_000,
    polling: 500,
  });
  const worldInfo = await page.evaluate(() => ({
    loaded: window.__mc.loadedChunks(),
    meshed: window.__mc.meshedChunks(),
    position: window.__mc.position(),
  }));
  report(
    "world generates and meshes",
    worldInfo.meshed >= 60,
    `${worldInfo.meshed} chunks meshed, player at y=${worldInfo.position.y.toFixed(1)}`,
  );

  // ---- player spawned on solid ground, not inside it, not falling forever ----
  const grounded = await page.evaluate(() => {
    const p = window.__mc.position();
    const below = window.__mc.blockAt(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z));
    const at = window.__mc.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    return { below, at, y: p.y };
  });
  report(
    "player rests on solid ground",
    grounded.below !== 0 && grounded.at === 0 && grounded.y > 1,
    `y=${grounded.y.toFixed(2)}, block below=${grounded.below}, block at feet=${grounded.at}`,
  );

  await page.screenshot({ path: path.join(OUT_DIR, "01-menu.png") });

  // ---- the world is actually visible behind the overlay ----
  await page.evaluate(() => document.querySelector("#overlay")?.classList.add("hidden"));
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(OUT_DIR, "02-world.png") });
  await page.evaluate(() => document.querySelector("#overlay")?.classList.remove("hidden"));

  // The render must not be a flat sky-only frame. The WebGL canvas can't be
  // read back directly (drawing buffer isn't preserved between frames), so
  // round-trip a real screenshot through an <img> into a 2D canvas.
  const shotB64 = await page.screenshot({ encoding: "base64" });
  const pixelStats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const probe = document.createElement("canvas");
    probe.width = img.width;
    probe.height = img.height;
    const ctx = probe.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) {
      colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
    }
    return { distinctColors: colors.size };
  }, shotB64);
  report(
    "render shows real variety (terrain, not a blank frame)",
    pixelStats.distinctColors > 12,
    `${pixelStats.distinctColors} distinct quantized colors sampled`,
  );

  // ---- pointer lock + movement ----
  await page.click("#play-button");
  await new Promise((r) => setTimeout(r, 800));
  const locked = await page.evaluate(() => document.pointerLockElement !== null);
  report("pointer lock engages from the play button", locked);

  if (locked) {
    // Break/place first, from the spawn point, where the ground is
    // guaranteed to be right under the player's feet and within reach —
    // after walking, the player may be mid-fall down a slope with nothing
    // targetable for 6 blocks. Look down via a synthetic MouseEvent with an
    // explicit movementY (headless pointer-lock delta reporting through
    // CDP-dispatched moves is unreliable).
    // 700 clamps to max pitch: looking (almost) straight down guarantees a
    // target — the block under the player's own feet — even on a spawn peak
    // whose slopes fall away faster than the 6-block reach.
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { movementX: 0, movementY: 700 }));
    });
    await new Promise((r) => setTimeout(r, 700));
    const target = await page.evaluate(() => window.__mc.target());
    report("crosshair targets a block when looking down", target !== null, JSON.stringify(target));

    if (target) {
      await page.mouse.down({ button: "left" });
      await page.mouse.up({ button: "left" });
      await new Promise((r) => setTimeout(r, 700));
      const afterBreak = await page.evaluate((t) => window.__mc.blockAt(t.x, t.y, t.z), target);
      report(
        "left click breaks the targeted block",
        afterBreak === 0,
        `block ${JSON.stringify(target)} is now id ${afterBreak}`,
      );

      const placeTarget = await page.evaluate(() => window.__mc.target());
      if (placeTarget) {
        const placeCell = await page.evaluate(() => {
          const hit = window.__mc.target();
          return hit; // the solid block aimed at; the placed block lands on its hit face
        });
        await page.mouse.down({ button: "right" });
        await page.mouse.up({ button: "right" });
        await new Promise((r) => setTimeout(r, 700));
        // Placement is validated by the world state changing somewhere
        // adjacent to the aim cell: scan its 6 neighbors for the block id
        // selected in the hotbar (slot 1 = grass by default).
        const placedNearby = await page.evaluate((t) => {
          const offsets = [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ];
          return offsets.some(([dx, dy, dz]) => {
            const id = window.__mc.blockAt(t.x + dx, t.y + dy, t.z + dz);
            return id === 1; // grass, the default hotbar selection
          });
        }, placeCell);
        report("right click places the selected block against the hit face", placedNearby);
      }
    }

    // Look back up before the movement test.
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { movementX: 0, movementY: -700 }));
    });

    const before = await page.evaluate(() => window.__mc.position());
    await page.keyboard.down("KeyW");
    await new Promise((r) => setTimeout(r, 2500));
    await page.keyboard.up("KeyW");
    const after = await page.evaluate(() => window.__mc.position());
    const dist = Math.hypot(after.x - before.x, after.z - before.z);
    report(
      "walking forward moves the player through the world",
      dist > 1,
      `moved ${dist.toFixed(1)} blocks`,
    );

    await page.screenshot({ path: path.join(OUT_DIR, "03-playing.png") });
  }

  // ---- console stayed clean ----
  const realErrors = consoleErrors.filter((e) => !e.includes("favicon"));
  report("no console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await browser.close();
}

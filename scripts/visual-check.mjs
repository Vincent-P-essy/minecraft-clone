/**
 * Drives the real game in a headless Chromium (SwiftShader software WebGL —
 * works on machines with no GPU at all) and verifies it end to end: every
 * graphics tier compiles and renders, the world is playable with mouse and
 * keyboard, with a blocked pointer lock, with no WebGL at all, and on a
 * touchscreen; progress survives a reload; the installed build boots
 * offline. Screenshots land in the directory given by --out.
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/visual-check.mjs [--url http://localhost:4173/] [--out dir]
 *
 * Set PUPPETEER_EXECUTABLE_PATH to use an already-installed Chromium.
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
const OUT_DIR = argValue("--out", "visual-check");
mkdirSync(OUT_DIR, { recursive: true });

/** Each scenario plays in its own world (seed), so the edits and the saved
 * position of one never leak into the next. The light tier keeps software
 * rendering fast enough for real-time input tests. */
const pageUrl = (seed, extra = "quality=low&view=5") =>
  `${BASE_URL}?seed=${seed.toString()}&lang=en&${extra}`;

/** Blocks that aren't a solid cube to stand a new block on. */
const NOT_GROUND = [0, 5, 10, 11, 12, 13, 31, 33];

const results = [];
function report(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
    "--window-size=1280,720",
  ],
});

const consoleErrors = [];
function watch(page, label) {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`[${label}] ${msg.text().slice(0, 400)}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[${label}] ${String(err).slice(0, 400)}`));
}

/** Opens a scenario in its own browser context — separate storage and
 * service workers — the way a different player on a different device
 * would arrive. */
async function openPage(label, url, viewport = { width: 1280, height: 720 }, before) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  watch(page, label);
  if (before) await page.evaluateOnNewDocument(before);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return page;
}

const waitForWorld = (page, chunks, counter = "meshedChunks") =>
  page.waitForFunction(
    (n, fn) => window.__mc && window.__mc[fn]() >= n,
    {
      timeout: 180_000,
      polling: 500,
    },
    chunks,
    counter,
  );

/** How many distinct (quantized) colors a screenshot holds — a blank or
 * single-color frame scores in the single digits. */
async function colorVariety(page) {
  const b64 = await page.screenshot({ encoding: "base64" });
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const probe = document.createElement("canvas");
    probe.width = img.width;
    probe.height = img.height;
    const ctx = probe.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, probe.width, probe.height).data;
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 4 * 97) {
      colors.add(`${pixels[i] >> 4},${pixels[i + 1] >> 4},${pixels[i + 2] >> 4}`);
    }
    return colors.size;
  }, b64);
}

/** Software rendering can be slow, and the game simulates in real time —
 * so instead of sleeping a fixed time and hoping enough frames ran, wait
 * for the thing itself, with a generous ceiling. */
async function until(page, predicate, arg, timeout = 25_000) {
  return page
    .waitForFunction(predicate, { timeout, polling: 100 }, arg)
    .then(() => true)
    .catch(() => false);
}

/** Holds forward (and jump, to hop ledges) until the player has covered
 * some ground, and reports the distance. */
async function walk(page) {
  const before = await page.evaluate(() => window.__mc.position());
  await page.keyboard.down("KeyW");
  await page.keyboard.down("Space");
  await until(
    page,
    (start) => {
      const p = window.__mc.position();
      return Math.hypot(p.x - start.x, p.z - start.z) > 1.5;
    },
    before,
  );
  await page.keyboard.up("Space");
  await page.keyboard.up("KeyW");
  const after = await page.evaluate(() => window.__mc.position());
  return Math.hypot(after.x - before.x, after.z - before.z);
}

try {
  // =====================================================================
  // 1. Desktop, WebGL, pointer lock
  // =====================================================================
  const page = await openPage("desktop", pageUrl(2026));
  await waitForWorld(page, 40);
  const worldInfo = await page.evaluate(() => ({
    meshed: window.__mc.meshedChunks(),
    position: window.__mc.position(),
    renderer: window.__mc.renderer(),
  }));
  report(
    "world generates and meshes (WebGL2)",
    worldInfo.meshed >= 40 && worldInfo.renderer === "webgl",
    `${worldInfo.meshed} chunks meshed, player at y=${worldInfo.position.y.toFixed(1)}`,
  );

  const grounded = await page.evaluate(() => {
    const p = window.__mc.position();
    const below = window.__mc.blockAt(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z));
    return { below, y: p.y };
  });
  report(
    "player rests on solid ground",
    !NOT_GROUND.includes(grounded.below) && grounded.y > 1,
    `y=${grounded.y.toFixed(2)}, block below=${grounded.below}`,
  );

  await page.screenshot({ path: path.join(OUT_DIR, "01-menu.png") });
  const menuText = await page.evaluate(() => ({
    title: document.querySelector(".title")?.textContent ?? "",
    play: document.querySelector("#play-button")?.textContent ?? "",
  }));
  report(
    "the title menu shows the game's name and a play button",
    menuText.title.length > 0 && menuText.play === "Play",
    JSON.stringify(menuText),
  );

  // The world must be visible behind the menu, not a flat sky-only frame.
  await page.evaluate(() => document.querySelector("#overlay")?.classList.add("hidden"));
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT_DIR, "02-world.png") });
  const variety = await colorVariety(page);
  await page.evaluate(() => document.querySelector("#overlay")?.classList.remove("hidden"));
  report(
    "render shows real variety (terrain, not a blank frame)",
    variety > 12,
    `${variety} distinct quantized colors sampled`,
  );

  await page.click("#play-button");
  await sleep(800);
  const locked = await page.evaluate(() => document.pointerLockElement !== null);
  report("pointer lock engages from the play button", locked);

  // Sets an absolute view direction regardless of prior state: pitch first
  // clamps fully up, then a fixed downward delta lands at a known angle;
  // yaw is a pure delta (the harness starts at yaw 0 and tracks its own
  // rotations). Synthetic MouseEvents because headless pointer-lock delta
  // reporting through CDP-dispatched moves is unreliable.
  const look = async (p, yawPixels, pitchPixels) => {
    await p.evaluate(
      ([yawPx, pitchPx]) => {
        document.dispatchEvent(new MouseEvent("mousemove", { movementX: 0, movementY: -2000 }));
        document.dispatchEvent(
          new MouseEvent("mousemove", { movementX: yawPx, movementY: pitchPx }),
        );
      },
      [yawPixels, pitchPixels],
    );
    await sleep(500);
  };

  if (locked) {
    // ---- placing, on a solid neighboring column the test picks itself ----
    // Aiming at the top face of an adjacent column's surface block makes the
    // place cell sit outside the player's own body (placing into yourself is
    // correctly rejected). The neighbor is chosen by inspecting the world,
    // so the test doesn't depend on which way the terrain slopes.
    const neighbor = await page.evaluate((notGround) => {
      const p = window.__mc.position();
      const bx = Math.floor(p.x);
      const by = Math.floor(p.y);
      const bz = Math.floor(p.z);
      const candidates = [
        { dx: 1, dz: 0, yaw: -Math.PI / 2 }, // +X
        { dx: -1, dz: 0, yaw: Math.PI / 2 }, // -X
        { dx: 0, dz: -1, yaw: 0 }, // -Z (default facing)
        { dx: 0, dz: 1, yaw: Math.PI }, // +Z
      ];
      for (const c of candidates) {
        const surface = window.__mc.blockAt(bx + c.dx, by - 1, bz + c.dz);
        const above = window.__mc.blockAt(bx + c.dx, by, bz + c.dz);
        const higher = window.__mc.blockAt(bx + c.dx, by + 1, bz + c.dz);
        // A tuft of grass on top is fine: aiming at it replaces it, which
        // puts the new block in the very same cell.
        const clear = above === 0 || (above >= 10 && above <= 13);
        if (!notGround.includes(surface) && clear && higher === 0) {
          return { ...c, x: bx + c.dx, y: by - 1, z: bz + c.dz };
        }
      }
      return null;
    }, NOT_GROUND);
    report(
      "a flat neighboring column exists to place against",
      neighbor !== null,
      JSON.stringify(neighbor),
    );

    if (neighbor) {
      // Face the neighbor, look ~55 degrees down: the ray crosses into its
      // column below the player's eye and hits the surface block's top face.
      await look(page, -neighbor.yaw / 0.0022, 1146);
      const placeTarget = await page.evaluate(() => window.__mc.target());
      await page.mouse.down({ button: "right" });
      await page.mouse.up({ button: "right" });
      await sleep(600);
      const placed = await page.evaluate((n) => window.__mc.blockAt(n.x, n.y + 1, n.z), neighbor);
      report(
        "right click places the selected block on the neighbor's top face",
        placed === 1, // grass, the default hotbar selection
        `aimed ${JSON.stringify(placeTarget)}, cell above is now id ${placed}`,
      );
      await look(page, neighbor.yaw / 0.0022, 709); // undo the yaw
    }

    // ---- walking (before any digging: a pit would trap the player) ----
    await look(page, 0, 709);
    const walked = await walk(page);
    report(
      "walking forward moves the player through the world",
      walked > 1,
      `moved ${walked.toFixed(1)} blocks`,
    );

    // ---- breaking, straight down at the block under the player's feet ----
    await look(page, 0, 2000); // clamps to max pitch: straight down
    const target = await page.evaluate(() => window.__mc.target());
    report("crosshair targets a block when looking down", target !== null, JSON.stringify(target));
    if (target) {
      await page.mouse.down({ button: "left" });
      await page.mouse.up({ button: "left" });
      await sleep(600);
      const afterBreak = await page.evaluate((t) => window.__mc.blockAt(t.x, t.y, t.z), target);
      report(
        "left click breaks the targeted block",
        afterBreak === 0,
        `block ${JSON.stringify(target)} is now id ${afterBreak}`,
      );
    }

    // ---- creative inventory: E opens it, a click fills the hotbar slot ----
    const hotbarBefore = await page.evaluate(() => window.__mc.hotbar());
    await page.keyboard.press("KeyE");
    await sleep(400);
    const opened = await page.evaluate(() => window.__mc.inventoryOpen());
    report("E opens the block inventory", opened);
    if (opened) {
      await page.screenshot({ path: path.join(OUT_DIR, "03-inventory.png") });
      // Pick a block that isn't in the selected slot yet (bricks, id 29).
      await page.click('.inventory-cell[data-block="29"]');
      await sleep(500);
      const state = await page.evaluate(() => ({
        hotbar: window.__mc.hotbar(),
        open: window.__mc.inventoryOpen(),
        mode: window.__mc.mode(),
      }));
      report(
        "choosing a block fills the selected slot and returns to the game",
        state.hotbar[0] === 29 && hotbarBefore[0] !== 29 && !state.open && state.mode !== "idle",
        `slot 1: ${hotbarBefore[0]} -> ${state.hotbar[0]}, open=${state.open}, mode=${state.mode}`,
      );
    }

    // ---- flight: double-tap jump takes off; then free movement up and down ----
    await page.keyboard.press("Space");
    await sleep(60);
    await page.keyboard.press("Space");
    await sleep(300);
    const tookOff = await page.evaluate(() => window.__mc.flying());
    report("double-tapping jump takes off", tookOff === true);

    // Move to open sky (trees may roof the spawn) and fly there.
    await page.evaluate(() => {
      const p = window.__mc.position();
      window.__mc.teleport(
        p.x,
        window.__mc.groundAt(Math.floor(p.x), Math.floor(p.z)) + 30,
        p.z,
        0,
        0,
      );
    });
    await sleep(300);
    const y0 = (await page.evaluate(() => window.__mc.position())).y;
    await page.keyboard.down("Space");
    await until(page, (from) => window.__mc.position().y > from + 4, y0);
    await page.keyboard.up("Space");
    const y1 = (await page.evaluate(() => window.__mc.position())).y;
    await page.keyboard.down("KeyC");
    await until(page, (from) => window.__mc.position().y < from - 4, y1);
    await page.keyboard.up("KeyC");
    const y2 = (await page.evaluate(() => window.__mc.position())).y;
    report(
      "in flight, jump climbs and C descends",
      y1 > y0 + 3 && y2 < y1 - 3,
      `y ${y0.toFixed(1)} -> ${y1.toFixed(1)} -> ${y2.toFixed(1)}`,
    );
    await page.screenshot({ path: path.join(OUT_DIR, "04-flying.png") });

    // ---- pause, change a setting, reload: both are remembered ----
    await page.evaluate(() => document.exitPointerLock());
    await sleep(500);
    const paused = await page.evaluate(() => ({
      mode: window.__mc.mode(),
      play: document.querySelector("#play-button")?.textContent ?? "",
    }));
    report(
      "leaving pointer lock pauses to the menu, which now offers to resume",
      paused.mode === "idle" && paused.play === "Resume",
      JSON.stringify(paused),
    );
    await page.click("#settings-button");
    await sleep(200);
    await page.screenshot({ path: path.join(OUT_DIR, "05-settings.png") });
    const fovBefore = (await page.evaluate(() => window.__mc.settings())).fov;
    await page.evaluate(() => {
      const sliders = document.querySelectorAll('[data-screen="settings"] input[type="range"]');
      const fov = sliders[1]; // view distance, then field of view
      fov.value = "88";
      fov.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const fovAfter = (await page.evaluate(() => window.__mc.settings())).fov;
    report(
      "the settings panel changes a setting live",
      fovAfter === 88 && fovBefore !== 88,
      `fov ${fovBefore} -> ${fovAfter}`,
    );

    const posBefore = await page.evaluate(() => window.__mc.position());
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForWorld(page, 9);
    const restored = await page.evaluate(() => ({
      position: window.__mc.position(),
      fov: window.__mc.settings().fov,
      hotbar: window.__mc.hotbar(),
      flying: window.__mc.flying(),
    }));
    const drift = Math.hypot(
      restored.position.x - posBefore.x,
      restored.position.y - posBefore.y,
      restored.position.z - posBefore.z,
    );
    report(
      "a reload restores the player's position, hotbar and settings",
      drift < 1.5 && restored.fov === 88 && restored.hotbar[0] === 29 && restored.flying,
      `moved ${drift.toFixed(2)} blocks, fov=${restored.fov}, slot 1=${restored.hotbar[0]}, flying=${restored.flying}`,
    );
    const edited = target
      ? await page.evaluate((t) => window.__mc.blockAt(t.x, t.y, t.z), target)
      : -1;
    report("the reload also keeps the world edits", edited === 0, `broken block is id ${edited}`);
  }
  await page.close();

  // ---- the interface speaks French when asked to ----
  const frenchPage = await openPage("french", `${BASE_URL}?seed=2026&lang=fr&quality=low&view=3`);
  await waitForWorld(frenchPage, 5);
  const french = await frenchPage.evaluate(() => ({
    lang: document.documentElement.lang,
    play: document.querySelector("#play-button")?.textContent?.trim() ?? "",
    settings: document.querySelector("#settings-button")?.textContent?.trim() ?? "",
    slot: document.querySelector(".hotbar-slot")?.getAttribute("title") ?? "",
  }));
  report(
    "the interface is available in French (menu and block names)",
    french.lang === "fr" &&
      french.play === "Jouer" &&
      french.settings === "Réglages" &&
      french.slot === "herbe",
    JSON.stringify(french),
  );
  await frenchPage.screenshot({ path: path.join(OUT_DIR, "05b-french.png") });
  await frenchPage.close();

  // =====================================================================
  // 2. Every graphics tier compiles its shaders and draws a real frame
  // =====================================================================
  for (const tier of ["medium", "high", "ultra"]) {
    const before = consoleErrors.length;
    const tierPage = await openPage(tier, pageUrl(7, `quality=${tier}&view=3&fullres=1`), {
      width: 640,
      height: 360,
    });
    await waitForWorld(tierPage, 5);
    await tierPage.evaluate(() => document.querySelector("#overlay")?.classList.add("hidden"));
    await sleep(4000);
    const tierVariety = await colorVariety(tierPage);
    await tierPage.screenshot({ path: path.join(OUT_DIR, `06-tier-${tier}.png`) });
    const errors = consoleErrors.length - before;
    report(
      `the ${tier} tier compiles and renders`,
      tierVariety > 12 && errors === 0,
      `${tierVariety} colors, ${errors} console errors`,
    );
    await tierPage.close();
  }

  // =====================================================================
  // 3. Pointer lock refused -> drag-look fallback
  // =====================================================================
  // Simulates browsers/extensions that silently refuse pointer lock — the
  // exact "I click play and nothing happens" failure. The game must fall
  // back to drag-look and still be fully playable.
  const fallbackPage = await openPage("drag", pageUrl(303), undefined, () => {
    Element.prototype.requestPointerLock = () => Promise.reject(new Error("blocked by test"));
  });
  await waitForWorld(fallbackPage, 25);
  await fallbackPage.click("#play-button");
  await sleep(1200); // watchdog is 600ms
  const fallback = await fallbackPage.evaluate(() => ({
    mode: window.__mc.mode(),
    overlayHidden: document.querySelector("#overlay")?.classList.contains("hidden") ?? false,
  }));
  report(
    "pointer lock blocked -> drag-look fallback engages",
    fallback.mode === "drag" && fallback.overlayHidden,
    `mode=${fallback.mode}, overlay hidden=${String(fallback.overlayHidden)}`,
  );

  if (fallback.mode === "drag") {
    const dist = await walk(fallbackPage);
    report("movement works in drag-look mode", dist > 1, `moved ${dist.toFixed(1)} blocks`);

    // Drag with the left button must rotate the camera.
    const pitchBefore = await fallbackPage.evaluate(() => window.__mc.pitch());
    await fallbackPage.mouse.move(640, 360);
    await fallbackPage.mouse.down({ button: "left" });
    await fallbackPage.mouse.move(640, 500, { steps: 5 });
    await fallbackPage.mouse.up({ button: "left" });
    await sleep(400);
    const pitchAfter = await fallbackPage.evaluate(() => window.__mc.pitch());
    report(
      "left-drag looks around in fallback mode",
      Math.abs(pitchAfter - pitchBefore) > 0.05,
      `pitch ${pitchBefore.toFixed(2)} -> ${pitchAfter.toFixed(2)}`,
    );

    // A quick tap (no drag) must break the block under the crosshair.
    // Steepen the view with a real drag first (synthetic mousemoves are
    // ignored in drag mode unless the button is down — by design).
    await fallbackPage.mouse.move(640, 300);
    await fallbackPage.mouse.down({ button: "left" });
    await fallbackPage.mouse.move(640, 700, { steps: 8 });
    await fallbackPage.mouse.up({ button: "left" });
    await sleep(400);
    const tapTarget = await fallbackPage.evaluate(() => window.__mc.target());
    if (tapTarget) {
      await fallbackPage.mouse.move(640, 360);
      await fallbackPage.mouse.down({ button: "left" });
      await fallbackPage.mouse.up({ button: "left" });
      await sleep(500);
      const afterTap = await fallbackPage.evaluate(
        (t) => window.__mc.blockAt(t.x, t.y, t.z),
        tapTarget,
      );
      report("tap breaks a block in fallback mode", afterTap === 0, `block is now id ${afterTap}`);
    } else {
      report("tap breaks a block in fallback mode", false, "no target under crosshair");
    }
    await fallbackPage.screenshot({ path: path.join(OUT_DIR, "07-fallback-mode.png") });
  }
  await fallbackPage.close();

  // =====================================================================
  // 4. No WebGL at all -> CPU raycaster
  // =====================================================================
  // Simulates machines where WebGL is unavailable entirely — a real player
  // hit exactly this. The game must boot into the CPU raycaster and be
  // fully playable: render, move, break.
  const cpuPage = await openPage("cpu", pageUrl(404), undefined, () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patched(type, ...rest) {
      if (String(type).startsWith("webgl")) return null;
      return original.call(this, type, ...rest);
    };
  });
  await waitForWorld(cpuPage, 25, "loadedChunks");
  const cpuMode = await cpuPage.evaluate(() => window.__mc.renderer());
  report("no WebGL at all -> CPU raycaster engages", cpuMode === "cpu", `renderer=${cpuMode}`);

  if (cpuMode === "cpu") {
    await sleep(1500); // a few frames of rendering
    await cpuPage.evaluate(() => document.querySelector("#overlay")?.classList.add("hidden"));
    await sleep(800);
    await cpuPage.screenshot({ path: path.join(OUT_DIR, "08-cpu-renderer.png") });
    const cpuVariety = await colorVariety(cpuPage);
    await cpuPage.evaluate(() => document.querySelector("#overlay")?.classList.remove("hidden"));
    report(
      "CPU render shows real variety (terrain, not a blank frame)",
      cpuVariety > 12,
      `${cpuVariety} distinct quantized colors sampled`,
    );

    await cpuPage.click("#play-button");
    await sleep(1000);
    const cpuDist = await walk(cpuPage);
    report("movement works on the CPU renderer", cpuDist > 1, `moved ${cpuDist.toFixed(1)} blocks`);

    await cpuPage.evaluate(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { movementX: 0, movementY: 2000 }));
    });
    await sleep(500);
    const cpuTarget = await cpuPage.evaluate(() => window.__mc.target());
    if (cpuTarget) {
      await cpuPage.mouse.down({ button: "left" });
      await cpuPage.mouse.up({ button: "left" });
      await sleep(500);
      const afterCpuBreak = await cpuPage.evaluate(
        (t) => window.__mc.blockAt(t.x, t.y, t.z),
        cpuTarget,
      );
      report(
        "breaking works on the CPU renderer",
        afterCpuBreak === 0,
        `block is now id ${afterCpuBreak}`,
      );
    } else {
      report("breaking works on the CPU renderer", false, "no target under crosshair");
    }
    await cpuPage.screenshot({ path: path.join(OUT_DIR, "09-cpu-playing.png") });
  }
  await cpuPage.close();

  // =====================================================================
  // 5. Phone: touchscreen only
  // =====================================================================
  // Proves the game detects a touch device, shows on-screen controls, and
  // is fully playable with thumb + drag + tap — no keyboard, no mouse.
  const mobilePage = await openPage("mobile", `${BASE_URL}?seed=505&view=4&lang=en`, {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const touch = (type, x, y, id = 1) =>
    mobilePage.evaluate(
      (a) => {
        const target = document.elementFromPoint(a.x, a.y) ?? document.body;
        target.dispatchEvent(
          new PointerEvent(a.type, {
            pointerId: a.id,
            pointerType: "touch",
            clientX: a.x,
            clientY: a.y,
            bubbles: true,
            cancelable: true,
            isPrimary: true,
          }),
        );
      },
      { type, x, y, id },
    );
  /** A finger pressed on one of the on-screen buttons, found by class. */
  const press = (selector, type = "pointerdown") =>
    mobilePage.evaluate(
      (a) => {
        document.querySelector(a.selector)?.dispatchEvent(
          new PointerEvent(a.type, {
            pointerId: 9,
            pointerType: "touch",
            bubbles: true,
            cancelable: true,
            isPrimary: true,
          }),
        );
      },
      { selector, type },
    );

  await waitForWorld(mobilePage, 9);
  const phone = await mobilePage.evaluate(() => ({
    touch: window.__mc.touch(),
    quality: window.__mc.settings().quality,
    autoJump: window.__mc.settings().autoJump,
  }));
  report(
    "touch device is detected and gets phone-sized defaults",
    phone.touch === true && phone.quality !== "ultra" && phone.autoJump === true,
    JSON.stringify(phone),
  );
  await mobilePage.screenshot({ path: path.join(OUT_DIR, "10-mobile-menu.png") });

  await mobilePage.click("#play-button");
  await mobilePage
    .waitForFunction(() => window.__mc.mode() !== "idle", { timeout: 5_000, polling: 100 })
    .catch(() => undefined);
  const active = await mobilePage.evaluate(() => window.__mc.mode());
  report("tapping play starts the game (drag mode) on touch", active === "drag", `mode=${active}`);

  await until(mobilePage, () => {
    const buttons = document.querySelector(".touch-buttons");
    return buttons !== null && getComputedStyle(buttons).display !== "none";
  });
  const controlsShown = await mobilePage.evaluate(() => {
    const shown = (selector) => {
      const el = document.querySelector(selector);
      return el ? getComputedStyle(el).display !== "none" : false;
    };
    return {
      actions: shown(".touch-buttons"),
      top: shown(".touch-top"),
      jump: shown(".touch-jump"),
      place: shown(".touch-place"),
      pause: shown(".touch-pause"),
    };
  });
  report(
    "on-screen jump, place, inventory and pause buttons are shown",
    Object.values(controlsShown).every(Boolean),
    JSON.stringify(controlsShown),
  );

  // Joystick: press bottom-left, push up (forward), hold, release.
  const beforeMove = await mobilePage.evaluate(() => window.__mc.position());
  await touch("pointerdown", 110, 560, 1);
  await touch("pointermove", 110, 500, 1);
  await touch("pointermove", 110, 485, 1);
  await until(
    mobilePage,
    (start) => {
      const p = window.__mc.position();
      return Math.hypot(p.x - start.x, p.z - start.z) > 1.5;
    },
    beforeMove,
  );
  await touch("pointerup", 110, 485, 1);
  const afterMove = await mobilePage.evaluate(() => window.__mc.position());
  const moved = Math.hypot(afterMove.x - beforeMove.x, afterMove.z - beforeMove.z);
  report("the joystick moves the player", moved > 1, `moved ${moved.toFixed(1)} blocks`);

  // Look straight down with a long right-side drag (the pitch clamps), so
  // the crosshair lands on whatever the player is standing on, then tap.
  for (let step = 0; step < 9; step++) {
    await touch(step === 0 ? "pointerdown" : "pointermove", 300, 120 + step * 60, 2);
  }
  await touch("pointerup", 300, 600, 2);
  await until(mobilePage, () => window.__mc.target() !== null, undefined, 8_000);
  const mobileTarget = await mobilePage.evaluate(() => window.__mc.target());
  if (mobileTarget) {
    // A genuine quick tap: down and up in one round trip, so the in-page
    // elapsed time stays inside the tap window (separate evaluate calls can
    // drift past it and be correctly treated as a drag, not a tap).
    await mobilePage.evaluate(
      (a) => {
        const target = document.elementFromPoint(a.x, a.y) ?? document.body;
        const opts = {
          pointerType: "touch",
          pointerId: a.id,
          clientX: a.x,
          clientY: a.y,
          bubbles: true,
          cancelable: true,
          isPrimary: true,
        };
        target.dispatchEvent(new PointerEvent("pointerdown", opts));
        target.dispatchEvent(new PointerEvent("pointerup", opts));
      },
      { x: 300, y: 300, id: 3 },
    );
    await sleep(400);
    const afterTap = await mobilePage.evaluate(
      (t) => window.__mc.blockAt(t.x, t.y, t.z),
      mobileTarget,
    );
    report("tap breaks the targeted block on touch", afterTap === 0, `block is now id ${afterTap}`);
  } else {
    report("tap breaks the targeted block on touch", false, "no target under crosshair");
  }
  await mobilePage.screenshot({ path: path.join(OUT_DIR, "11-mobile-playing.png") });

  await press(".touch-fly");
  await sleep(200);
  const mobileFlying = await mobilePage.evaluate(() => window.__mc.flying());
  report("the fly button toggles flight on touch", mobileFlying === true);

  await press(".touch-inventory");
  await sleep(300);
  const mobileInventory = await mobilePage.evaluate(() => window.__mc.inventoryOpen());
  report("the inventory button opens the block panel on touch", mobileInventory === true);
  await mobilePage.screenshot({ path: path.join(OUT_DIR, "12-mobile-inventory.png") });
  await mobilePage.click('.inventory-cell[data-block="18"]'); // a lantern
  await sleep(300);

  await press(".touch-pause");
  await sleep(300);
  const mobilePaused = await mobilePage.evaluate(() => ({
    mode: window.__mc.mode(),
    hotbar: window.__mc.hotbar(),
  }));
  report(
    "the pause button returns to the menu on touch",
    mobilePaused.mode === "idle" && mobilePaused.hotbar.includes(18),
    `mode=${mobilePaused.mode}`,
  );
  await mobilePage.close();

  // =====================================================================
  // 6. Installed build: boots with the network gone
  // =====================================================================
  const offlinePage = await openPage("offline", pageUrl(606));
  await waitForWorld(offlinePage, 5);
  const controlled = await offlinePage
    .evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      await navigator.serviceWorker.ready;
      // The first load isn't controlled until the worker claims the page.
      for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return navigator.serviceWorker.controller !== null;
    })
    .catch(() => false);
  report("the service worker installs and takes control", controlled === true);
  if (controlled) {
    await offlinePage.setOfflineMode(true);
    await offlinePage.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    const offlineOk = await waitForWorld(offlinePage, 5)
      .then(() => true)
      .catch(() => false);
    report("the game boots and builds the world with no network", offlineOk);
    await offlinePage.setOfflineMode(false);
  }
  await offlinePage.close();

  // =====================================================================
  // 7. Adventure mode: dig for blocks, craft, keep a journal
  // =====================================================================
  const adventure = await openPage("adventure", `${pageUrl(707)}&mode=adventure`);
  await waitForWorld(adventure, 25);
  await adventure.click("#play-button");
  await sleep(800);
  const startMode = await adventure.evaluate(() => ({
    mode: window.__mc.gameMode(),
    bag: window.__mc.bag(),
    counts: document.querySelectorAll(".hotbar-count").length,
  }));
  report(
    "Adventure starts with an empty bag and counted hotbar slots",
    startMode.mode === "adventure" &&
      Object.keys(startMode.bag).length === 0 &&
      startMode.counts === 9,
    JSON.stringify(startMode),
  );

  // Digging takes time: hold the button on the ground until it gives way.
  await adventure.evaluate(() => {
    document.dispatchEvent(new MouseEvent("mousemove", { movementX: 0, movementY: 2000 }));
  });
  await sleep(500);
  const ground = await adventure.evaluate(() => {
    const p = window.__mc.position();
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    return { x, y: Math.floor(p.y) - 1, z, id: window.__mc.blockAt(x, Math.floor(p.y) - 1, z) };
  });
  await adventure.mouse.down({ button: "left" });
  await sleep(150);
  const partWay = await adventure.evaluate((g) => window.__mc.blockAt(g.x, g.y, g.z), ground);
  const dug = await until(adventure, (g) => window.__mc.blockAt(g.x, g.y, g.z) === 0, ground);
  await adventure.mouse.up({ button: "left" });
  const afterDig = await adventure.evaluate(() => window.__mc.bag());
  const gathered = Object.values(afterDig).reduce((a, b) => a + b, 0);
  report(
    "holding the button digs through the ground, and the blocks land in the bag",
    partWay === ground.id && dug && gathered >= 1,
    `ground id ${ground.id} still there at first: ${partWay === ground.id}, bag ${JSON.stringify(afterDig)}`,
  );

  // Flight is a Creative thing.
  await adventure.keyboard.press("Space");
  await sleep(60);
  await adventure.keyboard.press("Space");
  await sleep(300);
  const tookFlight = await adventure.evaluate(() => window.__mc.flying());
  report("double-tapping jump does not take off in Adventure", tookFlight === false);

  // Crafting: two logs in the bag, one becomes four planks.
  await adventure.evaluate(() => window.__mc.give(6, 2));
  await adventure.keyboard.press("KeyE");
  await sleep(400);
  await adventure.click('.tab[data-tab="craft"]');
  await sleep(200);
  await adventure.screenshot({ path: path.join(OUT_DIR, "13-crafting.png") });
  const disabledBefore = await adventure.evaluate(
    () => document.querySelector('.recipe[data-recipe="lantern"]')?.disabled ?? null,
  );
  await adventure.click('.recipe[data-recipe="planks-oak"]');
  await sleep(300);
  const afterCraft = await adventure.evaluate(() => window.__mc.bag());
  report(
    "a recipe turns one log into four planks, and unaffordable recipes are disabled",
    afterCraft["6"] === 1 && afterCraft["14"] === 4 && disabledBefore === true,
    JSON.stringify(afterCraft),
  );

  await adventure.click('.tab[data-tab="journal"]');
  await sleep(200);
  await adventure.screenshot({ path: path.join(OUT_DIR, "14-journal.png") });
  const found = await adventure.evaluate(() => ({
    list: window.__mc.discoveries(),
    shown: document.querySelectorAll(".journal-entry.found").length,
  }));
  report(
    "the journal records the first dig and the first craft",
    found.list.includes("first-dig") && found.list.includes("craft") && found.shown >= 2,
    JSON.stringify(found.list),
  );

  await adventure.keyboard.press("KeyE");
  await sleep(300);
  await adventure.evaluate(() => document.exitPointerLock());
  await sleep(400);
  await adventure.reload({ waitUntil: "domcontentloaded" });
  await waitForWorld(adventure, 9);
  const kept = await adventure.evaluate(() => ({
    bag: window.__mc.bag(),
    found: window.__mc.discoveries().length,
  }));
  report(
    "the bag and the journal survive a reload",
    kept.bag["14"] === 4 && kept.found >= 2,
    JSON.stringify(kept),
  );
  await adventure.close();

  // ---- console stayed clean ----
  const realErrors = consoleErrors.filter((e) => !e.includes("favicon"));
  report("no console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await browser.close();
}

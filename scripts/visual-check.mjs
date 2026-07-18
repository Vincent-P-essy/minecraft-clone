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
    await new Promise((r) => setTimeout(r, 600));
  };

  if (locked) {
    // ---- placing, against a flat neighboring column the test picks itself ----
    // Aiming at the top face of an adjacent column's surface block makes the
    // place cell sit outside the player's own body (placing into yourself is
    // correctly rejected). The neighbor is chosen by inspecting the world,
    // so the test doesn't depend on which way the terrain slopes.
    const neighbor = await page.evaluate(() => {
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
        if (surface !== 0 && surface !== 5 && above === 0) {
          return { ...c, x: bx + c.dx, y: by - 1, z: bz + c.dz };
        }
      }
      return null;
    });
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
      const aimedRight =
        placeTarget !== null && placeTarget.x === neighbor.x && placeTarget.z === neighbor.z;
      await page.mouse.down({ button: "right" });
      await page.mouse.up({ button: "right" });
      await new Promise((r) => setTimeout(r, 700));
      const placed = await page.evaluate((n) => window.__mc.blockAt(n.x, n.y + 1, n.z), neighbor);
      report(
        "right click places the selected block on the neighbor's top face",
        placed === 1, // grass, the default hotbar selection
        `aimed ${JSON.stringify(placeTarget)} (expected column ${String(neighbor.x)},${String(neighbor.z)}: ${String(aimedRight)}), cell above is now id ${placed}`,
      );
      // Undo the yaw so later steps face -Z again.
      await look(page, neighbor.yaw / 0.0022, 709);
    }

    // ---- breaking, straight down at the block under the player's feet ----
    await look(page, 0, 2000); // clamps to max pitch: straight down
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
    }

    // Level the view before the movement test.
    await look(page, 0, 709);

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

  // ---- pointer-lock-blocked fallback (a fresh page, lock sabotaged) ----
  // Simulates browsers/extensions that silently refuse pointer lock — the
  // exact "I click play and nothing happens" failure. The game must fall
  // back to drag-look and still be fully playable.
  const fallbackPage = await browser.newPage();
  await fallbackPage.setViewport({ width: 1280, height: 720 });
  await fallbackPage.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = () => Promise.reject(new Error("blocked by test"));
  });
  await fallbackPage.goto(URL_UNDER_TEST, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await fallbackPage.waitForFunction(() => window.__mc && window.__mc.meshedChunks() >= 25, {
    timeout: 120_000,
    polling: 500,
  });
  await fallbackPage.click("#play-button");
  await new Promise((r) => setTimeout(r, 1200)); // watchdog is 600ms
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
    const before = await fallbackPage.evaluate(() => window.__mc.position());
    await fallbackPage.keyboard.down("KeyW");
    await new Promise((r) => setTimeout(r, 2000));
    await fallbackPage.keyboard.up("KeyW");
    const after = await fallbackPage.evaluate(() => window.__mc.position());
    const dist = Math.hypot(after.x - before.x, after.z - before.z);
    report("movement works in drag-look mode", dist > 1, `moved ${dist.toFixed(1)} blocks`);

    // Drag with the left button must rotate the camera.
    const pitchBefore = await fallbackPage.evaluate(() => window.__mc.pitch());
    await fallbackPage.mouse.move(640, 360);
    await fallbackPage.mouse.down({ button: "left" });
    await fallbackPage.mouse.move(640, 500, { steps: 5 });
    await fallbackPage.mouse.up({ button: "left" });
    await new Promise((r) => setTimeout(r, 400));
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
    await new Promise((r) => setTimeout(r, 400));
    const tapTarget = await fallbackPage.evaluate(() => window.__mc.target());
    if (tapTarget) {
      await fallbackPage.mouse.move(640, 360);
      await fallbackPage.mouse.down({ button: "left" });
      await fallbackPage.mouse.up({ button: "left" });
      await new Promise((r) => setTimeout(r, 500));
      const afterTap = await fallbackPage.evaluate(
        (t) => window.__mc.blockAt(t.x, t.y, t.z),
        tapTarget,
      );
      report("tap breaks a block in fallback mode", afterTap === 0, `block is now id ${afterTap}`);
    }
    await fallbackPage.screenshot({ path: path.join(OUT_DIR, "04-fallback-mode.png") });
  }
  await fallbackPage.close();

  // ---- zero-WebGL fallback (a fresh page, getContext('webgl*') sabotaged) ----
  // Simulates machines where WebGL is unavailable entirely — a real player
  // hit exactly this. The game must boot into the CPU raycaster and be
  // fully playable: render, move, break.
  const cpuPage = await browser.newPage();
  await cpuPage.setViewport({ width: 1280, height: 720 });
  await cpuPage.evaluateOnNewDocument(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patched(type, ...rest) {
      if (String(type).startsWith("webgl")) return null;
      return original.call(this, type, ...rest);
    };
  });
  await cpuPage.goto(URL_UNDER_TEST, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await cpuPage.waitForFunction(() => window.__mc && window.__mc.loadedChunks() >= 25, {
    timeout: 120_000,
    polling: 500,
  });
  const cpuMode = await cpuPage.evaluate(() => window.__mc.renderer());
  report("no WebGL at all -> CPU raycaster engages", cpuMode === "cpu", `renderer=${cpuMode}`);

  if (cpuMode === "cpu") {
    await new Promise((r) => setTimeout(r, 1500)); // a few frames of rendering
    await cpuPage.evaluate(() => document.querySelector("#overlay")?.classList.add("hidden"));
    await new Promise((r) => setTimeout(r, 800));
    await cpuPage.screenshot({ path: path.join(OUT_DIR, "05-cpu-renderer.png") });
    await cpuPage.evaluate(() => document.querySelector("#overlay")?.classList.remove("hidden"));

    // The CPU render must show real variety, same bar as the WebGL check.
    const cpuShot = await cpuPage.screenshot({ encoding: "base64" });
    const cpuPixels = await cpuPage.evaluate(async (b64) => {
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
    }, cpuShot);
    report(
      "CPU render shows real variety (terrain, not a blank frame)",
      cpuPixels.distinctColors > 12,
      `${cpuPixels.distinctColors} distinct quantized colors sampled`,
    );

    await cpuPage.click("#play-button");
    await new Promise((r) => setTimeout(r, 1000));
    const cpuBefore = await cpuPage.evaluate(() => window.__mc.position());
    await cpuPage.keyboard.down("KeyW");
    await new Promise((r) => setTimeout(r, 2000));
    await cpuPage.keyboard.up("KeyW");
    const cpuAfter = await cpuPage.evaluate(() => window.__mc.position());
    const cpuDist = Math.hypot(cpuAfter.x - cpuBefore.x, cpuAfter.z - cpuBefore.z);
    report("movement works on the CPU renderer", cpuDist > 1, `moved ${cpuDist.toFixed(1)} blocks`);

    await cpuPage.evaluate(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { movementX: 0, movementY: 2000 }));
    });
    await new Promise((r) => setTimeout(r, 500));
    const cpuTarget = await cpuPage.evaluate(() => window.__mc.target());
    if (cpuTarget) {
      await cpuPage.mouse.down({ button: "left" });
      await cpuPage.mouse.up({ button: "left" });
      await new Promise((r) => setTimeout(r, 500));
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
    await cpuPage.screenshot({ path: path.join(OUT_DIR, "06-cpu-playing.png") });
  }
  await cpuPage.close();

  // ---- console stayed clean ----
  const realErrors = consoleErrors.filter((e) => !e.includes("favicon"));
  report("no console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await browser.close();
}

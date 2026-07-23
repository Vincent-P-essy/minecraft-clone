/**
 * Captures the README screenshots from the real running game in headless
 * Chromium (SwiftShader). Hides the menu overlay and the fps line (software
 * rendering fps would be misleading) but keeps the crosshair and hotbar.
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/screenshot.mjs [--url http://localhost:4173/] [--out docs/screenshot.png]
 *   node scripts/screenshot.mjs --cpu --out docs/screenshot-cpu.png       # zero-WebGL mode
 *   node scripts/screenshot.mjs --mobile --out docs/screenshot-mobile.png # touch controls
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
const CPU_MODE = args.includes("--cpu");
const MOBILE_MODE = args.includes("--mobile");
const OUT = argValue(
  "--out",
  MOBILE_MODE
    ? "docs/screenshot-mobile.png"
    : CPU_MODE
      ? "docs/screenshot-cpu.png"
      : "docs/screenshot.png",
);
mkdirSync(path.dirname(OUT), { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--window-size=1600,900"],
});

try {
  const page = await browser.newPage();
  if (MOBILE_MODE) {
    await page.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
  } else {
    await page.setViewport({ width: 1600, height: 900 });
  }
  if (CPU_MODE) {
    // Same sabotage the visual-check harness uses: no WebGL context at all,
    // so the game boots into its CPU raycaster.
    await page.evaluateOnNewDocument(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function patched(type, ...rest) {
        if (String(type).startsWith("webgl")) return null;
        return original.call(this, type, ...rest);
      };
    });
  }
  await page.goto(URL_UNDER_TEST, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Wait for a substantial world before framing the shot.
  await page.waitForFunction(
    (cpu) =>
      window.__mc && (cpu ? window.__mc.loadedChunks() >= 40 : window.__mc.meshedChunks() >= 100),
    { timeout: 180_000, polling: 500 },
    CPU_MODE || MOBILE_MODE,
  );

  if (MOBILE_MODE) {
    // Start the game so the on-screen controls appear, look down a touch,
    // and pop the joystick into view for the shot.
    await page.click("#play-button");
    await page
      .waitForFunction(() => window.__mc.mode() !== "idle", { timeout: 5_000 })
      .catch(() => undefined);
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { movementX: 0, movementY: 260 }));
      const target = document.querySelector("canvas");
      target?.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerId: 9,
          pointerType: "touch",
          clientX: 100,
          clientY: 600,
          bubbles: true,
        }),
      );
      target?.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 9,
          pointerType: "touch",
          clientX: 118,
          clientY: 560,
          bubbles: true,
        }),
      );
    });
  }

  await page.evaluate(() => {
    document.querySelector("#overlay")?.classList.add("hidden");
    const fps = document.querySelector("#fps");
    if (fps) fps.style.display = "none";
  });
  await new Promise((r) => setTimeout(r, 2500));

  await page.screenshot({ path: OUT });
  console.log(`saved ${OUT}`);
} finally {
  await browser.close();
}

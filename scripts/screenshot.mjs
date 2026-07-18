/**
 * Captures the README screenshots from the real running game in headless
 * Chromium (SwiftShader). Hides the menu overlay and the fps line (software
 * rendering fps would be misleading) but keeps the crosshair and hotbar.
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/screenshot.mjs [--url http://localhost:4173/] [--out docs/screenshot.png]
 *   node scripts/screenshot.mjs --cpu --out docs/screenshot-cpu.png   # zero-WebGL mode
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
const OUT = argValue("--out", CPU_MODE ? "docs/screenshot-cpu.png" : "docs/screenshot.png");
mkdirSync(path.dirname(OUT), { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--window-size=1600,900"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
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
      window.__mc && (cpu ? window.__mc.loadedChunks() >= 60 : window.__mc.meshedChunks() >= 100),
    { timeout: 180_000, polling: 500 },
    CPU_MODE,
  );

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

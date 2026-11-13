/**
 * Renders every icon the game ships from the one source drawing
 * (public/favicon.svg): the PWA icons, the Android launcher icons (legacy,
 * round and adaptive, at every density) and the Play Store graphics.
 *
 *   node scripts/generate-icons.mjs
 *
 * Set PUPPETEER_EXECUTABLE_PATH to use an already-installed Chromium.
 */

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const root = path.resolve(import.meta.dirname, "..");
const svg = readFileSync(path.join(root, "public/favicon.svg"), "utf8");
/** The drawing without its rounded backdrop, for icons that bring their own. */
const art = svg.replace('rx="112" fill="url(#sky)"', 'rx="0" fill="none"');
const BACKDROP = "radial-gradient(circle at 50% 40%, #243a63, #090e18)";

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });

async function render(file, width, height, body, transparent = true) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.setContent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">${body}</body></html>`,
  );
  mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, omitBackground: transparent });
  await page.close();
  console.log(`wrote ${path.relative(root, file)}`);
}

const box = (size, inner, extra = "") =>
  `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;${extra}">${inner}</div>`;
const scaled = (size, drawing) => `<div style="width:${size}px;height:${size}px">${drawing}</div>`;

try {
  // ---- web ----
  const icons = path.join(root, "public/icons");
  await render(path.join(icons, "icon-192.png"), 192, 192, scaled(192, svg));
  await render(path.join(icons, "icon-512.png"), 512, 512, scaled(512, svg));
  // Maskable: launchers crop to a circle or squircle, so the backdrop runs
  // edge to edge and the art stays inside the safe zone.
  await render(
    path.join(icons, "icon-maskable-512.png"),
    512,
    512,
    box(512, scaled(400, art), `background:${BACKDROP}`),
    false,
  );

  // ---- Android launcher ----
  const res = path.join(root, "mobile/android/app/src/main/res");
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [name, scale] of Object.entries(densities)) {
    const dir = path.join(res, `mipmap-${name}`);
    const legacy = Math.round(48 * scale);
    const adaptive = Math.round(108 * scale);
    await render(path.join(dir, "ic_launcher.png"), legacy, legacy, scaled(legacy, svg));
    await render(
      path.join(dir, "ic_launcher_round.png"),
      legacy,
      legacy,
      box(legacy, scaled(legacy * 0.8, art), `background:${BACKDROP};border-radius:50%`),
    );
    // Adaptive foreground: 108dp canvas, the art within the central 66dp.
    await render(
      path.join(dir, "ic_launcher_foreground.png"),
      adaptive,
      adaptive,
      box(adaptive, scaled(adaptive * 0.62, art)),
    );
  }

  // ---- Play Store listing ----
  const store = path.join(root, "store/play");
  await render(
    path.join(store, "icon-512.png"),
    512,
    512,
    box(512, scaled(420, art), `background:${BACKDROP}`),
    false,
  );
  await render(
    path.join(store, "feature-graphic-1024x500.png"),
    1024,
    500,
    `<div style="width:1024px;height:500px;display:flex;align-items:center;gap:30px;padding:0 56px;box-sizing:border-box;
        background:radial-gradient(ellipse at 28% 45%, #2b4476 0%, #0b1220 62%, #05080d 100%);
        font-family:'Segoe UI',system-ui,Arial,sans-serif;color:#f4f7fb">
       <div style="width:270px;height:270px;flex:none">${art}</div>
       <div>
         <div style="font-size:86px;font-weight:800;letter-spacing:2px;line-height:1;
              background:linear-gradient(180deg,#fff3cf 10%,#ffc45a 55%,#ff8f4a 100%);
              -webkit-background-clip:text;color:transparent">Lumenwild</div>
         <div style="font-size:27px;margin-top:20px;opacity:.85">Explore. Dig. Build. Light up the night.</div>
       </div>
     </div>`,
    false,
  );
} finally {
  await browser.close();
}

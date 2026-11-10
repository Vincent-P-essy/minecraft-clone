import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/** Every file under `dir`, as paths relative to it. */
function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

/** Emits `sw.js`: a service worker that precaches the whole build, so the
 * installed game starts — and plays — with no network at all. The cache
 * name carries a hash of the file list, so a new build replaces the old
 * cache instead of mixing with it. Kept in-repo (thirty lines) rather
 * than pulling in a PWA toolkit. */
function offlineServiceWorker(): Plugin {
  return {
    name: "offline-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = [
        ...Object.keys(bundle).filter((name) => !name.endsWith(".map")),
        ...listFiles(path.resolve(import.meta.dirname, "public")),
      ]
        .filter((name) => name !== "sw.js")
        .sort();
      const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      const source = `// Generated at build time — see vite.config.ts.
const CACHE = "game-${version}";
const FILES = ${JSON.stringify(["./", ...files.filter((f) => f !== "index.html")])};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  // Pages: network first so a new release shows up, cache when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("./", copy));
          return response;
        })
        .catch(() => caches.match("./")),
    );
    return;
  }
  // Everything else is content-hashed or static: cache first.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)),
  );
});
`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

// Three ways the same build is hosted:
//  - GitHub Pages serves it from /minecraft-clone/ (a project page);
//  - the desktop and mobile shells load it from disk, so every URL must be
//    relative (BUILD_TARGET=native);
//  - anything else serves it from the root.
const base = process.env.GITHUB_PAGES
  ? "/minecraft-clone/"
  : process.env.BUILD_TARGET === "native"
    ? "./"
    : "/";

export default defineConfig({
  base,
  plugins: [offlineServiceWorker()],
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

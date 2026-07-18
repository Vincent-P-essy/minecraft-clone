import { defineConfig } from "vitest/config";

// Served from https://vincent-p-essy.github.io/minecraft-clone/ (a project
// page, not a user page), so every asset URL needs this prefix in production.
export default defineConfig({
  base: process.env.GITHUB_PAGES ? "/minecraft-clone/" : "/",
  worker: {
    format: "es",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

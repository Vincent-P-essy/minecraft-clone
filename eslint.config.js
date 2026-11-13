// @ts-check
import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default defineConfig(
  {
    ignores: [
      "dist/**",
      "desktop/node_modules/**",
      "desktop/release/**",
      "mobile/node_modules/**",
      "mobile/android/**",
      "store/**",
      "mobile/ios/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Plain-JS browser-automation harnesses, outside the TS project graph.
    // They run under Node but embed page.evaluate callbacks that execute in
    // the browser, so both worlds' globals are in scope.
    files: ["scripts/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        window: "readonly",
        document: "readonly",
        Element: "readonly",
        HTMLCanvasElement: "readonly",
        MouseEvent: "readonly",
        PointerEvent: "readonly",
        getComputedStyle: "readonly",
        Image: "readonly",
        Event: "readonly",
        navigator: "readonly",
      },
    },
  },
  {
    // The Electron main/preload scripts: CommonJS, Node globals.
    files: ["desktop/**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        Response: "readonly",
        Headers: "readonly",
        decodeURIComponent: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  prettier,
);

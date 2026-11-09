import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests run in plain Node (no DOM, no WebGL). "obsidian" is aliased to a tiny runtime stub because the
// npm package ships types only. Renderer smoke tests that need a GPU live in tests/smoke/ and run in a browser.
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  define: {
    // The worker bundle is inlined by the real build; tests get an empty stand-in.
    __CORTEX_WORKER_SOURCE__: JSON.stringify(""),
    __CORTEX_VERSION__: JSON.stringify("0.1.0-test"),
    __CORTEX_BUILD__: JSON.stringify("test"),
  },
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/stubs/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 20000,
    pool: "forks",
  },
});

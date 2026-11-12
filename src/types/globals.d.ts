/** Build-time constants injected by esbuild `define` (scripts/build.mjs) and vitest.config.ts. */
declare const __CORTEX_WORKER_SOURCE__: string;
declare const __CORTEX_VERSION__: string;
/** true in the built main.js: the lazy chunk is embedded, deflated and base64-encoded, as `__CORTEX_LAZY_SOURCE__`; undefined from source. */
declare const __CORTEX_LAZY_BUNDLED__: boolean | undefined;
declare const __CORTEX_LAZY_SOURCE__: string;
/** Build id shared by main.js and cortex-runner.js of one build (the runner restarts on a mismatch). */
declare const __CORTEX_BUILD__: string;

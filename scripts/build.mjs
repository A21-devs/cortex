// Build Cortex: worker (IIFE string) → main.js (CJS, worker inlined) + cortex-runner.js (Node CJS) + styles.css.
// Usage: node scripts/build.mjs [--watch] [--dev]
// Outputs to dist/: main.js, cortex-runner.js, styles.css, manifest.json, THIRD-PARTY-NOTICES.txt, meta.json.
// Options come from scripts/build-config.mjs so tests build with exactly the same settings.
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { BUDGET, buildId, cssOptions, lazyOptions, mainOptions, noticesText, runnerOptions, workerOptions } from "./build-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const args = new Set(process.argv.slice(2));
const watchMode = args.has("--watch");
const dev = args.has("--dev") || watchMode;
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

async function buildAll() {
  const t0 = Date.now();
  const build = buildId(pkg.version);
  await mkdir(dist, { recursive: true });
  const w = await esbuild.build(workerOptions(root, { dev }));
  const workerCode = w.outputFiles?.[0]?.text;
  if (!workerCode) throw new Error("worker build produced no output");
  const lazy = await esbuild.build(lazyOptions(root, { dev, workerCode, version: pkg.version, build }));
  const lazyCode = lazy.outputFiles?.[0]?.text;
  if (!lazyCode) throw new Error("lazy chunk build produced no output");
  const [main, runner] = await Promise.all([
    esbuild.build(mainOptions(root, { dev, lazyCode, version: pkg.version, build })),
    esbuild.build(runnerOptions(root, { dev, version: pkg.version, build })),
    esbuild.build(cssOptions(root, { dev })),
  ]);
  await copyFile(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
  await writeFile(path.join(dist, "THIRD-PARTY-NOTICES.txt"), noticesText(pkg.version));
  await writeFile(path.join(dist, "meta.json"), JSON.stringify({ build, main: main.metafile, lazy: lazy.metafile, runner: runner.metafile, worker: w.metafile }));
  const sizes = {
    main: (await stat(path.join(dist, "main.js"))).size,
    runner: (await stat(path.join(dist, "cortex-runner.js"))).size,
    worker: Buffer.byteLength(workerCode),
    lazy: Buffer.byteLength(lazyCode),
    css: (await stat(path.join(dist, "styles.css"))).size,
  };
  const warn = [];
  if (sizes.main > BUDGET.mainBytes) warn.push(`main.js ${sizes.main} > ${BUDGET.mainBytes}`);
  if (sizes.runner > BUDGET.runnerBytes) warn.push(`cortex-runner.js ${sizes.runner} > ${BUDGET.runnerBytes}`);
  if (sizes.worker > BUDGET.workerBytes) warn.push(`worker ${sizes.worker} > ${BUDGET.workerBytes}`);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`built ${build} in ${Date.now() - t0} ms — main.js ${kb(sizes.main)} (lazy chunk ${kb(sizes.lazy)} + worker ${kb(sizes.worker)} inlined) · cortex-runner.js ${kb(sizes.runner)} · styles.css ${kb(sizes.css)}${dev ? " [dev]" : ""}`);
  for (const x of warn) console.warn(`size budget exceeded: ${x}`);
}

await buildAll();

if (watchMode) {
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => buildAll().catch((e) => console.error(e.message)), 150);
  };
  watch(path.join(root, "src"), { recursive: true }, rebuild);
  watch(path.join(root, "styles.css"), rebuild);
  console.log("watching src/ …");
}

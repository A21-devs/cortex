// Build Cortex Desktop into dist-desktop/ (the Obsidian plugin's dist/ is not touched):
//   main.js            Electron main process (src/desktop/main.ts)
//   renderer.js        the plugin code on the "obsidian" shim (src/desktop/renderer.ts), layout worker inlined
//   cortex-runner.js   the runner, built with the same build id as renderer.js (the client checks it)
//   styles.css         Cortex's stylesheet (same build as the plugin's) + desktop.css + index.html
//   package.json       { productName: "Cortex", main: "main.js" } so Electron names the app
// Usage: node scripts/build-desktop.mjs [--dev] [--launch [app args…]]
//   npm run desktop:build              build only
//   npm run desktop -- --vault=D:\V    build, then start the app (arguments go to the app)
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { buildId, cssOptions, DESKTOP_BUNDLED, desktopMainOptions, desktopRendererOptions, runnerOptions, workerOptions } from "./build-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist-desktop");
const argv = process.argv.slice(2);
const dev = argv.includes("--dev");
const launch = argv.includes("--launch");
const appArgs = argv.filter((a) => a !== "--dev" && a !== "--launch");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

/** Shared esbuild options of the quick window's two small bundles. */
function launcherOptions(root, { dev }) {
  return { bundle: true, minify: !dev, sourcemap: dev ? "inline" : false, legalComments: "eof", logLevel: "warning", absWorkingDir: root };
}

export async function buildDesktop({ quiet = false } = {}) {
  const t0 = Date.now();
  const build = buildId(pkg.version);
  await mkdir(out, { recursive: true });
  const w = await esbuild.build(workerOptions(root, { dev }));
  const workerCode = w.outputFiles?.[0]?.text;
  if (!workerCode) throw new Error("worker build produced no output");
  await Promise.all([
    esbuild.build(desktopRendererOptions(root, { dev, workerCode, version: pkg.version, build, outdir: out })),
    esbuild.build(desktopMainOptions(root, { dev, version: pkg.version, build, outdir: out })),
    esbuild.build({ ...runnerOptions(root, { dev, version: pkg.version, build }), outfile: path.join(out, "cortex-runner.js"), metafile: false }),
    esbuild.build({ ...cssOptions(root, { dev }), outfile: path.join(out, "styles.css") }),
    // The quick window: a preload (three calls, Node side) and its page (plain DOM, no Node).
    esbuild.build({ ...launcherOptions(root, { dev }), entryPoints: [path.join(root, "src/desktop/launcherPreload.ts")], outfile: path.join(out, "launcher-preload.js"), format: "cjs", platform: "node", target: "node22", external: ["electron"] }),
    esbuild.build({ ...launcherOptions(root, { dev }), entryPoints: [path.join(root, "src/desktop/launcherPage.ts")], outfile: path.join(out, "launcher-page.js"), format: "iife", platform: "browser", target: "chrome120" }),
  ]);
  await copyFile(path.join(root, "src", "desktop", "launcher.html"), path.join(out, "launcher.html"));
  await copyFile(path.join(root, "src", "desktop", "launcher.css"), path.join(out, "launcher.css"));
  await copyFile(path.join(root, "src", "desktop", "index.html"), path.join(out, "index.html"));
  await copyFile(path.join(root, "src", "desktop", "desktop.css"), path.join(out, "desktop.css"));
  await copyFile(path.join(root, "manifest.json"), path.join(out, "manifest.json"));
  // The app icon (the Cortex glyph; scripts/make-icon.mjs draws it): the window and taskbar use it in a dev run too.
  await copyFile(path.join(root, "src", "desktop", "assets", "cortex.ico"), path.join(out, "icon.ico"));
  await writeFile(
    path.join(out, "package.json"),
    `${JSON.stringify({ name: "cortex-desktop", productName: "Cortex", version: pkg.version, private: true, main: "main.js", type: "commonjs", build }, null, 2)}\n`,
  );
  const notices = [`Cortex Desktop ${pkg.version} bundles the following third-party packages:`, "", ...DESKTOP_BUNDLED.map((b) => `- ${b.name} (${b.licence} licence)`), "", "It runs on Electron (MIT licence), which is not bundled. Each package's licence text is reproduced at the end of the bundle it ships in (legal comments).", ""];
  await writeFile(path.join(out, "THIRD-PARTY-NOTICES.txt"), notices.join("\n"));
  if (!quiet) {
    const kb = async (f) => `${((await stat(path.join(out, f))).size / 1024).toFixed(1)} KB`;
    console.log(`built Cortex Desktop ${build} in ${Date.now() - t0} ms — renderer.js ${await kb("renderer.js")} · main.js ${await kb("main.js")} · cortex-runner.js ${await kb("cortex-runner.js")} · styles.css ${await kb("styles.css")}${dev ? " [dev]" : ""} → ${path.relative(root, out)}`);
  }
  return { out, build };
}

/** The Electron executable installed by the `electron` dev dependency (downloaded on first use). */
export function electronPath() {
  const require = createRequire(import.meta.url);
  return require("electron");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await buildDesktop();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  if (launch) {
    const child = spawn(electronPath(), [out, ...appArgs], { stdio: "inherit", windowsHide: false });
    child.on("exit", (code) => process.exit(code ?? 0));
    child.on("error", (e) => {
      console.error(`could not start Electron: ${e.message}`);
      process.exit(1);
    });
  }
}

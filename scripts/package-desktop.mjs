// Packages Cortex Desktop as a runnable Windows app folder: release/Cortex-win32-x64/Cortex.exe (the Electron runtime,
// the dist-desktop bundle as the app, the Cortex glyph as the icon). Not an installer and not signed.
//   npm run desktop:package [-- --arch=x64|arm64] [-- --no-build]
// Needs a network the first time (the Electron runtime of the same version as the dev dependency is downloaded
// into Electron's cache). The result starts with `Cortex.exe` (add --no-background for a view-only run).
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { buildDesktop } from "./build-desktop.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arch = argv.find((a) => a.startsWith("--arch="))?.slice(7) ?? "x64";
if (arch !== "x64" && arch !== "arm64") {
  console.error("--arch must be x64 or arm64");
  process.exit(2);
}

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const electronVersion = String(pkg.devDependencies?.electron ?? "").replace(/^[^\d]*/, "");
if (!electronVersion) {
  console.error("package.json has no electron dev dependency");
  process.exit(1);
}

if (!argv.includes("--no-build")) await buildDesktop();
const app = path.join(root, "dist-desktop");
// --out=<dir> packages somewhere else, e.g. while the current release/Cortex.exe is still running and its files are locked.
const outArg = argv.find((a) => a.startsWith("--out="))?.slice(6);
const out = outArg ? path.resolve(root, outArg) : path.join(root, "release");

const t0 = Date.now();
const made = await packager({
  dir: app,
  out,
  name: "Cortex",
  executableName: "Cortex",
  platform: "win32",
  arch,
  electronVersion,
  icon: path.join(root, "src", "desktop", "assets", "cortex.ico"),
  appVersion: pkg.version,
  overwrite: true,
  // The runner (cortex-runner.js) is started as its own process from this folder, so the app stays unpacked.
  asar: false,
  prune: false,
  derefSymlinks: false,
  quiet: true,
  win32metadata: { CompanyName: "Cortex", FileDescription: "Cortex", ProductName: "Cortex", OriginalFilename: "Cortex.exe", InternalName: "Cortex" },
});
for (const dir of made) console.log(`packaged ${path.relative(root, path.join(dir, "Cortex.exe"))} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await rm(path.join(out, ".tmp"), { recursive: true, force: true }).catch(() => undefined);

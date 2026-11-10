// Builds Cortex Desktop's app icon from the Cortex glyph (src/ui/icons.ts): src/desktop/assets/cortex.ico (16 to 256 px,
// PNG-compressed entries) and cortex.png (512 px). The files are committed; run this only to redraw them:
//   node scripts/make-icon.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { electronPath } from "./build-desktop.mjs";
import { packIco } from "./ico.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "src", "desktop", "assets");
const SIZES = [16, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cortex-icon-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electronPath(), [path.join(root, "scripts", "icon-render.cjs"), tmp, SIZES.join(",")], { env, stdio: "inherit", windowsHide: true });
  if (r.status !== 0) {
    console.error("could not draw the icon");
    process.exit(1);
  }
  mkdirSync(assets, { recursive: true });
  const png = (px) => readFileSync(path.join(tmp, `icon-${px}.png`));
  writeFileSync(path.join(assets, "cortex.ico"), packIco(ICO_SIZES.map((size) => ({ size, png: png(size) }))));
  writeFileSync(path.join(assets, "cortex.png"), png(512));
  rmSync(tmp, { recursive: true, force: true });
  console.log(`wrote ${path.relative(root, path.join(assets, "cortex.ico"))} and cortex.png`);
}

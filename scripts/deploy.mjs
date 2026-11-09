// Deploy the built plugin into the vault's plugin folder — and nowhere else.
//
//   node scripts/deploy.mjs --vault <path> [--dry-run] [--reload]      (or set CORTEX_VAULT instead of --vault)
//
// Copies dist/{main.js, manifest.json, styles.css, cortex-runner.js, THIRD-PARTY-NOTICES.txt} into
// <vault>/.obsidian/plugins/cortex/ (creating only that folder, plus a create-only `.gitignore` containing `*`
// so nothing in the plugin folder, including data.json, is ever committed). Never deletes anything, never touches
// data.json, community-plugins.json or any other plugin, never runs git. Each file is written to a temp name
// in the target folder and renamed into place (OneDrive-safe). With --reload it asks the running Obsidian to
// reload the plugin through the Obsidian CLI (plugin:reload id=cortex vault=claude-obsidian); enabling the
// plugin the first time is a user decision (Settings › Community plugins, or `plugin:enable` after approval).
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const vault = path.resolve(value("--vault") ?? process.env.CORTEX_VAULT ?? fail("pass --vault <vault> or set CORTEX_VAULT"));
const dryRun = flag("--dry-run");
const reload = flag("--reload");
const obsidianCli = process.env.OBSIDIAN_CLI ?? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Obsidian", "Obsidian.com");
const vaultName = process.env.CORTEX_VAULT_NAME ?? "claude-obsidian";

const FILES = ["main.js", "manifest.json", "styles.css", "cortex-runner.js", "THIRD-PARTY-NOTICES.txt"];

function fail(msg) {
  console.error(`deploy: ${msg}`);
  process.exit(1);
}

if (!existsSync(path.join(vault, ".obsidian"))) fail(`not a vault (no .obsidian folder): ${vault}`);
const manifestPath = path.join(dist, "manifest.json");
if (!existsSync(manifestPath)) fail("dist/manifest.json missing — run `npm run build` first");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.id !== "cortex") fail(`unexpected plugin id "${manifest.id}"`);

const pluginsDir = path.join(vault, ".obsidian", "plugins");
const target = path.join(pluginsDir, manifest.id);
const rel = path.relative(pluginsDir, target);
if (rel !== "cortex" || path.isAbsolute(rel)) fail(`refusing to write outside ${pluginsDir}`);

const plan = [];
for (const f of FILES) {
  const src = path.join(dist, f);
  if (!existsSync(src)) fail(`missing build output ${f}`);
  plan.push({ src, dst: path.join(target, f), bytes: (await stat(src)).size });
}

console.log(`${dryRun ? "[dry run] " : ""}deploy Cortex ${manifest.version} → ${target}`);
for (const p of plan) console.log(`  ${path.relative(dist, p.src).padEnd(40)} ${(p.bytes / 1024).toFixed(1).padStart(8)} KB`);
if (dryRun) process.exit(0);

for (const p of plan) {
  await mkdir(path.dirname(p.dst), { recursive: true });
  const tmp = path.join(path.dirname(p.dst), `.${path.basename(p.dst)}.cortex-tmp-${process.pid}`);
  await copyFile(p.src, tmp);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, p.dst);
      break;
    } catch (e) {
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        await rm(tmp, { force: true });
        throw e;
      }
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
  }
}
// Create-only: an existing .gitignore (the user's or an earlier deploy's) is never rewritten.
const gitignore = path.join(target, ".gitignore");
if (!existsSync(gitignore)) {
  try {
    await writeFile(gitignore, "*\n", { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}
console.log("deployed.");

if (reload) {
  if (!existsSync(obsidianCli)) fail(`Obsidian CLI not found at ${obsidianCli}`);
  const r = spawnSync(obsidianCli, ["plugin:reload", `id=${manifest.id}`, `vault=${vaultName}`], { encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  const errs = spawnSync(obsidianCli, ["dev:errors", `vault=${vaultName}`], { encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 });
  process.stdout.write(errs.stdout ?? "");
} else {
  console.log(`reload in the running Obsidian with:\n  "${obsidianCli}" plugin:reload id=${manifest.id} vault=${vaultName}`);
}

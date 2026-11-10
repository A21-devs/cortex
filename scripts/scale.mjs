// Scale smoke test: a synthetic 20,000-note vault + 300 Claude Code sessions (a few ~20 MB) + a 1,000-conversation
// ChatGPT zip, imported through the in-process runner, with wall time per stage, peak RSS and index size.
// Entirely outside the real vault: a fresh folder under os.tmpdir() (deleted afterwards) holds the vault, the
// ledger, wiki/derived, .vault-meta and the cache (LOCALAPPDATA / XDG_CACHE_HOME point inside it). Synthetic data
// only; no claude CLI, no agents, nothing sent anywhere.
//
//   npm run scale                         full size (takes a few minutes)
//   npm run scale -- --notes 2000 --sessions 30 --conversations 100     a smaller run
//   options: --notes N  --raw N  --sessions N  --big-sessions N  --big-mb N  --conversations N  --touch N
//            --keep (leave the folder)  --real-vault <path> (checked for changes; default: CORTEX_VAULT, if set)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { generate } from "./scale-gen.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const num = (name, d) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : d);
const str = (name, d) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : d);
const keep = argv.includes("--keep");
const TOUCH = num("--touch", 100);

const realVault = str("--real-vault", process.env.CORTEX_VAULT ?? "");
const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".cache");

/** A fingerprint of a folder tree (paths, sizes, mtimes). Read-only. */
function snapshot(dir) {
  const h = createHash("sha256");
  let files = 0;
  let newest = 0;
  const walk = (d) => {
    let ents = [];
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          const st = statSync(p);
          files++;
          newest = Math.max(newest, st.mtimeMs);
          h.update(`${p}|${st.size}|${st.mtimeMs}\n`);
        } catch {
          /* gone between readdir and stat */
        }
      }
    }
  };
  walk(dir);
  return { dir, exists: existsSync(dir), files, newest: newest ? new Date(newest).toISOString() : null, hash: h.digest("hex").slice(0, 16) };
}

const dirSize = (d) => {
  let b = 0;
  const walk = (x) => {
    for (const e of readdirSync(x, { withFileTypes: true })) {
      const p = path.join(x, e.name);
      if (e.isDirectory()) walk(p);
      else b += statSync(p).size;
    }
  };
  walk(d);
  return b;
};

const watched = [...(realVault ? [path.join(realVault, ".vault-meta", "cortex")] : []), path.join(localAppData, "cortex")];
const before = watched.map(snapshot);

const tmp = mkdtempSync(path.join(os.tmpdir(), "cortex-scale-"));
if (tmp.toLowerCase().includes("onedrive")) {
  console.error("refusing to run under OneDrive");
  process.exit(1);
}
const t = Date.now();
const lap = () => `${((Date.now() - t) / 1000).toFixed(0)}s`;
let done = null;
let failed = null;
try {
  console.log(`scale folder: ${tmp}`);
  const gen = generate(tmp, {
    notes: num("--notes", 17_000),
    rawDocs: num("--raw", 3_000),
    sessions: num("--sessions", 300),
    bigSessions: num("--big-sessions", 3),
    bigSessionBytes: num("--big-mb", 20) * 1024 * 1024,
    conversations: num("--conversations", 1000),
    log: (s) => console.log(`  gen: ${s}`),
  });
  console.log(`generated in ${lap()}: ${gen.files.notes.length + gen.files.raw.length} notes/docs (${(dirSize(path.join(gen.vault, "notes")) / 1048576).toFixed(0)} MB under notes/), sessions ${(dirSize(gen.projects) / 1048576).toFixed(0)} MB, zip ${(statSync(gen.zip).size / 1048576).toFixed(1)} MB`);

  const driver = path.join(tmp, "driver.cjs");
  await esbuild.build({
    entryPoints: [path.join(root, "tests", "scale", "driver.ts")],
    outfile: driver,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    // the runner's own entry check (require.main === module) must not fire inside the driver bundle
    define: { __CORTEX_VERSION__: '"0.1.0-scale"', __CORTEX_BUILD__: '"scale"', "require.main": "undefined" },
    alias: { obsidian: path.join(root, "tests", "stubs", "obsidian.ts") },
    logLevel: "warning",
  });
  const touchFile = path.join(tmp, "touch.json");
  const every = Math.max(1, Math.floor(gen.files.notes.length / TOUCH));
  writeFileSync(touchFile, JSON.stringify(gen.files.notes.filter((_, i) => i % every === 0).slice(0, TOUCH)));

  // Every path the pipeline writes resolves inside the temp folder: the vault is there, and "local app data" and the
  // home folder are redirected there too.
  const home = path.join(tmp, "home");
  const env = { ...process.env, LOCALAPPDATA: path.join(tmp, "localappdata"), XDG_CACHE_HOME: path.join(tmp, "localappdata"), APPDATA: path.join(tmp, "appdata"), USERPROFILE: home, HOME: home, GIT_CONFIG_GLOBAL: path.join(tmp, "nogitconfig"), GIT_CONFIG_SYSTEM: path.join(tmp, "nogitconfig") };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=4096", driver, gen.vault, gen.zip, touchFile, gen.liveSession], { env, cwd: tmp, stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith("STAGE ")) {
          const s = JSON.parse(line.slice(6));
          console.log(`  ${s.name.padEnd(40)} ${(s.ms / 1000).toFixed(1).padStart(7)} s   rss ${String(Math.round(s.rssMb)).padStart(5)} MB   peak ${String(Math.round(s.peakMb)).padStart(5)} MB   ${JSON.stringify(s.detail)}`);
        } else if (line.startsWith("DONE ")) done = JSON.parse(line.slice(5));
        else if (line) console.log(`  ${line}`);
      }
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`driver exited ${code}`))));
    child.on("error", reject);
  });
} catch (e) {
  failed = e;
  console.error(`scale run failed: ${e instanceof Error ? e.message : e}`);
} finally {
  if (keep) console.log(`kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

const after = watched.map(snapshot);
console.log("");
console.log("real folders (read-only check, this script never writes there):");
for (let i = 0; i < watched.length; i++) console.log(`  ${watched[i]}  before ${before[i].files} files, newest ${before[i].newest}; after ${after[i].files} files, newest ${after[i].newest}; ${before[i].hash === after[i].hash ? "unchanged" : "CHANGED"}`);
if (done) console.log(`\npeak RSS ${done.peakMb} MB; record index ${(done.index.bytes / 1048576).toFixed(1)} MB for ${done.index.count} entries; total ${lap()}`);
process.exit(failed ? 1 : 0);

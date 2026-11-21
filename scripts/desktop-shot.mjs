// Screenshot harness for Cortex Desktop: opens the app in a window that is never shown, waits until the index is
// loaded and the figure has points, runs optional steps, and saves PNGs (webContents.capturePage, so the DOM chrome
// and the WebGL canvas are both in the picture). No human at the screen is needed.
//
// Usage: node scripts/desktop-shot.mjs [--out=<dir>] [--steps=<file.json>] [--agents-status=<file.json>]
//          [--size=1512x982] [--vault=<folder>] [--dpr=1] [--timeout=120000] [--settle=4500]
//          [--device=returning|fresh] [--mode=offscreen|hidden] [--no-build]
//   --out      where PNGs and shot-report.json go (default .tmp/desktop-shots); never inside the vault
//   --steps    a JSON list of steps, see src/desktop/shotSteps.ts:
//              [{ "wait": 1000 }, { "click": "selector" }, { "eval": "js" }, { "size": "1280x800" },
//               { "agentsStatus": "status.json" }, { "capture": "a.png" }]
//              Without steps (or without a capture step) one picture is saved as cortex.png.
//   --agents-status  a stand-in agents status (an AgentsStatusResult as JSON, src/shared/protocol/runner.ts),
//              applied once the app is ready, as the runner's own status is, so the Agents page shows its counts and
//              what is waiting; an agentsStatus step does the same at its place in the steps (a file name there is
//              relative to the steps file). Checked first: a malformed status stops the run with the reason.
//              Example: --steps=scripts/shots/agents-waiting.json (the Agents page with scripts/shots/agents-status.json)
//   --size     the window's content size in CSS pixels (default 1512x982, the reference recordings' screen)
//   --dpr      device pixel ratio of the captures (default 1; 2 for a Retina-like picture)
//   --settle   ms to wait after the figure has points, so the growth animation finishes (default 4500)
//   --device   "returning" (default): hints, checklist and tour count as seen; "fresh": a first visit
//   --mode     "offscreen" (default): Electron's offscreen rendering, driven at 60 frames a second, so the figure
//              animates as on screen; "hidden": a never-shown window (Chromium paints it, but at about 1 frame a second)
// The app runs view only: nothing is imported, no agent runs, settings changes stay in memory, and the browser
// profile is a throw-away folder. A stand-in agents status changes only what the page shows: it asks the runner for
// nothing and runs no agent. Exit code 0 when every capture was written.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDesktop, electronPath } from "./build-desktop.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name) => {
  const hit = [...argv].reverse().find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};
const KNOWN = new Set(["out", "steps", "agents-status", "size", "vault", "dpr", "timeout", "settle", "device", "mode", "no-build", "help"]);
for (const a of argv) {
  const name = /^--([a-z-]+)/.exec(a)?.[1];
  if (!name || !KNOWN.has(name)) {
    console.error(`unknown option ${a} (see the header of scripts/desktop-shot.mjs)`);
    process.exit(2);
  }
}
if (argv.includes("--help")) {
  console.log("node scripts/desktop-shot.mjs [--out=<dir>] [--steps=<file.json>] [--agents-status=<file.json>] [--size=1512x982] [--vault=<folder>] [--dpr=1] [--timeout=ms] [--settle=ms] [--device=returning|fresh] [--mode=offscreen|hidden] [--no-build]");
  process.exit(0);
}

const out = path.resolve(opt("out") ?? path.join(root, ".tmp", "desktop-shots"));
const steps = opt("steps");
const agentsStatus = opt("agents-status");
const timeout = Number(opt("timeout") ?? 120_000);

if (!argv.includes("--no-build")) await buildDesktop();

const profile = mkdtempSync(path.join(os.tmpdir(), "cortex-shot-"));
const args = [path.join(root, "dist-desktop"), "--shot", `--out=${out}`, `--profile=${profile}`];
for (const name of ["size", "vault", "dpr", "timeout", "settle", "device", "mode"]) {
  const v = opt(name);
  if (v !== undefined) args.push(`--${name}=${v}`);
}
if (steps) args.push(`--steps=${path.resolve(steps)}`);
if (agentsStatus) args.push(`--agents-status=${path.resolve(agentsStatus)}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // would start Electron as plain Node
const child = spawn(electronPath(), args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let summary = null;
let carry = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  carry += chunk;
  const lines = carry.split(/\r?\n/);
  carry = lines.pop() ?? "";
  for (const line of lines) {
    if (line.startsWith("{")) {
      try {
        summary = JSON.parse(line);
        continue;
      } catch {
        // not the summary line
      }
    }
    if (line.trim()) console.log(line);
  }
});
child.stderr.setEncoding("utf8");
const noise = /(GPU state invalid|gpu_init|ContextResult::kTransientFailure|Gpu memory|DevTools listening|Autofill\.enable|ERROR:CONSOLE)/i;
child.stderr.on("data", (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) if (line.trim() && !noise.test(line)) process.stderr.write(`${line}\n`);
});
const guard = setTimeout(() => {
  console.error(`the app did not finish within ${timeout + 60_000} ms; stopping it`);
  child.kill();
}, timeout + 60_000);

const code = await new Promise((resolve) => {
  child.on("exit", (c) => resolve(c ?? 1));
  child.on("error", (e) => {
    console.error(`could not start Electron: ${e.message}`);
    resolve(1);
  });
});
clearTimeout(guard);
if (carry.startsWith("{")) {
  try {
    summary = JSON.parse(carry);
  } catch {
    // ignore
  }
}
for (let i = 0; i < 10; i++) {
  try {
    rmSync(profile, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 300));
  }
}

if (summary?.ok) {
  for (const c of summary.captures ?? []) console.log(`saved ${c.path} (${c.width}×${c.height}, ${(c.bytes / 1024).toFixed(0)} KB, ${(c.lit * 100).toFixed(1)}% lit)`);
  const r = summary.ready;
  if (r) console.log(`ready after ${r.afterMs} ms: index ${r.phase}, ${r.points} points drawn (${r.dataPoints} record and note points + haze)${r.vault ? `; vault: ${r.vault.notes} notes of ${r.vault.files} files read in ${r.vault.readMs} ms` : ""}`);
  if (summary.final) console.log(`at the last capture: ${summary.final.fps} frames a second`);
  console.log(`report: ${path.join(out, "shot-report.json")}`);
} else {
  console.error(`screenshot failed: ${summary?.error ?? `Electron exited with code ${code}`}`);
  console.error(`report: ${path.join(out, "shot-report.json")}`);
}
process.exit(summary?.ok ? 0 : code === 0 ? 1 : code);

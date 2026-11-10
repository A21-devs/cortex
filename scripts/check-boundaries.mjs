// Enforce module boundaries so ~12 engineers can work in parallel without leaking Node into the worker,
// Obsidian into the runner, or DOM into shared code. Type-only imports (`import type`) are allowed across
// layers because they vanish at build time; runtime imports must respect the table below.
// Usage: node scripts/check-boundaries.mjs   (exit 1 on violations)
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");

// layer → allowed runtime targets (layers or package prefixes). "node:" = Node built-ins.
const RULES = {
  shared: { layers: ["shared"], packages: [] },
  worker: { layers: ["shared", "worker"], packages: [] },
  node: { layers: ["shared", "node"], packages: ["node:"] },
  store: { layers: ["shared", "node", "store"], packages: ["node:"] },
  importers: { layers: ["shared", "node", "store", "importers"], packages: ["node:"] },
  agents: { layers: ["shared", "node", "store", "agents"], packages: ["node:"] },
  runner: { layers: ["shared", "node", "store", "importers", "agents", "runner"], packages: ["node:"] },
  state: { layers: ["shared", "state"], packages: ["@preact/signals-core"] },
  render: { layers: ["shared", "state", "render"], packages: ["three"] },
  plugin: { layers: ["shared", "node", "store", "state", "plugin", "ui", "render"], packages: ["obsidian", "node:", "@preact/signals-core"] },
  ui: { layers: ["shared", "state", "ui", "render", "plugin"], packages: ["preact", "@preact/signals", "obsidian"] },
  root: { layers: ["root", "shared", "state", "plugin", "ui", "node"], packages: ["obsidian", "node:"] },
  types: { layers: [], packages: [] },
  // Cortex Desktop (Electron): runs the plugin (root) on its own "obsidian" shim (src/desktop/obsidian). Nothing
  // imports desktop/, and it never imports the real "obsidian" at runtime (that resolves to the shim only in its
  // renderer bundle).
  desktop: { layers: ["desktop", "root", "shared", "state", "plugin", "ui", "node"], packages: ["node:", "electron", "marked", "yaml", "lucide-static"] },
};

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

function layerOf(file) {
  const rel = path.relative(src, file).split(path.sep);
  return rel.length === 1 ? "root" : rel[0];
}

const IMPORT_RE = /^\s*(import|export)\s+(type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
const DYNAMIC_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const violations = [];

for await (const file of walk(src)) {
  const layer = layerOf(file);
  const rule = RULES[layer];
  if (!rule) {
    violations.push(`${path.relative(root, file)}: unknown layer "${layer}" (add it to scripts/check-boundaries.mjs)`);
    continue;
  }
  const text = await readFile(file, "utf8");
  const specs = [
    ...[...text.matchAll(IMPORT_RE)].filter((m) => !m[2]).map((m) => m[3]),
    ...[...text.matchAll(DYNAMIC_RE)].map((m) => m[1]),
  ];
  for (const spec of specs) {
    if (spec.startsWith(".")) {
      const target = path.resolve(path.dirname(file), spec);
      const tl = layerOf(target.endsWith(".ts") || target.endsWith(".tsx") ? target : `${target}.ts`);
      if (!rule.layers.includes(tl)) violations.push(`${path.relative(root, file)}: runtime import of ${tl}/ (${spec}) not allowed from ${layer}/`);
    } else {
      const ok = rule.packages.some((p) => (p === "node:" ? spec.startsWith("node:") : spec === p || spec.startsWith(`${p}/`)));
      if (!ok) violations.push(`${path.relative(root, file)}: package "${spec}" not allowed in ${layer}/`);
    }
  }
}

// Extra bans (ENV-INHERIT, CHILD-CWD-ONEDRIVE, browser layers): the runner never forks Obsidian's own executable,
// and browser layers never touch Node globals at runtime.
const BANNED = [
  { layers: ["runner", "agents", "importers", "node", "store"], re: /\bchild_process\.fork\b|\bfork\(\s*process\.execPath/, why: "forking process.execPath (Obsidian) is not allowed" },
  { layers: ["shared", "worker", "state", "render", "ui"], re: /\bprocess\.(env|cwd|execPath|platform)\b|\brequire\(\s*["']node:/, why: "Node globals are not allowed in browser layers" },
  // Electron belongs to the desktop layer; the UI and the renderer stay host-agnostic (they run inside Obsidian too).
  { layers: ["shared", "worker", "state", "render", "ui"], re: /\bfrom\s+["']electron["']|\b(?:require|import)\(\s*["']electron["']\s*\)/, why: "electron may only be imported by src/desktop" },
];
for await (const file of walk(src)) {
  const layer = layerOf(file);
  const text = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  for (const b of BANNED) if (b.layers.includes(layer) && b.re.test(text)) violations.push(`${path.relative(root, file)}: ${b.why}`);
}

if (violations.length > 0) {
  console.error(`module boundary violations (${violations.length}):\n  ${violations.join("\n  ")}`);
  process.exit(1);
}
console.log("module boundaries ok");

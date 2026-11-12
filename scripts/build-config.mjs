// esbuild option factories shared by scripts/build.mjs and tests/build.test.ts (BUILD-TEST-LAZINESS): the tests
// build with exactly these options and inspect the metafile, so the eager core stays free of Preact, three.js and
// the worker. Licences (RUNNER-VERSION-LICENSES): bundles keep legal comments at the end of the file and
// dist/THIRD-PARTY-NOTICES.txt lists every bundled package. No font is bundled (CORTEX-UX §4.6, L6).
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import path from "node:path";

export const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
export const obsidianExternals = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
];

/** Packages bundled into main.js / the worker / the runner, with their licences (written to THIRD-PARTY-NOTICES.txt). */
export const BUNDLED = [
  { name: "preact", licence: "MIT" },
  { name: "@preact/signals", licence: "MIT" },
  { name: "@preact/signals-core", licence: "MIT" },
  { name: "three", licence: "MIT" },
];

export const BUDGET = { mainBytes: 2_500_000, runnerBytes: 1_500_000, workerBytes: 600_000, eagerBytes: 120_000 };

/** A short build id: version + UTC timestamp (the runner's hello reports it; doctor compares it). */
export function buildId(version, now = new Date()) {
  return `${version}+${now.toISOString().replace(/[-:]/g, "").slice(0, 13)}`;
}

export function workerOptions(root, { dev = false } = {}) {
  return {
    entryPoints: [path.join(root, "src/worker/layoutWorker.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
  };
}

/**
 * The lazy chunk and main.js both need the UI wording (src/ui/copy.ts, ~150 KB). main.js already holds it, so the
 * lazy chunk leaves it out and asks for `SHARED_COPY_ID`; src/lazy.ts answers that require with main's own copy.
 */
export const SHARED_COPY_ID = "cortex-shared/copy";
export function sharedCopyPlugin(root) {
  const copyAbs = path.normalize(path.join(root, "src", "ui", "copy.ts")).toLowerCase();
  return {
    name: "shared-copy",
    setup(b) {
      b.onResolve({ filter: /(^|\/)copy(\.ts)?$/ }, (args) => {
        if (args.kind === "entry-point" || !args.resolveDir) return null;
        const abs = path.normalize(path.resolve(args.resolveDir, args.path.endsWith(".ts") ? args.path : `${args.path}.ts`)).toLowerCase();
        return abs === copyAbs ? { path: SHARED_COPY_ID, external: true } : null;
      });
    },
  };
}

/** The lazy chunk (container, commands, UI, renderer, worker): its own CJS bundle, embedded in main.js as a string. */
export function lazyOptions(root, { dev = false, workerCode = "", version = "0.0.0", build = "dev" } = {}) {
  return {
    entryPoints: [path.join(root, "src/lazyEntry.ts")],
    bundle: true,
    write: false,
    outfile: path.join(root, "dist", "lazy.js"),
    format: "cjs",
    platform: "browser",
    target: "es2022",
    // Obsidian's renderer cannot import() Node built-ins ("node:path" fails to fetch): lower import() to require().
    supported: { "dynamic-import": false },
    external: [...obsidianExternals, ...nodeBuiltins],
    plugins: [sharedCopyPlugin(root)],
    define: {
      __CORTEX_WORKER_SOURCE__: JSON.stringify(workerCode),
      __CORTEX_VERSION__: JSON.stringify(version),
      __CORTEX_BUILD__: JSON.stringify(build),
    },
    jsx: "automatic",
    jsxImportSource: "preact",
    treeShaking: true,
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
  };
}

/**
 * main.js carries the lazy chunk deflated and base64-encoded (the plugin is desktop-only, so src/lazy.ts inflates it
 * with Node's zlib on first use). Packing keeps the single-file plugin far under BUDGET.mainBytes however much UI the
 * chunk grows by. An empty chunk stays an empty string.
 */
export function packLazy(code) {
  return code === "" ? "" : deflateRawSync(Buffer.from(code, "utf8"), { level: 9 }).toString("base64");
}

export function mainOptions(root, { dev = false, lazyCode = "", version = "0.0.0", build = "dev", outdir } = {}) {
  return {
    entryPoints: [path.join(root, "src/main.ts")],
    ...(outdir ? { outdir } : { outfile: path.join(root, "dist", "main.js") }),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    // Obsidian's renderer cannot import() Node built-ins ("node:path" fails to fetch): lower import() to require().
    supported: { "dynamic-import": false },
    external: [...obsidianExternals, ...nodeBuiltins],
    define: {
      __CORTEX_LAZY_BUNDLED__: "true",
      __CORTEX_LAZY_SOURCE__: JSON.stringify(packLazy(lazyCode)),
      __CORTEX_VERSION__: JSON.stringify(version),
      __CORTEX_BUILD__: JSON.stringify(build),
    },
    jsx: "automatic",
    jsxImportSource: "preact",
    treeShaking: true,
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    legalComments: "eof",
    banner: { js: `/* Cortex ${version} (${build}). Bundled third-party code: see THIRD-PARTY-NOTICES.txt. */` },
    metafile: true,
    logLevel: "warning",
  };
}

export function runnerOptions(root, { dev = false, version = "0.0.0", build = "dev" } = {}) {
  return {
    entryPoints: [path.join(root, "src/runner/main.ts")],
    outfile: path.join(root, "dist", "cortex-runner.js"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    define: {
      __CORTEX_VERSION__: JSON.stringify(version),
      __CORTEX_BUILD__: JSON.stringify(build),
    },
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    legalComments: "eof",
    banner: { js: `/* Cortex runner ${version} (${build}). Bundled third-party code: see THIRD-PARTY-NOTICES.txt. */` },
    metafile: true,
    logLevel: "warning",
  };
}

/**
 * Obsidian ships global rules such as `button:not(.clickable-icon)` (specificity 0,1,1) for every button, input and
 * select. A plain `.cx-button` (0,1,0) loses to them, so the Cortex controls would pick up Obsidian's fill, padding,
 * height and shadow. This transform repeats the first `.cx-` class of every rule's subject (`.cx-a` becomes
 * `.cx-a.cx-a`), lifting each Cortex rule by one class (0,2,0 beats 0,1,1) while keeping every comparison between
 * Cortex rules as it was written (they all rise together). It works on the source text, so the partials stay readable.
 */
export function liftSpecificity(css) {
  let out = "";
  let i = 0;
  let prelude = "";
  const lift = (sel) => {
    const m = /(\.cx-[A-Za-z0-9_-]+)([^\s>+~,]*)$/.exec(sel);
    if (!m || m[1] === undefined) return sel;
    const start = m.index + m[1].length;
    return `${sel.slice(0, start)}${m[1]}${sel.slice(start)}`;
  };
  const liftList = (list) => {
    const parts = [];
    let depth = 0;
    let cur = "";
    for (const ch of list) {
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth -= 1;
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => {
      const lead = /^\s*/.exec(p)?.[0] ?? "";
      const trail = /\s*$/.exec(p)?.[0] ?? "";
      const core = p.trim();
      return core === "" ? p : `${lead}${lift(core)}${trail}`;
    }).join(",");
  };
  const keyframes = [];
  let depthBraces = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end < 0 ? css.length : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "{") {
      const raw = prelude;
      const t = raw.trim();
      const inKeyframes = keyframes.length > 0;
      const isAt = t.startsWith("@");
      if (isAt && /^@(-\w+-)?keyframes/.test(t)) keyframes.push(depthBraces);
      out += !isAt && !inKeyframes ? liftList(raw) : raw;
      out += "{";
      depthBraces += 1;
      prelude = "";
      i += 1;
      continue;
    }
    if (ch === "}" || ch === ";") {
      out += prelude + ch;
      prelude = "";
      if (ch === "}") {
        depthBraces -= 1;
        if (keyframes.length > 0 && keyframes[keyframes.length - 1] === depthBraces) keyframes.pop();
      }
      i += 1;
      continue;
    }
    prelude += ch;
    i += 1;
  }
  return out + prelude;
}

const liftPlugin = {
  name: "cortex-lift-specificity",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]styles[\\/](shell|stage|pages|charts|ask|themes|time-page|lab|guide)\.css$/ }, async (args) => ({ contents: liftSpecificity(await readFile(args.path, "utf8")), loader: "css" }));
  },
};

export function cssOptions(root, { dev = false } = {}) {
  return {
    entryPoints: [path.join(root, "styles.css")],
    outfile: path.join(root, "dist", "styles.css"),
    bundle: true,
    minify: !dev,
    plugins: [liftPlugin],
    logLevel: "warning",
  };
}

// ───────────────────────────── Cortex Desktop (scripts/build-desktop.mjs) ─────────────────────────────
// The Obsidian plugin's bundles above are untouched by these: the desktop builds its own copies into dist-desktop/.

/** Packages bundled into the desktop renderer on top of BUNDLED (the "obsidian" shim's dependencies). */
export const DESKTOP_BUNDLED = [
  ...BUNDLED,
  { name: "marked", licence: "MIT" },
  { name: "yaml", licence: "ISC" },
  { name: "lucide-static", licence: "ISC" },
];

/** Resolves every `import "obsidian"` (static or dynamic) to the desktop shim. */
export function obsidianShimPlugin(root) {
  const shim = path.join(root, "src", "desktop", "obsidian", "index.ts");
  return {
    name: "cortex-obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: shim }));
    },
  };
}

/**
 * The desktop renderer: src/desktop/renderer.ts, which boots the unchanged plugin code (main.ts, the lazy chunk's
 * modules, the UI and renderer) with "obsidian" resolved to src/desktop/obsidian. One script for the window
 * (Electron renderer with Node integration: Node built-ins and electron stay require() calls).
 */
export function desktopRendererOptions(root, { dev = false, workerCode = "", version = "0.0.0", build = "dev", outdir } = {}) {
  return {
    entryPoints: [path.join(root, "src/desktop/renderer.ts")],
    outfile: path.join(outdir ?? path.join(root, "dist-desktop"), "renderer.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    supported: { "dynamic-import": false },
    external: ["electron", ...nodeBuiltins],
    plugins: [obsidianShimPlugin(root)],
    define: {
      __CORTEX_WORKER_SOURCE__: JSON.stringify(workerCode),
      __CORTEX_VERSION__: JSON.stringify(version),
      __CORTEX_BUILD__: JSON.stringify(build),
      // The lazy chunk is part of this one bundle (src/lazy.ts takes its import() branch).
      __CORTEX_LAZY_BUNDLED__: "false",
      __CORTEX_LAZY_SOURCE__: JSON.stringify(""),
    },
    jsx: "automatic",
    jsxImportSource: "preact",
    treeShaking: true,
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    legalComments: "eof",
    banner: { js: `/* Cortex Desktop ${version} (${build}). Bundled third-party code: see THIRD-PARTY-NOTICES.txt. */` },
    metafile: true,
    logLevel: "warning",
  };
}

/** The desktop's Electron main process (src/desktop/main.ts). */
export function desktopMainOptions(root, { dev = false, version = "0.0.0", build = "dev", outdir } = {}) {
  return {
    entryPoints: [path.join(root, "src/desktop/main.ts")],
    outfile: path.join(outdir ?? path.join(root, "dist-desktop"), "main.js"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["electron"],
    define: {
      __CORTEX_VERSION__: JSON.stringify(version),
      __CORTEX_BUILD__: JSON.stringify(build),
    },
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    legalComments: "eof",
    banner: { js: `/* Cortex Desktop ${version} (${build}), main process. */` },
    metafile: true,
    logLevel: "warning",
  };
}

export function noticesText(version) {
  const lines = [`Cortex ${version} bundles the following third-party packages:`, ""];
  for (const b of BUNDLED) lines.push(`- ${b.name} (${b.licence} licence)`);
  lines.push("", "Each package's licence text is reproduced at the end of the bundle it ships in (legal comments).");
  return `${lines.join("\n")}\n`;
}

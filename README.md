# Cortex

An Obsidian desktop plugin that grows a living 3D particle nervous system — brain, brainstem, spinal cord
and nerves — from the whole record: vault notes, `.raw/` source documents, Claude Code sessions, Claude.ai,
ChatGPT and Gemini exports and chosen folders. Agents running through the Claude Code CLI label, sort and
summarise; the user's own words are never edited and every machine interpretation is stored separately and
marked as machine-written.

Read **[docs/CORTEX-UX.md](docs/CORTEX-UX.md)** first: it is the binding product and interaction design (every
surface, control, page, chart, Ask action and setting, with exact copy). Then
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**: decisions, verified environment, the module map with owners
and disjoint files, contracts, protocols, on-disk formats, budgets, security, testing, phasing and the review
responses.

## Quick start

```bash
npm install            # inside this repo only (never inside the vault or a cloud-synced folder)
npm run check          # typecheck + module boundaries, unit tests (incl. the originality and palette checks), build
npm run dev            # rebuild dist/ on every change
npm run sample         # write a synthetic sample vault + transcripts to %TEMP%
npm run deploy:dry     # show what would be copied into the vault's plugin folder
npm run deploy         # copy dist/* into <vault>/.obsidian/plugins/cortex/ (nothing else is touched)
```

Reload in the running Obsidian after a deploy:

```bash
"%LOCALAPPDATA%/Programs/Obsidian/Obsidian.com" plugin:reload id=cortex vault=<vault name>
"%LOCALAPPDATA%/Programs/Obsidian/Obsidian.com" dev:errors vault=<vault name>
```

The runner can also be used on its own (this is what the `/cortex-organise` skill does):

```bash
node dist/cortex-runner.js doctor --vault <vault> --json
node dist/cortex-runner.js import --vault <vault> --max-seconds 90 --json
node dist/cortex-runner.js agents run --dry-run --vault <vault> --json
```

## Layout

| Path | What |
|---|---|
| `src/main.ts` | plugin entry (eager core; everything heavy is lazy) |
| `src/shared/` | contracts and pure utilities (frozen contracts listed in ARCHITECTURE §3) |
| `src/node/`, `src/store/` | safe file system, locks, spawn; ledgers, segments, cursors, notes writer |
| `src/importers/` | Claude Code, `.raw/`, folders, written, Claude.ai, ChatGPT, Gemini |
| `src/agents/`, `src/runner/` | Claude Code CLI engine, jobs, budget, privacy; the `cortex-runner.js` process |
| `src/plugin/`, `src/state/` | Obsidian-side services; UI state and event bus |
| `src/worker/` | layout worker: anatomy, placement, grouping, arrangements, charts, search, stats |
| `src/render/` | three.js renderer, shaders, camera, picking |
| `src/ui/`, `src/styles/`, `styles.css` | Preact UI: header, stage, sheet, command line, pages, readers, modals; tokens from CORTEX-UX §4 |
| `src/desktop/` | Cortex Desktop: Electron main and renderer, the `obsidian` shim (`src/desktop/obsidian/`), screenshot steps |
| `tests/` | vitest suites, fixtures, Obsidian stub, browser smoke page |
| `skill/cortex-organise/` | Claude Code skill (installing it is the user's decision) |

## Ground rules

- Build outside any cloud-synced folder (OneDrive, Dropbox, iCloud); deploy copies only `main.js`,
  `manifest.json`, `styles.css`, `cortex-runner.js` and `THIRD-PARTY-NOTICES.txt` into `.obsidian/plugins/cortex/`
  (plus a create-only `.gitignore` with `*`). No font is bundled: Cortex uses Obsidian's interface and monospace
  fonts.
- Never rewrite or delete existing notes, never run git commands in the vault, never touch other plugins'
  folders, `graph.json`, the vault's own scripts, Claude Code's settings or the vault's root `.gitignore`.
- Cortex's look, names and copy are its own (CORTEX-UX §0.1; enforced by `tests/originality.test.ts`).

## Network use

Cortex makes no request of its own to the internet except one: **Cortex: Check for updates** (palette, header More
menu or the command bar) sends a single request to the GitHub releases API of the plugin's repository, only when you
run it, and compares the newest release tag with the installed version. Nothing is downloaded or installed by it;
updates come from Obsidian's Community plugins. Text sent to a model is described by **Cortex: Show what is sent**.

## Lock

**Cortex: Lock** (default hotkey Ctrl+Shift+L) blanks every Cortex view and stops the 3D rendering. Set a passphrase in
Settings > Cortex > Privacy > Lock (stored as a salted PBKDF2 hash, never as text); with none set, a click lifts the
lock. The same section sets an idle auto-lock.

## Cortex Desktop

A standalone, full-window app (Electron) that runs the same plugin code outside Obsidian on a small `obsidian`
shim (`src/desktop/obsidian/`: the vault and its metadata read straight from the folder, menus, notices, modals,
settings, Lucide icons). Same cache folder, runner, ledgers and settings schema as the plugin, so the existing
record shows up. It never writes into the vault except Cortex's own runtime files; its settings live in
`%APPDATA%\Cortex\vaults\<vaultKey>\data.json`, first copied from the vault's plugin `data.json` (only read).

```bash
npm run desktop                           # build dist-desktop/ and open the app (imports and agents run as in Obsidian)
npm run desktop -- --no-background        # view only: no imports, no agents, settings changes are not saved
npm run desktop -- --vault="D:/Other vault"   # or Settings > Cortex Desktop > Choose folder…
npm run desktop:build                     # bundles only (dist-desktop/; dist/ is not touched)
node scripts/desktop-shot.mjs --out=.tmp/shots [--steps=steps.json] [--size=1512x982] [--dpr=2]
```

`desktop-shot.mjs` opens the app in a window that is never shown (offscreen rendering at 60 frames a second, view
only, a throw-away profile), waits until the index is loaded and the figure has points, runs the steps (`wait`,
`click`, `eval`, `size`, `capture`; see `src/desktop/shotSteps.ts`) and writes PNGs plus `shot-report.json`.

Licences of bundled third-party code: three.js (MIT), Preact and @preact/signals (MIT); see
`dist/THIRD-PARTY-NOTICES.txt` and the legal comments at the end of each bundle.

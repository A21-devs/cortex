# Developing Cortex

How to build, test and run Cortex from source. For what Cortex is and how to install it, see the [README](../README.md).

Read **[CORTEX-UX.md](CORTEX-UX.md)** first: it is the binding product and interaction design (every surface, control, page,
chart, Ask action and setting, with exact copy). Then **[ARCHITECTURE.md](ARCHITECTURE.md)**: decisions, verified
environment, the module map with owners and disjoint files, contracts, protocols, on-disk formats, budgets, security,
testing, phasing and the review responses. [CONTRIBUTING.md](../CONTRIBUTING.md) has the pull request rules.

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
node scripts/desktop-shot.mjs --out=.tmp/shots [--steps=steps.json] [--agents-status=status.json] [--size=1512x982] [--dpr=2]
```

`desktop-shot.mjs` opens the app in a window that is never shown (offscreen rendering at 60 frames a second, view
only, a throw-away profile), waits until the index is loaded and the figure has points, runs the steps (`wait`,
`click`, `eval`, `size`, `agentsStatus`, `capture`; see `src/desktop/shotSteps.ts`) and writes PNGs plus
`shot-report.json`.

A screenshot run starts no agents, so the Agents page has no status of its own. `--agents-status=<file.json>`
(applied once the app is ready) or an `agentsStatus` step (applied at its place in the steps) gives it a stand-in: an
`agents.status` result as JSON (`AgentsStatusResult` in `src/shared/protocol/runner.ts`). It is checked before the run
starts (a malformed one stops the run with the reason) and applied as the runner's own status is; it changes nothing
else. The status card shows the count and what is waiting only while agents are on in the opened vault (while they are
off it says so and shows neither). The sample vault has them off, so a stand-in status alone captures none of the
waiting work there: `scripts/shots/agents-waiting.json` applies the synthetic status in
`scripts/shots/agents-status.json`, turns agents on for the run with `settings.preview` (never saved) and captures the
Agents page:

```bash
npm run sample                            # prints the sample vault's folder
npm run desktop:shot -- --vault="<sample vault>" --steps=scripts/shots/agents-waiting.json --out=.tmp/shots
```

Licences of bundled third-party code: three.js (MIT), Preact and @preact/signals (MIT); see
`dist/THIRD-PARTY-NOTICES.txt` and the legal comments at the end of each bundle.

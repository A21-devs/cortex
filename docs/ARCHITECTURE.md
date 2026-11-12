# Cortex — architecture

Version 0.2 · 9 November 2026 · lead architect (revision after the originality, completeness, feasibility and
safety reviews; aligned with CORTEX-UX v1.1). This is the build contract for ~12 engineers working in parallel
on disjoint files. Read §0–§5 before touching code, then the sections of your module.

Cortex is an Obsidian desktop plugin for a local vault (`<vault>`, laid out like claude-obsidian). It draws
the user's whole record — vault notes, `.raw/` documents, Claude Code transcripts, Claude.ai / ChatGPT / Gemini
exports, chosen folders and new entries — as a lying particle nervous system: notes in the brain, the record
along the spinal cord as time, every conversation a frond. Headless Claude Code agents label, summarise and
build maps; the user's own words are never rewritten, every machine interpretation is stored separately, marked
as machine-written and linked to the passages it rests on, and every change can be undone.

---

## 0. Read first

### 0.1 What is binding (B1)

- **`docs/CORTEX-UX.md` is binding for every user-visible surface, token, copy string and interaction.** This
  document decides structure, contracts, formats, processes and ownership. Where they must change together,
  CORTEX-UX §12 lists what this document had to add; every item is answered in §21 (traceability) or §20
  (review responses).
- `docs/research/SPEC.md` is capability evidence, not design. The recordings' analyses (`docs/research/video-*`)
  are evidence of capabilities only: never reproduce the reference product's name, wordmark, glyphs, mascot,
  lens names, "mindsight", colours, palettes, layout proportions, sentence-length copy or distinctive naming.
- Hard rules (from the lead): no node_modules, builds or caches inside the vault (which a cloud folder may
  sync); never rewrite or delete existing notes; never commit, reset, pull or stage in the vault repo; never run
  the vault's own scripts; never write into its generated folders, other plugins' folders or `graph.json` (the
  deny list in `src/node/paths.ts`); no new files named `wiki*.md`; keep paths short; Obsidian CLI always with
  `vault=<vault name>`, never `plugins:restrict`; never change Claude Code's own settings or the vault's root
  `.gitignore`.

### 0.2 Originality (ORIG-03, ORIG-21)

CORTEX-UX §0.1 holds the per-surface table (recorded expression → Cortex replacement) and is authoritative. The
build enforces it: `tests/originality.test.ts` reads the 145-pattern list of
`docs/mockups/src/originality_check.py` and fails `npm test` on any banned expression in `src/ui/copy.ts`, the
note templates in `src/store/notesWriter.ts`, the user-facing strings of `src/agents/privacy.ts` and the two
mockups; it also requires `src/shared/palette.ts` to equal the colours `palette_check.py` validates, runs both
Python scripts when Python is installed, and fails if retired structures reappear. The implementation side of
the table:

| Finding | Recorded expression (retired) | Cortex structure | Enforced in |
|---|---|---|---|
| ORIG-01 | "You" page with a hero percentage | No page; share in Time voices and Sources; names in Settings › Privacy; read log = Agents › Access log; seals = date evidence + Advanced row | `views.ts` (no route), `pages/AccessLog.tsx`, copy test |
| ORIG-02 | "When you wrote" column of lanes and heatmaps | Time = the spine laid flat + rhythm grid + one brush; labels over time in the Data view | `pages/Time.tsx`, `SpineFigure.tsx`, `RhythmGrid.tsx`, `TimeData.tsx` |
| ORIG-03 | Left rail, space chip, minimap, meters | 44 px header, compass, status in tokens / chips / toasts / status bar | the rail is `ui/nav/` (Nav.tsx, navModel.ts) under Cortex's own page names; `header/*`, `stage/Compass.tsx` (the minimap's role), `plugin/statusBar.ts` |
| ORIG-04 | "Search or ask", "‹n› found", "N new — refresh" | "Find anything in your record", "‹n› traced", "‹n› new" + Show them | `copy.ts` |
| ORIG-05 | Conversation note sections under "not your words" | Frond reader: gist subtitle, facets once, stem of parts, inline fixes | `reader/ConversationReader.tsx`, `notesWriter.ts` template |
| ORIG-06 | Hub panel with type · status · range and fixed sections | Map = index: kind + sparkline, brief with evidence meters, members by kind, crumb, Flag | `reader/MapReader.tsx`, `agents/validators.ts` evidenceOf |
| ORIG-07 | Canned chart questions with answer sentences | Plain chart names + ≤ 3 readings drawn on the chart; Ask about this chart | `worker/charts/*`, `stage/Readings.tsx`, no `answers` table |
| ORIG-08 | "Tell your AI what to show or fix" | Ask purpose line, Cortex's verbs as slash commands, computed Try suggestions | `command/AskConsole.tsx`, `slashCommands.ts` |
| ORIG-09 | Narrated seven-step tour | Self-ticking first-run checklist + one-time hints per surface | `stage/FirstRunCard.tsx`, `stage/Hints.tsx`, `ui/deviceState.ts` |
| ORIG-10 | Seven named palettes, six themes, white remainder | Prism, Signal, computed Print; Ink / Paper + Stage tint; mist / slate | `shared/palette.ts` = `palette_check.py` |
| ORIG-11 | Lab wording, "only your own lines" | Agents: ledger, work waiting, packs table, Declined / No answer, withheld replies | `pages/Agents.tsx`, `copy.ts` |
| ORIG-12 | "‹X›'s words" chip, Versions (n), used-by-models | Facts grid, frond scrubber, one History list, "+ Add label" | `reader/EntryReader.tsx`, `FactsGrid.tsx`, `FrondScrubber.tsx`, `HistoryList.tsx` |
| ORIG-13 | View popover Turning / Spread / Limit rotation | Display = Points + Motion only; colour and Layers in the key bar | `stage/DisplayPopover.tsx`, `stage/LayersMenu.ts` |
| ORIG-14 | Axis menu sections and "added" dimensions | Provenance menu, one Date ▸ with Written · Imported | `shared/dims.ts`, `ui/primitives/dimMenu.ts` |
| ORIG-15 | Packs core / anatomic / shelves, hub types | `session`, `placement`, PARA (derived), `correction` "Your fixes"; maps | `shared/packs.ts` |
| ORIG-16 | Scope by wheel, flash, swirl, dolly | Compass turn: 600 ms yaw, sink-and-fade, rise on return | `render/shaders.ts` SCOPE_TIMING, `render/camera.ts` |
| ORIG-18 | Sentence banner for thin groups | Hollow outlined groups + "n" chip + Fold under 30, plus the top-centre "thin-groups" banner in Cortex's own words (Add sources, Try the sample; dismissible) | `worker/arrangements.ts` SPARSE_GROUP, `stage/ShapeBar.tsx`, `stage/Banner.tsx` |
| ORIG-20 | Eleven-page navigation | Five pages: Brain · Read · Time · Agents · Sources | `shared/views.ts` |
| ORIG-21 | Docking left / right with stacked reader | One right sheet with a back stack and crumb, push / overlay / full | `sheet/Sheet.tsx`, `ui/breakpoints.ts` |
| ORIG-22 | Navigator rows with SOURCE · KIND meta | Read rows: speaker-split bar, title, relative time, one snippet | `pages/Read.tsx` |
| ORIG-23 | Month grid, year ring, function layout | Bubbles, Tree, Along the spine, Strata; role placement is an option | `shared/dims.ts` GROUP_LAYOUTS |

### 0.3 Decisions at a glance

| # | Decision | Why |
|---|---|---|
| 1 | One `main.js` with an eager core (< 50 ms, settings tab, commands, status item, link handler) and everything else behind `import()` | Obsidian loads plugins at startup; three.js and Preact must not cost anything until the view opens (BUILD-TEST-LAZINESS proves it with the metafile). |
| 2 | Three tiers: eager core → **background tier** at layout-ready + 30 s idle (settings, runner, agents clock, status, notices, ledger; no Preact or three) → **UI tier** on first view open | Imports must happen even with the tab closed, because Claude Code deletes old sessions on its own schedule (H2, BG-IMPORT-UNWIRED). |
| 3 | **Nothing is imported or sent before the first-run step** (`general.firstRunDone`) | Consent before egress (SAFE-11); OneDrive sync is egress too (SAFE-10). |
| 4 | Runner = system Node child (`cortex-runner.js serve`, cwd = local cache) → fallback a Node-integrated Web Worker → last resort inline with yields | Electron's RunAsNode fuse is off, so `fork(process.execPath)` would start a second Obsidian (§1 row 1); the worker keeps imports off the UI thread (INLINE-FALLBACK-UI-THREAD). |
| 5 | The runner is the single privacy enforcement point (H10) | It reads record text, applies withholding and redaction, writes the ReadRecord; the plugin only ever sends ids. |
| 6 | Claude Code CLI headless, no tools, restricted, explicit effort, allow-listed environment | Prompt-injection containment and no inherited session settings (SAFE-05, ENV-INHERIT). |
| 7 | Per-leaf stores; shared index, worker, runner, settings | Several Cortex tabs are independent views (H6, CORTEX-UX §2.4). |
| 8 | Hard-coded write roots with nested `.gitignore` and minted `WritablePath`s; caches and locks in `%LOCALAPPDATA%` | No setting can redirect writes (SAFE-02); locks must not sync (LOCKS-SHARED-SYNCED, SAFE-14). |
| 9 | Append-only, size-rolled ledgers; immutable gzip segments numbered from their folder | OneDrive uploads whole files; collisions and partial writes must be impossible (LEDGER-SHARD-SIZE, SEGMENT-SEQ-DEADLOCK). |
| 10 | Markdown is code in this vault: Cortex escapes every model string and renders record text with its own inert renderer | Dataview JS is enabled (SAFE-01). |

### 0.4 Frozen contracts and the RFC rule

Frozen (owner: architect; change only by RFC to the architect, which updates every caller in one change):
`src/shared/{types, index-format, views, dims, actions, settings, notesDoc, features}.ts`,
`src/shared/protocol/{worker, runner}.ts`, `src/plugin/services.ts`, `src/state/types.ts`,
`src/types/globals.d.ts`. Everything else is owned by exactly one engineer (§5). Tests that pin the contracts:
`tests/contracts.test.ts` (reads CORTEX-UX tables for commands and charts) and `tests/originality.test.ts`.

---

## 1. Verified environment and experiments (9 Nov 2026)

All experiments were read-only with respect to the vault and the running Obsidian.

| # | Experiment | Result | Consequence |
|---|---|---|---|
| 1 | Electron fuse wire of `Obsidian.exe` read from the binary (sentinel string, never executed) | **RunAsNode disabled**, NODE_OPTIONS disabled, inspect args disabled | `fork()`/`ELECTRON_RUN_AS_NODE` would start a second Obsidian: use system Node, a Node-integrated worker, or inline. `check-boundaries.mjs` bans `fork(process.execPath)`. |
| 2 | System Node discovery | `C:\Program Files\nodejs\node.exe` v24.18.0 | Child runner is the default; minimum Node 20. |
| 3 | Runner bundle smoke (serve mode) | frames `hello → pong → result → error`; exits on stdin EOF; `require`-able in-process | Protocol and transports work (`tests/build.test.ts`). |
| 4 | `claude --help` and the result schema (no prompt sent) | Claude Code 2.1.319: `-p`, `--output-format json`, `--input-format`, `--json-schema`, `--tools ""`, `--restricted`, `--permission-mode`, `--disallowedTools`, `--strict-mcp-config`, `--safe-mode`, `--disable-slash-commands`, `--no-session-persistence`, `--permission-prompts none`, `--max-budget-usd`, `--model`, `--effort`, hidden `--system-prompt-file`, `--max-turns`; aliases `sonnet, opus, haiku, fable, best`; envelope `{type, subtype, is_error, result, structured_output?, total_cost_usd, usage, modelUsage, …}` | §12.1. `doctor` refuses a CLI whose help lacks a mandatory flag (`missingMandatory`). |
| 5 | WebGL2 + worker probe (`tests/smoke/gl-worker-probe.html`) on the target GPU and inside Obsidian 1.15 (Chromium 142) | WebGL2, `EXT_color_buffer_float`, `EXT_float_blend`, RGBA16F and R32UI targets, point size 1–1024, Blob-URL worker with transferred buffers, OffscreenCanvas | HDR target, integer picking target and Blob worker are safe. |
| 6 | three.js with esbuild | 0.186.1; renderer + points ≈ 526 KB min; eager eval drops to 0.3 ms behind `import()` | UI + three lazy; one `main.js`. |
| 7 | Claude Code transcript structure survey (keys and counts only) | line types and origin markers; assistant blocks share `message.id`; live files end mid-line | `importers/claudeCodeClassify.ts`; byte splitter (SPLITLINES-BYTES). |
| 8 | `Obsidian.com help` | `plugin:reload`, `plugin:enable`, `dev:errors`, `dev:console`, `dev:screenshot`, `eval`; `plugins:restrict` toggles (never call it) | §18 dev loop. |
| 9 | Toolchain | npm blocks esbuild's postinstall; esbuild works through `@esbuild/win32-x64` | Nothing to do. |

Pinned versions (`package.json`, exact, all ≥ 2 weeks old): three 0.186.1 · @types/three 0.186.0 · preact
10.29.8 · @preact/signals 2.11.3 · @preact/signals-core 1.14.4 · typescript 6.0.3 · esbuild 0.28.2 · vitest
5.0.5 · vite 7.3.7 · obsidian (types) 1.12.3 (= `minAppVersion` 1.12.0; newer APIs such as
`MenuItem.setSubmenu` are feature-detected) · @types/node 22.20.5 · preact-render-to-string 6.8.1. **No font is
bundled** (L6, CORTEX-UX §4.6): `--cx-font: var(--font-interface)`, `--cx-font-mono: var(--font-monospace)`.

---

## 2. Repository layout and boundaries

```
cortex/                         the repository (keep it outside the vault and any synced folder)
  package.json  package-lock.json  tsconfig.json  tsconfig.browser.json  vitest.config.ts
  manifest.json  versions.json  styles.css (CSS entry)  README.md  .gitignore
  docs/ARCHITECTURE.md  docs/CORTEX-UX.md (binding UX)  docs/mockups/ (UX lead)  docs/research/ (inputs)
  scripts/build-config.mjs (+ .d.mts)  option factories shared by build.mjs and tests/build.test.ts
  scripts/build.mjs             worker → main.js (worker inlined) + cortex-runner.js + styles.css + notices
  scripts/deploy.mjs            copies dist/* into <vault>/.obsidian/plugins/cortex/ only (+ create-only .gitignore)
  scripts/check-boundaries.mjs  module-boundary lint (part of `npm run typecheck`)
  scripts/sample-data.mjs       synthetic vault + transcripts + exports in %TEMP%
  skill/cortex-organise/        Claude Code skill that drives the runner (installing it is the user's decision)
  src/  main.ts · shared/ · node/ · store/ · importers/ · agents/ · runner/ · plugin/ · state/ · worker/ ·
        render/ · ui/ · styles/ · types/
  tests/  one suite per owner area, fixtures/, helpers/, stubs/obsidian.ts, smoke/
  dist/   main.js, cortex-runner.js, styles.css, manifest.json, THIRD-PARTY-NOTICES.txt, meta.json
```

Runtime import rules (`scripts/check-boundaries.mjs`; type-only imports are exempt):

| Layer | May import at runtime |
|---|---|
| `shared` | `shared` |
| `worker` | `shared`, `worker` |
| `node` | `shared`, `node`, `node:*` |
| `store` | `shared`, `node`, `store`, `node:*` |
| `importers` | `shared`, `node`, `store`, `importers`, `node:*` |
| `agents` | `shared`, `node`, `store`, `agents`, `node:*` |
| `runner` | `shared`, `node`, `store`, `importers`, `agents`, `runner`, `node:*` |
| `state` | `shared`, `state`, `@preact/signals-core` |
| `render` | `shared`, `state`, `render`, `three` |
| `plugin` | `shared`, `node`, `store`, `state`, `plugin`, `ui`, `render`, `obsidian`, `node:*`, `@preact/signals-core` |
| `ui` | `shared`, `state`, `ui`, `render`, `plugin`, `preact`, `@preact/signals`, `obsidian` |
| root (`main.ts`) | `shared`, `state`, `plugin`, `ui`, `node`, `obsidian`, `node:*` |
| `desktop` (Cortex Desktop: Electron app + `obsidian` shim, README › Cortex Desktop) | `desktop`, root, `shared`, `state`, `plugin`, `ui`, `node`, `node:*`, `electron`, `marked`, `yaml`, `lucide-static`; nothing imports `desktop`, and `electron` is banned in browser layers |

Extra bans: runner-side layers may not `fork` `process.execPath`; browser layers (`shared`, `worker`, `state`,
`render`, `ui`) may not touch `process.*` or `require("node:…")`. `tsconfig.browser.json` (LAYER-TYPES)
typechecks those layers with `types: []` and DOM libs, so Node types cannot leak into them.

---

## 3. Contracts (summary; the files are the contract)

| File | Holds |
|---|---|
| `shared/types.ts` | Ids, EntryRecord / ConversationRecord / NoteRecord / LabelRecord / CorrectionRecord / RunRecord (`origin: plugin \| skill`, Declined, No answer) / ReadRecord / ReviewCardRecord (`label \| note \| filing \| mention \| conflict`, reason ≤ 140) / ReceiptRecord (summary by Cortex, model `reason` separate, `expiresAt: null` for data changes) / SourceManifest / ControlState / PinnedViewRecord; TextRef `segment \| file{byteStart,byteEnd} \| stage`; SourceKind incl. `cortex-ask`. |
| `shared/index-format.ts` | Binary index v2: columns (kind, noteKind, hubType, hubStatus, words, flags incl. Reference / Automated / Live / NoArea …), ordinal allocator with epochs, `IndexDelta`, `IndexPatch` (INDEX-DELTA-CONTRACT). |
| `shared/views.ts` | `PageId = brain \| read \| time \| agents \| sources`; sheet routes (pages `read, time, agents, sources, chart, guide, new-entry, change-history, runs`; readers `entry, conversation, note, map, vault-peek, thread`); `ROUTE_VIEWS`; `SheetEntry`; stack ≤ 12, width 340–560 (400); `ShapeKind`; the 18-chart catalogue with groups and phases. |
| `shared/dims.ts` | Provenance groups; one date dimension (`day…year`, `hour`, `weekday`; basis Written / Imported); file, conversation, agent and "you" dimensions; label-pack fields; `GroupLayout = bubbles \| tree \| spine \| strata`; remainder names. |
| `shared/actions.ts` | Ask's registry: 16 verbs (§13) with closed schemas and the flags `changesData`, `alwaysConfirm`, `spendsBudget`; `needsApply`, `verbAllowed` (`onlyVerb`), limits 8 actions / 500 items / 200 refresh items. |
| `shared/settings.ts` | One key per CORTEX-UX §5.27 row + `you` block; fail-safe migration (SAFE-08); no paths, no cache folder; version 3. |
| `shared/notesDoc.ts` | GistDoc (facets incl. project, parts, notes with block ids, cites), HubDoc (brief with cites), Cortex frontmatter keys (`cortex_*`, `made_by`, `conversation`, `space`). |
| `shared/cameraNumbers.ts` | `CAMERA_NUMBERS`: the one source for the camera numbers used by `render/tuning.ts` and the worker's `FIGURE.camera` (LIVE). |
| `shared/features.ts` | `BUILD_PHASE` and the phase of every gated feature (§19). |
| `shared/protocol/worker.ts` | Worker RPC with `viewId`, `dropView`, transfer rules (TRANSFER-DETACH), visibility, placement, grouping, arrangement (readings, ring sets), lines (`source \| stem \| spoke`), search shards, query tokens, stats kinds. |
| `shared/protocol/runner.ts` | Runner frames and commands incl. `import.inspect`, `import.estimate`, `agents.enqueue/dequeue`, `cache.clear`; `ai.ask` with `onlyVerb` and chart context; warning catalogue; error codes incl. `E_ENGINE_LIMIT`, `E_SETTINGS`; `hello` carries the build id. |
| `plugin/services.ts` | `SettingsHandle` (value, `signal`, corrupt, issues, update, reload), `RecordReader` (+ `revealHeld`), `LedgerService` (+ `workWaiting`), `DeviceHandle`, `SourcesService`, `NewEntryService`, `PinnedViewService`, `BackgroundServices`, `LeafServices`, `CortexServices`. |
| `state/types.ts` | Per-leaf slices (ui incl. tab, sheet, scope, period, tokens, command, popover, breakpoint…; view controls; selection; hover; legend; lit) and shared slices (data, activity, queues, receipts). |

Invariants: original text is never edited (corrections create versions); a machine string never becomes a
path, a command or code; every write goes through a minted path; every model call is logged with what it read;
nothing is deleted by Cortex.

---

## 4. Processes, threads and data flow

```
 Obsidian renderer process (Electron 39 / Chromium 142 / Node 22)
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ eager core: onload → view, ribbon, 36 commands, settings tab, status item, link and   │
 │   hover handlers, file/editor menus (< 50 ms; loadData only)                          │
 │ background tier (layout ready + 30 s idle, only after the first-run step):            │
 │   settings · runner client · agents clock · status bar · notices · ledger reader      │
 │ UI tier (first view open, import()): index · worker client · records · corrections ·  │
 │   Ask executor · renderer pool (≤ 3 live) · colours · sources · new entry · views     │
 │   per leaf: CortexView → leaf store → Preact App → RenderController (three.js)        │
 │      │ postMessage (viewId, transferables)          │ JSON lines over stdio           │
 │      ▼                                               ▼                                 │
 │  layout worker (Blob URL)               fallback: Node-integrated worker, then inline  │
 └──────────────────────────────────────────────────────────────────────────────────────┘
        ▲ fs.watch(<cache>/signal.json)                │ spawn(node, cortex-runner.js serve), cwd = cache
        │                                              ▼
 %LOCALAPPDATA%/cortex/<vaultKey>/  ◄── runner ──► vault (OneDrive): .raw/chats · .raw/written ·
   record.cxi/delta · vault.cxi · ordinals.cxo         .vault-meta/cortex · wiki/derived
   search shards · reads.cxr · stage/ · held/ · locks/      │ spawn claude.exe -p (no tools, allow-listed env)
```

- **Consent gate.** `plugin/background.ts` schedules the background start at layout ready + 30 s idle only
  when `firstRunDone` is true and settings are not corrupt; the runner refuses imports and agent runs until the
  first-run step has written the choice (SAFE-11). The first-run modal gets counts and the backlog estimate from
  `import.estimate` (a listing-only dry run).
- **Runner lifecycle.** Spawned with an allow-listed environment and `cwd` = the local cache
  (CHILD-CWD-ONEDRIVE); `hello` reports protocol, runner version and build id (RUNNER-VERSION-LICENSES); the
  watchdog fires only when a ping actually sent has been unanswered for 30 s (WATCHDOG-THROTTLE); three
  restarts in ten minutes mark it unavailable; on unload the clock stops first, then children are killed
  (`killAllChildrenSync`), and the runner kills its own children on SIGINT/SIGTERM/exit.
- **Live sessions** (LIVE-SESSION-SEMANTICS): complete messages of a live transcript are staged in the local
  cache at once (visible immediately, TextRef `stage`); the open message is held back; the vault receives one
  immutable segment when the session has been idle `liveIdleMinutes` (10) or at the nightly seal.
- **Index updates** (INDEX-DELTA-CONTRACT, REBUILD-PER-IMPORT): ordinals are allocated in arrival order and
  persisted (`ordinals.cxo`); an import appends a delta (`record.delta.cxi`, `[fromCount, count)`) and patches
  changed rows in place; the worker applies `appendIndex` / `patchIndex` and places only the new points; a
  changed epoch forces a full reload. Search uses immutable shards per closed ledger shard plus a live shard.
- **Flow of one new conversation:** Claude Code writes a transcript → the agents clock or the skill runs
  `import` → staged now, sealed into a segment later → ledgers + delta + `signal.json` → the plugin shows "‹n›
  new" (or applies with Refresh automatically) → held arrivals are born with a flash on Show them → 30 min after
  it goes quiet the scheduler runs `label` then `gist` within the budget → labels, a summary note and checks →
  delta + patch → colours and the key update.

**Single writer per artefact:**

| Artefact | Writer | Readers |
|---|---|---|
| Segments `.raw/chats/**` | runner (importers) | runner, plugin (readers) |
| Ledgers (entries, conversations, notes, labels, runs, reads, review) | runner | runner, plugin (LedgerService over cache aggregates) |
| `corrections.jsonl`, receipts | plugin only (user actions, applied Ask changes, check answers) | both |
| `wiki/derived/**` | runner (`notesWriter`) | Obsidian, plugin |
| `.raw/written/**` | plugin (NewEntryService) | runner (written importer) |
| `.vault-meta/cortex/state/{seq,budget,control}.json`, `sources.json` (import cursors live in the cache) | runner (control: plugin and runner, under the local lock) | both |
| `views.json` (pinned views), `state/colours.json` | plugin | plugin |
| `data.json` | plugin (`saveData`, backup first) | runner (read-only, retried, fail-closed) |
| cache folder | runner (record, search, reads, stage, held), plugin (vault.cxi, slots) | plugin, worker |

---

## 5. Module map and ownership

Every file has exactly one owner; collaborators are named in file headers but never co-own a file.

| Module | Owner files | Responsibility |
|---|---|---|
| **Architect** — contracts | `src/shared/{types,index-format,views,dims,actions,settings,notesDoc,features}.ts`, `src/shared/protocol/{worker,runner}.ts`, `src/plugin/services.ts`, `src/state/types.ts`, `src/types/globals.d.ts`, `tests/contracts.test.ts`, `tests/originality.test.ts`, `docs/ARCHITECTURE.md` | Frozen contracts, RFCs, the contract and originality tests. |
| **E1** — platform & kernel | `src/main.ts`; `src/plugin/{background,commands,commandRun,container,settingsStore,statusBar,notices,obsidianBridge,saveFile,deviceHandle,pinnedViews}.ts`; `src/node/{paths,fsAtomic,locks,gz,hash,spawn,platform,lineSplitter}.ts`; `src/shared/{cancel,errors,ids,jsonl,log,rng,sha256,text,time,validate}.ts`; `scripts/{build.mjs,build-config.mjs,build-config.d.mts,deploy.mjs,check-boundaries.mjs}`; `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.browser.json`, `vitest.config.ts`, `manifest.json`, `versions.json`, `.gitignore`, `README.md`; `tests/{kernel,node,build}.test.ts`, `tests/stubs/obsidian.ts` | Plugin entry and tiers, the 36 commands, settings persistence, status bar, notices, links / hover / file and editor menus, pinned views, device state handle, minted paths, atomic and exclusive writes, local locks, spawn, byte splitter, build and deploy. |
| **E2** — record store | `src/store/{layout,ledger,segments,cursors,manifest,signal,control,stage,notesWriter,recordReader,ledgerReader}.ts`, `src/shared/mdSafe.ts`, `tests/store.test.ts` | On-disk layout, size-rolled ledgers, immutable segments, live staging, control file, derived notes (inert markdown, ownership hashes, placeholders), RecordReader and LedgerService. |
| **E3** — importers I | `src/importers/{common,registry,claudeCode,claudeCodeClassify,rawDocs,passages,folders,written,vaultNotes}.ts`, `src/plugin/{sourcesService,newEntry}.ts`, `src/ui/modals/{AddSourcesModal,pickPath}.ts`, `scripts/sample-data.mjs`, `tests/importers-cc.test.ts`, `tests/fixtures/{claude-code,raw}/**` | Import framework (cursors, privacy, secrets held at import), Claude Code, `.raw/`, folders (copied into segments), New entry, vault notes; Sources service and the Add sources flows. |
| **E4** — importers II | `src/importers/{claudeAi,chatgpt,gemini,zip,jsonStream,html,inspect}.ts`, `tests/importers-exports.test.ts`, `tests/fixtures/{claude-ai,chatgpt,gemini}/**` | Export importers and `import.inspect` (recognise, preview, older-export check). |
| **E5** — runner & engine | `src/runner/{main,host,cli,commands,settingsLoader}.ts`, `src/agents/{engine,claudeCli,budget,privacy,scheduler}.ts`, `src/shared/secrets.ts`, `src/plugin/{runnerClient,agentsClock}.ts`, `skill/cortex-organise/SKILL.md`, `tests/runner-engine.test.ts`, `tests/fixtures/fake-claude.mjs` | Runner process and transports, CLI parsing with bounds, Claude CLI isolation and failure classes, probe, budget reserve/settle, withholding and redaction, scheduling, engine states, the agents clock. |
| **E6** — agent jobs & Ask | `src/agents/{jobs,prompts,schemas,validators}.ts`, `src/shared/packs.ts`, `src/plugin/aiExecutor.ts`, `src/ui/command/{AskConsole.tsx,slashCommands.ts}`, `src/ui/pages/ChangeHistory.tsx`, `tests/agents-jobs.test.tsx` | Label, summary, map, filing and name-check jobs; packs; prompts with JSON-line data blocks; schemas; validators (quotes, injection signals, evidence); Ask executor, console, slash commands, Change history. |
| **E7** — index, search & state | `src/plugin/{indexer,corrections,vaultSource,sampleRecord}.ts`, `src/shared/{indexCodec,searchCodec,spaces,vaultKinds}.ts`, `src/store/{indexBuilder,searchIndex}.ts`, `src/worker/{indexOps,search,sampleIndex}.ts`, `src/state/{store,actions,selectors,events,persist}.ts`, `tests/index-state.test.ts` | Ordinals and deltas, index and search builders and codecs, vault-note source, corrections fold (versions, pins, exclusions) and check answers, sample record, per-leaf state and named actions. |
| **E8** — layout worker | `src/worker/{layoutWorker,handler,anatomy,geom,placement,grouping,arrangements,lines}.ts`, `src/plugin/{workerClient,colourSlots}.ts`, `tests/layout-worker.test.ts` | Worker host and per-view state, the lying figure, placement (τ, fronds, wedges, roles), sticky colour slots, Groups layouts, line segments. |
| **E9** — charts & statistics | `src/worker/charts/{common,registry,compare,time,rhythm,connections,readings}.ts`, `src/worker/stats.ts`, `src/ui/pages/ChartPage.tsx`, `src/ui/stage/{ChartOverlay,Readings}.tsx`, `src/styles/charts.css`, `tests/charts.test.tsx` | The 18 chart layouts, readings, Top N, combines, ring sets; every statistic the pages need (CORTEX-UX §12.17); the Chart page and overlay. |
| **E10** — renderer | `src/render/{renderer,controller,camera,picking,shaders,animation,overlay,fallback2d,glCaps,governor,rendererPool,exportPicture,silhouette}.ts`, `src/render/layers/{points,haze,lines}.ts`, `tests/render.test.ts`, `tests/smoke/gl-worker-probe.html` | WebGL2 pipeline per CORTEX-UX §6: points and glow, colour states, scope turn, growth, camera and drift, picking, lines with hover pick, pool of ≤ 3 live renderers, governor, Save image, still frames, 2D fallback. |
| **E11** — shell & design system | `src/ui/{CortexView.ts,mount.tsx,App.tsx,context.ts,breakpoints.ts,icons.ts,deviceState.ts,keymap.ts}`, `src/ui/header/*`, `src/ui/stage/{Stage,CanvasHost,KeyBar,KeyPopover,LayersMenu,ShapeBar,ToolColumn,DisplayPopover,Compass,Banner,Toasts,Tooltip,LabelLayer,MemberCard,LiveRegion,FirstRunCard,Hints,ImmersivePill,StillFrame}.tsx/.ts`, `src/ui/strip/{TimeStrip,PeriodPopover}.tsx`, `src/ui/sheet/{Sheet,SheetHeader}.tsx`, `src/ui/primitives/{buttons,controls,menu}.tsx`, `src/ui/primitives/dimMenu.ts`, `src/ui/modals/{FirstRunModal,ConfirmModal}.ts`, `src/shared/palette.ts`, `src/styles/{tokens,shell,stage}.css`, `styles.css`, `tests/ui-shell.test.tsx`, `tests/helpers/fakeServices.ts` | The view and its leaf lifecycle, header, stage overlays, strip, sheet container, command line host, hints and checklist, keyboard scope, breakpoints, tokens and palettes, primitives, first-run step. |
| **E12** — pages, readers, settings & copy | `src/ui/copy.ts`, `src/ui/valueLabels.ts`, `src/ui/command/{CommandLine,Tokens,FindResults}.tsx`, `src/ui/pages/index.ts`, `src/ui/pages/{PageFrame,Read,Time,SpineFigure,RhythmGrid,TimeData,Agents,Checks,AccessLog,Sources,Guide,RunsLedger,NewEntry}.tsx`, `src/ui/reader/{Reader,EntryReader,ConversationReader,NoteReader,MapReader,NotePeek,Thread,FactsGrid,FrondScrubber,HistoryList,SafeMarkdown}.tsx`, `src/ui/reader/inertMarkdown.ts`, `src/ui/modals/CorrectionModals.ts`, `src/plugin/settingsTab.ts`, `src/styles/pages.css`, `tests/ui-pages.test.tsx` | All copy and value labels, Find, every sheet page and reader, correction dialogs, the inert renderer, the settings tab. |

Shared fixtures not listed above (`tests/fixtures/*` per source) belong to the importer that reads them.
`docs/CORTEX-UX.md` and `docs/mockups/**` belong to the product designer and are inputs to this team.

---

## 6. Surface ownership index (every CORTEX-UX surface → module, files, interfaces)

| CORTEX-UX | Surface | Owner · files | Interfaces |
|---|---|---|---|
| §1.3, §2.1 | Glyph, ribbon, view type, commands, settings tab, status item, links, hover source, file and editor menus, daily note, notices | E1 · `main.ts`, `ui/icons.ts` (E11), `plugin/{commands,commandRun,statusBar,notices,obsidianBridge}.ts` | `registerCommands`, `runCommand`, `statusBarModel`, `createNoticeService`, `parseCortexLink`, `ObsidianBridge` |
| §2.2, §2.4, §2.5 | View, immersive header, view state, keyboard scope, pop-outs, several tabs, breakpoints | E11 · `CortexView.ts`, `mount.tsx`, `breakpoints.ts`, `keymap.ts`; E7 `state/persist.ts`; E10 `rendererPool.ts` | `captureLeafState`/`restoreLeafState`, `classify`, `sheetMode`, `KEYMAP`, `RendererPool` |
| §5.1 | Header: brand, scope picker, page tabs + badge + dots, guide, Live, held arrivals, agent chip, Add sources, settings, More | E11 · `header/*` | `openTab`, `agentChipState`, `badgeText`, `openAddSources`, `moreItems` |
| §5.2 | Stage: canvas, gestures, empty state + checklist, hints, vault-only banner | E11 · `stage/{Stage,CanvasHost,FirstRunCard,Hints,Banner}.tsx`; E10 `controller.ts` | `createRenderController`, `DeviceHandle` |
| §5.3 | Key bar, chips, pickers, Layers, key popover | E11 · `stage/{KeyBar,KeyPopover,LayersMenu}`, `primitives/dimMenu.ts` | `dimMenuModel`, `toggleGroup`, `soloGroup`, `setColourMode`, `setLayer` |
| §5.4, §6.12 | Shape bar, morph, layouts, pose, core order, placement | E11 · `stage/ShapeBar.tsx`; E8 `arrangements.ts`, `placement.ts` | `setShape`, `setMorph`, `PlacementParams`, `ArrangementParams` |
| §5.5, §5.6 | Tool column; Display popover (Points, Motion) | E11 · `stage/{ToolColumn,DisplayPopover}.tsx` | `setLook`, `setMotion`, `resetDisplay` |
| §5.7, §6.7 | Compass and the scope turn | E11 · `stage/Compass.tsx`; E10 `camera.ts`, `shaders.ts` | `setScope`, `stepScope`, `SCOPE_TIMING`, `driftAngles(heading)` |
| §5.8 | Time strip, period brush and picker, Custom…, bracket, Undated | E11 · `strip/{TimeStrip,PeriodPopover}.tsx`; E9 stats `strip` | `setPeriod`, `parsePeriod`, `StatsParams{kind:"strip"}` |
| §5.9 | Command line Find, tokens, results | E12 · `command/{CommandLine,Tokens,FindResults}.tsx`; E7 search | `addToken`, `QueryParams`, `SearchResult` |
| §5.10, §12.7 | Ask console, slash commands, changes, proposals, errors | E6 · `command/{AskConsole,slashCommands}`, `plugin/aiExecutor.ts`; runner `ai.ask` | `AssistantExecutor`, `validateActionCall`, `AiAskArgs.onlyVerb` |
| §5.11 | Toasts, status bar, notices, agent chip states | E11 `stage/Toasts.tsx`; E1 `statusBar.ts`, `notices.ts` | `ActivityState.engine`, `NoticeService` |
| §5.12, §6.9 | Tooltip, label chips, selection, map member card | E11 · `stage/{Tooltip,LabelLayer,MemberCard}.tsx`; E10 picking | `HoverState`, `nearestSegment` |
| §5.13 | Sheet: stack, crumb, width, skeletons, error card | E11 · `sheet/*`; E12 `pages/PageFrame.tsx` | `pushSheet`, `sheetBack`, `setSheetWidth`, `Load` |
| §5.14 | Entry reader (facts, date evidence, inert text, scrubber, attachments, labels, cited by, related, History, where it lives, edit as version, secrets) | E12 · `reader/{EntryReader,FactsGrid,FrondScrubber,HistoryList,SafeMarkdown}`, `inertMarkdown.ts` | `RecordReader.entry`, `revealHeld`, `CorrectionService.apply` |
| §5.15 | Conversation reader (frond) and machine notes; the summary file format | E12 · `reader/{ConversationReader,NoteReader}`; E2 `notesWriter.ts` | `RecordReader.conversation/note`, `renderGistMarkdown` |
| §5.16 | Map reader, Flag | E12 · `reader/MapReader.tsx` | `NoteDetail.members/activity/evidence`, `evidenceMeter` |
| §5.17 | Vault note peek | E12 · `reader/NotePeek.tsx` | `RecordReader.noteMarkdown`, Obsidian `MarkdownRenderer` (vault notes only) |
| §5.18 | Read (segments, Pinned only, Today, sort, folder tree, maps filter, rows) | E12 · `pages/Read.tsx`; E9 stats `read`, `today` | `daySection`, `mapRecency`, `PinnedViewService` |
| §5.19 | Time (rhythm grid, spine figure, brush, longest conversations, Data view) | E12 · `pages/{Time,RhythmGrid,SpineFigure,TimeData}`; E9 stats `spine`, `rhythm`, `voices`, `data` | `shareTrend`, `tableToCsv`, `tableToMarkdown` |
| §5.20 | Agents: status card, engine lines, Today, Work waiting, Recent runs, Label packs, Last 14 days, Privacy, Access log | E12 · `pages/{Agents,AccessLog}`; E5 status; E2 ledger | `LedgerService.{runs,budgetHistory,workWaiting,accessLog}` |
| §5.21 | Checks (filters, cards, keys, mentions, conflicts, hold mode) | E12 · `pages/Checks.tsx`; E6 cards; E7 answers | `LedgerService.checks`, `CorrectionService.resolveCheck`, `keyToAnswer` |
| §5.22 | Sources (rows, attention), Files, Privacy (Off limits, left out, what is sent) | E12 · `pages/Sources.tsx`; E3 `sourcesService.ts` | `SourcesService`, `CorrectionService.leftOut/include` |
| §5.23 | Guide (five cards, keyboard table, sample) | E12 · `pages/Guide.tsx` | `GUIDE_CARDS` |
| §5.24 | New entry | E12 · `pages/NewEntry.tsx`; E3 `newEntry.ts` | `NewEntryService`, `writtenEntryPath` |
| §5.25, §7 | Chart page, gallery, zones, readings, options, Top N, folders, pin / save / CSV / table | E9 · `pages/ChartPage.tsx`, `worker/charts/*`, `stage/{ChartOverlay,Readings}` | `ChartSpec`, `ArrangementResult.readings`, `zoneFallback`, `clampTopN` |
| §5.26 | First-run step; Add sources (drop zone, rows, flows, pills) | E11 `modals/FirstRunModal.ts`; E3 `modals/{AddSourcesModal,pickPath}.ts`; E4 inspect | `SourcesService.estimate/inspect/importNow`, `applyFirstRunChoice` |
| §5.27 | Settings tab (six sections, every row) | E12 · `plugin/settingsTab.ts`; contract `shared/settings.ts` | `SettingsHandle`, `SETTING_RANGES` |
| §5.28 | Checklist, hints, sample record, reset | E11 `deviceState.ts`, `Hints.tsx`; E7 `sampleRecord.ts`, `worker/sampleIndex.ts` | `DeviceHandle`, `sandbox` |
| §5.29, §5.31 | Banners, thin groups, system states | E11 · `stage/Banner.tsx`; E8 `SPARSE_GROUP`; E5 warnings | `WarningCode` catalogue → `copy.warnings` |
| §5.30 | Correction dialogs, thread, names and name check, leaving out, Change history, Ask history, runs ledger, held secrets | E12 `modals/CorrectionModals.ts`, `reader/Thread.tsx`, `pages/RunsLedger.tsx`; E6 `pages/ChangeHistory.tsx`; E3 held secrets | `isoFromFields`, `conversationSlice`, `matchesRun` |
| §6 | 3D art direction (geometry, placement, points, colour states, growth, camera, lines, labels, shapes, robustness) | E8 geometry and targets; E10 drawing | `anatomy.ts`, `placement.ts`, `shaders.ts`, `camera.ts`, `layers/*` |
| §8.1–§8.4 | Keyboard, commands, accessibility, performance UX | E11 `keymap.ts`, `stage/LiveRegion.tsx`; E1 commands; E10 governor | `bindingFor`, `FrameGovernor` |

---

## 7. State, events and persistence

- **Per leaf** (`createLeafStore`, H6): `ui` (tab, sheet stack and width, scope, period, query tokens, command
  mode, popover, key collapsed, immersive, breakpoint, hidden groups, preview, active note, revealed count),
  `view` (shape, morph, colour modes, layers, motion, look, chart spec), `selection`, `hover`, `legend`, `lit`.
  Tokens (H4): same-kind OR, cross-kind AND; selection is separate. Period is per leaf.
- **Shared** (`createSharedStore`): data status (epoch, available count), activity (engine `ok | offline | auth |
  missing | limit | unsafe`, resumeAt, importing, warnings, corrupt settings, runner mode), queues (label,
  summaries, maps, checks, per source), receipts.
- **Persistence**: `getState`/`setState` carry `captureLeafState` (validated on restore; garbage → defaults).
  Pinned views store the same object in `.vault-meta/cortex/views.json`. Hints and the checklist are per device
  (`app.saveLocalStorage("cortex:hints")`, `ui/deviceState.ts`). Settings reach every leaf through
  `SettingsHandle.signal`; `onExternalSettingsChange` reloads, migrates and sets (SERVICES-CONTRACT-GAPS).
- **Events** (`state/events.ts`): index loaded / patched, arrivals, settings changed, active note, checklist
  step, warnings. Handlers are isolated (a throwing handler never breaks the others).
- **Named actions** (`state/actions.ts`) are the only way UI, commands, keys, hints and Ask change a leaf, so view
  changes can be undone.

---

## 8. Protocols

### 8.1 Plugin ↔ layout worker (`shared/protocol/worker.ts`)

Calls carry `viewId`; the worker keeps per-view state and drops it on `dropView`. Methods: `init`, `loadIndex`,
`appendIndex`, `patchIndex` (epoch-checked, `E_EPOCH` → reload), `loadSearch`/`addSearchShard`, `placement`,
`grouping` (sticky slots, `newSlots` to persist), `arrangement` (groups and charts, readings, ring set for a
map's sources), `lines` (`source | stem | spoke`, ≤ 60,000 segments, owner and target ordinals for hover
names), `search`, `related`, `query` (tokens + visibility), `stats` (`strip | spine | rhythm | voices | data |
read | sources | today | packs | hours`), `loadSample`. Results transfer only buffers they own entirely and that
are not worker state (`prepareTransfer`, TRANSFER-DETACH); views and state buffers are copied.

### 8.2 Plugin ↔ runner (`shared/protocol/runner.ts`)

JSON lines over stdio (child) or `postMessage` (worker / inline). Frames: `hello {protocol, runner, build, node,
pid, mode}`, `ping`/`pong {n}`, `req {id, ctx, command}`, `progress`, `event` (`entries-added`, `engine-state`,
`warning {code}`), `result`, `error {code}`. `ctx` carries vault root, vault key, cache folder, settings and
their source. Commands: `doctor`, `import` (selectors incl. `vault-notes`; `maxSeconds`, `resume`, `seal`),
`import.inspect`, `import.estimate`, `index.build`, `search.build`, `agents.run` (`maxJobs`, `maxSeconds`,
`dryRun`), `agents.status`, `agents.enqueue`/`dequeue`, `ai.ask` (ids and titles only, thread, timeout,
`onlyVerb`, chart context), `cache.clear` (known names only, never recursive), `ledger.compact`. Errors and
warnings come from fixed catalogues, never raw text (SAFE-17); the UI maps codes to CORTEX-UX §5.31 copy.

### 8.3 CLI and the skill

`cortex-runner.js <doctor|import|agents run|agents status|serve> --vault <path> --json`, with defaults
`--max-seconds 90` and `--max-jobs 10` (SKILL-LONG-RUNS) and `partial: true` when a bound stops a run. The
skill (`skill/cortex-organise/SKILL.md`) treats output as data and runs long work in bounded batches.

---

## 9. On-disk formats and concurrency

### 9.1 Where things live

| Path | Contents | Notes |
|---|---|---|
| `.raw/chats/<source>/<yyyy-mm>/<conv>/<nnnn>.jsonl.gz` | Immutable record segments (Claude Code, exports, folders, `cortex-ask`) | Root has `.gitignore` `*`; the number comes from the folder under a local lock (SEGMENT-SEQ-DEADLOCK); exclusive create. |
| `.raw/written/<yyyy>/<mm>/<yyyymmdd-HHmm>-<slug>.md` | New entries | Plugin writes exclusively; Undo = exclude. |
| `.vault-meta/cortex/<ledger>/<yyyy-mm>/<nnnnnn>.jsonl` | Ledgers: entries, conversations, notes, labels, runs, reads, review, receipts | Size-rolled at 8 MB; closed shards immutable (LEDGER-SHARD-SIZE). |
| `.vault-meta/cortex/corrections.jsonl` | Every fix (versions assigned under the lock, SAFE-13; pins; check answers) | Plugin only. |
| `.vault-meta/cortex/state/{seq,budget,control,colours}.json`, `sources.json`, `views.json` | Sequence, budget (reserved + open), control (paused, privacyRev), colour slots, source manifest, pinned views | Atomic replace. |
| `.vault-meta/cortex/trash/<noteId>/<sha8>.md` | Previous bytes of a derived note turned into a placeholder | Undo restores exactly (SAFE-12). |
| `wiki/derived/gists/<yyyy>/…md`, `wiki/derived/maps/<project\|area\|topic>/…md` | Summaries and maps (CORTEX-UX §5.15 template) | Exclusive create with `-2`, `-3`; rewritten only when the owned hash matches (DERIVED-NOTE-SHA). |
| `.obsidian/plugins/cortex/` | Plugin files, `data.json`, `.data.json.bak`, create-only `.gitignore` `*` | Deploy writes only here. |
| `%LOCALAPPDATA%/cortex/<vaultKey>/` (marker `.cortex-cache`) | `record.cxi`, `record.delta.cxi`, `vault.cxi`, `ordinals.cxo`, `offsets.bin`, search shards, `reads.cxr`, `agg/`, `stage/`, `held/`, `locks/`, `state/cursors.json`, `exports/`, `logs/`, `tmp/` | Never synced. Export copies live here (SAFE-07). |

### 9.2 Atomic writes, locks and OneDrive

- `writablePath(vaultRoot, rel)` mints a `WritablePath` only inside the hard-coded roots (`.raw/chats/`,
  `.raw/written/`, `wiki/derived/`, `.vault-meta/cortex/`, `.obsidian/plugins/cortex/`), outside the deny list,
  ≤ 240 characters, never `wiki*.md`, and only when the root's nested `.gitignore` exists
  (`ensureCortexRoots`, create-only). Writers re-assert (`assertMinted`).
- Replace = temp + fsync + rename with retries; publish = temp + fsync + `link` (EEXIST never replaces); appends
  retry; temp files are cleaned only when older than 10 minutes and their writer is dead
  (APPEND-RETRY-TMP-GITIGNORE).
- Locks live in the local cache (`locks/<sha1>.lock`), stale after 60 s (inline runner ≥ 5 min), broken by atomic
  rename, verified by token before a commit (LOCKS-SHARED-SYNCED, SAFE-14).
- `control.json` is re-read before every engine call and import unit; unreadable = paused (SAFE-03).
- OneDrive conflict copies of Cortex files are never merged; Sources › Needs attention lists them.
- Files-On-Demand: a segment not on this computer reads as `not-local` with Try again / Fetch now.

### 9.3 Text references

A record entry points at a segment line, a byte range of a `.raw/` file verified by sha-256
(`changed-at-source` on mismatch, INPLACE-TEXTREF), or a staged line. Folder sources are copied into segments
at import, so their text can never change underneath a citation (M6).

---

## 10. Importers

Common contract (`importers/common.ts`): stream with the byte splitter from a cursor; honour exclusions (fixes
and settings), off-limits paths and `mayContinue` (control file, deadline); run the high-confidence secret
detector and replace spans with a marker, keeping originals under `held/` (SAFE-10); emit EntryRecords,
ConversationRecords and segments; report `staged`, `secretsHeld`, `partial`; never read text the user left out.

| Source | P | Notes |
|---|---|---|
| Claude Code (`claudeCode.ts`, `claudeCodeClassify.ts`) | P0 | Primary. Live staging, subagents and automated sessions hidden by default, tool output and thinking off. |
| Vault notes (`vaultNotes.ts`, `plugin/vaultSource.ts`) | P0 | Reference notes (`status: reference`) hidden and never sent; Obsidian's excluded files apply. |
| `.raw/` documents (`rawDocs.ts`, `passages.ts`) | P0 | In-place byte-range refs; Roblox creator docs are reference (licence line); API dump skipped. |
| New entry (`written.ts`) | P2 | From `.raw/written/`. |
| Folders (`folders.ts`) | P1 | Copied into segments; speaker Mine · Another person's · Ask per file; watch. No inbox (M16). |
| Claude.ai, ChatGPT (`claudeAi.ts`, `chatgpt.ts`, `zip.ts`, `jsonStream.ts`) | P1 | Kept branch only; edits and regenerations become versions; older-export check. |
| Gemini Takeout (`gemini.ts`, `html.ts`) | P2 | Grouped at 30-minute gaps; HTML Takeout refused with guidance. |
| Inspect / estimate (`inspect.ts`, runner) | P1 / P0 | Recognise drops; first-run counts and backlog. |

---

## 11. Agents

### 11.1 Engine invocation (`agents/claudeCli.ts`)

`claude -p --output-format json --input-format text --model <alias> --effort <low|medium|high> --tools ""
--restricted --permission-mode dontAsk --disallowedTools <built-ins> --strict-mcp-config --safe-mode
--disable-slash-commands --no-session-persistence --permission-prompts none --max-turns 4
[--system-prompt-file f] [--json-schema s] [--max-budget-usd x.xxxx]`, prompt on stdin, `cwd` an empty local
folder, environment from an allowlist (+ `DISABLE_AUTOUPDATER=1`; ANTHROPIC_* only for a future API engine).
Model aliases must match `^[a-z0-9][a-z0-9.-]{0,63}$`. `probe` reads `--version` and `--help` (whole-token flag
match) and refuses a CLI that lacks a mandatory flag. Failures are classified from structured fields only
(subtype, exit code, API status, stderr): `E_ENGINE_AUTH`, `E_ENGINE_MISSING`, `E_ENGINE_LIMIT` (with
`resumeAt`), `E_BUDGET_CAPPED`, `E_TIMEOUT`, `E_VALIDATION` (CLI-FAILURE-CLASSIFY). Sign-in and missing-CLI
set the engine state instead of pausing; a free probe every 5 minutes resumes work.

### 11.2 Jobs, packs, prompts and validation

Jobs: `label` (packs `session` for conversations, `placement` for notes), `gist` (summary: gist ≤ 300, facets,
parts with notes and cites, answers open comments), `hub` (maps: project, area, topic; brief 3–5 bullets with
cites), `filing` (always checks, never applied), `name-check` (mention checks from `you.names`/`handles`),
`answer` (Ask). Every job has an explicit effort. Prompts render record items as one JSON object per line inside
a per-call boundary (SAFE-09). Validators: closed schemas (own properties only, SAFE-15), ids from the shown
set, substantial exact quotes (≥ 12 characters or 3 non-stopword words), enum values, user-owned fields kept,
injection signals (`$=`, `dataviewjs`, fences, `<script`, `<iframe`, `javascript:`, `obsidian://`, `](`, `![`,
`[[`, `::`) drop the field and raise a check and a warning. Evidence meters are computed by Cortex from cited
speakers, never claimed by the model.

### 11.3 Budget, schedule, checks

Budget = tokens per local day (default 1,000,000). Under the budget lock a call reserves its estimate before it
runs and settles to the real usage afterwards (BUDGET-RESERVE). Scheduler: answer > label > gist > filing >
name-check > hub; only while idle (60 s) and at the nightly pass; retries 30 s / 2 min / 10 min; reference
notes and left-out material are never targets. Each label or summary run appends one check per target with
confidence and a ≤ 140-character reason; "Hold for my check" stores labels as `held` until confirmed (M5).

---

## 12. Ask: questions and changes

`AssistantExecutor.ask` retrieves ≤ 40 candidates (ids and titles), the runner reads and filters the text, the
model returns `{reply, citations[], actions[], reasons?}`; citations are verified against the exact version;
actions are re-validated in the plugin (closed schemas, ≤ 8 per reply, ≤ 500 items, refresh ≤ 200, a slash
command's `onlyVerb`). Registry (CORTEX-UX §5.10):

| Verb | Kind | Apply |
|---|---|---|
| `trace`, `set_period`, `open_view`, `arrange`, `make_chart`, `pin` | view | never |
| `set_date`, `set_speaker`, `set_label`, `merge_groups`, `refile`, `exclude` | data | unless "Apply Ask's changes without asking" is on |
| `correct_entry`, `include` | data, alwaysConfirm | always |
| `refresh`, `propose_filing` | spendsBudget | always, with Cortex's own estimate |

Change text is written by Cortex from validated parameters and resolved targets; a model reason is stored
separately and shown labelled "The AI's reason". Undo of a data change never expires; Ctrl Shift Z redoes.
Exchanges are record entries of source `cortex-ask` (`.raw/chats/cortex-ask/`), hidden unless Layers › Ask
history is on, never offered back to retrieval or jobs by default. Try suggestions are computed without a
model call.

---

## 13. Renderer

CORTEX-UX §6 is normative for geometry, placement, sprite sizes, glow, tone mapping, colour states, growth,
camera and lines; constants live in `worker/anatomy.ts`, `worker/placement.ts`, `render/shaders.ts`,
`render/camera.ts` and `render/animation.ts` and are tested against the UX numbers.

- Pipeline: points, haze and lines draw additively (premultiplied, PREMULTIPLIED-BLEND) into an RGBA16F target,
  tone-mapped `1 − exp(−1.35 × brightness × hdr)` and composited over the stage; Paper uses normal alpha at 70%
  without halos or tone mapping.
- Colour states (§6.6): selected others × 0.06 and haze × 0.35; traced others × 0.12 and haze × 0.5; preview ×
  0.35; hidden × 0.06; outside the period × 0.06 in Body; outside the scope a per-point sink of 25% toward the
  core with a 300 ms fade, rising back over 400 ms; map beacon × 1.6 with a 2.4 s pulse.
- Camera: FOV 30°, home lying yaw 11° pitch −8°, drift ±26° over 12 s around the current heading, spin 16 s
  standing, Keep upright ±50° / ±30°, fly 520 ms, dock via `setViewOffset` 300 ms.
- Picking: R32UI id target cleared to zero before each pick pass (PICK-CLEAR-PROBE), ≤ 30 Hz; lines are picked
  by a nearest-segment test for hover names.
- Buffers: partial uploads are clamped to the live range (POINTS-TOUCH-NOOP).
- Pool: ≤ 3 live renderers, LRU; a hidden leaf releases GPU buffers after 60 s; a fourth leaf shows a still.
- Governor: frames > 22 ms for 2 s → DPR 1.25, then halos off, then haze halved, one toast.
- Robustness: context loss → still + banner + restore; no WebGL2 → 2D fallback still.
- Pop-outs: `contentEl.win` / `contentEl.doc` for frames, listeners and DPR (POPOUT-WINDOWS).

---

## 14. UI architecture

- One `ItemView` (`cortex-view`) per leaf mounts Preact into `contentEl` (`.cx-root`) after a race-safe open
  (generation counter, VIEW-OPEN-RACE), hides Obsidian's view header for its leaf, and rebuilds the pane menu in
  More. Layout (CORTEX-UX §3): header (44 px), stage (canvas + overlays), time strip (64 / 44 px), one right
  sheet (push at XL/L, overlay at M, full at S; Mini = brain only).
- Sheet routes come from `shared/views.ts`; `ui/pages/index.ts` maps page routes to components and
  `ui/reader/Reader.tsx` maps reader routes. Opening a header page replaces the stack; items push.
- Command line: Find (search tokens, results groups) and Ask (console) are mutually exclusive in place.
- Menus are Obsidian `Menu`s (`primitives/menu.tsx`); the dimension menu is built by `primitives/dimMenu.ts`.
- Modals: first-run step, Add sources, correction dialogs, confirmations (Obsidian `Modal`).
- Settings tab: `plugin/settingsTab.ts`, eager-safe (no Preact), six sections with native `Setting` rows.
- Copy: every string in `ui/copy.ts` (`t()` with typed keys); enum values through `ui/valueLabels.ts` (L7);
  record and machine text through `reader/SafeMarkdown.tsx` only (SAFE-01); vault notes through Obsidian's
  renderer in the peek.
- Tokens: `styles/tokens.css` ports `docs/mockups/src/tokens.css`; chrome binds to Obsidian variables, the stage
  and data colours are Cortex's own; light theme and Paper stage overrides; frosted panels can be turned off.

---

## 15. Performance budgets

| Budget | Target | How |
|---|---|---|
| Plugin load | < 50 ms eager evaluation (tested) | eager core only; `loadData` only |
| Background start | 0 ms on the critical path | layout ready + 30 s idle; child runner |
| View open → first frame | ≤ 50 ms silhouette; ≤ 800 ms with warm caches for 300,000 points | binary caches, worker placement |
| Steady frame | 60 fps at 300k points + 60k segments (1576 × 933, DPR 1.83) | GPU animation, picking ≤ 30 Hz, governor |
| Main thread per frame | ≤ 2 ms steady, ≤ 8 ms slices while loading | worker for layout, search, stats |
| Interaction | tooltip after 60 ms still; Find 150 ms debounce; key chip fade 150 ms; layout in worker ≤ 400 ms | |
| Memory | UI + GPU < 400 MB; worker < 400 MB; runner < 1.5 GB | typed arrays, streaming |
| Bundles | main.js ≤ 2.5 MB, runner ≤ 1.5 MB, worker ≤ 0.6 MB | `scripts/build.mjs` warns |

---

## 16. Security and privacy

1. **Markdown is code in this vault** (SAFE-01): Dataview JS is on, so `$=` spans and `dataviewjs` fences execute.
   Every model string and quote that reaches a file goes through `mdInert`; only Cortex writes structure
   (frontmatter, callout line, headings, list markers, block ids, `obsidian://cortex` links from validated ids);
   footnotes carry no quote text; validators drop fields with injection signals. Record text, documents and
   machine notes render through Cortex's inert renderer (no HTML, no embeds, no remote images, links only after
   a confirmation).
2. **What leaves the machine** — two egress paths: model calls (only after the first-run step, only through the
   runner, assistant replies from ChatGPT and Gemini withheld by default, keys / emails / phones / custom
   patterns redacted, every call logged in `reads/`), and **OneDrive sync, which is egress too** (SAFE-10):
   detected secrets are replaced in the vault copy and kept under `held/` in the local cache; caches, locks,
   staged live text and export copies never enter the vault.
3. **Containment**: the model has no tools, no MCP, no customisations, no session files, a restricted
   permission mode and an allow-listed environment; output is JSON validated against closed schemas; ids,
   quotes, enums and verbs are checked; nothing a model writes becomes a path, a command or code.
4. **Writes**: hard-coded roots, minted paths, deny list, nested `.gitignore`, exclusive creates, never delete
   (placeholders + trash for left-out notes), never rewrite a user-edited derived note (conflict check instead).
5. **Settings fail closed** (SAFE-08, SETTINGS-FAIL-OPEN): wrong types fall back to safe values; malformed
   exclusion lists mark settings corrupt, pause background work and block saving until resolved; the runner
   retries reading and fails with `E_SETTINGS`.
6. **Links and frames** (SAFE-17): `obsidian://cortex` only navigates (validated ids, vault-resolved paths,
   strict periods, pinned-view ids); runner frames carry codes and Cortex-built paths only.
7. **No shell**: `spawn(exe, args, {shell: false})`, absolute executables, `.cmd/.bat/.ps1` refused.
8. **Licences**: three.js and Preact MIT, listed in `THIRD-PARTY-NOTICES.txt` and kept as legal comments; Roblox
   creator docs carry their CC BY 4.0 line in readers; no font is bundled.

---

## 17. Testing

`npm run check` = `typecheck` (tsc for everything, tsc for browser layers without Node types, boundaries) +
`test` + `build`. Suites (owner): `kernel` (E1: commands = UX §8.2, onload, tiers, consent gate, links,
notices, settings migration, device state), `node` (E1: minted paths, exclusive writes, temp cleanup, locks,
byte splitter, spawn), `build` (E1: eager graph from the metafile, < 50 ms eval, runner version and build,
notices), `store` (E2: layout, segments, byte-range refs, control, budget, the §5.15 template, injection
contract, ownership hashes), `importers-cc` (E3), `importers-exports` (E4), `runner-engine` (E5: argv, env
allowlist through a fake CLI, probe refusal, failure classes, privacy, frames), `agents-jobs` (E6),
`index-state` (E7), `layout-worker` (E8: geometry and τ against UX numbers, sticky slots, handler,
transfers), `charts` (E9), `render` (E10: camera, multipliers, lines pick, pick clear, partial uploads, pool,
governor), `ui-shell` (E11: App without rail, sheet, checklist, Display, hints, breakpoints, keymap),
`ui-pages` (E12: every route and reader renders, inert renderer, page helpers), `contracts` and `originality`
(Architect). The fake CLI (`tests/fixtures/fake-claude.mjs`) never calls a model. GPU behaviour is checked by
`tests/smoke/gl-worker-probe.html` in a browser.

---

## 18. Dev loop

`npm install` (repo only) → `npm run dev` (watch build) → `npm run deploy:dry` → `npm run deploy` (copies
`main.js`, `manifest.json`, `styles.css`, `cortex-runner.js`, `THIRD-PARTY-NOTICES.txt` into
`<vault>/.obsidian/plugins/cortex/`, creates its `.gitignore` once) → reload with
`Obsidian.com plugin:reload id=cortex vault=claude-obsidian` and read `dev:errors`. Enabling the plugin the
first time is the user's decision. The runner can be exercised alone: `node dist/cortex-runner.js doctor
--vault <vault> --json`.

---

## 19. Phasing (from CORTEX-UX §9; every page has a milestone)

| Milestone | Scope |
|---|---|
| **M0 skeleton (done)** | Contracts, stubs, tests, build. |
| **P0 · M1 first light** | Eager core, settings tab (General, Sources, Agents, Privacy), first-run step and consent gate, background tier, Claude Code + vault notes + `.raw/` importers, store, index and search, worker placement of the lying figure, renderer (points, haze, glow, picking, drift, intro), header (five tabs), key bar + Layers, shape bar (Body ↔ Groups · Bubbles), tool column, Display (Motion), time strip with brush and age key, Find and tokens, toasts, status bar, notices, entry reader, conversation reader and machine notes (inert), Read (By date, folder, source; Pinned only), Time (figure: rhythm grid, spine figure, brush), Agents (status card, engine line, Today), Sources (Sources and Privacy tabs), label + summary jobs with the budget, undated cloud, Reset display. |
| **P1 · M2 understanding** | Compass and scope turn, Groups layouts (Tree, Along the spine, Strata), role placement, map reader and maps (hub job), map hover and spokes, lines (source, stems) with hover names, charts (P1 set) and the Chart page with readings, Ask with slash commands and Change history, Checks, Agents ledger (work waiting, runs, packs, last 14 days, Access log), runs ledger, Guide, first-run checklist and hints, Display points, period picker / Custom… / `set_period`, live arrivals, corrections loop (reader Correct, Flag, correction dialogs), key popover tree, Claude.ai + ChatGPT + folders importers, Appearance settings. |
| **P2 · M3 depth** | Advanced settings, New entry, Read › Today, Time › Data, Sources › Files, Gemini, sample record, replay, link views, highlight tokens, Combine with…, Pin view, Save image… and Copy data as CSV, P2 charts (nested bubbles, arc diagram, beeswarm, radial heatmap, chord), semantic zoom, date seals, Layers › Ask history. |

`shared/features.ts` encodes these phases; commands of unshipped features use `checkCallback` and stay out of the
palette.

---

## 20. Review responses

Where a finding was not taken exactly as written, or two findings conflicted, the decision and the reason:

| Finding | Decision | Why |
|---|---|---|
| B2 vs ORIG-20 / ORIG-01 | Five header pages plus sheet routes (CORTEX-UX v1.1 §12.2), not B2's page list | The originality findings retire the You, Timeline and Navigator pages; B2's intent (every surface owned) is met by §6. |
| H9 vs ORIG-25 / §12.7 | `trace`, `open_view`, `make_chart` instead of `light`, `open`, `chart`; no `answer` or `unpin` verbs | The reply is a top-level field; unpinning is the Undo of `pin`; "light" was a traced expression. |
| SAFE-04 vs UX §5.10 | `refresh` and `propose_filing` always wait for Apply, even with "Apply Ask's changes without asking" on | Spending tokens must always show Cortex's estimate first; the UX table marks them "yes", this is stricter. |
| `onlyVerb` (§12.7) | Accepts a verb or a verb family | `/correct` covers wording, date and speaker (three verbs). |
| M10 | Ask exchanges under `.raw/chats/cortex-ask/` (source `cortex-ask`) | The UX renamed `assistant-pane`; one location in both documents. |
| §12.7 receipts path | `receipts/<yyyy-mm>/<nnnnnn>.jsonl` (the month as a folder of size-rolled shards) | LEDGER-SHARD-SIZE and SAFE-07 require rolling by size; the month granularity of the UX path is kept. |
| §12.8 engine states | `ok · offline · auth · missing` plus `limit` and `unsafe` | CLI-FAILURE-CLASSIFY reports Claude Code's usage limit with a reset time, and the probe can refuse a CLI that lacks a safety flag; both need their own copy. |
| ORIG-11 / SAFE-10 wording | "never sent to a model" instead of "kept on this computer"; the withheld marker reads "[assistant reply withheld from models]" | Imported text lives in the vault, which OneDrive syncs. |
| SAFE-02 vs M2 | Settings hold no paths and no exclusion lists of left-out items; left-out items are exclude fixes; Off limits stays a guarded settings list | One source of truth per concept; settings cannot redirect writes. |
| M16, SAFE-16 | No inbox folder | No feature writes there; fewer roots. |
| L6 | No bundled font | Obsidian's fonts; one decision in both documents. |
| L8 | Chart combines are local to the chart and saved with a pinned view; the key's "Merge with…" is the global fix | Exploring a chart must not recolour the brain. |
| M14 | Strip and its brush are P0; the period picker, Custom… and `set_period` are P1 | The strip is the age key and the P0 period control. |
| ORIG-10 floor | 5 ΔE floor plus the set rule, as CORTEX-UX §11 | The literal 8 ΔE rule fails even the palettes the finding accepts; `palette_check.py` is the gate. |
| CORTEX-UX §5.23 "Show me" | The Guide button reads "Show it" | `originality_check.py` bans "Show me" (ORIG-08) and runs over `copy.ts`. |
| UX example id `e_q3k2v7m4c5x2a9pd` | Ids use base32 (`a–z2–7`); `9` is not valid | The template test uses a valid id; the format is unchanged. |
| SAFE-18 | Left to the user: add `wiki/derived/` to wiki-lint's excludes | A vault edit outside Cortex's roots needs the user. |
| LAYER-TYPES | `tsconfig.browser.json` covers shared, worker, state, render and ui | Runs inside `npm run typecheck`. |

---

## 21. Traceability (where each finding lives)

| Findings | Applied in |
|---|---|
| ORIG-01…ORIG-23 | §0.2 table; `copy.ts`, `views.ts`, pages, readers, palette; enforced by `tests/originality.test.ts` |
| B1 | §0.1 |
| B2, H1, L1 | §5 module map, §6 surface index; `views.ts`; owner files |
| H2, BG-IMPORT-UNWIRED | §4 tiers; `plugin/background.ts`, `container.ts` `createBackground`, `BackgroundServices` |
| H3, H11 | `settings.sources.raw.referenceFolders`, `skipApiDump`, `agents.skipReference`; ItemFlag Reference / Automated; `rawDocs.ts` |
| H4, H6 | §7; `state/store.ts` per leaf, tokens, per-leaf period |
| H5, ORIG-12 | `EntryDetail` (versions, dateEvidence, history, secrets), `reader/EntryReader.tsx` |
| H7 | `index-format.ts` noteKind / hubType / hubStatus columns |
| H8 | `worker/anatomy.ts`, `placement.ts` (tested against §6.2–§6.3) |
| H9, SAFE-04 | §12; `shared/actions.ts`, `aiExecutor.ts` |
| H10 | §0.3 row 5; `AiCandidate` ids and titles only; runner privacy |
| M1, §12.8 | `ActivityState.engine`, `WarningCode` catalogue, `copy.warnings`, Agents status card |
| M2, SAFE-02 | `node/paths.ts` roots; settings without paths; exclusions as fixes |
| M3, SAFE-17 | `plugin/obsidianBridge.ts`, `main.ts` link and hover registration |
| M4, §12.17 | `StatsParams` kinds; `LedgerService.workWaiting`, access log |
| M5, M17 | §11.3; ReviewCard kinds; `agents.reviewMode`; `LabelRecord.state = "held"` |
| M6, INPLACE-TEXTREF | §9.3; folders copied into segments; sha-verified byte ranges |
| M7 | `GistDoc.addressedComments`; reader Correct boxes show waiting / answered |
| M8 | `plugin/colourSlots.ts`, `state/colours.json`, sticky `assignSlots` |
| M9 | worker `lines` method, `worker/lines.ts` |
| M10 | `AssistantExecutor` (cancel, progress, thread, history, changes) |
| M11 | `import.inspect`, `SourcesService.inspect` |
| M12 | defaults = CORTEX-UX §5.27 (`tests/kernel.test.ts`) |
| M13 | `worker/sampleIndex.ts`, `plugin/sampleRecord.ts`, `sandbox` |
| M14 | §19 |
| M15 | pins as corrections (`pin` action, `EffectiveCorrections.pinned`) |
| M16, SAFE-16 | no inbox; deploy writes the plugin `.gitignore` |
| L2 | `plugin/commands.ts` = §8.2 (test reads the UX table) |
| L3, L5 | `render/{exportPicture,governor,silhouette}.ts` (E10); CSV in `TimeData.tsx` / chart stats (E9) |
| L6 | no font (`package.json`, build, tokens) |
| L7 | `ui/valueLabels.ts` |
| L8 | §20; `ChartSpec.merges`, key "Merge with…" = `merge_groups` |
| ENV-INHERIT, SAFE-05 | §11.1; `claudeEnv`, `buildClaudeArgs`, fake-CLI test |
| TRANSFER-DETACH | `prepareTransfer`, `ownsBuffer`, worker test |
| SEGMENT-SEQ-DEADLOCK | `nextSegmentSeq`, `writeSegment` |
| POINTS-TOUCH-NOOP | `render/layers/points.ts` `touch` |
| INDEX-DELTA-CONTRACT, REBUILD-PER-IMPORT | §4; `index-format.ts`, worker `appendIndex`/`patchIndex`/`addSearchShard` |
| LOCKS-SHARED-SYNCED, SAFE-14 | `node/locks.ts` in the cache |
| LEDGER-SHARD-SIZE, SAFE-07 | `store/ledger.ts`, `SHARD_ROLL_BYTES` |
| SPLITLINES-BYTES | `node/lineSplitter.ts` |
| CLI-FAILURE-CLASSIFY | `classifyCliFailure` |
| SETTINGS-FAIL-OPEN, SAFE-08 | `migrateSettingsChecked`, `settingsStore.ts`, `runner/settingsLoader.ts` |
| VIEW-OPEN-RACE | `ui/CortexView.ts` generation counter |
| WATCHDOG-THROTTLE | `protocol/runner.ts` watchdog contract, `runnerClient.ts` |
| INLINE-FALLBACK-UI-THREAD | runner mode `worker` |
| DERIVED-NOTE-SHA | `notesWriter.ownedHash`, `mergeForeignFrontmatter` |
| SERVICES-CONTRACT-GAPS | `SettingsHandle.signal`, `RecordReader` (E2), `LedgerService` |
| BUILD-TEST-LAZINESS | `scripts/build-config.mjs`, `tests/build.test.ts` |
| PREMULTIPLIED-BLEND, PICK-CLEAR-PROBE | `render/shaders.ts`, `render/picking.ts` |
| LAYER-TYPES | `tsconfig.browser.json` |
| RUNNER-VERSION-LICENSES | build defines, `hello.build`, `THIRD-PARTY-NOTICES.txt` |
| CHILD-CWD-ONEDRIVE | runner `cwd` = cache |
| APPEND-RETRY-TMP-GITIGNORE | `node/fsAtomic.ts` |
| BUDGET-RESERVE | `agents/budget.ts` reserve / settle |
| LIVE-SESSION-SEMANTICS | `store/stage.ts`, `liveIdleMinutes` |
| POPOUT-WINDOWS | `contentEl.win` / `contentEl.doc` |
| SKILL-LONG-RUNS | `runner/cli.ts` bounds, `SKILL.md` |
| SAFE-01 | §16.1; `mdInert`, `notesWriter.ts`, `SafeMarkdown.tsx`, injection contract test |
| SAFE-03 | `store/control.ts` |
| SAFE-06, SAFE-10 | `shared/secrets.ts`; held secrets at import; `revealHeld` |
| SAFE-09 | JSON-line data blocks; `evidenceOf` |
| SAFE-11 | §4 consent gate; `FirstRunModal.ts`, `background.ts` |
| SAFE-12 | `tombstoneDerivedNote`, trash, conflict checks |
| SAFE-13 | correction versions under the lock |
| SAFE-15 | `shared/validate.ts` own properties; substantial quotes; id patterns |
| SAFE-18 | §22 user decision |

---

## 22. Open items and user decisions

| # | Item | Default until decided | Who |
|---|---|---|---|
| 1 | Lying pose as the default | Lying; one setting flips it | User |
| 2 | Exact model aliases on the user's plan | haiku / sonnet / opus | Builder (`doctor --live` with approval) |
| 3 | Add `wiki/derived/` to wiki-lint's excludes (SAFE-18) | Not changed | User (vault edit) |
| 4 | Track `wiki/derived/` in git | Nested `.gitignore` `*` | User |
| 5 | Retire the vault's older visualisation plugins | Untouched | User |
| 6 | Public timestamps for date seals | Off; explicit button (P2) | User |
| 7 | System Save dialog through Electron | Use it when present; else Downloads + notice (`plugin/saveFile.ts`) | Builder |
| 8 | Gemini and Claude.ai export shapes | As SPEC §7; verify with one real export each | Builder + user sample |

## 23. Build notes (integration pass)

State after pass 2: E1, E2, E3, E4, E5, E6, E7, E8, E9, E10, E11 and E12 are all built, with no stub left in `src` (the only `notImplemented` is the helper in `shared/errors.ts`). Pass 1 notes follow; the pass 2 section is at the end.

**Checks.** `npm run check` is green: both typechecks, `check-boundaries`, 271+ tests (`vitest run`) and the build. Also run headless on throwaway data: `node dist/cortex-runner.js doctor --json` (no `--live`, which would send a prompt), `import` / `index` / `search` / `agents status` on a `scripts/sample-data.mjs` vault, `npm run deploy:dry` (writes nothing). `tests/integration-sample.test.ts` repeats import → index → decode → layout worker placement in-process, with `LOCALAPPDATA` pointed at a temp folder (the cache is always `<local app data>/cortex/<vaultKey>`, SAFE-02).

**Contracts changed (from the RFCs in `docs/rfcs/`).**
- Standing is the default pose: `DEFAULT_SETTINGS.general.pose = "standing"`, new `general.poseChosen` (false), `SETTINGS_VERSION` 4. The migration reads a stored pose only once `poseChosen` is true, so an older build's "lying" reads as Standing. `defaultView()` falls back to `"standing"`. Lying stays an option (shape bar, per-leaf).
- `HazeKind` / `HAZE_KINDS` are `brain | nerve | thread | ring | brainstem | undated` (E8, E10); `worker/anatomy.ts` maps its fine sub-kinds onto them (guides and twigs share `nerve`).
- `SettingsHandle.useDefaults()`, `HoverState.line`, `ImportArgs.importChanged`, optional `JobContext.pluginVersion / deadline / promptVersions` (E1, E10, E3, E5).
- The bus declares `command`, `arrivals` and `warning`; `commandRun.emitLeafCommand` / `onLeafCommand` are plain `bus.emit/on("command")`. Command `toggle-drift` is now `toggle-motion` ("Spin on or off").
- `CortexServices.save(req)` (system Save dialog or Downloads, one place); `ColourSlotService` and `SlotMap` moved into `plugin/services.ts` so the browser typecheck does not reach Node.

**Container wiring (`plugin/container.ts`).** The UI tier now builds the real services: ledger reader with its folders, the node-backed correction and index services (`correctionsNode`, `indexerNode`), the sample-record controller (palette `toggle-sample`), Sources and New entry with their dependencies, colour slots with paths, and the agents clock with its schedule and log. `save-image` is handled by the canvas host (`controller.savePicture()` → `services.save`). The index loads when the services are built (first view open) and then follows the cache signal. The store context is built without touching the disk; `startBackground` creates the folders.

**Build split.** `main.js` compiled and evaluated in about 68 ms because it held the whole UI (three.js alone is 536 KB). The heavy half now lives in a lazy chunk: `src/lazyEntry.ts` is built by `scripts/build-config.mjs` `lazyOptions` (with the inlined layout worker), embedded in `main.js` as a deflated base64 string (`packLazy`, which keeps `main.js` far under its 2.5 MB budget) and inflated with Node's zlib, then compiled with `new Function` on first use (`src/lazy.ts`, with main.js's own `require` so `obsidian` resolves). From source (tests) `lazy.ts` falls back to a plain `import()`. `CortexView` receives the UI module through `host.loadUi`. `main.js` is still one file; its eager part is about 100 KB of code. `check-boundaries` lets root files import each other.

**Known gaps from pass 1** are superseded by the pass 2 section below.

## 23.1 Pass 2 (integration of E4, E6, E9, E12, LIVE and the review)

**Checks.** `npm run check` green with 426 tests. `tests/ui-shell.test.tsx` can report an `EnvironmentTeardownError` (a console line written while vitest closes) on some runs; the tests themselves pass.

**RFCs applied.**
- E6: `createAssistantExecutor` now gets its `AssistantDeps` in `container.ts` (runner, receipts ledger, ledger reader, corrections, index, worker, record reader, settings, shared store, leaf stores, sandbox); `styles.css` imports `src/styles/ask.css`; `AiAskResult` has `reasons` and `raw`; `CommandLine` opens the console when Ask mode text starts with `/`.
- E4: `ExportImportStats` lives in `shared/protocol/runner.ts`; new warning `export-truncated` (copy in `warnings.*`, shown in Add sources and Sources); `InspectResult.truncated` and `skippedActivity` are set by `importers/inspect.ts`. `SourcesService.importNow` returns `ImportResult`, and `listFolderFiles` / `saveFolderSpeakers` are part of the contract.
- E9: `save-image` and `copy-data-csv` are registered at feature `chartPage`; the key bar pickers drag with `application/x-cortex-dim`; Save image reads resolved label text from the overlay (`data-cx-label-key`). Not done: the `stage:chart` event (ChartFeed still asks the worker for its own arrangement; one extra layout per change, no behaviour gap).
- E12: Rhythm grid cells add weekday and hour group tokens (the worker's existing keys: weekday "1".."7" with Monday = "1", hour "00".."23"); `LedgerService.accessIds` and the Access log trace button; Read rows fetch the first 120 characters of an entry's original text lazily (conversation rows still show their message count).
- E7: `cache.clear` also removes `vault.cxi.key` and `search/*.sig`; the readers answer with `sampleTextResult` in the sample record (`RecordReaderDeps.sampleText`).
- E8: `PlacementParams.areaSlots` is declared and the renderer sends the colour slots of `space`.
- Already in place from earlier passes: pose default, haze kinds, `useDefaults`, `HoverState.line`, `importChanged`, `command` bus event, agents clock schedule, ledger and sources wiring, `toggle-motion`, `sourceControl`, the shared `cameraNumbers.ts` (`shared/cameraNumbers.ts` is the one source for the camera numbers in `render/tuning.ts` and `FIGURE.camera`).

**Review fixes (REVIEW).** The Claude Code probe accepts hidden-but-working flags; writes refuse symlinked folders; documents over 32 MiB are skipped; machine front matter and New entry text are made inert (no runnable Dataview or Templater).

**Live notes.** `BUILD_PHASE` stays P0, because `tests/kernel.test.ts` and others assert the P0 command and feature set. A temporary P1 build was run live to check the Chart page, ranked bars, the rhythm tokens and the Agents, Time, Read and Sources pages; none raised dev errors. Moving to P1 needs those tests to be updated by the phase owner.

**Known gaps.**
- Entering the sample record through the palette command `cortex:toggle-sample` did not turn it on the first time in the live check; the bus event did. The sample also shows a "33,500 new entries" arrivals banner at P1.
- Not run: real Claude Code, a real multi-GB export, `doctor --live`, Ask against Claude.
- E7 §4 (one corrections fold shared by importers and jobs) and E10 §5 (label columns in `LabelLayer`) remain optional.

## 23.2 Pass 3 (every feature on: BUILD_PHASE "P2")

**Shipped phase.** `BUILD_PHASE` is "P2". All 13 gated commands are plain callbacks; P0/P1 builds still use `checkCallback`. Contract changes of this pass are in `docs/rfcs/PASS3.md`.

**Landed.** Held arrivals use a per-load baseline (`ui/arrivals.ts`) and the person's own entries reveal at once; the sample record no longer counts as arrivals. More › Link views follows scope, period and tokens (`bindLink`). First-run consent gate, stage keyboard (`render/stageKeys.ts`), point gestures (`ui/stage/pointGestures.ts`), loading surfaces, replay playhead, find-in-conversation counter, Add sources progress. Index-failed and worker-off banners plus Export diagnostics. Date evidence: local seal blocks, git first-seen and the opt-in public timestamp (`store/dateEvidence.ts`). Ids compare with `compareIds`; undo of `propose_filing` goes through `review.discard`; folder chains are re-checked on every write.

**Integrator fixes (found live).**
- `deploy.mjs` does not build: run `npm run build` before it, or the old bundle is deployed.
- `cortex:toggle-chart` set the shape to body without morph 0, which left an empty stage; it now morphs (0 out, 1 in, default chart "ranked-bars").
- The "Arranging…" pill stayed forever when a shape had no arrangement to compute; it is now raised only while a worker call is in flight.
- `toggle-sample` builds the sample after the command returns (a `setTimeout`), so the command is instant.
- Test harness clock in `importers-cc.test.ts` never falls behind real time; before, a slow run made files "live" and the last line was held back (flake under load).

**Live check (sample record, Obsidian CLI).** Brain, Read, Time, Agents, Sources, Chart page, Guide, Today and Change history open with no errors. Standing figure with labels, lines and compass; selection with side sheet; Find; Ask console (not sent); Ranked bars with Copy data as CSV; Spin; Lying and back; time-strip period and hover preview; replay with Esc; Pin view says "Not available in the sample record". The settings tab renders all six sections (Advanced shows the seal toggle, "No blocks sealed yet." and Timestamp publicly), but Obsidian's settings modal would not open through `app.setting.open()` in this window (the active window was a blank one), so it was read from `tab.display()` rather than seen.

**Known gaps.** Link views was clicked but its effect on a second leaf was not read back live (covered by `tests/link-views.test.ts`). Real mouse drag, wheel and right-click were not exercised. Public timestamps stop at the calendar receipt. Not run: real Claude Code, `doctor --live`, Ask against Claude.

## 23.3 Scale smoke test (`npm run scale`)

Cortex had only run on fixtures and the 29k-entry sample. `npm run scale` (`scripts/scale.mjs`, generator `scripts/scale-gen.mjs`, pipeline `tests/scale/pipeline.ts`) imports a synthetic vault the size of a first real import, outside `npm run check`:

- **What it builds** in a fresh folder under `os.tmpdir()` (deleted at the end; `--keep` leaves it): 17,000 notes in nested folders (front matter and `[[links]]`) plus 3,000 `.raw/` documents, 6 large ones of about 200 KB, a git repo over them with 2 commits, 300 Claude Code session files (3 of about 20 MB: one chatty with about 127,000 entries, two tool-heavy), and one ChatGPT export zip with 1,000 branching conversations. Synthetic only; nothing real is read.
- **What it runs** (the integration test's import-only pipeline, in-process runner, no claude CLI, no agents, seals off, git first-seen on): import each source, `index.build --full`, the git first-seen pass cold (`seals.run --force` after deleting its cache file), a second import with nothing changed, an incremental index build, 100 notes edited and re-imported, a live session that grows by two messages.
- **Isolation.** The vault, ledger, `wiki/derived`, `.vault-meta` and the cache all resolve inside the temp folder: the driver process gets `LOCALAPPDATA`, `XDG_CACHE_HOME`, `APPDATA`, `USERPROFILE`, `HOME` and the git config pointed there. Before and after, the script fingerprints (path, size, mtime) the real vault's `.vault-meta/cortex` and `%LOCALAPPDATA%/cortex` and prints whether they changed; it only stats them and never writes there.
- **Options.** `npm run scale -- --notes 2000 --raw 300 --sessions 30 --big-sessions 1 --big-mb 5 --conversations 100 --touch 20 [--keep]`. The full size takes about 5 minutes (about 2 of them generating, mostly `git` and file creation). `tests/scale-pipeline.test.ts` runs the same generator and pipeline at a tiny size inside `npm run check`; `tests/scale-pool.test.ts` covers the helpers.
- **Reading the numbers.** "rss" is the highest RSS sampled during the stage (timer and progress frames), "peak" the process's peak working set so far. The whole pipeline shares one process here, so the peak is higher than a single runner request would need.

**Measured** (Windows 11, NVMe, Node 24, full size: 251,792 entries from 20,006 vault files, 300 sessions (164 MB), 1,000 conversations; record index 28.5 MB on disk):

| Stage | Before fixes | After fixes | Peak RSS (after) |
|---|---|---|---|
| import Claude Code (300 files, 182,650 entries) | 57.9 s | 47.0 s | 497 MB |
| import vault notes (17,003) | 102.3 s | 28.6 s | 513 MB |
| import .raw documents (3,003 files, 43,662 entries) | 32.3 s | 16.9 s | 563 MB |
| import ChatGPT zip (1,000 conversations, 8,477 entries) | 26.8 s | 22.3 s | 578 MB |
| index build, full (251,792 entries) | 4.5 s | 4.4 s | 719 MB |
| git first-seen pass, cold (20,006 files) | 48.5 s | 12.8 s | 719 MB |
| re-import, nothing changed (20,307 files seen, 1 read: the export zip) | 9.2 s | 5.9 s | 766 MB |
| index build, incremental | 5.6 s | 5.6 s | 820 MB |
| re-import after editing 100 notes (100 read) | 10.9 s | 7.4 s | 826 MB |
| index build after the edit | 5.7 s | 5.7 s | 897 MB |
| one live session grew by two messages | not measured | 0.3 s | 897 MB |

No stage came near 2 minutes and the peak RSS (897 MB) stayed under the 1.5 GB line, so nothing was pathological in the sense of the brief. The git pass was already batched (one `git hash-object --stdin-paths` and one `git log --raw` for all files, never a process per file; `tests/scale-pool.test.ts` asserts two git calls for 400 files). What the run found, and fixed:

1. **One await per file.** Every importer and the git pass waited on the disk for each file in turn (open, stat and read take 1 to 3 ms each on Windows with real-time scanning), so most wall time was idle. `src/node/pool.ts` adds `mapLimit` and `readAhead`; `walkFiles` stats a folder's files 32 at a time; vault notes, `.raw` documents and folders decide (stat, read, hash) up to 8 files ahead of the loop (`documentsAhead` in `importers/common.ts`; files over 1 MB are read only when the loop reaches them, so memory stays bounded; order and per-file state are unchanged); the git pass checks that files still hold the imported bytes 16 at a time.
2. **O(n²) state writes.** The document state file (path to size, mtime, hash for every file) was rewritten whole after every 150 notes: 113 rewrites of a growing multi-megabyte file at 17,000 notes, and quadratic beyond (100,000 notes would write about 16 GB). `saveDocStateSoon` writes it at most every 5 seconds during a pass, and the end of the pass always writes it. A crash between saves is safe: the state is a cache, and a note already in the ledger is recognised by its id.
3. **Needless git pass.** The git first-seen pass reads the whole ledger and every file it names. An import now starts it only when it added entries from vault files (`obsidian`, `files`, `written`); Claude Code and export imports skip it. The pass still runs on the next import that adds vault files, and `seals.run` still runs it on demand.
4. **Stack overflow guard.** `rows.push(...list)` in the index builder (labels on a conversation) and in the `.raw` importer would throw `RangeError` beyond about 120,000 items (one session had 127,000 entries); both are plain loops now.

**Limits seen, left alone.** The ChatGPT import took 22 s for 1,000 conversations on a 240,000-entry ledger (one segment file per conversation, flushed to disk by design, plus one read of the whole ledger to know what is already there), so a 5,000-conversation export is a matter of minutes, not seconds. The index build reads the whole ledger every time (the "incremental" build only writes a delta), about 3.5 KB of RAM per entry: 750,000 entries would need about 2.5 GB. The git pass gives up (and treats the vault as having no git) if `git log` over the history takes more than 120 seconds. `git add` with a long path list is quadratic, so the generator uses `git update-index --stdin`.
## 23.4 Frame-rate governor and the display's cadence (pass 4)

Frame intervals are rAF intervals. On a 30 Hz screen, or in an unfocused leaf capped at 30 fps (§2.4), every
interval is 33 ms however cheap the frame was (Cortex draws a frame in about 0.4 ms of CPU). Under the plain
"over 22 ms for 2 s" rule, the governor therefore lowered detail and posted its toast on machines that were never
slow; this was seen live after a plugin reload.

A frame now counts as slow only when it is over 22 ms **and** over 1.5 × the expected interval. The expected
interval is the display's recent best cadence (capped at 28 ms, so 24–30 Hz screens pass), or the leaf's frame cap
when that is longer (`isSlowFrame` in src/render/governor.ts). The first 3 s after the loop starts, a resize or a new
placement never count, nor the 3 s after any stall of 250 ms or more (loading work on the main thread: index, sample,
arrangement). The renderer calls `governor.interrupt()` from `start`, `resize` and `setPlacement`; before
this pass nothing called it. A slow streak that overlaps a main-thread long task (PerformanceObserver "longtask",
over 50 ms) starts again: that slowness is Cortex's own loading or page work, which lower drawing detail cannot
help. A GPU that cannot keep up leaves no long tasks, so it is still caught. This was measured live: every frame drop
during reloads and page switches coincided with long tasks.

Trade-off: a GPU that holds a steady 25–30 fps on a 60 Hz screen from its very first frame is no longer stepped
down. A false "lowered detail" on a fast machine costs more than that. Tests are in tests/render.test.ts.

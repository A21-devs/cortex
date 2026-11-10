
## PHASE (P2 shipped)

- `shared/features.ts`: `BUILD_PHASE` is now `"P2"`; every feature is on. No change to ids or phases.
- `plugin/container.ts`: `BackgroundDeps.logSink?: LogSink` (additive). Tests pass a quiet sink so background work that outlives a short test no longer writes to the console during vitest teardown (the `EnvironmentTeardownError` in `ui-shell.test.tsx`).
- `plugin/commands.ts`: `registerCommands(plugin, run, phase = BUILD_PHASE)`. A command whose feature is on gets a plain `callback` (the Obsidian CLI and palette run it with no active Cortex leaf); only an unshipped one keeps a `checkCallback` that is always false.
- `plugin/commandRun.ts`: `toggle-sample` is a window-wide command: it reveals a leaf if it can but never waits for its store. Leaf commands that cannot open a leaf now say so (notice "failed") instead of doing nothing.
- `state/selectors.ts`: `heldArrivals` is 0 while `revealedCount` is 0 (the contract's "nothing held"). New `ui/arrivals.ts` (`keepArrivals`, bound in `bindShell`) sets each leaf's baseline to the loaded index count on every `index:loaded` (the sample record included), holds only `index:delta` items past it, and reveals them at once with Sources › Refresh automatically.
- `ui/header/MoreMenu.ts`: `bindLink` (bound in `bindShell`) wires Link views; `propagateLink` had no caller.


## STAB (leftovers and review items)

Shared-contract changes, all additive:

- `shared/ids.ts`: `compareIds(a, b)`. The base32 alphabet (`a-z`, `2-7`) puts digits after letters, so a plain string comparison of two ids that differ at a digit/letter boundary gives the wrong creation order. `plugin/aiExecutor.ts` (the "later change touched the same item" test and the change lists), `agents/scheduler.ts` (latest run) and `store/ledgerReader.ts` (checks, runs) now tie-break with it. This was the cause of the flaky Ask test "asks before undoing a change when a later one touched the same item": two ids made in one millisecond differ only in the random tail.
- `shared/types.ts`: `ReviewCardRecord.dismissedAt?: IsoDate`. Written by the runner's new `review.discard`; `ledgerReader.cards()` and `countOpenChecks` treat a dismissed card as closed.
- `shared/protocol/runner.ts`: command `review.discard` with `ReviewDiscardArgs { runId?; targets?; kind?; since? }` and result `{ discarded: number }`; lane `light` (`runner/host.ts`); handler in `runner/commands.ts`, logic in `agents/discard.ts`. It needs a run id or a list of targets (never "everything"), skips cards the person already answered, and never deletes: a newer line for the same card id carries `dismissedAt`. Undo of an applied `propose_filing` now sends `agents.dequeue` and then `review.discard { targets, kind: "filing", since }`; the change card says "Undo" for it ("Cancel" stays for refresh).
- `ui/context.ts` `StageEvents`: `"stage:chart": { viewId, spec, result, visibility, index }`, emitted by the render controller after a chart arrangement (E9 RFC 1; `visibility` and `index` are an addition to the RFC so the feed can tell the result answers its own question). `ChartFeed` adopts it instead of a second worker call when spec, visibility (revealed count 0 = all) and index identity match, and keeps its own call as the fallback (nothing was offered yet, or the settings differ).
- Chart option `rename:<dim>=<first value>` (a string in `ChartSpec.options`, no type change): the name of a combined category (CORTEX-UX 7.4). `worker/charts/common.ts` `combineNamesFor` applies it to the category label only when that value heads a combine; `ui/stage/ChartOverlay.tsx` `renamesOf`, `setCombinedName`, `renameInline` (double-click a combined label or its context menu > Rename...). `categoryName`, `overlayLabelText`, `readingText` take an optional names map.
- E12 RFC 1 (Read rows): the worker holds no message text, so the snippet stays a lazy read of the first entry of the conversation (the row's ordinal is already that entry). The row no longer shows a message count in place of text; the count moves to the row's tooltip, the area label is the line while the text loads.

Hardening:

- `shared/mdSafe.ts` `yamlScalar` also breaks up `[[links]]`, `![embeds]`, `](` markdown links, `::` inline fields, raw HTML tags (`<` before a letter, `/`, `!`, `?`) and link schemes (`javascript:`, `https://`, `www.` ...) in model-written front-matter values.
- `node/paths.ts`: `assertFolderChainClear(vaultRoot, relFolder)` checks the disk with no memory; `assertMinted` (called by every write helper) now checks the folder chain fresh before each write, so the 30 s memory only speeds up minting. `ensureCortexRoots` refuses a root whose chain holds a link or junction (before and after creating the folder) and still creates the nested `.gitignore` in every root.

Tests: `tests/stab-pass3.test.tsx`, `tests/review-safety.test.ts` (front-matter cases), `tests/agents-jobs.test.tsx` (propose_filing Undo), `tests/build.test.ts` (eager-eval budget measured as the best of 7 runs after a warm-up; still 50 ms).

## FIGURE (live figure pass)

- `src/ui/context.ts`, `StageEvents["stage:labels"]`: new optional `columns: { cx, pxPerUnit, brainBottom } | null`. The renderer now measures where the standing figure really is on screen (centre line, pixels per scene unit along the camera's right axis, lowest edge of the brain) and the label layer uses it instead of estimating from the safe frame; it falls back to its own estimate when absent.
- `docs/CORTEX-UX.md` §6.3: frond length is now f = clamp(0.55 + 0.14 ln(1 + n/10), 0.45, 1.0). The earlier 0.30 + 0.15 ln(1 + n/10) left most fronds of the sample record short, so the nerves read as a narrow fern inside the brain's width instead of a torso.
- `RelatedResult` (worker `related`): for a message of a conversation, `citedBy` and `lines` now cover every note built from any message of that conversation, not only from that one message. No type change.
- Lines: Selection draws only the selection's links (the worker's `related` lines); Lines: All draws every note's. Source lines are no longer re-routed in the renderer (the worker already returns curves).

## GAPS-UI (completeness audit of CORTEX-UX, ui gaps)

Contract changes, all additive:

- `src/ui/context.ts`, `StageEvents`: new `"stage:point"` (renderer → shell: click, dblclick, ctrl-click, context, preview on a point, with client x/y and the pointer event for the page preview) and `"stage:announce"` (Tab stepped to an ordinal; the live region says it). The controller no longer opens readers itself; the shell does (`ui/stage/pointGestures.ts`), so the §2.3 table lives in one place. `Shell.stopReplay` is set while Replay runs; Esc calls it (`escapeStep` gains an optional `replay` input).
- `src/state/types.ts`, `ActivityState.importing`: new optional `kept` (messages kept so far, from the importer's progress note). `trackImport` fills it.
- `src/plugin/services.ts`, `SourcesService.importNow(source, onProgress?)`: optional progress callback `{ done, total?, kept? }` so Add sources can draw "Reading ‹n› sessions…" with a bar.
- `src/shared/protocol/runner.ts`, `InspectResult.exchanges` (Gemini): prompt-and-reply exchanges to be imported, for "‹n› prompts and replies, grouped into ‹m› conversations".

Decisions:

- The Guide button stays "Show it" (CORTEX-UX §5.23 says "Show me"): `originality_check.py` bans "Show me" (ORIG-08). Already recorded in ARCHITECTURE §23.
- First-run step: Choose… on the Chat exports row is Start with the current choices, then Add sources (an export cannot be inspected before the consent gate). The "How long it takes" card is the runner's estimate with an unticked source's conversations and notes taken back out (same tokens-per-item figures as `importers/registry.ts`).
- Stage keys: Tab steps only while something is traced and leaves the stage at either end, so keyboard users are never trapped; Enter opens the stepped-to point (or the selection); Ctrl/Cmd+Enter is the new-tab gesture. The canvas is focusable (`tabindex 0`, described by the stage summary); the polite live region and the summary are now rendered by `Stage`.
- Your own entry: after New entry › Save the leaf reveals up to that entry's ordinal as soon as the index has it (`ui/arrivals.ts revealOwnEntry`); anything held from Claude Code later stays held. The arrivals toast says "‹n› new items in your record" when no Claude Code session produced them.
- Find in a conversation counts matches over the whole conversation (read a page at a time), steps with Enter / Shift+Enter or the arrows, and shows "‹i› of ‹n›" or "No matches".

## GAPS-DATA (system states, date evidence)

Shared-contract changes, all additive:

- `state/types.ts` `DataStatus.failure?: "last-good" | "none"`. Raised by `plugin/indexer.ts` when a build (`runnerBuild`) or a load fails, cleared by the next build that works; also sets `activity.lastWarning = "index-failed"` (the warning code was declared but nothing raised it). "last-good" = an earlier index is shown, "none" = there is none. Surfaces: stage banner kinds `index-failed` and `index-failed-none` (`ui/stage/Banner.tsx`, **Rebuild index** runs the `rebuild-index` command), and Sources > Needs attention rows from `SourcesDeps.health` (`index-failed` with `detail: "none"` for the second sentence, action `rebuild-index`; `runner-unavailable`, action `export-diagnostics`).
- `plugin/services.ts`: `CortexServices.exportDiagnostics()` (the existing `saveFile.exportDiagnostics`, now reachable). It works without the runner, which the Settings button did not (it asked the runner for `doctor`); Settings > Advanced uses it too. `EntryDetail.dateEvidence[].block?: number` (the seal block number for "Sealed on this computer in block N").
- `ui/pages/WorkerBanner.tsx` (new), one line each in `Agents.tsx` and `Sources.tsx`: the "background worker stopped three times" banner with **Export diagnostics**, shown while `activity.runner === "unavailable"`.
- `shared/protocol/runner.ts`: commands `seals.run { force? }`, `seals.status`, `seals.publish` (lanes io, light, io). `seals.run` is also what every `import` that adds entries ends with (`runner/commands.ts`), gated by `advanced.dateSeals.sealLocally` for the sealing part.
- `ui/copy.ts` `settings.advanced`: `sealedNone`, `sealedBroken`, `timestampConfirm`, `timestampWhat`, `timestampSend`, `timestamping`, `timestamped`, `timestampedAlready`, `timestampNone`, `timestampFailed`. `tests/stubs/obsidian.ts`: `apiVersion`, and `Setting` keeps its toggles and buttons (with the click handler) so tests can drive them.

Date evidence design (`store/dateEvidence.ts`):

- Evidence is NOT written into entries (the entries ledger is append-only and an entry's `dates` is fixed at import). It lives in sidecars the entry reader merges into `EntryDetail.dateEvidence`.
- Seals: immutable block files `.vault-meta/cortex/seals/<computer>/<n>.json` (<computer> = first 8 hex of sha256(hostname), so two computers never write one file), at most 5,000 entries each, each naming the hash of the previous block; a Merkle root over `sha256(id \n textSha256)`. A damaged chain is reported (`intact: false`) and no new block is linked to it. The folder is under `.vault-meta/cortex/`, which already carries its nested `.gitignore`.
- Public timestamp: explicit button only (confirmation first). Sends the 32-byte hash of this computer's newest block to the OpenTimestamps calendar `alice.btc.calendar.opentimestamps.org` (nothing else) and keeps the reply as a standard `.ots` file beside a small JSON record. The calendar's Bitcoin confirmation arrives later and is completed by the standard `ots upgrade` tool; Cortex shows the date it asked. Decision 6 of ARCHITECTURE stays: off by default, explicit button.
- Git first-seen: for entries whose original is a file inside the vault (`obsidian` and `files` sources with a vault-relative `sourceRef.path`). It counts only when the file still holds the imported bytes (sha256 equals `sourceRef.sha256`) and a commit introduced exactly the current blob (`git hash-object --stdin-paths`, so line-ending filters apply; `git log --raw` for the first commit with that blob). Cache file `<cache>/state/git-first-seen.json`; paths with no commit yet are looked at again after 6 hours; a vault outside git is noticed once and asked again after 6 hours.

Tests: `tests/date-evidence.test.ts` (including a real `git` repository when git is installed), `tests/gaps-data.test.tsx`, and two cases in `tests/index-state.test.ts`.

## PASS4 (FIX agent: sample record and label fixes)

Contract changes, all confined to the sample record (sandbox) or to pure helpers. Tests: `tests/fix-pass4.test.ts`.

1. **Sample maps list their members.** `RecordReader.note(ordinal)` in sandbox mode now fills `NoteDetail.members`, `activity` and `record.hub` (`hubType`, `status`, `range`, `members`, empty `brief`) for a map, from the index relation `rel.hubMembers`. The grouping and the 12-week activity use the same function as the ledger path (`hubMembersFilled` in `store/recordReader.ts`). `MapReader` needs no change; it now skips the real-ledger `ledger.runs` read in the sample.
2. **Duplicate note rows.** Cause: two distinct sample notes of one conversation could carry the same title (the generator drew the same frame twice; a note citing several messages was already listed once). `sampleIndexInput` (`shared/indexCodec.ts`) now gives each atomic note of a conversation its own title by taking the kind's next unused frame, adding no random draws, so everything else in the sample is unchanged (a rare fourth repeat gets " (2)").
3. **Sample Sources rows.** `SourcesService.list()` returns `sampleSourceRows(index)` while `deps.sandbox()` is true: conversations per source for Claude Code and the export sources, entries for the others (notes for the vault row), shares of your words from `yourShareBySource`. In the sample `files()` and `needsAttention()` return `[]` and `estimate()` returns an empty estimate without asking the runner. The manifest, settings rows and real folders are never read there.
4. **Empty label chips.** Cause: sample messages carry no title (only the first of a conversation does), and a traced conversation anchors up to 48 of them. `layoutLabels` drops anchors whose title is blank, so a chip is drawn only with its text.
5. **Selection source lines.** New `render/lineAlpha.ts` (`lineVertexAlpha8`, `effectiveSourceAlpha`). The selection's own lines (the worker's `related` answer) are drawn at the tuned alphas, 0.5 to 0.34. Lines drawn for everything shown (Lines: All, stems) keep a 0.5 dim while a selection exists, applied now as per-segment vertex alpha. `Renderer.setDimming`'s third argument is therefore always 1 from the controller; the `lines` redraw key also includes "a selection exists".
6. **Sample summary text.** `sampleGistText(title, messages, noteTitles)` (exported from `store/recordReader.ts`) builds the sample gist: `<title>: <n> messages, with <k notes ...>.` `sampleText` still serves the entries.

## PASS4 (SCALE agent: first-real-import performance)

No contract changes. Internal changes confined to importers, the store's index builder and date evidence, and the runner's import command. Tests: `tests/scale-pool.test.ts`, `tests/scale-pipeline.test.ts`. Numbers and how to run: ARCHITECTURE section 23.3.

1. **`src/node/pool.ts` (new).** `mapLimit` and `readAhead`. `common.ts` exports `documentsAhead`, `READ_AHEAD` (8), `READ_AHEAD_MAX_BYTES` (1 MiB), `saveDocStateSoon` and `DOC_STATE_SAVE_MS` (5 s). `walkFiles` yields the same files in the same order, with the stats of a folder taken 32 at a time.
2. **Importer loops.** Vault notes, `.raw` documents and folders consume `documentsAhead(...)` entries (`{ item, wanted, result, error }`) instead of calling `decideDocument` inline. Behaviour is the same (same decisions, same `stats`); reads happen up to 8 files early.
3. **State files.** Document state files are written at most every 5 s while an import runs and once at its end (`flush(true)`), not after every 150 documents.
4. **`runDateEvidence(..., { skipGit })`.** The `import` command passes `skipGit` when no source that added entries keeps files in the vault, and does not call it at all when seals are off too. `seals.run` is unchanged.
5. **Index builder / `.raw` importer.** `push(...list)` replaced by loops (call-stack limit on lists over about 120,000).
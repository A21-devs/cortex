# Cortex: product and interaction design

Version 1.2 · 9 Nov 2026 · lead product and interaction design (1.1 answered the originality, completeness, feasibility and safety reviews; 1.2 stands the figure up: Standing is the default pose, Spin the default motion, and §6.2 specifies the standing anatomy)
Status: ready to build. Every value in this document is meant to be implemented as written, or changed on purpose.

**Companion files**
- `docs/mockups/main.png` (+ `main.html`): the main view at 1576 × 933, dark theme, the figure standing (the default pose). One conversation frond is selected: the frond and the notes built from it stay bright, source lines arc from the notes in the brain round the torso down to the frond, the notes' name chips sit in two columns either side of the brain, the time strip carries a bracket over the conversation's dates, and the conversation reader is open in the sheet.
- `docs/mockups/panels.png` (+ `panels.html`): the entry reader, a map reader, Time, Agents and Read sheets; Ask with a thread and Ask empty, each rising from the bottom of the stage under the standing figure's brain; the Display popover with the key bar's Layers menu; the empty stage with its first-run checklist over the standing haze silhouette; the first-run step of Add sources.
- `docs/mockups/src/`: the scripts that produced both mockups and the particle impressions (`render_stage.py`), the shared `tokens.css`, the icon set, `palette_check.py` (accessibility and palette originality) and `originality_check.py` (banned expressions in copy). Re-run them after a token or copy change (Appendix A).
- `docs/research/SPEC.md` is the capability source. Its working name "Neuraxis" / `--nx-` is "Cortex" / `--cx-` here. Data model, importers and agent jobs are specified there and in `docs/ARCHITECTURE.md`; this document decides what the user sees and does. Where the two documents must change together, §12 lists what the architecture has to add.

**How to read this.** §1–§4 set the identity, the Obsidian model, the layout and the tokens. §5 specifies every surface: purpose, contents, controls, states and the exact copy. §6 is the 3D art direction, §7 the charts, §8 keyboard, commands, accessibility and performance. §9 maps every SPEC feature to a surface. §10 lists the design decisions. §11 answers the review findings this revision did not take as written. §12 lists what the architecture must add.

**Copy conventions in this document.** Strings the user sees are in “curly quotes” or in `code` when they are short labels. ‹Angle brackets› are values. British spelling, sentence case everywhere, no exclamation marks.

---

## 0. The design in one page

Cortex is an Obsidian tab that draws the user's whole record as a living particle nervous system. The design rests on ten decisions:

1. **The figure stands.** The brain sits at the top of the stage, the brainstem under it, and the spinal cord runs down the middle as the time axis (oldest at the brainstem, newest at the bottom tip, the undated cloud just below it). Each conversation grows a frond, a nerve, that leaves the cord where the conversation started, on alternating sides, and arches outward and downward round the torso like a rib, so a dense record reads as the rib-like torso of a nervous system; the newest nerves fan out as the cauda equina at the bottom. A slow turntable spin shows its depth. The time strip under the stage keeps calendar time left to right; tracing and brackets couple the two (§5.8). Lying (brain at the left, time running right) is one choice away in the shape bar's overflow menu.
2. **A slim left rail, one sheet.** (Amended after the first build: the recordings showed twelve destinations and five header tabs hid them.) At XL and L a 168 px left rail holds the space chip, thirteen destinations (Brain · Navigator · Write · Today · + Add · Timeline · Numbers · You · Review · Lab · Files · Learn · Your AI), a Show everything toggle and two meters; at M and S the header's page picker lists the same destinations. Every destination reuses an existing sheet page or view except **You**, a new page. The mapping is `src/ui/nav/navModel.ts`. The canvas (the *stage*) takes everything else.
3. **One sheet on the right.** Every page and every reader opens in a single right-hand *sheet* with a back stack and a crumb line, so reading never fights a second dock.
4. **One command line for finding and asking.** A floating bar at the bottom centre of the stage finds anything as you type. Press Tab and the same bar asks Claude about the record, or type `/` for one of Cortex's actions. Answers, changes and Undo appear in a console that rises from it.
5. **The current query is visible as tokens.** Everything that traces points on the figure (a search, an area, a week, a chart band, a conversation, an Ask result) becomes a removable token in the command line. That is the status display.
6. **The key is a bar, not a list.** Colour meanings sit in a horizontal key bar at the top left; the record's age colours are explained by the time strip itself, whose bars carry those colours.
7. **The compass is the scope control.** A ring of the brain's territories seen from above shows area sizes and which territory faces you. Choosing a territory turns the figure until that wedge faces you and narrows every view to it.
8. **Native where Obsidian is better.** Vault notes open in Obsidian's own editor and hover preview; settings live in Obsidian's settings; commands are Obsidian commands; background status uses the status bar.
9. **Your words and machine words never look alike.** A solid rule and filled marker mean your words; a dotted rule, dashed chip and hollow marker mean a model wrote it. Every machine sentence links back to its passage.
10. **Every change can be undone.** Corrections, merges and exclusions from a reader, a check or Ask apply with one click, show up as a change with Undo, and are logged. Nothing is deleted.

### 0.1 Originality: what the recordings show, and what Cortex does instead

The recordings and the reference product's site are evidence of capabilities, not a template. This table is the originality check for builders and QA, one row per expression the design review traced to them. If the left column ever appears in Cortex (as a screen, a sequence, a label or a sentence), it is a defect. Two scripts make the check executable and must run in `npm run check` (§12.1): `docs/mockups/src/originality_check.py` fails on any banned expression in `src/ui/copy.ts`, the markdown note templates and the mockups, and `docs/mockups/src/palette_check.py` fails on any colour set that sits too close to an observed one.

**Shell and navigation**

| # | Recorded expression | Cortex |
|---|---|---|
| — | Full-height left rail with wordmark, search field, nav list, minimap, status block, meters | A left rail at XL and L (168 px) and M (136 px): the space chip, every page (All pages on by default), and the Organised and Checks done meters. Search lives in the bottom command line; the minimap's job is done by the compass on the stage; status is tokens, header chips and Obsidian's status bar |
| — | Standing full-body figure centred: a single-hue dome brain over a neck sheath, white vertebra chevrons down the cord, a leaf- or bell-shaped fan of decorative fibres widest about 40% down and tapering to a point, spine top = newest in one look-alike | Cortex stands too, because an upright nervous system (brain above, cord descending, paired spinal nerves) is anatomy, not an expression. Everything drawn on it is Cortex's own: territories coloured by area with rim-lit points and folds traced in the slots, a cord coloured by age (violet at the brainstem to warm white at the tip, oldest at the top), faint mist rings instead of chevrons and no neck sheath, every nerve a conversation frond with part barbs, rooted at its start and alternating sides, a torso that narrows at the waist and widens again at the hips, a cauda equina fan and the undated cloud below the tip, a back three-quarter home view on a 16 s turntable; Lying is an option (§6) |
| ORIG-21 | Side pages dock on the right (video-C) or the left (video-B, site), and the reader docks on the right, stacked over the side page in C | One sheet holds pages and readers in a single back stack with a crumb line; at XL and L a page and a reader can stand in two columns either side of the stage (§3.4 rule 1); it pushes the stage at wide sizes and floats at medium sizes (§3.4). A right-hand panel is Obsidian's own convention; the stack model is Cortex's |
| ORIG-20 | Pages Brain · Navigator · Write · Today · Numbers · Timeline · You · Lab · Review · Files · Learn · Your AI (+ a table builder) | The rail (§0 item 2) gives every one of those destinations its own item under Cortex's own names: Brain · Read · Write · Today · Time · Data · Yours · Checks · Agents · Files · Guide · Ask · Add sources, with "All pages" for the full list. Each opens an existing Cortex page or view (Yours is new). The reference labels stay banned (originality_check.py) |
| — | Vertical legend at the bottom left with notes · record counts | Horizontal key bar at the top left; the age key is the time strip |
| ORIG-16 | Scope (lens) switching by clicking or wheeling the wordmark; non-members fade to black, members flash white, then a swirl and a dolly re-form the figure | The compass turn stays, and the space chip also switches: its name part steps areas on click or wheel (one step per flick) and previews each area in turn after a 700 ms rest. Members flash and settle over 600 ms; returning to all areas plays a 450 ms swirl. The rail wordmark (bold "cortex" plus the area as a light, slot-coloured suffix) opens the scope menu and rolls the suffix over about 120 ms when the area changes (old name up and out, new one rising in, a one-frame ghost); the roll and both figure effects are skipped under reduced motion (§6.7) |
| — | Small histogram box at the bottom right | Full-width time strip under the stage, coloured by age, with a notes lane |
| ORIG-13 | A view popover with sections Form · Groups · Show · Motion · Drawn, and labels Turning, Speed 0–200%, Limit rotation, Spread, Point size, Threads, the own-chats toggle with a count | Controls live where they act: shape controls in the shape bar and its overflow menu, colour pickers and a Layers menu in the key bar, and a Display popover with only Points (Dot size, Glow, Brightness, Scatter) and Motion (Spin · Drift · Off, a Speed slider 0–200%, Keep upright). “Conversation stems”, “Ask history” (count in the tooltip only), “Names on the figure” |
| ORIG-14 | Axis menu sections Time / When added / Where it is / Who and how / Labels, with Hour of the day, Notes or record, More labels (‹n›) | Dimension menu grouped by provenance: From the file · From the conversation · From the agents · From you, plus one “Date ▸” item with a granularity submenu and a Written / Imported switch; “All fields…” opens a searchable list (§7.3) |
| ORIG-09 | A seven-step narrated tour with step dots and auto-play, in the site's order | A Quick walkthrough: seven steps, each ringing its target with a card; skippable, ends on Esc, never blocks the figure; offered once after the first run and from More and the Guide page, with “Show a demo brain”. The first-run checklist and one-time hints stay (§5.28). The recorded tour phrases stay banned |
| ORIG-18 | A top-centre sentence banner when a grouping is thin, with Import more and See it on a sample | Thin groups are drawn in place as hollow outlined spheres with an “n” chip; the shape bar shows a warning dot whose menu offers “Fold groups under 30 into Other” (§5.29). Its own words are also a top-centre banner (small caps, “Groups fill out at about 30 entries each · the smallest has ‹n›”) with “Add sources” and “Try the sample”; it shows only while Groups or Chart is on and the smallest group is under 30, hides on the body and can be dismissed for the session (P16, `stage/Banner.tsx`) |

**Pages and readers**

| # | Recorded expression | Cortex |
|---|---|---|
| ORIG-01 | A “You” page: a lone 44 px percentage of the record in your own words, a three-part speaker bar, then still-waiting items, proof of dates, who has read it | Yours (a rail item) covers the same ground in Cortex's own layout and wording; your share of the words also labels the voices track on the Time page and is a column in Sources. The recorded sentences stay banned (originality_check.py) |
| ORIG-02 | A narrow “when you wrote” column: area bars, four kind lanes, a day heatmap, monthly speaker bars, labels over time with a picker, and an undated footnote | Time › Figure keeps the flat spine (your words above the axis, the assistant's below, fronds, kind glyphs, the weekday × hour grid) and adds a When block under it: activity by area, kind lanes, a day heatmap, by speaker, labels by month, one shared drag-to-range period and an All time reset, in Cortex's own wording (§5.19) |
| ORIG-05 | Conversation note sections in order: summary, tags by four families, numbered parts with topic · stage · status, ideas, decisions, your calls and corrections, sources, under a “not your words” banner | The conversation reader is built around the frond: the gist is one sentence under a dotted rule with a model chip, the body is a stem of parts (time range and message span) with the notes extracted from each part hanging off it, facets appear once as dashed chips, your fixes sit inline at the part they changed, and each note row expands to its quotes (§5.15) |
| ORIG-06 | Hub panel: type · status · range meta, a disclaimer that every point links to passages, “Within:”, fixed report sections per hub type, You · date / Assistant · date evidence lines, a trailing “from the assistant only” tag, a Comment button | A map is an index: kind (project, area or topic map) and a 12-week sparkline, a brief of 3–5 bullets each with an evidence meter, member notes grouped by kind with counts, the parent map as the crumb, and a Flag icon (§5.16) |
| ORIG-12 | Entry panel: a “‹X›'s words” chip, “Written ‹date› · added ‹date›”, a date-proof disclosure, an attachment card with Save a copy, “No labels yet.”, related rows “shares ‹terms›”, a collapsed models list, Versions (‹n›) | A facts grid at the top (Speaker · Source · Project · Area · Written · Imported · Date), a frond scrubber instead of “message ‹n› of ‹m›”, one chronological History list, an empty chip row with “+ Add label”, Related grouped under shared-term chips, “Export file…” (§5.14) |
| ORIG-22 | Navigator rows: bold title with count, bold date + two-line snippet, SOURCE · KIND meta; segments Recent / Folders / Everything / Pinned | Read rows: bold short date, a two-line snippet, a SOURCE · KIND meta line; the folder tree has a Recent block and folder colour dots; segments By date · By folder · By source and a pin filter (§5.18) |
| ORIG-11 | Lab wording: what labelled your record and what each run spent, choose a pack to light its entries, a Fields link, a footnote about labels on replaced versions, labels · refused · unanswered, “only your own lines are sent”, never-read lists, Tags % / Review % meters | Agents: “Model runs, their cost in tokens, and what they changed.”; work waiting per queue and per source; packs as a table whose rows expand per field; an “Include superseded labels” toggle; run fields Items · Labels · Declined · No answer; the privacy rule stated from the other side; exclusions as an “Off limits” table (§5.20, §5.22) |
| ORIG-19 | A Learn page of plain explainers and a seven-entry line legend | Lines explain themselves where they are drawn (hover one); only source lines and conversation stems exist by default; the Guide is five interactive cards about elements only Cortex has (§5.23) |
| ORIG-08 | The “tell your AI what to show or fix” loop, its example grid (show / fix / keep tidy) and receipt framing | Ask: “Ask about your record or change how it is shown. Every change can be undone.”; Cortex's own verbs as slash commands; up to three suggestions drawn from your own recent record; results called changes (§5.10) |

**Charts and the figure**

| # | Recorded expression | Cortex |
|---|---|---|
| ORIG-07 | Each chart carries a canned question and a computed one-line answer in a question-small / answer-large layout; ridgeline controls Scale / Smoothing / Window / Each to its own peak; Across / Bands / Around / From / To axes with Order and Swap; What shows and Merge and fold sections; Show the largest; Name this table; Export counts / Export picture; an auto-resolve sentence; leader-lined highlight pills; a 90 px focus halo | Each chart has a plain name and up to three readings drawn on it as annotations, plus “Ask about this chart”. One axis scheme: drag a dimension onto x, y or colour (pickers as fallback), a sort toggle on each axis, a swap arrow. Ridgeline: Normalise rows, one Smoothing slider, Scale. Highlights are command-line tokens. Combine from an axis label's menu; Top N stepper, default 20. Pin view. “Save image…” and “Copy data as CSV”. Map sources ringed in place with a count chip (§7) |
| ORIG-17 | Hub hover: depth-faded member chips over the brain, coloured link streaks, and the hub's sources turning white in a wave down the cord | Map hover after a 70 ms dwell: up to 30 depth-faded member chips, a fan of links from the map to its members (Body shape), the map's sources tinted toward white oldest first in four steps, one member card beside the map, and a provenance line above the command bar. Spokes stay on selection (§6.9) |
| ORIG-23 | Layouts Spheres / Folder tree / month grid / Year wheel / Function (anatomy) | Bubbles, Tree, Along the spine and Strata, plus two date layouts under Cortex's own names: Calendar rings (one ring per year, twelve month sectors, January at the top) and Months by year (twelve columns, one row per year). Role placement is a Placement option, not a layout (§6.12). The recorded layout names stay banned |
| ORIG-10 | Six window themes and seven named data palettes shown as gradient swatches; a violet-to-red month ramp; white for unsorted items | Prism and Signal, plus a computed Print mode. Stages: Follow theme · Ink · Paper, with one Stage tint slider. Age ramp rises in lightness; folded groups are mist and missing values slate (§4.4–4.5). Every stop is checked against the observed colours |
| ORIG-15 | Packs core / anatomic / shelves; fields Correction kind and Role; values building / planning, decided / left open, makes (no) claims; kinds with “rejection” and hub types Project / Area / Concept hub | Packs built from this vault and these sessions: `session` (work, outcome, project, topics), `placement` (role → region), PARA read from the vault's own wiki-mode, the correction field “Your fixes”; kinds decision · question · idea · plan · abandoned · concept · summary; maps (project, area, topic map) after the vault's MOC convention |
| ORIG-25 | “Light” as the highlight verb, “‹n› lit · Clear” | “Trace”, from tract tracing: “Trace its sources”, “214 traced · Clear”, “Traced 214 entries and 9 notes” |
| — | Pure black, square corners, hairlines, white-filled “on” states, tracked micro-caps | Obsidian chrome plus a deep ink stage, 6–14 px radii, frosted glass overlays, accent-coloured “on” states, sentence-case labels |
| — | Mascot glyph for agents | No mascot; agents are a header chip and a page |
| ORIG-24 | Example values from the recordings (41% tags, “built from 38 entries”, 39% at 44 px, the 48 largest, a 90 px sphere) | Values computed from this vault or chosen independently (57% of today's cap, 27 sources, Top N default 20); no hero numeral, no halo |

**What the checks enforce.** `originality_check.py` holds 145 patterns, each tagged with the finding that retired it: page and section names (Lab, Learn, Navigator, Numbers, Review), sentences (“not your words”, “show or fix”, “only your own lines”, “when you wrote”), control labels (Turning, Spread, Limit rotation, What shows, Each to its own peak, Export counts) and vocabulary (‹n› lit, hub, shelf, Unsorted). Short generic words (Speed, Group by, Legend, Timeline, Search) are allowed. `palette_check.py` enforces: every chromatic stop at least 5 ΔE (OKLab × 100) from every data colour listed in section 6 of the four recording analyses and every near-neutral stop at least 3; no shipped palette or ramp whose best one-to-one assignment to an observed palette averages under 6.5 ΔE, or pairs half its stops under 6; and ten negative controls (the dropped palettes, the scaffold's counterpart palettes and themes) that must be caught. §11 explains why the floor is 5 rather than 8.

---

## 1. Identity

### 1.1 Principles

1. **Your words are the ground truth.** Originals are stored untouched and shown first. Interpretations are visibly secondary and always traceable.
2. **Every point is something real.** Each particle is one entry or one note. The only decorative particles are the anatomy haze, and it stays faint enough never to be mistaken for data.
3. **Overview first, evidence one click away.** The brain is a map; every point, band and label opens to the passages behind it.
4. **Native where it counts.** Obsidian already edits notes, runs commands, stores settings and shows status. Cortex hands off to it instead of imitating it.
5. **Calm by default.** A slow turntable spin, no surprise motion, new arrivals held until you ask, every animation pausable, reduced motion honoured everywhere.
6. **Every change can be undone.** Every action that changes data needs one click to apply and one click to undo, and it is logged. Nothing is ever deleted.
7. **Honest numbers.** Counts, dates, tokens and scales are exact and labelled. A log scale says so. A guess says it is a guess.
8. **Fast first frame.** The tab opens instantly to a silhouette; indexing and layout happen out of sight.
9. **Nothing leaves without consent.** No import and no model call happens before the first-run step has shown what is read, where the text goes and what is sent (§5.26).

### 1.2 Name

**Cortex**: the outer layer of the brain, where the agents' interpretations accumulate over your original record. Plugin id `cortex`, view type `cortex-view`, display text “Cortex”, command names “Cortex: …”, CSS prefix `--cx-`, class prefix `cx-`, frontmatter keys `cortex_*`, skill `/cortex-organise`. In copy, Cortex is a product name, never a persona: “Cortex found 214 entries”, never “I'm Cortex”. Ask replies use the first person (“I traced 214 entries…”) because they are a model's words and are marked as such.

### 1.3 Glyph

An original mark: **strata**. Two open arcs around a seed. The outer arc opens to the right like a C; the inner arc opens toward the lower right, so the pair reads as growth turning outward from a centre, the way the record grows from the brainstem. It is not a brain silhouette, and it does not resemble the taken ribbon icons `network`, `sparkles` or `orbit`.

24 × 24 master (stroke icon, Lucide-compatible weight):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M19.09 6.46A9 9 0 1 0 19.09 17.54"/>
  <path d="M16.83 10.71A5 5 0 1 0 12.44 16.98"/>
  <circle cx="12" cy="12" r="1.65" fill="currentColor" stroke="none"/>
</svg>
```

Construction: centre (12, 12). Outer arc r = 9, gap ±38° about 0° (pointing right), 284° drawn. Inner arc r = 5, gap ±50° about +35° (lower right), 260° drawn. Seed r = 1.65, filled. Stroke 1.75 in a 24 grid, round caps.

Obsidian registration (`addIcon` expects a 0 0 100 100 viewBox and no outer `<svg>`):

```ts
addIcon("cortex-glyph",
  `<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="1.75"
      stroke-linecap="round" stroke-linejoin="round">
     <path d="M19.09 6.46A9 9 0 1 0 19.09 17.54"/>
     <path d="M16.83 10.71A5 5 0 1 0 12.44 16.98"/>
     <circle cx="12" cy="12" r="1.65" fill="currentColor" stroke="none"/>
   </g>`);
this.addRibbonIcon("cortex-glyph", "Open Cortex", () => this.activateView());
```

Usage: ribbon and tab icon (Obsidian sizes it, about 18 px); header 20 px in `--cx-text-1`; console avatar 14 px in `--cx-machine`; machine chips 12 px in `--cx-machine`; agent chip 15 px in `--cx-accent` (it rotates slowly while agents run: 360° per 2.4 s, no rotation under reduced motion). Minimum size 12 px. Never fill the arcs, never add colour inside the mark, never place it on a busy part of the stage without a glass backing.

### 1.4 Wordmark

“Cortex” in the Obsidian interface font (`var(--font-interface)`, Segoe UI Variable on this machine), 15 px, weight 600, letter-spacing −0.005em, colour `--cx-text-1`, 8 px after the 20 px glyph. One weight only, no colour split, no tagline, no all-caps. In the settings tab header it is 18 px/600. In plain text it is always written “Cortex”.

### 1.5 Voice

- Second person, plain words, short sentences. “You wrote this on 3 Nov.” Not “The user's entry was created…”.
- Say what happened, what did not change, and what to do next. Errors never blame the user.
- Name the model when a model did something. Never call it “AI magic”, never give it a character.
- Numbers: thousands separators (`97,519`), tabular figures in tables and counters. Dates `3 Nov 2026`, with the year omitted only inside the current year's context lists (`3 Nov`). Times 24 h `14:05`. Ranges with an en dash `2–8 Nov 2026`. Relative times in lists: `2 h`, `1 d`, `6 d`, `3 w`, then dates.
- Units are words: “tokens”, “entries”, “notes”, not abbreviations, except `k` in compact counts (`28.4k`).

### 1.6 Vocabulary (use these words consistently)

| Word | Meaning |
|---|---|
| **Record** | Everything you or others wrote that Cortex keeps verbatim: messages, documents, files, new entries. Drawn as the spine and fronds. |
| **Entry** | One unit of the record: a message, a document passage, a file. |
| **Conversation** | A thread of messages from one source. Drawn as one frond; read in the conversation reader. |
| **Part** | A stretch of one conversation (split at a compaction or a gap of more than 6 hours). Drawn as a branch of its frond; a node on the conversation reader's stem. |
| **Note** | An interpretation: a machine note (summary, decision, question, idea, plan, abandoned idea, concept) or a vault note written by Claude or a script. Drawn in the brain. |
| **Map** | A machine index over many notes: a project map, an area map or a topic map (the vault's own MOC idea). Drawn as a beacon in the brain. |
| **Area** | A top-level grouping from the vault's own area map: Code, Web, Data, AI, Roblox, Games, Money, Design, Life, Vault. Items without one are in **No area**. |
| **Scope** | Which area every view is limited to. “All areas” by default. |
| **Period** | The time window every view is limited to. “All time” by default. |
| **Trace** | Pick out points that match a query; everything else dims. A traced set shows as a token. |
| **Shape** | How the points are arranged: **Body**, **Groups** or **Chart**. |
| **Frond** | A conversation drawn as a branch off the spine. |
| **Change** | Something you or Ask did to the data or the view that can be undone; shown as a change card and listed in Change history. |
| **Check** | A machine decision waiting for you to confirm, change or reject (the Checks tab of Agents). |
| **Key**, **Compass**, **Strip**, **Command line**, **Sheet**, **Console** | The surfaces defined in §3 and §5. |

---

## 2. Obsidian integration model

### 2.1 What lives where

| Surface | Lives in | Obsidian API |
|---|---|---|
| Main view (stage, header, strip, sheet, console) | The Cortex tab, an `ItemView` of type `cortex-view` in the main area | `registerView`, `ItemView` |
| Ribbon icon | Left ribbon, glyph `cortex-glyph`, tooltip “Open Cortex” | `addRibbonIcon` |
| Commands | Command palette and Hotkeys settings, all prefixed “Cortex:” | `addCommand` (§8.2) |
| Settings | Settings › Community plugins › Cortex (one tab with six sections) | `PluginSettingTab` (§5.27) |
| Background status | Status bar item “Cortex · …” | `addStatusBarItem` (§5.11) |
| Vault notes (`wiki/**`, root notes) | Obsidian's editor and reading view; Obsidian's page preview for hover | `workspace.openLinkText`, `registerHoverLinkSource`, `trigger("hover-link")` |
| Machine notes and maps (`wiki/derived/**`) | Cortex readers first (citations, sources traced); “Open in editor” available. The files are written inert (§12.11), so Obsidian may render them safely | — |
| Chat messages, `.raw/` documents, new entries | Cortex readers only (Obsidian does not index dot-folders) | — |
| File explorer | “Show in Cortex” on notes and folders | `workspace.on("file-menu")` |
| Editor | “Show this note in Cortex” in the editor menu; the active note is marked in the brain | `workspace.on("editor-menu")`, `workspace.on("file-open")` |
| Links into Cortex | `obsidian://cortex?entry=e_…`, `?note=<vault path>`, `?area=<name>`, `?period=2026-11-02..2026-11-08`, `?view=<pinned view id>`. Navigation only: ids must match the id pattern, note paths resolve only through the vault API inside this vault, the period is parsed strictly, and nothing in a link can start an import, an agent run, an Ask request or a change. Gists in `wiki/derived/` use these links for their citations | `registerObsidianProtocolHandler("cortex", …)` |
| Daily note | Read › Today preset → “Open today's daily note” runs the core Daily notes command | `app.commands.executeCommandById("daily-notes")` |
| Menus (pickers, context menus, Layers, More) | Obsidian `Menu`, so they look and behave natively | `Menu`, `MenuItem.setSection`, `setChecked`, `setSubmenu` (feature-detected; flat sections as fallback) |
| Dialogs | Add sources, the first-run step, correction dialogs, confirmations | `Modal` |
| Background messages when the tab is hidden | Obsidian notices, at most one per kind per 5 minutes | `new Notice()` |

The rule: **if Obsidian has a native surface for it, use it; if the content lives outside Obsidian's index or needs Cortex's evidence trail, use a Cortex reader.**

### 2.2 The view

- `getViewType()` → `cortex-view`; `getDisplayText()` → “Cortex”, or “Cortex · ‹Area›” when scoped; `getIcon()` → `cortex-glyph`.
- **Immersive.** Cortex hides Obsidian's view header for its own leaf (`.workspace-leaf-content[data-type="cortex-view"] > .view-header { display: none; }`) and draws its 44 px header instead. Obsidian's tab still shows the name and icon. The header's More menu reproduces the standard pane items by building an Obsidian `Menu`, calling `this.onPaneMenu(menu, "more-options")` and `app.workspace.trigger("leaf-menu", menu, this.leaf)`, so “Split right”, “Open in new window” and “Close” stay available.
- **Opening.** `cortex:open` reveals an existing Cortex leaf, or creates one in the main area as a new tab. Cortex never opens itself at startup unless Settings › General › “Open Cortex when Obsidian starts” is on (default off).
- **Startup cost.** `onload` only registers the view, icon, commands, settings tab, status item, menus and protocol handler (target < 15 ms). Indexing starts in `onLayoutReady` and then in idle callbacks. The 3D bundle is created in `onOpen` of the first view.
- **Background work needs consent.** Imports and agent runs start in the background (about 30 s after layout ready, then on transcript changes and idle time), whether or not the Cortex tab is open, but only after the first-run step has been completed (§5.26). Until then nothing is imported and nothing is sent.
- **View state.** `getState()`/`setState()` persist per leaf: figure pose (`standing` by default, from Settings › General › Pose; `lying` from the shape bar's overflow), shape, morph value, colour dimensions, layers, motion, look, scope, period, camera pose, sheet stack (ids only), sheet width, key collapsed. Obsidian restores them with the workspace layout. A pinned view (§7.4) stores the same object under a name.
- **Keyboard scope.** The view sets `this.scope = new Scope(this.app.scope)` and registers its keys there, so they apply only while focus is inside Cortex and never steal Obsidian's global hotkeys (§8.1).

### 2.3 How each kind of item opens

| Item under the pointer | Click | Ctrl/Cmd + click | Double-click | Ctrl/Cmd + hover |
|---|---|---|---|---|
| Vault note (kind wiki) | Select + **note peek** in the sheet (Obsidian-rendered preview, “Open in editor”) | Open in a new Obsidian tab | Open in a new Obsidian tab | Obsidian page preview popover |
| Machine note or map (`wiki/derived`) | Select + Cortex reader | Open the markdown file in a new tab | Cortex reader (same as click) | Obsidian page preview (the file is inert, §12.11) |
| Chat message | Select + entry reader | Open the reader and pin it | Select the whole conversation + conversation reader | Cortex tooltip only |
| Document passage, file, new entry | Select + entry reader | Open the reader and pin it | Open the whole document | Cortex tooltip only |
| Empty stage | Clear selection | — | Home view | — |

Page preview: Cortex registers itself with `registerHoverLinkSource("cortex", { display: "Cortex", defaultMod: true })`, so it appears in Settings › Page preview and the user decides whether Ctrl is required, exactly as for other Obsidian sources.

### 2.4 Several Cortex tabs, pop-out windows

- Each Cortex leaf is independent: its own shape, colours, scope, period, camera, sheet stack and query tokens. All leaves share one in-memory index, one layout worker, one agent runner and one settings object. A settings change (palette, stage, tint, names on the figure) reaches every open leaf at once (§12.12).
- Rendering: each leaf has its own WebGL2 context. Only visible leaves render. The focused leaf renders at full rate; other visible leaves cap at 30 fps and pause their spin (or drift). A leaf hidden for 60 s releases its GPU buffers and rebuilds them from the shared store when shown again (target < 300 ms).
- At most **3 live renderers**. A fourth visible Cortex leaf shows its last frame as a still with the line “Paused to save graphics memory. Click to bring this view back.”; clicking it pauses the least recently used live leaf instead.
- More › “Open another Cortex view” creates a leaf; More › “Link views” (P2) syncs scope, period and query tokens between linked leaves.
- Pop-out windows work: the view uses `this.containerEl.win` and `this.containerEl.doc` for animation frames, listeners and DPR.

### 2.5 Width and height breakpoints

Breakpoints use the Cortex view's own content size (`ResizeObserver` on `contentEl`), not the window.

| Class | View width | What changes |
|---|---|---|
| **XL** | ≥ 1400 px | Everything as designed. Sheet pushes the stage. |
| **L** | 1100–1399 | Compass card 124 px wide (ring 92). Command line 560 px. Key chips spill into “+N” sooner. Sheet pushes. |
| **M** | 760–1099 | Header tabs collapse into a page picker (current page name + chevron). Live and agent chips become icons. The sheet floats over the stage (overlay) instead of pushing it. The key bar becomes a single “Key” button that opens the key popover. Compass shrinks to 88 px, without its caption. |
| **S** | 480–759 | Header: glyph, page picker, scope icon, More. The sheet covers the whole view below the header. The tool column becomes one “Tools” button. The shape bar collapses to a “Shape” button that opens it as a popover. The strip drops its lead area and becomes 44 px. The command line spans the width minus 32 px. The compass is hidden; scope stays in the header. |
| **Mini** | < 480 wide or < 360 tall (for example in a sidebar) | Brain only, turning slowly (the spin), with a 32 px header (glyph, scope, More). Hover tooltips stay; overlays are hidden. A single button in the corner: “Open in the main area”. More has no Quick walkthrough there (nothing to point at). |

Height: below 640 px the strip becomes 44 px (no notes lane; axis labels appear on hover) and the key bar shows one row. Below 520 px the compass is hidden.

---

## 3. Layout

### 3.1 The view at the reference size (1576 × 933)

```
y=0    ┌─────────────────────────────────────────────────────────────────────────────────────┐
       │ ◎ Cortex │ (◉ All areas ▾)  Brain  Read  Time  Agents 63 •  Sources       ? ● Live  │  header 44
       │                                          (◎ Organising 3 jobs) │ + Add sources  ⚙  ⋯ │
y=44   ├─────────────────────────────────────────────────────────────────────────────────────┤
       │ ┌Key bar, ≤ 44% of the stage──┐        ╭───────╮          ┌Shape bar─────────────┐  │
       │ │Brain [Area▾] ● Games ● … +6 │       (         )         │Body ●──── Groups ▾ ⋯ │  │
       │ │Spine [Age▾] ▬▬ ● 41 [Layers]│       (  brain  )         └──────────────────────┘  │
       │ └─────────────────────────────┘       (         )                             ┌──┐  │
       │                    ‹note chip›───·     ╰───┬───╯     ·───‹note chip›          │⚙ │  │
       │ (banner slot)                              │ brainstem, cord: oldest          │▥ │  │  tools
       │                                     ╱╱╱╱╱╱╱│╲╲╲╲╲╲╲ shoulders                 │↻ │  │
       │                                      ╱╱╱╱╱╱│╲╲╲╲╲╲  fronds arch out as ribs   │⌂ │  │
       │                                        ╱╱╱╱│╲╲╲╲    waist                     └──┘  │
       │                                      ╱╱╱╱╱╱│╲╲╲╲╲╲  hips                            │
       │ ┌Compass┐                               ╱╱╱┆╲╲╲ cauda: newest ┌Toasts──────────┐    │
       │ │  ◔    │                                 ∴ undated           │146 new · Show  │    │
       │ └───────┘            ┌Command line──────────────────────────┐ └────────────────┘    │
       │                      │ [Find|Ask] [token ×] Find anything…  │                       │
y=869  ├─────────────────────────────────────────────────────────────────────────────────────┤
       │ ▶ Time [All time▾]  ▁▂▁▂▃▂▁▂▃▃▂▃▄▃▃▄▃▄▅▄▄▅▄▅▅▆▅▆▆▇█  today      (● Undated 41)       │  strip 64
y=933  └─────────────────────────────────────────────────────────────────────────────────────┘
```

When a page or reader is open, the **sheet** occupies x 1176–1576, y 44–933, and the stage and strip end at x 1176 (main.png shows this state).

### 3.2 Regions

All positions are CSS px at 100% Obsidian zoom. “Stage-local” means relative to the stage's top-left corner (x 0, y 44 in the view).

| Region | Position | Size | Background | z (§3.3) |
|---|---|---|---|---|
| Header | view top, full width | h 44 | `--cx-chrome`, bottom border `--cx-line` | 20 |
| Stage | below header, left of sheet, above strip | 1576 × 825 (1176 × 825 with sheet) | `--cx-stage` + radial lift + WebGL canvas | 0–1 |
| Key bar | stage-local left 16, top 12 | h 66 (two 28 px rows + padding), w ≤ 44% of the stage w (517 px with the sheet open at the reference size, 693 without), so the standing figure's brain clears it | glass | 10 |
| Shape bar | stage-local right 16, top 12 | h 40, w ≈ 420 (content) | glass | 10 |
| Tool column | stage-local right 16, top 64 | w 38, buttons 32 × 32, h ≈ 272 | glass | 10 |
| Banner | stage-local left 16, top 92 (under the key bar, clear of the standing figure's brain) | w ≤ 400, h auto (2 lines) | glass | 10 |
| Compass | stage-local left 16, bottom 16 | 140 × 150 | glass | 10 |
| Command line | stage-local bottom 16, centred | 640 × 44 (L: 560; S: stage w − 32) | glass-strong | 10 |
| Find results | above the command line, 8 px gap | 640 × ≤ 420 | glass-strong | 34 |
| Ask console | above the command line, 8 px gap | 640 × ≤ min(520, 62% of stage h) | glass-strong | 32 |
| Toast stack | stage-local right 16, bottom 16 | w 330, ≤ 3 toasts, 8 px gap, stacking upward | glass-strong | 45 |
| Display popover | right edge 8 px left of the tool column, top aligned to its button | w 304, h ≤ stage h − 24 | glass-strong | 30 |
| Key popover | stage-local left 16, top 86 | 320 × ≤ 60% of stage h | glass-strong | 30 |
| Tooltip | pointer + (16, 16), flipped near edges | w ≤ 300 | glass-strong | 40 |
| Label chips | at projected points | h 21 | label glass | 5 |
| Member card | beside a hovered map, flipped near edges | w 260 | glass-strong | 40 |
| Hint bubble | anchored to the surface it explains | w 250 | `#2b2f3a` | 50 |
| Sheet | right edge, below header to view bottom | w 400 (340–560, user-resizable) × 889 | `--cx-chrome`, left border `--cx-line` | 20 |
| Time strip | bottom of view, under the stage only | h 64 (44 when short) | `--cx-strip`, top border `--cx-glass-line` | 10 |
| Modal | Obsidian modal layer, centred | 720 × ≤ 85% of window h | `--cx-chrome` | Obsidian |

**Safe frame.** The figure's home framing keeps it in the free stage, clear of every overlay.
- **Standing (default)** is fitted by height: the brain's crown sits at 9% of the stage height (y 74 at the reference size) and the lowest point of the undated cloud 8 px above the command line's top (stage height − 68, y 757); the projected figure is centred on the free stage's centre x, (24 + stage width − 70) / 2 (x 565 with the sheet open, 765 without). The key bar's 44% cap keeps the brain clear of it. If the projected silhouette would still come within 8 px of an overlay rectangle (key bar, shape bar, tool column, compass, command line, a toast), the figure first slides away from it along x by up to 36 px (6 px steps), then shrinks about its centre in 2% steps until it clears. At the reference size with the sheet open the result is: crown at 9.8% of the stage height, the lowest point 19 px above the command line, the whole figure 292 px wide and 665 px tall (about 67 px per scene unit), 8 px or more clear of the key bar. §6.8 has the camera numbers; main.png shows the result.
- **Lying** fits the figure's projected bounds into the rectangle left 24, top 86, right 70, bottom 76 px with a 4% margin.

In both poses the brain never sits under the key bar or the command line at rest.

### 3.3 Stacking order (bottom → top)

| z | Layer |
|---|---|
| 0 | Stage background (CSS) and WebGL canvas |
| 5 | Label chips and their leader lines (HTML + one SVG) |
| 10 | Stage overlays: key bar, shape bar, tools, compass, command line, banners, time strip |
| 20 | Header; sheet (in overlay mode it also casts `--cx-shadow-sheet-float` over the stage) |
| 30 | Popovers (Display, key, period range) |
| 32 | Ask console |
| 34 | Find results |
| 40 | Tooltip, member card |
| 45 | Toasts |
| 50 | Hint bubbles |
| Obsidian | Menus, modals and notices sit above the whole view (Obsidian's own layers) |

### 3.4 Docking rules

1. The sheet holds one stack. Opening a page from the header replaces the stack with that page. Opening an item from inside a page pushes it. Choosing **Brain** closes the sheet.
   **Amended for XL and L (two columns).** With the sheet open on Chart, Read or Time and a reader opened on top of it, the sheet holds two columns instead of replacing the page: the page stays docked on its own side (left or right, chosen with the dock button in its header and remembered per page, per leaf; Read defaults left, the others right) and the reader takes the opposite column, 400 px wide, with the stage between them, still interactive. Each column pushes the stage in from its own side (rule 2). The page list marks the open entry. **Esc** closes the reader first (the page stays), then the sheet. The reader column's close button closes the reader; Back there only steps between readers. The page column can be **parked** as a 28 px vertical tab on its edge carrying its name; a click or Enter on the tab brings it back. Each column is at least 300 px and the stage keeps at least 320 px; with less room (the low end of L) the single stack below stands. Opening an entry from the page's own list replaces the reader beside it instead of stacking. **At M and S the rule is unchanged:** one stack, the reader replaces the page and Back returns to it.
2. **Push mode** (XL, L): the stage and strip narrow by the sheet width. The scene stays centred in the narrower stage by tweening `camera.setViewOffset` over `--cx-t-dock` (300 ms); the camera itself does not move.
3. **Overlay mode** (M): the sheet floats over the stage with a left shadow; the stage keeps its size; clicking the stage does not close the sheet.
4. **Full mode** (S): the sheet covers the view below the header.
5. Floating overlays never move the scene. When the sheet pushes, the overlays re-anchor to the new stage edges in the same 300 ms.
6. The sheet's width is resizable by dragging its left edge (6 px hit area, `col-resize` cursor); double-click the edge to return to 400 px. Width is stored per leaf.
7. Find results and the Ask console are mutually exclusive: switching mode swaps them in place.
8. Immersive mode (I) hides header, key bar, compass, strip, command line, tools and sheet, leaving only a small “Leave immersive (Esc)” pill at the top right (stage-local right 16, top 12).

### 3.5 Transitions

| What | Motion | Duration | Easing |
|---|---|---|---|
| Sheet opens | slides in 24 px from the right + fades in | 220 ms | `--cx-ease-out` |
| Sheet closes | fades + slides 16 px right | 180 ms | `--cx-ease-inout` |
| Stack push / pop | new content enters 16 px from the right (pop: left) + fades; old leaves the opposite way | 260 ms | `--cx-ease-out` |
| Scene re-centre when the sheet docks | `setViewOffset` tween | 300 ms | `--cx-ease-inout` |
| Popover opens | fades in, rises 4 px, scales .98 → 1 from its anchor | 140 ms | `--cx-ease-out` |
| Popover closes | fades out | 100 ms | linear |
| Console opens | grows from the command line (clip) + fades | 220 ms | `--cx-ease-out` |
| New console message | fades up 6 px | 160 ms | `--cx-ease-out` |
| Toast in / out | rises 8 px + fades / fades | 200 / 160 ms | `--cx-ease-out` |
| Tooltip | none: appears after 60 ms of stillness, hides at once | — | — |
| Label chips | fade in | 120 ms | linear |
| Hint bubble | fades in after the surface has been used for 600 ms; fades out on “Got it” or the next action | 160 / 120 ms | linear |
| Header tabs, segmented controls, toggles | instant state, 90 ms background fade | 90 ms | linear |

Under reduced motion every translate and scale is removed; fades are capped at 120 ms (§4.8).

---

## 4. Design tokens

### 4.1 Theming model

- Tokens are CSS custom properties on `.cx-root` (the view's `contentEl`).
- **Chrome follows Obsidian.** Header, sheet, modal and settings bind to Obsidian's variables (`--background-primary`, `--text-normal`, `--interactive-accent`, `--font-interface`, …), so Cortex looks native in any theme and with any accent. Fallbacks equal this vault's live dark values.
- **The stage is Cortex's own.** The stage, its glass overlays, the strip and all data colours use Cortex tokens. They switch with Obsidian's `body.theme-dark` / `body.theme-light` class, or are pinned by Settings › Appearance › Stage.
- Three Cortex text colours replace Obsidian's `--text-faint` wherever text carries meaning, because `--text-faint` (#666 on #1c1c1c, 3.0:1) fails the 4.5:1 rule.
- Every data colour below is checked by `docs/mockups/src/palette_check.py` for accessibility and for distance from the colours observed in the recordings (§0.1). Change a value only together with that script.

### 4.2 Dark tokens (default; `body.theme-dark`)

```css
.cx-root {
  /* chrome: bound to Obsidian */
  --cx-chrome: var(--background-primary, #1c1c1c);
  --cx-chrome-alt: var(--background-secondary, #282828);
  --cx-chrome-raised: #2a2a2a;
  --cx-chrome-hover: rgba(255,255,255,.075);
  --cx-chrome-active: rgba(255,255,255,.11);
  --cx-line: var(--background-modifier-border, #333333);
  --cx-line-strong: #474747;
  --cx-text-1: var(--text-normal, #dadada);
  --cx-text-2: var(--text-muted, #b3b3b3);
  --cx-text-3: #9aa0aa;                 /* own: ≥ 5.4:1 on chrome, alt and raised */
  --cx-text-off: var(--text-faint, #666666);  /* disabled only, never meaning */
  --cx-accent: var(--interactive-accent, #8a5cf5);
  --cx-accent-hover: var(--interactive-accent-hover, #9b74f7);
  --cx-accent-fill: color-mix(in oklab, var(--interactive-accent, #8a5cf5) 90%, #000); /* #774fd5 */
  --cx-accent-soft: rgba(138,92,245,.18);
  --cx-on-accent: var(--text-on-accent, #ffffff);
  --cx-focus: var(--interactive-accent, #8a5cf5);

  /* stage: "Ink" */
  --cx-stage: #06070a;
  --cx-stage-lift: #0e121a;             /* radial lift behind the figure; Stage tint rotates its hue */
  --cx-strip: #090b10;
  --cx-glass: rgba(14,16,22,.86);
  --cx-glass-strong: rgba(19,22,30,.95);
  --cx-glass-hover: rgba(255,255,255,.06);
  --cx-glass-active: rgba(255,255,255,.11);
  --cx-glass-line: rgba(255,255,255,.09);
  --cx-glass-line-strong: rgba(255,255,255,.17);
  --cx-glass-blur: 14px;
  --cx-stage-text-1: #eceef2;
  --cx-stage-text-2: #c3c8d1;
  --cx-stage-text-3: #9ea5b1;
  --cx-scrim: rgba(3,4,6,.64);

  /* states */
  --cx-ok: #4cc38a;  --cx-warn: #dfbc5e;  --cx-serious: #f27733;  --cx-critical: #e6737c;
  --cx-live: var(--cx-ok);
  --cx-machine: #b8a6ff;                /* dotted rules, dashed chips, machine avatar */
  --cx-you: var(--cx-cat-2-glow); --cx-assistant: var(--cx-cat-7-glow);
  --cx-voice-other: var(--cx-cat-5-glow); --cx-tool: var(--cx-none-glow);
}
```

Primary filled buttons use `--cx-accent-fill` with `--cx-on-accent`: white on #774fd5 is 5.4:1, where white on the raw accent #8a5cf5 would be 4.3:1. When the user's accent changes, Cortex measures white on the mixed fill at runtime and switches `--cx-on-accent` to #111111 if white falls below 4.5:1.

Data tokens (dark) are listed in §4.4–4.5; the full block is in `docs/mockups/src/tokens.css`.

### 4.3 Light tokens (`body.theme-light`)

```css
body.theme-light .cx-root {
  --cx-chrome: var(--background-primary, #ffffff);
  --cx-chrome-alt: var(--background-secondary, #f6f6f6);
  --cx-chrome-raised: #ffffff;
  --cx-chrome-hover: rgba(0,0,0,.05);
  --cx-chrome-active: rgba(0,0,0,.08);
  --cx-line: var(--background-modifier-border, #e0e0e0);
  --cx-line-strong: #c8c8c8;
  --cx-text-1: var(--text-normal, #222222);
  --cx-text-2: var(--text-muted, #5c5c5c);
  --cx-text-3: #575d66;                 /* ≥ 5.6:1 on #ebebeb, 6.6:1 on white */
  --cx-accent-soft: rgba(138,92,245,.12);

  /* stage: "Paper" (default when following the light theme) */
  --cx-stage: #f4f2ee;  --cx-stage-lift: #ffffff;  --cx-strip: #efede8;
  --cx-glass: rgba(255,255,255,.88);  --cx-glass-strong: rgba(255,255,255,.96);
  --cx-glass-hover: rgba(0,0,0,.05);  --cx-glass-active: rgba(0,0,0,.08);
  --cx-glass-line: rgba(0,0,0,.10);   --cx-glass-line-strong: rgba(0,0,0,.18);
  --cx-stage-text-1: #1f2329;  --cx-stage-text-2: #4a5059;  --cx-stage-text-3: #5a616b;
  --cx-scrim: rgba(244,242,238,.72);
  --cx-ok: #168a5a;  --cx-warn: #a66a00;  --cx-serious: #b9541d;  --cx-critical: #ce2637;
  --cx-machine: #7b4acc;
}
```

**Stages** (Settings › Appearance › Stage, a plain segmented control): **Follow theme** (default: Ink in dark, Paper in light) · **Ink** (#06070a / lift #0e121a) · **Paper** (#f4f2ee / lift #ffffff). Ink renders particles additively with glow. Paper renders them with normal alpha blending at 70% alpha, without halos, using the light data variants; dense areas darken instead of washing out. A dark stage inside the light theme keeps dark stage tokens (they are scoped to `.cx-stage[data-stage]`), while the chrome stays light.

**Stage tint** (Settings › Appearance, a hue slider with an Off end, default Off): rotates the hue of the stage lift and gives the anatomy haze a tint of that hue at OKLCH chroma 0.03 (Ink) or 0.02 (Paper). It never touches data colours, text or glass. This replaces mood palettes: the record keeps its categorical colours while the room around it can be warmer or cooler.

### 4.4 Data palettes

Every categorical palette has three variants: **glow** (particles and stage keys on a dark stage), **fill** (2D marks on the dark chrome, for example Time page marks), **light** (Paper stage and light chrome). Groups take slots in rank order of everything indexed, computed once per dimension and then kept (“colour follows the group”): filtering, scoping or a new period never repaints a group. New values take the next free slot. A dimension shows at most 8 hues; the rest fold into **Other**. Items without a value are **No area** / **Undated** / **No kind** / **No project**.

**Prism (default).** Slot order chosen by enumerating every ordering for the best worst-case adjacent colour-blind separation across all three variants.

| Slot | Name | Glow | Fill (dark chrome) | Light |
|---|---|---|---|---|
| 1 | azure | `#7ab9fd` | `#5293ed` | `#156ec3` |
| 2 | amber | `#deb125` | `#cd8000` | `#a56500` |
| 3 | rose | `#f58ebc` | `#d35e9a` | `#b84580` |
| 4 | citron | `#cbd871` | `#9d9900` | `#878300` |
| 5 | teal | `#2eeafd` | `#00a0ad` | `#0090a4` |
| 6 | coral | `#e6ac86` | `#d95833` | `#c5482c` |
| 7 | violet | `#c4a9ff` | `#9875e3` | `#864fc2` |
| 8 | mint | `#6ad39a` | `#09a773` | `#008c5f` |
| — | **Other** (folded groups), mist | `#b6bbd3` | `#7b90a5` | `#4a5666` |
| — | **No value** (No area, Undated, No kind), slate | `#727b8a` | `#66686f` | `#7e8086` |

Validation (OKLab ΔE × 100, Machado 2009 protan/deutan at severity 1): fill on #1c1c1c: adjacent CVD ≥ 14.8, normal-vision ≥ 19.2, contrast ≥ 4.3:1, L 0.62–0.67, chroma ≥ 0.11. Light on #ffffff: adjacent CVD ≥ 12.8, normal ≥ 17.7, contrast ≥ 3.8:1, L 0.54–0.60. Glow on #07080b: adjacent CVD ≥ 14.6, normal ≥ 17.8, contrast ≥ 9:1, L 0.77–0.86; it sits above the chart lightness band on purpose, because 2 px additive points on near-black need L ≈ 0.80 to be seen. All pairs of glow colours are at least 9.4 apart for normal vision, and the first three slots pass the all-pairs colour-blind test (≥ 10.1) in every variant, which matters in the brain, where any two territories can touch. The shipped order ties the best enumerated order on worst adjacent separation (12.8 / 17.7 across variants) and is kept so slot meanings stay stable (you = amber, assistant = violet).

**Signal** (Settings › Appearance › Palette): colour-blind first, built on the Okabe–Ito hues and re-stepped for dark and light stages.

| Variant | Slot order | Checks |
|---|---|---|
| Glow | `#dfb748 #f487c5 #cddb78 #a2cffe #f17731 #169ad6 #3fd399` | adjacent CVD ≥ 16.5, normal ≥ 19.2, contrast ≥ 6.3:1 |
| Light | `#b17a00 #b6508c #ada200 #0f9bd7 #b54f02 #005d92 #008a64` | adjacent CVD ≥ 15.9, normal ≥ 17.7; its yellow is 2.6:1 on white, so on Paper that group always shows its name |
| Fill | the glow variant | contrast ≥ 5.3:1 on #1c1c1c |

**Print** (Settings › Appearance › Palette, and the command “Cortex: Save image…” offers it for one export): a computed mode for screenshots and paper, not a third palette. Each slot becomes one of four brown-black ink greys with one of two fills, so neighbouring slots always differ in both.

| Slot | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Ink | `#372a2b` | `#7a6a6b` | `#584949` | `#9e8d8e` | `#7a6a6b` | `#372a2b` | `#9e8d8e` | `#584949` |
| Fill | solid | 45° hatch | solid | 45° hatch | solid | 45° hatch | solid | 45° hatch |

Print uses the Paper stage, turns “Names on the figure” to **Always** (particles cannot carry a hatch) and adds the line “Names are shown on the figure because Print relies on pattern and lightness.” under the palette picker. The inks are 13.7, 8.5, 5.1 and 3.2:1 on white.

Mood palettes are not offered: Stage tint (§4.3) changes the mood without giving up the categorical checks.

### 4.5 Ramps and fixed colour sets

**Age ramp (record coloured by age, default).** Lightness rises monotonically from oldest to newest, so “newer = brighter” reads before hue; hue drifts from violet through blue, teal and green to a warm white. It is not a rainbow: no stop is darker than the one before it.

| Stop | 0 (oldest) | 1 | 2 | 3 | 4 | 5 | 6 | 7 (newest) |
|---|---|---|---|---|---|---|---|---|
| Glow / dark | `#866fc8` | `#5890ec` | `#37acc3` | `#56c4a7` | `#90cf82` | `#cdd261` | `#e1d6ba` | `#f0e0c6` |
| Light (Paper) | `#b1b0ed` | `#82a5ec` | `#229dc3` | `#018d87` | `#2c7f44` | `#5f6700` | `#734c00` | `#772e00` |

Interpolated in OKLCH. Dark lightness 0.60 → 0.91; Paper lightness 0.78 → 0.40 (newest has the most contrast on paper). An entry's age colour is taken from its position along the spine (§6.3), which is mostly rank-based, so a burst of activity spreads across the ramp instead of collapsing into one colour. **Undated** is the no-value colour (`#727b8a` / `#7e8086`). Settings › Appearance › “Age colours” offers **Hue and lightness** (above) or **Lightness only** (the ramp with its chroma set to 0.02, hue from Stage tint when it is on).

**Count ramp** (magnitude: calendar cells, matrix density, the rhythm grid): one hue, blue.

| Step | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Dark (low → high) | `#1e2c3f` | `#004568` | `#265d8e` | `#3d6dc3` | `#5692ec` | `#73b2f8` | `#abcffe` |
| Light (low → high) | `#aacefc` | `#92b0e6` | `#5593ea` | `#426ec3` | `#0f62a4` | `#084c81` | `#0c3965` |

Empty cells: dark `#1e2b38`, light `#e5e4d1`.

**Diverging** (you ↔ assistant, used by the Time page voices track and the diverging-area chart): you arm amber, assistant arm violet, neutral midpoint grey. Dark: `#fdd0a0 #dcab53 #c68128 | #4e4f58 | #926fd4 #b295ee #e9baff` (extremes brightest). Light: `#a36400 #cc8730 #e6af73 | #ccc3cb | #bcabe6 #9a7ad9 #814cb7`.

**Speakers.** You = slot 2 amber, filled circle. Assistant = slot 7 violet, hollow circle. Another person = slot 5 teal, half-filled circle. Tool output = no-value slate, small square. Shapes carry the meaning together with the colour everywhere a speaker is marked.

**Kinds** (machine notes) each have a glyph and a slot: decision ◆ slot 2, question ? slot 1, plan ▸ slot 5, abandoned × slot 6, idea ✶ slot 8, concept ◎ slot 7, summary ≡ slot 3, map ✦ white beacon. The glyphs are drawn as 12 px icons (the mockups use text glyphs), so kind never depends on colour. Vault notes use their area colour.

**Status** (agent and import states; always with an icon and a word): ok `#4cc38a`, warning `#dfbc5e`, serious `#f27733`, critical `#e6737c` (light: `#168a5a`, `#a66a00`, `#b9541d`, `#ce2637`). On dark chrome they are 5.8–9.3:1, on white 4.4–5.3:1.

**Strip and chart textures** (Settings › Appearance › “Patterns on charts”, off by default; always on in Print): 45° hatching for slots 2, 4, 6, 8, 135° for slots 3, 5, 7, solid for slot 1.

### 4.6 Type

Fonts: Cortex bundles no font. The interface uses Obsidian's interface font (`--cx-font: var(--font-interface)`); numbers in tables, counters, axes, token counts and code use Obsidian's monospace (`--cx-font-mono: var(--font-monospace)`, Cascadia Mono on this machine) with `font-variant-numeric: tabular-nums`. So Cortex follows whatever fonts the user set in Obsidian. The large token count on Agents uses the monospace at weight 600. (This is a joint decision with the architecture, which drops its bundled font, §12.4.)

| Token | px | Weight | Line height | Tracking | Used for |
|---|---|---|---|---|---|
| `--cx-fs-xl` | 22 | 600 | 1.2 | −0.01em | Settings section headings |
| `--cx-fs-title` | 18 | 600 | 1.3 | −0.01em | Reader titles, dialog titles |
| `--cx-fs-lg` | 16 | 400–600 | 1.4 | 0 | Wordmark in settings (18) |
| `--cx-fs-body` | 14 | 400 | 1.62 | 0 | Verbatim text, machine text; Ask replies are 13 |
| `--cx-fs-md` | 13 | 400 / 600 active | 1.4 | 0 | Header tabs, list titles, controls, console |
| `--cx-fs-sm` | 12 | 400 / 500 | 1.4 | 0 | Key chips, facts grids, section labels (600), tooltips |
| `--cx-fs-xs` | 11 | 400 | 1.35 | 0 | Mono counts, axis labels, kbd hints, chips |
| strip axis | 10.5 | 400 mono | 1 | 0 | Strip ticks, chart axes |

Section labels are 12 px/600 in `--cx-text-2`, sentence case, with no rule above them; sections are separated by 18 px of space. Nothing in Cortex is set in capitals, apart from keyboard key names. There is no hero numeral anywhere.

### 4.7 Space, shape, depth

| Token | Value |
|---|---|
| Spacing scale `--cx-sp-1…10` | 2, 4, 6, 8, 12, 16, 20, 24, 32, 40 px |
| Sheet padding | 14 px top, 20 px sides, 20 px bottom |
| Popover padding | 14 px sides, 4 px under the header, 12 px bottom |
| Control heights | 22 (chips, terms), 24 (inline pickers, tokens), 26–28 (buttons, segmented), 32 (tool buttons), 44 (command line) |
| Row pitch | 30–32 px in popovers and menus, 28 px in the key bar, 44 px in Read lists, 27 px in map member lists |
| Radii `--cx-r-xs/sm/md/lg/pill` | 4 (label chips, kbd, kind glyph boxes), 6 (buttons, tabs, pickers), 10 (glass cards, popovers, toasts), 14 (command line, console), 999 (pills, toggles) |
| Borders | 1 px everywhere; dashed 1 px for machine chips and kind glyph boxes; dotted 2 px for machine rules; dashed 1.5 px for the drop zone |
| Glass | `--cx-glass` + 1 px `--cx-glass-line` + `backdrop-filter: blur(14px) saturate(1.15)` + `--cx-shadow-glass`. Settings › Appearance › “Frosted panels” off → no blur, `--cx-glass-strong` fill. |
| Shadows | glass `0 10px 30px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.045)`; popovers and toasts `0 18px 44px rgba(0,0,0,.52)`; floating sheet `-14px 0 36px rgba(0,0,0,.45)`; modal is Obsidian's |
| Focus ring | 2 px `--cx-focus` outline, 2 px offset, radius follows the element; on the stage add a 4 px `rgba(0,0,0,.5)` halo behind it |

### 4.8 Motion

| Token | Value | Used for |
|---|---|---|
| `--cx-ease-out` | `cubic-bezier(.16,.84,.3,1)` | Most UI entrances |
| `--cx-ease-inout` | `cubic-bezier(.62,.02,.33,.98)` | Camera, docking, morphs |
| `--cx-ease-pop` | `cubic-bezier(.34,1.32,.64,1)` | Small confirmations (change tick) |
| `--cx-t-hover` | 90 ms | Hover backgrounds |
| `--cx-t-pop` | 140 ms | Popovers, menus |
| `--cx-t-sheet` | 220 ms | Sheet open, console open |
| `--cx-t-stack` | 260 ms | Sheet push/pop |
| `--cx-t-dock` | 300 ms | Scene re-centre, scope fade |
| `--cx-t-fly` | 520 ms | Camera fly to a selection |
| `--cx-t-recolour` | 600 ms | Per-point colour change |
| `--cx-t-chart` | 750 ms | Chart to chart |
| `--cx-t-shape` | 1400 ms | Body ↔ Groups/Chart when not scrubbed |
| `--cx-t-grow` | 3600 ms | Intro growth (§6.7) |

**Reduced motion.** Active when Settings › Appearance › Motion is “Reduced”, or “Follow system” (default) and `prefers-reduced-motion: reduce`. Then: no intro growth (points fade in over 200 ms); spin off by default; shape changes, chart changes and scope changes jump instantly with a 120 ms opacity dip; camera moves and scope turns cut; no map pulse, no draw-on of lines, no spinning glyph (the agent chip shows “…” text instead); popovers and sheet appear without translation; toasts fade only. Nothing that conveys information is lost: progress always has text.

### 4.9 Component primitives

| Primitive | Spec |
|---|---|
| **Button** | 28 px, padding 0 11 px, radius 6, 13 px. Secondary: transparent, 1 px `--cx-line-strong`, `--cx-text-1`. Primary: `--cx-accent-fill`, `--cx-on-accent`, weight 600. Hover: secondary gets `--cx-chrome-hover`; primary lightens 6%. Disabled: 40% opacity, no hover. |
| **Icon button** | 28 × 28 (header, sheet) or 32 × 32 (tools), radius 6–8, 16–17 px icon in `--cx-text-2`; hover background + `--cx-text-1`. Toggled on: `--cx-glass-active` background + 5 px accent dot at the top right. |
| **Picker** (select) | Button showing the value and a 13 px chevron; 24–26 px; opens an Obsidian `Menu` positioned under it, current item checked, groups separated by labelled sections. Keyboard: Enter/Space/↓ opens; arrows move; Enter picks; Esc closes. |
| **Segmented** | Track with 2 px inset, radius 8; segments 24–26 px, 12 px/500; selected segment raised (`--cx-chrome-raised` or `--cx-glass-active`) with a 1 px inner highlight; arrow keys move selection. |
| **Toggle** | Obsidian's own `.checkbox-container` pill on chrome; on the stage the same shape at 30 × 18 with accent fill when on; inline in section headers at 24 × 14. |
| **Slider** | 2 px track, accent fill to the thumb, 14 px round thumb `#eceef2` with shadow; value text right-aligned in mono; end labels for two-ended sliders. Arrow keys step 5%, Shift + arrows 1%, Home/End ends. |
| **Key chip** | 24 px pill, 8 px dot, 12 px name, 11 px mono count in `--cx-stage-text-3`. Hidden: hollow dot, name struck through, 50% opacity. |
| **Token** (command line) | 24 px pill, radius 6, `--cx-glass-active`, optional dot, 12 px label, 14 px × button. |
| **Label chip** (on the figure) | 21 px, radius 4, `rgba(10,12,17,.8)` + 1 px `rgba(255,255,255,.12)` + 6 px blur, 3 px colour bar on the left, kind glyph, kind word in `--cx-stage-text-3`, title in `--cx-stage-text-1`, 11.5 px, max 42 characters. |
| **Tooltip** | Glass-strong card, radius 10, padding 10/12/10/14, 3 px colour bar on the left, title 13/600, meta lines 12 px, numbers mono, hint line 11 px after a hairline. |
| **Machine chip** | 22 px, radius 4, 1 px **dashed** `rgba(184,166,255,.55)`, field name in `--cx-text-3`, value in `--cx-text-2`. User-set labels use the same chip with a solid `--cx-line-strong` border. A **model chip** (20 px pill, dashed, mono 11 px in `--cx-machine`, glyph first) names the model and date: “sonnet · 4 Nov”. |
| **Kind glyph** | 18 × 18 box, radius 4, dashed `rgba(184,166,255,.45)` border (machine), glyph in the kind's slot colour (§4.5). A map's box is solid white-bordered. |
| **Evidence meter** | Two 24 × 4 px bars stacked 2 px apart: quotes from you (amber) over quotes from the assistant (violet), filled in quarters up to 4 quotes; tooltip “‹n› quotes from you, ‹m› from the assistant”. |
| **Speaker-split bar** | 4 px wide, full row height, radius 2: your share of the words on top in amber, the rest in violet; tooltip “‹p›% your words”. |
| **Rules** | Your words: 2 px solid left rule in the speaker colour. Machine text: 2 px dotted left rule in `--cx-machine`. |
| **Change card** | Row card, radius 9, 1 px `--cx-glass-line`, tick in an 18 px `--cx-ok` circle, summary 12.5 px written by Cortex, detail mono 11 px, “Undo change” text button. |
| **Proposal** | Card with 1 px accent border and `rgba(138,92,245,.08)` fill, title 13/600 with an icon, explanation 12 px written by Cortex, an optional dotted-rule line “The AI's reason: “‹text›”” in `--cx-stage-text-3`, Apply (primary) + Cancel, key hints. |
| **Status pill** | 18 px, radius 9, 6 px dot + 11 px/500 word, tinted background per state. |
| **Hint bubble** | 250 px, radius 10, `#2b2f3a`, 1 px `rgba(255,255,255,.16)`, a 12 px pointer toward the surface, 12.5 px text, a “Got it” link. |
| **Scrollbars** | Obsidian's own in the sheet and modals; 4 px thumbs `rgba(255,255,255,.16)` in glass panels. |

### 4.10 Icons

Cortex uses Obsidian's bundled Lucide icons through `setIcon()` for every control, so they match the rest of the app, plus its own `cortex-glyph`. Mapping: Display `sliders-horizontal`; Chart `chart-column`; Names `tag`; Lines `spline`; Spin `rotate-3d`; Home `house`; Immersive `maximize`; Find `search`; Add sources `plus`; Settings `settings`; More `ellipsis`; Guide `circle-help`; Back `arrow-left`; Close `x`; Pin `pin`; Show in brain `crosshair`; Flag `flag`; Save image `image-down`; Copy data `clipboard-copy`; Export ledger `download`; Undo `undo-2`; Change history `history`; Folder `folder`; Document `file-text`; Conversation `message-square`; Agents `cpu`; Privacy `shield-check`; Checks `inbox`; Calendar `calendar`; Today `sun`; New entry `pen-line`; Data view `table`; Sources `database`; Layers `layers`; Play `play`; Pause `pause`; Warning `triangle-alert`; Lock `lock` (secret kept on this computer). Kind glyphs are Cortex's own 12 px icons (§4.5). (The mockups draw look-alike placeholders; the build uses the real Lucide names above.)

---

## 5. Surfaces and pages

Each surface lists its purpose, contents, controls (type · default · range), states and copy. Priorities (P0/P1/P2) follow §9.

### 5.1 Header bar

**Purpose.** Identity, scope, page navigation and the few global statuses that must stay visible.

**Contents, left to right**

| Element | Spec |
|---|---|
| Brand | 20 px glyph + “Cortex” wordmark, 14 px left padding, 1 px divider after it. Click → Brain page (closes the sheet). Right-click → the leaf menu. |
| Scope picker | 28 px pill on `--cx-chrome-alt` with `--cx-line` border. Shows a 14 px ring of the top area colours and “All areas”, or one area dot and its name. Chevron 14 px. Click → Obsidian `Menu`: “All areas” (total count) · separator · each area with its dot, name and count, in slot order · “No area” · separator · “Previous area [” · “Next area ]”. Choosing an area runs the compass turn (§5.7, §6.7). The pill has two parts: the name steps to the next area on click or wheel (one step per flick) and previews areas in turn after a 700 ms rest; the chevron opens the menu. At S the icon-only pill opens the menu. |
| Page tabs | `Brain` · `Read` · `Time` · `Agents` + checks badge and activity dot · `Sources` + attention dot. Tabs are 28 px, padding 0 10, radius 6, 13 px; active tab `--cx-chrome-active` + `--cx-text-1` + weight 600; inactive `--cx-text-2`. Checks badge: unresolved checks (§5.21), `99+` above 99, hidden at 0. Agents dot: green pulsing while running, amber when paused or capped, red when the engine needs attention, hidden when idle. Sources dot: red when a source needs attention. |
| Guide | 28 px icon button (`circle-help`), tooltip “Guide (?)”. Opens the Guide in the sheet (§5.23). |
| Live | Green 6 px dot + “Live”, shown while at least one source is watched. Tooltip: “Watching Claude Code. New sessions show up within a minute.” |
| Held arrivals | Accent-outlined pill “‹n› new”, shown when new entries are held back. Click → show them (§6.7 live arrivals). |
| Agent chip | 28 px pill: spinning glyph + state word + detail. States: “Organising · ‹n› jobs”, “Up to date” (shown 4 s after the queue empties, then shrinks to the glyph alone), “Paused”, “Cap reached”, “Sign-in needed”, “Claude Code not found”, “Engine offline”, “Agents off” (after “Import only”). Hidden before the first-run step. Click → Agents page. Tooltip: “‹used› of ‹cap› tokens used today · ‹n› conversations waiting”. |
| Add sources | Secondary button with plus icon, “Add sources”. Opens Add sources (§5.26); before the first-run step it opens that step instead. |
| Settings | Icon button → Obsidian settings opened at Cortex (`app.setting.open(); app.setting.openTabById("cortex")`, an internal API guarded by a fallback that just opens Settings). |
| More | Icon button → menu: Reset display · Save image… · Copy data as CSV · Pin view… · Open another Cortex view · Link views (P2) · Rebuild index · Reset hints · Sample record (toggle) · separator · Obsidian's pane items. |

**States.** Loading: tabs and pickers are live from the first frame; counts show “–” until the index is ready. Sample record: an amber-outlined pill “Sample” sits after the wordmark; tooltip “You're looking at a made-up record. Leave it from the More menu.”

### 5.2 Stage: the Brain page (default)

**Purpose.** The whole record at a glance, as the standing nervous system (§6).

**Contents.** The WebGL canvas, the key bar, shape bar, tool column, compass, command line, toasts, and on hover the tooltip, label chips or a map's member card.

**Interactions**

| Gesture | Result |
|---|---|
| Hover a point (60 ms still) | Tooltip (§5.12), point drawn white at 2× with a ring; for a map, its member card, source braid and strip bracket (§6.9) |
| Hover a line | A one-line tooltip naming it: “Source line · ‹note title› → 1 of its ‹n› sources” or “Conversation stem · ‹conversation›” |
| Click a point | Select: everything else dims (§6.6), source lines draw on, the matching reader opens in the sheet, the camera flies to frame it (§6.8) |
| Double-click a message | Select its whole conversation: the frond stays bright, the notes built from it brighten in the brain with source lines, the strip shows a bracket over its dates, and the conversation reader opens (main.png) |
| Click empty stage | Clear the selection (tokens stay) |
| Double-click empty stage | Home view |
| Drag | Orbit (spin pauses) |
| Right-drag or Shift + drag | Pan |
| Wheel | Dolly toward the cursor |
| Ctrl/Cmd + click a vault note | Open it in a new Obsidian tab |
| Right-click a point | Menu: Open · Trace its sources · Trace everything like this · Pin · Show in Read · Copy link · (vault notes) Open in new tab / Open to the right |

**Empty, before setup.** The haze silhouette at 1.5× its rest brightness, turning slowly, and a centred glass card (360 px, panels.png): title “Your record is empty”, body “Start with this vault's notes and your Claude Code sessions. Cortex copies words, never changes them, and asks before anything is sent to a model.”, then a **first-run checklist** of three items that tick themselves off from real actions: “Add a source”, “Open one conversation frond” (hint line “Double-click a branch off the spine”), “Ask one question” (hint line “Press Tab in the command line”). Buttons **Add sources** (primary, opens the first-run step, §5.26) and **Explore the sample record**. Once data arrives the checklist moves into a small card in the banner slot until all three items are ticked; its menu has “Hide checklist”.

**One-time hints.** The first time each surface is used, a hint bubble (§4.9) appears next to it once and never again (stored per device; “Cortex: Reset hints” brings them back):

| Surface | Trigger | Hint |
|---|---|---|
| Stage | first hover after the first import | “Hover anything for details. Drag to turn, wheel to zoom. The spine is time, oldest by the brain.” |
| Time strip | first hover of 600 ms | “Drag across the strip to set the period for every view.” |
| Shape bar | first drag of the slider | “The same points move between the body and the groups. Nothing in your record changes.” |
| Compass | first hover | “Choose a territory to turn the figure toward it and narrow every view to that area.” |
| Command line | first focus | “Press Tab to ask instead of find, or type / for an action.” |
| Conversation reader | first open | “Each node is one part of the conversation. Open a row to see the words it came from.” |

**Vault notes only, no record yet:** the brain grows; the spine is a faint haze; a banner (§5.29) says “Add Claude Code or a chat export to grow the spine.” with **Add sources**.

### 5.3 Key bar (legend)

**Purpose.** Say what the colours mean, let you hide, isolate or trace groups, and choose which layers are drawn.

**Contents.** Two rows inside one glass bar (stage-local left 16, top 12).

| Row | Spec |
|---|---|
| Brain | Label “Brain”, picker with the colour dimension (default **Area**), then one chip per coloured group in slot order: dot, name, note count (compact above 9,999: `28.4k`). Chips that do not fit collapse into a final “+‹n›” chip that opens the key popover. Groups folded into Other show as one “Other” chip; No area shows a hollow slate dot. |
| Spine | Label “Spine”, picker (default **Age**). With Age: earliest month label, a 170 × 6 px gradient of the age ramp, “today”, a divider, a slate dot with “Undated ‹n›”. With a categorical dimension: chips, as in the Brain row. At the right end: the **Layers ▾** button. |
| Unsplit | When “Same colour for both” is on, the two rows become one: “Everything by [Area ▾]”, with Layers at its end. |
| Collapse | A 20 px chevron at the bar's right end collapses it to “Brain by Area · Spine by Age”; stored per leaf. |

**Dimension pickers.** Each picker opens the dimension menu (§7.3); below it, a section of toggles: “Same colour for both”, “Fold small groups into Other” (on), “Hide items without a value” (off), and “Single colour…” (a swatch row of the 8 slots plus a custom picker; the haze takes a dim tint of it).

**Layers ▾** (a checklist `Menu`, panels.png): Notes · Vault notes · Reference material (“‹n› hidden” at the right) · Maps · Record · Undated cloud · Ask history · Subagent traffic (only when imported) · separator · Anatomy haze. Defaults: all on except Reference material, Ask history and Subagent traffic. Ask history's count appears only in its tooltip (“‹n› Ask exchanges”).

**Chip interactions**

| Gesture | Result |
|---|---|
| Hover (150 ms) | Members +40% brightness; tooltip “‹Group› · ‹n› notes · ‹m› entries” |
| Click | Hide or show the group (members fade to 6% in 150 ms; chip shows hollow dot, struck-through name) |
| Alt + click | Show only this group (solo); Alt + click again restores all |
| Shift + click | Trace the group: adds the token “‹Dimension›: ‹Group›” to the command line |
| Right-click | Menu: Trace · Show only this · Hide · Show in Read · Merge with… (a proposal card: the two groups show as one everywhere, saved as your fix, undoable; §5.10) |
| Keyboard | Chips form one toolbar: ←/→ move, Space toggles, Alt + Space solos, Enter traces |

**Key popover** (“+‹n›” or the picker's “All groups…” item): 320 px, max 60% of the stage. Search field “Filter groups”; a two-column list (notes, entries) with a dot, name and toggle per row; hierarchical dimensions (Folder, Folder path) show a tree with disclosure chevrons and solo-on-Alt behaviour (SPEC F67); footer “Hide items without a value” toggle. No match: “No groups match “‹text›”.”

**States.** Before the index is ready the chips show grey dots and “–”. When the dimension has no values: “Nothing to colour by yet.” in `--cx-stage-text-3`.

### 5.4 Shape bar

**Purpose.** Move every point between its place in the body and its place in a grouping or chart, continuously, and set how the body is arranged.

**Contents.** Glass bar, 40 px (stage-local right 16, top 12): body icon + “Body”, a 132 px slider with ticks at 25/50/75%, the target icon + name (“Groups” or “Chart”), a divider, a picker (“by Area ▾” in Groups, “Calendar ▾” in Chart) and an overflow button (⋯). A warning dot appears on the picker when the grouping is thin (§5.29).

| Control | Type | Default | Range / behaviour |
|---|---|---|---|
| Morph | Slider | 0 (Body) | 0–1 continuous; dragging scrubs the morph live; releasing within 6% of an end snaps to it in 150 ms; clicking an end label animates there in 1.4 s; double-click the thumb toggles ends; keyboard ←/→ 5%, Shift 1%, Home/End |
| Target | Picker | Groups · Area | Groups: the dimension menu (§7.3) plus a “Layout” section (Bubbles, Tree, Along the spine, Strata; §6.12). Chart: the chart catalogue (§7.2), grouped. Choosing a chart sets the target to Chart and, at XL/L widths, opens the Chart page in the sheet. |
| Overflow ⋯ | Menu | — | Pose: Standing · Lying (Standing is the default; Lying is the alternative for a very wide, short tab). At the core: Oldest notes · Newest notes · Largest first. Placement: By area · By role in the body (role = the `placement` pack label, §6.3). |

`aria-valuetext`: “Body”, “Halfway to Groups”, “Groups”. When the target is Chart and the morph passes 0.85, the chart's axes, labels and readings fade in (§7.1).

### 5.5 Tool column

Vertical glass column (stage-local right 16, top 64), 32 px buttons in three groups separated by 22 px hairlines.

| Button | Icon | Key | Action | State shown |
|---|---|---|---|---|
| Display | `sliders-horizontal` | O | Opens the Display popover | pressed while open |
| Chart | `chart-column` | C | Opens the Chart page (or closes it) | pressed when the shape is Chart |
| Names | `tag` | L | Names on the figure: on hover ↔ always (Off in Settings › Appearance) | dot when “Always” |
| Lines | `spline` | K | Source lines for the selection ↔ for everything shown; right-click → Off · Selection · All, and “Conversation stems” | dot when “All” |
| Spin | `rotate-3d` | Space | Motion on/off (spin in Standing, drift in Lying); right-click → ×0.5 · ×1 · ×2 | dot when on |
| Home | `house` | H | Home view (§6.8) | — |
| Immersive | `maximize` | I | Immersive mode | — |

Every button has a tooltip with its name and key, for example “Lines · K”.

### 5.6 Display popover (rendering and motion only)

**Purpose.** How the points are drawn and how the figure moves. Opened from the tool column (O). 304 px, glass-strong (panels.png), header “Display” with a reset button (tooltip “Reset display”) and a close button. No tabs: two short sections. Changes apply live to this leaf only; the footer says “Only this view changes. Other Cortex tabs keep theirs.” Shape controls live in the shape bar, colour controls and layers in the key bar.

| Section | Control | Type | Default | Range |
|---|---|---|---|---|
| Points | Dot size | Slider + value | 100% | 50–250% |
| Points | Glow | Slider + value | 100% | 0–200% |
| Points | Brightness | Slider + value | 100% | 25–200% (exposure before tone mapping) |
| Points | Scatter | Slider + value | 100% | 50–150% (distance from each point's slot centre) |
| Motion | Motion | Segmented | Spin (Standing) / Drift (Lying) | Spin · Drift · Off |
| Motion | Speed | Segmented | ×1 | ×0.5 · ×1 · ×2; ×1 = one spin per 16 s, or one drift cycle per 12 s |
| Motion | Pause while pointing | Toggle | Off | When on, the motion pauses while the pointer rests on a point; by default the figure keeps turning under the cursor |
| Motion | Keep upright | Toggle | Off (on by itself in charts) | Clamps orbit to ±50° yaw, ±30° pitch around the home view; note under it “On by itself in charts.” |

The reset button restores every Display control and the camera, but not the scope, the period, the palette (a setting) or the query tokens; it posts the toast “Display reset · Undo change”.

### 5.7 Compass (scope)

**Purpose.** A map of the brain's territories seen from above: how big each area is, which one faces you, and the gesture that narrows every view to one area.

**Contents.** Glass card 140 × 150 (stage-local left 16, bottom 16). A 104 px ring: outer radius 48, inner 37, one segment per coloured area in slot order clockwise from 12 o'clock, 1.6° gaps, segment angle ∝ (notes in the area)^0.6, which is exactly the share each area gets around the brain (§6.3). Centre: note count in scope (mono 13/600) over “notes” (10 px). A white heading needle on the rim points at the territory facing the camera and swings with the spin. Under the ring: the scope name and a chevron (opens the scope menu).

| Gesture | Result |
|---|---|
| Hover a segment | Segment brightens; tooltip “Vault · 1,203 notes · 18,533 entries”; members preview +40% |
| Click a segment | Scope to that area: the figure turns until that wedge faces you (600 ms) and the needle swings with it; non-members sink toward the brain's core and fade (§6.7); the segment extends 3 px outward, others drop to 28% |
| Click the centre or the scoped segment again | Back to All areas: members rise back to the surface over 400 ms |
| Drag around the ring | Turns the camera to face the dragged-to territory without changing scope (P1) |
| Keyboard | Segments are a radio group: arrows move, Enter scopes; `[` and `]` step areas from anywhere in the view |

In Groups and Chart shapes the needle hides and the ring dims to 50%; it still scopes (without the turn).

**States.** No notes yet: one dim grey ring, centre “0”, caption “No notes yet”. Every note is in No area: one slate ring, caption “All notes in No area”, tooltip “Areas come from your vault's folders. Set them in Settings › Sources.”

### 5.8 Time strip (histogram and period brush)

**Purpose.** How much you wrote, and when; the period every view is limited to; and the key to the age colours.

**Contents** (64 px, under the stage)

| Part | Spec |
|---|---|
| Lead (x 14–214) | Row 1: 24 px round replay button, “Time” (12/600), period picker (“All time ▾”). Row 2: “‹n› entries · ‹m› notes” in the period (mono 11 px). |
| Notes lane | Top 6 px of the plot: one 2 px tick per week that has new notes, in `--cx-machine`, height ∝ notes (max 5 px). Label “notes” at the lane's left. |
| Histogram | Plot from x 236 to stage width − 146, y 14–50. One bar per week (per day when the period covers ≤ 120 days; per month beyond 8 years). **Log scale** by default (Settings › Appearance › Strip scale: Log · Linear). Bars carry the age colour of their entries when the record is coloured by age, otherwise `--cx-stage-text-3` at 55%. 1 px gaps, 1 px radius. While something is selected, bars outside its dates drop to 34%. |
| Axis | Year starts get a dashed guide and a label; month labels appear where there is room; mono 10.5 px. The first label shows the earliest month (“Feb 2023”); the right end shows a white “now” triangle and “today”. |
| Period brush | Two handles (8 px wide, plot height + 8) at the period's ends; outside the period the plot is covered by a 55% stage-coloured scrim. Default period: All time, handles at both ends. |
| Bracket | When a conversation or map is selected, or a map hovered: a 1.5 px white bracket above the bars over its date span (at least 14 px wide), and a small label with the dates (“3–4 Nov”) to its left, joined by a leader (main.png). |
| Undated | Right end: a pill “● Undated ‹n›”. Click traces the undated cloud; tooltip “‹n› entries have no date of their own. They sit just below the tip of the spine.” |

**Interactions**

| Gesture | Result |
|---|---|
| Hover a bar | White 8% column with 1 px outline; tooltip “Week of 2 Nov 2026 · 12,904 entries · 61 notes”; the brain previews that week (matches full, others at 35%) |
| Click a bar | Traces it: token “Week of 2 Nov 2026” (or the day / month) |
| Drag across the plot | Sets the period; every page and chart re-ranges; the figure fades points outside the period to 6% (Body) or removes them (Groups, Chart) |
| Drag inside the period | Moves it |
| Drag a handle | Resizes it |
| Double-click | All time |
| Period picker | All time · Last 7 days · Last 30 days · Last 90 days · This year · Last year · Custom… (opens a 2-field date popover) |
| Replay | Plays the record's growth in date order over 8 s with a playhead on the strip; drag the playhead to scrub; Esc stops (P2) |
| Keyboard | Handles are sliders (←/→ one bar, Shift one month, Page Up/Down one year); bars are a list (←/→, Enter traces) |

**States.** Loading: grey skeleton bars (`rgba(255,255,255,.06)`) that pulse once per 1.2 s. No dated entries: centred text “No dated entries yet.” with an “Add sources” link. Scope change: bars cross-fade in 250 ms and re-range.

The record's position along the spine is mostly rank-based (§6.3), so the strip (calendar time) and the 3D spine (record time) are not drawn to the same scale. They are coupled by tracing and brackets, not geometry. The Time page draws the spine's own scale (§5.19).

### 5.9 Command line: Find (Ctrl K)

**Purpose.** Find anything, and show what the figure is currently traced by.

**Contents.** Glass-strong bar, 640 × 44, radius 14, at the stage's bottom centre: a Find/Ask segmented switch (Tab toggles while focused), the query tokens, the input, a traced-count readout, and the key hint `Ctrl K`.

| Part | Spec |
|---|---|
| Placeholder | Find: “Find anything in your record”. Ask: “Ask a question, or type / for an action”. |
| Tokens | One per active filter, in the order added. Kinds: text search, group (area, folder, project, kind, source, speaker), time (day, week, month, range), chart band or highlighted series, conversation, Ask result set. Same-kind tokens are OR; different kinds are AND. Backspace in an empty input removes the last token. |
| Readout | “‹n› traced” in mono + “Clear” link when any token is active. |

**Live filtering.** Typing traces matches after 150 ms (matches full colour, others 12%, the haze half its rest brightness). Matching uses the in-plugin search index across titles, text, labels and folder names.

**Results popover** (opens above the bar while the input has text; 640 wide, max 420 tall): groups **Entries**, **Notes**, **Maps**, **Areas and folders**, **Pages and actions**, up to 5 rows each plus “Show all ‹n›”. Row: 40 px, kind icon, title with the match underlined in the accent, meta line “Claude Code · 3 Nov 2026 · Roblox”. Final row: “Ask: “‹query›”” with the Tab hint. Footer: “↑↓ move · Enter open · Ctrl+Enter trace all ‹n› · Tab ask”.

| Key | Result |
|---|---|
| ↑ / ↓ | Move through results |
| Enter | Open the highlighted result (reader, page or action) and keep the query traced |
| Ctrl + Enter | Turn the query into a token (““trade” · 214”), close results |
| Tab | Switch to Ask with the same text |
| Esc | First: close results, keep the traced query. Second: clear the input. Third: remove all tokens. |

**States.** No results: “Nothing matches “‹query›”. Try fewer words, or press Tab to ask.” Index still building: results show what is ready plus “Still reading your record; results may be incomplete.”

### 5.10 Ask

**Purpose.** Ask about your record or change how it is shown. Every change can be undone. Answers come only from the record, with citations; changes are applied by Cortex, never by the model.

**How it runs.** The Claude Code CLI in headless mode (`claude -p --output-format json`, no tools). Cortex sends the request, the conversation so far and the passages its search retrieved; the model returns one JSON object `{ reply, citations[], actions[] }`. Cortex validates every citation (the quote must be an exact substring of the cited entry version) and every action (a verb in the registry, valid ids, within limits) before showing anything. The model never touches files; Cortex executes actions itself, through the same code paths as the buttons.

**Console.** Rises from the command line (same width, up to min(520, 62% of the stage height)). Header 42 px: glyph, “Ask”, an engine line “Claude Code · ‹model› · answers only from your record”, buttons Change history, Keep open (pin), Collapse. Thread: your messages right-aligned in an amber-tinted bubble (a leading slash command shown in mono); replies left-aligned with the machine avatar; citation chips `1` `2` inline (hover → the quoted passage, speaker and date; click → the entry in the reader); change cards and proposals inline. Collapses on Esc or Collapse unless pinned; it never closes while a request runs.

**Empty state** (panels.png). No title sentence. The purpose line “Ask about your record or change how it is shown. Every change can be undone.”, then Cortex's actions as slash commands, one row each with a description and an example; clicking a row inserts its template into the input:

| Command | Description | Inserts |
|---|---|---|
| `/trace` | Trace everything that matches | “/trace ‹words›” |
| `/chart` | Arrange the figure as a chart | “/chart ‹chart› by ‹dimension›” |
| `/arrange` | Pull the points into groups | “/arrange by ‹dimension›” |
| `/period` | Set the period for every view | “/period ‹from› to ‹to›” |
| `/correct` | Fix an entry's text, date or speaker | “/correct ‹what› of this to ‹value›” |
| `/merge` | Show two groups as one | “/merge ‹group› into ‹group›” |
| `/leave-out` | Keep something out of Cortex | “/leave-out ‹entry, conversation or source›” |
| `/refresh` | Redo summaries for a stretch | “/refresh ‹selection or period›” |

Below them, up to three “Try” suggestions generated from your own recent record, without a model call: the title of yesterday's longest conversation (“What did I decide in “‹title›”?”), the area with the most open questions this week (“Which ‹area› questions are still open from last week?”), and the project you touched least recently among the active ones (“When did I last work on ‹project›?”). No fixed example grid. With an empty record the Try row is hidden.

**Slash commands.** Typing `/` at the start of the input opens the same list as a menu above the input, filtered as you type; Tab completes. A slash command still goes through the model (it fills in ids and values from the record), but the model may only return that one verb.

**Action vocabulary** (the registry in `src/shared/actions.ts` is the source of truth; verbs marked RFC are added there with closed schemas, §12.7)

| Change verb | Action (`id`) | Parameters | Effect | Apply | Undo |
|---|---|---|---|---|---|
| Traced | `trace` (renamed from `light`) | query?, ids?, filters? | Traces matches; adds a token | no | removes the token |
| Set the period | `set_period` (RFC) | start, end | Sets the period for every view | no | previous period |
| Opened | `open_view` | view, params | Opens a page or reader | no | Back |
| Arranged | `arrange` (RFC) | by, layout? | Groups shape by a dimension | no | previous shape |
| Charted | `make_chart` | chart, x?, y?, colour?, filter? | Builds a chart | no | previous view |
| Corrected | `correct_entry` | entryId, newText, reason? | New version; the first wording stays in History | **always** | restores the previous version |
| Re-dated | `set_date` (RFC) | target, date | Your date overrides the evidence | yes | removes the override |
| Speaker set | `set_speaker` (RFC) | target, speaker | Your speaker overrides | yes | removes the override |
| Relabelled | `set_label` | target, field, value | Your label, which models must keep | yes, even for one item | removes your label |
| Merged | `merge_groups` | dim, from, into | Display mapping; nothing moves on disk | yes | deletes the mapping |
| Refiled | `refile` (RFC) | target, area/folder/project | Display filing override | yes | removes the override |
| Left out | `exclude` | target, scope (entry, conversation, source) | Leaves the figure, search and notes; nothing is deleted (§5.30.4) | yes | brings it back exactly |
| Brought back | `include` (RFC) | target | Reverses Left out | **always** | leaves it out again |
| Queued refresh | `refresh` | scope (selection or period only), capped at 200 items | Queues agent jobs; spends tokens | yes, with Cortex's own estimate | cancels jobs not yet run |
| Suggested | `propose_filing` | scope | Creates checks; spends tokens | yes, with Cortex's own estimate | discards the checks |
| Pinned | `pin` (RFC) | target | Pins | no | unpins |

**Apply rules.** Every action marked yes waits for **Apply** on its proposal card. Settings › Agents › “Apply Ask's changes without asking” (default off) skips Apply for verbs marked yes, never for those marked **always**. `refresh` and `propose_filing` show Cortex's own estimate (“14 conversations · about 120,000 tokens · within today's cap”) and may not target everything at once. One reply may carry at most 8 actions; a single data-changing action may touch at most 500 items.

**Changes (copy).** Change text is written by Cortex from the validated parameters and the resolved targets (titles, counts, dates), never taken from model text. Examples: “Traced 214 entries and 9 notes · 2–8 Nov 2026”. “Set the period · 2–8 Nov 2026”. “Arranged by project”. “Corrected · the first wording stays in History”. “Merged inv-sync into roblox-inventory · display only”. “Left out “‹title›” · nothing was deleted”. “Queued 14 summaries · about 120,000 tokens”. “Suggested places for 63 items · see Checks”. Each change card has **Undo change** (or **Cancel** for queued work). Undo of a data change never expires; it stays in Change history. If a later change touched the same item, Undo first shows what it will revert (“This also undoes your later fix of 5 Nov.”) and asks for **Undo both**.

**Proposal card (copy, panels.png).** Title “Combine two projects”. Body written by Cortex: “inv-sync (12 conversations) into roblox-inventory (26). They show as one group everywhere; no file moves. Saved as your fix, so the agents keep it.” When the model gave a reason it appears under a dotted rule, labelled: “The AI's reason: “They share 31 conversations.”” Buttons **Apply**, **Cancel**; hint “Enter applies · Esc cancels”.

**Progress.** “Reading 38 passages…” with an indeterminate 2 px bar and **Stop**. After 20 s: “Still working. Long questions can take up to a minute.”

**Errors**

| Situation | Message |
|---|---|
| Timeout (90 s) | “Claude Code didn't answer within 90 seconds. Nothing was changed.” **Try again** |
| Claude Code not found | “Cortex can't find Claude Code at ‹path›. Check the path in Settings › Agents.” **Open settings** |
| Sign-in needed | “Claude Code needs you to sign in again. Run claude once in a terminal, then ask again.” |
| Token cap reached | “Today's token cap is reached. Ask again after midnight, or raise the cap in Settings › Agents.” |
| Invalid reply | “The reply didn't match anything Cortex can do, so nothing was changed.” **Show the raw reply** |
| Citation failed validation | The statement is dropped and the reply ends with “One statement was removed because its quote couldn't be found in your record.” |
| Too broad | “That would change ‹n› items at once. Narrow it down, or check them in Agents › Checks.” |
| Not allowed | “Ask can't do that. These are the actions it can take: type / to see them.” |

**Change history and Ask history.** The History button opens Change history in the sheet (§5.30.5); its second tab, Ask history, lists past exchanges. Ask exchanges are stored as record entries of source `cortex-ask` under `.raw/chats/cortex-ask/` and are drawn on the figure only when Layers › Ask history is on.

### 5.11 Status: tokens, header chips, toasts, status bar

Status is spread over four places instead of one block:

| What | Where | Copy / behaviour |
|---|---|---|
| What is traced, and how much | Command line tokens + readout | “214 traced · Clear” |
| Selection | The reader's header; the live region for screen readers | Note or map selected: a source-count chip in the reader header, “27 sources”, plus the drawn source lines. Entry selected: “Cited by 3 notes” chip. Conversation selected: “549 messages · 6 notes” chip. |
| Live capture | Header “● Live” | tooltip above |
| Held arrivals | Header pill “‹n› new” + one toast | Toast: “‹n› new entries from ‹k› Claude Code sessions” / “Held back so the view doesn't shift while you look” · **Show them** |
| Agents | Header agent chip; Obsidian status bar item; Agents page | below |
| Results of actions | Toasts (stage bottom right) | change cards with Undo change, 8 s, hover pauses; errors stay until dismissed; max 3 |
| Background events while the tab is hidden | Obsidian notices | “Cortex imported 2 new Claude Code sessions.” · “Cortex paused its agents: today's token cap is reached.” · “Claude Code needs you to sign in again. Cortex will keep checking every 5 minutes.” · “Cortex can't find Claude Code. Its agents are waiting.” |
| Work waiting | Agents page (§5.20); agent chip tooltip | “Label: 1,284 conversations waiting · Summaries: 46 · Your checks: 63” |

**Obsidian status bar item.** Glyph + text, click opens Cortex on the Agents page, tooltip “‹used› of ‹cap› tokens used today”. Texts: “Cortex · organising 3”, “Cortex · importing 63%”, “Cortex · 1,284 waiting” (idle), “Cortex · up to date”, “Cortex · paused”, “Cortex · cap reached”, “Cortex · sign-in needed”, “Cortex · Claude Code not found”, “Cortex · engine offline”, “Cortex · set up” (before the first-run step).

### 5.12 Hover, tooltip, label chips, selection

**Tooltip formats** (glass-strong, 3 px colour bar = the point's colour):

| Item | Line 1 (13/600) | Line 2 | Line 3 | Hint (11 px) |
|---|---|---|---|---|
| Message | first line or title, ≤ 60 characters | “Claude Code · 39 / 549” (mono numbers) | “3 Nov 2026, 14:52 · Roblox” | “Click to read · double-click for the conversation” |
| Document passage | document title | “.raw · passage 3 of 12” | “No date of its own · Roblox” | “Click to read” |
| Machine note | kind glyph + note text, ≤ 60 characters | “Decision · sonnet” | “4 Nov 2026 · Roblox” | “Click to read · 6 sources” |
| Vault note | title | “Vault note · layer 4” | “wiki/kb/business/… · Money” | “Click to peek · Ctrl+click to open” |
| Map | ✦ + title | “Project map · Roblox” | “14 Oct – 8 Nov 2026” + mono “26 notes · 1,204 sources” | “Click to read · Shift+click to trace every source” |
| Chart mark | value label | “‹n› entries · ‹p›%” | period | “Click to trace” |
| Line | “Source line” or “Conversation stem” | “‹note title› → 1 of its ‹n› sources” or the conversation title | — | — |

**Label chips.** Shown for traced, found and selected items and for a selection's notes while Names is “On hover”; for the largest groups and maps always while Names is “Always”. At most 24 at once, chosen by size then nearness. Each chip carries its kind glyph. Placed by a small screen-space force layout that keeps them off each other and off the overlays' rectangles, joined to their points by 1 px leaders at 42% white. Depth fade: nearest 100%, farthest 45%. A hovered map does not scatter chips; it shows its member card (§6.9).

**Selection.** Click: everything else dims to 6% of its rest brightness (the haze to 35%) in 150 ms; the selected point is white at 2.4× with a 2 px accent ring; source lines draw on (§6.10); the camera flies (§6.8); the reader opens. A group selection (key chip, Read folder, chart band, Agents pack row, a whole conversation) traces its members and adds a token, without flying; a conversation also brightens its notes and draws their source lines (main.png).

### 5.13 The sheet (container for pages and readers)

**Header** (52 px): back button (when the stack has more than one entry), a crumb line (11 px, `--cx-text-3`) with the previous entry's name and “›”, or, for a conversation, note or map, its parent map, title (15/600, truncated), page actions (28 px icon buttons; text buttons where the action needs a word, such as “New entry”), close.

**Stack.** Up to 12 entries. Alt + ← back, Alt + → forward. Header tabs reset the stack. Scroll position is remembered per entry. Clicking the crumb opens that parent.

**States.** Every page shows skeleton blocks (rounded `rgba(255,255,255,.06)` bars that pulse once per 1.2 s) for up to 300 ms while data loads, then content. Errors inside a page show an inline card: icon, one sentence on what failed, what still works, and **Try again**.

### 5.14 Reader: record entry (your original words)

**Header.** Back, crumb (the conversation's title ›), title “Message” / “Document passage” / “File” / “New entry”, a chip “Cited by 3 notes”, actions Pin, Show in brain (F), More → Edit as a new version (E) · Correct the date… · Correct the speaker… · Leave this out… · Copy text · Copy link · Show in Read.

**Body, top to bottom** (panels.png)

| Block | Spec and copy |
|---|---|
| Facts grid | A compact card on `--cx-chrome-alt`, 12 px: **Speaker** (marker + “You”, “Assistant (‹model›)”, “Another person”, “Tool”) · **Source** (icon + “Claude Code”, “ChatGPT”, “Claude.ai”, “Gemini”, “.raw”, “Folder”, “New entry”) · **Project** · **Area** (dot + name) on two half-width rows, then full-width rows **Written** (“3 Nov 2026, 14:52”, or “No date of its own”) · **Imported** (“3 Nov 2026, 15:10”) · **Date** (a confidence pill Strong / Medium / Bound / Unknown + the link “How this date is known”). |
| Date evidence | The link expands one line per piece of evidence with its strength: “Claude Code timestamp on the message · strong”, “First imported 3 Nov 2026 · upper bound”, “Committed to git 7 Oct 2026 · upper bound”; with date seals on (P2) also “Sealed on this computer in block 418 · provable bound” and “Timestamped publicly on ‹date› · provable bound”. |
| Title | 18/600, up to 3 lines. Untitled messages use their first line with Markdown removed. |
| Verbatim text | 2 px solid left rule in the speaker colour; 14 px / 1.62. Rendered by Cortex's own inert renderer: headings, emphasis, lists, block quotes and code as inert preformatted text; no HTML, no embeds, no remote images (shown as “Image: ‹alt› · ‹host›”), links shown as text with their address and opened only after **Open link** in a confirmation. Documents get a **Formatted · Source** switch; Source shows the untouched text. Roblox creator docs end with “Roblox Creator Documentation · CC BY 4.0”. A secret found at import shows as a lock chip “secret kept on this computer” with **Show on this computer** (§5.30.7). |
| Frond scrubber | “In this conversation” and mono “39 / 549” at the right; under it a 360 × 14 px bar of the conversation's messages, one sliver each, coloured by speaker (you amber, assistant violet, tool slate and shorter), part boundaries as ticks under the bar, the current message as a white tick with a caret. Click or drag to step; ←/→ step one message while the bar has focus. A key under it (you · assistant · tool) and **Open conversation** at the right (§5.30.2). |
| Attachments | Card per file: name (12/600), size, **Export file…** (system Save dialog). When Cortex kept only the text (no stored copy), there is no button and the card reads “Cortex kept only the text of this attachment.” |
| Labels | One chip row: machine labels dashed, yours solid, and a final solid chip “+ Add label”. Under it a model line with the glyph: “From its conversation · haiku · session 1.0.0 · 3 Nov” (messages inherit their conversation's labels). **Correct** at the section's right opens inline pickers per field; saving posts “Relabelled · Undo change”. With no labels the row holds only “+ Add label”. |
| Notes that cite this | Machine notes and maps citing this entry, with kind glyphs: title + “Decision · sonnet · 3 Nov”, maps “Project map · 26 notes”. Hidden when empty. |
| Related | Shared-term chips with counts (“trade 4 · slot 2 · confirm 2”), the first selected; under them the entries sharing that term: speaker marker, title, “28 Oct · Claude Code”. Clicking the selected term again traces it on the figure. |
| History | One chronological list, each line with its time at the right: “Imported from Claude Code”, “Labelled by haiku · session 1.0.0”, “Cited by sonnet in a summary”, “Version 2 by you · fixed a typo · diff”, “Read by sonnet for an Ask answer”, “Left out by you”, “Brought back by you”. Machine lines carry a dotted hollow marker, yours a filled amber one; “diff” shows that version's changes inline. |
| Where it lives | Collapsed: the store path and line, **Copy path**. |

**Edit as a new version.** The verbatim block becomes an editor with the banner “You're writing a new version. The original wording stays in History.” Buttons **Save version** (Ctrl+Enter) and **Cancel**. Saving posts “Saved version 2 · Undo change” and marks notes that cited the old wording as stale (“This note cites an earlier version. It will be refreshed.”).

**States.** Loading: “Opening…” (12 px) for up to 300 ms, then skeleton. Left out: banner “You left this out on 5 Nov. Nothing was deleted.” **Bring it back**. Missing source file: “The original file for this entry has moved or been deleted. Cortex still has the text it copied on 3 Nov.” Not downloaded: “This text is stored in OneDrive but isn't on this computer yet.” **Try again** (Cortex asks Windows to fetch the file). Unreadable: “Cortex couldn't read this entry's stored text. Rebuild the index from Settings › Advanced, or include it in Export diagnostics.”

### 5.15 Reader: conversation, and machine notes

**Conversation reader** (main.png). Opened by double-clicking a message on the figure, from Read, from a note's crumb, or by clicking a frond tick on the Time page.

| Block | Spec and copy |
|---|---|
| Header | Crumb: the conversation's project map, when it has one (“Roblox inventory sync ›”). Title: the conversation's title (your title > the model's title > its first line). Actions: Pin, Show in brain (F), More (Open in editor for its summary file, Copy link, Leave this out…), close. Chip: “549 messages · 6 notes”. |
| Facets | One row of dashed machine chips directly under the header, shown once: “work debug” · “outcome shipped” · “project roblox-inventory” · “topics trading · inventory”. Your labels appear in the same row as solid chips. |
| Gist | The sheet's subtitle: one sentence (≤ 240 characters) beside a 2 px dotted machine rule, then a model chip “sonnet · 4 Nov”. There is no disclaimer sentence: the dotted rule, the hollow markers and the model chip already say a model wrote it. |
| Facts line | Source icon + “Claude Code” · mono “549 messages” · mono “3 Nov 14:05 – 4 Nov 10:12” · area dot + name. |
| Stem | A vertical 2 px stem in the conversation's age colour, one hollow node per part. Each node: the part's title (12.5/600, written by the summary job) and a mono line “3 Nov 14:05–14:40 · messages 1–38”. The notes taken from that part hang off the node as 28 px rows: kind glyph box, the note's text, a chevron. A row expands in place to its quotes: speaker marker (filled amber for you, hollow violet for the assistant), the exact quote in quotation marks, the time at the right; clicking a quote opens its entry. |
| Your fixes | Your corrections sit inline at the node they changed: a row with a 2 px solid amber rule, a pencil and “Your fix”, the text, its date: “The timeout is 5 s, not 30 s · 4 Nov”. |
| Actions | **Open conversation** (the whole thread, §5.30.2) · **Looks right** (counts as checked) · **Correct** (inline box “What's wrong or missing?”, saved as your fix and passed to the next summary run). |

States: no summary yet: “No summary yet. The agents summarise a conversation 30 minutes after it goes quiet.”, with the stem drawn from the parts alone (“Part 1”, “Part 2”…) and no facets. While a refresh runs: a 2 px progress line under the facets and “Refreshing with sonnet…”; the current summary stays until the new one passes its checks.

**Machine note** (decision, question, idea, plan, abandoned idea, concept)

| Block | Spec and copy |
|---|---|
| Header | Crumb: its conversation ›. Title: the kind (“Decision”). Chip “6 sources”. Actions Pin, Show in brain, More (Open in editor, Copy link). |
| Statement | The note's text, 18/600, after its kind glyph. Under it, beside a dotted rule, a model chip “sonnet · 4 Nov” and the link **Trace its sources** (traces them and scrolls to the quotes). |
| Part | “Part 2 · 14:52–16:30 · messages 39–188”, a link to that node in the conversation reader. |
| Quotes (‹n›) | One row per cited passage: speaker marker, the exact quote in quotation marks, mono date and time at the right; a click opens the entry. |
| Actions | **Looks right** · **Correct** · More → Open in editor (file-backed notes), Copy link |

**Legacy vault notes** that are interpretations (all of `wiki/**`) use the note peek (§5.17), not these readers.

**How a summary is written to disk.** The markdown in `wiki/derived/gists/` mirrors the reader, not a report: facets only in `cortex_*` frontmatter, then a machine callout, then a timeline of parts.

```markdown
---
cortex_id: n_5k2…
cortex_kind: summary
conversation: c_k2fh3j4k5l6m7n8p
made_by: "claude-sonnet-5-5 · run r_c99… · 2026-11-04"
cortex_work: debug
cortex_outcome: shipped
cortex_project: roblox-inventory
cortex_topics: [trading, inventory]
cortex_state: current
---
> [!cortex-machine] Machine summary · claude-sonnet-5-5 · run r_c99…
> You traced item duplication to two trades resolving in the same frame and locked slots until the server confirms.

## Timeline
### 3 Nov 14:05–14:40 · Reproducing the duplication
- question: Why do items duplicate in trades? ^n-4f2a [^1]
### 3 Nov 14:52–16:30 · Locking slots while trades confirm
- decision: Lock slots while the server confirms ^n-77b0 [^2]
- plan: Release a held slot after 5 s ^n-81c3 [^3]

[^1]: [e_q3k2v7m4c5x2a9pd v1](obsidian://cortex?entry=e_q3k2v7m4c5x2a9pd) · you · 3 Nov 2026
[^2]: [e_7hdk… v1](obsidian://cortex?entry=e_7hdk…) · assistant · 3 Nov 2026
```

Every model string in that file (the gist, part titles, note texts) passes through the inert-markdown escape before it is written; the list markers, headings, callout line and citation links are written by Cortex from validated ids only; the footnotes carry no quote text (the reader shows the quotes from the ledger). §12.11 has the rules.

### 5.16 Reader: map

A map is a machine index of the notes about one project, area or topic (panels.png).

| Block | Spec and copy |
|---|---|
| Header | Crumb: the parent map (“Roblox ›” for a project map inside the Roblox area map). Title. Actions: Flag (icon `flag`), Pin, Show in brain (F), More (Open in editor, Copy link, Trace all sources), close. Chip “1,204 sources”. |
| Kind line | ✦ glyph box + “Project map” / “Area map” / “Topic map”, then a 96 × 20 px sparkline of member notes per week over the last 12 weeks (bars brighter toward now), then mono “last 12 weeks”. Recency is read from the sparkline; there is no status sentence. |
| Brief | 3–5 bullets beside a dotted machine rule, 12.5 px. Each bullet starts with an evidence meter (§4.9) counting the quotes behind it from you and from the assistant; a bullet whose top bar is empty rests only on the assistant. Clicking a bullet expands its quotes. A model chip ends the brief: “sonnet · refreshed 8 Nov”. |
| Kind filter | Chips with counts: “All 26 · Decisions 8 · Questions 7 · Plans 4 · Ideas 5 · Abandoned 2”. |
| Members | Grouped by kind (glyph, kind name, count). Rows of 27 px: the note's text, mono date, chevron; a row expands to its quotes (speaker marker, quote, date). At most 3 rows per kind, then “+‹n› more”. |
| Footer | mono “26 notes · 1,204 sources” and **Trace all sources**. |
| Flag | The Flag icon opens a 3-line box under the header: placeholder “What's wrong or missing in this map?”, **Save** and **Cancel**. Saving posts “Flag saved. The next refresh has to answer it.” Open flags are listed under the header with their state (“waiting”, “answered on ‹date›”) and **Resolve**. |

**Figure side effects while open:** the map's beacon pulses, its members light, and its sources brighten as a braid in the map's territory colour (§6.9); in charts its sources are ringed in place with a count chip (§7.1).

**States.** A kind with no members is not listed. No members at all: “No notes in this map yet.” While a refresh runs: a 2 px progress line under the header and “Refreshing with sonnet… The current map stays until the new one passes its checks.” A failed refresh: “This map couldn't be refreshed on ‹date›. It shows the last good version.” **Try again**. Active, cooling and dormant exist only as a filter in Read (§5.18).

### 5.17 Reader: vault note peek

For notes Obsidian already shows. Header title = note title. Meta “Vault note · ‹path› · ‹area› · layer ‹n›”. Under it, beside a dotted rule: “Written before Cortex by Claude or a script; the model wasn't recorded.” Body: the first 3,000 characters rendered with Obsidian's `MarkdownRenderer` (Obsidian renders these notes anyway), then **Show all**. Buttons **Open in editor** (Enter; new tab next to Cortex) and **Open to the right** (Ctrl+Enter), link **Trace its links**, and “Linked from ‹n› notes”. Moved or deleted: “This note was moved or deleted in your vault.” **Find it** (opens Obsidian's quick switcher with the title).

### 5.18 Read

**Purpose.** Everything you have, by date, folder or source; what happened today; writing a new entry; tracing what you browse (panels.png).

| Part | Spec |
|---|---|
| Header | “Read”, a text button **New entry** (§5.24), More. |
| Filter | Field “Filter this list”; toggle “Trace results on the figure” (on). |
| Segmented | **By date** · **By folder** · **By source**, then two toggle buttons: Pinned only (`pin`) and Today (`sun`). |
| By date | Day headers (“Today”, “Yesterday”, “This week”, then months) over rows. |
| By folder | A tree (areas → folders → subfolders) with dots and counts, up to 40% of the sheet height, resizable; choosing a folder traces it (token “Folder: kb/business”) and lists its items below. A menu “Maps: All · Active · Cooling · Dormant” filters map rows (active: newest member note within 30 days of your newest entry; cooling: 30–120 days; dormant: beyond). |
| By source | Claude Code projects, chat exports, vault, `.raw/`, folders, new entries, Ask, each with a count and a speaker-split bar. |
| Today | With Today on: “Today · Monday 9 November”, **Open today's daily note**, the list limited to today's entries and notes, and a footer “38 runs · 412,880 tokens today” linking to Agents. Empty: “Nothing yet today. Anything you write or import today shows up here.” |
| Pinned only | Pinned items and pinned views (§7.4); a pinned view shows its name, what it shows (“Calendar by source · last 90 days”) and **Copy link**. Empty: “Pin anything from its reader, or a view from More, to keep it here.” |
| Sort | Menu: Newest · Oldest · Most messages · Title |
| List row (44 px) | A 4 px speaker-split bar (your share of the words in amber over the assistant's in violet; documents and new entries are all amber), the title (12.5 px, one line), a right-aligned relative time (“2 h”, “1 d”, “6 d”), and one snippet line (11 px, `--cx-text-3`) that starts with the source icon and an area dot. No meta line. |
| Row click | Pushes the matching reader (the list stays one Back away) |

Empty folder: “Nothing in this folder yet.” Filter with no results: “Nothing matches “‹text›”. Try fewer words, or press Tab in the command line to ask.”

### 5.19 Time

**Purpose.** The record laid out on its own time scale; set the period (panels.png).

**Header.** “Time”, a small segmented control **Figure · Data**, actions Save image… and More. Subtitle (13 px, `--cx-text-2`): “Your spine, laid flat. Drag across it to set the period.”

| Part | Spec |
|---|---|
| Rhythm | A 7 × 24 weekday-by-hour grid (8 px cells, 2 px gaps) in the count ramp for the current period; rows Mon…Sun, columns 00…23; header right “weekday × hour · this period”. Hover a cell: “Tuesdays 21:00 · 1,204 entries”; click traces it (token “Tue 21:00–22:00”). |
| Spine figure | 360 px wide, about 260 px tall, on the 3D cord's own spine scale τ (§6.3), so a conversation's x here is its place along the cord. Top to bottom: **your words** as a filled area above a centre axis (amber fill at 55% with a 1 px edge), labelled at its top left “yours: ‹p›% of words, ‹trend›” (rising, falling or steady over the period); the **axis**, a 3 px bar in the age ramp, carrying the machine notes as kind glyphs (◆ decision, ? question, ▸ plan, × abandoned, ✶ idea) at the spine position of their source conversation; **the assistant's words** mirrored below in violet, labelled “assistant”; and a **fronds** lane: one 1 px tick per conversation rooted at its first message, length ∝ log(messages), coloured by area, labelled “conversations”. A selected conversation's tick is white and carries its message count. With “Hide No area” on, conversations without an area leave the figure. |
| Axis labels | Calendar labels at the spine positions where they fall (“Feb 2023”, “2024”, “2025”, “2026”, “Oct”, “today”); under the key: “spine scale: busy weeks get more room”. |
| Brush | One brush across the whole figure sets the period, exactly like the strip's; outside the period is scrimmed and the dates sit beside the handle (“period: 2 Oct – today”). |
| Key | The kind glyphs with their names; a tick's tooltip names its area. |
| Longest conversations in this period | Read rows (§5.18) for the top 4, then “Show all in Read”. |

**Interactions.** Hover a tick → the conversation's tooltip and a preview on the figure; click → select it (conversation reader, strip bracket); hover a glyph → the note's tooltip; drag across → set the period; Esc → clear. Undated entries are counted only in the strip's Undated pill.

**Data view.** The Figure · Data switch shows the numbers as a table: Rows [Area ▾], Columns [None · Week · Month · Year · Source ▾], Count [Entries · Notes · Words ▾]. Any label field can be the rows, so labels across months are Rows = a label field, Columns = Month. Sticky first column, sortable headers, mono numbers, a share column, a totals row. Actions **Copy data as CSV**, **Copy as Markdown table**, **Trace selected rows**. The period follows the brush. Charts' **Show as table** opens this view pre-filtered. Empty: “Pick what to count, and Cortex fills the table.”

**Empty.** “Nothing dated in this period. Widen the period on the strip, or choose All time.”

### 5.20 Agents

**Header.** “Agents”, actions Export ledger, More. A segmented control **Ledger** · **Checks** ‹n› · **Access log**. Subtitle: “Model runs, their cost in tokens, and what they changed.” (panels.png)

**Ledger**

| Block | Spec and copy |
|---|---|
| Status card | Spinning glyph + state + detail, **Pause** / **Resume**, **Run now** (when idle). States: “Organising · 3 jobs · label, summary, summary”; “Up to date · last run 14:22”; “Paused by you. Nothing runs until you resume.”; “Today's cap is reached. Work resumes at midnight.”; “Claude Code needs you to sign in again. Run claude once in a terminal; Cortex checks again every 5 minutes.”; “Cortex can't find Claude Code at ‹path›.” **Open settings**; “Claude Code isn't answering. Cortex will try again in 5 minutes.”; “Agents are off. Turn them on in Settings › Agents.” |
| Engine line | “Claude Code CLI, headless, no tools. Labels with haiku, summaries with sonnet, maps with opus. Signed in through Claude Code; Cortex stores no key.” When the runner works inside Obsidian a second line: “Imports run inside Obsidian and are slower because Cortex can't find Node.js. Install Node 20 or later, or set its path in Settings › Advanced.” |
| Today | Mono count “566,240” + “of 1,000,000 tokens”; 6 px meter; “57% of today's cap” · “≈ 5 h of work left at this pace”; header right “resets at midnight”. |
| Work waiting | Header right “since ‹first import date›”. A line “Label 1,284 conversations · Summaries 46 · Your checks 63”, then one stacked bar per source (Claude Code, ChatGPT, Claude.ai, Gemini, Vault notes, Documents) with its total: checked by you (green), done (blue), waiting (grey). |
| Recent runs | Table Time · Job · model · Tokens · Result (done, partly, failed, capped, stopped). A row expands to four fields, **Items · Labels · Declined · No answer**, and a line “label@1.0.0 · 1,840 in / 212 out · 41 s · from the plugin” (or “from /cortex-organise”). **All ‹n›** opens the runs ledger (§5.30.6). |
| Label packs | Table Pack · Labels · Items · Blank; a pack row expands to one row per field (field, labels, coverage %, blank); clicking a row traces that pack's items. Header toggle “Include superseded labels” (off). **Manage** opens Settings › Agents. |
| Last 14 days | Bars of tokens per day, a dashed cap line labelled “daily cap 1,000,000”; capped days in `--cx-serious`. |
| Privacy | “Assistant replies imported from ChatGPT and Gemini are never sent to a model; models only see what you typed there.” · “Every model call is logged with what it read: see Access log.” · link **Off limits** (Sources › Privacy). |

Before the first run: “No runs yet. The first runs start after Obsidian has been idle for a minute.” Today shows 0; Work waiting shows the backlog; Recent runs and Last 14 days are hidden; Label packs show “–”.

**Checks.** §5.21.

**Access log.** A sortable table **Model · Route · Items read · First · Last**, for example “claude-haiku-4.5 · Claude Code → Anthropic · 41,208 · 9 Oct · today 14:22”. Route names where the text went (“Claude Code → Anthropic”, later “this computer” for a local model). Clicking a row traces what that model read. Retention follows Settings › Privacy › “Keep the access log”. Empty: “The access log is empty.”

### 5.21 Checks (a tab of Agents)

**Purpose.** Confirm or correct what the agents decided; your answer always wins.

**Where checks come from.** Every label or summary run adds one check per item it labelled or summarised, with the model's confidence and its reason (at most 140 characters). Filing runs add filing checks; the name check adds mention checks; a summary you edited in Obsidian that the agents wanted to refresh adds a conflict check. The Agents tab's badge counts unresolved checks. With Settings › Agents › “After labelling” = **Hold for my check**, labels wait and count nowhere until you confirm them.

| Part | Spec and copy |
|---|---|
| Progress | “‹n› checked today · ‹m› waiting” + filter chips: All · Labels · Summaries · Filing · Mentions · Conflicts · Unsure (confidence < 0.6) |
| Card | Context line “Conversation · Claude Code · 3 Nov”; title; an excerpt of your words (solid rule, 6 lines max); the proposal (dotted rule) “session 1.0.0 suggests” with one row per field “work → debug” and the confidence in mono; a model chip; **Why?** shows the model's reason under the label “The AI's reason”. |
| Buttons | **Confirm** (1, primary) · **Change** (2) · **Reject** (3) · **Skip** (4) |
| Change | Inline pickers for each field; **Save** |
| Reject | Reason chips: “Wrong”, “Not about this”, “Too vague”, “Other…” |
| Filing | “Suggested place: Roblox › roblox-inventory · 0.82”. Applied only if you confirm; filing is never applied by itself. |
| Mention | “Another person's message mentions “Ari”.” with the quote; **That's me** · **Not me** · **Skip**. |
| Conflict | “You edited this summary in Obsidian. Cortex kept your version; the agents' new version is here.” with a side-by-side diff; **Keep mine** (primary) · **Use theirs**. |
| After each | The next card slides in (260 ms); a change toast with Undo change |

Empty: “Nothing to check. New suggestions appear here as the agents work.” Done: “All caught up. You checked ‹n› suggestions today, and the agents follow your answers from now on.” Keys: 1–4, J/K next/previous, Z undo the last answer.

### 5.22 Sources (with privacy)

**Header.** “Sources”, button **Add sources**, More. A segmented control **Sources** · **Files** · **Privacy**. Subtitle: “Everything Cortex reads, where it's kept, and how fresh it is.”

**Sources.** One row per source: status pill, counts, a **your words** column (the share of that source's words that are yours, mono, with a speaker-split bar), last import, storage path (“Stored in .raw/chats/claude-code/ · not tracked by git”), and a menu: Pause watching · Import again · Remove source… (§5.30.4) · Reveal folder. Below the rows, **Needs attention** when anything does: “3 conversations couldn't be imported. Cortex will retry at the next pass.” **Show details** · “OneDrive made a conflict copy of a Cortex ledger (entries-‹HOST›.jsonl). Cortex ignores it until you choose.” **Show** · “12 files are in OneDrive but not on this computer yet.” **Fetch now** · other runner warnings by kind (§5.31).

**Files.** Imported documents and attachments by folder; rows show name, size, versions, a state (“Unchanged since import” / “Changed on disk · import the new version?”) and **Export file…** when a copy is kept.

**Privacy.** An **Off limits** table, Path or app · Reason: “Browser profiles · never read” · “Mail and password stores · never read” · “.env, key and certificate files, .ssh · never read” · “.git and node_modules · never read” · each folder you added in Settings › Privacy · “your choice”; then sources and conversations you left out, each with **Bring back**. Under the table: what each source sends to models (“Claude Code: your words and the assistant's · ChatGPT: only what you typed · …”), and **Names and handles** linking to Settings › Privacy.

Empty: “No sources yet. Add your vault notes and Claude Code sessions to start.”

**Live capture in your browser (desktop hosts).** A panel under the source rows, off by default. Off: a short intro, the three sites the add-on may read (ChatGPT, Claude, Gemini; each with its addresses) as checkboxes, and **Turn on live capture…** (disabled until a site is ticked and while the sample record shows). Its dialog names exactly what is kept: who said it, the full text, the time, the conversation's title and id, on this computer, screened like every source, nothing leaving it. On: a pill (Listening / Paused), the address `127.0.0.1:<port>`, **Pause capture**, **Turn off**, the per-site approve list, the install token (**Copy token**, **Make a new token…**), the port, **Save the add-on** (a zip of `browser-addon/`, no token inside) with the install steps, what was taken, what waits for the next import, and what was turned away by reason (not this computer, wrong address, not from the add-on, no token, wrong token, paused, site not approved, too large, malformed, too many wrong tokens). Entries land as source “Browser capture” through the normal ledger, staging, screening and sealing. Code: `src/plugin/captureServer.ts`, `src/importers/capture.ts`, `browser-addon/`.

### 5.23 Guide

Opened by the header's “?” icon or the ? key. Five cards about elements only Cortex has; each has a 40 × 28 illustration drawn with real particles, a 13/600 title, a 13 px body and **Show me**, which drives the live stage and returns on Esc.

| Title | Body | Show me |
|---|---|---|
| Fronds are conversations | “Each conversation grows from the spine where it started. Long ones grow long fronds; every branch is a part.” | Selects yesterday's longest conversation and opens its reader |
| The strip sets the period | “Drag across the strip at the bottom to limit every view to that stretch of time.” | Animates the brush to the last 30 days, then back |
| The compass turns the figure | “Choose a territory on the compass and the figure turns toward it, keeping only that area.” | Scopes to the largest area, then back |
| The sheet keeps your trail | “Readers and pages stack in the sheet. Back steps through what you opened; the crumb shows where a note came from.” | Opens a note, then its conversation, and highlights Back |
| Tokens are what you traced | “Everything that picks out points becomes a token in the command line. Remove a token to undo just that.” | Traces a word and an area, then highlights the two tokens |

Then the shortcuts table (§8.1) and **Explore the sample record**. Lines need no legend: hovering one on the stage names it (§5.2).

### 5.24 New entry

Opened from Read's **New entry** or `cortex:new-entry`. Subtitle: “Write in your own words. It joins your record as yours and is never rewritten.” Fields: Title (optional, placeholder “Untitled”), body (Markdown, 14 px, min 240 px, grows), Area picker (optional), buttons **Save** (Ctrl+Enter, primary) and **Discard**. Drafts save per leaf every 2 s (“Draft saved”). Saving writes `.raw/written/<yyyy>/<mm>/<yyyymmdd-HHmm>-<slug>.md` (the folder gets its own `.gitignore` with `*` on first use) and posts “Saved to your record · Undo change”; the new point is born at the spine's tip. Undo leaves it out of the record (an exclude fix); the file stays where it is, and the change line reads “Left out of your record · it stays in .raw/written/”. Discard with text asks “Discard this draft? It hasn't been saved.” **Discard** / **Keep writing**. A failed save: “Couldn't save. Your draft is safe; try again.” **Try again**.

### 5.25 Chart page

The sheet page for charts (Chart tool, C, or the shape bar's picker). The chart itself is drawn by the particles on the stage (§7).

| Part | Spec |
|---|---|
| Gallery | Tiles 84 × 64 with a mini drawing and the chart's name, grouped **Compare**, **Over time**, **Rhythm**, **Connections** (§7.2); the selected tile has an accent outline |
| Fields | The dimensions as draggable chips (the key bar's pickers drag too). Drop one on the chart's **x**, **y** or **colour** zone on the stage, or use the pickers “Horizontal ▾ · Vertical ▾ · Colour ▾”. Each axis has a small sort toggle at its end (Date · Name · Count, cycling) and a ⇄ button between the zones swaps them. On round charts Horizontal runs around the circle and Vertical outward. If one dimension would land on both zones, the other zone takes the next sensible one (Area → Folder → Month) and the live region announces it (“Vertical: Folder”). |
| Size and filter | Size [Count · Words ▾]; Filter [None · field = value ▾]; “Hide items without a value” toggle |
| Readings | The chart's readings (up to three), each with **Trace**, and **Ask about this chart**, which opens Ask with the chart attached (“Ask about this chart: Calendar by source, 2 Oct – today”) |
| Chart options | Chart-specific (§7.2) |
| Top N | Stepper “Top ‹n›”, default 20, range 5–60; the rest fold into Other |
| Folders | Treemap and Icicle only: a checklist tree of folders with counts; unticking a folder removes its particles from this chart |
| Actions | **Pin view…** · **Save image…** · **Copy data as CSV** · **Show as table** (Time › Data, pre-filtered) |

### 5.26 Add sources, and the first-run step

**First-run step** (panels.png). The first time Add sources opens, and from the empty-state card, an Obsidian `Modal` (720 px) titled “Set up your record”, subtitle “Choose what Cortex reads. Nothing is imported or sent until you press a button below.”

| Part | Spec and copy |
|---|---|
| Sources | Rows with toggles: **This vault's notes** “1,767 notes · 5,454 reference notes stay hidden and are not sent” · **Documents in .raw/** “2,233 files · read in place; the Roblox creator docs count as reference” · **Claude Code** “381 sessions · C:\Users\you\.claude\projects · text only, no tool output” · **Chat exports** “Claude.ai, ChatGPT and Gemini can be added later from Add sources” **Choose…** |
| What happens | A card of three lines, computed from the sources ticked: **Where the text goes** “Into .raw/chats/ in this vault, which OneDrive syncs. Detected secrets stay on this computer.” · **What models read** “Claude Code and vault text go to Claude through your Claude Code login. Assistant replies from ChatGPT and Gemini are never sent.” · **How long it takes** “About 1,330 conversations and 1,767 notes to organise: roughly 5.2 million tokens, about 6 days at your daily cap of 1,000,000.” |
| Choice | **Import and organise** (preselected) “Import now; agents label and summarise within the daily cap.” · **Import only** “Import now; turn agents on later in Settings › Agents.” |
| Footer | Shield + “Change any of this later in Settings › Privacy and Settings › Agents.” **Not now** · **Start** (primary). Start records the choice and starts background work (§2.2). |

**Add sources** (afterwards). Obsidian `Modal`, 720 px. Title “Add sources”; subtitle “Bring in everything you've written. Cortex copies the words into .raw/ as plain text and never changes them; nothing is committed to git.” A 46 px drop zone: “Drop an export (.zip or folder) here. Cortex works out which service it came from.” Then one row per source: 32 px icon tile, name + status pill, a detail line, and a control. Footer: shield + “Assistant replies from ChatGPT and Gemini are never sent to a model. Change this in Settings › Privacy.” and **Done**.

| Source | Row control | Flow and copy |
|---|---|---|
| **This vault's notes** | Toggle (on) | Detail: “‹n› notes · ‹m› reference notes hidden by default”. Options (Settings): include reference notes; folders to skip (Obsidian's excluded files apply automatically); wiki folders and their areas (§5.27). Indexing: “Indexing ‹n› of ‹m› notes”. |
| **Documents in .raw/** | Toggle (on) | Detail: “‹n› files · the Roblox creator docs count as reference”. Options: treat Roblox creator docs as reference (on); skip YAML (on); skip the API dump (on). |
| **Claude Code** | **Options** | Detected at `%USERPROFILE%\.claude\projects`. Detail: “‹n› sessions · checked ‹t› ago”. First import: “Reading ‹n› sessions… ‹k› of ‹n› · ‹m› messages kept” with a bar. Options: watch for new sessions (on), include subagent conversations (off), include tool output (off), include thinking (off), project → area table. Note: “Claude Code removes old sessions on its own schedule. Cortex copies the text as soon as it sees a session, so nothing it has read is lost.” Errors: “Cortex can't read ‹path›. Check that the folder exists and that Obsidian can open it.” · “Skipped 2 files that aren't session logs.” **Show details** |
| **Claude.ai export** | **Import…** / **Import newer…** | Choose a .zip → “Checking the export…” → preview “842 conversations · Mar 2024 – Nov 2026 · 12 projects · 31 attachments” with “Include the text of attachments” (on) → **Import** → progress “‹k› of ‹n› conversations” → done “Imported 842 conversations (16,930 messages). 12 were already here and were skipped. 3 secrets were kept on this computer.” Errors: “This zip has no conversations.json, so it isn't a Claude export.” · “This export is older than the one you imported on ‹date›. Import it anyway?” **Import anyway** |
| **ChatGPT export** | **Import…** / **Pause** while running | Same steps. Preview adds “Only the branch you kept is imported; edits and regenerations become earlier versions.” Error: “This zip has no conversations.json, so it isn't a ChatGPT export.” |
| **Gemini (Google Takeout)** | **Choose…** | Choose the Takeout .zip or folder; Cortex looks for My Activity › Gemini Apps › MyActivity.json. Preview “‹n› prompts and replies, grouped into ‹m› conversations” + “Takeout doesn't say which messages belong together, so Cortex groups them when they're less than 30 minutes apart.” Errors: “This Takeout has My Activity as HTML. Export it again with JSON selected, then choose it here.” · “There's no Gemini activity in this Takeout.” |
| **A folder of your own** | **Choose folder…** | Choose → “Whose words are these?” [Mine · Another person's · Ask per file] → file types (md, txt, code, json, csv, html) → “Watch this folder for changes” (on) → **Import**. Detail after: “‹n› files · watched”. |

Status pills: Connected (green), Watching (green), Importing (accent), Imported ‹date› (grey), Not added (grey), Needs attention (red). Every row's detail line also states the storage path once imported.

### 5.27 Settings (Obsidian settings tab)

One Obsidian settings tab, “Cortex”, with a header (glyph + “Cortex” 18/600 + version) and a segmented control of six sections. Rows use Obsidian's `Setting` API, so they look native.

**General** (P0)

| Setting | Control | Default | Description |
|---|---|---|---|
| Open Cortex when Obsidian starts | Toggle | Off | “Cortex never opens on its own unless you turn this on.” |
| Pose | Dropdown | Standing | “Standing runs time from the head down. Lying runs it from left to right.” |
| Follow the active note | Toggle | On | “Marks the note you're editing in the brain.” |
| Show reference material | Toggle | Off | “Generated reference notes (status: reference) and reference documents stay off the figure until you turn this on.” |
| Date format | Dropdown | 3 Nov 2026 | 3 Nov 2026 · 2026-11-03 · Nov 3, 2026 |
| Week starts on | Dropdown | Monday | Monday · Sunday |
| Reset display settings | Button | — | “Puts every Cortex view's display back to the defaults.” |

**Sources** (P0): every row from §5.26 with its options; “Refresh automatically” toggle (off: “New entries wait behind a Show them button so the view doesn't shift while you look.”); the Claude Code project → area table (editable dropdown per project; defaults from SPEC §7.2); under This vault's notes, right after Folders to skip, the wiki folder → area table below; a read-only line “Imported chats are kept in .raw/chats/ as text only, with their own .gitignore.”

| Setting | Control | Default | Description |
|---|---|---|---|
| Wiki folders and their areas | Heading, then one row per folder, “Folder ‹n› of ‹total›”: a path field (label “Folder inside wiki/”, placeholder “notes/recipes”), an area dropdown (label “Area”; the ten areas by name) and × (“Remove”). Then “Add a folder” (“Type a path inside wiki/, choose its area, then Add.”): the same field and dropdown and **Add** (primary). No rows: “No folders yet: each note takes the area Cortex finds from its folders.” At 100 rows the add row gives way to “Up to 100 folders.” Notices: “Type a folder inside wiki/ first.” · “‹folder› already has an area. Change it in its row.” | Empty | “Notes in a folder inside wiki/, and in every folder inside it, join the area you choose here. These come before the areas Cortex finds on its own, and when a note sits in two of your folders, the one deeper down wins.” A wiki note's area is decided in that order: your folders (the deepest match), then Cortex's own table for kb/ vaults, then the area words in its folder names, else Vault. Paths are tidied (slashes, spaces) and matched as written. Editing a row saves at once; the brain re-places the wiki notes a few seconds after the rows stop changing, with no restart, and agent work reads the rows at its next run. |

**Agents** (P0)

| Setting | Control | Default | Description |
|---|---|---|---|
| Organise automatically | Toggle | On (after the first-run step) | “Agents label and summarise new material in the background within the daily cap, and suggest where things belong.” |
| Engine | Dropdown | Claude Code CLI | Anthropic API and Local model are listed as “later” and disabled |
| Claude Code path | Text + **Test** | `%USERPROFILE%\.local\bin\claude.exe` | Test: “Claude Code ‹version› answered in 1.8 s.” / “Couldn't run Claude Code at this path.” / “Claude Code is installed but needs you to sign in. Run claude once in a terminal.” |
| Models | Four dropdowns | Labels haiku · Summaries sonnet · Maps opus · Ask sonnet | The aliases the CLI accepts |
| Daily token cap | Number | 1,000,000 | 50,000–20,000,000. “When the cap is reached, agents stop until midnight.” |
| Ask counts toward the cap | Toggle | On | |
| Apply Ask's changes without asking | Toggle | Off | “When off, every change from Ask waits for you to press Apply. Corrections and bringing things back always wait.” |
| Only work while Obsidian is idle | Toggle | On | “Starts after 60 seconds without typing.” |
| Nightly pass | Toggle + time | On, 03:00 | |
| Jobs at once | Slider | 2 | 1–4 |
| Label packs | Rows with toggles and versions | session on · placement on · PARA (from wiki-mode) · Your fixes (always on) | PARA is available only when the vault's wiki-mode is PARA; here: “This vault uses generic mode, so there is nothing to read.” |
| After labelling | Dropdown | Apply and show in Checks | Apply and show in Checks · Hold for my check |
| Leave reference notes out of agent jobs | Toggle | On | “Generated reference notes are never sent to a model unless you turn this off.” |
| Run now · Pause agents | Buttons | — | |

**Privacy** (P0)

| Setting | Control | Default | Description |
|---|---|---|---|
| Names and handles that mean you | Tag field + **Check other people's words for these** | empty | “Cortex uses these to tell your words from other people's and to find mentions of you.” The button runs the name check on demand; results arrive as mention checks (§5.21). |
| Which speaker is you | Per folder and export | You | You · Ask per file |
| Off limits | Fixed list + editable folders | — | the list in §5.22 |
| Left out | List with **Bring back** | — | sources and conversations you left out |
| Don't send assistant replies to models from | Four toggles | ChatGPT on · Gemini on · Claude.ai off · Claude Code off | “Those two services weren't Claude, so by default only what you typed there reaches a model.” |
| Remove before sending | Toggles + custom patterns | API keys and tokens on · email addresses on · phone numbers on | |
| Keep detected secrets out of the vault | Toggle | On | “Secrets found while importing stay on this computer, outside OneDrive. The record shows where they were.” |
| Keep the access log | Dropdown | Forever | Forever · 1 year · 90 days |
| Clear local cache | Button | — | “Cortex rebuilds it from your vault. Your record, notes and fixes are not touched.” |

**Appearance** (P1): Stage (Follow theme · Ink · Paper); Stage tint (slider, Off by default); Palette (Prism · Signal · Print); Age colours (Hue and lightness · Lightness only); Frosted panels (on; “Turn off if the view feels slow.”); Names on the figure (Off · On hover · Always); Lines (Off · Selection · All); Conversation stems (off); Patterns on charts (off); Motion (Follow system · Reduced · Full); default Dot size, Glow, Brightness; Strip scale (Log · Linear).

**Advanced** (P2): cache location (read-only, `%LOCALAPPDATA%\cortex\<vault-id>\`) with **Open folder**; logs (`.vault-meta/cortex/`) with **Open folder**; Node.js path (automatic, with **Test**: “Node 24.18.0 found. Imports run in their own process.” / “No Node.js found. Imports run inside Obsidian and are slower.”); **Rebuild index**; **Date seals**: “Seal new entries on this computer” (off), a line “‹n› blocks sealed · last ‹date›” and **Timestamp publicly…** (explicit opt-in; it makes a network request); Point budget slider (100,000–500,000, default 300,000); Show frame rate (off); **Export diagnostics** (runner mode, Node and Claude Code versions, recent warnings, and the names, never the values, of the environment variables passed to Claude Code).

### 5.28 First run, hints, sample record, reset

- **First-run checklist and step**: §5.2 and §5.26. The checklist ticks “Add a source” when the first-run step starts an import, “Open one conversation frond” when a conversation reader first opens, and “Ask one question” when Ask returns its first answer.
- **One-time hints**: §5.2. They are per device and per surface, never repeat, and never stack (one at a time, the newest wins). “Cortex: Reset hints” shows them again.
- **Sample record** (“Explore the sample record”, More › Sample record, `cortex:toggle-sample`). A generated, read-only sandbox: about 30,000 entries and 3,500 notes over three years, six invented areas (Garden, Studio, Ledger, Workshop, Travel, Reading). The header shows the “Sample” pill; a one-time banner says “This is a made-up record so you can try things safely. Nothing here is yours, and nothing you do is saved.” **Leave the sample**. Agents, imports and Ask's data changes are disabled in the sample (“Not available in the sample record.”).
- **Reset display**: §5.6.

### 5.29 Banners and sparse states

Banner slot: stage top centre, under the key bar, glass, max 560 px, icon + one sentence + up to two buttons.

| When | Copy | Buttons |
|---|---|---|
| Brain has notes but no record | “Add Claude Code or a chat export to grow the spine.” | **Add sources** |
| Everything is hidden by the key | “Every group is hidden.” | **Show all** |
| Period contains nothing | “Nothing in this period.” | **All time** |
| The scope has nothing | “Nothing in ‹area› yet.” | **All areas** |
| Graphics reset | “The 3D view stopped because the graphics driver reset. Click to restart it.” | **Restart** |
| First-run checklist not finished | the checklist card (§5.2) | **Hide checklist** |

**Thin groupings get no banner.** In Groups and Chart shapes, a group with fewer than 30 items is drawn as a hollow outlined sphere (or an outlined bar or cell) with a small “n” chip showing its count. The shape bar's picker carries a warning dot; its menu opens with the label “‹k› groups have fewer than 30 items” and the action **Fold groups under 30 into Other** (the fold control from the key bar, applied with Undo).

### 5.30 Dialogs and secondary pages

**5.30.1 Correction dialogs** (from a reader's More menu or Ask; each is an Obsidian `Modal`, 480 px, and saves a fix with Undo change)

| Dialog | Contents and copy |
|---|---|
| Correct the date… | Title “What's the right date?”; a date field and an optional time; the current evidence list, read-only; **Save** / **Cancel**. Change: “Re-dated to 2 Oct 2026 · your date overrides the evidence”. |
| Correct the speaker… | Title “Who wrote this?”; choices You · Assistant · Another person · Tool; “Apply to” This entry · Every message from this speaker in this conversation; **Save** / **Cancel**. |
| Leave this out… | Title “Leave this out of Cortex?”; scope This entry · This conversation · Everything from ‹source›; the explanation “It leaves the figure, search and summaries. Nothing is deleted: the original stays in .raw/, and a summary written only from it is replaced by a short placeholder until you bring it back.”; **Leave out** / **Cancel**. |

**5.30.2 Whole conversation.** “Open conversation” pushes a thread page: the frond scrubber pinned at the top acts as the scroll position; messages in order, each with its speaker marker, time and text (inert renderer, §5.14); part dividers labelled as on the stem; tool output, when imported, collapsed to one line “Tool output · ‹n› lines”. Long conversations load 200 messages at a time with **Earlier** / **Later** and a field “Go to message ‹n›”; the message you came from is highlighted; Ctrl F inside the sheet finds within the conversation.

**5.30.3 Names, handles and the name check.** Names and handles are a Settings › Privacy field (§5.27), stored as `you.names[]` and `you.handles[]`, with “Which speaker is you” per folder and export. **Check other people's words for these** runs the name-check job on demand (fast model, logged, within the cap). Each hit arrives as a mention check (§5.21); “That's me” records a fix so the entry carries “mentions you”.

**5.30.4 What leaving out and removing do.** Nothing is ever deleted. Leaving something out removes it from the figure, search and summaries. A summary or map written only from it is handled by who last wrote the file: if Cortex wrote it and you haven't edited it, the file is rewritten as a placeholder (“Left out by you on 5 Nov.”, no quotes) and the previous file is kept in `.vault-meta/cortex/trash/` so Undo restores it exactly; if you edited it, the file is left alone and a conflict check asks what to do. **Remove source…** (Sources) stops watching and leaves out everything that source imported: “Remove ‹source›? Cortex stops reading it and leaves out what it imported. Nothing is deleted; Undo brings it all back.” **Remove** / **Cancel**. Cortex offers no way to delete files.

**5.30.5 Change history and Ask history.** The console's History button and `cortex:change-history` push a page with two tabs. **Changes**: grouped by day, each change card with its state (applied, undone, waiting for Apply), filter chips View · Data · Agents; data changes keep **Undo change** for good. Empty: “No changes yet.” **Ask history**: past exchanges by day; a click reopens the thread in the console; each exchange can be left out like any entry. Empty: “No Ask exchanges yet.”

**5.30.6 Runs ledger.** “All ‹n›” on Agents pushes a page: filters Job · Model · Result · Route · Date range; a table with a sticky Time column that scrolls sideways: Time · Job · Model · Items · Labels · Declined · No answer · Tokens · Result; a row expands to the prompt version, tokens in, out and cached, duration, error text, and an API-equivalent cost when the CLI reports one (“≈ $0.42 at API prices; your plan covers it”). Empty: “No runs match these filters.”

**5.30.7 Secrets kept on this computer.** At import, high-confidence secrets (API keys, tokens, private keys) are replaced in the stored text by a marker; the original line is kept under `%LOCALAPPDATA%\cortex\<vault-id>\held\`, which OneDrive does not sync. Readers show a lock chip “secret kept on this computer” with **Show on this computer**, which reveals it in place for this session. On another computer the chip reads “secret kept on another computer”. The import summary counts them (§5.26); Settings › Privacy turns this off.

### 5.31 System states

| Situation | Where it shows | Copy |
|---|---|---|
| Claude Code needs sign-in | Agent chip “Sign-in needed”, status bar, Agents status card, one notice | “Claude Code needs you to sign in again. Run claude once in a terminal; Cortex checks again every 5 minutes.” Agents are not paused: they resume by themselves when a free check succeeds. |
| Claude Code not found | Agent chip “Claude Code not found”, Agents status card | “Cortex can't find Claude Code at ‹path›.” **Open settings** |
| Engine offline (network, overload) | Agent chip “Engine offline” | “Claude Code isn't answering. Cortex will try again in 5 minutes.” |
| No Node.js (imports run inside Obsidian) | Agents engine line, Settings › Advanced | “Imports run inside Obsidian and are slower because Cortex can't find Node.js. Install Node 20 or later, or set its path in Settings › Advanced.” |
| Background worker unavailable (three restarts in ten minutes) | Banner on Agents and Sources, one notice | “Cortex's background worker stopped three times and is off until Obsidian restarts. Your record is safe.” **Export diagnostics** |
| Index failed to build or load | Stage line, Sources › Needs attention | “Cortex couldn't build its index. The last good one is shown.” **Rebuild index**; with no earlier index: “Cortex couldn't build its index. Nothing is lost; rebuild it from Settings › Advanced.” |
| OneDrive conflict copy of a ledger | Sources › Needs attention | §5.22 |
| Stored text not on this computer | The reader | §5.14 |
| A conversation keeps failing to import | Sources › Needs attention | “3 conversations couldn't be imported. Cortex will retry at the next pass.” **Show details** |
| Any other background warning | Sources › Needs attention, grouped by kind, last 10 | Cortex's own text for that kind, never raw error output, for example “Skipped 2 files that aren't session logs.” |

---

## 6. 3D art direction

`main.png` shows the target look in the selected-conversation state, and `panels.png` uses the plain figure behind its stage frames. Both were rendered by `docs/mockups/src/render_stage.py` with the geometry, sizes and tone mapping below, so the numbers here are tested, not guessed.

### 6.1 What it looks like

A luminous figure standing in the middle of the stage on a deep ink background. At the top, a jewel-like brain made of thousands of small coloured sparks, brighter at its outline: a folded cerebrum split by its fissure, a temporal lobe under each side, and the cerebellum tucked under its back. From the brainstem a thin, bright cord descends the whole height of the figure in a gentle S, its colour rising from dim violet at the brainstem through blue, teal and green to warm white at the tip. Along it, 31 pairs of spinal nerves leave the cord level by level and arch outward and downward like ribs, so the torso is made of the nerves themselves: wider at the shoulders and the hips, narrower at the waist, and open in the middle so the cord shows through as the brightest line in the figure. Every conversation's frond is one of these nerves: it leaves the cord at the moment the conversation began, on alternating sides, long where the conversation was long, dense where you were busy. The newest nerves hang as a fan at the bottom, the cauda equina, and just below the tip floats a small grey cloud of entries with no date. A faint haze of uncoloured points traces the 31 nerve pairs and the folds of the brain so the shape reads even when the record is small. Maps glitter as brighter beacons in the brain. Nothing is outlined or shaded with polygons: every visible thing is a point.

The figure is never turning fast: by default it spins slowly, one turn a minute, so the brain shows its depth and every side of the torso gets its turn. The home view is from behind and a little to the figure's right, looking slightly down, so the cord, the paired nerves and the cerebellum under the brain's back read at once.

### 6.2 Geometry (scene units; the standing figure is about 10 high)

Axes: +Y up, +X the figure's left, +Z the front (the face looks toward +Z). The generator is written once, in this standing frame. **Lying pose** (an option in the shape bar's overflow) rotates the finished figure +90° about Z, (x, y, z) → (−y, x, z), so the brain is at the left and the tip at the right; nothing else changes. Key heights: crown y = +5.00; cerebellum base 2.74; cord tip −4.02; lowest cauda nerve −4.32; lowest point of the undated cloud −4.86. The brain (cerebrum, temporal lobes, cerebellum) is the top 2.3 units, about a fifth of the 9.9-unit height, and the cerebrum alone is 16% of it. Everything below is data-independent anatomy; data only chooses which slots are lit.

| Part | Definition |
|---|---|
| Cerebrum | One superellipsoid (exponent 2.3) centred (0, 4.00, 0.06), semi-axes 1.42 across (X), 1.02 high (Y), 1.60 front to back (Z). Frontal pole narrowed by 12% and occipital pole by 10%, the frontal underside lifted 0.22, the occipital pole lowered 0.08. Flat base: nothing below y 3.40. **Longitudinal fissure:** a groove 0.26 deep and about 0.11 wide down the midline, no slots with \|x\| < 0.06 over the crown (y > 3.78) and down the back (z < −0.55). **Lateral sulcus:** a slot along the line from (z 1.02, y 3.55) to (z −0.46, y 4.00), 0.045–0.065 wide, on \|x\| > 0.5. 88% of slots on the surface, 12% inside (radius × U^0.5 × 0.86). **Folds:** a crest field f from two octaves of isotropic band-limited wave noise (16 random directions each, wavenumbers 11 and 19 per unit); a surface slot is kept with probability 0.04 + 0.96 f⁷ and pushed in by 4% × (0.55 − f), so gyri show as dense, rim-lit crests and the sulci between them as dark lines. |
| Temporal lobes | Superellipsoids (exponent 2.2) centred (±0.80, 3.50, 0.34), semi-axes (0.34, 0.31, 0.76), the pole lowered 0.10 as it points forward; surface slots only, below the lateral sulcus and outside the cerebrum. |
| Cerebellum | Ellipsoid centred (0, 3.16, −0.86), semi-axes (1.02, 0.42, 0.62), under the occipital lobe (no cerebrum slot below y 3.53 behind z −0.35). Two lateral lobes and the vermis (a notch 0.07 deep and 0.13 wide at x = 0); folia as curved bands, 20 round the transverse axis, slots kept with probability 0.15 + 0.85 × ridge³. |
| Brainstem | Midbrain, pons, medulla along the centre line from y 3.58 to the first cervical exit (y 2.74); radius 0.20 → 0.25 (the pons, swelling 35% forward) → 0.15 → 0.10. Haze only, 700 points, the oldest age stop mixed 40% with mist. |
| Cord centre line | Catmull–Rom through (y, z): (3.58, 0.00), (3.30, 0.08), (3.02, 0.02), (2.78, −0.08), (2.50, −0.02), (2.22, 0.04), (1.90, −0.06), (1.30, −0.40), (0.55, −0.66), (−0.25, −0.58), (−0.95, −0.26), (−1.65, 0.02), (−2.35, −0.10), (−2.95, −0.44), (−3.50, −0.62), (−4.02, −0.50); x = 0. That is the spine's S in side view: the neck curves forward, the chest back, the lower back forward, the sacrum back (0.74 front to back in all). **τ** is the arc fraction along this line, 0 at the top of the brainstem, 1 at the tip (y −4.02). |
| Cord radius | By y: 0.25 (pons) → 0.15 (3.0) → 0.10 (2.7) → 0.115 (cervical enlargement, 2.15) → 0.095 (1.5) → 0.08 (−0.8) → 0.095 (lumbar enlargement, −1.6) → 0.07 (−2.6) → 0.045 (tip). |
| Spinal segments | 31 exit levels, each with a pair of nerves: C1–C8 at y = 2.62 − 0.09 i; T1–T12 at 1.84 − 0.2285 i; L1–L5 at −0.94 − 0.30 i; S1–S5 at −2.40 − 0.22 i; Co1 at −3.56. A faint mist ring (40 points, radius 0.15 → 0.08) marks each exit level on the cord. |
| Torso envelope | The surface the nerves wrap round. It is not drawn as a volume: an elliptical section of half-width w(y) and half-depth 0.40 w(y), its back on the cord. w by y, interpolated and smoothed over ±0.2: 0.25 (2.80), 0.55 (2.55), 1.30 (2.30), 2.35 (2.05), 2.90 (1.80), 3.02 (1.50, the shoulders), 2.95 (1.10), 2.65 (0.50), 2.25 (−0.10), 1.88 (−0.60), 1.62 (−1.00), 1.58 (−1.40, the waist), 1.85 (−1.90), 2.30 (−2.40), 2.50 (−2.90, the hips), 2.30 (−3.40), 1.70 (−3.90), 1.15 (−4.32). |
| Spinal nerves | Each nerve starts on the cord at its exit level and is a 56-step path: it heads out sideways at a leave angle a0 below the horizontal and bends further down as a(j) = a0 + Δa × (j/56)^2.2, while it wraps forward round the envelope (angle φ advancing by the step's horizontal run divided by √((w cos φ)² + (0.4 w sin φ)²), so it follows the ellipse) until the wrap limit φmax; past the limit it only descends, by at most 0.22 more, and it never goes below y −4.32. Parameters (a0, Δa, φmax, full length): **C1–C4** 38–18°, 16–24°, 60–72°, 0.60–1.30; **C5–C8** 8–3°, 34–48°, 84–90°, 2.25–3.30 (out to the shoulders); **T1–T4** 3–4°, 52–60°, 92°, 3.45–3.55; **T5–T8** 5–7°, 60–58°, 92°, 3.40–3.00; **T9–T12** 8–14°, 56–50°, 90°, 2.80–2.35 (in to the waist); **L1–L5** 18–42°, 46–30°, 90–80°, 2.40–3.00 (out to the hips); **S1** 46°, 22°, 76°, 2.80; **S2–Co1, the cauda equina** 30–45°, 58–43°, 70–30°, 1.95–0.84, fanning down and inward over the bottom 1.9 units. A nerve on the figure's right goes to −X, on its left to +X. |
| Nerve guides (haze) | The anatomy's own 62 nerves (two per segment, full length), 60 + 50 × length points each with 0.01 of scatter, brightness 0.24 → 0.13 along the nerve, plus two twigs from each at 62–67% and 80–85% of its length (26 points, 22% of its length, 24–32° off the nerve toward the outside and down). They make the empty figure read as a nervous system and carry the shape of a sparse record. |
| Cord thread (haze) | 3,000 points along the whole cord within 0.22 × its radius of the axis, so the cord reads as one bright continuous line at any density; colour 50% age ramp, 50% mist. |
| Undated cloud | Gaussian at (0, −4.64, −0.42), σ = (0.14, 0.10, 0.14), truncated at 2.2σ: 0.6 below the cord tip. |
| Brain haze | 14,000 points: 60% on the folded surface (crest-weighted as above, hemispheres and temporal lobes), 25% filling the cerebrum toward the surface (radius × U^0.33), 15% on the cerebellum's folia; plus 1,800 points along the lips of the fissure so the split between the hemispheres reads from any side. |

The regions used by “Placement: By role in the body” follow SPEC §4.2's region tests in brain-local coordinates (prefrontal, frontal, parietal, occipital, temporal, limbic, cerebellum, brainstem; origin at the cerebrum's centre, +Z toward the frontal pole), with SPEC §4.3.1's role → region table, fed by the `placement` pack.

### 6.3 Placing data

**Notes (brain).**
1. **Territories.** Placement “By area” (default): the brain is split into wedges by azimuth around its vertical axis, starting at the frontal pole and running first along the side that faces the home camera, in slot order. Wedge angle ∝ (notes in the area)^0.6, so Roblox's large share does not swallow the brain. Inside a wedge, folders split the elevation by the same rule, subfolders split azimuth again (a nested treemap over the surface). The compass ring is this partition seen from above. “By role in the body”: notes go to their placement role's region; unlabelled notes stay in their area wedge.
2. **Depth.** Within a territory, “At the core: Oldest notes” gives the oldest notes the deepest slots and the newest the outermost, so the brain grows outward over time. “Newest notes” reverses it. “Largest first” orders by member count or length. Vault notes use their `layer` (0–8) as the depth key and `created` within a layer.
3. **Stable slots.** Recolouring never moves a point. Slots change only when placement, core order or data change.
4. **Maps.** At the centroid of their members' slots, pushed out to the surface (+0.08). Drawn as beacons (§6.5).

**Record (the cord and its nerves).**
1. **Cord position.** τ = 0.06 + 0.88 × (0.65 r + 0.35 ℓ), where r is the entry's rank among dated entries (0–1) and ℓ its linear calendar position (0–1). The rank term spreads bursts (this record's Claude Code weeks), the linear term keeps a sense of calendar time. **Oldest is at the brainstem (τ 0.06), newest at the tip (τ 0.94)**; the undated cloud lies past the tip. The Time page uses the same τ (§5.19). A conversation's **segment** is the spinal segment whose exit level is nearest its τ (edges at the midpoints between adjacent exit levels), so the oldest conversations sit on the neck nerves, the long middle of the record on the ribs, and this month's on the hips and the cauda equina.
2. **Fronds.** Each conversation is one nerve with its root on the cord at τ(first message).
   - **Side.** Alternating in start order: the first conversation goes to the figure's right, the next to its left, and so on, so the torso fills evenly and neighbours in time are on opposite sides.
   - **Course.** A rootlet 0.22 long runs from the cord point at τ to its segment's nerve course (§6.2), then follows that course out and down. Several conversations on one segment lie side by side as a ribbon: each is offset from the course by N(0, 0.011) in height and depth, scaled from 30% at the rootlet to 120% at the end.
   - **Length** = f × the segment's full nerve length (§6.2), f = clamp(0.55 + 0.14 ln(1 + n/10), 0.45, 1.0) × U(0.9, 1.1) (never below 0.12), n the number of messages: a long conversation runs the whole nerve, a short one still reaches past the middle of it, so the torso stays full.
   - **Messages.** Message i of n sits at arc fraction u^0.85 with u sorted uniform; at most 900 points are drawn (longer conversations collapse the rest into beads, §6.4). Scatter σ = 0.004 + 0.009 s; the outer 20% of points splay downward and outward by up to 0.10 × (0.5 + 0.5 f), so each nerve ends in a soft brush.
   - **Parts.** One branch per about 180 messages (the importer's part boundaries, at most 4 drawn), leaving the outer half of the nerve 22–32° off it toward the outside and down, 24% of its length (at most 0.8) and curving down a further 18% of that length.
   - **Colour.** The age ramp at (τ − 0.06) / 0.88; brightness 0.60 at the root to 0.36 at the tip (§6.5).
3. **Single entries** (documents, passages, files, new entries) sit in the cord core at their τ, with radial jitter |N(0, 0.7)| × the cord radius.
4. **Undated** entries sit in the undated cloud.
5. **Reference documents** (the Roblox creator docs) are hidden with the reference filter; when shown they are undated and join the cloud.

**Links down.** Each note keeps its source entries; selecting it draws source lines to them (§6.10).

### 6.4 Density and budget at this vault's scale

| Population | This vault | Drawn | Budget |
|---|---|---|---|
| Notes | 7,221 vault notes; 1,767 when reference notes are hidden; plus machine notes (about 3–6 per conversation) | one point per note | ≤ 60,000 |
| Maps | tens | one beacon each | ≤ 500 |
| Record | 773 Claude Code transcripts (381 sessions, subagents hidden) → roughly 50,000–200,000 kept messages; `.raw/` 2,233 files → passages; later exports | one point per entry | ≤ 220,000 |
| Brain haze | — | 14,000 + 1,800 fissure lips | fixed |
| Anatomy haze (62 nerve guides + 124 twigs, cord thread 3,000, 31 rings × 40, brainstem 700) | — | about 19,000 | fixed |
| Lines | — | ≤ 60,000 segments | 80,000 |
| **Total points** | | | **≈ 300,000** |

Above budget, conversations longer than 400 messages collapse their inner messages into beads sized by log(count), then the haze thins. The mockups render about 143,000 points (105,000 on the fronds, 29,000 haze).

### 6.5 Points, glow and the stage

Each point is a camera-facing sprite. Inside the sprite, with d the distance from its centre in CSS px:

`alpha = intensity × (core_peak × exp(−d² / 2σc²) + halo_peak × exp(−d² / 2σh²))`

| Kind | σc (core) | σh (halo) | core peak | halo peak | Intensity |
|---|---|---|---|---|---|
| Record (fronds) | 0.55 px | 2.8 px | 0.105 | 0.0105 | 0.60 at the root → 0.36 at the tip, × U(0.85, 1.15) |
| Record (cord core) | 0.55 | 2.8 | 0.105 | 0.0105 | 1.0 |
| Cord thread (haze) | 0.55 | 2.8 | 0.105 | 0.0105 | 0.95, colour 50% age + 50% mist |
| Notes (cerebrum, temporal lobes) | 0.85 | 3.8 | 0.60 | 0.035 | 1.7 × U(0.75, 1.2) × (0.70 + 1.1 × rim²) × (0.45 + 0.55 f) × (1.0 on the surface, 0.7 inside), where rim = 1 − \|normal · view\| and f the crest field |
| Notes (cerebellum) | 0.85 | 3.8 | 0.60 | 0.035 | 1.5 × (0.75 + 0.6 × rim²) |
| Brainstem haze | 0.55 | 2.8 | 0.105 | 0.0105 | 0.55, colour 60% oldest age stop + 40% mist (700 points) |
| Maps | 1.4 | 6.5 | 0.95 | 0.16 | 1.0, colour 60% white + 40% territory |
| Undated | 0.55 | 2.8 | 0.105 | 0.0105 | 1.3 |
| Brain haze: folds | 0.55 | 2.8 | 0.105 | 0.0105 | 0.80 × (0.6 + rim²), colour 60% territory + 40% mist (Stage tint, when on, replaces the mist) |
| Brain haze: fissure lips, cerebrum volume, cerebellum folia | 0.55 | 2.8 | 0.105 | 0.0105 | 0.55, 0.12, 0.50, same colour |
| Nerve guides and twigs (haze) | 0.55 | 2.8 | 0.105 | 0.0105 | 0.24 → 0.13 along a guide, 0.16 on a twig, mist |
| Segment rings (haze) | 0.55 | 2.8 | 0.105 | 0.0105 | 0.20, mist |

Sizes scale with Display › Dot size and Glow (halo peak × Glow) and with distance as (d0/d)^0.35. Sprites are clamped to 1–24 CSS px × DPR (DPR capped at 2).

**Blending and tone mapping.** Additive (`ONE, ONE`), depth test and write off, into an RGBA16F target. Then `out = 1 − exp(−1.35 × Brightness × hdr)` per channel, so dense areas roll toward pastel and white instead of clipping. The result is composited over the stage background with a screen blend.

**Depth cue.** Brain points: × (0.16 + 0.84 × n^1.6), with n the point's nearness within the brain (1 = nearest), which keeps the near territories readable. Everything else: × (0.55 + 0.45 × n^0.8) over the whole figure.

**Stage background.** `--cx-stage` with a radial lift to `--cx-stage-lift` centred at 47% / 50% of the stage (radii 62% × 75%, falloff power 1.6), and a vignette that darkens the corners by up to 35%.

**Paper stage.** Normal alpha blending, 70% alpha, light-variant colours, no halo, core σ × 1.3, and no tone mapping. Dense areas darken.

### 6.6 Colour states

All factors multiply a point's rest brightness.

| State | Rule |
|---|---|
| Rest | Data colour per the key (§4.4–4.5) |
| Hover | Point drawn white at 2× size with a 1.5 px white ring (r 7.5 px) and a 1 px ring at 32% (r 13 px) |
| Selected | White core at 2.4× with a 2 px accent ring; everything else × 0.06, the haze × 0.35 (main.png) |
| Selected group (a conversation, a key chip, a band) | Members at full colour × 1.4 brightness, everything else × 0.06, the haze × 0.35 |
| Traced (query matches) | Full colour; everything else × 0.12, the haze × 0.5 |
| Previewing (hovering a strip bar, chip, compass segment) | Matches full, others × 0.35 (lighter, to avoid flicker) |
| Hidden by the key | × 0.06 (a ghost that keeps the shape) |
| Outside the period | × 0.06 in Body; removed in Groups and Chart |
| Outside the scope | Sinks 25% of the way toward the brain's core (or the cord axis) and fades to 0 over 300 ms; the haze stays |
| Map beacon | 1.6× brightness, opacity 0.85 ↔ 1 over 2.4 s; no pulse under reduced motion |
| A hovered map's sources | +60% brightness, colour mixed 50% toward the map's territory colour; no white, no travelling wave |
| Thin group (Groups, Chart) | Drawn as an outline only: points at × 0.5 on the group's shell, interior empty, plus an “n” chip |
| Active note (Follow the active note) | 1.5 px accent ring, no size change |
| Recolour | Per-point colour change over 600 ms in linear RGB |
| In flight (morph) | Lifted toward warm white by 0.25 × sin(π m), m = the point's own progress |
| Birth flash | White at 2.2× size, settling to its colour and size over 220 ms |

### 6.7 Growth, scope and arrivals

**Intro** (first open per session, Rebuild, Replay). 3.6 s.

| Time (s) | Stage | Rule |
|---|---|---|
| 0.00–0.25 | Seed | 12 points ignite at the top of the brainstem (y 3.58); a ring expands from 0 to 40 px and fades |
| 0.25–1.30 | Cord | Cord points are born at 0.25 + 1.05 τ, from the brainstem down to the tip, behind a bright travelling tip; each segment ring lights as the tip passes its exit level |
| 0.55–2.20 | Nerves out | Each conversation's frond starts 0.08 s after the tip passes its root: the rootlet appears, then its messages root → tip over 0.45 s while the nerve swings out and down from lying along the cord (60° toward the cord axis) to its final course. The 62 anatomy nerves grow the same way, in step with the tip, so the torso fills from the shoulders down through the ribs and hips and the cauda equina comes last |
| 1.20–1.60 | Anatomy haze | The cord thread, nerve guides and brain haze fade in to their rest alpha |
| 1.60–3.10 | Brain blooms | Notes are born at 1.60 + 1.5 × depth rank, deepest (oldest) first, from the brainstem cap upward and outward (the cerebellum with the cerebrum), with birth flashes |
| 2.90–3.60 | Settle | Maps ignite, key and compass counts tick up over 600 ms, the spin is already turning from the first frame of the growth (0.2 of full speed, full speed 0.5 s in) |

**Rebuild** after re-indexing: the same order compressed to 0.9 s.

**Scope change** (compass, scope picker, `[` `]`). The camera turns about the brain's vertical axis until the chosen territory's wedge faces the viewer (600 ms, `--cx-ease-inout`) and the compass needle swings with it; the spin continues around the new heading. At the same time non-members sink 25% of the way toward the brain's core (record points toward the cord axis) and fade to 0 over 300 ms; members keep their places. The camera re-fits (600 ms) only if the members fill less than 40% of the safe frame. **Back to All areas**: the hidden points rise back to their slots while fading in, over 400 ms; the camera stays where it is. No white flash, no swirl, no dolly.

**Live arrivals**: held until **Show them**, then each new point is born in its slot with a birth flash; nothing else moves.

**Reduced motion**: points fade in over 200 ms; no seed ring, no unfurl; scope changes cut the camera to the new heading and cross-fade the points in 120 ms.

### 6.8 Motion and camera

| Item | Rule |
|---|---|
| Camera | Perspective, vertical field of view 30°, near 0.1, far 200 |
| Home view (Standing, default) | Camera behind the figure, 26° round toward its right side (heading 154°, measured from the frontal pole) and 9° above, aimed at (0, 0.3, −0.2); vertical field of view 30°; fitted by height as §3.2 (distance about 25 units at the reference size). From behind, the cord and both columns of paired nerves are symmetric about it and the cerebellum shows under the brain's back |
| Spin (default motion, Standing) | 360° about the figure's vertical axis (the cord's x = 0), 16 s per turn at ×1 (×0.5: 32 s, ×2: 8 s), starting from the current heading; with **Keep upright** on, the spin becomes a sway: yaw = h + 26° sin(2πt / 40 s) |
| Home view (Lying) | Yaw 11°, pitch −8°, looking at the figure's centre; distance fitted so the figure's projected bounds fill the safe frame (§3.2) with a 4% margin |
| Drift (default motion, Lying; Spin's alternative) | yaw(t) = h + 26° sin(2πt / P), pitch(t) = −8° + 3° sin(πt / P), P = 12 s at ×1 (×0.5: 24 s, ×2: 6 s), h = the current heading (11° at home; a scoped territory's heading after a scope turn) |
| Pauses | While dragging and 0.6 s after; while the pointer rests on a point for 300 ms (only if “Pause while pointing” is turned on, it is off by default); resumes over 600 ms |
| Orbit | Drag: yaw free, pitch ±75°. Keep upright: yaw ±50°, pitch ±30° about the home view |
| Dolly | Wheel toward the cursor; distance 0.15–4 × home |
| Pan | Right-drag or Shift + drag |
| Fly to selection | 520 ms (`--cx-ease-inout`), selection centred in the safe frame at 0.5 × home distance; closing the reader flies back in 380 ms |
| Scope turn | 600 ms yaw to the territory's heading (§6.7) |
| Re-fit after a shape change | 400 ms to the targets' bounds + 8% |
| Sheet docking | `setViewOffset` tween, 300 ms; the camera does not move |
| Hidden leaf | Rendering stops; frame delta clamped to 50 ms on resume |

### 6.9 Hover, selection and maps

- **Hover a point**: tooltip, white marker, names for related items when Names is on.
- **Hover a map**: (1) one **member card** beside the map, glass-strong, 260 px: the map's kind and “26 notes”, then up to 8 members as kind glyph + title, then “+‹n› more”; (2) its source entries brighten in the map's own territory colour as a braid along their fronds (§6.6); (3) a bracket on the time strip over their date span (§5.8); (4) the tooltip's mono line “‹n› notes · ‹m› sources”. No chips are scattered over the brain and no spokes are drawn on hover.
- **Select a map**: spokes from the map to each member (straight, 1 px, territory colour at 55%), its sources stay braided, the map reader opens.
- **Select a note**: source lines draw on (§6.10); its sources light; the reader opens.
- **Select an entry**: the notes built from it light in the brain; a source line rises from the entry to each.
- **Select a conversation** (double-click a message): its frond stays bright at × 1.4, everything else dims (§6.6), the notes built from it brighten with their source lines curving down to the frond, their names appear as label chips, the strip shows a bracket over its dates, and the conversation reader opens (main.png).

### 6.10 Lines

Cortex draws two line families, plus map spokes on selection and the label leaders of the overlay. Hovering any line names it in a one-line tooltip (§5.12); there is no line legend.

| Family | Joins | When | Style |
|---|---|---|---|
| Source line | Note → its source entries | Note hovered or selected; Lines: All draws them for everything shown | Quadratic curve lifted 0.6 units away from the figure's axis, white at 34–50%, draws on over 280 ms from the source end |
| Conversation stem | Consecutive messages of one conversation | Settings › Appearance › Conversation stems, or the Lines tool's menu (off by default) | Record colour at 10%, along the frond |
| Map spokes | Map → member notes | A map selected | Straight, territory colour at 55% |
| Label leaders | Label chip → its point | Names shown | 1 px, white 42% (HTML/SVG overlay) |

All 3D lines are 1 px, premultiplied additive, multiplied by the depth cue; draw-on uses a per-vertex 0–1 parameter.

### 6.11 Labels

Label chips (§4.9) are HTML over the canvas. Placement runs every frame the camera moves (throttled to 30 Hz): project anchors, discard those behind the camera or inside overlay rectangles, keep the top 24 by priority (selected > the selection's notes > traced > largest), then relax positions with 6 iterations of a simple repulsion keeping chips at least 4 px apart and 8 px from the anchor; leaders connect to the nearest point of each chip's outline. Chips fade in over 120 ms and out over 90 ms. In the standing figure the chips go in two columns either side of the brain (each at its anchor's height, nearest column first), never over the torso, and the nerve and cord anchors (segment names such as “T4”, shown only while the pointer is on the cord) sit beside the cord. In Groups and Chart shapes, group labels sit at the group centroids and appear when the morph passes 0.85.

### 6.12 Shapes: Body, Groups, Chart

Every point carries its body slot and its current arrangement target; the shape slider drives a morph value m. Each point moves with its own delay: `e = smoothstep(clamp((m − 0.25 × seed) / 0.75, 0, 1))`, `P = mix(body, target, e) + 0.35 × sin(π e) × curl(body × 0.8 + 0.15 t)`, so the middle of the morph is a drifting cloud rather than straight lines. Programmatic changes animate over 1.4 s; scrubbing is live.

| Groups layout | Arrangement |
|---|---|
| **Bubbles** (default) | One sphere per group, radius ∝ ∛count, packed around the largest, centred in the safe frame; members fill each sphere with a Gaussian falloff (σ = 0.45 r); the group label at the centroid |
| **Tree** | The folder hierarchy laid out left to right (root at the left, children fanning right), one sphere per node, 1 px leaders |
| **Along the spine** | The figure stays standing; each group becomes a bar leaving the cord sideways at the spine position τ of its median date (groups alternate sides), length ∝ count, members packed in the bar; bars that would overlap step apart along the cord. Reads as “what you worked on, where along your time” |
| **Strata** | Groups become horizontal slabs stacked by size, largest at the bottom, each slab's width ∝ count and its members spread through it; the stack curves gently like the glyph's arcs. Reads as the share of each group at a glance |

Placement › **By role in the body** (shape bar overflow) moves notes to their role's brain region inside the Body shape; it is not a Groups layout and draws no tracts. Chart arrangements are in §7. Arrangement → arrangement changes take 750 ms with a 0.3-unit lift at mid-flight; overlays (axes, labels, readings) fade out in 100 ms and back in over 250 ms once points settle. After any change the camera re-fits in 400 ms.

### 6.13 Small and sparse records

- The haze is always drawn at rest alpha, so an almost empty record still shows the silhouette; with no data at all it is drawn at 1.5× (§5.2).
- With fewer than 200 record entries, fronds use a minimum length of 0.35 scene units (or the nerve's own length if that is shorter) so they read as nerves rather than dots.
- With fewer than 300 notes, brain dot size is × 1.4 and the brain haze × 1.5.
- Thin groups (under 30 items) are drawn hollow with an “n” chip (§5.29).
- The sample record uses the same art; only the area names are invented.

### 6.14 Robustness

On WebGL context loss: prevent default, show the last rendered frame as a still with the banner “The 3D view stopped because the graphics driver reset. Click to restart it.”, and try to restore. Without WebGL2 at all: a static side view drawn on a 2D canvas (points at 1.3 px with `lighter` compositing) and the line “3D isn't available here, so Cortex shows a still picture. Everything else works.” All layout work runs in a Web Worker; the main thread only swaps buffers. Picking reads integer ids from its own target, cleared to zero before each pick pass, so a light Paper stage never makes empty pixels pickable (§12.18).

---

## 7. Charts

### 7.1 Shared rules

- **Every chart is drawn by the same particles**: one per entry or note in the period, morphed into place (§6.12). Axes, gridlines, labels and readings are a 2D overlay that fades in after the points settle. Points outside the period leave.
- **Keep upright** turns on by itself in Chart shape (±50° yaw, ±30° pitch).
- **Readings, not answers.** Each chart has a plain name and computes up to three **readings** from the current data, drawn on the chart as annotations: a callout (short leader + label), a bracket, or a label on a mark. Readings are numbers and names, never sentences: “21:00 · peak”, a bracket labelled “23 days”, “1,284” on the widest ribbon. They are listed on the Chart page, each with **Trace**.
- **Ask about this chart** (Chart page) opens Ask with the chart's state attached, so questions come from you.
- **Hover** a mark: tooltip with value, count and share; matching particles brighten. **Click** a mark: trace it (token). **Click** a series or band label: add it as a highlight token (§7.4). **Click** a particle: open its reader. **Wheel**: zoom (semantic zoom on the calendar). **Esc**: remove the last highlight token; again: clear.
- **A map's sources in a chart.** While a map's reader is open in Chart shape, its source particles are ringed in place (a 1.5 px white ring on each, up to 400; beyond that, the marks containing them get an outline) and a count chip “‹n› of this map's sources” sits at the chart's top right. Nothing moves to a separate halo.
- **Show as table** opens Time › Data pre-filtered, for screen readers and exact values.
- Label rules: 10.5 px mono axis labels in `--cx-stage-text-3`; category labels truncated at 24 characters; rotated time labels in two staggered rows when crowded.

### 7.2 Catalogue

| Chart | Group | Encoding and particle form | Readings drawn on the chart | Chart options | P |
|---|---|---|---|---|---|
| **Ranked bars** | Compare | One horizontal bar per group (sorted), particles packed into each bar so length ∝ count; names left, counts right | The top bar's count and share at its end | Top N | P1 |
| **Matrix** | Compare | x × y grid; each cell a rectangle filled with its particles (density = count) | The busiest cell outlined with its count | Counts in cells | P1 |
| **Treemap** | Compare | Squarified nested rectangles of the folder hierarchy, area ∝ entries, particles fill the leaves; flies in from a small rectangle | The largest folder's share inside its box | Show all levels · Folders checklist | P1 |
| **Icicle** | Compare | Indented horizontal bands in tree order, particles fill each band; expand and collapse re-flow in 300 ms | The deepest branch's depth (“6 levels”) at its end | Folders checklist | P1 |
| **Bubble pack** | Compare | One sphere per group (radius ∝ ∛count), coloured by the colour zone | “×2.4” between the two largest | — | P1 |
| **Nested bubbles** | Compare | Spheres per group with concentric shells per colour value (largest innermost), plus an Other sphere | The largest shell's share | — | P2 |
| **Stream graph** | Over time | Centred streamgraph, wiggle-minimising baseline; bands filled with their particles; band names at the right; a “now” mark | The leading band named at each end of the time axis | — | P1 |
| **Ridgeline** | Over time | One overlapping area per category from a shared baseline, particles under each curve | A dot on each row's peak with its month; the latest peak brighter | Normalise rows (toggle) · Smoothing (slider, off to 90 days) · Scale (Linear · Log) | P1 |
| **Calendar heatmap** | Over time | A block per year, 53 week columns × 7 days; particle clumps per day sized by count; counts appear in cells taller than 18 px, single particles above 40 px (semantic zoom) | A bracket over the longest run with its length; a callout on the busiest day | — | P1 |
| **Timeline lanes** | Over time | One lane per category: a thin span from first to last entry, with particle blocks per month (brighter recently); lanes still active end in an open arrow, ended lanes in a closed cap; duration in the tooltip | A bracket on the longest lane with its length | Monthly density (toggle, on) | P1 |
| **Arc diagram** | Over time | One lane per category; half-ellipse arcs join consecutive bursts, arc height ∝ gap; particle clusters on the baseline | The tallest arc labelled with its gap | Minimum gap | P2 |
| **Diverging area** | Over time | Your words stacked above a zero line, the assistant's below, smoothed areas filled with particles; a dashed line at your overall share | A callout at the month your share peaked (“peak 46%”) | Measure (Words · Messages) | P1 |
| **Beeswarm** | Over time | Each conversation a packed cluster on a time axis, size ∝ messages, colour by area | The largest cluster labelled with its message count | Size (Messages · Words) | P2 |
| **Radial clock** | Rhythm | 24 sectors with 00:00 at the top, clockwise; concentric rings per category; particle clumps per sector and ring | A callout at the peak hour; a peak tick on each ring | x takes Hour or Weekday (Date ▸ Rhythm) | P1 |
| **Radial heatmap** | Rhythm | Sectors for one dimension, rings for another, particles fill each cell; central hole 30% | The hottest cell outlined | — | P2 |
| **Alluvial** | Connections | Two stacked axes joined by curved ribbons ∝ count, packed with particles | The widest ribbon labelled with its count | — | P1 |
| **Chord** | Connections | Category arcs around a circle; ribbons weighted by shared conversations and links; particles ride the ribbons | The thickest ribbon labelled with its count | Weight (Shared conversations · Links) | P2 |
| **3D clusters** | Connections | One Gaussian cluster per (x × y) value, σ ∝ ∛count, packed on an ellipsoid; labels “‹a› · ‹b›” above 0.85 morph | The densest cluster's label enlarged with its count | — | P1 |

Gallery thumbnails are simple monochrome drawings of each form in `--cx-stage-text-2`.

### 7.3 Dimension menu

Built from the data model and grouped by where a value comes from, which is Cortex's organising idea (provenance). Section labels are non-selectable 11 px rows; machine-derived sections carry the dashed machine icon and your sections the solid one.

| Section | Items |
|---|---|
| (top) | **Date ▸**: a submenu with Day · Week · Month · Year, a **Rhythm ▸** submenu with Hour · Weekday, and a switch at its foot: **Written** · **Imported** |
| From the file | Area · Folder · Folder path · Layer |
| From the conversation | Source · Project · Conversation · Speaker |
| From the agents | Kind · Map · each enabled pack field (Work, Outcome, Topics, Role, PARA when available) |
| From you | Your labels · Your fixes |
| (foot) | **All fields…** opens a searchable list of every field, with its source and coverage |

Notes and record are not a dimension: the key's Brain and Spine rows already split them. Remainders take their own names (§4.4): No area, Undated, No project, No kind, No map. Submenus use `MenuItem.setSubmenu` where the running Obsidian has it, otherwise the Date items appear as a flat section.

### 7.4 Highlights, combining, Top N, pinned views, saving

- **Highlights are tokens** (P2): clicking a series or band label adds the token “‹Dimension›: ‹value›” to the command line; that band keeps its colour and the rest drop to 35%; the readout counts what is highlighted. Backspace or Esc removes the last one. No pills and no leader lines. A highlighted label is drawn as a filled chip in its group's colour and every other label drops to 40%. **Right-click** a band label removes its highlight, or hides that band when it has none; **Alt-click** (Option on a Mac) shows only that value, again restores all. Hovering a label says so: “‹name› · ‹n› entries” and the three gestures.
- **Combine** (P2): Shift + right-click an axis or band label › “Combine with…” › pick values; the chart shows them as one category named after the first (rename inline). A combine is local to this chart: it is saved with a pinned view and does not recolour the brain. The key chip's “Merge with…” is the separate, global fix (`merge_groups`, §5.3), with Apply and Undo.
- **Top N**: a stepper, default 20 (5–60); the rest fold into Other.
- **Pin view** (P2): “Pin view…” (Chart page, More, `cortex:pin-view`) asks for a name and stores the whole leaf state (shape, chart, zones, sorts, combines, colours, layers, scope, period, camera). Pinned views appear in Read › Pinned with **Copy link** (`obsidian://cortex?view=‹id›`; opening it only navigates).
- **Save image…**: PNG at 2× the canvas, the current stage only, via the system Save dialog (default folder Downloads); offers Print colours for that one export. **Copy data as CSV**: the chart's counts as CSV on the clipboard.

---

## 8. Keyboard, commands, accessibility, performance

### 8.1 Keyboard map (view-scoped)

These keys live in the view's own `Scope`, so they work only while focus is inside Cortex and never override Obsidian's global hotkeys. Every action also exists as an Obsidian command (§8.2) so it can be bound globally in Settings › Hotkeys.

| Key | Action |
|---|---|
| Ctrl K or / | Focus the command line in Find |
| Ctrl Shift K | Focus the command line in Ask |
| Tab (in the command line) | Switch Find ↔ Ask |
| / (at the start of Ask) | Open the slash-command menu |
| Esc | Close the topmost menu, popover, console or sheet; then clear the input; then the tokens; then the selection |
| Space | Spin (or drift) on or off |
| H | Home view |
| F | Frame the selection |
| O | Display popover |
| C | Chart page |
| G | Next shape: Body → Groups → Chart → Body |
| L | Names on the figure: on hover ↔ always |
| K | Lines: selection ↔ all |
| I | Immersive mode |
| ? | Guide |
| [ and ] | Previous / next area (with the scope turn) |
| Alt 1 … Alt 5 | Brain, Read, Time, Agents, Sources |
| Alt ← / Alt → | Sheet back / forward |
| Ctrl Z / Ctrl Shift Z | Undo / redo the last Cortex change |
| Arrow keys (stage focused) | Turn (←/→ yaw, ↑/↓ pitch); with Shift, pan |
| + / − (stage focused) | Zoom |
| Tab / Shift Tab (stage focused, something traced) | Step through traced points, largest first; each one is hovered and announced |
| Enter (stage focused) | Open the stepped-to point |
| Ctrl Enter (stage, vault note) | Open it in a new Obsidian tab |
| 1–4, J/K, Z (Agents › Checks) | Confirm, Change, Reject, Skip; next/previous; undo the last answer |
| J / K (Read list) | Next / previous row |

Obsidian defaults checked: Ctrl K (insert link) and Ctrl Z are editor-scoped, Alt + digits and Ctrl Shift K are unbound, Ctrl 1–8 (switch tab) are not used by Cortex; ? is only handled when focus is not in a text field.

### 8.2 Obsidian commands

Names as they appear in the palette; ids are `cortex:<id>`. One default hotkey: Lock (Ctrl Shift L; Obsidian keeps Ctrl L). The user binds anything else.

| Id | Name | Id | Name |
|---|---|---|---|
| `open` | Cortex: Open | `open-new` | Cortex: Open in a new tab |
| `find` | Cortex: Find in the record | `ask` | Cortex: Ask |
| `add-sources` | Cortex: Add sources | `show-active-note` | Cortex: Show the current note |
| `open-read` | Cortex: Open Read | `open-time` | Cortex: Open Time |
| `open-agents` | Cortex: Open Agents | `open-checks` | Cortex: Open checks |
| `open-sources` | Cortex: Open Sources | `open-guide` | Cortex: Open the guide |
| `open-today` | Cortex: Show today | `new-entry` | Cortex: New entry |
| `change-history` | Cortex: Change history | `toggle-chart` | Cortex: Toggle chart |
| `display` | Cortex: Display controls | `toggle-motion` | Cortex: Spin on or off |
| `home-view` | Cortex: Home view | `frame-selection` | Cortex: Frame the selection |
| `clear` | Cortex: Clear traced and selected | `next-area` | Cortex: Next area |
| `previous-area` | Cortex: Previous area | `show-arrivals` | Cortex: Show held arrivals |
| `import-claude-code` | Cortex: Import Claude Code sessions now | `run-agents` | Cortex: Run agents now |
| `pause-agents` | Cortex: Pause agents | `resume-agents` | Cortex: Resume agents |
| `rebuild-index` | Cortex: Rebuild the index | `pin-view` | Cortex: Pin view |
| `save-image` | Cortex: Save image | `copy-data-csv` | Cortex: Copy data as CSV |
| `reset-hints` | Cortex: Reset hints | `toggle-sample` | Cortex: Explore or leave the sample record |
| `reset-display` | Cortex: Reset display | `toggle-immersive` | Cortex: Immersive mode |
| `setup-agents` | Cortex: Set up agents | `connect-agent` | Cortex: Connect an agent |
| `show-agreement` | Cortex: Show what is sent | `check-updates` | Cortex: Check for updates |
| `lock` | Cortex: Lock (default hotkey Ctrl Shift L) | `about` | Cortex: About Cortex |
| `open-settings` | Cortex: Cortex settings | `start-tour` | Cortex: Quick walkthrough |
| `export-ledger` | Cortex: Export ledger | `showcase` | Cortex: Showcase mode (hands-free tour; Ctrl 0 then Ctrl 9 toggles it) |
| `encrypt-record` | Cortex: Encrypt my record (opens Settings > Lock, where it checks first, backs up, then encrypts) | | |
| `prove-entry` | Cortex: Prove this entry (the entry open in the reader; saves a proof folder) | `audit-pack` | Cortex: Audit pack |
| `export-record` | Cortex: Export my record (areas, period, optional encryption) | `open-export` | Cortex: Open an encrypted export (a .cortexenc file, with the record open) |

File and editor menus add “Show in Cortex” (notes and folders). The skill `/cortex-organise` (outside Obsidian) triggers the same jobs as **Run agents now**; its runs appear in the Agents ledger marked “from /cortex-organise”.

### 8.3 Accessibility

**Focus order.** Header (brand → scope → tabs → guide → live/arrivals → agent chip → Add sources → settings → More) → stage overlays (key bar → shape bar → tool column → stage → compass → command line → toasts) → time strip (period picker → handles → bars → undated) → sheet (header → body). Toolbars (tabs, key chips, tools, compass segments, strip bars) use a roving tab index: Tab enters, arrows move, Tab leaves.

**Roles and names**

| Surface | ARIA |
|---|---|
| View root | `role="application"`, `aria-label="Cortex"` |
| Page tabs | `role="tablist"` (five tabs); each `role="tab"`, `aria-selected`, `aria-controls` = the sheet |
| Key bar | `role="toolbar"`, `aria-label="Key"`; chips `aria-pressed` (false = hidden), names include counts; Layers is a menu button |
| Shape slider | `role="slider"`, `aria-valuemin 0`, `aria-valuemax 100`, `aria-valuetext` (“Body”, “Halfway to Groups”, “Groups”) |
| Tool column | `role="toolbar"`, `aria-orientation="vertical"`; toggles `aria-pressed` |
| Stage canvas | `aria-roledescription="3D record"`, `aria-describedby` a visually hidden summary kept current: “‹n› notes in the brain coloured by area. ‹m› entries along the spine from ‹first› to today. Use Tab to step through traced points.” |
| Live region | One polite `aria-live` region announcing hover/step targets (“Decision: Lock slots while the server confirms. 3 Nov 2026. Roblox.”), selection, traced counts (“214 traced”), chart zone changes (“Vertical: Folder”) and changes |
| Compass | `role="radiogroup"`, `aria-label="Area scope"`; segments `role="radio"` |
| Command line | `role="search"`; the input `role="combobox"`, `aria-expanded`, `aria-controls` = results or the slash menu; results `role="listbox"` with grouped options |
| Ask console | `role="log"`, `aria-live="polite"`; proposals are `role="group"` with labelled Apply/Cancel |
| Time strip | `role="group"`, `aria-label="Time"`; handles `role="slider"` with dates as `aria-valuetext`; bars a `role="list"` of buttons named “Week of 2 Nov 2026, 12,904 entries” |
| Time page figure | `role="img"` with a text summary (“Your words 31% of the period, rising. 1,184 conversations.”) and **Show as table** next to it |
| Frond scrubber | `role="slider"`, `aria-valuetext` “Message 39 of 549, you, 3 Nov 14:52” |
| Sheet | `role="complementary"`, `aria-labelledby` its title; Back has `aria-label="Back to ‹previous›"` |
| Dialogs | Obsidian `Modal` (`role="dialog"`, focus trapped, Esc closes) |
| Hint bubbles | `role="note"`, announced once, dismissed with Esc |

**Colour is never alone.** Key chips carry names; speakers carry shapes (filled, hollow, half, square); kinds carry glyphs; machine text carries a dotted rule and a model chip, not just a colour; status pills carry words; charts offer patterns (Settings, always in Print) and a table view; hidden groups are struck through; evidence meters have tooltips with counts.

**Contrast** (WCAG 2 ratios, computed; worst case on glass assumes the frosted panel sits over pure white particles):

| Text token | Surface | Ratio |
|---|---|---|
| `--cx-text-1` #dadada | chrome #1c1c1c / alt #282828 / raised #2a2a2a | 12.2 / 10.6 / 10.3 |
| `--cx-text-2` #b3b3b3 | same | 8.1 / 7.0 / 6.9 |
| `--cx-text-3` #9aa0aa | same | 6.5 / 5.6 / 5.5 |
| `--cx-stage-text-1` #eceef2 | glass typical / worst | 16.5 / 11.2 |
| `--cx-stage-text-2` #c3c8d1 | glass typical / worst | 11.4 / 7.7 |
| `--cx-stage-text-3` #9ea5b1 | glass typical / worst | 7.7 / 5.2 |
| White on `--cx-accent-fill` #774fd5 | primary buttons | 5.4 |
| `--cx-machine` #b8a6ff | chrome #1c1c1c | 8.1 |
| Light `--cx-machine` #7b4acc | white | 5.7 |
| Error text #f3a6aa | chrome #1c1c1c / #282828 | 8.8 / 7.6 |
| Light `--cx-text-3` #575d66 | white / #f6f6f6 / #ebebeb | 6.6 / 6.1 / 5.6 |
| Light `--cx-stage-text-3` #5a616b | white / glass worst | 6.3 / 4.7 |

Obsidian's `--text-faint` is never used for text that carries meaning. Data colours are marks, not text: they meet 3:1 against their surfaces (§4.4).

**Targets.** Every interactive element is at least 24 × 24 px; tool buttons 32 × 32.

**Reduced motion.** See §4.8. Information conveyed by motion (growth order, scope turns) is also available as text (tooltips, the live region, the Time page).

**Zoom and text size.** All sizes are in px relative to Obsidian's zoom; the layout reflows down to 480 px wide (§2.5) without horizontal scrolling of the view.

### 8.4 Performance UX

| Phase | What the user sees | Target |
|---|---|---|
| View opens | Chrome, the stage background and a pre-rendered silhouette of the haze; a 2 px accent progress line under the header; the stage line “Reading your record…” | ≤ 50 ms |
| Cache hit | Points arrive and the intro plays (or fade in under reduced motion) | ≤ 800 ms for 300,000 points from `%LOCALAPPDATA%\cortex\` |
| Reconcile | Header chip “Checking for changes…”; new items are held, nothing shifts | background |
| First ever run (no cache) | Header chip “Indexing ‹k› of ‹n›” with the progress line; the brain and spine grow chunk by chunk as they are indexed; stage line “First run: Cortex is reading your vault and sessions. This happens once; after this it opens in about a second.” | background, never blocks Obsidian |
| Layout in the worker | Small glass pill at the stage's top centre: spinner glyph + “Arranging…”; points wait in place | ≤ 400 ms typical |
| Sheet pages and charts | Skeleton blocks for ≤ 300 ms | — |
| Frame rate drops | If frames take > 22 ms for 2 s: DPR down to 1.25, then halos off, then haze halved; one toast “Cortex lowered detail to stay smooth. Change it in Display.” and a “Performance mode” line in the Display popover | 60 fps target at 1576 × 933, DPR 1.83 |
| Tab hidden or window minimised | Rendering stops | 0% GPU |
| Status bar | “Cortex · importing 63%” or “Cortex · indexing 63%”, so progress is visible from any tab | — |

---

## 9. Traceability: SPEC features → Cortex

Priorities are Cortex's build priorities; where they differ from the SPEC the reason is given.

| F# | Feature | Cortex surface (section) | P |
|---|---|---|---|
| F1 | 3D particle nervous system | Stage, standing figure (§6.1–6.2) | P0 |
| F2 | Notes in the brain, record in the cord and body | Placement (§6.3) | P0 |
| F3 | Chronological spine | Spine position τ, oldest at the brainstem (§6.3); drawn flat on the Time page (§5.19) | P0 |
| F4 | Growth animation | Intro growth (§6.7) | P0 |
| F5 | Turning with a speed control | Spin / drift, ×0.5 · ×1 · ×2, Space (§5.6, §6.8) | P0 |
| F6 | Camera: orbit, dolly, re-frame, fly | §6.8 | P0 |
| F7 | Hover tooltip | §5.12 | P0 |
| F8 | Select: reader, dim, links, fly | §5.12, §6.9 | P0 |
| F9 | Hub hover | Map hover: member card, source braid in territory colour, strip bracket; spokes on selection (§6.9) | P1 |
| F10 | Colour grouping, split | Key bar pickers and toggles (§5.3) | P0 |
| F11 | Anatomy ↔ arranged morph | Shape bar (§5.4), §6.12 | P0 |
| F12 | Groups layouts | Bubbles, Tree, Along the spine, Strata (§6.12); role placement in the shape bar's overflow (§5.4) | P1 |
| F13 | Spaces (top-level filters) | Scope: the compass turn (§5.7, §6.7), header picker, `[` `]` | P1 |
| F14 | Legend | Key bar + key popover (§5.3) | P0 |
| F15 | Hide unsorted | “Hide items without a value” (§5.3); “Hide No area” on Time (§5.19) | P0 |
| F16 | Notes / Record visibility | Key bar › Layers (§5.3) | P0 |
| F17 | Time histogram / brush | Time strip (§5.8); raised to P0 because it is also the age key | P0 |
| F18 | Minimap | Compass (§5.7) | P1 |
| F19 | Data-sufficiency banner | Replaced: thin groups drawn hollow with an “n” chip, and a warning dot with “Fold groups under 30 into Other” (§5.29) | P2 |
| F20 | Line types | Two families, each named when hovered (§6.10); no legend | P1 |
| F21 | Hub colour cycling | Replaced by beacon brightness + slow pulse (§6.6) | P1 |
| F22 | Transit tint | Warm-white lift in flight (§6.6, §6.12) | P2 |
| F23 | Charts panel | Chart page (§5.25) + readings on the chart (§7.1) | P1 |
| F24 | Forms (7) | Compare and Connections charts (§7.2) | P1 |
| F25 | Answers (9) | Over time and Rhythm charts with readings drawn on them, no answer sentences (§7.1–7.2) | P1 |
| F26 | Highlight set | Highlight tokens (§7.4) | P2 |
| F27 | Axis auto-resolve | Zone fallback announced in the live region, no sentence (§5.25) | P2 |
| F28 | Merge and fold | “Combine with…” (local) and Top N (§7.4); global merge in the key bar (§5.3) | P2 |
| F29 | Saved tables, export | Pin view, Save image…, Copy data as CSV (§7.4) | P2 |
| F30 | Time window | Period: strip brush, Time page brush, period picker, `set_period` (§5.8, §5.19, §5.10) | P1 |
| F31 | Focus sphere | Replaced: a map's sources ringed in place with a count chip (§7.1) | P2 |
| F32 | Semantic zoom | Calendar heatmap (§7.2) | P2 |
| F33 | Reader: record entry | §5.14 | P0 |
| F34 | Reader: machine note | Conversation reader and machine note (§5.15) | P0 |
| F35 | Reader: hub | Map reader (§5.16) | P1 |
| F36 | Navigator | Read (§5.18) | P0 |
| F37 | Timeline | Time: the spine laid flat, the rhythm grid and the Data view (§5.19) | P0 |
| F38 | You | No page. Your share labels the Time voices track and is a Sources column; names are a Settings › Privacy field; seals are date evidence and a Settings › Advanced row; the read log is Agents › Access log (§0.1) | P1 |
| F39 | Lab | Agents › Ledger (§5.20) | P1 |
| F40 | Learn | Guide: five interactive cards (§5.23) | P1 |
| F41 | Your AI | Ask: command line, slash commands, console, changes (§5.10) | P1 |
| F42 | Ask or search (Ctrl K) | Command line: Find (§5.9) | P0 |
| F43 | Status block | Tokens + readout, header chips, toasts, status bar (§5.11) | P0 |
| F44 | Meters and activity ring | Work waiting per queue and per source (§5.20), agent chip, status bar | P1 |
| F45 | Settings | Obsidian settings tab, six sections (§5.27): General, Sources, Agents, Privacy P0; Appearance P1; Advanced P2 | P0–P2 |
| F46 | App menus | Obsidian commands + header More menu (§8.2, §5.1) | P2 |
| F47 | Walkthrough, demo brain, reset | First-run checklist and one-time hints (P1), sample record (P2), Reset display (P0) (§5.28) | P0–P2 |
| F48 | Own-chat toggle | Layers › Ask history (§5.3) | P2 |
| F49 | Write, Today, Numbers, Review, Files | New entry (§5.24), Read › Today (§5.18), Time › Data (§5.19), Agents › Checks (§5.21, P1), Sources › Files (§5.22) | P2 (Checks P1) |
| F50 | Originals kept unchanged | Edit as a new version, History (§5.14) | P0 |
| F51 | Machine words marked | Dotted rule, model chip, dashed chips, hollow markers (§4.9, §5.15) | P0 |
| F52 | Dating with evidence | Facts grid Date + “How this date is known” (§5.14) | P0 |
| F53 | Proof of dates | Date seals in the date evidence and Settings › Advanced (§5.14, §5.27) | P2 |
| F54 | Label packs | `session`, `placement`, PARA from wiki-mode, Your fixes (§5.20, §5.27) | P0 |
| F55 | Hubs | Maps (§5.16, §6.6) | P1 |
| F56 | Self-organising with a budget | Organise automatically after the first-run step, 1,000,000 tokens/day, Agents page (§5.20, §5.26, §5.27); raised to P0 by the lead's defaults | P0 |
| F57 | Local and cloud models | Engine setting: Claude Code CLI now; API and local later (§5.27) | P1 |
| F58 | Privacy rules | Settings › Privacy, Sources › Privacy, the Agents privacy line, the first-run step (§5.27, §5.22, §5.20, §5.26) | P0 |
| F59 | Live recording | Live indicator, held arrivals, birth on Show them (§5.1, §5.11, §6.7) | P1 |
| F60 | Undated handling | Undated cloud, strip pill (§6.3, §5.8) | P0 |
| F61 | Corrections loop | Agents › Checks (§5.21), reader Correct (§5.14–5.15), map Flag (§5.16), Ask (§5.10), correction dialogs (§5.30.1) | P1 |
| F62 | Research programme | Not built | X |
| F63 | App lock and sync | Not built (OneDrive syncs; Obsidian has no lock) | X |
| F64 | One colour / time / area colouring with swatches | “Single colour…” in the key bar pickers (§5.3) | P2 |
| F65 | Body layer | Layers › Anatomy haze (§5.3, §6.2) | P0 |
| F66 | Point size, glow, brightness | Display › Points (§5.6) | P1 |
| F67 | Legend as a folder tree | Key popover tree, Read › By folder (§5.3, §5.18) | P1 |
| F68 | On-canvas hint line | The stage's one-time hint (§5.2) | P1 |

**Smaller capabilities from the SPEC's view specs**

| Capability | Cortex | P |
|---|---|---|
| Lab's per-source tagging table (V17) | Not built: Agents › Work waiting (done, waiting and checked per source) and the runs ledger's filters answer the same question without a third table | — |
| Folders checklist that removes folders from the treemap (V7) | Chart page › Folders, for Treemap and Icicle (§5.25) | P1 |
| Hide unsorted on the timeline (V15) | Time › “Hide No area” (§5.19) | P1 |
| Clicking a hub in a chart re-lays the chart around its sources (V8) | Not built: a map's sources are ringed in place instead (§7.1), so the chart keeps its layout and they stay comparable with everything else | — |

---

## 10. Design decisions

### 10.1 Resolved

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Figure pose | **Standing** by default (brain on top, the cord running down as time, oldest at the brainstem); Lying in Settings and the shape bar's overflow | It is how people picture a nervous system and how the reference videos show it; older-above-newer-below reads like a feed; and paired nerves arching round a torso give a dense record somewhere to spread evenly. A very wide, short tab suits Lying, so it stays one click away |
| 2 | Motion | **Spin**, a turntable (16 s a turn at ×1); Drift (±26° sway, 12 s) for Lying and for Keep upright | A standing figure is symmetric about its cord, so a full turn is never awkward and shows the brain's depth and every side of the torso. A lying figure would point its tail at the viewer, so it sways |
| 3 | Where nerves come from | **Conversations grow fronds**, nerves leaving the cord at their start time on alternating sides; branches are their parts | Makes structure visible (long talks are long fronds) and turns the body into data, not decoration |
| 4 | Navigation | **Five header tabs**: Brain, Read, Time, Agents, Sources; Guide is a “?” icon | Obsidian already has a left sidebar; five tabs cover every capability, and none is a renamed page of the reference product |
| 5 | Where pages and readers go | **One right sheet with a stack and a crumb** | Reading and browsing never compete for two docks; Back is predictable; the crumb shows where a note came from |
| 6 | Search and the AI pane | **One command line, two modes**, Cortex's verbs as slash commands; console rises from it | One place to type; the brain stays visible while Ask works; fits a Claude Code user's habits |
| 7 | Status display | **Tokens** in the command line + header chips + toasts + Obsidian status bar | What is traced is always visible and removable; background state stays visible in other tabs |
| 8 | Legend | **Horizontal key bar** with Layers; the time strip is the age key | Leaves the stage's sides free for the figure and stops two legends from repeating each other |
| 9 | Scope | **The compass turns the figure** to the chosen territory; the space chip also steps on click and wheel, with a member flash and a swirl home | It is the actual brain partition seen from above, so the gesture and its result are the same object |
| 10 | Settings | **Obsidian's settings tab**, not a custom modal | Native, searchable, one place |
| 11 | Vault notes | **Obsidian renders and opens them**; Cortex only peeks | Never re-implement the editor; respect page preview settings |
| 12 | Colour for remainder and missing values | **Mist** for Other, **slate** for no value; white reserved for hover, selection, birth | Avoids confusing “unsorted” with “selected” |
| 13 | Assigning colours | **Sticky, by rank of everything indexed**, max 8, rest in Other | Colour follows the group across filters, scopes and periods |
| 14 | Age colours | **Lightness-rising ramp**, colour from spine position | Newest reads brightest; bursts get their own colours instead of one blob |
| 15 | Strip scale | **Log by default**, labelled; Linear in Settings | Quiet years stay visible next to the Claude Code burst |
| 16 | Reference material | **Hidden by default and left out of agent jobs** (notes with `status: reference` and the Roblox creator docs) | Lead's default 4; keeps 72% generated notes from swallowing the brain or the budget |
| 17 | Undated entries | **Their own cloud just below the cord's tip**, plus the strip pill | Honest: no fake date, but still visible and countable |
| 18 | Map recency | **A 12-week sparkline** in the reader; active / cooling / dormant (30 / 120 days) only as a Read filter | Shows the shape of activity instead of a verdict |
| 19 | Marking machine text | **Dotted vs solid rules, dashed vs solid chips, hollow vs filled markers, a model chip** | Works without colour and at a glance; no disclaimer sentences |
| 20 | Budget unit | **Tokens per day** (1,000,000 default); API-equivalent cost shown as information only | The engine is the user's Claude Code plan; dollars would mislead |
| 21 | Ask safety | **No tools for the model; JSON actions validated against the registry; Apply for data changes; corrections and bringing back always wait; budget-spending actions show Cortex's estimate** | Matches the lead's no-tools rule and keeps one injected sentence from changing data |
| 22 | Too-thin groupings | **Drawn in place** (hollow, “n” chip) with a Fold action; threshold 30 items | Suits a personal record's scale; no sentence banner |
| 23 | Several Cortex tabs | **Independent views, shared index**, ≤ 3 live renderers | Lets you compare views without doubling the data or the GPU budget forever |
| 24 | Light theme | **Paper stage** (normal blending) by default; Ink available | Follows the user's theme without forcing a dark hole into a light window |
| 25 | Accent text contrast | **Accent fill = accent mixed 90% with black** for filled buttons | White on the raw accent is 4.3:1; on the fill it is 5.4:1 |
| 26 | The Display popover | **Points and motion only**; shape in the shape bar, colour and layers in the key bar | Each control sits next to what it changes; the popover stays short |
| 27 | Palettes | **Prism, Signal and a computed Print mode**; Stage tint instead of mood palettes; every stop checked against the observed colours | Two categorical palettes that pass every check, one honest print mode, and no counterpart sets |
| 28 | Fonts | **None bundled**: Obsidian's interface and monospace fonts | Native in every theme; one decision shared with the architecture (§12.4) |
| 29 | Merging inside a chart | **“Combine with…” is local to the chart** and saved with a pinned view; the key's “Merge with…” is the global fix | Exploring a chart must not recolour the brain by accident |
| 30 | Where changes and Ask history live | Changes in `.vault-meta/cortex/receipts/<yyyy-mm>.jsonl`; Ask exchanges as record entries of source `cortex-ask` under `.raw/chats/cortex-ask/` | One location each, in both documents |
| 31 | Filing | **Always a suggestion** (a filing check); Settings says agents “suggest where things belong” | Matches the architecture: filing is never applied automatically |
| 32 | Checks | **Apply and show in Checks** by default; **Hold for my check** keeps labels out of every count until confirmed | The record organises itself, and you can still be strict |
| 33 | Consent | **A first-run step before any import or model call**, with “Import and organise” preselected | Lead's default, with the user's explicit go-ahead; nothing is sent before it |
| 34 | Leaving out and removing | **Nothing is ever deleted**; Cortex-written notes become placeholders with the old file in Cortex's trash | Undo restores exactly; a privacy action never destroys the only copy |
| 35 | Secrets in imported text | **Kept on this computer**, outside OneDrive, with a marker in the record | Import must not turn a local secret into a synced one |
| 36 | Links into Cortex | **Navigation only** | A link from a web page can open a view, never start work |
| 37 | Onboarding | **A self-ticking checklist and one-time hints**; no narrated tour | Teaches by doing, at the moment each surface is first used |
| 38 | Dimming | Selected: others × 0.06, haze × 0.35. Traced: others × 0.12, haze × 0.5 | A selection must stand out (main.png); a traced set keeps more context |

### 10.2 Still open (decide before or during the build)

| # | Question | Default chosen until decided | Who decides |
|---|---|---|---|
| 1 | Does the user like the standing pose as the default? | Standing; one setting flips it | User, after seeing `main.png` |
| 2 | Exact model aliases and ids the Claude Code CLI accepts on the user's plan | haiku / sonnet / opus aliases | Builder: run `claude -p --model …` once each |
| 3 | Whether to show API-equivalent cost at all | Shown only in the run detail, labelled “at API prices” | User |
| 4 | Gemini Takeout and Claude.ai export shapes | As SPEC §7; parsers verified against one real export each | Builder, with a sample from the user |
| 5 | System Save dialog API inside Obsidian (Electron remote) | Use it if present; otherwise write to Downloads and show the path in a notice | Builder |
| 6 | Cost of frosted glass over 300,000 additive points | Blur on; auto-off by the frame-rate governor | Builder, measured |
| 7 | Retiring the vault's older visualisation plugins | Untouched; Cortex sits beside them | User |
| 8 | Whether gists in `wiki/derived/` should be tracked by git | Nested `.gitignore` with `*` (lead's default 1) | User |
| 9 | Whether date seals ever use a public timestamp service | Seals off; public timestamping is an explicit button | User (P2) |
| 10 | Whether the `session` pack's values fit exported chats as well as Claude Code sessions | One pack for all conversations; revisit after the first 200 checks | User, through Checks |

---

## 11. Review responses

The revision applies every finding. Where it did not take a finding exactly as written, the reason is here.

| Finding | What changed instead | Why |
|---|---|---|
| ORIG-10, the palette check | `palette_check.py` enforces a 5 ΔE floor for chromatic stops and a 3 ΔE floor for near-neutral stops against every data colour in section 6 of the four analyses (225 colours), a set rule (no palette or ramp whose best one-to-one assignment to an observed palette averages under 6.5, or pairs half its stops under 6), and ten negative controls that must be caught, including Glacier, Kiln, Ash and the scaffold's palettes and themes. The literal rule (every stop ≥ 8 from every observed stop) is printed for information. | The literal rule fails 97 of 104 shipped stops, including Prism and Signal, which the finding itself calls fine. Under 9% of the usable glow band and none of the neutral band (L 0.35–0.9) lies 8 ΔE from every observed stop, because the recordings contain rainbows, ramps and a full grey scale. A 5 ΔE floor is about 2.5 just-noticeable differences, rules out any sampled value, and is satisfiable: 69 of the 100 earlier stops were nudged to meet it (§4.4–4.5), all accessibility checks still pass, and the set rule catches every counterpart set the review measured. |
| ORIG-11, privacy wording | “Assistant replies imported from ChatGPT and Gemini are never sent to a model; models only see what you typed there.” Settings group “Don't send assistant replies to models from”. | The proposed “stay on this computer” and “Keep assistant replies local” would be false: imported text lives in the vault, which OneDrive syncs (SAFE-10). The rule is stated from the other side, as the finding asks, and stays true. |
| ORIG-15, the session pack | `session` applies to every conversation, not only Claude Code sessions. | Charts and Checks need one set of work and outcome labels across sources; the values were derived from this vault's sessions and fit chat exports too. Open question 10 revisits it with real checks. |
| ORIG-21, the docking row | The single right sheet stays; the table row now states the recordings' docking correctly (C on the right with the reader stacked over it; B and the site on the left). | A right-hand panel is Obsidian's own convention (its right sidebar). Cortex's differences are the single back stack with a crumb, the push / overlay / full modes and the resizable width, not the side. |
| ORIG-07, the ridgeline Scale control | Scale offers Linear · Log. | Keeping a three-way Linear · Square root · Log control would repeat the observed set word for word. |
| ORIG-12, the frond scrubber | The scrubber carries a mono index “39 / 549” beside its label. | Screen readers and exact stepping need the position as text; it is a counter, not the flagged sentence. |
| ORIG-02, the Time page | Under the figure, the page lists the period's longest conversations as Read rows. | Gives the figure a way into the readers using Cortex's own row design; it is not one of the recorded sections. |
| ORIG-09, the sample record | Reachable from the empty state, More › Sample record and a command. | Useful later for trying charts on a full record without touching your own; there is still no tour. |
| ORIG-16, motion after a scope turn | The spin continues around the new heading. | The finding is silent on motion after the turn; centring the spin's start on the chosen territory keeps it facing you. |
| ORIG-08, slash commands | A slash command still goes to the model, which may return only that verb; the Try suggestions are computed without a model call. | The model fills in ids and values from the record; Cortex still applies the change itself. Suggestions must not spend tokens just because the console opened. |
| M5, filing | Filing stays a suggestion; the Settings copy changed to “suggest where things belong”. | Of the two options the finding offers, this one matches the architecture and the record's rule that nothing changes without the user. |

---

## 12. Requirements for architecture

What `docs/ARCHITECTURE.md` and the scaffold must add or change so the build matches this document. Items name the finding they come from.

**12.1 Originality checks in `npm run check`** (ORIG-21, ORIG-10). Run `docs/mockups/src/originality_check.py` (or a vitest port that reads the same pattern list) over `src/ui/copy.ts`, the markdown templates in `src/store/notesWriter.ts`, any user-facing strings in `src/agents/privacy.ts`, and the two mockups; run `palette_check.py`; any hit fails the build. Today the scaffold's `copy.ts` has 19 hits: `nav.review`, `view.turning`, `view.limitRotation`, `view.pointSize`, `view.spread`, `reader.assistantWords`, `reader.otherWords`, `reader.written`, `reader.machineNotice` (“not your words”), `reader.noLabels`, `pages.timelineSubtitle` (two), `pages.authorshipSubtitle` (two), `banner.sparse` (two), `banner.importMore`, `answers.spans`, `answers.balance`. The whole `answers` table goes (charts have readings, §7.1), and `copy.ts` gains value-label maps for map status, map type, kind, speaker and source, used wherever an enum value is shown (L7).

**12.2 Shell, pages and commands** (ORIG-20, ORIG-01, ORIG-09). ARCHITECTURE §13 and E11 describe a rail, a left dock and a right assistant pane; replace them with §3 here: header, stage, one right sheet, bottom command line and console. `views.ts`: `PageId` = `brain | read | time | agents | sources`, plus sheet routes `entry | conversation | note | map | vault-peek | thread | chart | guide | new-entry | change-history | runs`; every page docks in the sheet; Add sources and the first-run step are modals. Remove `authorship`, `library`, `today`, `tables`, `files`, `review`, `assistant`, `write`, `import` and `SHORT_RAIL`. Delete `src/ui/pages/Authorship.tsx`, `src/ui/tour/Tour.tsx` and `TOUR_STEPS`; remove the rail components, including `SpaceChip`'s click-to-cycle, wheel stepping and name roll. Add per-device hint and checklist state (`app.saveLocalStorage("cortex:hints")`). Scaffold files follow their sections: `pages/Timeline.tsx` becomes Time (§5.19, ORIG-02), `pages/Library.tsx` becomes Read (§5.18, ORIG-22), `reader/EntryReader.tsx`, `NoteReader.tsx` and `HubReader.tsx` follow §5.14–5.16 (ORIG-12, ORIG-05, ORIG-06), `canvas/ViewPopover.tsx` becomes the Display popover of §5.6 and the key bar's Layers menu (ORIG-13), `canvas/ChartsPanel.tsx` follows §5.25 and §7 (ORIG-07), `assistant/AssistantPane.tsx` becomes the Ask console of §5.10 (ORIG-08), and `pages/Agents.tsx` with `rail/Meters.tsx` follow §5.20 (ORIG-11). Commands as §8.2 (drop `open-you`, `start-tour`, `export-picture`, `export-counts`, `open-tables`, `open-review`, `open-browse`, `write`; add `open-read`, `open-checks`, `new-entry`, `change-history`, `pin-view`, `save-image`, `copy-data-csv`, `reset-hints`, `toggle-drift`). ARCHITECTURE §0.1 item 2's list of page names changes to these.

**12.3 Palettes, stages, speakers** (ORIG-10). `palette.ts`: `PALETTES` = Prism and Signal with the values of §4.4 (glow, fill, light); Print computed (§4.4); delete `spectrum, kiln, tide, moss, borealis, pewter, dusk` and the themes `ink, harbour, basalt, fern, mulberry, ash`; `TIME_RAMP_*` = the age ramp of §4.5; the remainder is mist (Other) and slate (No value) in all three variants, never white; `SPEAKER_SLOTS` = you 2, assistant 7, another person 5, tool no-value (the scaffold has you 5, assistant 6). `settings.ts`: `PaletteId = "prism" | "signal" | "print"`, `StageId = "follow" | "ink" | "paper"`, `stageTint: number | null` (hue degrees), `ageColours: "hue" | "lightness"`.

**12.4 Fonts** (L6). Drop `@fontsource-variable/inter`, the `fonts/` deploy step, `src/ui/fonts.ts` and the `FontFace` load; `--cx-font: var(--font-interface)` and `--cx-font-mono: var(--font-monospace)`. Update ARCHITECTURE §1 (pinned versions), §2 (build), §13 (design system) and §15.6 (licences).

**12.5 Packs, kinds, maps and dimensions** (ORIG-15, ORIG-14, ORIG-23, L7). `packs.ts`: `session@1.0.0` for conversations — `work` (debug, build, research, write, set up, plan), `outcome` (shipped, partly done, abandoned, blocked, still open), `project` (text), `topics` (≤ 5); `placement@1.0.0` for notes — `role` → region (the current role list); PARA is not a model pack: when `.vault-meta/mode.json` says `para`, a PARA dimension is derived from each note's PARA folder, otherwise it is disabled with the reason; `correction@1.0.0` field `fixes`, label “Your fixes”. Remove `core` (its kind, intent, stage, status, claims and unfinished labels) and `shelf`. Note kinds: decision, question, idea, plan, abandoned, concept, summary. Hubs become maps everywhere the user can see them: types project, area, topic; files under `wiki/derived/maps/<project|area|topic>/`. `dims.ts`: groups `file | conversation | agents | you`; one date dimension with granularity (day, week, month, year, hour, weekday) and basis (written, imported); remove `population`, the separate “added” dimensions and “Unsorted” remainders; keep one area dimension (the scaffold's `space` and `area` are the same thing to the user). `GroupLayout` = `bubbles | tree | spine | strata` (remove month grid, year wheel, regions). Update ARCHITECTURE §10.3 and §12.7 (“year wheel”).

**12.6 Scope, selection and lines in the renderer** (ORIG-16, ORIG-17, ORIG-19). ARCHITECTURE §12.6's “return-to-all swirl 400 ms + dolly 1.2 s” becomes the scope turn of §6.7: a 600 ms yaw to the territory's heading, non-members sinking 25% toward the core while fading (300 ms), members rising back on return (400 ms); add a per-point sink offset to the vertex shader. State multipliers as §6.6 (selected × 0.06, haze × 0.35; traced × 0.12, haze × 0.5; preview × 0.35; hidden × 0.06), replacing §12.3's “unlit 10%, haze 4%”. Map hover mixes its sources toward the territory colour (+60%); no white cascade. Line families: source lines, conversation stems, and map spokes on selection only; drop parent lines, cross-links and sequence chains. Lines need hover picking (a nearest-segment test is enough) for their tooltips. Motion: drift centred on a heading, speeds ×0.5, ×1, ×2 (replacing 0–200%); Keep upright limits ±50° yaw and ±30° pitch (ARCHITECTURE §12.6 says ±60° / ±35°). Groups layouts as §6.12.

**12.7 The action registry** (SAFE-04, ORIG-25, ORIG-08, ORIG-07). Rename `light` to `trace`. Add by RFC, with closed schemas: `set_period`, `arrange`, `include`, `set_date`, `set_speaker`, `refile`, `pin`. `make_chart` takes `x`, `y`, `colour`; `open_view` takes the page and route ids of §12.2. Flags: `changesData: true` for include, exclude, set_label, set_speaker, set_date, refile, merge_groups and correct_entry; `alwaysConfirm` for include and correct_entry; `spendsBudget` for refresh and propose_filing, whose Apply card shows Cortex's own estimate; refresh scope is `selection | period` only, at most 200 items. A slash command sends `onlyVerb`, and the validator rejects any other verb. Change text (`ReceiptRecord.summary`) is generated by Cortex from validated parameters and resolved targets; a model `reason` is stored separately and shown labelled. Undo of a data change never expires. Changes live in `.vault-meta/cortex/receipts/<yyyy-mm>.jsonl` (fix the comment in `types.ts`); Ask exchanges are record entries of source `cortex-ask` under `.raw/chats/cortex-ask/` (rename `assistant-pane`). Rename ARCHITECTURE §11 to “Ask: questions and changes” and drop the quoted tagline from the header comments of `actions.ts` and `aiExecutor.ts`.

**12.8 Engine and runner states** (M1, ENV-INHERIT, SKILL-LONG-RUNS). `ActivityState.engine: "ok" | "offline" | "auth" | "missing"`; sign-in and missing-CLI failures set it instead of pausing, and a free `doctor` probe every 5 minutes resumes work on success. Surface the runner's `inline` and `unavailable` modes, index build or load failures, OneDrive conflict copies, segments not yet downloaded by Files-On-Demand (with a fetch request), repeated import failures and other `warning` events, each with a catalogue code the UI maps to §5.31's copy. The child environment is an allowlist (no UI, but Export diagnostics lists the variable names passed). Runs record their origin (`plugin` or `skill`) for the ledger. CLI runs are bounded (`--max-seconds`, `--max-jobs`) so the skill leaves no orphans.

**12.9 Checks** (M5, M17). Each label or summary run appends one ReviewCard per target (kind `label` or `note`) with confidence and a reason of at most 140 characters from the output schema; `agents.reviewMode: "apply" | "hold"` with `LabelRecord.state = "held"`, which counts nowhere until confirmed; the Agents badge counts unresolved cards; card kinds `filing` (never applied automatically), `mention` (from the name check) and `conflict` (a user-edited derived note), with the copy of §5.21.

**12.10 Settings additions.** `you.names[]`, `you.handles[]`, `you.speakerBySource`; `privacy.withholdAssistantFrom` per source (ChatGPT and Gemini on, Claude.ai and Claude Code off); `privacy.keepSecretsLocal` (on); `general.firstRunDone` and `agents.enabled` from the first-run choice; `agents.reviewMode`; `agents.skipReference` (on); `agents.applyAskWithoutConfirm` (off); the appearance keys of §12.3 plus `namesOnFigure`, `lines`, `stems`, `patterns`, `motion`, `stripScale`; `advanced.nodePath`, `advanced.dateSeals`. Pinned views live in `.vault-meta/cortex/views.json` (replacing `tables.json`).

**12.11 Inert markdown and readers** (SAFE-01, ORIG-05). `notesWriter` escapes every model string with `mdInert`; only Cortex writes structural markup (headings, callout line, list markers, citation links built from validated ids). The summary template is the one in §5.15: facets in `cortex_*` frontmatter, a `cortex-machine` callout, `## Timeline`, `### ‹time range› · ‹part title›`, notes as block-ref bullets, footnotes with `obsidian://cortex` links and no quote text. Validators drop any field carrying an injection signal (`$=`, `dataviewjs`, a code fence, `<script`, `<iframe`, `javascript:`, `obsidian://`, `](`, `![`, `[[`, `::`) and raise a check and a warning. Record entries, documents and machine notes are rendered by Cortex's own inert renderer; `MarkdownRenderer` is used only for legacy vault notes in the peek. Add the contract test with the injection fixtures. Remove “not your words” from ARCHITECTURE §8.2's example and from `src/agents/privacy.ts`; rewrite §15.2 to say markdown is code in this vault.

**12.12 Live settings and the record reader** (SERVICES-CONTRACT-GAPS). `SettingsHandle.signal` so palette, stage, tint and names changes reach every open leaf at once; `onExternalSettingsChange` reloads, migrates and sets. `RecordReader` is owned by E2 (`store/recordReader.ts`) and serves every reader in §5.14–5.16 and the thread view.

**12.13 Background work and consent** (BG-IMPORT-UNWIRED, SAFE-11). The agents clock joins `CortexServices` in a cheap background tier and starts only when `firstRunDone` is set; it runs a startup import, watches transcripts, schedules agents, and stops on unload. Reference notes are left out of agent jobs by default. The first-run step needs per-source counts and a backlog estimate (conversations, notes, tokens, days at the cap) before anything is imported: a dry-run estimate from the runner.

**12.14 Leaving out, removing, writing** (SAFE-12, M17). Exclude never deletes. A Cortex-written, unedited derived note becomes a placeholder (`cortex_state: excluded`, “Left out by you on ‹date›.”, no quotes) with its previous bytes in `.vault-meta/cortex/trash/<noteId>/<sha>.md`, so Undo restores it exactly; a user-edited note is left alone and a conflict check is raised. “Remove source” = stop watching + exclude everything it imported. New derived notes are created exclusively (`wx`), with `-2`, `-3` suffixes on a name clash. New entry's Undo is an exclude fix; the file stays in `.raw/written/`.

**12.15 Secrets at import** (SAFE-10). Run the high-confidence secret detector at import; store a marker in the segment and the original line under `%LOCALAPPDATA%/cortex/<vaultKey>/held/`; give readers a “show on this computer” call; report the count in the import result. State in §15 that OneDrive sync is egress.

**12.16 Links and frames** (SAFE-17). The `obsidian://cortex` handler is navigation-only: `entry`, `note`, `area`, `period` and `view` are validated (id pattern, vault API path resolution, strict period parsing, pinned-view id), and nothing starts an import, an agent run, Ask or a change. Runner frames carry counts, ids, enum codes and Cortex-built paths; error text comes from a fixed catalogue (which §5.31 maps to copy); `SKILL.md` tells Claude to treat runner output as data.

**12.17 Statistics the pages need** (E9). Time: each conversation's τ (the cord's), words per τ bin per speaker, note glyph positions (the τ of each note's source conversation), weekday × hour counts for the period, and the trend of your share. Read and Sources: each conversation's and each source's share of your words, and a first-line snippet. Agents: work waiting per queue and per source (done, waiting, checked), and the access-log aggregates (model, route, items read, first, last) from `reads/`. Map reader: a 12-week member sparkline, members grouped by kind, and per-statement quote counts by speaker. Charts: up to three readings per chart (values, names and anchor positions) instead of answer strings; Top N default 20; local combines saved in pinned views (`mergedCategories`); `excludedFolders` for Treemap and Icicle; the ring set for a map's sources.

**12.18 Feasibility findings with no design change.** TRANSFER-DETACH, SEGMENT-SEQ-DEADLOCK (its only visible effect is the repeated-failure line in Sources), LOCKS-SHARED-SYNCED, LEDGER-SHARD-SIZE, PICK-CLEAR-PROBE (the design relies on correct picking on the Paper stage, so the integer target must be cleared to zero) and CHILD-CWD-ONEDRIVE change nothing a user sees. The design assumes each is fixed as its finding proposes.

**12.19 The standing figure** (v1.2: the figure now stands by default; Lying stays an option). Everything below follows from §0 decision 1, §3.2, §6 and §10 rows 1–2. The scaffold was written against the lying figure in places; these are the exact changes, by file.

1. **Default pose.** `src/shared/settings.ts` (`DEFAULT_SETTINGS.general.pose` is `"lying"`; make it `"standing"` and add `general.poseChosen: boolean`, false by default, so a stored `"lying"` written by an older build is read as Standing until the person picks a pose; bump `SETTINGS_VERSION` with a migration). `src/state/types.ts` (`settings?.general.pose ?? "lying"` at line 87 becomes `?? "standing"`; line 109 keeps the pose → motion rule, now Spin first). `src/worker/anatomy.ts` `resolvePose` already falls back to `DEFAULT_SETTINGS.general.pose`; no change. `src/ui/copy.ts`: the Pose dropdown lists Standing first, and `poseDesc` becomes “Standing runs time from the head down. Lying runs it from left to right.” (keys `lying` at lines 164 and 1411 stay; add them after `standing`).
2. **Camera and framing.** `src/render/tuning.ts`: `poses.standing.home` is {yawDeg −150, pitchDeg −6}; set the home heading 154° and elevation 9° (§6.8) and keep a single source for `camera.standing` ({yawDeg 20, elevationDeg 5}, which duplicates it with a different sign convention: delete one). Add `frame.standing.slideStepPx: 6`, `maxSlidePx: 36` and make `fitStanding` slide before it shrinks (§3.2); the crown fraction stays 0.09. Rewrite the file's header comment, which says §6 is “being revised”. `src/render/camera.ts`: `homeLying`, `safeFrame` and `fitMargin` are built from `T.frame.lying` and the initial `base` framing at line 434 is `T.poses.lying.home`; resolve all three from the current pose, so the first frame of a standing leaf is already the standing home view and never snaps from the lying one. `fitRect` and `driftAngles` keep their lying defaults, used only for Lying. `src/ui/breakpoints.ts` `safeFrame(…, pose)`: the standing branch is the default; the Mini breakpoint (§2.5) shows the brain only, fitted to its crown and cerebellum.
3. **Spin is the default motion.** `src/render/camera.ts` `MotionMode`: order `"spin" | "drift" | "off"`; Spin is 60 s per turn about the cord's vertical axis, starting from the current heading; with Keep upright it sways (yaw h ± 26° over 40 s, pitch 0). `src/plugin/commandRun.ts` (line 288, `toggle-drift`) and `src/plugin/commands.ts` (line 32): rename to `toggle-motion`, name “Spin on or off”; the handler already picks spin for Standing and drift for Lying. `src/ui/stage/ToolColumn.tsx` (tool id `"drift"` at lines 25, 56, 92, 120–125 becomes `"motion"`; its label is `display.spin` in Standing, `display.drift` in Lying); `src/ui/copy.ts` (`tools.drift` at line 183 and `display.drift` at line 204: add `tools.spin`, order Spin first); `src/ui/stage/DisplayPopover.tsx` and `src/ui/keymap.ts` `motionModeFor` already put the pose's own motion first. `src/render/animation.ts` (line 217): “the drift should be fully eased in” becomes the spin's ease-in over 1.5 s from the Settle stage.
4. **Standing anatomy generator.** `src/worker/anatomy.ts` already has a standing `FIGURE`, but its constants predate §6.2. Replace them with the values of §6.2: cerebrum centre (0, 4.00, 0.06), axes (1.42, 1.02, 1.60), exponent 2.3, base y 3.40, fissure and lateral sulcus; temporal lobes; cerebellum (0, 3.16, −0.86) with axes (1.02, 0.42, 0.62) and the folia bands; brainstem y 3.58 → 2.74; the 16-point cord centre line and radius table; the 31 exit levels (`segmentLevels()`); `envelope.y`/`halfWidth` (18 entries); the 31-row `nerves.levels` table as (leave, bend, wrap, length) rows, with the 2.2 power bend, the 0.40 depth ratio, the 0.22 end drop and the −4.32 floor in `traceNerve`/`runNerve`. The crown must come out at y 5.00 and the cord tip at −4.02. Sample the brain as §6.2: 74% cerebrum, 5% per temporal lobe, 16% cerebellum, 88% of cerebrum slots on the surface, the fold probability 0.04 + 0.96 f⁷.
5. **Fronds on nerves.** `src/worker/placement.ts` (record placement): the root is `spinePoint(τ)` with τ from the §6.3 rule; the segment is `nerveLevel(τ)`; side alternates by rank in start order (note that importing an older conversation later re-flows the sides after it, which is a rebuild event, §6.7); the course is `traceNerve(τ, side, shell = 1, length = f × level length)` with a 0.22 rootlet, then the ribbon offsets N(0, 0.011), the messages at u^0.85, the splay and the part branches of §6.3. Remove the old sweep-toward-the-tail and curl-about-the-axis rules, the 36 / 28 / 36% direction split and the “newest 10% shortened” rule: the segment's own nerve length already shortens the newest ones.
6. **Haze.** `HAZE_BUDGET` is {brain, body, vertebra, brainstem} and `HAZE_KIND_INDEX` has `body` and `vertebra`; replace them with {brainFolds 8,400, brainVolume 3,500, cerebellum 2,100, brainLips 1,800, nerveGuides ≈ 11,000, nerveTwigs ≈ 3,200 (62 guides and 124 twigs), cordThread 3,000, rings 1,240, brainstem 700} and kinds `nerve`, `thread`, `ring`; delete the filled body envelope haze (the torso is the nerves, §6.2) and the vertebra chevrons. `src/render/layers/haze.ts` and `src/render/layers/points.ts`: per-kind intensities from §6.5 (the nerve guides' 0.24 → 0.13 gradient, the cord thread's 0.95, the notes' 1.7 and the brain depth cue 0.16 + 0.84 n^1.6, the fronds' 0.60 → 0.36 gradient).
7. **Lines.** `src/render/layers/lines.ts`: source lines (§6.10) are quadratic curves from each note to its messages whose control point sits level with the chord's middle, on the entry's side of the cord, at 2 × w(y) + 0.2 from the cord axis, so they pass outside the torso; they must not cross the cord.
8. **Labels and compass.** `src/ui/stage/LabelLayer.tsx` and `src/render/overlay.ts`: two label columns either side of the brain (§6.11), the 4 px / 8 px relaxation unchanged, discard anchors inside the key bar, shape bar and tool column rectangles. `src/ui/stage/Compass.tsx`: the needle shows the azimuth of the territory facing the camera about the brain's vertical axis, which now changes continuously with the spin (update at most 15 Hz, and not at all under reduced motion).
9. **Growth order.** `src/render/animation.ts` stages (`TUNING` intro table): seed at the top of the brainstem; the cord born top to bottom at 0.25 + 1.05 τ; nerves and fronds out from their roots 0.08 s after the tip passes; anatomy haze 1.20–1.60; the brain last, deepest note first (1.60–3.10); maps and counts, then the spin eases in (2.90–3.60) (§6.7). Rebuild is the same order in 0.9 s. Reduced motion fades everything in over 200 ms.
10. **Checks.** Add a vitest on the anatomy generator: crown y 5.00 ± 0.02, cord tip −4.02 ± 0.02, the brain's slots inside y 2.74–5.02, the S-curve z range 0.74 ± 0.05, the cord centre line monotone in y, every nerve inside the envelope plus 0.2 and above y −4.32, 31 pairs, the undated cloud's lowest point −4.86 ± 0.05, and that two consecutive conversations take opposite sides. Add a framing test at the reference stage (1176 × 825): crown between 8% and 10% of the height, lowest point at least 8 px above the command line, clearance 8 px or more from every overlay rectangle. Re-run `docs/mockups/src/render_stage.py` and both checks (Appendix A) after any change to §6.2.

---

## Appendix A. Mockups and how to regenerate them

| File | What it shows |
|---|---|
| `mockups/main.html`, `main.png` | The main view, 1576 × 933, dark, with the sheet open: a Claude Code conversation (549 messages) selected by double-click; its frond bright and the rest of the figure dimmed; six notes built from it bright in the Roblox territory with label chips and source lines curving down to the frond; the time strip with a bracket over 3–4 Nov; the conversation reader (facets, gist, stem of four parts with their notes, an expanded row with quotes, your fix); the header with five tabs, the guide icon, Live and Organising; the key bar with Layers; the shape bar with its overflow; the tool column; the compass; the command line with a conversation token and “549 traced”. |
| `mockups/panels.html`, `panels.png` | Row 1: entry reader (facts grid, frond scrubber, labels with Add label, notes that cite it, related terms, history), map reader (kind and sparkline, brief with evidence meters, members by kind), Time (rhythm grid, the spine laid flat with its brush, longest conversations), Agents (ledger: status, today, work waiting, runs with one expanded, label packs), Read (by date with the Today preset). Row 2: Ask with a thread, two changes and a proposal; Ask empty with slash commands and Try suggestions; the Display popover and the Layers menu. Row 3: the empty stage with its checklist; the first-run step of Add sources. 2160 × 2620. |
| `mockups/src/tokens.css` | The dark token block used by both mockups. |
| `mockups/src/render_stage.py` | Renders the particle impressions from the geometry and sprite values in §6 (numpy + Pillow): `stage.jpg` (plain, 1576 × 825), `hero.jpg` (`--select`, 1176 × 825) and `haze.jpg` (`--haze`, 700 × 656), each with a `.json` of overlay anchors and the composition numbers of §3.2 (crown percentage, clearances, slide and shrink steps). All three show the standing figure from the home view of §6.8. |
| `mockups/src/build_main.py`, `build_panels.py`, `icons.py` | Build the two HTML files (no external requests; images are embedded). |
| `mockups/src/palette_check.py` | Re-derives Prism's slot order, re-runs the palette and text-contrast checks, and runs the originality rules and negative controls (§0.1, §11). Exit status 1 on failure. |
| `mockups/src/originality_check.py` | Fails on any banned expression (145 patterns tagged by finding) in the files given, by default the two mockups (§0.1, §12.1). |

Regenerate from `docs/mockups/src/`: `python render_stage.py stage.jpg 1576 825`, `python render_stage.py hero.jpg 1176 825 --select`, `python render_stage.py haze.jpg 700 656 --haze`, then `python build_main.py` and `python build_panels.py`, then screenshot with Chrome headless (`--headless=new --force-device-scale-factor=1 --window-size=1576,933 --screenshot=… file:///…/main.html`; panels at 2160 × 2620). Finish with `python palette_check.py` (prints “RESULT: pass”) and `python originality_check.py` (prints “clean”).

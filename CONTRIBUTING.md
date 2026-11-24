# Contributing to Cortex

Cortex is an Obsidian plugin, plus Cortex Desktop: an Electron app around the same code.

Everyone taking part agrees to the [code of conduct](CODE_OF_CONDUCT.md). Questions go to
[Discussions](https://github.com/A21-devs/cortex/discussions), see [SUPPORT.md](SUPPORT.md).

## Set up

Use Node 20.11 or newer (the GitHub check uses Node 24). Clone outside any cloud-synced folder (OneDrive, Dropbox,
iCloud), then:

```bash
npm ci
npm run check     # typecheck + module boundaries, unit tests, build: the same as the GitHub check
npm run sample    # a synthetic sample vault and transcripts in your temp folder, to try Cortex without your own notes
npm run dev       # rebuild dist/ on every change
npm run desktop   # build and open Cortex Desktop
```

## Where things live

- `docs/CORTEX-UX.md` is the product and interaction design. Surfaces, controls and wording are specified there first.
- `docs/ARCHITECTURE.md` is the module map, contracts, protocols and on-disk formats. Modules keep to their own files;
  `scripts/check-boundaries.mjs` (part of `npm run check`) fails on imports across the lines.
- `src/ui/copy.ts` holds every word the interface shows. Add or change wording there, not inline.

## Rules the checks keep

- Cortex's look, names and wording are its own: `tests/originality.test.ts` fails on borrowed phrasing.
- Cortex never rewrites or deletes existing notes, never runs git in a vault and never touches other plugins' folders
  (see the ground rules in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#ground-rules)).
- Cortex goes online only when the person asks: **Check for updates**, and the optional public timestamp of a date
  seal (see the README's Privacy section). A new network request needs the same treatment. Anything sent to a model
  is listed by **Show what is sent**.

## Keep personal data out

Tests, fixtures, sample data and screenshots must not contain real names, email addresses, file paths, note titles or
chat text. Use the synthetic sample vault and placeholders such as `C:/Users/you/...`.

## Pull requests

- One change per pull request, linked to its issue ("Closes #12").
- `npm run check` must pass; GitHub runs it on Windows for every pull request.
- Fill in the checklist in the pull request template.

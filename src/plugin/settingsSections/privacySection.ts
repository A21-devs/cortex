/**
 * Settings > Privacy, the consent rows:
 *   - "Who can read this" at the top: where the record is, whether it is encrypted, which readers have read it, who holds a
 *     share of the key, the grants, the open spaces and the last time anything left this computer. Each line has a button
 *     that goes to its control.
 *   - Grants: "Require a grant", the list (purpose, reader, spaces, days, reads, Revoke) and a form to add one.
 *   - Open spaces: every area, space of yours and folder, closed until opened; "Open nothing".
 *   - The read limit per item.
 * Every change is also written into the record as a dated, sealed entry (plugin/consentRecord.ts). The rules themselves
 * (what a grant covers, what counts as open) are shared/consent.ts; the runner enforces them (agents/grants.ts).
 */
import { effectiveOpenSpaces, grantState, grantUsed, isOpenPlace, makeGrant, revokeGrant, READER_IDS, type GrantProblem } from "../../shared/consent";
import type { CortexSettings } from "../../shared/settings";
import { SPACES, NO_AREA } from "../../shared/spaces";
import { localDayKey } from "../../shared/time";
import { normaliseFolder } from "../../shared/userSpaces";
import { COPY } from "../../ui/copy";
import { recordConsent } from "../consentRecord";
import type { SectionHost, SectionRow } from "./index";

const c = COPY.consent;
const fill = (s: string, v: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? `{${k}}`));
const AREAS = [...SPACES.map((s) => ({ id: s.id as string, name: s.name })), { id: NO_AREA.id as string, name: NO_AREA.name }];

// ───────────────────────────── the edits, pure on a settings draft (tested without a settings tab) ─────────────────────────────

export function setAreaOpen(s: CortexSettings, id: string, on: boolean): void {
  const rest = s.consent.openSpaces.filter((x) => x !== id);
  s.consent.openSpaces = on ? [...rest, id] : rest;
}

export function setUserSpaceOpen(s: CortexSettings, id: string, on: boolean): void {
  const sp = s.userSpaces.find((u) => u.id === id);
  if (sp) sp.open = on;
  // A user space id that was listed as open by hand follows the flag.
  s.consent.openSpaces = s.consent.openSpaces.filter((x) => x !== id);
}

/** Open a folder path. Returns the cleaned path, or "" when it is not a usable path. */
export function openFolder(s: CortexSettings, raw: string): string {
  const folder = normaliseFolder(raw);
  if (folder === "") return "";
  if (!s.consent.openSpaces.includes(folder)) s.consent.openSpaces = [...s.consent.openSpaces, folder];
  return folder;
}

export function closeFolder(s: CortexSettings, folder: string): void {
  s.consent.openSpaces = s.consent.openSpaces.filter((x) => x !== folder);
}

/** Close everything at once: the list, and every space of the owner's. */
export function openNothing(s: CortexSettings): void {
  s.consent.openSpaces = [];
  for (const sp of s.userSpaces) sp.open = false;
}

/** The names of everything open, for the summary and the record entry. */
export function openNames(s: CortexSettings): string[] {
  const out: string[] = [];
  for (const a of AREAS) if (s.consent.openSpaces.includes(a.id)) out.push(a.name);
  for (const sp of s.userSpaces) if (sp.open || s.consent.openSpaces.includes(sp.id)) out.push(sp.name);
  const known = new Set([...AREAS.map((a) => a.id), ...s.userSpaces.map((u) => u.id)]);
  for (const f of s.consent.openSpaces) if (!known.has(f)) out.push(f);
  return out;
}

/** The spaces a grant may name: every open area, open space of the owner's and open folder, with its label. */
export function grantChoices(s: CortexSettings): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const a of AREAS) if (isOpenPlace({ space: a.id, folder: [] }, s.consent, s.userSpaces)) out.push({ id: a.id, label: a.name });
  for (const sp of s.userSpaces) if (sp.open || s.consent.openSpaces.includes(sp.id)) out.push({ id: sp.id, label: sp.name });
  const known = new Set([...AREAS.map((a) => a.id), ...s.userSpaces.map((u) => u.id)]);
  for (const f of s.consent.openSpaces) if (!known.has(f)) out.push({ id: f, label: f });
  return out;
}

/** A space id as the person knows it: an area's name, a space's name, or the folder path. */
export function spaceLabel(s: CortexSettings, id: string): string {
  return AREAS.find((a) => a.id === id)?.name ?? s.userSpaces.find((u) => u.id === id)?.name ?? id;
}

export const readerLabel = (id: string): string => (c.readerNames as Readonly<Record<string, string>>)[id] ?? id;

// ───────────────────────────── drawing ─────────────────────────────

interface Draft {
  purpose: string;
  reader: string;
  spaces: Set<string>;
  days: number;
  limit: number;
}

let draft: Draft = { purpose: "", reader: "any-model", spaces: new Set(), days: 30, limit: 0 };
let problem = "";

async function tell(host: SectionHost, change: Parameters<typeof recordConsent>[1], s: CortexSettings): Promise<void> {
  try {
    const sv = await host.services();
    const r = await recordConsent(sv, change, (id) => spaceLabel(s, id));
    if (r.ok) host.notify(c.sealedNote);
    else if (r.reason === "failed") host.notify(c.sealFailed);
  } catch {
    host.notify(c.sealFailed);
  }
}

function mark(row: ReturnType<SectionHost["row"]>, ctl: string): void {
  (row as unknown as { settingEl?: { setAttr?(k: string, v: string): void } }).settingEl?.setAttr?.("data-cx-ctl", ctl);
}

function goTo(host: SectionHost, ctl: string): void {
  host.mount.ownerDocument.querySelector<HTMLElement>(`[data-cx-ctl="${ctl}"]`)?.scrollIntoView?.({ block: "center" });
}

function stateText(g: { state: string }): string {
  return (c.state as Readonly<Record<string, string>>)[g.state] ?? g.state;
}

function grantsRows(host: SectionHost, s: CortexSettings): void {
  host.heading(c.grantsHeading, c.grantsDesc);
  const req = host.row(c.requireName, c.requireDesc);
  mark(req, "grants");
  req.addToggle((tg) =>
    tg.setValue(s.consent.requireGrant).onChange((v) => {
      host.set((x) => void (x.consent.requireGrant = v));
      void tell(host, { kind: "require-grant", on: v }, s);
    }),
  );
  const today = localDayKey(Date.now());
  const list = host.mount.createDiv({ cls: "cx-grants" });
  const draw = (counts: Readonly<Record<string, number>>): void => {
    list.empty();
    if (s.consent.grants.length === 0) {
      list.createEl("p", { cls: "cx-note", text: c.grantsEmpty });
      return;
    }
    for (const g of s.consent.grants) {
      const used = grantUsed(g, counts[g.id] ?? 0);
      const state = grantState(g, today, used);
      const reads = g.readLimit > 0 ? fill(c.grantReads, { used, limit: g.readLimit }) : fill(c.grantReadsFree, { used });
      const meta = fill(c.grantMeta, { reader: readerLabel(g.reader), spaces: g.spaces.map((x) => spaceLabel(s, x)).join(", "), start: g.start, end: g.end });
      const row = host.row(g.purpose || g.id, `${meta} · ${reads}`);
      row.settingEl?.classList.add(`cx-grant-${state}`);
      row.nameEl?.createSpan({ cls: `cx-chip cx-grant-chip cx-grant-chip-${state}`, text: stateText({ state }), attr: { "data-state": state } });
      if (!g.revoked && state !== "expired") {
        row.addButton((b) =>
          b.setButtonText(c.revoke).onClick(() => {
            let revoked: typeof g | undefined;
            host.set((x) => {
              if (revokeGrant(x.consent, g.id)) revoked = x.consent.grants.find((y) => y.id === g.id);
            });
            host.notify(c.revoked);
            void tell(host, { kind: "grant-revoked", grant: { ...(revoked ?? g), revoked: true } }, s);
            host.refresh();
          }),
        );
      }
    }
  };
  draw({});
  void (async () => {
    try {
      const sv = await host.services();
      if (sv.sandbox.value) return;
      const r = await sv.runner.request({ cmd: "consent.reads", args: {} });
      draw(r.grants);
    } catch {
      // the counts stay as the settings hold them
    }
  })();

  host.heading(c.addHeading);
  const choices = grantChoices(s);
  host.row(c.purposeName).addText((tx) => tx.setValue(draft.purpose).setPlaceholder(c.purposePlaceholder).onChange((v) => void (draft.purpose = v)));
  const readers: Record<string, string> = {};
  for (const id of READER_IDS) readers[id] = readerLabel(id);
  host.row(c.readerName).addDropdown((d) => d.addOptions(readers).setValue(draft.reader).onChange((v) => void (draft.reader = v)));
  if (choices.length === 0) host.mount.createEl("p", { cls: "cx-note", text: c.spacesNoneOpen });
  else {
    host.heading(c.spacesName);
    for (const ch of choices) host.row(ch.label).addToggle((tg) => tg.setValue(draft.spaces.has(ch.id)).onChange((v) => (v ? draft.spaces.add(ch.id) : draft.spaces.delete(ch.id))));
  }
  host.row(c.daysName).addText((tx) => tx.setValue(String(draft.days)).onChange((v) => void (draft.days = Number(v))));
  host.row(c.limitName, c.limitHint).addText((tx) => tx.setValue(String(draft.limit)).onChange((v) => void (draft.limit = Number(v))));
  if (problem !== "") host.mount.createEl("p", { cls: "cx-note cx-note-warn", text: problem });
  host.row(c.create).addButton((b) =>
    b
      .setButtonText(c.create)
      .setCta?.()
      .onClick(() => {
        const made = makeGrant({ purpose: draft.purpose, spaces: [...draft.spaces].filter((x) => choices.some((ch) => ch.id === x)), reader: draft.reader, start: localDayKey(Date.now()), days: draft.days, readLimit: draft.limit }, s.consent.grants, effectiveOpenSpaces(s.consent, s.userSpaces), s.userSpaces);
        if (!made.ok) {
          problem = (c.problems as Readonly<Record<GrantProblem, string>>)[made.problem];
          host.refresh();
          return;
        }
        problem = "";
        draft = { purpose: "", reader: draft.reader, spaces: new Set(), days: draft.days, limit: 0 };
        host.set((x) => void x.consent.grants.push(made.grant));
        host.notify(c.created);
        void tell(host, { kind: "grant-added", grant: made.grant }, s);
        host.refresh();
      }),
  );
}

function openRows(host: SectionHost, s: CortexSettings): void {
  host.heading(c.openHeading, c.openDesc);
  const head = host.row(c.openNothing, c.openNothingDesc);
  mark(head, "open");
  head.addButton((b) =>
    b.setButtonText(c.openNothing).onClick(() => {
      host.set((x) => openNothing(x));
      host.notify(c.nothingOpenNote);
      void tell(host, { kind: "nothing-open" }, s);
      host.refresh();
    }),
  );
  const flip = (name: string, id: string, was: boolean, apply: (x: CortexSettings, on: boolean) => void): void => {
    host.row(name, was ? c.openState.open : c.openState.closed).addToggle((tg) =>
      tg.setValue(was).onChange((v) => {
        host.set((x) => apply(x, v));
        host.notify(fill(v ? c.openedNote : c.closedNote, { name }));
        void tell(host, v ? { kind: "spaces-opened", spaces: [id] } : { kind: "spaces-closed", spaces: [id] }, s);
        host.refresh();
      }),
    );
  };
  host.heading(c.openAreas);
  for (const a of AREAS) flip(a.name, a.id, s.consent.openSpaces.includes(a.id), (x, on) => setAreaOpen(x, a.id, on));
  if (s.userSpaces.length > 0) {
    host.heading(c.openYours);
    for (const sp of s.userSpaces) flip(sp.name, sp.id, sp.open || s.consent.openSpaces.includes(sp.id), (x, on) => setUserSpaceOpen(x, sp.id, on));
  }
  host.heading(c.openFolders, c.openFoldersDesc);
  const known = new Set([...AREAS.map((a) => a.id), ...s.userSpaces.map((u) => u.id)]);
  for (const f of s.consent.openSpaces.filter((x) => !known.has(x))) {
    host.row(f).addExtraButton((b) =>
      b.setIcon?.("x")?.setTooltip?.(c.closedNote.replace("{name}", f))?.onClick(() => {
        host.set((x) => closeFolder(x, f));
        void tell(host, { kind: "spaces-closed", spaces: [f] }, s);
        host.refresh();
      }),
    );
  }
  let folder = "";
  host.row(c.openFolderAdd).addText((tx) => tx.setPlaceholder(c.openFolderPlaceholder).onChange((v) => void (folder = v)));
  host.row(c.openFolderAdd).addButton((b) =>
    b.setButtonText(c.openFolderAdd).onClick(() => {
      let done = "";
      host.set((x) => void (done = openFolder(x, folder)));
      const clean = normaliseFolder(folder);
      if (clean === "") return;
      host.notify(fill(c.openedNote, { name: clean }));
      void tell(host, { kind: "spaces-opened", spaces: [clean] }, s);
      void done;
      host.refresh();
    }),
  );
}

function limitRows(host: SectionHost, s: CortexSettings): void {
  const lim = s.consent.itemReadLimit;
  const row = host.row(c.limitRowName, c.limitRowDesc);
  mark(row, "limit");
  row.addToggle((tg) =>
    tg.setValue(lim.enabled).onChange((v) => {
      host.set((x) => void (x.consent.itemReadLimit.enabled = v));
      void tell(host, { kind: "read-limit", on: v, max: lim.max }, s);
      host.refresh();
    }),
  );
  if (lim.enabled) host.slider(c.limitMaxName, undefined, [1, 20], 1, lim.max, (x, v) => void (x.consent.itemReadLimit.max = v));
}

// ───────────────────────────── Who can read this ─────────────────────────────

/** What the summary needs from the record, read once per draw. */
export interface WhoFacts {
  path: string;
  sample: boolean;
  readers: { model: string; route: string; itemsRead: number; last: string }[];
  /** The newest read that went to a route other than this computer. */
  leftAt: { at: string; route: string } | null;
}

export const isLocalRoute = (route: string): boolean => route === "local" || route === "this computer" || route === "rules";

/** The lines of the summary, each with the control it points to. Pure on settings and facts. */
export function whoLines(s: CortexSettings, f: WhoFacts, today: string = localDayKey(Date.now())): { id: string; head: string; text: string; go: { label: string; ctl?: string; tab?: string } }[] {
  const out: { id: string; head: string; text: string; go: { label: string; ctl?: string; tab?: string } }[] = [];
  out.push({ id: "where", head: c.whoWhere, text: f.sample ? c.whoRecordSample : fill(c.whoRecord, { path: f.path }), go: { label: c.whoSyncGo, tab: "sync" } });
  out.push({ id: "enc", head: c.whoEnc, text: s.record.encryption.enabled ? c.whoEncOn : c.whoEncOff, go: { label: c.whoEncGo, tab: "lock" } });
  const top = f.readers.slice(0, 3);
  const readerText = top.length === 0 ? c.whoReadersNone : top.map((r) => fill(c.whoReaderRow, { model: r.model, route: r.route === "local" || r.route === "this computer" ? COPY.agents.routeLocal : r.route === "remote" || r.route === "claude-cli" ? COPY.agents.routeAnthropic : r.route, n: r.itemsRead, when: r.last.slice(0, 10) })).join(" ") + (f.readers.length > top.length ? ` ${fill(c.whoReadersMore, { n: f.readers.length - top.length })}` : "");
  out.push({ id: "readers", head: c.whoReaders, text: readerText, go: { label: c.whoGo, tab: "agents" } });
  const holders = s.record.shares.holders.length;
  const heir = s.record.heir.name.trim();
  out.push({
    id: "holders",
    head: c.whoHolders,
    text: `${holders === 0 ? c.whoHoldersNone : fill(c.whoHoldersSome, { n: holders, k: s.record.shares.threshold })} ${heir === "" ? c.whoHeirNone : fill(c.whoHeir, { name: heir })}`,
    go: { label: c.whoHoldersGo, tab: "lock" },
  });
  const n = s.consent.grants.filter((g) => grantState(g, today, g.reads) === "live").length;
  out.push({ id: "grants", head: c.whoGrants, text: s.consent.requireGrant ? fill(c.whoGrantsOn, { n }) : c.whoGrantsOff, go: { label: c.whoGo, ctl: "grants" } });
  const names = openNames(s);
  out.push({ id: "open", head: c.whoOpen, text: names.length === 0 ? c.whoOpenNone : fill(c.whoOpenSome, { n: names.length, names: names.slice(0, 6).join(", ") }), go: { label: c.whoGo, ctl: "open" } });
  out.push({ id: "left", head: c.whoLeft, text: f.leftAt ? fill(c.whoLeftLast, { when: f.leftAt.at.slice(0, 10), route: f.leftAt.route === "remote" || f.leftAt.route === "claude-cli" ? COPY.agents.routeAnthropic : f.leftAt.route }) : c.whoLeftNever, go: { label: c.whoGo, ctl: "limit" } });
  return out;
}

async function loadFacts(host: SectionHost): Promise<WhoFacts> {
  const sv = await host.services();
  const rows = sv.sandbox.value ? [] : await sv.ledger.accessLog().catch(() => []);
  const away = rows.filter((r) => !isLocalRoute(r.route)).sort((a, b) => (a.last < b.last ? 1 : -1))[0];
  return { path: sv.vaultRoot, sample: sv.sandbox.value, readers: rows.map((r) => ({ model: r.model, route: r.route, itemsRead: r.itemsRead, last: r.last })), leftAt: away ? { at: away.last, route: away.route } : null };
}

/** "Who can read this", drawn by the tab at the top of Privacy. */
export function whoRender(host: SectionHost, s: CortexSettings): void {
  host.heading(c.whoHeading, c.whoDesc);
  const box = host.mount.createDiv({ cls: "cx-who" });
  const draw = (f: WhoFacts): void => {
    box.empty();
    for (const l of whoLines(s, f)) {
      const row = box.createDiv({ cls: "cx-who-row", attr: { "data-who": l.id } });
      row.createEl("strong", { text: l.head });
      row.createSpan({ text: ` ${l.text}` });
      const go = l.go;
      row.createEl("button", { cls: "cx-text-button", text: go.label }).addEventListener("click", () => {
        if (go.tab && host.goTo) host.goTo(go.tab);
        else if (go.ctl) goTo(host, go.ctl);
      });
    }
  };
  draw({ path: "", sample: true, readers: [], leftAt: null });
  void loadFacts(host).then(draw, () => undefined);
}

export const privacyRows: readonly SectionRow[] = [
  { id: "privacy-grants", section: "privacy", order: 10, render: grantsRows },
  { id: "privacy-open", section: "privacy", order: 20, render: openRows },
  { id: "privacy-limit", section: "privacy", order: 30, render: limitRows },
];


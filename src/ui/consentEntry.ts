/**
 * The record's account of a consent change, as text: the title and body of the dated entry that says what changed (a grant
 * made or revoked, a space opened or closed, the grant rule or the read limit switched, an item's read count reset). The
 * entries hold the purpose, the names of spaces and dates, never record text. plugin/consentRecord.ts writes them.
 */
import type { ConsentChange } from "../shared/consent";
import { NO_AREA, SPACES } from "../shared/spaces";
import { localDayKey } from "../shared/time";
import { COPY, t } from "./copy";

export interface ConsentEntryText {
  title: string;
  body: string;
}

const readerName = (id: string): string => (COPY.consent.readerNames as Readonly<Record<string, string>>)[id] ?? id;
/** A space id as a name: an area's own name, else the id (a space of yours or a folder path; the caller may know better). */
export function defaultSpaceLabel(id: string): string {
  return [...SPACES, NO_AREA].find((s) => s.id === id)?.name ?? id;
}

/** The entry that says what changed, dated `date` (yyyy-mm-dd). */
export function consentEntry(change: ConsentChange, date: string = localDayKey(Date.now()), label: (id: string) => string = defaultSpaceLabel): ConsentEntryText {
  const list = (xs: readonly string[]): string => xs.map(label).join(", ");
  const state = (on: boolean): string => (on ? COPY.consent.on : COPY.consent.off);
  switch (change.kind) {
    case "grant-added": {
      const g = change.grant;
      const v = { date, purpose: g.purpose, reader: readerName(g.reader), spaces: list(g.spaces), start: g.start, end: g.end, limit: g.readLimit > 0 ? String(g.readLimit) : COPY.consent.unlimited };
      return { title: t("consent.changeGrantAddedTitle", v), body: t("consent.changeGrantAdded", v) };
    }
    case "grant-revoked": {
      const g = change.grant;
      const v = { date, purpose: g.purpose, reader: readerName(g.reader), start: g.start, end: g.end };
      return { title: t("consent.changeGrantRevokedTitle", v), body: t("consent.changeGrantRevoked", v) };
    }
    case "spaces-opened":
      return { title: t("consent.changeOpenedTitle", { names: list(change.spaces) }), body: t("consent.changeOpened", { date, names: list(change.spaces) }) };
    case "spaces-closed":
      return { title: t("consent.changeClosedTitle", { names: list(change.spaces) }), body: t("consent.changeClosed", { date, names: list(change.spaces) }) };
    case "nothing-open":
      return { title: t("consent.changeNothingTitle"), body: t("consent.changeNothing", { date }) };
    case "require-grant":
      return { title: t("consent.changeRequireTitle", { state: state(change.on) }), body: t("consent.changeRequire", { date, state: state(change.on) }) };
    case "read-limit":
      return { title: t("consent.changeLimitTitle", { state: state(change.on) }), body: t("consent.changeLimit", { date, state: state(change.on), max: change.max }) };
    case "item-reset":
      // No record id in the entry: the count of one item was reset, which the settings keep.
      return { title: t("consent.changeResetTitle"), body: t("consent.changeReset", { date }) };
  }
}


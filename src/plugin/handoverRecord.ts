/**
 * The dated entries that record who holds a key share and who the heir is. They go into the record the normal way (a written
 * entry, then the seal run), so the day they were made stands. They hold names, a day, a check code and a fingerprint of the
 * full designation. They never hold a share, the key, a contact detail, an instruction or the letter: the entry is plain text
 * under `.raw/written/`, and a fingerprint lets the owner prove later what the full designation said without printing it.
 */
import { sha256Hex } from "../shared/sha256";
import { t } from "../ui/copy";

export interface RecordedEntry {
  title: string;
  body: string;
}

/** The fingerprint of a designation: SHA-256 of its fields in a fixed order, with the field names, so no two designations collide by shifting text. */
export function designationFingerprint(fields: Readonly<Record<string, string | number | readonly string[]>>): string {
  const keys = Object.keys(fields).sort();
  const text = keys.map((k) => `${k}=${JSON.stringify(fields[k])}`).join("\n");
  return sha256Hex(`cortex-designation 1\n${text}`);
}

export interface HolderEntryInput {
  name: string;
  contact: string;
  instructions: string;
  share: number;
  total: number;
  threshold: number;
  checksum: string;
  keyId: string;
  date: string;
}

export function holderEntry(i: HolderEntryInput): RecordedEntry {
  const fp = designationFingerprint({ kind: "holder", name: i.name, contact: i.contact, instructions: i.instructions, share: i.share, checksum: i.checksum, date: i.date });
  const v = { name: i.name, date: i.date, x: i.share, n: i.total, k: i.threshold, code: i.checksum, id: i.keyId, fp };
  return {
    title: t("handover.entryHolderTitle", v),
    body: [t("handover.entryHolder1", v), t("handover.entryHolder2", v), t("handover.entryHolder3", v), t("handover.entryHolder4", v)].join("\n\n"),
  };
}

export interface HeirEntryInput {
  name: string;
  contact: string;
  /** Area names; empty = every area. */
  spaces: readonly string[];
  letter: string;
  threshold: number;
  date: string;
  /** Set when the entry also notes a bundle built that day. */
  bundle?: boolean;
}

export function heirEntry(i: HeirEntryInput): RecordedEntry {
  const fp = designationFingerprint({ kind: "heir", name: i.name, contact: i.contact, spaces: [...i.spaces].sort(), letter: i.letter, date: i.date });
  const v = { name: i.name, date: i.date, spaces: i.spaces.length > 0 ? i.spaces.join(", ") : t("handover.entryAllAreas"), k: i.threshold, fp };
  const parts = [t("handover.entryHeir1", v), t("handover.entryHeir2", v), t("handover.entryHeir3", v)];
  if (i.bundle) parts.push(t("handover.entryHeirBundle", v));
  return { title: t("handover.entryHeirTitle", v), body: parts.join("\n\n") };
}

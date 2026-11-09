/**
 * Vault `type` frontmatter → note kind (H7). Owner: E7. Pure.
 * Vaults use many `type` values; most are topics (gardening, finance …) and map to the
 * plain "wiki" kind. Only types that say what a note IS map to a specific kind. `status: reference` overrides
 * everything (ItemFlag.Reference + kind "reference").
 */
import type { NoteKind } from "./types";

export const VAULT_TYPE_KIND: Readonly<Record<string, NoteKind>> = {
  moc: "hub",
  "roblox-api": "reference",
  "roblox-doc": "reference",
  concept: "concept",
  decision: "decision",
  session: "log",
  meta: "log",
  source: "reference",
};

export function vaultNoteKind(type: unknown, status: unknown): NoteKind {
  if (status === "reference") return "reference";
  if (typeof type !== "string") return "wiki";
  return VAULT_TYPE_KIND[type.toLowerCase()] ?? "wiki";
}

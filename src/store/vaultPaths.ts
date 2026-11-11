/**
 * Vault-relative path of a vault note from its id. Vault note ids are a hash of the path, so the path can only be
 * found by hashing the vault's markdown files; the index keeps the title and folder, and a note whose title differs
 * from its file name (frontmatter title, "hot.md" shown as "Hot Cache") cannot be guessed from them.
 * The id → path table is built on first use and rebuilt when the number of files changes.
 */
import { wikiNoteId } from "../shared/ids";

export function createVaultPathResolver(listPaths: () => readonly string[]): (id: string) => string | undefined {
  let table = new Map<string, string>();
  let built = -1;
  return (id) => {
    const paths = listPaths();
    if (paths.length !== built) {
      table = new Map();
      for (const p of paths) table.set(wikiNoteId(p), p);
      built = paths.length;
    }
    return table.get(id);
  };
}

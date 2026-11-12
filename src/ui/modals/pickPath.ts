/**
 * Choosing files and folders for Add sources (CORTEX-UX §5.26). Owner: E3.
 * Order of preference: a dropped File (Electron 39: `webUtils.getPathForFile(file)`, since File.path was removed),
 * the system dialog through `require("electron").remote` when this Obsidian build still exposes it (feature-
 * detected, never assumed), then a typed absolute path ("Or type a path"). Every result is an absolute local path
 * that the runner re-validates; nothing here reads the file.
 */

export type PickKind = "zip-or-folder" | "folder" | "resume";

interface ElectronLike {
  webUtils?: { getPathForFile?(f: File): string };
  remote?: { dialog?: { showOpenDialog?(opts: { properties: string[]; filters?: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePaths: string[] }> } };
}

function electron(): ElectronLike | null {
  try {
    const req = (globalThis as { require?: (m: string) => unknown }).require;
    return req ? (req("electron") as ElectronLike) : null;
  } catch {
    return null;
  }
}

/** Absolute path of a dropped file, or null when this runtime can't tell. */
export function pathOfDroppedFile(f: File): string | null {
  const p = electron()?.webUtils?.getPathForFile?.(f);
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** The system open dialog when available; null when the user cancelled or the dialog API isn't exposed. */
export async function showOpenDialog(kind: PickKind): Promise<string | null> {
  const dialog = electron()?.remote?.dialog;
  if (!dialog?.showOpenDialog) return null;
  const r = await dialog.showOpenDialog(
    kind === "folder"
      ? { properties: ["openDirectory"] }
      : kind === "resume"
        ? { properties: ["openFile"], filters: [{ name: "Resume", extensions: ["pdf", "docx", "txt", "md"] }] }
        : { properties: ["openFile", "openDirectory"], filters: [{ name: "Exports", extensions: ["zip", "json"] }] },
  );
  return r.canceled ? null : (r.filePaths[0] ?? null);
}

/** A typed path is accepted only when absolute (drive letter or UNC on Windows, "/" elsewhere). */
export function isAbsoluteTypedPath(p: string): boolean {
  const s = p.trim();
  return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\[^\\]+\\[^\\]+/.test(s) || s.startsWith("/");
}

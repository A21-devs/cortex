/**
 * Cortex Desktop's menu bar (the Windows counterpart of an app menu): a pure description, no Electron, so a test can
 * check it. main.ts turns it into an Electron menu. Four kinds of entry:
 *   command   runs the Cortex command `cortex:<id>` in the page (the same ids as the palette and the More menu)
 *   role      an Electron role (clipboard, zoom, window)
 *   action    something only the window can do (full screen, reload, developer tools, quit)
 *   submenu / separator
 * Every label comes from ui/copy.ts (`desktopMenu`). Mac-only entries (Services, Hide Others) have no place here.
 */
import { t, type CopyKey } from "../ui/copy";
import type { CommandId } from "../plugin/commands";

export type MenuAction = "quit" | "full-screen" | "reload" | "devtools";

export type MenuNode =
  | { kind: "command"; id: CommandId; label: string; accelerator?: string }
  | { kind: "role"; role: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll" | "zoomIn" | "zoomOut" | "resetZoom" | "minimize" | "close"; label: string; accelerator?: string }
  | { kind: "action"; action: MenuAction; label: string; accelerator?: string }
  | { kind: "separator" }
  | { kind: "submenu"; label: string; items: MenuNode[] };

const SEP: MenuNode = { kind: "separator" };

const label = (key: CopyKey): string => t(key);

/** The whole menu bar: Cortex, File, Edit, View, Window, Help. */
export function desktopMenu(): MenuNode[] {
  return [
    {
      kind: "submenu",
      label: label("desktopMenu.app"),
      items: [
        { kind: "command", id: "about", label: label("desktopMenu.about") },
        { kind: "command", id: "check-updates", label: label("desktopMenu.checkUpdates") },
        SEP,
        { kind: "command", id: "open-settings", label: label("desktopMenu.settings"), accelerator: "CmdOrCtrl+," },
        { kind: "command", id: "setup-agents", label: label("desktopMenu.setupAgents") },
        {
          kind: "submenu",
          label: label("desktopMenu.connect"),
          items: [
            { kind: "command", id: "connect-agent", label: label("desktopMenu.connectClaude") },
            { kind: "command", id: "open-agents", label: label("desktopMenu.connectOthers") },
          ],
        },
        { kind: "command", id: "show-agreement", label: label("desktopMenu.consent") },
        SEP,
        { kind: "command", id: "lock", label: label("desktopMenu.lock"), accelerator: "CmdOrCtrl+L" },
        SEP,
        { kind: "action", action: "quit", label: label("desktopMenu.quit"), accelerator: "CmdOrCtrl+Q" },
      ],
    },
    {
      kind: "submenu",
      label: label("desktopMenu.file"),
      items: [
        { kind: "command", id: "new-entry", label: label("desktopMenu.newEntry") },
        { kind: "command", id: "add-sources", label: label("desktopMenu.addSources") },
        SEP,
        { kind: "command", id: "save-image", label: label("desktopMenu.saveImage") },
        { kind: "command", id: "export-ledger", label: label("desktopMenu.exportLedger") },
      ],
    },
    {
      kind: "submenu",
      label: label("desktopMenu.edit"),
      items: [
        { kind: "role", role: "undo", label: label("desktopMenu.undo"), accelerator: "CmdOrCtrl+Z" },
        { kind: "role", role: "redo", label: label("desktopMenu.redo"), accelerator: "CmdOrCtrl+Shift+Z" },
        SEP,
        { kind: "role", role: "cut", label: label("desktopMenu.cut"), accelerator: "CmdOrCtrl+X" },
        { kind: "role", role: "copy", label: label("desktopMenu.copy"), accelerator: "CmdOrCtrl+C" },
        { kind: "role", role: "paste", label: label("desktopMenu.paste"), accelerator: "CmdOrCtrl+V" },
        { kind: "role", role: "selectAll", label: label("desktopMenu.selectAll"), accelerator: "CmdOrCtrl+A" },
      ],
    },
    {
      kind: "submenu",
      label: label("desktopMenu.view"),
      items: [
        { kind: "role", role: "zoomIn", label: label("desktopMenu.zoomIn"), accelerator: "CmdOrCtrl+=" },
        { kind: "role", role: "zoomOut", label: label("desktopMenu.zoomOut"), accelerator: "CmdOrCtrl+-" },
        { kind: "role", role: "resetZoom", label: label("desktopMenu.zoomReset"), accelerator: "CmdOrCtrl+0" },
        SEP,
        { kind: "action", action: "full-screen", label: label("desktopMenu.fullScreen"), accelerator: "F11" },
        { kind: "command", id: "toggle-immersive", label: label("desktopMenu.immersive") },
        { kind: "command", id: "showcase", label: label("desktopMenu.showcase") },
        SEP,
        { kind: "action", action: "reload", label: label("desktopMenu.reload"), accelerator: "CmdOrCtrl+R" },
        { kind: "action", action: "devtools", label: label("desktopMenu.devTools"), accelerator: "CmdOrCtrl+Shift+I" },
      ],
    },
    {
      kind: "submenu",
      label: label("desktopMenu.window"),
      items: [
        { kind: "role", role: "minimize", label: label("desktopMenu.minimise") },
        { kind: "role", role: "close", label: label("desktopMenu.close"), accelerator: "CmdOrCtrl+W" },
      ],
    },
    {
      kind: "submenu",
      label: label("desktopMenu.help"),
      items: [
        { kind: "command", id: "open-guide", label: label("desktopMenu.guide") },
        { kind: "command", id: "start-tour", label: label("desktopMenu.walkthrough") },
      ],
    },
  ];
}

/** Every Cortex command id the menu can run (main.ts only forwards these to the page). */
export function menuCommandIds(nodes: readonly MenuNode[] = desktopMenu()): CommandId[] {
  const out: CommandId[] = [];
  for (const n of nodes) {
    if (n.kind === "command") out.push(n.id);
    else if (n.kind === "submenu") out.push(...menuCommandIds(n.items));
  }
  return out;
}

/**
 * The notes and agent sources in the app: Sources rows and their watch switches, the Add to your record sheet
 * (Notion and Google Docs rows, drops routed to them, the opt-in agent rows), the settings, the clock's selectors,
 * the CLI flags and the reader's labels. Synthetic data in temp folders; no network, no model.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportSourceOf } from "../src/shared/exportDue";
import { createSourcesService } from "../src/plugin/sourcesService";
import { importSelectors } from "../src/plugin/container";
import { parseSourceFlag } from "../src/runner/cli";
import { applyLiveCapture, liveCaptureAvailable, liveCaptureOn } from "../src/shared/settingsTabs";
import { DEFAULT_SETTINGS, migrateSettings, type CortexSettings } from "../src/shared/settings";
import { SOURCE_KINDS } from "../src/shared/types";
import { SOURCE_ORDER } from "../src/shared/index-format";
import { nullLogger } from "../src/shared/log";
import { updateSourceManifest } from "../src/store/manifest";
import { openStoreContext } from "../src/store/layout";
import { EXPORT_SOURCE_COPY } from "../src/ui/copy";
import { sourceLabel } from "../src/ui/valueLabels";
import { selectorFor } from "../src/ui/pages/Sources";
import { tmpDir } from "./helpers/importHarness";

const clone = (): CortexSettings => structuredClone(DEFAULT_SETTINGS) as CortexSettings;

describe("settings and kinds", () => {
  it("keep the new sources off or inert until chosen, and survive a round trip", () => {
    const s = clone();
    expect(s.sources.codexCli.enabled || s.sources.geminiCli.enabled || s.sources.cursor.enabled).toBe(false);
    s.sources.codexCli.enabled = true;
    s.sources.cursor.dir = "C:/somewhere";
    const back = migrateSettings(JSON.parse(JSON.stringify(s)) as unknown);
    expect(back.sources.codexCli.enabled).toBe(true);
    expect(back.sources.cursor.dir).toBe("C:/somewhere");
    // An older settings file without the keys reads as the defaults.
    const older = JSON.parse(JSON.stringify(s)) as { sources: Record<string, unknown> };
    delete older.sources.codexCli;
    delete older.sources.notion;
    const migrated = migrateSettings(older);
    expect(migrated.sources.codexCli.enabled).toBe(false);
    expect(migrated.sources.notion.enabled).toBe(true);
  });
  it("append the kinds to the persisted source order, in the same order as the list of kinds", () => {
    expect(SOURCE_ORDER.slice(0, 8)).toEqual(["claude-code", "claude-ai", "chatgpt", "gemini", "obsidian", "files", "written", "cortex-ask"]);
    expect(SOURCE_ORDER.slice(8, 13)).toEqual(["notion", "google-docs", "codex-cli", "gemini-cli", "cursor"]);
    expect([...SOURCE_KINDS]).toEqual([...SOURCE_ORDER]);
    expect(sourceLabel("codex-cli")).toBe("Codex CLI");
    expect(sourceLabel("google-docs")).toBe("Google Docs");
  });
  it("name the export pages and wording for the two archive sources", () => {
    expect(exportSourceOf("notion")?.exportUrl.startsWith("https://")).toBe(true);
    expect(exportSourceOf("google-docs")?.exportUrl).toBe("https://takeout.google.com/");
    expect(EXPORT_SOURCE_COPY.notion?.how).toMatch(/Markdown/);
    expect(EXPORT_SOURCE_COPY["google-docs"]?.how).toMatch(/Drive/);
  });
});

describe("the clock and the live switch", () => {
  it("add an agent to a pass only when it is on, and watch it with the live switch", () => {
    const s = clone();
    expect(importSelectors(s, "watch").map((x) => x.kind)).toEqual(["claude-code"]);
    s.sources.codexCli.enabled = true;
    s.sources.cursor.enabled = true;
    expect(importSelectors(s, "watch").map((x) => x.kind)).toEqual(["claude-code", "codex-cli", "cursor"]);
    expect(importSelectors(s, "seal").map((x) => x.kind)).toContain("cursor");
    s.sources.claudeCode.enabled = false;
    expect(liveCaptureAvailable(s)).toBe(true);
    expect(liveCaptureOn(s)).toBe(true);
    applyLiveCapture(s, false);
    expect(s.sources.codexCli.watch).toBe(false);
    expect(s.sources.geminiCli.watch).toBe(true); // off sources are left alone
    expect(liveCaptureOn(s)).toBe(false);
  });
  it("parse the CLI flags", () => {
    expect(parseSourceFlag("codex-cli")).toEqual({ kind: "codex-cli" });
    expect(parseSourceFlag("cursor")).toEqual({ kind: "cursor" });
    expect(parseSourceFlag("notion=C:/x/export.zip")).toEqual({ kind: "notion", file: "C:/x/export.zip" });
    expect(parseSourceFlag("google-docs")).toBeUndefined();
    expect(selectorFor({ id: "gemini-cli", kind: "gemini-cli" })).toEqual({ kind: "gemini-cli" });
    expect(selectorFor({ id: "notion", kind: "notion" })).toBeNull();
  });
});

describe("Sources rows and their watch switches", () => {
  async function service() {
    const vault = await tmpDir();
    const cache = await tmpDir();
    const store = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
    const settings = clone();
    const excluded: string[] = [];
    const svc = createSourcesService({
      app: { vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => null } } as never,
      vaultRoot: vault,
      cacheDir: cache,
      log: nullLogger,
      settings: { value: settings, signal: undefined as never, corrupt: false, issues: [], update: async (fn: (s: CortexSettings) => void) => fn(settings), reload: async () => undefined, useDefaults: async () => undefined } as never,
      runner: { request: (async () => ({ sources: [], conversations: 0, notes: 0, tokens: 0 })) as never },
      corrections: { exclude: (async (id: string) => void excluded.push(id)) as never },
      sandbox: () => false,
    });
    return { svc, settings, store, excluded };
  }
  it("lists an agent only once it is on, with a watch switch, and a notes export once it has imported", async () => {
    const { svc, settings, store, excluded } = await service();
    expect((await svc.list()).map((r) => r.id)).not.toContain("codex-cli");
    expect((await svc.list()).map((r) => r.id)).not.toContain("notion");
    settings.sources.codexCli.enabled = true;
    let row = (await svc.list()).find((r) => r.id === "codex-cli");
    expect(row).toMatchObject({ kind: "codex-cli", status: "watching", watching: true, storedIn: ".raw/chats/codex-cli/" });
    await svc.pauseWatching("codex-cli", true);
    expect(settings.sources.codexCli.watch).toBe(false);
    row = (await svc.list()).find((r) => r.id === "codex-cli");
    expect(row).toMatchObject({ status: "connected", watching: false });
    await updateSourceManifest(store, "notion", { kind: "notion", path: "C:/x/export.zip", bytes: 5, importedAt: new Date().toISOString(), entries: 42, conversations: 0, status: "imported" });
    const notion = (await svc.list()).find((r) => r.id === "notion");
    expect(notion).toMatchObject({ kind: "notion", status: "imported", items: 42, watching: false });
    await svc.remove("codex-cli");
    expect(settings.sources.codexCli).toMatchObject({ enabled: false, watch: false });
    await svc.remove("notion");
    expect(settings.sources.notion.enabled).toBe(false);
    expect(excluded).toEqual(["codex-cli", "notion"]);
  });
});

// ───────────────────────────── the sheet ─────────────────────────────

describe("Add to your record sheet: notes exports and coding agents", () => {
  afterEach(() => vi.unstubAllGlobals());
  interface Node {
    tag?: string;
    text?: string;
    children?: Node[];
    listeners: Map<string, ((e?: unknown) => void)[]>;
    allText(): string[];
  }
  const all = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(all)];
  async function build(inspect: (file: string) => unknown) {
    const { AddSourcesModal } = await import("../src/ui/modals/AddSourcesModal");
    const settings = clone();
    const importNow = vi.fn(async () => undefined);
    const services = {
      settings: { value: settings, update: async (fn: (s: CortexSettings) => void) => fn(settings) },
      sandbox: { value: false },
      sources: {
        list: async () => [],
        estimate: async () => ({ sources: [], conversations: 0, notes: 0, tokens: 0 }),
        needsAttention: async () => [],
        inspect: async (file: string) => inspect(file),
        importNow,
        pauseWatching: async () => undefined,
      },
    };
    const modal = new AddSourcesModal({} as never, services as never);
    (modal as unknown as { open(): void }).open();
    await new Promise((r) => setTimeout(r, 20));
    return { modal, settings, importNow, content: (modal as unknown as { contentEl: Node }).contentEl };
  }
  const NOTION = { kind: "notion", conversations: 4, projects: 2, attachments: 0, alreadyImported: 0 };

  it("lists Notion and Google Docs with a how-to and Request an export, and the three agents with their wording", async () => {
    const { modal, content } = await build(() => NOTION);
    const text = content.allText().join("\n");
    for (const s of ["Notion", "Google Docs", EXPORT_SOURCE_COPY.notion?.how, EXPORT_SOURCE_COPY["google-docs"]?.how, "Other coding agents", "Codex CLI", "Gemini CLI", "Cursor", "Off until you turn one on", "Read these sessions", "Keep watching"]) expect(text).toContain(s as string);
    (modal as unknown as { close(): void }).close();
  });

  it("routes a dropped Notion export to its row, previews it and imports with a notion selector", async () => {
    const { modal, content, importNow } = await build(() => NOTION);
    await (modal as unknown as { route(f: string): Promise<void> }).route("C:/x/export.zip");
    await new Promise((r) => setTimeout(r, 20));
    expect(content.allText().join("\n")).toContain("4 items found in this export");
    const go = all(content).find((n) => n.tag === "button" && n.text === "Import");
    expect(go).toBeDefined();
    go?.listeners.get("click")?.[0]?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(importNow).toHaveBeenCalledWith({ kind: "notion", file: "C:/x/export.zip" }, undefined);
    (modal as unknown as { close(): void }).close();
  });

  it("says it cannot tell when a drop is none of them", async () => {
    const { modal, content } = await build(() => ({ kind: "unknown", conversations: 0, projects: 0, attachments: 0, alreadyImported: 0, problem: "export-not-recognised" }));
    await (modal as unknown as { route(f: string): Promise<void> }).route("C:/x/other.zip");
    await new Promise((r) => setTimeout(r, 20));
    expect(content.allText().join("\n")).toContain("couldn't tell which service");
    (modal as unknown as { close(): void }).close();
  });

  it("turns an agent on and reads it only when asked, never before", async () => {
    const { modal, content, settings, importNow } = await build(() => NOTION);
    expect(settings.sources.codexCli.enabled).toBe(false);
    expect(importNow).not.toHaveBeenCalled();
    const buttons = all(content).filter((n) => n.tag === "button" && n.text === "Read now");
    expect(buttons).toHaveLength(3);
    buttons[0]?.listeners.get("click")?.[0]?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(settings.sources.codexCli.enabled).toBe(true);
    expect(settings.sources.geminiCli.enabled).toBe(false);
    expect(importNow).toHaveBeenCalledWith({ kind: "codex-cli" }, undefined);
    (modal as unknown as { close(): void }).close();
  });
});

describe("nothing in the new sources reaches a network", () => {
  it("has no network calls in the importers", async () => {
    const dir = path.join(__dirname, "..", "src", "importers");
    const files = ["agentSessions.ts", "codexCli.ts", "geminiCli.ts", "cursor.ts", "notion.ts", "docx.ts", "exportDocs.ts"];
    for (const f of files) {
      const src = await fsp.readFile(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/\bfetch\(|node:https?|XMLHttpRequest|WebSocket|node:net\b/);
    }
  });
});

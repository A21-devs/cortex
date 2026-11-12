// Types for scripts/build-config.mjs (used by tests/build.test.ts).
import type { BuildOptions } from "esbuild";

export declare const nodeBuiltins: string[];
export declare const obsidianExternals: string[];
export declare const BUNDLED: { name: string; licence: string }[];
export declare const BUDGET: { mainBytes: number; runnerBytes: number; workerBytes: number; eagerBytes: number };
export declare function buildId(version: string, now?: Date): string;
export declare function workerOptions(root: string, o?: { dev?: boolean }): BuildOptions;
export declare function mainOptions(root: string, o?: { dev?: boolean; lazyCode?: string; version?: string; build?: string; outdir?: string }): BuildOptions;
export declare function packLazy(code: string): string;
export declare const SHARED_COPY_ID: string;
export declare function sharedCopyPlugin(root: string): import("esbuild").Plugin;
export declare function lazyOptions(root: string, o?: { dev?: boolean; workerCode?: string; version?: string; build?: string }): BuildOptions;
export declare function runnerOptions(root: string, o?: { dev?: boolean; version?: string; build?: string }): BuildOptions;
export declare function liftSpecificity(css: string): string;
export declare function cssOptions(root: string, o?: { dev?: boolean }): BuildOptions;
export declare function noticesText(version: string): string;
export declare const DESKTOP_BUNDLED: { name: string; licence: string }[];
export declare function obsidianShimPlugin(root: string): import("esbuild").Plugin;
export declare function desktopRendererOptions(root: string, o?: { dev?: boolean; workerCode?: string; version?: string; build?: string; outdir?: string }): BuildOptions;
export declare function desktopMainOptions(root: string, o?: { dev?: boolean; version?: string; build?: string; outdir?: string }): BuildOptions;

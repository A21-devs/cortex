// Types for scripts/scale-gen.mjs (used by tests/scale-pipeline.test.ts).
export interface ScaleGenOptions {
  notes?: number;
  rawDocs?: number;
  bigNotes?: number;
  bigBytes?: number;
  sessions?: number;
  bigSessions?: number;
  bigSessionBytes?: number;
  conversations?: number;
  seed?: number;
  log?: (s: string) => void;
}
export interface ScaleGenResult {
  vault: string;
  projects: string;
  zip: string;
  files: { notes: string[]; raw: string[] };
  spaceMap: Record<string, string>;
  liveSession: string;
  genMs: number;
}
export declare function rng(seed: number): { rand: () => number; int: (n: number) => number; pick: <T>(a: readonly T[]) => T };
export declare function generate(root: string, opts?: ScaleGenOptions): ScaleGenResult;

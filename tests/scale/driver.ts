/** Entry point bundled by scripts/scale.mjs: runs the pipeline against a generated vault and prints JSON lines. */
import { readFileSync } from "node:fs";
import { runPipeline } from "./pipeline";

async function main(): Promise<void> {
  const [vault, zip, touchFile, grow] = process.argv.slice(2);
  if (!vault || !zip) throw new Error("usage: driver <vault> <zip> [touch-json-file] [session-file]");
  const touch = touchFile ? (JSON.parse(readFileSync(touchFile, "utf8")) as string[]) : [];
  const res = await runPipeline({ vault, zip, touch, ...(grow ? { grow } : {}), onStage: (s) => console.log(`STAGE ${JSON.stringify(s)}`) });
  console.log(`DONE ${JSON.stringify({ index: res.index, cache: res.cache, peakMb: Math.round(process.resourceUsage().maxRSS / 1024) })}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});

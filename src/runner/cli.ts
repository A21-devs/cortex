/**
 * Command-line parsing for `node cortex-runner.js <command> [--flags]` (Claude Code skill + terminal).
 * Owner: E5.
 *
 *   serve                                  stdio protocol mode (used by the plugin)
 *   doctor [--live]                        environment checks (--live sends one tiny prompt; costs tokens)
 *   import [--source claude-code|raw|written|claude-ai=<file>|chatgpt=<file>|gemini=<file>|folder=<id>]…
 *   index [--full]                         rebuild <cache>/record.cxi
 *   search [--full]                        rebuild <cache>/search.cxs
 *   agents run [--job label|gist|hub|filing] [--max-jobs N] [--max-tokens N] [--dry-run]
 *   agents status
 *   compact [--month YYYY-MM]
 * Common flags: --vault <abs path> (default: walk up from the runner file to the folder holding .obsidian),
 *   --json (emit protocol frames as JSON lines), --quiet, --max-seconds N.
 * CLI mode is BOUNDED (SKILL-LONG-RUNS): import and agents run stop cleanly after --max-seconds (default 90) and
 * agents run after --max-jobs (default 10), reporting `partial`; the skill runs long work in the background
 * and polls `agents status` instead of holding Claude Code's Bash tool past its timeout.
 */
import type { RunnerCommand, SourceSelector } from "../shared/protocol/runner";
import type { JobKind } from "../shared/types";

export interface CliInvocation {
  mode: "serve" | "command" | "help";
  command?: RunnerCommand;
  vault?: string;
  json: boolean;
  quiet: boolean;
  errors: string[];
}

function takeValue(argv: string[], i: number): string | undefined {
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

export function parseSourceFlag(v: string): SourceSelector | undefined {
  const [kind, arg] = v.split(/=(.*)/s, 2) as [string, string | undefined];
  switch (kind) {
    case "claude-code":
      return { kind: "claude-code" };
    case "raw":
      return { kind: "raw" };
    case "written":
      return { kind: "written" };
    case "vault-notes":
      return { kind: "vault-notes" };
    case "codex-cli":
    case "gemini-cli":
    case "cursor":
    case "capture":
      return { kind };
    case "claude-ai":
    case "chatgpt":
    case "gemini":
    case "notion":
    case "google-docs":
    case "whatsapp":
    case "telegram":
    case "discord":
    case "slack":
    case "keep":
    case "evernote":
    case "roam":
    case "kindle":
    case "zoom":
      return arg ? { kind, file: arg } : undefined;
    case "folder":
      return arg ? { kind: "folder", id: arg } : undefined;
    default:
      return undefined;
  }
}

/** CLI passes stop after this long so a skill's foreground call never outlives its tool timeout. */
export const CLI_DEFAULT_MAX_SECONDS = 90;
export const CLI_DEFAULT_MAX_JOBS = 10;

export function parseArgv(argv: readonly string[]): CliInvocation {
  const a = [...argv];
  const out: CliInvocation = { mode: "help", json: a.includes("--json"), quiet: a.includes("--quiet"), errors: [] };
  const vi = a.indexOf("--vault");
  if (vi >= 0) {
    const v = takeValue(a, vi);
    if (v) out.vault = v;
    else out.errors.push("--vault needs a path");
  }
  const cmd = a[0];
  const has = (f: string) => a.includes(f);
  const num = (f: string): number | undefined => {
    const i = a.indexOf(f);
    const v = i >= 0 ? takeValue(a, i) : undefined;
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  switch (cmd) {
    case "serve":
      out.mode = "serve";
      return out;
    case "doctor":
      out.mode = "command";
      out.command = { cmd: "doctor", args: { live: has("--live") } };
      return out;
    case "import": {
      const sources: SourceSelector[] = [];
      a.forEach((x, i) => {
        if (x === "--source") {
          const v = takeValue(a, i);
          const s = v ? parseSourceFlag(v) : undefined;
          if (s) sources.push(s);
          else out.errors.push(`bad --source ${v ?? ""}`);
        }
      });
      out.mode = "command";
      out.command = { cmd: "import", args: { sources: sources.length > 0 ? sources : [{ kind: "claude-code" }, { kind: "raw" }, { kind: "written" }], dryRun: has("--dry-run"), maxSeconds: num("--max-seconds") ?? CLI_DEFAULT_MAX_SECONDS } };
      return out;
    }
    case "index":
      out.mode = "command";
      out.command = { cmd: "index.build", args: { full: has("--full") } };
      return out;
    case "search":
      out.mode = "command";
      out.command = { cmd: "search.build", args: { full: has("--full") } };
      return out;
    case "agents": {
      out.mode = "command";
      if (a[1] === "status") {
        out.command = { cmd: "agents.status", args: {} };
        return out;
      }
      const jobs: JobKind[] = [];
      a.forEach((x, i) => {
        if (x === "--job") {
          const v = takeValue(a, i);
          if (v === "label" || v === "gist" || v === "hub" || v === "filing" || v === "name-check") jobs.push(v);
          else out.errors.push(`bad --job ${v ?? ""}`);
        }
      });
      const maxJobs = num("--max-jobs") ?? CLI_DEFAULT_MAX_JOBS;
      const maxTokens = num("--max-tokens");
      out.command = {
        cmd: "agents.run",
        args: { reason: "skill", ...(jobs.length > 0 ? { jobs } : {}), maxJobs, ...(maxTokens !== undefined ? { maxTokens } : {}), maxSeconds: num("--max-seconds") ?? CLI_DEFAULT_MAX_SECONDS, dryRun: has("--dry-run") },
      };
      return out;
    }
    case "compact": {
      out.mode = "command";
      const mi = a.indexOf("--month");
      const month = mi >= 0 ? takeValue(a, mi) : undefined;
      out.command = { cmd: "ledger.compact", args: month ? { month } : {} };
      return out;
    }
    default:
      return out;
  }
}

export const HELP_TEXT = `Cortex runner

Usage: node cortex-runner.js <command> [options]

Commands:
  doctor [--live]            Check Node, the Claude Code CLI and the vault (--live sends one tiny prompt)
  import [--source <s>]...   Import new material (default: claude-code, raw, written)
                             <s> = claude-code | raw | written | vault-notes | folder=<id> | claude-ai=<zip> | chatgpt=<zip> | gemini=<zip>
                             | notion=<zip or folder> | google-docs=<zip, folder or .docx> | codex-cli | gemini-cli | cursor
  index [--full]             Rebuild the record index cache
  search [--full]            Rebuild the search index cache
  agents run [--job <j>]...  Run organising agents within today's token cap
             [--max-jobs N] [--max-tokens N] [--dry-run]
  agents status              Show today's usage, cap and waiting work
  compact [--month YYYY-MM]  Compact ledger shards
  serve                      Protocol mode used by the Obsidian plugin

Options:
  --vault <path>   Vault folder (default: found from the runner's location)
  --json           Print protocol frames as JSON lines
  --quiet          Only print the final result
  --max-seconds N  Stop cleanly after N seconds (default 90); run again to continue
`;

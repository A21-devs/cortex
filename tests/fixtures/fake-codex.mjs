// A stand-in for the Codex CLI used by tests/codex-engine.test.ts. It never contacts a model: it prints what a
// real `codex --version`, `codex exec --help` and `codex exec ... -` would, and answers from --fake-mode.
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = (argv.find((a) => a.startsWith("--fake-mode=")) ?? "--fake-mode=ok").split("=")[1];
const args = argv.filter((a) => !a.startsWith("--fake-mode="));

if (args[0] === "--version") {
  console.log("codex-cli 0.99.0");
  process.exit(0);
}
if (args[0] === "exec" && args.includes("--help")) {
  if (mode === "old") {
    console.log("Usage: codex exec [OPTIONS] [PROMPT]\n  --skip-git-repo-check\n  --output-last-message <FILE>\n  --cd <DIR>");
    process.exit(0);
  }
  console.log(
    [
      "Usage: codex exec [OPTIONS] [PROMPT]",
      "  -m, --model <MODEL>",
      "  -s, --sandbox <SANDBOX_MODE>",
      "  -c, --config <key=value>",
      "      --skip-git-repo-check",
      "      --ephemeral",
      "      --color <COLOR>",
      "      --json",
      "  -o, --output-last-message <FILE>",
      "  -C, --cd <DIR>",
    ].join("\n"),
  );
  process.exit(0);
}

const stdin = readFileSync(0, "utf8");
const out = args[args.indexOf("--output-last-message") + 1];

if (mode === "flag" && args.includes("--ephemeral")) {
  console.error("error: unexpected argument '--ephemeral' found");
  process.exit(2);
}
if (mode === "auth") {
  console.error("Not logged in. Please run `codex login`.");
  process.exit(1);
}
if (mode === "limit") {
  console.log(JSON.stringify({ type: "error", message: "You've hit your usage limit. Try again in 3 hours." }));
  process.exit(1);
}
if (mode === "network") {
  console.error("error sending request: ECONNRESET");
  process.exit(1);
}

const events = (text, usage = { input_tokens: 120, cached_input_tokens: 20, output_tokens: 15 }) => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "t" }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage }));
};

if (mode === "prose") {
  writeFileSync(out, "I am sorry, I cannot help with that.");
  events("I am sorry, I cannot help with that.");
  process.exit(0);
}
if (mode === "echo") {
  const seen = { args, stdinHasPrompt: stdin.includes("RECORD-DATA"), argvHasPrompt: args.some((a) => a.includes("RECORD-DATA")), env: Object.keys(process.env).sort(), cwd: process.cwd() };
  const text = JSON.stringify(seen);
  writeFileSync(out, text);
  events(text);
  process.exit(0);
}
if (mode === "stdout-only") {
  events('```json\n{"ok":true}\n```');
  process.exit(0);
}
const text = '```json\n{"ok":true}\n```';
writeFileSync(out, text);
events(text);

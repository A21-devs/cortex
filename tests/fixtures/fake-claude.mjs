// Stand-in for the Claude Code CLI in tests (never calls a model). Run as: node fake-claude.mjs <claude args…>
// Behaviour is chosen by the FAKE_CLAUDE_MODE environment variable:
//   ok (default)  → success envelope whose result is JSON echoing the model, stdin length, isolation flags and
//                   the names of any CLAUDE*/MCP_*/ANTHROPIC_* variables that leaked into the environment
//   structured    → success envelope with structured_output
//   auth          → exit 1 with a sign-in error on stderr
//   limit         → exit 1 with a subscription usage-limit message on stderr
//   budget        → error_max_budget_usd envelope
//   slow          → sleeps 10 s (timeout tests)
//   oldhelp       → --help without the isolation flags (probe must refuse)
//   hidden        → --help hides --max-turns and --system-prompt-file (the real CLI does) but still accepts them
//   nomax         → like hidden, but the CLI rejects --max-turns as an unknown option
//   leaky         → with --output-format stream-json, an init event that lists tools (the live check must refuse)
//   plan          → stream-json with a rate_limit_event carrying the plan's windows (5-hour 42%, weekly 18%), as Claude Code does
//   plan-hot      → the same with the 5-hour window at 71% (past a 70% cap) and the weekly one at 18%
//   plan-rejected → a rate_limit_event with the 5-hour window rejected, then exit 1 with a usage-limit message on stderr
//   plan-old      → a rate_limit_event in the older top-level shape (rateLimitType, utilization, resetsAt)
// With --output-format stream-json (every call, and the live isolation check) it prints init, rate-limit, assistant and
// result events; the result line is the same envelope the json format prints.
// The mode comes from a leading --fake-mode=<m> argument (the engine passes only allow-listed environment
// variables to the CLI, so an environment switch would be filtered out — which is the point of ENV-INHERIT).
const modeArg = process.argv.slice(2).find((a) => a.startsWith("--fake-mode="));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--fake-mode="));
const mode = modeArg ? modeArg.slice("--fake-mode=".length) : process.env.FAKE_CLAUDE_MODE ?? "ok";
if (args.includes("--version")) {
  process.stdout.write("2.1.319 (Claude Code)\n");
  process.exit(0);
}
if (mode === "nomax" && args.includes("--max-turns")) {
  process.stderr.write("error: unknown option '--max-turns'\n");
  process.exit(1);
}
if (args.includes("--help")) {
  const iso = mode === "oldhelp" ? "" : "  --restricted\n  --permission-mode <mode>\n  --disallowedTools <tools...>\n";
  const hide = mode === "hidden" || mode === "nomax";
  const strip = (t) => (hide ? t.replace("  --max-turns <n>\n", "").replace("  --system-prompt-file <file>\n", "") : t);
  process.stdout.write(
    strip("Usage: claude [options]\n  -p, --print\n  --output-format <format>\n  --input-format <format>\n  --json-schema <schema>\n  --tools <tools...>\n  --strict-mcp-config\n  --safe-mode\n  --disable-slash-commands\n  --no-session-persistence\n  --permission-prompts <target>\n  --max-budget-usd <amount>\n  --system-prompt <prompt>\n  --append-system-prompt <prompt>\n  --model <model>\n  --effort <level>\n  --max-turns <n>\n  --verbose\n  --system-prompt-file <file>\n" +
      iso),
  );
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  if (input === "") {
    process.stderr.write("Error: Input must be provided either through stdin or as a prompt argument when using --print\n");
    process.exit(1);
  }
  const model = args[args.indexOf("--model") + 1] ?? "unknown";
  const toolsIdx = args.indexOf("--tools");
  const toolsDisabled = toolsIdx >= 0 && args[toolsIdx + 1] === "";
  const usage = { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 40 };
  const modelUsage = { "claude-haiku-5-5": { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 40, cacheCreationInputTokens: 10, costUSD: 0.0012 } };
  if (mode === "slow") {
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (mode === "auth") {
    process.stderr.write("Invalid API key · Please run /login\n");
    process.exit(1);
  }
  if (mode === "limit") {
    process.stderr.write("Claude usage limit reached. Your limit will reset at 2026-11-09T15:00:00Z\n");
    process.exit(1);
  }
  if (mode === "budget") {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, num_turns: 1, total_cost_usd: 1.01, usage, modelUsage }) + "\n");
    process.exit(1);
  }
  const stream = args[args.indexOf("--output-format") + 1] === "stream-json";
  const nl = String.fromCharCode(10);
  const prefix = [];
  if (stream) {
    const reset = (h) => Math.floor(Date.now() / 1000) + h * 3600;
    prefix.push({ type: "system", subtype: "init", tools: mode === "leaky" ? ["Bash"] : [], mcp_servers: [], model });
    if (mode === "plan" || mode === "plan-hot") {
      const five = mode === "plan-hot" ? 0.71 : 0.42;
      prefix.push({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: reset(2), rateLimitType: "five_hour", utilization: five, unifiedWindows: { five_hour: { utilization: five, resetsAt: reset(2) }, seven_day: { utilization: 0.18, resetsAt: reset(72) } } }, uuid: "u1", session_id: "fake" });
    }
    if (mode === "plan-old") prefix.push({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: reset(1), rateLimitType: "five_hour", utilization: 0.8 }, uuid: "u1", session_id: "fake" });
    if (mode === "plan-rejected") {
      prefix.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset(3), rateLimitType: "five_hour" }, uuid: "u1", session_id: "fake" });
      process.stdout.write(prefix.map((l) => JSON.stringify(l)).join(nl) + nl);
      process.stderr.write("Claude usage limit reached." + nl);
      process.exit(1);
    }
  }
  const leaked = Object.keys(process.env).filter((k) => /^(CLAUDE|MCP_|OTEL_|ANTHROPIC_)/i.test(k)).sort();
  const payload = {
    model,
    stdinChars: input.length,
    toolsDisabled,
    restricted: args.includes("--restricted") && args.includes("--permission-mode") && args.includes("--disallowedTools"),
    effort: args[args.indexOf("--effort") + 1] ?? null,
    sawSchema: args.includes("--json-schema"),
    leaked,
  };
  const envelope = { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 5, result: mode === "structured" ? "" : "```json\n" + JSON.stringify(payload) + "\n```", total_cost_usd: 0.0012, usage, modelUsage, session_id: "fake" };
  if (mode === "structured") envelope.structured_output = payload;
  if (stream) prefix.push({ type: "assistant", message: { content: [{ type: "text", text: envelope.result }] } });
  process.stdout.write([...prefix, envelope].map((l) => JSON.stringify(l)).join(nl) + nl);
  process.exit(0);
});

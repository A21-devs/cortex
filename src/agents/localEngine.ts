/**
 * Local model engine: a model that runs on this computer, so a call costs nothing. Owner: P20.
 *
 * Talks to a model server over HTTP, either Ollama's own API (`/api/chat`, `/api/tags`) or the OpenAI-compatible
 * one (`/v1/chat/completions`, `/v1/models`: llama.cpp server, LM Studio, vLLM …). It never runs a program and
 * never executes anything the model says: the reply is parsed, validated against the call's schema here (one
 * retry) and again by the job before it becomes a record, exactly like the Claude Code engine.
 *
 * Privacy: the address rules live in shared/localModel.ts (loopback only unless "Allow a network address").
 * Nothing else is contacted: no telemetry, no model download. Run records carry where = "this computer",
 * paidBy = "none" and a cost of 0 (the Engine contract); token counts come from the reply, estimated when the
 * server gives none.
 */
import type { EngineProbe, EngineRequest, EngineResult, EngineUsage, Engine, EngineError } from "./engine";
import { zeroUsage } from "./engine";
import { checkEndpoint, estimateTextTokens, fetchHttp, localUrl, LOCAL_DEFAULT_TIMEOUT_MS, LocalHttpError, modelListed, parseJsonText, readModelList, readReply, stripThinking, type EndpointCheck, type LocalHttp, type LocalHttpResponse, type LocalReply, type LocalTestConfig } from "../shared/localModel";
import { formatIssues, validate, type JsonSchema } from "../shared/validate";

export * from "../shared/localModel";

/** The context window asked of the server (Ollama's own default of 2–4k tokens would silently cut long prompts). */
const CTX_MIN = 4_096;
const CTX_MAX = 32_768;

// ───────────────────────────── the engine ─────────────────────────────

export type LocalEngineConfig = LocalTestConfig;

type Role = "system" | "user" | "assistant";
interface Message {
  role: Role;
  content: string;
}

const JSON_ONLY = "Reply with one JSON object and nothing else: no prose, no code fence.";

export class LocalEngine implements Engine {
  readonly kind = "local" as const;
  readonly where = "this computer" as const;
  readonly paidBy = "none" as const;
  /** The server rejected a schema-constrained reply once: plain JSON text is asked for from then on. */
  private schemaFormatOff = false;

  constructor(private readonly cfg: LocalEngineConfig) {}

  private get http(): LocalHttp {
    return this.cfg.http ?? fetchHttp;
  }

  private get timeoutMs(): number {
    const s = this.cfg.timeoutSec;
    return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : LOCAL_DEFAULT_TIMEOUT_MS;
  }

  private endpoint(): EndpointCheck {
    return checkEndpoint(this.cfg.endpoint, this.cfg.allowNetwork);
  }

  /** Free check: lists the models (never sends a prompt). */
  async probe(): Promise<EngineProbe> {
    const ep = this.endpoint();
    if (!ep.ok) return { ok: false, flags: {}, missingMandatory: [], detail: ep.reason === "not-loopback" ? "address refused" : "unreachable" };
    if (!this.cfg.model.trim()) return { ok: false, flags: {}, missingMandatory: [], detail: "no model chosen" };
    try {
      const r = await this.http({ url: localUrl(ep.base, this.cfg.api, "models"), method: "GET", timeoutMs: Math.min(this.timeoutMs, 10_000) });
      if (r.status >= 200 && r.status < 300) {
        const names = readModelList(this.cfg.api, r.text);
        if (names.length > 0 && !modelListed(names, this.cfg.model)) return { ok: false, flags: {}, missingMandatory: [], detail: "model missing" };
        return { ok: true, version: "local", flags: {}, missingMandatory: [], detail: "ready" };
      }
      // A server that answers but has no list route (some OpenAI-style servers) is still there.
      if (r.status === 404 || r.status === 405) return { ok: true, version: "local", flags: {}, missingMandatory: [], detail: "ready" };
      return { ok: false, flags: {}, missingMandatory: [], detail: "unreachable" };
    } catch {
      return { ok: false, flags: {}, missingMandatory: [], detail: "unreachable" };
    }
  }

  private fail(error: EngineError, started: boolean, t0: number, usage?: EngineUsage, rawText?: string): EngineResult {
    const res: EngineResult = { ok: false, error, durationMs: Date.now() - t0, started };
    if (usage) res.usage = usage;
    if (rawText !== undefined) res.rawText = rawText;
    return res;
  }

  private body(messages: Message[], req: EngineRequest, strict: boolean): string {
    const maxOut = Math.max(256, Math.ceil(req.expectedOutputTokens ?? 2_000) * 2);
    if (this.cfg.api === "ollama") {
      const chars = messages.reduce((n, m) => n + m.content.length, 0);
      const ctx = Math.min(CTX_MAX, Math.max(CTX_MIN, estimateTextTokens(chars) + maxOut + 256));
      const body: Record<string, unknown> = { model: this.cfg.model, messages, stream: false, options: { temperature: 0, num_predict: maxOut, num_ctx: ctx } };
      if (strict) body.format = req.schema;
      return JSON.stringify(body);
    }
    const body: Record<string, unknown> = { model: this.cfg.model, messages, stream: false, temperature: 0, max_tokens: maxOut };
    if (strict) body.response_format = { type: "json_schema", json_schema: { name: "cortex_reply", schema: req.schema, strict: false } };
    return JSON.stringify(body);
  }

  /** One HTTP exchange; never throws. */
  private async exchange(messages: Message[], req: EngineRequest, base: string, t0: number): Promise<{ ok: true; reply: LocalReply } | { ok: false; error: EngineError; started: boolean; usage?: EngineUsage }> {
    const url = localUrl(base, this.cfg.api, "chat");
    let strict = !this.schemaFormatOff;
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = req.timeoutMs - (Date.now() - t0);
      if (left < 1_000) return { ok: false, error: { code: "E_TIMEOUT", message: "the local model did not answer in time", retryable: true }, started: attempt > 0 };
      let r: LocalHttpResponse;
      try {
        r = await this.http({ url, method: "POST", body: this.body(messages, req, strict), timeoutMs: Math.min(this.timeoutMs, left), signal: req.signal });
      } catch (e) {
        const kind = e instanceof LocalHttpError ? e.kind : "network";
        if (kind === "aborted") return { ok: false, error: { code: "E_CANCELLED", message: "cancelled", retryable: false }, started: true };
        if (kind === "timeout") return { ok: false, error: { code: "E_TIMEOUT", message: "the local model did not answer in time", retryable: true }, started: true };
        return { ok: false, error: { code: "E_ENGINE_FAILED", message: "the local model could not be reached", retryable: true, state: "offline", reason: "endpoint-unreachable" }, started: false };
      }
      if (r.status >= 200 && r.status < 300) {
        const reply = readReply(this.cfg.api, r.text);
        if (!reply) return { ok: false, error: { code: "E_ENGINE_FAILED", message: "the local model sent a reply Cortex could not read", retryable: true, reason: "unreadable-reply" }, started: true };
        return { ok: true, reply };
      }
      if ((r.status === 400 || r.status === 422) && strict) {
        // An older server that does not know schema-constrained output: ask for plain JSON text instead.
        strict = false;
        this.schemaFormatOff = true;
        continue;
      }
      if (r.status === 404) return { ok: false, error: { code: "E_ENGINE_FAILED", message: "the local model was not found on that server", retryable: false, state: "offline", reason: "model-not-found" }, started: false };
      if (r.status === 401 || r.status === 403) return { ok: false, error: { code: "E_ENGINE_FAILED", message: "the local model server refused the request", retryable: false, state: "offline", reason: "refused" }, started: false };
      return { ok: false, error: { code: "E_ENGINE_FAILED", message: "the local model failed to answer", retryable: r.status >= 500 || r.status === 429, reason: `http-${r.status}` }, started: true };
    }
    return { ok: false, error: { code: "E_ENGINE_FAILED", message: "the local model failed to answer", retryable: false, reason: "format-rejected" }, started: true };
  }

  async run(req: EngineRequest): Promise<EngineResult> {
    const t0 = Date.now();
    if (req.signal.aborted) return this.fail({ code: "E_CANCELLED", message: "cancelled", retryable: false }, false, t0);
    const ep = this.endpoint();
    if (!ep.ok) {
      return this.fail(
        ep.reason === "not-loopback"
          ? { code: "E_ENGINE_FAILED", message: "the local model address is not on this computer", retryable: false, reason: "address-refused" }
          : { code: "E_ENGINE_FAILED", message: "the local model address is not valid", retryable: false, reason: "address-invalid" },
        false,
        t0,
      );
    }
    const model = this.cfg.model.trim();
    if (!model) return this.fail({ code: "E_ENGINE_FAILED", message: "no local model is chosen", retryable: false, reason: "no-model" }, false, t0);

    const system = `${req.system}\n\n${JSON_ONLY}`;
    let messages: Message[] = [
      { role: "system", content: system },
      { role: "user", content: req.prompt },
    ];
    const promptChars = system.length + req.prompt.length;
    let usage = zeroUsage(false);
    let lastRaw = "";
    let used = false;
    let lastIssue = "the reply was not a JSON object";

    for (let attempt = 0; attempt < 2; attempt++) {
      const ex = await this.exchange(messages, req, ep.base, t0);
      if (!ex.ok) return this.fail(ex.error, ex.started || used, t0, used ? usage : undefined, lastRaw || undefined);
      used = true;
      const { reply } = ex;
      const answer = stripThinking(reply.text);
      const estimated = reply.tokensIn === undefined || reply.tokensOut === undefined;
      const chars = attempt === 0 ? promptChars : messages.reduce((n, m) => n + m.content.length, 0);
      usage = {
        ...usage,
        inputTokens: usage.inputTokens + (reply.tokensIn ?? estimateTextTokens(chars)),
        outputTokens: usage.outputTokens + (reply.tokensOut ?? estimateTextTokens(reply.text.length)),
        estimated: usage.estimated || estimated,
        models: [...new Set([...usage.models, reply.model ?? model])],
      };
      lastRaw = answer;
      const output = parseJsonText(reply.text);
      if (output !== undefined) {
        const v = validate(req.schema, output);
        if (v.ok) return { ok: true, output: v.value, rawText: answer, usage, durationMs: Date.now() - t0, modelUsed: usage.models[0] ?? model };
        lastIssue = formatIssues(v.issues);
      } else lastIssue = "the reply was not a JSON object";
      // One retry: show the model its own reply and what was wrong with it.
      messages = [
        ...messages.slice(0, 2),
        { role: "assistant", content: answer.slice(0, 8_000) },
        { role: "user", content: `That reply did not match the required shape (${lastIssue.slice(0, 600)}). ${JSON_ONLY}` },
      ];
    }
    return this.fail({ code: "E_VALIDATION", message: "the local model's reply did not match the expected shape", retryable: true, reason: "schema" }, true, t0, usage, lastRaw);
  }
}


// ───────────────────────────── the optional personal-detail pass ─────────────────────────────

/** What the local model is asked for: names of people and street addresses, exactly as written. */
export const PERSON_PROPOSAL_SCHEMA: JsonSchema = {
  type: "object",
  required: ["names", "addresses"],
  additionalProperties: false,
  properties: {
    names: { type: "array", maxItems: 40, items: { type: "string", minLength: 3, maxLength: 60 } },
    addresses: { type: "array", maxItems: 20, items: { type: "string", minLength: 6, maxLength: 120 } },
  },
};

const PERSON_PROPOSAL_SYSTEM =
  "You help someone keep personal details out of what they send to online services. From the passages, list the full names of real people and the street addresses that appear, copied exactly as written. Never invent or complete a name or an address; leave out company names, product names, places that are not addresses and the writer's own first name when it stands alone.";

/**
 * The optional "propose names and addresses" pass (Settings > Privacy > "Let a model on this computer look for names").
 * Runs only on an engine that is on this computer, sends the passages nowhere else and writes nothing: it returns
 * proposals the person confirms one by one. A proposal that does not appear verbatim in the passages is dropped.
 */
export async function proposePersonDetails(
  engine: Pick<Engine, "run" | "where">,
  passages: readonly string[],
  o: { model: string; signal: AbortSignal; timeoutMs?: number; known?: ReadonlySet<string> },
): Promise<{ kind: "name" | "address"; text: string }[]> {
  if (engine.where !== "this computer" || passages.length === 0) return [];
  const prompt = passages.map((p, i) => `--- passage ${i + 1} ---\n${p}`).join("\n\n");
  const res = await engine.run({
    runId: `r_screen${Date.now().toString(36)}`,
    job: "label",
    model: o.model,
    system: PERSON_PROPOSAL_SYSTEM,
    prompt,
    schema: PERSON_PROPOSAL_SCHEMA,
    timeoutMs: o.timeoutMs ?? 120_000,
    effort: "low",
    signal: o.signal,
    expectedOutputTokens: 400,
  });
  if (!res.ok) return [];
  const out = res.output as { names?: unknown; addresses?: unknown } | undefined;
  const seen = new Set<string>();
  const list: { kind: "name" | "address"; text: string }[] = [];
  const take = (kind: "name" | "address", v: unknown): void => {
    if (!Array.isArray(v)) return;
    for (const x of v) {
      if (typeof x !== "string") continue;
      const text = x.trim();
      const k = text.toLowerCase();
      if (text.length < 3 || seen.has(k) || o.known?.has(k) || !prompt.includes(text)) continue;
      seen.add(k);
      list.push({ kind, text });
    }
  };
  take("name", out?.names);
  take("address", out?.addresses);
  return list;
}

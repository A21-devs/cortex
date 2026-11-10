/**
 * A model server on this computer: the address rules, the wire formats and the settings "Test" button. Owner: P20.
 * Pure (no Node imports) so the settings tab and the engine (agents/localEngine.ts) share one implementation.
 *
 * Privacy: the endpoint must be a loopback address (127.x, ::1, localhost) unless the person ticked "Allow a
 * network address". Redirects are never followed. Only the configured address is ever contacted.
 */
import type { LocalApi, LocalEngineSettings } from "./settings";

export const LOCAL_DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
/** One request may take this long unless the settings say otherwise. */
export const LOCAL_DEFAULT_TIMEOUT_MS = 60_000;
/** Largest reply body read (a model that rambles is cut off, not buffered forever). */
export const LOCAL_MAX_BODY_CHARS = 4_000_000;
/** Characters per token used when a server reports no usage. */
const CHARS_PER_TOKEN = 3.5;
/** The probe details the scheduler treats as "the model is not reachable". */
export const LOCAL_DOWN_DETAILS: ReadonlySet<string> = new Set(["unreachable", "model missing", "address refused", "no model chosen"]);

// ───────────────────────────── the HTTP seam ─────────────────────────────

export interface LocalHttpRequest {
  url: string;
  method: "GET" | "POST";
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface LocalHttpResponse {
  status: number;
  text: string;
}

/** A transport failure: nothing answered (`network`), it took too long (`timeout`), or the caller cancelled (`aborted`). */
export class LocalHttpError extends Error {
  constructor(readonly kind: "network" | "timeout" | "aborted", message: string = kind) {
    super(message);
    this.name = "LocalHttpError";
  }
}

export type LocalHttp = (req: LocalHttpRequest) => Promise<LocalHttpResponse>;

/** The default seam: global `fetch` (Node 18+ in the runner, Chromium in the app), redirects refused. */
export const fetchHttp: LocalHttp = async (req) => {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, Math.max(1, req.timeoutMs));
  (timer as { unref?: () => void }).unref?.();
  const onAbort = (): void => ac.abort();
  if (req.signal) {
    if (req.signal.aborted) ac.abort();
    else req.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const init: RequestInit = { method: req.method, signal: ac.signal, redirect: "error" };
    if (req.body !== undefined) {
      init.body = req.body;
      init.headers = { "content-type": "application/json", accept: "application/json" };
    } else init.headers = { accept: "application/json" };
    const res = await fetch(req.url, init);
    const text = await res.text();
    return { status: res.status, text: text.length > LOCAL_MAX_BODY_CHARS ? text.slice(0, LOCAL_MAX_BODY_CHARS) : text };
  } catch (e) {
    if (timedOut) throw new LocalHttpError("timeout");
    if (req.signal?.aborted) throw new LocalHttpError("aborted");
    throw new LocalHttpError("network", e instanceof Error ? e.name : "network");
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
};

// ───────────────────────────── the address ─────────────────────────────

/** True for a host name or literal that can only mean this computer. */
export function isLoopbackHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return Number(v4[1]) === 127 && [v4[2], v4[3], v4[4]].every((p) => Number(p) <= 255);
  // IPv4-mapped IPv6 (::ffff:127.0.0.1, which URL prints as ::ffff:7f00:1).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) return (parseInt(mapped[1] as string, 16) >> 8) === 127;
  const dotted = /^::ffff:(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(h);
  return dotted !== null && Number(dotted[1]) === 127;
}

export type EndpointCheck = { ok: true; base: string; host: string; loopback: boolean } | { ok: false; reason: "empty" | "invalid" | "scheme" | "credentials" | "not-loopback"; host?: string };

/**
 * Accept the configured address or say why not. `http` and `https` only, no embedded login, and a loopback host
 * unless `allowNetwork`. The returned base has no trailing slash, query or fragment.
 */
export function checkEndpoint(raw: string, allowNetwork: boolean): EndpointCheck {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "credentials" };
  if (u.hostname === "") return { ok: false, reason: "invalid" };
  const loopback = isLoopbackHost(u.hostname);
  if (!loopback && !allowNetwork) return { ok: false, reason: "not-loopback", host: u.hostname };
  const path = u.pathname.replace(/\/+$/, "");
  return { ok: true, base: `${u.protocol}//${u.host}${path}`, host: u.hostname, loopback };
}

export function localUrl(base: string, api: LocalApi, what: "chat" | "models"): string {
  if (api === "ollama") return `${base}${what === "chat" ? "/api/chat" : "/api/tags"}`;
  const root = /\/v1$/i.test(base) ? base : `${base}/v1`;
  return `${root}${what === "chat" ? "/chat/completions" : "/models"}`;
}

// ───────────────────────────── reading replies ─────────────────────────────

/** Reasoning models print their thinking in <think> blocks before the answer; the answer is what follows. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();
}

/** The JSON object in a model's text: bare, fenced, or embedded in prose. undefined when there is none. */
export function parseJsonText(text: string): unknown {
  const clean = stripThinking(text);
  if (!clean) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(clean);
  const candidate = (fenced?.[1] ?? clean).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

export interface LocalReply {
  text: string;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
}

/** The text, token counts and model name out of an Ollama or OpenAI-style chat reply. Undefined when it has no text. */
export function readReply(api: LocalApi, body: string): LocalReply | undefined {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return undefined;
  }
  const o = asRecord(j);
  if (!o) return undefined;
  const out: LocalReply = { text: "" };
  const model = typeof o.model === "string" ? o.model : undefined;
  if (model) out.model = model.slice(0, 120);
  if (api === "ollama") {
    const content = asRecord(o.message)?.content;
    if (typeof content !== "string") return undefined;
    out.text = content;
    const i = count(o.prompt_eval_count);
    const n = count(o.eval_count);
    if (i !== undefined) out.tokensIn = i;
    if (n !== undefined) out.tokensOut = n;
    return out;
  }
  const choice = Array.isArray(o.choices) ? asRecord(o.choices[0]) : undefined;
  const content = asRecord(choice?.message)?.content;
  if (typeof content !== "string") return undefined;
  out.text = content;
  const usage = asRecord(o.usage);
  const i = count(usage?.prompt_tokens);
  const n = count(usage?.completion_tokens);
  if (i !== undefined) out.tokensIn = i;
  if (n !== undefined) out.tokensOut = n;
  return out;
}

/** Model names listed by an Ollama `/api/tags` or OpenAI `/v1/models` reply (empty when unreadable). */
export function readModelList(api: LocalApi, body: string): string[] {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return [];
  }
  const o = asRecord(j);
  const rows = api === "ollama" ? o?.models : o?.data;
  if (!Array.isArray(rows)) return [];
  const names: string[] = [];
  for (const r of rows) {
    const rec = asRecord(r);
    const n = api === "ollama" ? (rec?.name ?? rec?.model) : rec?.id;
    if (typeof n === "string" && n !== "") names.push(n.slice(0, 120));
  }
  return names;
}

/** True when `wanted` is one of `names` ("qwen2.5" matches "qwen2.5:latest"). */
export function modelListed(names: readonly string[], wanted: string): boolean {
  const w = wanted.trim().toLowerCase();
  if (!w) return false;
  return names.some((n) => {
    const x = n.toLowerCase();
    return x === w || (!w.includes(":") && x === `${w}:latest`);
  });
}

/** Rough token count of a text (used only when the server reports none). */
export function estimateTextTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN));
}

// ───────────────────────────── the settings "Test" button ─────────────────────────────

export interface LocalTestConfig extends LocalEngineSettings {
  /** The HTTP layer (default: fetch). Tests pass a fake. */
  http?: LocalHttp;
}

export type EndpointTest =
  | { ok: true; model: string; models: string[]; tokens: number; ms: number }
  | { ok: false; reason: "address" | "address-refused" | "unreachable" | "no-model" | "model-missing" | "no-answer" | "timeout"; models: string[]; host?: string; model?: string };

/**
 * List the models the server has and, when one is chosen, ask it for one token. This is what the Test button
 * runs. Only the configured address is contacted, and the one-token prompt is a fixed word, never record text.
 */
export async function testEndpoint(cfg: LocalTestConfig): Promise<EndpointTest> {
  const http = cfg.http ?? fetchHttp;
  const ep = checkEndpoint(cfg.endpoint, cfg.allowNetwork);
  if (!ep.ok) return ep.reason === "not-loopback" ? { ok: false, reason: "address-refused", models: [], ...(ep.host ? { host: ep.host } : {}) } : { ok: false, reason: "address", models: [] };
  const t0 = Date.now();
  const timeoutMs = Math.min(Math.max(1_000, Math.round((cfg.timeoutSec || 60) * 1000)), LOCAL_DEFAULT_TIMEOUT_MS);
  let models: string[] = [];
  try {
    const r = await http({ url: localUrl(ep.base, cfg.api, "models"), method: "GET", timeoutMs: Math.min(timeoutMs, 10_000) });
    if (r.status < 200 || r.status >= 300) {
      if (r.status !== 404 && r.status !== 405) return { ok: false, reason: "unreachable", models: [] };
    } else models = readModelList(cfg.api, r.text);
  } catch (e) {
    return { ok: false, reason: e instanceof LocalHttpError && e.kind === "timeout" ? "timeout" : "unreachable", models: [] };
  }
  const model = cfg.model.trim();
  if (!model) return { ok: false, reason: "no-model", models };
  if (models.length > 0 && !modelListed(models, model)) return { ok: false, reason: "model-missing", models, model };
  const body =
    cfg.api === "ollama"
      ? { model, messages: [{ role: "user", content: "Say ok." }], stream: false, options: { temperature: 0, num_predict: 1 } }
      : { model, messages: [{ role: "user", content: "Say ok." }], stream: false, temperature: 0, max_tokens: 1 };
  try {
    const r = await http({ url: localUrl(ep.base, cfg.api, "chat"), method: "POST", body: JSON.stringify(body), timeoutMs });
    if (r.status < 200 || r.status >= 300) return { ok: false, reason: r.status === 404 ? "model-missing" : "no-answer", models, model };
    const reply = readReply(cfg.api, r.text);
    if (!reply) return { ok: false, reason: "no-answer", models };
    return { ok: true, model, models, tokens: (reply.tokensIn ?? 0) + (reply.tokensOut ?? 0), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, reason: e instanceof LocalHttpError && e.kind === "timeout" ? "timeout" : "unreachable", models };
  }
}

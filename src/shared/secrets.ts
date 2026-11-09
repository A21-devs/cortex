/**
 * Secret detection, shared by the importers (SAFE-10: keep detected secrets out of the vault copy) and the
 * agents' privacy filter (SAFE-06: redact everything that leaves the machine). Owner: E5. Pure: no Node, no DOM.
 *
 *  - HIGH-CONFIDENCE patterns (distinctive prefixes, key blocks, credentials in URLs and auth headers) run at
 *    import time, where a hit replaces text in the vault copy and the original is held on this computer.
 *  - Every pattern, plus the low-confidence `key-value` rule and the entropy detector, runs before text is sent
 *    to a model, where over-redaction is the safe direction.
 *  - A pattern may name a capture `group`: only that span is replaced, so "password = [secret removed]" keeps
 *    its context. Spans are reported against the ORIGINAL text (the importers store them).
 *  - Every expression is written to run in linear time on hostile input (no nested quantifiers, look-behind
 *    anchors on runs of word characters, bounded repeats), because it runs over gigabytes of transcripts.
 */

export interface SecretPattern {
  id: string;
  /** Global expression. Never used with `test()` across calls (matchAll clones it). */
  re: RegExp;
  /** Safe to apply at import time (very low false-positive rate). */
  highConfidence: boolean;
  /** Capture group whose span is replaced; the whole match when absent. */
  group?: number;
}

/** Marker written into the vault copy at import; the original is held under the local cache (SAFE-10). */
export const SECRET_MARKER = "[secret kept on this computer]";
/** Marker in text sent to a model (SAFE-06). */
export const REDACTED_SECRET = "[secret removed]";

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: "private-key",
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,20000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|[A-Za-z0-9+/=\r\n\t :-]{0,20000})/g,
    highConfidence: true,
  },
  { id: "putty-key", re: /PuTTY-User-Key-File-\d:[^\n]{0,200}\n(?:[^\n]{0,200}\n){0,60}?Private-MAC: [0-9a-fA-F]{16,}/g, highConfidence: true },
  { id: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, highConfidence: true },
  { id: "openai", re: /\bsk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{20,}/g, highConfidence: true },
  { id: "stripe", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, highConfidence: true },
  { id: "stripe-webhook", re: /\bwhsec_[A-Za-z0-9]{24,}/g, highConfidence: true },
  { id: "github", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, highConfidence: true },
  { id: "github-fine", re: /\bgithub_pat_\w{40,}/g, highConfidence: true },
  { id: "gitlab", re: /\bglpat-[A-Za-z0-9_-]{20,}/g, highConfidence: true },
  { id: "aws", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, highConfidence: true },
  { id: "slack", re: /\bxox[a-z]-[A-Za-z0-9-]{10,}/g, highConfidence: true },
  { id: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g, highConfidence: true },
  { id: "discord-webhook", re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,}/g, highConfidence: true },
  { id: "discord-bot", re: /\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, highConfidence: true },
  { id: "google", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, highConfidence: true },
  { id: "google-oauth", re: /\bya29\.[0-9A-Za-z_-]{20,}/g, highConfidence: true },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, highConfidence: true },
  { id: "npm", re: /\bnpm_[A-Za-z0-9]{36}\b/g, highConfidence: true },
  { id: "huggingface", re: /\bhf_[A-Za-z0-9]{30,}\b/g, highConfidence: true },
  { id: "sendgrid", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, highConfidence: true },
  { id: "twilio", re: /\bSK[0-9a-fA-F]{32}\b/g, highConfidence: true },
  { id: "telegram-bot", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g, highConfidence: true },
  { id: "roblox-cookie", re: /_\|WARNING:-DO-NOT-SHARE-THIS[^\s"';]*/g, highConfidence: true },
  { id: "azure-key", re: /\b(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/=]{20,})/g, highConfidence: true, group: 1 },
  { id: "auth-header", re: /\bauthorization:\s{0,10}(?:bearer|basic|token)\s{1,10}(\S{8,})/gi, highConfidence: true, group: 1 },
  { id: "bearer", re: /\bbearer\s{1,10}([A-Za-z0-9._~+/-]{20,}=*)/gi, highConfidence: true, group: 1 },
  { id: "url-credentials", re: /(?<![\w+.-])[a-z][\w+.-]{0,30}:\/\/[^/\s:@]{1,200}:([^@\s/]{1,200})@/gi, highConfidence: true, group: 1 },
  {
    id: "key-value",
    re: /(?<![\w-])(?:[\w-]{0,30}[_-])?(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth)(?:[_-][\w-]{0,30})?["']?\s{0,10}[:=]\s{0,10}["']?([^\s"',;}]{6,})/gi,
    highConfidence: false,
    group: 1,
  },
];

/** The patterns as matched: grouped ones get the `d` flag so their group spans are known. */
const COMPILED: readonly SecretPattern[] = SECRET_PATTERNS.map((p) =>
  p.group === undefined || p.re.flags.includes("d") ? p : { ...p, re: new RegExp(p.re.source, `${p.re.flags}d`) },
);

/** Candidate random tokens: 32+ characters from the base64 / base64url alphabets. */
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;

function entropyPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function classes(s: string): number {
  return Number(/[a-z]/.test(s)) + Number(/[A-Z]/.test(s)) + Number(/[0-9]/.test(s)) + Number(/[+/_=-]/.test(s));
}

/**
 * A random-looking token: ≥ 32 characters, ≥ 3 character classes, ≥ 3 digits and ≥ 4 bits of entropy per
 * character. Identifiers in code rarely carry three scattered digits; hex digests (two classes) never match.
 */
export function looksLikeRandomToken(s: string): boolean {
  if (s.length < 32 || classes(s) < 3) return false;
  let digits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
  }
  return digits >= 3 && entropyPerChar(s) >= 4.0;
}

export interface SecretSpan {
  start: number;
  end: number;
  /** Pattern id ("entropy" for the entropy detector); merged spans keep the first id. */
  id: string;
}

export interface SecretScan {
  text: string;
  count: number;
  /** Ranges of the ORIGINAL text that were replaced (for the held-secrets store at import). */
  spans: SecretSpan[];
}

export interface ScanOptions {
  /** Only the high-confidence patterns (import time). Default true. */
  highConfidenceOnly: boolean;
  /** Text written in place of each secret. Default SECRET_MARKER. */
  replacement: string;
  /** Run the entropy detector. Default: on when highConfidenceOnly is false. */
  entropy?: boolean;
}

/** Spans of `text` that hold secrets, sorted and merged (overlapping hits become one span). */
export function findSecrets(text: string, opts: Partial<ScanOptions> = {}): SecretSpan[] {
  const highOnly = opts.highConfidenceOnly ?? true;
  const hits: SecretSpan[] = [];
  if (text.length === 0) return hits;
  for (const p of COMPILED) {
    if (highOnly && !p.highConfidence) continue;
    for (const m of text.matchAll(p.re)) {
      if (m.index === undefined || m[0].length === 0) continue;
      if (p.group !== undefined) {
        const span = m.indices?.[p.group];
        if (span && span[1] > span[0]) hits.push({ start: span[0], end: span[1], id: p.id });
        continue;
      }
      hits.push({ start: m.index, end: m.index + m[0].length, id: p.id });
    }
  }
  if (opts.entropy ?? !highOnly) {
    for (const m of text.matchAll(LONG_TOKEN)) {
      if (m.index !== undefined && looksLikeRandomToken(m[0])) hits.push({ start: m.index, end: m.index + m[0].length, id: "entropy" });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretSpan[] = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.start < last.end) last.end = Math.max(last.end, h.end);
    else merged.push({ ...h });
  }
  return merged;
}

/** Replace detected secrets with `replacement`. Defaults: high-confidence patterns, the import marker. */
export function scanSecrets(text: string, opts: Partial<ScanOptions> = {}): SecretScan {
  const spans = findSecrets(text, opts);
  if (spans.length === 0) return { text, count: 0, spans };
  const replacement = opts.replacement ?? SECRET_MARKER;
  let out = "";
  let pos = 0;
  for (const h of spans) {
    out += text.slice(pos, h.start) + replacement;
    pos = h.end;
  }
  out += text.slice(pos);
  return { text: out, count: spans.length, spans };
}

/** True when `text` holds at least one secret (high-confidence patterns unless told otherwise). */
export function hasSecret(text: string, highConfidenceOnly = true): boolean {
  return findSecrets(text, { highConfidenceOnly }).length > 0;
}

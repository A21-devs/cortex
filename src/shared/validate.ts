/**
 * A small JSON-Schema-subset validator (draft-07 keywords only) used for model outputs (defence against prompt
 * injection: output is data, validated, never executed), protocol frames and on-disk records. The same schema
 * objects are passed to `claude --json-schema`. Owner: E1.
 *
 * Supported keywords: type (string or array, so `["string", "null"]` is nullable), enum, const, properties,
 * required, additionalProperties (boolean), items (one schema), minItems, maxItems, minLength, maxLength (in
 * Unicode code points, as JSON Schema defines), minimum, maximum, pattern (Unicode regex, compiled once), anyOf
 * (combined with the other keywords of the same schema), description (ignored).
 *
 * SAFE-15: only OWN properties count ("constructor" or "__proto__" never satisfy `required` through the
 * prototype chain), nesting is limited, and a schema with an invalid pattern fails closed (every string is
 * rejected) instead of throwing.
 */

export type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface JsonSchema {
  type?: JsonType | JsonType[];
  enum?: readonly (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  anyOf?: JsonSchema[];
  description?: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

/** Values nested deeper than this are rejected (a hostile reply cannot exhaust the stack). */
export const MAX_DEPTH = 64;

function typeOf(v: unknown): JsonType | "undefined" | "function" | "symbol" | "bigint" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v as JsonType;
}

function typeMatches(actual: string, wanted: JsonType): boolean {
  return actual === wanted || (wanted === "number" && actual === "integer");
}

const patternCache = new Map<string, RegExp | null>();

function compiled(pattern: string): RegExp | null {
  let re = patternCache.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern, "u");
    } catch {
      re = null;
    }
    if (patternCache.size > 500) patternCache.clear();
    patternCache.set(pattern, re);
  }
  return re;
}

/** Length in Unicode code points (a surrogate pair counts once). */
export function codePointLength(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}

function keyPath(path: string, key: string): string {
  return `${path}.${key}`;
}

function check(schema: JsonSchema, v: unknown, path: string, out: ValidationIssue[], limit: number, depth: number): void {
  if (out.length >= limit) return;
  if (depth > MAX_DEPTH) {
    out.push({ path, message: "nested too deeply" });
    return;
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => {
      const sub: ValidationIssue[] = [];
      check(s, v, path, sub, 1, depth + 1);
      return sub.length === 0;
    });
    if (!ok) {
      out.push({ path, message: "matches none of the allowed shapes" });
      return;
    }
  }
  const actual = typeOf(v);
  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wanted.some((w) => typeMatches(actual, w))) {
      out.push({ path, message: `expected ${wanted.join("|")}, got ${actual}` });
      return;
    }
  }
  if (schema.const !== undefined && v !== schema.const) out.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  if (schema.enum && !schema.enum.includes(v as string | number | boolean | null)) {
    out.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` });
  }
  if (actual === "string") {
    const s = v as string;
    if (schema.minLength !== undefined || schema.maxLength !== undefined) {
      const len = codePointLength(s);
      if (schema.minLength !== undefined && len < schema.minLength) out.push({ path, message: `shorter than ${schema.minLength}` });
      if (schema.maxLength !== undefined && len > schema.maxLength) out.push({ path, message: `longer than ${schema.maxLength}` });
    }
    if (schema.pattern !== undefined) {
      const re = compiled(schema.pattern);
      if (re === null) out.push({ path, message: "schema pattern is invalid" });
      else if (!re.test(s)) out.push({ path, message: `does not match ${schema.pattern}` });
    }
  }
  if (actual === "number" || actual === "integer") {
    const n = v as number;
    if (!Number.isFinite(n)) out.push({ path, message: "not a finite number" });
    if (schema.minimum !== undefined && n < schema.minimum) out.push({ path, message: `below ${schema.minimum}` });
    if (schema.maximum !== undefined && n > schema.maximum) out.push({ path, message: `above ${schema.maximum}` });
  }
  if (actual === "array") {
    const a = v as unknown[];
    if (schema.minItems !== undefined && a.length < schema.minItems) out.push({ path, message: `fewer than ${schema.minItems} items` });
    if (schema.maxItems !== undefined && a.length > schema.maxItems) {
      out.push({ path, message: `more than ${schema.maxItems} items` });
      return; // do not walk an oversized array
    }
    if (schema.items) {
      for (let i = 0; i < a.length && out.length < limit; i++) check(schema.items, a[i], `${path}[${i}]`, out, limit, depth + 1);
    }
  }
  if (actual === "object") {
    const o = v as Record<string, unknown>;
    for (const r of schema.required ?? []) {
      if (!Object.hasOwn(o, r)) out.push({ path: keyPath(path, r), message: "is required" });
    }
    const props = schema.properties ?? {};
    for (const k of Object.keys(o)) {
      if (out.length >= limit) return;
      const ps = Object.hasOwn(props, k) ? props[k] : undefined;
      if (ps) check(ps, o[k], keyPath(path, k), out, limit, depth + 1);
      else if (schema.additionalProperties === false) out.push({ path: keyPath(path, k), message: "is not allowed" });
    }
  }
}

/** Validate `value` against `schema`. Returns at most `limit` issues. */
export function validate<T>(schema: JsonSchema, value: unknown, limit = 20): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  check(schema, value, "$", issues, Math.max(1, limit), 0);
  return issues.length === 0 ? { ok: true, value: value as T } : { ok: false, issues: issues.slice(0, Math.max(1, limit)) };
}

/** True when `value` matches `schema` (stops at the first issue). */
export function isValid(schema: JsonSchema, value: unknown): boolean {
  const issues: ValidationIssue[] = [];
  check(schema, value, "$", issues, 1, 0);
  return issues.length === 0;
}

/** Human-readable one-line summary of issues (fed back to the model on a repair retry). */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `${i.path} ${i.message}`).join("; ");
}

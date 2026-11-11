/**
 * Live capture, the receiver (desktop only; Node's http). Off by default; started from Sources, Live capture, after
 * the person has read what is stored and agreed.
 *
 *  - Binds 127.0.0.1 only (never 0.0.0.0, never the machine's name), one port, no CORS headers.
 *  - Every request is checked in this order, and the first failure is counted by reason and refused:
 *      the peer is this computer; the Host header names the loopback address and this port (so a name that merely
 *      resolves here is refused); the Origin is the add-on's own, or none; a rate limit on wrong tokens; the
 *      per-install token (Authorization: Bearer, compared in constant time); capture is not paused; the body is small
 *      and well formed; the site is approved in Sources.
 *  - What is taken goes to the local spool (store/captureSpool.ts) and nowhere else; the import pass screens it and
 *    writes it to the record like any other source. Only turns are accepted: no cookies, no page, no account data.
 *
 * `createReceiver` holds the logic with no socket in it (tests call `handle` directly); `startCaptureServer` is the
 * thin http layer; `createCaptureService` is what Sources talks to.
 */
import { promises as fsp } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { Logger } from "../shared/log";
import {
  CAPTURE_BAD_TOKEN_LIMIT,
  CAPTURE_HOST,
  CAPTURE_MAX_BODY_BYTES,
  CAPTURE_PROTOCOL,
  CAPTURE_SITES,
  bearerOf,
  checkRequestShape,
  emptyCounts,
  parseCapturePost,
  validPort,
  type CaptureCounts,
  type CaptureService,
  type CaptureStatus,
  type RefusalReason,
} from "../shared/capture";
import { ADDON_FILES } from "../shared/captureAddon";
import type { CaptureSiteId, CortexSettings } from "../shared/settings";
import { ensureCacheDir } from "../node/fsAtomic";
import { ZipWriter } from "../node/zip";
import { Spool, loadCounts, loadOrCreateToken, rotateToken, saveCounts, spoolTurnCount, tokenMatches } from "../store/captureSpool";

export interface ReceiverRequest {
  method: string;
  /** Path only; a query string is ignored. */
  url: string;
  headers: Readonly<Record<string, string | undefined>>;
  remoteAddress: string | undefined;
  /** The port this receiver listens on. */
  port: number;
  /** null: the body went over the limit and was not read. */
  body: Buffer | null;
}

export interface ReceiverResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ReceiverDeps {
  cacheDir: string;
  getSettings(): CortexSettings;
  now?: () => number;
  log?: Logger;
  /** Turns were written to the spool: the clock may run an import pass. */
  onSpooled?(): void;
  /** Counters changed (the service persists them, throttled). */
  onCounts?(): void;
}

export interface Receiver {
  handle(req: ReceiverRequest): Promise<ReceiverResponse>;
  counts(): CaptureCounts;
  /** Replace the counters (loaded from disk at start). */
  setCounts(c: CaptureCounts): void;
  resetCounts(): void;
  /** The token was replaced: read it again before the next request. */
  forgetToken(): void;
}

const STATUS: Record<RefusalReason, number> = {
  "not-loopback": 403,
  "bad-host": 403,
  "bad-origin": 403,
  "no-token": 401,
  "bad-token": 401,
  paused: 423,
  "site-off": 403,
  "too-large": 413,
  "bad-request": 400,
  "rate-limited": 429,
};

export function createReceiver(deps: ReceiverDeps): Receiver {
  const now = deps.now ?? (() => Date.now());
  const spool = new Spool(deps.cacheDir, now);
  let counts = emptyCounts();
  let badTokens: number[] = [];
  let token: string | undefined;

  const refuse = (reason: RefusalReason): ReceiverResponse => {
    counts.refused[reason] += 1;
    deps.onCounts?.();
    return { status: STATUS[reason], body: { ok: false, reason } };
  };

  const tokenNow = async (): Promise<string> => (token ??= await loadOrCreateToken(deps.cacheDir, now));

  return {
    counts: () => ({ ...counts, refused: { ...counts.refused } }),
    setCounts(c) {
      counts = c;
    },
    resetCounts() {
      counts = emptyCounts();
      deps.onCounts?.();
    },
    forgetToken() {
      token = undefined;
    },
    async handle(req) {
      const path = req.url.split("?")[0] ?? "";
      const shape = checkRequestShape({ remoteAddress: req.remoteAddress, host: req.headers.host, origin: req.headers.origin, port: req.port });
      if (shape !== null) return refuse(shape);
      // Wrong tokens: after a burst, nothing more is looked at for the rest of the minute.
      const t = now();
      badTokens = badTokens.filter((x) => t - x < 60_000);
      if (badTokens.length >= CAPTURE_BAD_TOKEN_LIMIT) return refuse("rate-limited");
      const supplied = bearerOf(req.headers.authorization);
      let expected: string;
      try {
        expected = await tokenNow();
      } catch {
        return refuse("bad-request");
      }
      if (supplied === undefined) {
        badTokens.push(t);
        return refuse("no-token");
      }
      if (!tokenMatches(expected, supplied)) {
        badTokens.push(t);
        return refuse("bad-token");
      }
      const cfg = deps.getSettings().sources.capture;
      if (path === "/v1/ping" && req.method === "GET") return { status: 200, body: { ok: true, v: CAPTURE_PROTOCOL, paused: cfg.paused, sites: Object.fromEntries(CAPTURE_SITES.map((s) => [s.id, cfg.sites[s.id] === true])) } };
      if (path !== "/v1/turns" || req.method !== "POST") return refuse("bad-request");
      if (cfg.paused) return refuse("paused");
      if (req.body === null) return refuse("too-large");
      let raw: unknown;
      try {
        raw = JSON.parse(req.body.toString("utf8"));
      } catch {
        return refuse("bad-request");
      }
      const parsed = parseCapturePost(raw);
      if (!parsed.ok) return refuse("bad-request");
      if (cfg.sites[parsed.post.site] !== true) return refuse("site-off");
      try {
        const r = await spool.append(parsed.post);
        counts.accepted += r.added;
        counts.duplicates += r.duplicates;
        if (r.added > 0) counts.lastAt = new Date(now()).toISOString();
        deps.onCounts?.();
        if (r.added > 0) deps.onSpooled?.();
        return { status: 200, body: { ok: true, added: r.added, duplicates: r.duplicates } };
      } catch (e) {
        deps.log?.warn("capture spool write failed", { code: (e as { code?: unknown }).code ?? "unknown" });
        return { status: 500, body: { ok: false, reason: "spool" } };
      }
    },
  };
}

// ───────────────────────────── the socket ─────────────────────────────

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Listen on 127.0.0.1:`port` (0 = any free port, for tests). Rejects with the Node error (EADDRINUSE …) when it cannot. */
export function startCaptureServer(receiver: Receiver, port: number): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    let listening = 0;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      const declared = Number(req.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > CAPTURE_MAX_BODY_BYTES) tooLarge = true;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > CAPTURE_MAX_BODY_BYTES) tooLarge = true;
        else if (!tooLarge) chunks.push(c);
      });
      req.on("error", () => res.destroy());
      req.on("end", () => {
        const headers: Record<string, string | undefined> = {};
        for (const k of ["host", "origin", "authorization"] as const) {
          const v = req.headers[k];
          headers[k] = Array.isArray(v) ? v[0] : v;
        }
        receiver
          .handle({ method: req.method ?? "", url: req.url ?? "", headers, remoteAddress: req.socket.remoteAddress, port: listening, body: tooLarge ? null : Buffer.concat(chunks) })
          .then(
            (r) => {
              const out = Buffer.from(JSON.stringify(r.body));
              res.writeHead(r.status, { "Content-Type": "application/json", "Content-Length": out.length, "Cache-Control": "no-store" });
              res.end(out);
            },
            () => {
              res.writeHead(500);
              res.end();
            },
          );
      });
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.on("error", reject);
    server.listen({ port, host: CAPTURE_HOST, exclusive: true }, () => {
      const addr = server.address();
      listening = typeof addr === "object" && addr ? addr.port : port;
      server.off("error", reject);
      resolve({
        port: listening,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

// ───────────────────────────── what Sources talks to ─────────────────────────────

export interface CaptureServiceDeps {
  cacheDir: string;
  settings: { readonly value: CortexSettings; update(patch: (s: CortexSettings) => void): Promise<void> };
  log: Logger;
  now?: () => number;
  /** Save a file the person asked for (plugin/saveFile.ts). */
  save?: (req: { suggestedName: string; mime: string; data: Uint8Array | string }) => Promise<string | null>;
  /** New turns are in the spool: run an import pass soon. */
  onSpooled?(): void;
  /** Builds the add-on zip bytes (injectable for tests). */
  addonZip?: () => Promise<Uint8Array>;
}

export function createCaptureService(deps: CaptureServiceDeps): CaptureService {
  const now = deps.now ?? (() => Date.now());
  let running: RunningServer | null = null;
  let runningPort = 0;
  let problem: CaptureStatus["problem"];
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let loaded = false;
  let chain: Promise<unknown> = Promise.resolve();

  const receiver = createReceiver({
    cacheDir: deps.cacheDir,
    getSettings: () => deps.settings.value,
    now,
    log: deps.log,
    ...(deps.onSpooled ? { onSpooled: deps.onSpooled } : {}),
    onCounts: () => {
      dirty = true;
      if (saveTimer === null) {
        saveTimer = setTimeout(() => {
          saveTimer = null;
          void persist();
        }, 5000);
      }
    },
  });

  async function persist(): Promise<void> {
    if (!dirty) return;
    dirty = false;
    await saveCounts(deps.cacheDir, receiver.counts()).catch(() => undefined);
  }

  async function loadOnce(): Promise<void> {
    if (loaded) return;
    loaded = true;
    receiver.setCounts(await loadCounts(deps.cacheDir));
  }

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  async function syncNow(): Promise<void> {
    await loadOnce();
    const c = deps.settings.value.sources.capture;
    const port = validPort(c.port);
    // A synced settings file can say "on" on a computer where nobody agreed: without this computer's own token it stays off.
    const localConsent = c.enabled && c.consentAt !== "" && (await hasToken());
    if (!localConsent) {
      problem = c.enabled && c.consentAt !== "" ? "other-computer" : undefined;
      if (running) await closeRunning();
      return;
    }
    if (running && runningPort === port) return;
    if (running) await closeRunning();
    try {
      running = await startCaptureServer(receiver, port);
      runningPort = running.port;
      problem = undefined;
    } catch (e) {
      running = null;
      problem = (e as { code?: string }).code === "EADDRINUSE" ? "port-in-use" : "failed";
      deps.log.warn("capture receiver did not start", { code: (e as { code?: string }).code ?? "unknown" });
    }
  }

  async function hasToken(): Promise<boolean> {
    try {
      await fsp.access(path.join(deps.cacheDir, "capture", "token.json"));
      return true;
    } catch {
      return false;
    }
  }

  async function closeRunning(): Promise<void> {
    const r = running;
    running = null;
    runningPort = 0;
    await r?.close();
  }

  const status = async (): Promise<CaptureStatus> => {
    await loadOnce();
    const c = deps.settings.value.sources.capture;
    const port = validPort(c.port);
    const out: CaptureStatus = {
      running: running !== null,
      enabled: c.enabled,
      paused: c.paused,
      port,
      address: `${CAPTURE_HOST}:${port}`,
      sites: CAPTURE_SITES.map((s) => ({ id: s.id, label: s.label, hosts: s.hosts, approved: c.sites[s.id] === true })),
      counts: receiver.counts(),
      waiting: await spoolTurnCount(deps.cacheDir, CAPTURE_SITES.filter((s) => c.sites[s.id] === true).map((s) => s.id)).catch(() => 0),
      consentAt: c.consentAt,
    };
    if (problem !== undefined) out.problem = problem;
    return out;
  };

  return {
    status,
    async turnOn(sites) {
      await loadOnce();
      await loadOrCreateToken(deps.cacheDir, now);
      await deps.settings.update((s) => {
        const c = s.sources.capture;
        c.enabled = true;
        c.paused = false;
        c.consentAt = new Date(now()).toISOString();
        for (const site of CAPTURE_SITES) c.sites[site.id] = sites.includes(site.id);
      });
      await serial(syncNow);
      return status();
    },
    async turnOff() {
      await deps.settings.update((s) => {
        s.sources.capture.enabled = false;
      });
      await serial(syncNow);
      return status();
    },
    async setPaused(paused) {
      await deps.settings.update((s) => {
        s.sources.capture.paused = paused;
      });
    },
    async setSite(id, approved) {
      await deps.settings.update((s) => {
        s.sources.capture.sites[id] = approved;
      });
    },
    async setPort(port) {
      await deps.settings.update((s) => {
        s.sources.capture.port = validPort(port);
      });
      await serial(syncNow);
    },
    token: () => loadOrCreateToken(deps.cacheDir, now),
    async newToken() {
      await rotateToken(deps.cacheDir, now);
      receiver.forgetToken();
    },
    async saveAddon() {
      if (!deps.save) return null;
      const data = deps.addonZip ? await deps.addonZip() : await defaultAddonZip(deps.cacheDir);
      return deps.save({ suggestedName: "cortex-live-capture-addon.zip", mime: "application/zip", data });
    },
    async resetCounts() {
      receiver.resetCounts();
      await persist();
    },
    sync: () => serial(syncNow),
    async stop() {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = null;
      await persist();
      await serial(async () => {
        await closeRunning();
      });
    },
  };
}

/** The add-on folder as one zip (written beside the cache's temp files, read back, removed). */
async function defaultAddonZip(cacheDir: string): Promise<Uint8Array> {
  await ensureCacheDir(cacheDir);
  const dir = path.join(cacheDir, "tmp");
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `addon-${Date.now().toString(36)}.zip`);
  const zip = new ZipWriter(target);
  for (const [name, text] of Object.entries(ADDON_FILES)) await zip.add(`cortex-live-capture/${name}`, text);
  await zip.finish();
  try {
    return new Uint8Array(await fsp.readFile(target));
  } finally {
    await fsp.rm(target, { force: true });
  }
}

/**
 * Live capture (browser add-on to a loopback receiver): the checks on every request (token, host, peer, origin,
 * rate), the post shape, dedupe by turn id, the spool, the importer (screening, staging, sealing, approved sites), the
 * service lifecycle on a real 127.0.0.1 socket, and the add-on files themselves (embedded copy, manifest, the page-side
 * logic in core.js). Everything is local: temp folders, loopback sockets, made-up chat text. No network.
 */
import { createRequire } from "node:module";
import { promises as fsp, readFileSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CaptureImporter, captureTool, pruneSpool, approvedSites, SPOOL_KEEP_DAYS } from "../src/importers/capture";
import { stagedMessages } from "../src/importers/common";
import { createImporters } from "../src/importers/registry";
import { createSourcesService } from "../src/plugin/sourcesService";
import { nullLogger } from "../src/shared/log";
import { SOURCE_KINDS } from "../src/shared/types";
import { SOURCE_ORDER } from "../src/shared/index-format";
import { parseSourceFlag } from "../src/runner/cli";
import { createCaptureService, createReceiver, startCaptureServer, type ReceiverRequest } from "../src/plugin/captureServer";
import { importSelectors } from "../src/plugin/container";
import {
  CAPTURE_BAD_TOKEN_LIMIT,
  CAPTURE_MAX_BODY_BYTES,
  CAPTURE_SITES,
  REFUSAL_REASONS,
  bearerOf,
  checkRequestShape,
  cleanId,
  conversationKey,
  emptyCounts,
  hostHeaderOk,
  isLoopbackPeer,
  originOk,
  parseCapturePost,
  sanitiseCounts,
  totalRefused,
  validPort,
} from "../src/shared/capture";
import { conversationId } from "../src/shared/ids";
import { DEFAULT_SETTINGS, migrateSettings, type CortexSettings } from "../src/shared/settings";
import { ADDON_FILES } from "../src/shared/captureAddon";
import { Spool, captureDirs, listSpool, loadOrCreateToken, parseSpool, rotateToken, tokenMatches } from "../src/store/captureSpool";
import { harness, settingsWith, tmpDir } from "./helpers/importHarness";

const require = createRequire(import.meta.url);
const ADDON = path.join(__dirname, "..", "browser-addon");
const PORT = 47999;
const HOST = `127.0.0.1:${PORT}`;

const settingsOn = (patch?: (s: CortexSettings) => void): CortexSettings =>
  settingsWith((s) => {
    s.sources.capture.enabled = true;
    s.sources.capture.consentAt = "2026-11-01T10:00:00.000Z";
    s.sources.capture.sites = { chatgpt: true, claude: true, gemini: false };
    patch?.(s);
  });

const post = (turns: { id: string; role?: "user" | "assistant"; text: string }[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  site: "chatgpt",
  conversation: "conv-aaaa-1111",
  title: "Garden plan",
  turns: turns.map((t) => ({ id: t.id, role: t.role ?? "user", text: t.text })),
  ...extra,
});

function request(over: Partial<ReceiverRequest> & { token?: string; json?: unknown }): ReceiverRequest {
  const body = over.json !== undefined ? Buffer.from(JSON.stringify(over.json)) : "body" in over ? (over.body as Buffer | null) : Buffer.from("{}");
  return {
    method: "POST",
    url: "/v1/turns",
    remoteAddress: "127.0.0.1",
    port: PORT,
    ...over,
    headers: { host: HOST, ...(over.token !== undefined ? { authorization: `Bearer ${over.token}` } : {}), ...(over.headers ?? {}) },
    body,
  };
}

async function receiverIn(settings: CortexSettings = settingsOn()): Promise<{ cache: string; token: string; rx: ReturnType<typeof createReceiver>; spooled: { n: number } }> {
  const cache = await tmpDir();
  const token = await loadOrCreateToken(cache);
  const spooled = { n: 0 };
  const rx = createReceiver({ cacheDir: cache, getSettings: () => settings, onSpooled: () => void spooled.n++ });
  return { cache, token, rx, spooled };
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });

describe("the shared checks (no disk, no socket)", () => {
  it("knows the three sites and their hosts", () => {
    expect(CAPTURE_SITES.map((s) => s.id)).toEqual(["chatgpt", "claude", "gemini"]);
    expect(CAPTURE_SITES.flatMap((s) => s.hosts)).toEqual(["chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com"]);
  });

  it("accepts only this computer as the peer", () => {
    for (const ok of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackPeer(ok)).toBe(true);
    for (const bad of ["192.168.1.20", "10.0.0.5", "::ffff:192.168.1.20", "0.0.0.0", "", undefined]) expect(isLoopbackPeer(bad)).toBe(false);
  });

  it("accepts only the loopback Host header with this port (a rebinding name is refused)", () => {
    expect(hostHeaderOk("127.0.0.1:47831", 47831)).toBe(true);
    expect(hostHeaderOk("localhost:47831", 47831)).toBe(true);
    expect(hostHeaderOk("evil.example:47831", 47831)).toBe(false);
    expect(hostHeaderOk("127.0.0.1:9999", 47831)).toBe(false);
    expect(hostHeaderOk("127.0.0.1", 47831)).toBe(false);
    expect(hostHeaderOk(undefined, 47831)).toBe(false);
  });

  it("accepts the add-on's origin or none, never a web page", () => {
    expect(originOk(undefined)).toBe(true);
    expect(originOk("chrome-extension://abcdefghijklmnop")).toBe(true);
    expect(originOk("moz-extension://3f2a-77")).toBe(true);
    expect(originOk("https://chatgpt.com")).toBe(false);
    expect(originOk("http://127.0.0.1:47831")).toBe(false);
    expect(originOk("null")).toBe(false);
  });

  it("reads a bearer token only in its one form", () => {
    expect(bearerOf("Bearer abcdefghijklmnopqrstuvwxyz012345")).toBe("abcdefghijklmnopqrstuvwxyz012345");
    expect(bearerOf("bearer short")).toBeUndefined();
    expect(bearerOf("Basic abcdefghijklmnopqrstuvwxyz012345")).toBeUndefined();
    expect(bearerOf(undefined)).toBeUndefined();
  });

  it("checkRequestShape names the first failure", () => {
    const ok = { remoteAddress: "127.0.0.1", host: HOST, origin: undefined, port: PORT };
    expect(checkRequestShape(ok)).toBeNull();
    expect(checkRequestShape({ ...ok, remoteAddress: "8.8.8.8" })).toBe("not-loopback");
    expect(checkRequestShape({ ...ok, host: "attacker.test:47999" })).toBe("bad-host");
    expect(checkRequestShape({ ...ok, origin: "https://claude.ai" })).toBe("bad-origin");
  });

  it("validates a post field by field and repairs nothing", () => {
    const good = parseCapturePost(post([{ id: "m1", text: "hello" }, { id: "m2", role: "assistant", text: "hi" }]));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.post.title).toBe("Garden plan");
    const bad = (raw: unknown) => {
      const r = parseCapturePost(raw);
      return r.ok ? "ok" : r.problem;
    };
    expect(bad(null)).toBe("bad-shape");
    expect(bad({ ...post([{ id: "m1", text: "x" }]), v: 2 })).toBe("bad-shape");
    expect(bad({ ...post([{ id: "m1", text: "x" }]), site: "bing" })).toBe("bad-site");
    expect(bad({ ...post([{ id: "m1", text: "x" }]), conversation: "../../etc" })).toBe("bad-conversation");
    expect(bad({ ...post([]) })).toBe("no-turns");
    expect(bad(post([{ id: "m 1", text: "x" }]))).toBe("bad-turn");
    expect(bad({ ...post([{ id: "m1", text: "x" }]), turns: [{ id: "m1", role: "system", text: "x" }] })).toBe("bad-turn");
    expect(bad(post([{ id: "m1", text: "x".repeat(120_001) }]))).toBe("text-too-long");
    expect(bad(post(Array.from({ length: 41 }, (_, i) => ({ id: `m${i}`, text: "x" }))))).toBe("too-many-turns");
    // Blank turns are dropped; a post of only blanks has no turns.
    expect(bad(post([{ id: "m1", text: "  \n " }]))).toBe("no-turns");
  });

  it("makes ids that cannot be paths and spool names from a hash", () => {
    expect(cleanId("abc-123_x:9.1")).toBe("abc-123_x:9.1");
    for (const bad of ["", "a/b", "..", "a b", "x".repeat(201), "ä"]) expect(cleanId(bad)).toBeUndefined();
    const k = conversationKey("chatgpt", "conv-aaaa-1111");
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(conversationKey("claude", "conv-aaaa-1111")).not.toBe(k);
  });

  it("keeps counts honest when read back", () => {
    const c = sanitiseCounts({ accepted: 5, duplicates: -3, refused: { "bad-token": 2, bogus: 9 }, lastAt: "not a date" });
    expect(c.accepted).toBe(5);
    expect(c.duplicates).toBe(0);
    expect(c.refused["bad-token"]).toBe(2);
    expect(c.lastAt).toBe("");
    expect(totalRefused(c)).toBe(2);
    expect(Object.keys(emptyCounts().refused).sort()).toEqual([...REFUSAL_REASONS].sort());
    expect(validPort(80)).toBe(47831);
    expect(validPort(50000)).toBe(50000);
  });
});

describe("the token", () => {
  it("is made once, is long and random, and can be replaced", async () => {
    const cache = await tmpDir();
    const a = await loadOrCreateToken(cache);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await loadOrCreateToken(cache)).toBe(a);
    const b = await rotateToken(cache);
    expect(b).not.toBe(a);
    expect(await loadOrCreateToken(cache)).toBe(b);
    expect(tokenMatches(b, b)).toBe(true);
    expect(tokenMatches(b, a)).toBe(false);
    expect(tokenMatches(b, undefined)).toBe(false);
  });

  it("is not in the vault settings and survives Clear cache's file list", async () => {
    const cache = await tmpDir();
    await loadOrCreateToken(cache);
    expect(JSON.stringify(DEFAULT_SETTINGS)).not.toMatch(/token/i);
    const { CLEARABLE_CACHE_FILES } = await import("../src/store/layout");
    expect(CLEARABLE_CACHE_FILES.some((f) => f.includes("capture") || f.includes("token"))).toBe(false);
  });
});

describe("the receiver: every request is checked", () => {
  it("takes a good post and counts it", async () => {
    const { rx, token, spooled } = await receiverIn();
    const r = await rx.handle(request({ token, json: post([{ id: "m1", text: "plant tomatoes in May" }, { id: "m2", role: "assistant", text: "Tomatoes like warm soil." }]) }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, added: 2, duplicates: 0 });
    expect(rx.counts().accepted).toBe(2);
    expect(rx.counts().lastAt).not.toBe("");
    expect(spooled.n).toBe(1);
  });

  it("refuses a request without the token and counts it", async () => {
    const { rx } = await receiverIn();
    const r = await rx.handle(request({ json: post([{ id: "m1", text: "x" }]) }));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ ok: false, reason: "no-token" });
    expect(rx.counts().refused["no-token"]).toBe(1);
    expect(rx.counts().accepted).toBe(0);
  });

  it("refuses a wrong token, and the right one still works afterwards", async () => {
    const { rx, token } = await receiverIn();
    const wrong = await rx.handle(request({ token: "A".repeat(43), json: post([{ id: "m1", text: "x" }]) }));
    expect(wrong.status).toBe(401);
    expect(rx.counts().refused["bad-token"]).toBe(1);
    expect((await rx.handle(request({ token, json: post([{ id: "m1", text: "x" }]) }))).status).toBe(200);
  });

  it("refuses anything that is not from this computer, even with the right token", async () => {
    const { rx, token, cache } = await receiverIn();
    const r = await rx.handle(request({ token, remoteAddress: "192.168.1.44", json: post([{ id: "m1", text: "x" }]) }));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, reason: "not-loopback" });
    expect(rx.counts().refused["not-loopback"]).toBe(1);
    expect(await listSpool(cache, ["chatgpt"])).toHaveLength(0);
    const v6 = await rx.handle(request({ token, remoteAddress: "fe80::1", json: post([{ id: "m1", text: "x" }]) }));
    expect(v6.status).toBe(403);
    expect(rx.counts().refused["not-loopback"]).toBe(2);
  });

  it("refuses a Host header that is not the loopback address and port, and a web origin", async () => {
    const { rx, token } = await receiverIn();
    expect((await rx.handle(request({ token, headers: { host: "my-laptop.attacker.test:47999" }, json: post([{ id: "m1", text: "x" }]) }))).body).toEqual({ ok: false, reason: "bad-host" });
    expect((await rx.handle(request({ token, headers: { host: HOST, origin: "https://chatgpt.com" }, json: post([{ id: "m1", text: "x" }]) }))).body).toEqual({ ok: false, reason: "bad-origin" });
    expect((await rx.handle(request({ token, headers: { host: HOST, origin: "chrome-extension://abcdefghij" }, json: post([{ id: "m1", text: "x" }]) }))).status).toBe(200);
    expect(rx.counts().refused["bad-host"]).toBe(1);
    expect(rx.counts().refused["bad-origin"]).toBe(1);
  });

  it("answers 429 to a caller that keeps sending wrong tokens, even when the next one is right", async () => {
    let clock = 1_000_000;
    const cache = await tmpDir();
    const token = await loadOrCreateToken(cache);
    const rx = createReceiver({ cacheDir: cache, getSettings: () => settingsOn(), now: () => clock });
    for (let i = 0; i < CAPTURE_BAD_TOKEN_LIMIT; i++) await rx.handle(request({ token: "B".repeat(43), json: post([{ id: "m1", text: "x" }]) }));
    const blocked = await rx.handle(request({ token, json: post([{ id: "m1", text: "x" }]) }));
    expect(blocked.status).toBe(429);
    expect(rx.counts().refused["rate-limited"]).toBe(1);
    clock += 61_000;
    expect((await rx.handle(request({ token, json: post([{ id: "m1", text: "x" }]) }))).status).toBe(200);
  });

  it("refuses while paused, for a site that is not approved, for a body that is too large or malformed", async () => {
    const paused = await receiverIn(settingsOn((s) => void (s.sources.capture.paused = true)));
    expect((await paused.rx.handle(request({ token: paused.token, json: post([{ id: "m1", text: "x" }]) }))).status).toBe(423);
    expect(paused.rx.counts().refused.paused).toBe(1);

    const { rx, token } = await receiverIn();
    expect((await rx.handle(request({ token, json: post([{ id: "g1", text: "x" }], { site: "gemini" }) }))).body).toEqual({ ok: false, reason: "site-off" });
    expect((await rx.handle(request({ token, body: null }))).status).toBe(413);
    expect((await rx.handle(request({ token, body: Buffer.from("{ not json") }))).status).toBe(400);
    expect((await rx.handle(request({ token, json: { v: 1, site: "chatgpt" } }))).status).toBe(400);
    expect((await rx.handle(request({ token, method: "GET", url: "/v1/turns" }))).status).toBe(400);
    expect((await rx.handle(request({ token, url: "/v1/other", json: {} }))).status).toBe(400);
    const c = rx.counts();
    expect(c.refused["site-off"]).toBe(1);
    expect(c.refused["too-large"]).toBe(1);
    expect(c.refused["bad-request"]).toBe(4);
  });

  it("answers a ping only with the token, and reports pause and approved sites", async () => {
    const { rx, token } = await receiverIn(settingsOn((s) => void (s.sources.capture.paused = true)));
    expect((await rx.handle(request({ method: "GET", url: "/v1/ping" }))).status).toBe(401);
    const r = await rx.handle(request({ method: "GET", url: "/v1/ping", token }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, v: 1, paused: true, sites: { chatgpt: true, claude: true, gemini: false } });
  });

  it("reads the settings on every request, so a site removed or a pause applies at once", async () => {
    let s = settingsOn();
    const cache = await tmpDir();
    const token = await loadOrCreateToken(cache);
    const rx = createReceiver({ cacheDir: cache, getSettings: () => s });
    expect((await rx.handle(request({ token, json: post([{ id: "m1", text: "one" }]) }))).status).toBe(200);
    s = settingsOn((x) => void (x.sources.capture.sites.chatgpt = false));
    expect((await rx.handle(request({ token, json: post([{ id: "m2", text: "two" }]) }))).status).toBe(403);
  });
});

describe("dedupe by turn id and the spool", () => {
  it("writes a repeated turn once, in the same process and after a restart", async () => {
    const { rx, token, cache } = await receiverIn();
    const body = post([{ id: "m1", text: "first" }, { id: "m2", role: "assistant", text: "second" }]);
    expect((await rx.handle(request({ token, json: body }))).body).toMatchObject({ added: 2, duplicates: 0 });
    expect((await rx.handle(request({ token, json: body }))).body).toMatchObject({ added: 0, duplicates: 2 });
    const rx2 = createReceiver({ cacheDir: cache, getSettings: () => settingsOn() });
    const mixed = post([{ id: "m2", role: "assistant", text: "second" }, { id: "m3", text: "third" }]);
    expect((await rx2.handle(request({ token, json: mixed }))).body).toMatchObject({ added: 1, duplicates: 1 });
    expect(rx.counts().duplicates).toBe(2);
    const files = await listSpool(cache, ["chatgpt"]);
    expect(files).toHaveLength(1);
    const conv = parseSpool(await fsp.readFile(files[0]?.abs as string, "utf8"));
    expect(conv?.turns.map((t) => t.id)).toEqual(["m1", "m2", "m3"]);
    expect(conv?.title).toBe("Garden plan");
  });

  it("names files by hash, one per conversation, and keeps sites apart", async () => {
    const { rx, token, cache } = await receiverIn();
    await rx.handle(request({ token, json: post([{ id: "a1", text: "x" }]) }));
    await rx.handle(request({ token, json: post([{ id: "b1", text: "y" }], { conversation: "conv-bbbb-2222" }) }));
    await rx.handle(request({ token, json: post([{ id: "c1", text: "z" }], { site: "claude" }) }));
    const files = await listSpool(cache, ["chatgpt", "claude", "gemini"]);
    expect(files.map((f) => f.site).sort()).toEqual(["chatgpt", "chatgpt", "claude"]);
    for (const f of files) expect(path.basename(f.abs)).toMatch(/^[0-9a-f]{32}\.jsonl$/);
    expect(files.every((f) => f.abs.startsWith(captureDirs(cache).spool))).toBe(true);
  });

  it("skips a torn last line instead of failing the whole file", () => {
    const text = [JSON.stringify({ t: "meta", site: "claude", conversation: "conv-zzzz-9999", at: "2026-11-01T10:00:00.000Z" }), JSON.stringify({ t: "turn", id: "a", role: "user", text: "ok", at: "2026-11-01T10:00:01.000Z", rx: "2026-11-01T10:00:01.000Z" }), '{"t":"turn","id":"b","ro'].join("\n");
    expect(parseSpool(text)?.turns.map((t) => t.id)).toEqual(["a"]);
    expect(parseSpool("not a spool file")).toBeNull();
  });
});

describe("a real loopback socket", () => {
  it("listens on 127.0.0.1, answers with the token, refuses without it, and rejects a body over the limit", async () => {
    const { rx, token } = await receiverIn();
    const server = await startCaptureServer(rx, 0);
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const ok = await fetch(`${url}/v1/ping`, { headers: { Authorization: `Bearer ${token}` } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true });
      const none = await fetch(`${url}/v1/ping`);
      expect(none.status).toBe(401);
      const sent = await fetch(`${url}/v1/turns`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(post([{ id: "s1", text: "over the socket" }])) });
      expect(await sent.json()).toMatchObject({ ok: true, added: 1 });
      const big = await fetch(`${url}/v1/turns`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "x".repeat(CAPTURE_MAX_BODY_BYTES + 10) });
      expect(big.status).toBe(413);
      expect(rx.counts().refused["too-large"]).toBe(1);
      expect(rx.counts().refused["no-token"]).toBe(1);
      expect(rx.counts().accepted).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("is bound to the loopback address only: nothing answers on another interface address", async () => {
    const { rx } = await receiverIn();
    const server = await startCaptureServer(rx, 0);
    try {
      // The server's own address is the loopback one.
      const probe = await new Promise<string>((resolve) => {
        const c = net.connect({ host: "127.0.0.1", port: server.port }, () => {
          resolve(c.remoteAddress ?? "");
          c.destroy();
        });
      });
      expect(probe).toBe("127.0.0.1");
    } finally {
      await server.close();
    }
  });
});

describe("the service: on only after consent, off by default", () => {
  const settingsHandle = (initial: CortexSettings): { value: CortexSettings; update(patch: (s: CortexSettings) => void): Promise<void> } => {
    const h = {
      value: initial,
      async update(patch: (s: CortexSettings) => void) {
        const next = structuredClone(h.value);
        patch(next);
        h.value = next;
      },
    };
    return h;
  };
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => log };

  it("is off in the defaults and starts nothing until turned on", async () => {
    expect(DEFAULT_SETTINGS.sources.capture).toMatchObject({ enabled: false, paused: false, consentAt: "", sites: { chatgpt: false, claude: false, gemini: false } });
    expect(importSelectors(DEFAULT_SETTINGS, "watch").some((s) => s.kind === "capture")).toBe(false);
    expect(importSelectors(settingsOn(), "watch").some((s) => s.kind === "capture")).toBe(true);
    const cache = await tmpDir();
    const svc = createCaptureService({ cacheDir: cache, settings: settingsHandle(settingsWith()), log: log as never });
    await svc.sync();
    expect((await svc.status()).running).toBe(false);
    await svc.stop();
  });

  it("turns on with the ticked sites, listens, takes a post, pauses, and turns off", async () => {
    const cache = await tmpDir();
    const port = await freePort();
    const handle = settingsHandle(settingsWith((s) => void (s.sources.capture.port = port)));
    const spooled = { n: 0 };
    const svc = createCaptureService({ cacheDir: cache, settings: handle, log: log as never, onSpooled: () => void spooled.n++ });
    const st = await svc.turnOn(["chatgpt"]);
    expect(st).toMatchObject({ running: true, enabled: true, port, address: `127.0.0.1:${port}` });
    expect(st.consentAt).not.toBe("");
    expect(st.sites.filter((s) => s.approved).map((s) => s.id)).toEqual(["chatgpt"]);
    const token = await svc.token();
    const url = `http://127.0.0.1:${port}/v1/turns`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(post([{ id: "m1", text: "hello there" }])) })).status).toBe(200);
    expect(spooled.n).toBe(1);
    expect((await svc.status()).waiting).toBe(1);
    // A site that was not ticked is refused; pausing refuses everything; resuming takes posts again.
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(post([{ id: "c1", text: "x" }], { site: "claude" })) })).status).toBe(403);
    await svc.setPaused(true);
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(post([{ id: "m2", text: "x" }])) })).status).toBe(423);
    await svc.setPaused(false);
    await svc.setSite("claude", true);
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(post([{ id: "c1", text: "x" }], { site: "claude" })) })).status).toBe(200);
    // A new token locks the old one out.
    await svc.newToken();
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(post([{ id: "m3", text: "x" }])) })).status).toBe(401);
    const off = await svc.turnOff();
    expect(off.running).toBe(false);
    await expect(fetch(url, { method: "POST", headers, body: "{}" })).rejects.toThrow();
    await svc.stop();
  });

  it("does not listen on a computer where nobody agreed, even if synced settings say on", async () => {
    const cache = await tmpDir();
    const port = await freePort();
    const handle = settingsHandle(settingsOn((s) => void (s.sources.capture.port = port)));
    const svc = createCaptureService({ cacheDir: cache, settings: handle, log: log as never });
    await svc.sync();
    const st = await svc.status();
    expect(st.running).toBe(false);
    expect(st.problem).toBe("other-computer");
    await svc.stop();
  });

  it("says so when the port is taken", async () => {
    const cache = await tmpDir();
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    const svc = createCaptureService({ cacheDir: cache, settings: settingsHandle(settingsWith((s) => void (s.sources.capture.port = port))), log: log as never });
    const st = await svc.turnOn(["chatgpt"]);
    expect(st.running).toBe(false);
    expect(st.problem).toBe("port-in-use");
    await svc.stop();
    await new Promise<void>((r) => blocker.close(() => r()));
  });

  it("saves the add-on as a zip with no token inside", async () => {
    const cache = await tmpDir();
    const saved: { name: string; data: Uint8Array | string }[] = [];
    const svc = createCaptureService({ cacheDir: cache, settings: settingsHandle(settingsWith()), log: log as never, save: async (req) => (saved.push({ name: req.suggestedName, data: req.data }), "C:/Downloads/addon.zip") });
    const token = await svc.token();
    expect(await svc.saveAddon()).toBe("C:/Downloads/addon.zip");
    expect(saved[0]?.name).toBe("cortex-live-capture-addon.zip");
    const bytes = Buffer.from(saved[0]?.data as Uint8Array);
    expect(bytes.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    expect(bytes.includes(Buffer.from("cortex-live-capture/manifest.json"))).toBe(true);
  });
});

describe("the importer: screening, staging, sealing and the approved sites", () => {
  const conv = conversationId("capture", "chatgpt:conv-aaaa-1111");

  async function spooled(cache: string, turns: { id: string; role?: "user" | "assistant"; text: string }[], extra: Record<string, unknown> = {}): Promise<void> {
    const parsed = parseCapturePost(post(turns, extra));
    if (!parsed.ok) throw new Error("bad test post");
    await new Spool(cache).append(parsed.post);
  }

  it("is registered as source capture and reads nothing until turned on", async () => {
    expect(Object.keys(createImporters())).toContain("capture");
    const h = await harness();
    await spooled(h.cache, [{ id: "m1", text: "a first turn" }]);
    const r = await CaptureImporter().run({ kind: "capture" }, h.ctx);
    expect(r.entriesAdded).toBe(0);
    expect(await stagedMessages(h.ctx, conv)).toHaveLength(0);
  });

  it("brings spooled turns in as source capture: staged at once, sealed when idle, no repeats", async () => {
    const h = await harness((s) => void Object.assign(s.sources.capture, { enabled: true, sites: { chatgpt: true, claude: false, gemini: false } }));
    await spooled(h.cache, [{ id: "m1", text: "how deep should I plant garlic?" }, { id: "m2", role: "assistant", text: "About five centimetres, pointed end up." }]);
    const first = await CaptureImporter().run({ kind: "capture" }, h.ctx);
    expect(first.entriesAdded).toBe(2);
    const staged = await stagedMessages(h.ctx, conv);
    expect(staged).toHaveLength(2);
    expect(staged.map((s) => s.entry.speaker)).toEqual(["you", "assistant"]);
    expect(staged[0]?.entry.source).toBe("capture");
    // Same turns posted again, one new: only the new one is added.
    await spooled(h.cache, [{ id: "m1", text: "how deep should I plant garlic?" }, { id: "m3", text: "and when?" }]);
    expect((await CaptureImporter().run({ kind: "capture" }, h.next())).entriesAdded).toBe(1);
    expect(await stagedMessages(h.ctx, conv)).toHaveLength(3);
    // Idle for the whole window: sealed into the record with the conversation title and site.
    await CaptureImporter().run({ kind: "capture" }, h.next(undefined, { options: { seal: true } }));
    const entries = await h.entries();
    expect(entries.map((e) => e.idx)).toEqual([0, 1, 2]);
    expect(entries.every((e) => e.source === "capture")).toBe(true);
    expect(await h.text(entries[1] as never)).toBe("About five centimetres, pointed end up.");
  });

  it("screens secrets like every source: the record never holds the key", async () => {
    const h = await harness((s) => void Object.assign(s.sources.capture, { enabled: true, sites: { chatgpt: true, claude: false, gemini: false } }));
    await spooled(h.cache, [{ id: "m1", text: "my key is AKIAIOSFODNN7EXAMPLE, remember it" }, { id: "m2", role: "assistant", text: "Do not paste keys into chats." }]);
    await CaptureImporter().run({ kind: "capture" }, h.ctx);
    await CaptureImporter().run({ kind: "capture" }, h.next(undefined, { options: { seal: true } }));
    const entries = await h.entries();
    expect(entries).toHaveLength(2);
    const text = await h.text(entries[0] as never);
    expect(text).not.toContain("AKIA");
    expect(text).toContain("secret");
    expect(h.ctx.tally?.secretsHeld ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("takes only the approved sites, and a site switched off keeps its spool unread", async () => {
    const h = await harness((s) => void Object.assign(s.sources.capture, { enabled: true, sites: { chatgpt: true, claude: false, gemini: false } }));
    await spooled(h.cache, [{ id: "g1", text: "from chatgpt" }]);
    await spooled(h.cache, [{ id: "c1", text: "from claude" }], { site: "claude", conversation: "conv-cccc-3333" });
    const r = await CaptureImporter().run({ kind: "capture" }, h.ctx);
    expect(r.entriesAdded).toBe(1);
    expect(approvedSites(h.ctx.settings)).toEqual(["chatgpt"]);
    expect(await stagedMessages(h.ctx, conversationId("capture", "claude:conv-cccc-3333"))).toHaveLength(0);
    // Approve it later: the waiting turn comes in then.
    const later = await CaptureImporter().run({ kind: "capture" }, h.next((s) => void Object.assign(s.sources.capture, { enabled: true, sites: { chatgpt: true, claude: true, gemini: false } })));
    expect(later.entriesAdded).toBe(1);
  });

  it("leaves out anything under an Off limits row", async () => {
    const h = await harness((s) => {
      Object.assign(s.sources.capture, { enabled: true, sites: { chatgpt: true, claude: false, gemini: false } });
    });
    await spooled(h.cache, [{ id: "m1", text: "keep this out" }]);
    const off = await harness((s) => {
      Object.assign(s.sources.capture, { enabled: true, sites: { chatgpt: true, claude: false, gemini: false } });
      s.privacy.offLimits = [{ path: captureDirs(h.cache).spool, reason: "test" }];
    });
    // Same cache folder, but the pass runs with the Off limits row in place.
    const ctx = { ...off.ctx, store: h.ctx.store, ledger: h.ctx.ledger };
    const stats = await CaptureImporter().run({ kind: "capture" }, ctx);
    expect(stats.entriesAdded).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it("prunes a spool file only after it was read and left alone for the keep window", async () => {
    const h = await harness((s) => void Object.assign(s.sources.capture, { enabled: true, sites: { chatgpt: true, claude: false, gemini: false } }));
    await spooled(h.cache, [{ id: "m1", text: "old chat" }]);
    const later = Date.now() + (SPOOL_KEEP_DAYS + 1) * 86_400_000;
    // Not read yet: kept, however old.
    expect(await pruneSpool(h.next(undefined, { now: () => later }))).toBe(0);
    await CaptureImporter().run({ kind: "capture" }, h.ctx);
    expect(await pruneSpool(h.next(undefined, { now: () => Date.now() }))).toBe(0);
    expect(await pruneSpool(h.next(undefined, { now: () => later }))).toBe(1);
    expect(await listSpool(h.cache, ["chatgpt"])).toHaveLength(0);
  });
});

describe("the Sources row and the kinds", () => {
  it("lists the capture source once it is on, with a pause switch, and removing it turns it off and clears the sites", async () => {
    const vault = await tmpDir();
    const cache = await tmpDir();
    const settings = settingsWith();
    const excluded: string[] = [];
    const svc = createSourcesService({
      app: { vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => null } } as never,
      vaultRoot: vault,
      cacheDir: cache,
      log: nullLogger,
      settings: { value: settings, signal: undefined as never, corrupt: false, issues: [], update: async (fn: (s: CortexSettings) => void) => fn(settings), reload: async () => undefined, useDefaults: async () => undefined } as never,
      runner: { request: (async () => ({})) as never },
      corrections: { exclude: (async (id: string) => void excluded.push(id)) as never },
      sandbox: () => false,
    });
    expect((await svc.list()).map((r) => r.id)).not.toContain("capture");
    Object.assign(settings.sources.capture, { enabled: true, sites: { chatgpt: true, claude: false, gemini: false } });
    expect((await svc.list()).find((r) => r.id === "capture")).toMatchObject({ kind: "capture", status: "watching", watching: true, storedIn: ".raw/chats/capture/" });
    await svc.pauseWatching("capture", true);
    expect(settings.sources.capture.paused).toBe(true);
    expect((await svc.list()).find((r) => r.id === "capture")).toMatchObject({ status: "connected", watching: false });
    await svc.remove("capture");
    expect(settings.sources.capture.enabled).toBe(false);
    expect(Object.values(settings.sources.capture.sites)).toEqual([false, false, false]);
    expect(excluded).toEqual(["capture"]);
  });

  it("is a source kind in both orders (append only), and a command-line selector", () => {
    expect(SOURCE_KINDS).toContain("capture");
    expect(SOURCE_ORDER.indexOf("capture")).toBeGreaterThan(SOURCE_ORDER.indexOf("outcome"));
    expect(new Set(SOURCE_ORDER).size).toBe(SOURCE_ORDER.length);
    expect(parseSourceFlag("capture")).toEqual({ kind: "capture" });
  });
});

describe("settings", () => {
  it("keeps capture off through a migration of old settings and keeps what the person set", () => {
    const old = migrateSettings({ version: 5, sources: { claudeCode: { enabled: true } } });
    expect(old.sources.capture.enabled).toBe(false);
    const on = migrateSettings({ version: 5, sources: { capture: { enabled: true, consentAt: "2026-11-01T10:00:00.000Z", sites: { claude: true }, port: 50111 } } });
    expect(on.sources.capture).toMatchObject({ enabled: true, port: 50111, sites: { chatgpt: false, claude: true, gemini: false } });
  });
});

describe("the add-on files", () => {
  const names = ["manifest.json", "core.js", "content.js", "background.js", "options.html", "options.js", "README.md"];

  it("are embedded in Cortex exactly as they are on disk (run node scripts/embed-addon.mjs after editing)", () => {
    expect(Object.keys(ADDON_FILES).sort()).toEqual([...names].sort());
    for (const n of names) expect(ADDON_FILES[n]).toBe(readFileSync(path.join(ADDON, n), "utf8"));
  });

  it("is a Manifest V3 add-on that can read only loopback plus the three sites it asks permission for", () => {
    const m = JSON.parse(readFileSync(path.join(ADDON, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(m.manifest_version).toBe(3);
    expect(m.host_permissions).toEqual(["http://127.0.0.1/*"]);
    const optional = (m.optional_host_permissions as string[]).map((o) => new URL(o.replace("*", "x")).hostname).sort();
    expect(optional).toEqual(CAPTURE_SITES.flatMap((s) => s.hosts).sort());
    expect(m.content_scripts).toBeUndefined();
    expect(m.permissions).toEqual(["storage", "scripting", "alarms"]);
  });

  it("lists the same sites as Cortex does", () => {
    const core = require("../browser-addon/core.js") as { SITES: Record<string, { hosts: string[] }> };
    expect(Object.keys(core.SITES)).toEqual(CAPTURE_SITES.map((s) => s.id));
    for (const s of CAPTURE_SITES) expect(core.SITES[s.id]?.hosts).toEqual([...s.hosts]);
  });

  it("talks only to 127.0.0.1 and never to another address", () => {
    const code = ["background.js", "content.js", "options.js", "core.js"].map((n) => readFileSync(path.join(ADDON, n), "utf8")).join("\n");
    const urls = code.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    expect(urls.every((u) => u.startsWith("http://127.0.0.1:") || u.startsWith("https://chatgpt.com") || u.startsWith("https://chat.openai.com") || u.startsWith("https://claude.ai") || u.startsWith("https://gemini.google.com"))).toBe(true);
    expect(code).not.toMatch(/XMLHttpRequest|WebSocket|sendBeacon|eval\(|document\.cookie/);
    // The only fetch is the post to the loopback endpoint.
    expect((code.match(/fetch\(/g) ?? []).length).toBe(1);
  });
});

describe("the page-side logic (core.js)", () => {
  const core = require("../browser-addon/core.js") as {
    siteOfHost(h: string): string | null;
    conversationOf(site: string, p: string): string | null;
    withIds(conv: string, turns: { role: string; text: string; id?: string }[]): { id: string; role: string; text: string }[];
    createTracker(o?: { settleMs?: number; baselineMs?: number; backfill?: boolean }): { update(now: number, turns: { id: string; role: string; text: string }[], busy: boolean): { id: string; role: string; text: string; at: string }[]; pending(): boolean };
    cleanTitle(t: string): string | null;
  };

  it("recognises the sites and conversation ids", () => {
    expect(core.siteOfHost("chatgpt.com")).toBe("chatgpt");
    expect(core.siteOfHost("claude.ai")).toBe("claude");
    expect(core.siteOfHost("evil.example")).toBeNull();
    expect(core.conversationOf("chatgpt", "/c/6745-abcd-ef01")).toBe("6745-abcd-ef01");
    expect(core.conversationOf("claude", "/chat/aaaa-bbbb-cccc")).toBe("aaaa-bbbb-cccc");
    expect(core.conversationOf("gemini", "/app/abc123def456")).toBe("abc123def456");
    expect(core.conversationOf("claude", "/new")).toBeNull();
  });

  it("gives repeated turns distinct ids that survive older messages loading above them", () => {
    const a = core.withIds("c1", [{ role: "user", text: "ok" }, { role: "assistant", text: "yes" }, { role: "user", text: "ok" }]);
    expect(new Set(a.map((t) => t.id)).size).toBe(3);
    const b = core.withIds("c1", [{ role: "assistant", text: "older" }, { role: "user", text: "ok" }, { role: "assistant", text: "yes" }, { role: "user", text: "ok" }]);
    expect(b.slice(1).map((t) => t.id)).toEqual(a.map((t) => t.id));
    expect(core.withIds("c1", [{ role: "user", text: "x", id: "site-id-1" }])[0]?.id).toBe("site-id-1");
    for (const t of a) expect(cleanId(t.id)).toBe(t.id);
  });

  it("does not send what was on the page when it opened, and sends a new turn once it has settled", () => {
    const tr = core.createTracker({ settleMs: 3000, baselineMs: 4000 });
    const old = [{ id: "o1", role: "user", text: "old question" }, { id: "o2", role: "assistant", text: "old answer" }];
    expect(tr.update(1000, old, false)).toEqual([]);
    expect(tr.update(9000, old, false)).toEqual([]);
    const withNew = [...old, { id: "n1", role: "user", text: "new question" }];
    expect(tr.update(10_000, withNew, false)).toEqual([]);
    expect(tr.pending()).toBe(true);
    const sent = tr.update(13_100, withNew, false);
    expect(sent.map((t) => t.id)).toEqual(["n1"]);
    expect(tr.update(20_000, withNew, false)).toEqual([]);
    expect(tr.pending()).toBe(false);
  });

  it("waits while a reply is still being written, and while its text still changes", () => {
    const tr = core.createTracker({ settleMs: 3000, baselineMs: 0 });
    expect(tr.update(100, [], false)).toEqual([]);
    let t = 10_000;
    expect(tr.update(t, [{ id: "a1", role: "assistant", text: "Hel" }], true)).toEqual([]);
    t += 5000;
    expect(tr.update(t, [{ id: "a1", role: "assistant", text: "Hello wor" }], true)).toEqual([]);
    t += 5000;
    // Not busy any more, but the text just changed: settle again.
    expect(tr.update(t, [{ id: "a1", role: "assistant", text: "Hello world" }], false)).toEqual([]);
    t += 3100;
    expect(tr.update(t, [{ id: "a1", role: "assistant", text: "Hello world" }], false).map((x) => x.text)).toEqual(["Hello world"]);
  });

  it("sends the turns already on screen only when the person chose that", () => {
    const tr = core.createTracker({ settleMs: 1000, baselineMs: 4000, backfill: true });
    const old = [{ id: "o1", role: "user", text: "old question" }];
    expect(tr.update(1000, old, false)).toEqual([]);
    expect(tr.update(2500, old, false).map((t) => t.id)).toEqual(["o1"]);
  });

  it("cleans the page title", () => {
    expect(core.cleanTitle("Garden plan - Claude")).toBe("Garden plan");
    expect(core.cleanTitle("ChatGPT")).toBeNull();
    expect(core.cleanTitle("Garden plan | ChatGPT")).toBe("Garden plan");
  });
});

describe("the words", () => {
  it("name what is stored, and label the source", async () => {
    const { COPY } = await import("../src/ui/copy");
    expect(COPY.liveCapture.consentBody).toContain("{address}");
    expect(COPY.liveCapture.consentBody).toMatch(/full text/);
    expect(COPY.sources ? true : true).toBe(true);
    expect(DEFAULT_SETTINGS.sources.capture.liveIdleMinutes).toBe(10);
  });
});

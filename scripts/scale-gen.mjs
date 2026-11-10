// Synthetic record generator for the scale smoke test (scripts/scale.mjs, tests/scale*). Synthetic data only:
// nothing here reads a real vault, a real Claude Code session or a real export.
//
//   generate(root, opts) writes, under <root> (a throwaway folder):
//     notes/<area>/<sub>/<sub>/note-N.md         front matter + [[links]]; a few ~200 KB ones
//     .raw/docs/<a>/<b>/doc-N.md                 documents with headings
//     claude-projects/<slug>/<uuid>.jsonl        Claude Code sessions in the verified line shapes; a few ~20 MB
//     exports/chatgpt-export.zip                 conversations.json (branching mapping) in a stored+deflated zip
//     .obsidian/plugins/cortex/data.json         settings pointing the importers at the above
//     a git repo over notes/ and .raw/ with 2 commits
//   Sizes are options so tests can run a tiny version through the same code.
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const { deflateRawSync } = zlib;
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf);
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
};

const DAY = 86_400_000;
const T0 = Date.UTC(2025, 0, 1);

export function rng(seed0) {
  let seed = seed0 >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { rand, int: (n) => Math.floor(rand() * n), pick: (a) => a[Math.floor(rand() * a.length)] };
}

const TOPICS = ["importer", "renderer", "budget", "inventory", "home office plan", "report", "garden", "shader", "timeline", "privacy", "recipe", "travel plan", "reading list", "workout", "invoice"];
const WORDS = "the of and a to in is you that it he was for on are as with his they at be this from have or by one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know".split(" ");
const AREAS = [["projects", ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]], ["journal", ["2025", "2026"]], ["people", ["work", "family", "friends"]], ["ideas", ["code", "writing", "design", "money"]], ["reading", ["books", "papers", "articles"]]];

function sentence(r, n) {
  const w = [];
  for (let i = 0; i < n; i++) w.push(r.pick(WORDS));
  return `${w.join(" ")}.`;
}

function paragraph(r, sentences) {
  const s = [];
  for (let i = 0; i < sentences; i++) s.push(sentence(r, 8 + r.int(10)));
  return s.join(" ");
}

/** Write a file atomically-enough for a throwaway folder, with an mtime in the past (so nothing is "live"). */
function put(file, text, mtimeMs) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mtimeMs !== undefined) utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

function noteText(r, n, total, big) {
  const created = new Date(T0 + r.int(600) * DAY).toISOString().slice(0, 10);
  const title = `${r.pick(TOPICS)} ${n}`;
  const links = [];
  for (let i = 0; i < 2 + r.int(4); i++) links.push(`[[${r.pick(TOPICS)} ${r.int(total)}]]`);
  const head = `---\ntitle: "${title}"\ncreated: ${created}\ntags: [synthetic, ${r.pick(TOPICS).replace(/ /g, "-")}]\nstatus: ${r.rand() < 0.05 ? "reference" : "evergreen"}\n---\n\n# ${title}\n\n`;
  let body = "";
  if (big) {
    let h = 0;
    while (body.length < big) body += `## Section ${++h}\n\n${paragraph(r, 6)}\n\nSee ${r.pick(links)}.\n\n`;
  } else {
    body = `${paragraph(r, 3 + r.int(7))}\n\nRelated: ${links.join(", ")}\n`;
  }
  return head + body;
}

function docText(r, n, big) {
  let out = `# Document ${n}\n\n${paragraph(r, 3)}\n\n`;
  let h = 0;
  const limit = big ?? 1500 + r.int(2500);
  while (out.length < limit) out += `## Part ${++h}\n\n${paragraph(r, 5)}\n\n### Detail\n\n${paragraph(r, 3)}\n\n`;
  return out;
}

// ───────────────────────────── Claude Code sessions ─────────────────────────────

const uuidOf = (r) => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => (c === "x" ? r.int(16) : 8 + r.int(4)).toString(16));

/** Buffered synchronous line writer: big sessions are written in 1 MB slabs, never held whole. */
function lineWriter(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "w");
  let buf = [];
  let size = 0;
  const flush = () => {
    if (buf.length > 0) writeSync(fd, buf.join(""));
    buf = [];
    size = 0;
  };
  return {
    line(o) {
      const s = `${JSON.stringify(o)}\n`;
      buf.push(s);
      size += s.length;
      if (size > 1 << 20) flush();
    },
    bytes: () => size,
    close() {
      flush();
      closeSync(fd);
    },
  };
}

/** One session: typed prompts, thinking, answers, and (when `toolBytes`) a tool call + big tool result per turn. */
function writeSession(file, r, { turns, toolBytes, startMs, tiny }) {
  const sid = uuidOf(r);
  const w = lineWriter(file);
  let t = startMs;
  const iso = (x) => new Date(x).toISOString();
  w.line({ type: "permission-mode", permissionMode: "default", sessionId: sid });
  let parent = null;
  const topic = r.pick(TOPICS);
  const blob = toolBytes ? `${"line of tool output with some words and numbers 12345\n".repeat(Math.ceil(toolBytes / 56))}`.slice(0, toolBytes) : "";
  for (let m = 0; m < turns; m++) {
    t += 15_000 + r.int(300_000);
    const u = uuidOf(r);
    w.line({ type: "user", uuid: u, parentUuid: parent, timestamp: iso(t), sessionId: sid, cwd: "C:\\Users\\synthetic\\proj", gitBranch: "main", entrypoint: "cli", promptSource: "typed", turnOrigin: "human", origin: { kind: "human" }, message: { role: "user", content: tiny ? `q${m}` : `About the ${topic}: ${sentence(r, 12)} Question ${m}?` } });
    const mid = `msg_${u.slice(0, 12)}`;
    const a1 = uuidOf(r);
    w.line({ type: "assistant", uuid: a1, parentUuid: u, timestamp: iso(t + 400), sessionId: sid, message: { id: mid, role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "thinking", thinking: tiny ? "hm" : sentence(r, 30) }] } });
    const a2 = uuidOf(r);
    w.line({ type: "assistant", uuid: a2, parentUuid: a1, timestamp: iso(t + 800), sessionId: sid, message: { id: mid, role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: tiny ? `a${m}` : `For the ${topic}: ${paragraph(r, 2 + r.int(3))}` }] } });
    parent = a2;
    if (toolBytes) {
      const tid = `toolu_${m}`;
      const a3 = uuidOf(r);
      w.line({ type: "assistant", uuid: a3, parentUuid: a2, timestamp: iso(t + 1200), sessionId: sid, message: { id: mid, role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: tid, name: "Read", input: { file_path: `C:\\synthetic\\file-${m}.txt` } }] } });
      const ur = uuidOf(r);
      w.line({ type: "user", uuid: ur, parentUuid: a3, timestamp: iso(t + 1600), sessionId: sid, toolUseResult: { ok: true }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: blob }] } });
      parent = ur;
    }
  }
  w.line({ type: "ai-title", aiTitle: `Working on the ${topic}`, sessionId: sid });
  w.close();
  utimesSync(file, new Date(t), new Date(t));
  return { sid, endMs: t };
}

// ───────────────────────────── ChatGPT export zip ─────────────────────────────

function zipStore(members) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const m of members) {
    const raw = Buffer.from(m.data, "utf8");
    const body = m.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(m.name, "utf8");
    const crc = crc32(raw) >>> 0;
    const method = m.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

function chatgptConversation(r, i) {
  const base = T0 / 1000 + r.int(600) * 86_400;
  const mapping = { root: { id: "root", parent: null, children: ["m1"], message: null } };
  const turns = 4 + r.int(10);
  let parent = "root";
  let t = base;
  let last = "root";
  for (let k = 1; k <= turns; k++) {
    const id = `m${k}`;
    t += 10 + r.int(120);
    const user = k % 2 === 1;
    mapping[id] = {
      id,
      parent,
      children: k < turns ? [`m${k + 1}`] : [],
      message: { id, author: { role: user ? "user" : "assistant" }, create_time: t, content: { content_type: "text", parts: [user ? `${sentence(r, 10)} ${r.pick(TOPICS)}?` : paragraph(r, 3 + r.int(4))] }, metadata: user ? {} : { model_slug: "gpt-4o" } },
    };
    parent = id;
    last = id;
  }
  // a regenerated branch off the first answer, as real exports have
  if (turns >= 3) {
    mapping.m2.children.push("b1");
    mapping.b1 = { id: "b1", parent: "m2", children: [], message: { id: "b1", author: { role: "user" }, create_time: base + 500, content: { content_type: "text", parts: ["(earlier branch)"] }, metadata: {} } };
  }
  return { title: `Chat ${i} about ${r.pick(TOPICS)}`, create_time: base, update_time: t, conversation_id: `conv-${i}-${uuidOf(r).slice(0, 8)}`, current_node: last, mapping };
}

// ───────────────────────────── the whole thing ─────────────────────────────

/**
 * @param {string} root throwaway folder (will hold the vault, the projects folder and the export)
 * @param {{notes?: number, rawDocs?: number, bigNotes?: number, bigBytes?: number, sessions?: number, bigSessions?: number, bigSessionBytes?: number, conversations?: number, seed?: number, log?: (s: string) => void}} o
 */
export function generate(root, o = {}) {
  const NOTES = o.notes ?? 17_000;
  const RAW = o.rawDocs ?? 3_000;
  const BIG_NOTES = o.bigNotes ?? 6;
  const BIG_BYTES = o.bigBytes ?? 200 * 1024;
  const SESSIONS = o.sessions ?? 300;
  const BIG_SESSIONS = o.bigSessions ?? 3;
  const BIG_SESSION_BYTES = o.bigSessionBytes ?? 20 * 1024 * 1024;
  const CONVS = o.conversations ?? 1000;
  const log = o.log ?? (() => undefined);
  const r = rng(o.seed ?? 11);
  const vault = path.join(root, "vault");
  const projects = path.join(root, "claude-projects");
  const t0 = Date.now();
  const old = () => Date.now() - 3 * DAY - r.int(300) * DAY;

  // notes (user notes outside wiki/) and .raw documents
  const files = { notes: [], raw: [] };
  for (let n = 0; n < NOTES; n++) {
    const [area, subs] = r.pick(AREAS);
    const rel = `notes/${area}/${r.pick(subs)}/${(n % 40).toString(36)}/note-${n}.md`;
    put(path.join(vault, rel), noteText(r, n, NOTES, 0), old());
    files.notes.push(rel);
  }
  for (let n = 0; n < RAW; n++) {
    const rel = `.raw/docs/${r.pick(["a", "b", "c", "d"])}/${(n % 25).toString(36)}/doc-${n}.md`;
    put(path.join(vault, rel), docText(r, n), old());
    files.raw.push(rel);
  }
  for (let b = 0; b < BIG_NOTES; b++) {
    if (b % 2 === 0) put(path.join(vault, `notes/big/big-note-${b}.md`), noteText(r, 900_000 + b, NOTES, BIG_BYTES), old());
    else put(path.join(vault, `.raw/docs/big/big-doc-${b}.md`), docText(r, 900_000 + b, BIG_BYTES), old());
  }
  log(`notes+raw written (${NOTES + RAW + BIG_NOTES} files) in ${Date.now() - t0} ms`);

  // sessions
  const slugs = ["C--Users-synthetic-Notes", "C--Users-synthetic-Games", "C--Users-synthetic-Downloads"];
  const spaceMap = { [slugs[0]]: "vault", [slugs[1]]: "roblox", [slugs[2]]: "none" };
  const t1 = Date.now();
  let liveSession = "";
  for (let s = 0; s < SESSIONS; s++) {
    const big = s < BIG_SESSIONS;
    const slug = slugs[s % 2];
    // the first big one is chatty (tiny lines, tens of thousands of entries); the others are tool-heavy
    const chatty = big && s === 0;
    const toolBytes = big ? (chatty ? 0 : 8_000) : r.rand() < 0.4 ? 2_000 : 0;
    const perTurn = chatty ? 330 : toolBytes ? toolBytes + 1_100 : 1_100;
    const turns = big ? Math.round(BIG_SESSION_BYTES / perTurn) : 20 + r.int(120);
    const file = path.join(projects, slug, `${big ? "big" : "s"}-${s}-${uuidOf(r)}.jsonl`);
    if (!big && liveSession === "") liveSession = file;
    writeSession(file, r, { turns, toolBytes, startMs: T0 + 400 * DAY + r.int(250) * DAY, tiny: chatty });
  }
  log(`${SESSIONS} sessions written in ${Date.now() - t1} ms`);

  // ChatGPT export
  const t2 = Date.now();
  const convs = [];
  for (let c = 0; c < CONVS; c++) convs.push(chatgptConversation(r, c));
  const exp = path.join(root, "exports", "chatgpt-export.zip");
  mkdirSync(path.dirname(exp), { recursive: true });
  writeFileSync(
    exp,
    zipStore([
      { name: "conversations.json", data: JSON.stringify(convs), deflate: true },
      { name: "user.json", data: '{"id":"u","email":"private@example.invalid"}' },
      { name: "chat.html", data: "<html></html>" },
    ]),
  );
  log(`${CONVS} conversations zipped in ${Date.now() - t2} ms`);

  // settings (the importers read them; nothing else points outside the temp folder)
  put(
    path.join(vault, ".obsidian", "plugins", "cortex", "data.json"),
    JSON.stringify({ sources: { claudeCode: { projectsDir: projects, spaceMap } }, agents: { enabled: false } }, null, 2),
  );

  // git: two commits over notes/ and .raw/ (the settings and Obsidian's files stay untracked)
  const t3 = Date.now();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "nogitconfig"), GIT_CONFIG_SYSTEM: path.join(root, "nogitconfig"), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (args, date) => execFileSync("git", args, { cwd: vault, env: date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 28 });
  writeFileSync(path.join(root, "nogitconfig"), "");
  git(["init", "-q"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "gc.auto", "0"]);
  const cut = Math.floor(files.notes.length * 0.6);
  const first = [...files.notes.slice(0, cut), ...files.raw.slice(0, Math.floor(files.raw.length * 0.6))];
  const second = [...files.notes.slice(cut), ...files.raw.slice(Math.floor(files.raw.length * 0.6))];
  const addAll = (list) => {
    // a folder spans both commits, so feed exact paths on stdin
    // update-index takes exact paths (git add with a 20,000-entry pathspec list is quadratic and takes minutes)
    execFileSync("git", ["update-index", "--add", "--stdin"], { cwd: vault, env, input: `${list.join("\n")}\n`, stdio: ["pipe", "ignore", "pipe"], maxBuffer: 1 << 28 });
  };
  addAll(first);
  git(["commit", "-q", "-m", "first", "--no-gpg-sign"], "2025-03-01T10:00:00Z");
  addAll(second);
  addAll([...new Set(Array.from({ length: BIG_NOTES }, (_, b) => (b % 2 === 0 ? `notes/big/big-note-${b}.md` : `.raw/docs/big/big-doc-${b}.md`)))]);
  git(["commit", "-q", "-m", "second", "--no-gpg-sign"], "2025-09-01T10:00:00Z");
  log(`git repo with 2 commits in ${Date.now() - t3} ms`);

  return { vault, projects, zip: exp, files, spaceMap, liveSession, genMs: Date.now() - t0 };
}

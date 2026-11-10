// Write a synthetic record to a temporary folder for development (never the real vault).
//
//   node scripts/sample-data.mjs [--out <dir>] [--sessions 40] [--messages 30] [--notes 300] [--seed 7]
//
// Produces a throwaway "sample vault" shaped like the real one:
//   <out>/.obsidian/plugins/cortex/data.json      settings pointing the importers at the sample sources
//   <out>/.vault-meta/locks/                       lock folder (as in the real vault)
//   <out>/wiki/kb/…                                wiki notes with flat frontmatter (layer/type/status/created)
//   <out>/.raw/docs/*.md                           source documents with H2/H3 headings
//   <out>/.raw/roblox/...                          a reference document (hidden by default) and a stand-in API dump (skipped)
//   <out>/daily/*.md, <out>/ideas/*.md             your own notes outside wiki/ (one reference note, one with a fake secret)
//   <out>/sample-folder/*.md                       a folder source (Add sources › A folder of your own)
//   <out>/claude-projects/<slug>/<uuid>.jsonl      Claude Code transcripts using the verified line shapes
//   <out>/exports/chatgpt/conversations.json       ChatGPT export with branches
// Then: node dist/cortex-runner.js import --vault <out>   (once the importers are implemented)
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const num = (name, d) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const outArg = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : undefined;
const SESSIONS = num("--sessions", 40);
const MESSAGES = num("--messages", 30);
const NOTES = num("--notes", 300);
let seed = num("--seed", 7) >>> 0;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];
const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => (c === "x" ? Math.floor(rand() * 16) : 8 + Math.floor(rand() * 4)).toString(16));

const out = path.resolve(outArg ?? path.join(os.tmpdir(), `cortex-sample-${new Date().toISOString().replace(/[:.]/g, "-")}`));
if (out.toLowerCase().includes("onedrive")) {
  console.error("refusing to write sample data under OneDrive");
  process.exit(1);
}

const TOPICS = ["importer", "renderer", "budget", "roblox inventory", "home office plan", "trip notes", "garden", "shader", "timeline", "privacy"];
const AREAS = [
  ["kb/deep/roblox", "roblox"],
  ["kb/business", "money"],
  ["kb/deep/python", "code"],
  ["kb/web-frontend", "web"],
  ["kb/llms-genai", "ai"],
  ["kb/design", "design"],
  ["kb/life", "life"],
];
const SLUGS = ["C--Users-sample-Notes", "C--Users-sample-Games", "C--Users-sample-Downloads"];

async function write(rel, content) {
  const p = path.join(out, ...rel.split("/"));
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content);
}

const day0 = Date.UTC(2026, 6, 1);
const iso = (t) => new Date(t).toISOString();

// Claude Code transcripts
for (let s = 0; s < SESSIONS; s++) {
  const sid = uuid();
  const slug = pick(SLUGS);
  let t = day0 + Math.floor(rand() * 120) * 86_400_000 + Math.floor(rand() * 86_400_000);
  const topic = pick(TOPICS);
  const lines = [{ type: "permission-mode", permissionMode: "default", sessionId: sid }];
  let parent = null;
  for (let m = 0; m < MESSAGES; m++) {
    t += 20_000 + Math.floor(rand() * 600_000);
    const u = uuid();
    if (m % 2 === 0) {
      lines.push({ type: "user", uuid: u, parentUuid: parent, timestamp: iso(t), sessionId: sid, cwd: "C:\\Users\\sample", entrypoint: "cli", promptSource: "typed", turnOrigin: "human", origin: { kind: "human" }, message: { role: "user", content: `About the ${topic}: question ${m / 2 + 1}, what should change next?` } });
      lines.push({ type: "api-request-blob", sessionId: sid, hash: u.slice(0, 8), message: { role: "user", content: [{ type: "text", text: "(duplicate request content; never imported)" }] } });
    } else {
      const mid = `msg_${u.slice(0, 12)}`;
      lines.push({ type: "assistant", uuid: u, parentUuid: parent, timestamp: iso(t), sessionId: sid, message: { id: mid, role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "thinking", thinking: "(private reasoning)" }] } });
      lines.push({ type: "assistant", uuid: uuid(), parentUuid: u, timestamp: iso(t + 500), sessionId: sid, message: { id: mid, role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: `For the ${topic}, I would start with step ${m}. Decision: keep originals untouched.` }] } });
    }
    parent = u;
  }
  lines.push({ type: "ai-title", aiTitle: `Working on the ${topic}`, sessionId: sid });
  // The last session is still being written: its final line has no newline yet.
  const live = s === SESSIONS - 1;
  const tail = live ? `\n{"type":"user","uuid":"cut","message":{"role":"user","content":"half a li` : "\n";
  await write(`claude-projects/${slug}/${sid}.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n") + tail);
  if (s === 0) {
    // A subagent transcript (hidden by default) and an automated headless session (no person typed in it).
    await write(`claude-projects/${slug}/${sid}/subagents/agent-a1.jsonl`, JSON.stringify({ type: "user", uuid: uuid(), timestamp: iso(t), sessionId: sid, isSidechain: true, message: { role: "user", content: "Check the sample step." } }) + "\n");
    const auto = uuid();
    const autoLines = [
      { type: "user", uuid: uuid(), timestamp: iso(t), sessionId: auto, entrypoint: "sdk-cli", promptSource: "sdk", turnOrigin: "sdk", message: { role: "user", content: "Summarise this file." } },
      { type: "assistant", uuid: uuid(), timestamp: iso(t + 1000), sessionId: auto, message: { id: "msg_auto", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "A short summary." }] } },
    ];
    await write(`claude-projects/${slug}/${auto}.jsonl`, autoLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
}

// Wiki notes
for (let n = 0; n < NOTES; n++) {
  const [prefix] = pick(AREAS);
  const title = `${pick(TOPICS)} note ${n}`;
  const created = new Date(day0 + Math.floor(rand() * 90) * 86_400_000).toISOString().slice(0, 10);
  const status = prefix.includes("roblox") && rand() < 0.7 ? "reference" : "evergreen";
  const body = `---\ntype: note\ntitle: "${title}"\nstatus: ${status}\ncreated: ${created}\nupdated: ${created}\nlayer: ${3 + Math.floor(rand() * 4)}\ntags: [sample]\n---\n\n# ${title}\n\nA short synthetic note about ${pick(TOPICS)}. See [[${pick(TOPICS)} note ${Math.floor(rand() * NOTES)}]].\n`;
  await write(`wiki/${prefix}/sample-${n}.md`, body);
}

// .raw documents
for (let d = 0; d < 5; d++) {
  await write(`.raw/docs/doc-${d}.md`, `# Document ${d}\n\nIntro.\n\n## Part one\n\n${"Words about the topic. ".repeat(40)}\n\n## Part two\n\n${"More words. ".repeat(60)}\n`);
}

// Your own notes outside wiki/
for (let n = 0; n < 6; n++) {
  const day = new Date(day0 + n * 86_400_000).toISOString().slice(0, 10);
  await write(`daily/${day}.md`, `Daily note for ${day}. Thought about the ${pick(TOPICS)} today.\n`);
}
await write("ideas/reference-card.md", "---\nstatus: reference\n---\n# Reference card\n\nA note kept for lookup only.\n");
await write("ideas/with-key.md", "# Key note\n\nThe example key from the AWS docs is AKIAIOSFODNN7EXAMPLE (fake).\n");

// Reference documents and a stand-in for the API dump
await write(".raw/roblox/creator-docs/content/en-us/part.md", "# Part\n\nA synthetic reference page.\n\n## Properties\n\nAnchored and Size.\n");
await write(".raw/roblox/Full-API-Dump.json", JSON.stringify({ Version: 1, Classes: [] }));

// A folder source
await write("sample-folder/plan.md", "# Plan\n\nMy plan for the garden.\n");
await write("sample-folder/log.txt", "Planted peas.\n");

// ChatGPT export
const conv = { title: "Sample garden plan", create_time: day0 / 1000, update_time: day0 / 1000 + 600, conversation_id: uuid(), current_node: "n4", mapping: {
  root: { id: "root", parent: null, children: ["n1"], message: null },
  n1: { id: "n1", parent: "root", children: ["n2"], message: { id: "n1", author: { role: "user" }, create_time: day0 / 1000 + 10, content: { content_type: "text", parts: ["What grows well in spring?"] }, metadata: {} } },
  n2: { id: "n2", parent: "n1", children: ["n3", "n4"], message: { id: "n2", author: { role: "assistant" }, create_time: day0 / 1000 + 20, content: { content_type: "text", parts: ["Peas and lettuce."] }, metadata: { model_slug: "gpt-4o" } } },
  n3: { id: "n3", parent: "n2", children: [], message: { id: "n3", author: { role: "user" }, create_time: day0 / 1000 + 30, content: { content_type: "text", parts: ["(earlier branch)"] }, metadata: {} } },
  n4: { id: "n4", parent: "n2", children: [], message: { id: "n4", author: { role: "user" }, create_time: day0 / 1000 + 40, content: { content_type: "text", parts: ["And tomatoes?"] }, metadata: {} } },
} };
await write("exports/chatgpt/conversations.json", JSON.stringify([conv], null, 2));

// Vault scaffolding + settings that point the importers at the sample sources
await mkdir(path.join(out, ".vault-meta", "locks"), { recursive: true });
const settings = {
  sources: {
    claudeCode: { projectsDir: path.join(out, "claude-projects"), spaceMap: { "C--Users-sample-Notes": "vault", "C--Users-sample-Games": "roblox", "C--Users-sample-Downloads": "none" } },
  },
  agents: { enabled: false },
};
settings.sources.folders = [{ id: "sample", path: path.join(out, "sample-folder"), label: "Sample folder", extensions: ["md", "txt"], space: "life", watch: false, enabled: true }];
settings.you = { speakerBySource: { "folder:sample": "you" } };
await write(".obsidian/plugins/cortex/data.json", JSON.stringify(settings, null, 2));

console.log(JSON.stringify({ out, sessions: SESSIONS, messagesPerSession: MESSAGES, notes: NOTES, next: `node dist/cortex-runner.js import --vault "${out}"` }, null, 2));

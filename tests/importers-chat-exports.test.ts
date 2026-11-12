/**
 * Chat, notes and reading exports: WhatsApp, Telegram, Discord, Slack, Google Keep, Evernote, Roam, Kindle, Zoom.
 * Parsers on small invented fixtures (one per format), whole passes through the real store in temp folders
 * (zip, folder and single file), stable ids on a newer export, speakers, date strength, `import.inspect`,
 * and malformed input (it ends as a code, never as a throw). No network, no real data.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeText, parseCsv, speakerResolver, type ChatParseEnv, DataReader } from "../src/importers/chatExportKit";
import { discordTime } from "../src/importers/discord";
import { CHAT_EXPORT_DEFS } from "../src/importers/extra/chatExports";
import { EXTRA_GROUPS, extraImporters } from "../src/importers/extra";
import { inspectExport } from "../src/importers/inspect";
import { enexNotes, enmlText, keepNote, looksLikeRoam, parseEnexNote, roamDailyTitle } from "../src/importers/keepEvernoteRoam";
import { kindleDate, parseClippings, parseZoomChat, parseZoomTranscript, zoomStart } from "../src/importers/kindleZoom";
import { createImporters } from "../src/importers/registry";
import { slackText } from "../src/importers/slack";
import { telegramText } from "../src/importers/telegram";
import { dateOrder, isWhatsAppName, parseWhatsApp } from "../src/importers/whatsapp";
import { openExportSource } from "../src/importers/zip";
import { CHAT_EXPORT_KEYS } from "../src/shared/chatExportKinds";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { SOURCE_KINDS, type EntryRecord } from "../src/shared/types";
import { SOURCE_ORDER } from "../src/shared/index-format";
import { exportSources } from "../src/shared/exportDue";
import { EXPORT_SOURCE_COPY } from "../src/ui/copy";
import { createSourcesService } from "../src/plugin/sourcesService";
import { parseSourceFlag } from "../src/runner/cli";
import { nullLogger } from "../src/shared/log";
import type { CortexSettings } from "../src/shared/settings";
import { sourceLabel } from "../src/ui/valueLabels";
import { harness, tmpDir, writeZip, type Harness, type ZipMember } from "./helpers/importHarness";

const imp = (k: (typeof CHAT_EXPORT_KEYS)[number]) => createImporters()[k];
const sel = (kind: (typeof CHAT_EXPORT_KEYS)[number], file: string) => ({ kind, file }) as never;

async function writeFile(name: string, data: string | Buffer, dir?: string): Promise<string> {
  const d = dir ?? (await tmpDir());
  const file = path.join(d, name);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
  return file;
}

async function writeTree(files: Record<string, string>): Promise<string> {
  const d = await tmpDir();
  for (const [n, data] of Object.entries(files)) await writeFile(n, data, d);
  return d;
}

function env(patch?: (s: typeof DEFAULT_SETTINGS) => void): ChatParseEnv {
  const settings = structuredClone(DEFAULT_SETTINGS);
  patch?.(settings);
  const ac = new AbortController();
  return { settings, human: "you", signal: ac.signal, exportName: "export", reader: undefined as unknown as DataReader, exportTime: "2024-06-01T00:00:00.000Z" };
}

const dateOf = (e: EntryRecord, type = "source-timestamp") => e.dates.find((d) => d.type === type);

// ───────────────────────────── the kit ─────────────────────────────

describe("kit", () => {
  it("decodes byte-order marks and line ends", () => {
    expect(decodeText(Buffer.from("﻿a\r\nb\rc", "utf8"))).toBe("a\nb\nc");
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hé", "utf16le")]))).toBe("hé");
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("hé", "utf16le").swap16()]))).toBe("hé");
  });
  it("reads csv with quotes, commas and line breaks, and survives a stray quote", () => {
    expect(parseCsv('ID,Contents\n1,"a, ""b""\nc"\n2,plain\n')).toEqual([["ID", "Contents"], ["1", 'a, "b"\nc'], ["2", "plain"]]);
    expect(() => parseCsv('1,"never closed\n2,x')).not.toThrow();
    expect(parseCsv("")).toEqual([]);
  });
  it("names who spoke from Settings › You", () => {
    const who = speakerResolver(env((s) => void (s.you.names = ["Ana Lopez"])));
    expect(who(" ana lopez ")).toEqual({ speaker: "you" });
    expect(who("Ben")).toEqual({ speaker: "other", detail: "Ben" });
    expect(who("")).toEqual({ speaker: "other", detail: "Unknown" });
  });
  it("is registered once per kind, in settings, the sheet and the index order", () => {
    expect(Object.keys(extraImporters()).sort()).toEqual(expect.arrayContaining([...CHAT_EXPORT_KEYS]));
    expect(EXTRA_GROUPS.map((g) => g.name)).toContain("chatExports");
    for (const k of CHAT_EXPORT_KEYS) {
      expect(DEFAULT_SETTINGS.sources.chatExports[k].enabled).toBe(true);
      expect(SOURCE_KINDS).toContain(k);
      expect(SOURCE_ORDER).toContain(k);
      expect(createImporters()[k].source).toBe(k);
      expect(exportSources().some((s) => s.id === k)).toBe(true);
      expect(EXPORT_SOURCE_COPY[k]?.how.length).toBeGreaterThan(10);
    }
    expect(CHAT_EXPORT_DEFS.map((d) => d.key).sort()).toEqual([...CHAT_EXPORT_KEYS].sort());
  });
});

// ───────────────────────────── WhatsApp ─────────────────────────────

const WA_ANDROID = `12/03/2024, 14:05 - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.
12/03/2024, 14:05 - Ana: Hi there
second line of the same message
12/03/2024, 14:06 - Ben: <Media omitted>
13/03/2024, 09:00 - Ben: IMG-20240313-WA0001.jpg (file attached)
Look at this
13/03/2024, 09:01 - Ana: You deleted this message
13/03/2024, 09:02 - Ana joined using this group's invite link
`;

const WA_IOS = `‎[3/12/24, 2:05:09 PM] Ana: Dinner at 8?
[3/13/24, 9:00:00 AM] Ben: ‎<attached: 00000012-PHOTO-2024-03-13.jpg>
`;

describe("WhatsApp", () => {
  it("recognises the file names WhatsApp writes", () => {
    expect(isWhatsAppName("WhatsApp Chat with Ben.txt")).toBe(true);
    expect(isWhatsAppName("x/_chat.txt")).toBe(true);
    expect(isWhatsAppName("notes.txt")).toBe(false);
  });
  it("reads the Android layout, joins continuation lines and drops notices", () => {
    const c = parseWhatsApp(WA_ANDROID, "Ben", env(() => undefined));
    expect(c?.turns.map((t) => [t.speakerDetail, t.text])).toEqual([
      ["Ana", "Hi there\nsecond line of the same message"],
      ["Ben", "Look at this"],
    ]);
    expect(c?.turns[1]?.attachments?.[0]).toMatchObject({ name: "IMG-20240313-WA0001.jpg", mime: "image/jpeg" });
    // 13/03 can only be day first: no guess, medium strength.
    expect(c?.turns[0]).toMatchObject({ at: "2024-03-12T14:05:00.000Z", atStrength: "medium" });
  });
  it("reads the iPhone layout with 12-hour times and month first", () => {
    const c = parseWhatsApp(WA_IOS, "Ben", env());
    expect(c?.turns[0]?.at).toBe("2024-03-12T14:05:09.000Z");
    expect(c?.turns[1]).toMatchObject({ at: "2024-03-13T09:00:00.000Z", text: "" });
    expect(c?.turns[1]?.attachments?.[0]?.name).toBe("00000012-PHOTO-2024-03-13.jpg");
  });
  it("marks the date weak when day and month cannot be told apart", () => {
    expect(dateOrder([{ a: 3, b: 4 }], false)).toEqual({ order: "dmy", guessed: true });
    expect(dateOrder([{ a: 3, b: 4 }, { a: 20, b: 4 }], false)).toEqual({ order: "dmy", guessed: false });
    expect(dateOrder([{ a: 3, b: 4 }, { a: 4, b: 20 }], false)).toEqual({ order: "mdy", guessed: false });
    const c = parseWhatsApp("1/2/2024, 10:00 - Ana: hi\n", "X", env());
    expect(c?.turns[0]).toMatchObject({ atStrength: "weak", at: "2024-02-01T10:00:00.000Z" });
  });
  it("gives repeated identical lines their own stable ids", () => {
    const c = parseWhatsApp("1/2/2024, 10:00 - Ana: ok\n1/2/2024, 10:00 - Ana: ok\n", "X", env());
    expect(c?.turns).toHaveLength(2);
    expect(new Set(c?.turns.map((t) => t.key)).size).toBe(2);
  });
  it("imports a zip, marks the person's own lines, and adds only new lines from a newer export", async () => {
    const h = await harness((s) => void (s.you.names = ["Ana"]));
    const file = await writeZip([{ name: "WhatsApp Chat with Ben.txt", data: WA_ANDROID, deflate: true }, { name: "IMG-20240313-WA0001.jpg", data: "not read" }]);
    const stats = await imp("whatsapp").run(sel("whatsapp", file), h.ctx);
    expect(stats.errors).toEqual([]);
    expect(stats.entriesAdded).toBe(2);
    const es = await h.entries();
    expect(es.map((e) => [e.speaker, e.speakerDetail ?? null])).toEqual([["you", null], ["other", "Ben"]]);
    expect(await h.text(es[0] as EntryRecord)).toBe("Hi there\nsecond line of the same message");
    expect(dateOf(es[0] as EntryRecord)?.strength).toBe("medium");
    expect(es[1]?.attachments?.[0]?.name).toBe("IMG-20240313-WA0001.jpg");
    const again = await imp("whatsapp").run(sel("whatsapp", await writeZip([{ name: "WhatsApp Chat with Ben.txt", data: WA_ANDROID }])), h.next());
    expect(again.entriesAdded).toBe(0);
    const newer = WA_ANDROID + "14/03/2024, 10:00 - Ana: A new line\n";
    const more = await imp("whatsapp").run(sel("whatsapp", await writeZip([{ name: "WhatsApp Chat with Ben.txt", data: newer }])), h.next());
    expect(more.entriesAdded).toBe(1);
    expect(await h.entries()).toHaveLength(3);
  });
});

// ───────────────────────────── Telegram ─────────────────────────────

const TG_CHAT = {
  name: "Ben",
  type: "personal_chat",
  id: 4242,
  messages: [
    { id: 1, type: "service", date: "2024-03-01T10:00:00", actor: "Ben", action: "phone_call" },
    { id: 2, type: "message", date: "2024-03-01T10:15:00", date_unixtime: "1709288100", from: "Ben", from_id: "user7", text: "Hello" },
    { id: 3, type: "message", date: "2024-03-01T10:16:00", date_unixtime: "1709288160", from: "Ana Lopez", from_id: "user99", text: ["See ", { type: "link", text: "this link" }, "!"] },
    { id: 4, type: "message", date: "2024-03-01T10:17:00", from: "Ben", from_id: "user7", text: "", photo: "(File not included. Change data exporting settings to download.)", file_name: "pic.jpg" },
    { id: 5, type: "message", date: "2024-03-01T10:18:00", from: "Ben", from_id: "user7", text: "" },
  ],
};

describe("Telegram", () => {
  it("flattens text entities", () => {
    expect(telegramText(["a", { type: "bold", text: "b" }, 3])).toBe("ab");
    expect(telegramText(undefined)).toBe("");
  });
  it("reads one chat: service lines out, exact and as-printed dates", async () => {
    const h = await harness();
    const file = await writeFile("result.json", JSON.stringify(TG_CHAT));
    const stats = await imp("telegram").run(sel("telegram", file), h.ctx);
    expect(stats.errors).toEqual([]);
    const es = await h.entries();
    expect(es.map((e) => e.speakerDetail)).toEqual(["Ben", "Ana Lopez", "Ben"]);
    expect(await h.text(es[1] as EntryRecord)).toBe("See this link!");
    expect(dateOf(es[0] as EntryRecord)).toMatchObject({ strength: "strong", at: "2024-03-01T10:15:00.000Z" });
    expect(dateOf(es[2] as EntryRecord)).toMatchObject({ strength: "medium", at: "2024-03-01T10:17:00.000Z" });
    expect(es[2]?.attachments?.[0]?.name).toBe("pic.jpg");
  });
  it("reads a whole-account export and knows the owner from personal_information", async () => {
    const h = await harness();
    const full = {
      personal_information: { user_id: 99, first_name: "Ana", last_name: "Lopez" },
      chats: { list: [TG_CHAT, { name: "Saved messages", type: "saved_messages", id: 1, messages: [{ id: 1, type: "message", date: "2024-02-01T08:00:00", date_unixtime: "1706774400", from: "Ana Lopez", from_id: "user99", text: "note to self" }] }] },
    };
    const dir = await writeTree({ "ChatExport/result.json": JSON.stringify(full) });
    const stats = await imp("telegram").run(sel("telegram", dir), h.ctx);
    expect(stats.conversationsTouched).toBe(2);
    const es = await h.entries();
    expect(es.filter((e) => e.speaker === "you")).toHaveLength(2); // Ana's line in Ben's chat and the saved message
  });
});

// ───────────────────────────── Discord ─────────────────────────────

describe("Discord", () => {
  it("reads timestamps with and without an offset", () => {
    expect(discordTime("2024-03-01 10:15:00.123456+00:00")).toEqual({ at: "2024-03-01T10:15:00.123Z", strength: "strong" });
    expect(discordTime("2024-03-01T10:15:00+02:00").at).toBe("2024-03-01T08:15:00.000Z");
    expect(discordTime("2024-03-01 10:15:00")).toEqual({ at: "2024-03-01T10:15:00.000Z", strength: "medium" });
    expect(discordTime("garbage").at).toBeUndefined();
  });
  it("imports channels from csv and json, with names, server and attachment names", async () => {
    const h = await harness();
    const dir = await writeTree({
      "package/messages/index.json": JSON.stringify({ "111": "general in Cortex Club", "222": "Direct Message with Ben" }),
      "package/messages/c111/channel.json": JSON.stringify({ id: "111", type: 0, name: "general", guild: { id: "9", name: "Cortex Club" } }),
      "package/messages/c111/messages.csv": 'ID,Timestamp,Contents,Attachments\n10,2024-03-01 10:15:00.000000+00:00,"hello, ""world""\nsecond line",\n11,2024-03-01 10:16:00+00:00,,https://cdn.example.com/a/file%20one.png?ex=1\n',
      "package/messages/c222/channel.json": JSON.stringify({ id: "222", type: 1 }),
      "package/messages/c222/messages.json": JSON.stringify([{ ID: 20, Timestamp: "2024-03-02 09:00:00+00:00", Contents: "hi Ben", Attachments: "" }]),
    });
    const stats = await imp("discord").run(sel("discord", dir), h.ctx);
    expect(stats.errors).toEqual([]);
    expect(stats.conversationsTouched).toBe(2);
    const es = await h.entries();
    expect(es).toHaveLength(3);
    expect(es.every((e) => e.speaker === "you")).toBe(true);
    const first = es.find((e) => e.project === "Cortex Club" && e.idx === 0) as EntryRecord;
    expect(await h.text(first)).toBe('hello, "world"\nsecond line');
    expect(es.find((e) => e.attachments?.length)?.attachments?.[0]?.name).toBe("file one.png");
  });
});

// ───────────────────────────── Slack ─────────────────────────────

describe("Slack", () => {
  it("turns markup into text", () => {
    const users = new Map([["U1", "ana"]]);
    const chans = new Map([["C1", "general"]]);
    expect(slackText("hi <@U1> in <#C1> <!here> <https://x.example/a|the doc> &lt;ok&gt; &amp;", users, chans)).toBe("hi @ana in #general @here the doc (https://x.example/a) <ok> &");
  });
  it("imports channels in time order, skips joins, names senders", async () => {
    const h = await harness((s) => void (s.you.names = ["ana"]));
    const members: ZipMember[] = [
      { name: "users.json", data: JSON.stringify([{ id: "U1", name: "ana", profile: { display_name: "ana" } }, { id: "U2", name: "ben", real_name: "Ben Ruiz", profile: { display_name: "" } }]) },
      { name: "channels.json", data: JSON.stringify([{ id: "C1", name: "general" }]) },
      { name: "general/2024-03-02.json", data: JSON.stringify([{ type: "message", user: "U2", text: "second day <@U1>", ts: "1709373600.000100" }]), deflate: true },
      { name: "general/2024-03-01.json", data: JSON.stringify([{ type: "message", subtype: "channel_join", user: "U2", text: "joined", ts: "1709287000.000100" }, { type: "message", user: "U1", text: "first", ts: "1709287500.000200", files: [{ name: "plan.pdf", mimetype: "application/pdf", size: 10 }] }]) },
    ];
    const stats = await imp("slack").run(sel("slack", await writeZip(members)), h.ctx);
    expect(stats.errors).toEqual([]);
    const es = await h.entries();
    expect(es).toHaveLength(2);
    expect(es.map((e) => [e.speaker, e.speakerDetail ?? null])).toEqual([["you", null], ["other", "Ben Ruiz"]]);
    expect(await h.text(es[1] as EntryRecord)).toBe("second day @ana");
    expect(dateOf(es[0] as EntryRecord)).toMatchObject({ strength: "strong", at: "2024-03-01T10:05:00.000Z" });
    expect(es[0]?.attachments?.[0]?.name).toBe("plan.pdf");
  });
  it("keeps going past a damaged day file", async () => {
    const h = await harness();
    const dir = await writeTree({ "random/2024-03-01.json": "{not json", "random/2024-03-02.json": JSON.stringify([{ type: "message", user: "U9", text: "survived", ts: "1709373600.000100" }]) });
    const stats = await imp("slack").run(sel("slack", dir), h.ctx);
    expect(stats.entriesAdded).toBe(1);
  });
});

// ───────────────────────────── Keep, Evernote, Roam ─────────────────────────────

const ENEX = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20240601T000000Z" application="Evernote">
<note><title>Shopping &amp; errands</title><content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>Buy milk</div><div><en-todo checked="true"/>eggs</div><div><en-todo/>bread</div><en-media hash="abc" type="image/png"/><en-crypt hint="h">SECRETCIPHER</en-crypt></en-note>]]></content><created>20240301T101500Z</created><updated>20240302T080000Z</updated><tag>home</tag><resource><data encoding="base64">AAAAAAAAAAAA</data><mime>image/png</mime><resource-attributes><file-name>receipt.png</file-name></resource-attributes></resource></note>
<note><title>Only an edit time</title><content><![CDATA[<en-note>plain</en-note>]]></content><updated>20240303T090000Z</updated></note>
</en-export>`;

describe("Google Keep", () => {
  it("reads text, lists and links, and leaves trashed notes out", () => {
    expect(keepNote({ isTrashed: true, textContent: "gone" })).toBeNull();
    const n = keepNote({ title: "Groceries", listContent: [{ text: "milk", isChecked: true }, { text: "tea", isChecked: false }], annotations: [{ url: "https://example.com/a" }], createdTimestampUsec: 1709288100000000, userEditedTimestampUsec: 1709374500000000, labels: [{ name: "Home" }] });
    expect(n).toMatchObject({ title: "Groceries", text: "- [x] milk\n- [ ] tea\nLink: https://example.com/a", created: "2024-03-01T10:15:00.000Z", label: "Home" });
    expect(keepNote({})).toBeNull();
  });
  it("imports a Takeout folder with versions on a changed note", async () => {
    const note = (text: string) => JSON.stringify({ title: "Idea", textContent: text, createdTimestampUsec: 1709288100000000, userEditedTimestampUsec: 1709288100000000, labels: [{ name: "Work" }] });
    const dir = await writeTree({ "Takeout/Keep/Idea.json": note("first wording"), "Takeout/Keep/Gone.json": JSON.stringify({ title: "x", textContent: "y", isTrashed: true }), "Takeout/Keep/Labels.txt": "Work" });
    const h = await harness();
    const stats = await imp("keep").run(sel("keep", dir), h.ctx);
    expect(stats.errors).toEqual([]);
    let es = await h.entries();
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ kind: "document", title: "Idea", project: "Work", speaker: "you" });
    expect(dateOf(es[0] as EntryRecord)).toMatchObject({ strength: "strong", at: "2024-03-01T10:15:00.000Z" });
    await fsp.writeFile(path.join(dir, "Takeout/Keep/Idea.json"), note("second wording"));
    const again = await imp("keep").run(sel("keep", dir), h.next());
    expect(again.entriesAdded).toBe(1);
    es = await h.entries();
    expect(es).toHaveLength(2);
    expect(es.filter((e) => e.supersedes !== undefined)).toHaveLength(1);
    const same = await imp("keep").run(sel("keep", dir), h.next());
    expect(same.entriesAdded).toBe(0);
  });
  it("imports when the Keep folder itself was chosen (notes with their .html twins, no Keep/ in the paths)", async () => {
    const dir = await writeTree({ "Idea.json": JSON.stringify({ title: "Idea", textContent: "x", createdTimestampUsec: 1709288100000000 }), "Idea.html": "<html></html>", "result.json": "{}" });
    const h = await harness();
    const stats = await imp("keep").run(sel("keep", dir), h.ctx);
    expect(stats.errors).toEqual([]);
    expect(stats.entriesAdded).toBe(1);
  });
});

describe("Evernote", () => {
  it("reads notes piece by piece, whatever the piece size", async () => {
    for (const size of [1, 7, 64, 100000]) {
      const pieces = (async function* () {
        for (let i = 0; i < ENEX.length; i += size) yield ENEX.slice(i, i + size);
      })();
      const got: string[] = [];
      for await (const n of enexNotes(pieces)) got.push(n);
      expect(got).toHaveLength(2);
      expect(got[0]?.startsWith("<note>")).toBe(true);
    }
  });
  it("turns ENML into text, keeping checkboxes and never decrypting", () => {
    const n = parseEnexNote(ENEX.slice(ENEX.indexOf("<note>"), ENEX.indexOf("</note>") + 7));
    expect(n?.title).toBe("Shopping & errands");
    expect(n?.text).toContain("Buy milk");
    expect(n?.text).toContain("[x] eggs");
    expect(n?.text).toContain("[ ] bread");
    expect(n?.text).toContain("[encrypted text left out]");
    expect(n?.text).not.toContain("SECRETCIPHER");
    expect(n).toMatchObject({ created: "2024-03-01T10:15:00.000Z", updated: "2024-03-02T08:00:00.000Z", attachments: ["receipt.png"] });
    expect(enmlText("<en-note><div>a</div><div>b</div></en-note>")).toBe("a\nb");
    expect(parseEnexNote("<note></note>")).toBeNull();
  });
  it("imports a notebook file: the notebook is the project, an edit time is only a bound", async () => {
    const h = await harness();
    const file = await writeFile("My notebook.enex", ENEX);
    const stats = await imp("evernote").run(sel("evernote", file), h.ctx);
    expect(stats.errors).toEqual([]);
    const es = await h.entries();
    expect(es).toHaveLength(2);
    expect(es.every((e) => e.project === "My notebook" && e.kind === "document")).toBe(true);
    const edit = es.find((e) => e.title === "Only an edit time") as EntryRecord;
    expect(dateOf(edit)?.strength).toBe("bound");
    expect(edit.writtenAt).toBeUndefined();
    expect(es.find((e) => e.title === "Shopping & errands")?.attachments?.[0]?.name).toBe("receipt.png");
  });
});

const ROAM = [
  { title: "March 1st, 2024", uid: "03-01-2024", children: [{ string: "morning pages", uid: "a", "create-time": 1709288100000, children: [{ string: "a [[Project X]] idea", uid: "b" }] }] },
  { title: "Project X", uid: "px", "create-time": 1700000000000, "edit-time": 1709000000000, children: [{ string: "goals", heading: 2 }] },
  { title: "Empty page", uid: "e" },
];

describe("Roam", () => {
  it("recognises its shape and daily titles", () => {
    expect(looksLikeRoam(JSON.stringify(ROAM).slice(0, 500))).toBe(true);
    expect(looksLikeRoam('{"a":1}')).toBe(false);
    expect(looksLikeRoam('[{"id":1,"name":"x"}]')).toBe(false);
    expect(roamDailyTitle("March 1st, 2024")).toBe("2024-03-01T00:00:00.000Z");
    expect(roamDailyTitle("Project X")).toBeUndefined();
  });
  it("imports pages as outlines, dating them from create-time", async () => {
    const h = await harness();
    const file = await writeFile("roam-export.json", JSON.stringify(ROAM));
    const stats = await imp("roam").run(sel("roam", file), h.ctx);
    expect(stats.errors).toEqual([]);
    const es = await h.entries();
    expect(es).toHaveLength(2); // the empty page has nothing to keep
    const daily = es.find((e) => e.title === "March 1st, 2024") as EntryRecord;
    expect(await h.text(daily)).toBe("- morning pages\n  - a [[Project X]] idea");
    expect(dateOf(daily)).toMatchObject({ strength: "strong", at: "2024-03-01T10:15:00.000Z" });
    expect(await h.text(es.find((e) => e.title === "Project X") as EntryRecord)).toBe("- ## goals");
  });
  it("does not claim a json that is not a Roam export", async () => {
    const h = await harness();
    const file = await writeFile("other.json", JSON.stringify([{ id: 1, name: "x" }]));
    const r = await imp("roam").run(sel("roam", file), h.ctx);
    expect(r.entriesAdded).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(await inspectExport({ file }, h.ctx)).toMatchObject({ kind: "unknown" });
  });
});

// ───────────────────────────── Kindle and Zoom ─────────────────────────────

const CLIPPINGS = `﻿The Art of Notes (Ana Writer)
- Your Highlight on page 12 | location 123-125 | Added on Monday, March 4, 2024 10:15:22 PM

Memory is the residue of thought.
==========
The Art of Notes (Ana Writer)
- Your Note on page 12 | location 125 | Added on Monday, March 4, 2024 10:16:00 PM

check this against chapter 3
==========
The Art of Notes (Ana Writer)
- Your Bookmark on page 40 | location 600 | Added on Tuesday, March 5, 2024 8:00:00 AM


==========
Un livre (Auteur)
- Your Highlight at location 7-8 | Added on Monday, 4 March 2024 22:15:22

Second book text.
==========
`;

describe("Kindle", () => {
  it("reads both date styles", () => {
    expect(kindleDate("Monday, March 4, 2024 10:15:22 PM")).toBe("2024-03-04T22:15:22.000Z");
    expect(kindleDate("Monday, 4 March 2024 22:15:22")).toBe("2024-03-04T22:15:22.000Z");
    expect(kindleDate("Monday, March 4, 2024 12:05:00 AM")).toBe("2024-03-04T00:05:00.000Z");
    expect(kindleDate("someday")).toBeUndefined();
  });
  it("splits clippings and drops bookmarks", () => {
    const c = parseClippings(CLIPPINGS);
    expect(c.map((x) => [x.book, x.author, x.kind, x.where])).toEqual([
      ["The Art of Notes", "Ana Writer", "highlight", "123-125"],
      ["The Art of Notes", "Ana Writer", "note", "125"],
      ["The Art of Notes", "Ana Writer", "bookmark", "600"],
      ["Un livre", "Auteur", "highlight", "7-8"],
    ]);
  });
  it("imports highlights as the author's words and notes as the person's own", async () => {
    const h = await harness();
    const file = await writeFile("My Clippings.txt", CLIPPINGS);
    const stats = await imp("kindle").run(sel("kindle", file), h.ctx);
    expect(stats.errors).toEqual([]);
    const es = await h.entries();
    expect(es).toHaveLength(3);
    const hl = es.find((e) => e.speaker === "other") as EntryRecord;
    expect(hl).toMatchObject({ project: "The Art of Notes", title: "The Art of Notes (Ana Writer)" });
    expect(es.find((e) => e.speaker === "you")?.speakerDetail).toBeUndefined();
    expect(dateOf(hl)?.strength).toBe("medium");
    const again = await imp("kindle").run(sel("kindle", file), h.next());
    expect(again.entriesAdded).toBe(0);
  });
});

describe("Zoom", () => {
  const CHAT = "10:05:03\tFrom Ana Lopez to Everyone:\tHello all\n10:05:40\tFrom Ben to Everyone : second\nline two\n10:06:00\tFrom Ana Lopez to Ben (Direct Message) : private\n";
  const VTT = "WEBVTT\n\n1\n00:00:05.000 --> 00:00:09.000\nAna Lopez: Hello everyone\n\n2\n00:00:09.500 --> 00:00:12.000\nAna Lopez: welcome\n\n3\n00:01:02.000 --> 00:01:05.000\nBen: thanks\n\n4\n00:01:06.000 --> 00:01:07.000\n<v Cy>voice tag</v>\n";

  it("reads the start of a meeting from a name", () => {
    expect(zoomStart("GMT20240301-120000_Recording.transcript.vtt")).toEqual({ day: [2024, 3, 1], time: [12, 0, 0], utc: true });
    expect(zoomStart("2024-03-01 12.00.00 Weekly sync/meeting_saved_chat.txt")).toEqual({ day: [2024, 3, 1], time: [12, 0, 0], utc: false });
    expect(zoomStart("Zoom/2024-03-01/chat.txt")).toEqual({ day: [2024, 3, 1], utc: false });
    expect(zoomStart("meeting_saved_chat.txt")).toBeNull();
  });
  it("reads a chat: sender, direct messages and continuation lines", () => {
    const c = parseZoomChat(CHAT, "2024-03-01 12.00.00 Sync/meeting_saved_chat.txt", env());
    expect(c?.turns.map((t) => [t.speakerDetail, t.text])).toEqual([["Ana Lopez", "Hello all"], ["Ben", "second\nline two"], ["Ana Lopez", "private"]]);
    expect(c?.turns[0]).toMatchObject({ at: "2024-03-01T10:05:03.000Z", atStrength: "medium" });
  });
  it("reads a transcript: cues of one speaker are one message; offsets add to the start", () => {
    const c = parseZoomTranscript(VTT, "GMT20240301-120000_x.transcript.vtt", env());
    expect(c?.turns.map((t) => [t.speakerDetail, t.text])).toEqual([["Ana Lopez", "Hello everyone welcome"], ["Ben", "thanks"], ["Cy", "voice tag"]]);
    expect(c?.turns[1]).toMatchObject({ at: "2024-03-01T12:01:02.000Z", atStrength: "medium" });
  });
  it("dates a chat with no date in its name only by when it was saved: an upper bound", async () => {
    const h = await harness();
    const file = await writeFile("meeting_saved_chat.txt", CHAT);
    const stats = await imp("zoom").run(sel("zoom", file), h.ctx);
    expect(stats.errors).toEqual([]);
    const es = await h.entries();
    expect(es).toHaveLength(3);
    const d = dateOf(es[0] as EntryRecord);
    expect(d?.strength).toBe("bound");
    expect(es[0]?.writtenAt).toBeUndefined();
  });
  it("imports a recording folder: chat and transcript", async () => {
    const dir = await writeTree({ "2024-03-01 12.00.00 Weekly sync/meeting_saved_chat.txt": CHAT, "2024-03-01 12.00.00 Weekly sync/GMT20240301-120000_Recording.transcript.vtt": VTT, "2024-03-01 12.00.00 Weekly sync/video.mp4": "bytes" });
    const h = await harness((s) => void (s.you.names = ["Ana Lopez"]));
    const stats = await imp("zoom").run(sel("zoom", dir), h.ctx);
    expect(stats.conversationsTouched).toBe(2);
    const es = await h.entries();
    expect(es.filter((e) => e.speaker === "you").length).toBeGreaterThan(0);
    expect(es.every((e) => dateOf(e)?.strength === "medium")).toBe(true);
  });
});

// ───────────────────────────── inspect ─────────────────────────────

describe("import.inspect", () => {
  it("recognises each export and counts without returning text", async () => {
    const h = await harness();
    const cases: [string, string, number][] = [
      ["whatsapp", await writeFile("WhatsApp Chat with Ben.txt", WA_ANDROID), 1],
      ["telegram", await writeFile("result.json", JSON.stringify(TG_CHAT)), 1],
      ["slack", await writeZip([{ name: "general/2024-03-01.json", data: JSON.stringify([{ type: "message", user: "U1", text: "x", ts: "1709287500.000200" }]) }]), 1],
      ["evernote", await writeFile("nb.enex", ENEX), 2],
      ["roam", await writeFile("graph.json", JSON.stringify(ROAM)), 2],
      ["kindle", await writeFile("My Clippings.txt", CLIPPINGS), 3],
      ["zoom", await writeFile("x.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAna: hi\n"), 1],
      ["keep", await writeTree({ "Takeout/Keep/A.json": JSON.stringify({ title: "A", textContent: "b", createdTimestampUsec: 1709288100000000 }) }), 1],
      ["discord", await writeTree({ "messages/c1/messages.json": JSON.stringify([{ ID: 1, Timestamp: "2024-03-01 10:00:00+00:00", Contents: "x", Attachments: "" }]) }), 1],
    ];
    for (const [kind, file, n] of cases) {
      const r = await inspectExport({ file }, h.ctx);
      expect(r, kind).toMatchObject({ kind, conversations: n, alreadyImported: 0 });
      expect(r.problem).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain("Hello");
    }
    const r = await inspectExport({ file: cases[1]![1] }, h.ctx);
    expect(r.range).toEqual(["2024-03-01T10:15:00.000Z", "2024-03-01T10:17:00.000Z"]);
  });
  it("reports what is already in the record after an import", async () => {
    const h = await harness();
    const file = await writeFile("result.json", JSON.stringify(TG_CHAT));
    await imp("telegram").run(sel("telegram", file), h.ctx);
    expect((await inspectExport({ file }, h.next())).alreadyImported).toBe(1);
  });
  it("leaves the three chat services and other files alone", async () => {
    const h = await harness();
    const file = await writeFile("notes.txt", "just some text");
    expect(await inspectExport({ file }, h.ctx)).toMatchObject({ kind: "unknown", problem: "export-not-recognised" });
  });
});

// ───────────────────────────── the app around them ─────────────────────────────

describe("Sources rows, flags and labels", () => {
  it("lists a source once something from it has arrived, adding up its files, and removes it by switching it off", async () => {
    const h = await harness();
    const settings = structuredClone(DEFAULT_SETTINGS) as CortexSettings;
    const excluded: string[] = [];
    const svc = createSourcesService({
      app: { vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => null } } as never,
      vaultRoot: h.vault,
      cacheDir: h.cache,
      log: nullLogger,
      settings: { value: settings, signal: undefined as never, corrupt: false, issues: [], update: async (fn: (s: CortexSettings) => void) => fn(settings), reload: async () => undefined, useDefaults: async () => undefined } as never,
      runner: { request: (async () => ({ sources: [], conversations: 0, notes: 0, tokens: 0 })) as never },
      corrections: { exclude: (async (id: string) => void excluded.push(id)) as never },
      sandbox: () => false,
    });
    expect((await svc.list()).map((r) => r.id)).not.toContain("whatsapp");
    await imp("whatsapp").run(sel("whatsapp", await writeFile("WhatsApp Chat with Ben.txt", WA_ANDROID)), h.ctx);
    await imp("whatsapp").run(sel("whatsapp", await writeFile("WhatsApp Chat with Cy.txt", "1/2/2024, 10:00 - Cy: hi\n")), h.next());
    const row = (await svc.list()).find((r) => r.id === "whatsapp");
    expect(row).toMatchObject({ kind: "whatsapp", status: "imported", items: 3, storedIn: ".raw/chats/whatsapp/" });
    expect(row?.lastImport).toBeTruthy();
    await svc.remove("whatsapp");
    expect(settings.sources.chatExports.whatsapp.enabled).toBe(false);
    expect(excluded).toEqual(["whatsapp"]);
  });
  it("takes each kind as a command-line source and names it", () => {
    for (const k of CHAT_EXPORT_KEYS) {
      expect(parseSourceFlag(`${k}=C:/x/export`)).toEqual({ kind: k, file: "C:/x/export" });
      expect(parseSourceFlag(k)).toBeUndefined();
      expect(sourceLabel(k).length).toBeGreaterThan(2);
    }
  });
});

// ───────────────────────────── screening ─────────────────────────────

describe("screening", () => {
  it("replaces a secret in the stored copy of a chat and a note, as for the chat services", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const h = await harness();
    await imp("whatsapp").run(sel("whatsapp", await writeFile("WhatsApp Chat with Ben.txt", `12/03/2024, 14:05 - Ben: my key is ${secret} ok
`)), h.ctx);
    await imp("evernote").run(sel("evernote", await writeFile("nb.enex", ENEX.replace("Buy milk", `Buy ${secret}`))), h.next());
    const es = await h.entries();
    expect(es).toHaveLength(3);
    for (const e of es) expect(await h.text(e)).not.toContain("AKIA");
  });
  it("keeps ids when the same chat is exported again in a different zip", async () => {
    const h = await harness();
    await imp("whatsapp").run(sel("whatsapp", await writeZip([{ name: "WhatsApp Chat with Ben.txt", data: WA_ANDROID }])), h.ctx);
    const before = (await h.entries()).map((e) => e.id).sort();
    await imp("whatsapp").run(sel("whatsapp", await writeFile("WhatsApp Chat with Ben.txt", WA_ANDROID)), h.next());
    expect((await h.entries()).map((e) => e.id).sort()).toEqual(before);
  });
});

// ───────────────────────────── bad input ─────────────────────────────

describe("malformed input never throws past the importer", () => {
  const garbage = Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x01, 0x02, 0x80, 0x81, 0x7b, 0x22]);
  const files: [(typeof CHAT_EXPORT_KEYS)[number], string][] = [
    ["whatsapp", "WhatsApp Chat with X.txt"],
    ["telegram", "result.json"],
    ["discord", "messages.csv"],
    ["slack", "general/2024-03-01.json"],
    ["keep", "Takeout/Keep/A.json"],
    ["evernote", "a.enex"],
    ["roam", "graph.json"],
    ["kindle", "My Clippings.txt"],
    ["zoom", "x.vtt"],
  ];
  for (const [kind, name] of files) {
    for (const [label, body] of [["empty", Buffer.alloc(0)], ["garbage", garbage], ["truncated json", Buffer.from('[{"title":"a","children":[{"string"')], ["wrong shape", Buffer.from('{"messages":"no","chats":7,"list":null}')]] as const) {
      it(`${kind}: ${label}`, async () => {
        const h = await harness();
        const dir = await tmpDir();
        const file = await writeFile(name, body, dir);
        const target = name.includes("/") ? dir : file;
        const stats = await imp(kind).run(sel(kind, target), h.ctx);
        expect(stats.entriesAdded).toBe(0);
        const r = await inspectExport({ file: target }, h.next());
        expect(r.conversations).toBe(0);
      });
    }
  }
  it("refuses a missing path and a relative path with a code", async () => {
    const h = await harness();
    const missing = await imp("whatsapp").run(sel("whatsapp", path.join(await tmpDir(), "nope.txt")), h.ctx);
    expect(missing.errors.length).toBe(1);
    const rel = await imp("whatsapp").run(sel("whatsapp", "relative.txt"), h.ctx);
    expect(rel.errors[0]?.message).toBe("path-unreadable");
  });
  it("does nothing when the source is turned off", async () => {
    const h = await harness((s) => void (s.sources.chatExports.whatsapp.enabled = false));
    const file = await writeFile("WhatsApp Chat with Ben.txt", WA_ANDROID);
    const stats = await imp("whatsapp").run(sel("whatsapp", file), h.ctx);
    expect(stats.filesSeen).toBe(0);
    expect(await h.entries()).toHaveLength(0);
  });
  it("opens a lone file as an export source", async () => {
    const file = await writeFile("My Clippings.txt", CLIPPINGS);
    const src = await openExportSource(file);
    expect(src.form).toBe("file");
    await src.close();
  });
});

export type { Harness };

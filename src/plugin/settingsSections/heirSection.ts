/**
 * Settings > Lock > Heir or custodian: who can pick the record up, the letter to them, which areas go, and the hand-over
 * bundle. Naming the heir is recorded as a sealed dated entry; the bundle is a zip the owner saves where they choose. Nothing
 * is released automatically and nothing is sent: the record opens only when people bring the key shares together.
 */
import { encryptionConfigured, recordKeyState } from "../../shared/crypto/keyring";
import type { CortexSettings } from "../../shared/settings";
import { SPACES } from "../../shared/spaces";
import { SETTINGS_COPY } from "../../ui/copy";
import { buildHandoverBundle, recordSealed, today } from "../handoverFlow";
import { heirEntry } from "../handoverRecord";
import { shareSession } from "../shareSession";
import type { SectionHost, SectionRow } from "./index";

const c = SETTINGS_COPY.lock.heir;
const fill = (s: string, v: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? `{${k}}`));

let busy = false;

function areaNames(ids: readonly string[]): string[] {
  return ids.map((id) => SPACES.find((s) => s.id === id)?.area ?? id);
}

function render(host: SectionHost, s: CortexSettings): void {
  const heir = s.record.heir;
  host.heading(c.heading, c.desc);
  host.row(c.heading, heir.name ? fill(c.statusNamed, { name: heir.name, date: heir.namedAt }).trim() : c.statusNone);
  host.text(c.name, undefined, heir.name, c.namePh, (x, v) => void (x.record.heir.name = v));
  host.text(c.contact, undefined, heir.contact, c.contactPh, (x, v) => void (x.record.heir.contact = v));

  host.heading(c.spaces, c.spacesDesc);
  for (const sp of SPACES) {
    host.toggle(sp.area, undefined, heir.spaces.includes(sp.id), (x, on) => {
      const set = new Set(x.record.heir.spaces);
      if (on) set.add(sp.id);
      else set.delete(sp.id);
      x.record.heir.spaces = [...set];
    });
  }

  host.row(c.letter).addTextArea((ta) => {
    ta.setPlaceholder(c.letterPh).setValue(heir.letter).onChange((v) => host.set((x) => void (x.record.heir.letter = v)));
    if (ta.inputEl) ta.inputEl.rows = 5;
  });

  const session = shareSession();
  const options: Record<string, string> = { "0": c.shareNone };
  if (session) for (let x = 2; x <= session.n; x++) options[String(x)] = fill(c.shareOption, { x });
  host.dropdown(c.share, c.shareDesc, options, options[String(heir.share)] ? String(heir.share) : "0", (x, v) => void (x.record.heir.share = Number(v)));

  host.row(c.save).addButton((b) =>
    b.setButtonText(c.save).setCta().onClick(async () => {
      const sv = await host.services();
      const cur = sv.settings.value.record;
      if (cur.heir.name.trim() === "") return host.notify(c.needName);
      const date = today();
      await sv.settings.update((x) => void (x.record.heir.namedAt = date));
      host.notify(fill(c.saved, { name: cur.heir.name.trim() }));
      const rec = await recordSealed(sv, heirEntry({ name: cur.heir.name.trim(), contact: cur.heir.contact, spaces: areaNames(cur.heir.spaces), letter: cur.heir.letter, threshold: cur.shares.splitAt ? cur.shares.threshold : 2, date }));
      host.notify(rec.ok ? c.sealedNote : rec.reason === "sample" ? SETTINGS_COPY.lock.shares.sealedSample : fill(c.sealedFailed, { reason: rec.detail || "—" }));
      host.refresh();
    }),
  );

  // The bundle
  const encrypted = s.record.encryption.enabled || encryptionConfigured();
  const state = recordKeyState();
  const row = host.row(c.bundle, c.bundleDesc);
  row.addButton((b) =>
    b.setButtonText(c.bundleButton).onClick(async () => {
      if (busy) return;
      const sv = await host.services();
      const cur = sv.settings.value.record;
      if (sv.sandbox.value) return host.notify(c.bundleSample);
      if (!(cur.encryption.enabled || encryptionConfigured())) return host.notify(c.bundleNeedEncrypt);
      if (recordKeyState() !== "open") return host.notify(c.bundleNeedOpen);
      if (cur.heir.name.trim() === "") return host.notify(c.bundleNeedName);
      if (cur.shares.splitAt === "") return host.notify(c.bundleSplit);
      busy = true;
      try {
        host.notify(c.bundleWorking);
        const live = shareSession();
        const x = cur.heir.share;
        const bytes = live && x >= 2 && x <= live.n ? (live.shares[x - 1] as Uint8Array) : null;
        const out = await buildHandoverBundle(sv, {
          name: cur.heir.name.trim(),
          letter: cur.heir.letter,
          areas: cur.heir.spaces,
          share: bytes ? { bytes, x } : null,
          n: cur.shares.total,
          k: cur.shares.threshold,
        });
        if (!out.ok) {
          if (out.reason === "cancelled") return;
          return host.notify(out.reason === "empty" ? c.bundleEmpty : out.reason === "sample" ? c.bundleSample : out.reason === "closed" ? c.bundleNeedOpen : c.bundleFailed);
        }
        host.notify(fill(c.bundleDone, { path: out.path }));
        const date = today();
        const rec = await recordSealed(sv, heirEntry({ name: cur.heir.name.trim(), contact: cur.heir.contact, spaces: areaNames(cur.heir.spaces), letter: cur.heir.letter, threshold: cur.shares.threshold, date, bundle: true }));
        if (!rec.ok && rec.reason === "failed") host.notify(fill(c.sealedFailed, { reason: rec.detail || "—" }));
      } finally {
        busy = false;
      }
    }),
  );
  if (!encrypted) host.mount.createEl("p", { cls: "cx-note", text: c.bundleNeedEncrypt });
  else if (state !== "open") host.mount.createEl("p", { cls: "cx-note", text: c.bundleNeedOpen });
}

export const heirRows: readonly SectionRow[] = [{ id: "lock-heir", section: "lock", order: 80, render }];

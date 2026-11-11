/**
 * Settings > Lock > Encryption: the status of the record's encryption and the rows that run it ("Encrypt my record",
 * "Check first", "Open with this Windows account", "Raise the key strength", "Remove encryption", "Delete the plain
 * backup"). The steps themselves live in plugin/recordEncryptionFlow.ts; this file only draws and asks.
 * Status that needs the disk (the key file, the account copy, backups) is read once per draw, cached, and the page
 * redraws when it changes.
 */
import { encryptionConfigured, recordKeyState } from "../../shared/crypto/keyring";
import { iterationsFor } from "../../shared/crypto/vaultKey";
import { hasPassphrase, verifyPassphrase } from "../../shared/lock";
import type { CortexSettings } from "../../shared/settings";
import { listBackups, planRecordConversion, removeBackup } from "../../store/encryptRecord";
import { COPY, SETTINGS_COPY } from "../../ui/copy";
import { allowAccountUnlock, envelopeNeedsRaise, rewrapRecordKey } from "../recordKeys";
import { checkEncryption, encryptMyRecord, removeEncryption, type FlowCtx } from "../recordEncryptionFlow";
import type { SectionHost, SectionRow } from "./index";
import type { CortexServices } from "../services";

const c = SETTINGS_COPY.lock.enc;

const fill = (s: string, v: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? `{${k}}`));

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DiskStatus {
  key: "none" | "ok" | "damaged";
  kdfVersion: number;
  iterations: number;
  needsRaise: boolean;
  accountOffered: boolean;
  accountReady: boolean;
  backups: string[];
}

let cache: DiskStatus | null = null;
let busy = false;
let note = "";

async function readStatus(sv: CortexServices): Promise<DiskStatus> {
  const access = sv.recordKeys;
  const env = access ? await access.readEnvelope() : ({ state: "none" } as const);
  return {
    key: env.state,
    kdfVersion: env.state === "ok" ? env.envelope.kdfVersion : 0,
    iterations: env.state === "ok" ? env.envelope.iterations : 0,
    needsRaise: access && env.state === "ok" ? await envelopeNeedsRaise(access) : false,
    accountOffered: access ? await access.osOffered() : false,
    accountReady: access ? await access.osReady() : false,
    backups: await listBackups(sv.cacheDir).catch(() => []),
  };
}

function flowCtx(sv: CortexServices): FlowCtx {
  return { vaultRoot: sv.vaultRoot, cacheDir: sv.cacheDir, owner: "plugin", lockStaleMs: 5 * 60_000 };
}

async function load(host: SectionHost): Promise<void> {
  try {
    const sv = await host.services();
    const next = await readStatus(sv);
    const changed = JSON.stringify(next) !== JSON.stringify(cache);
    cache = next;
    if (changed) host.refresh();
  } catch {
    // the page works without the disk status: it shows the plain state
  }
}

function addPassword(row: ReturnType<SectionHost["row"]>, hint: string, onChange: (v: string) => void): void {
  row.addText((tx) => {
    tx.inputEl?.setAttribute?.("type", "password");
    tx.inputEl?.setAttribute?.("autocomplete", "off");
    tx.setPlaceholder(hint).onChange(onChange);
  });
}

async function confirmStep(host: SectionHost, title: string, body: string, ok: string): Promise<boolean> {
  const { confirm } = await import("../../ui/modals/ConfirmModal");
  const sv = await host.services();
  return confirm(sv.app, { title, body, confirm: ok, cancel: COPY.dialogs.cancel, warning: false });
}

function reasonText(detail: string | undefined): string {
  return detail && detail.length > 0 ? `${detail.replace(/[.\s]+$/, "")}.` : "";
}

function render(host: SectionHost, s: CortexSettings): void {
  const encrypted = s.record.encryption.enabled || encryptionConfigured();
  const state = recordKeyState();
  const disk = cache;
  host.heading(c.heading, c.desc);

  // Status
  const damaged = disk?.key === "damaged";
  const statusText = !encrypted ? c.statusOff : damaged ? c.statusDamaged : state === "open" ? c.statusOpen : c.statusLocked;
  const kdf = encrypted && disk && disk.key === "ok" ? ` ${fill(c.kdf, { v: disk.kdfVersion, n: disk.iterations.toLocaleString("en-US") })}` : "";
  const status = host.row(c.statusName, `${note !== "" ? `${note} ` : ""}${statusText}${kdf}`);
  void status;
  void load(host);

  if (!encrypted) {
    let pass = "";
    const row = host.row(c.encrypt, `${c.encryptDesc} ${c.passphraseHint}`);
    addPassword(row, c.passphrase, (v) => (pass = v));
    row.addButton((b) =>
      b.setButtonText(c.checkFirst).onClick(async () => {
        if (busy) return;
        try {
          const sv = await host.services();
          const plan = await checkEncryption(flowCtx(sv));
          note = plan.toConvert === 0 ? c.checkNothing : fill(c.checkResult, { files: plan.files, size: size(plan.bytes), n: plan.toConvert, shards: plan.byKind.shard.files + plan.byKind.corrections.files, segments: plan.byKind.segment.files, seals: plan.byKind.seal.files });
          host.notify(note);
          host.refresh();
        } catch {
          host.notify(SETTINGS_COPY.advanced.failed);
        }
      }),
    );
    row.addButton((b) =>
      b
        .setButtonText(c.encrypt)
        .setCta()
        .onClick(async () => {
          if (busy) return;
          if (pass.length < 8) return host.notify(c.weak);
          const sv = await host.services();
          if (!sv.recordKeys) return host.notify(c.keyFailed);
          const lock = sv.settings.value.privacy.lock;
          if (hasPassphrase(lock) && !(await verifyPassphrase(pass, lock))) return host.notify(c.wrongPassphrase);
          const plan = await planRecordConversion(sv.vaultRoot, "encrypt");
          if (!(await confirmStep(host, c.confirmTitle, fill(c.confirmBody, { n: plan.toConvert }), c.encrypt))) return;
          busy = true;
          let lastShown = 0;
          const out = await encryptMyRecord(
            {
              access: sv.recordKeys,
              ctx: flowCtx(sv),
              lock: () => sv.settings.value.privacy.lock,
              update: (patch) => sv.settings.update(patch),
              onProgress: (done, total) => {
                if (done - lastShown >= Math.max(1, Math.floor(total / 10))) {
                  lastShown = done;
                  note = fill(c.running, { done, total });
                  host.refresh();
                }
              },
            },
            pass,
          );
          busy = false;
          pass = "";
          if (out.ok) note = c.done;
          else if (out.reason === "weak") note = c.weak;
          else if (out.reason === "wrong-passphrase") note = c.wrongPassphrase;
          else if (out.reason === "key") note = c.keyFailed;
          else if (out.result?.rollbackFailed) note = fill(c.stoppedBad, { reason: reasonText(out.detail), path: out.result.backup ?? "" });
          else if (out.result?.rolledBack) note = fill(c.stopped, { reason: reasonText(out.detail) });
          else note = fill(c.stoppedPlain, { reason: reasonText(out.detail) });
          host.notify(note);
          cache = null;
          host.refresh();
        }),
    );
    return;
  }

  // Encrypted
  if (state !== "open") {
    host.mount.createEl("p", { cls: "cx-note", text: c.needOpen });
  } else {
    if (disk?.accountOffered) {
      const row = host.row(c.account, `${c.accountDesc} ${disk.accountReady ? c.accountOn : c.accountOff}`);
      row.addButton((b) =>
        b.setButtonText(disk.accountReady ? c.accountStop : c.accountAllow).onClick(async () => {
          const sv = await host.services();
          if (!sv.recordKeys) return;
          if (disk.accountReady) await sv.recordKeys.removeOs();
          else if (!(await allowAccountUnlock(sv.recordKeys))) return host.notify(c.accountFailed);
          cache = null;
          host.refresh();
        }),
      );
    }
    if (disk?.needsRaise) {
      let pass = "";
      const row = host.row(c.raise, fill(c.raiseDesc, { n: disk.iterations.toLocaleString("en-US"), m: iterationsFor(2).toLocaleString("en-US") }));
      addPassword(row, c.passphrase, (v) => (pass = v));
      row.addButton((b) =>
        b.setButtonText(c.raiseButton).onClick(async () => {
          const sv = await host.services();
          if (!sv.recordKeys || !(await rewrapRecordKey(sv.recordKeys, pass, pass))) return host.notify(c.wrongPassphrase);
          note = c.raised;
          cache = null;
          host.refresh();
        }),
      );
    }
    host.row(c.remove, c.removeDesc).addButton((b) =>
      b
        .setButtonText(c.remove)
        .setWarning()
        .onClick(async () => {
          if (busy) return;
          const sv = await host.services();
          if (!sv.recordKeys) return;
          const plan = await planRecordConversion(sv.vaultRoot, "decrypt");
          if (!(await confirmStep(host, c.removeConfirm, fill(c.removeBody, { n: plan.toConvert }), c.remove))) return;
          busy = true;
          const out = await removeEncryption({ access: sv.recordKeys, ctx: flowCtx(sv), lock: () => sv.settings.value.privacy.lock, update: (patch) => sv.settings.update(patch) });
          busy = false;
          if (out.ok) note = c.removed;
          else if (out.reason === "locked") note = c.needOpen;
          else note = fill(out.result?.rollbackFailed ? c.stoppedBad : c.stopped, { reason: reasonText(out.detail), path: out.result?.backup ?? "" });
          host.notify(note);
          cache = null;
          host.refresh();
        }),
    );
  }
  for (const rel of disk?.backups ?? []) {
    host.row(c.deleteBackup, `${fill(c.backupFound, { path: rel })} ${c.deleteBackupDesc}`).addButton((b) =>
      b
        .setButtonText(c.deleteBackup)
        .setWarning()
        .onClick(async () => {
          const sv = await host.services();
          await removeBackup(sv.cacheDir, rel).catch(() => undefined);
          note = c.backupDeleted;
          cache = null;
          host.refresh();
        }),
    );
  }
  host.mount.createEl("p", { cls: "cx-note", text: c.cacheNote });
  host.mount.createEl("p", { cls: "cx-note", text: c.runnerNote });
}

/** Test hook: forget the cached disk status. */
export function resetLockSectionCache(): void {
  cache = null;
  busy = false;
  note = "";
}

export const lockRows: readonly SectionRow[] = [{ id: "lock-encryption", section: "lock", order: 50, render }];

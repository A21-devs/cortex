/**
 * Schemas you build (Agents > Ledger): one sentence, New schema · Import from a file · Show archived, a table SCHEMA ·
 * VERSIONS · COVERAGE and "Copy a built-in pack". A schema has fields, a working copy and saved versions; coverage
 * counts entries the pack it was copied from has already labelled. Nothing here asks a model anything.
 * Stored in settings (`schemas`). Owner: lab.
 */
import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { STARTER_PACKS } from "../../../shared/packs";
import type { StatsResult } from "../../../shared/protocol/worker";
import {
  draftFromFile,
  draftFromPack,
  fieldKeyFor,
  frozenCount,
  newDraft,
  renameDraft,
  replaceDraft,
  saveVersion,
  schemaCoverage,
  schemaState,
  SCHEMA_LIMITS,
  type SchemaDraft,
  type SchemaState,
} from "../../../shared/schemas";
import type { PackField, PackFieldType } from "../../../shared/types";
import { useServices } from "../../context";
import { t } from "../../copy";
import { Button } from "../../primitives/buttons";
import { Select } from "../../primitives/controls";
import { fmtInt } from "../../valueLabels";
import { useChange, useLoad } from "../PageFrame";

type PacksStats = Extract<StatsResult, { kind: "packs" }>;

const STATE_KEYS: Readonly<Record<SchemaState, "agents.schemaUnsaved" | "agents.schemaChanged" | "agents.schemaSaved">> = {
  unsaved: "agents.schemaUnsaved",
  changed: "agents.schemaChanged",
  saved: "agents.schemaSaved",
};

const typeOptions = (): { value: PackFieldType; label: string }[] => [
  { value: "enum", label: t("agents.schemaTypeEnum") },
  { value: "multi", label: t("agents.schemaTypeMulti") },
  { value: "bool", label: t("agents.schemaTypeBool") },
  { value: "text", label: t("agents.schemaTypeText") },
];

/** A field with the new type: a list type keeps (or starts) its values, the others drop them. */
export function withType(f: PackField, type: PackFieldType): PackField {
  const { values, ...rest } = f;
  return type === "enum" || type === "multi" ? { ...rest, type, values: values ?? [] } : { ...rest, type };
}

/** The values typed as one line ("debug, build, research"), as a list. */
export function parseValues(line: string): string[] {
  return line.split(",").map((v) => v.trim()).filter((v) => v !== "");
}

function FieldEditor(p: { field: PackField; onChange(next: PackField): void; onRemove(): void }): JSX.Element {
  const f = p.field;
  return (
    <li class="cx-schema-field">
      <input
        class="cx-input"
        type="text"
        aria-label={t("agents.schemaFieldName")}
        maxLength={SCHEMA_LIMITS.fieldLabel}
        defaultValue={f.label}
        key={`${f.key}:${f.label}`}
        onChange={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value.trim();
          if (v !== "" && v !== f.label) p.onChange({ ...f, label: v });
        }}
      />
      <Select label={t("agents.schemaFieldType")} bare value={f.type} options={typeOptions()} onChange={(v) => p.onChange(withType(f, v))} />
      {f.type === "enum" || f.type === "multi" ? (
        <input
          class="cx-input cx-schema-values"
          type="text"
          aria-label={t("agents.schemaValues")}
          placeholder={t("agents.schemaValues")}
          defaultValue={(f.values ?? []).join(", ")}
          key={`${f.key}:${(f.values ?? []).join("|")}`}
          onChange={(e) => p.onChange({ ...f, values: parseValues((e.currentTarget as HTMLInputElement).value).slice(0, SCHEMA_LIMITS.values) })}
        />
      ) : null}
      <button type="button" class="cx-text-button" title={t("agents.schemaRemoveField", { field: f.label })} aria-label={t("agents.schemaRemoveField", { field: f.label })} onClick={p.onRemove}>
        ×
      </button>
    </li>
  );
}

function Editor(p: { draft: SchemaDraft; set(next: SchemaDraft): void; rename(name: string): void; onSave(): void; onArchive(): void; onDelete(): void; onClose(): void }): JSX.Element {
  const d = p.draft;
  const state = schemaState(d);
  const setFields = (fields: PackField[]) => p.set({ ...d, fields });
  const add = () => {
    if (d.fields.length >= SCHEMA_LIMITS.fields) return;
    const label = t("agents.schemaFieldDefault", { n: d.fields.length + 1 });
    const key = fieldKeyFor(label, new Set(d.fields.map((f) => f.key)));
    setFields([...d.fields, { key, label, description: "", type: "enum", values: [], prompt: "" }]);
  };
  return (
    <div class="cx-schema-editor">
      <label class="cx-field">
        <span>{t("agents.schemaName")}</span>
        <input class="cx-input" type="text" maxLength={SCHEMA_LIMITS.name} defaultValue={d.name} key={d.name} onChange={(e) => p.rename((e.currentTarget as HTMLInputElement).value)} />
      </label>
      {d.from ? <p class="cx-note">{t("agents.schemaFrom", { pack: d.from.pack, version: d.from.version })}</p> : null}
      <div class="cx-schema-fields-head cx-note">{t("agents.schemaFields")}</div>
      {d.fields.length === 0 ? (
        <p class="cx-note">{t("agents.schemaNoFields")}</p>
      ) : (
        <ul class="cx-schema-fields">
          {d.fields.map((f) => (
            <FieldEditor key={f.key} field={f} onChange={(next) => setFields(d.fields.map((x) => (x.key === f.key ? next : x)))} onRemove={() => setFields(d.fields.filter((x) => x.key !== f.key))} />
          ))}
        </ul>
      )}
      <div class="cx-schema-actions">
        <Button onClick={add} disabled={d.fields.length >= SCHEMA_LIMITS.fields}>{t("agents.schemaAddField")}</Button>
        <Button primary onClick={p.onSave} disabled={d.fields.length === 0 || state === "saved"}>{t("agents.schemaSave")}</Button>
        <Button onClick={p.onArchive}>{d.archived ? t("agents.schemaRestore") : t("agents.schemaArchive")}</Button>
        {d.versions.length === 0 ? <Button onClick={p.onDelete}>{t("agents.schemaDelete")}</Button> : null}
        <Button onClick={p.onClose}>{t("agents.schemaDone")}</Button>
      </div>
    </div>
  );
}

export function Schemas(): JSX.Element {
  const s = useServices();
  const change = useChange();
  const list: readonly SchemaDraft[] = s.settings.value.schemas ?? [];
  const [archived, setArchived] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const packs = useLoad<PacksStats>(
    async (signal) => {
      const res = await s.worker.call("agents#schemaPacks", "stats", { kind: "packs", includeSuperseded: false }, { signal });
      if (res.kind !== "packs") throw new Error("unexpected stats result");
      return res;
    },
    [s.shared.slices.queues.value.label],
  );
  const rows = packs.state === "ready" ? packs.value.packs : [];
  const data = s.shared.slices.data.value;
  const total = data.record > 0 ? data.record : rows.reduce((m, r) => Math.max(m, r.items), 0);

  const write = (fn: (cur: SchemaDraft[]) => SchemaDraft[]) => void s.settings.update((x) => void (x.schemas = fn(x.schemas ?? [])));
  const add = (make: (cur: readonly SchemaDraft[]) => SchemaDraft) => {
    const made = make(list);
    write((cur) => [...cur, made]);
    setOpenId(made.id);
  };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    let draft: SchemaDraft | null = null;
    try {
      draft = draftFromFile(await f.text(), list, new Date());
    } catch {
      draft = null;
    }
    if (!draft) return void change.post(t("agents.schemaImportBad"));
    const made = draft;
    write((cur) => [...cur, made]);
    setOpenId(made.id);
    change.post(t("agents.schemaImported"));
  };
  const shown = list.filter((d) => archived || !d.archived);
  const hasArchived = list.some((d) => d.archived);

  return (
    <section class="cx-schemas" aria-label={t("agents.schemasTitle")}>
      <div class="cx-section-label">
        <span>{t("agents.schemasTitle")}</span>
      </div>
      <p class="cx-note">{t("agents.schemasHint")}</p>
      <div class="cx-schema-actions">
        <button type="button" class="cx-text-button" onClick={() => add((cur) => newDraft(cur, t("agents.schemaDefaultName"), new Date()))}>
          {t("agents.schemaNew")}
        </button>
        <button type="button" class="cx-text-button" onClick={() => file.current?.click()}>
          {t("agents.schemaImport")}
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const input = e.currentTarget as HTMLInputElement;
            const f = input.files?.[0];
            input.value = "";
            void importFile(f);
          }}
        />
        {hasArchived ? (
          <button type="button" class="cx-text-button" aria-pressed={archived} onClick={() => setArchived(!archived)}>
            {archived ? t("agents.schemaHideArchived") : t("agents.schemaShowArchived")}
          </button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p class="cx-note">{t("agents.schemaEmpty")}</p>
      ) : (
        <div class="cx-table-wrap">
          <table class="cx-table cx-lab-table">
            <thead>
              <tr>
                <th scope="col">{t("agents.schemaColSchema")}</th>
                <th scope="col" class="is-num">{t("agents.schemaColVersions")}</th>
                <th scope="col" class="is-num">{t("agents.schemaColCoverage")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.flatMap((d) => {
                const frozen = frozenCount(d);
                const cover = schemaCoverage(d, rows);
                const editing = openId === d.id;
                const out = [
                  <tr key={d.id} class={`cx-lab-row${editing ? " is-picked" : ""}${d.archived ? " is-archived" : ""}`}>
                    <th scope="row">
                      <button type="button" class="cx-lab-pick" aria-expanded={editing} title={t("agents.schemaEdit")} onClick={() => setOpenId(editing ? null : d.id)}>
                        {d.name}
                      </button>
                      <span class="cx-note cx-lab-sub">{t(STATE_KEYS[schemaState(d)])}</span>
                    </th>
                    <td class="cx-mono">
                      {fmtInt(d.versions.length)}
                      <span class="cx-note cx-lab-sub is-nowrap">{frozen === 0 ? t("agents.schemaFrozenNone") : t("agents.schemaFrozen", { n: fmtInt(frozen) })}</span>
                    </td>
                    <td class="cx-mono">
                      {t("agents.schemaCoverage", { n: fmtInt(cover), total: fmtInt(total) })}
                      {cover > 0 ? <span class="cx-note cx-lab-sub">{t("agents.schemaCoverageNote")}</span> : null}
                    </td>
                  </tr>,
                ];
                if (editing) {
                  out.push(
                    <tr key={`${d.id}:edit`}>
                      <td colSpan={3}>
                        <Editor
                          draft={d}
                          set={(next) => write((cur) => replaceDraft(cur, next))}
                          rename={(name) => write((cur) => renameDraft(cur, d.id, name))}
                          onSave={() => {
                            const next = saveVersion(d, new Date());
                            write((cur) => replaceDraft(cur, next));
                            const last = next.versions[next.versions.length - 1];
                            if (last) change.post(t("agents.schemaSavedNote", { n: last.n }));
                          }}
                          onArchive={() => {
                            write((cur) => replaceDraft(cur, { ...d, archived: !d.archived }));
                            setOpenId(null);
                          }}
                          onDelete={() => {
                            write((cur) => cur.filter((x) => x.id !== d.id));
                            setOpenId(null);
                          }}
                          onClose={() => setOpenId(null)}
                        />
                      </td>
                    </tr>,
                  );
                }
                return out;
              })}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" class="cx-text-button cx-schema-copy" aria-expanded={copying} onClick={() => setCopying(!copying)}>
        {t("agents.schemaStartFrom")}
      </button>
      {copying ? (
        <ul class="cx-schema-packs">
          {STARTER_PACKS.map((pk) => (
            <li key={pk.id}>
              <button
                type="button"
                class="cx-lab-pick"
                title={pk.description}
                onClick={() => {
                  add((cur) => draftFromPack(pk, cur, t("agents.schemaCopyName", { pack: pk.id }), new Date()));
                  setCopying(false);
                }}
              >
                {t("agents.packName", { pack: pk.id, version: pk.version })}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

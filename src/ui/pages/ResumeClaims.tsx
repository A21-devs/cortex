/**
 * Your resume in Checks: each line of the resume Add sources › Your resume was given, with whether the record
 * supports it (Supported, Partly supported, Not found) and the entries it rests on, which open in the reader.
 * Nothing here changes the record; it only shows when a resume has been checked.
 */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ClaimVerdict, ResumeStatus } from "../../shared/resume";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { StatusPill } from "../primitives/buttons";
import { openItemReader, resolveOrdinal, useIndex } from "../reader/readerKit";

const VERDICT: Readonly<Record<ClaimVerdict, { tone: "ok" | "warn" | "muted"; label: "checks.claimSupported" | "checks.claimPartly" | "checks.claimNotFound" }>> = {
  supported: { tone: "ok", label: "checks.claimSupported" },
  partly: { tone: "warn", label: "checks.claimPartly" },
  "not-found": { tone: "muted", label: "checks.claimNotFound" },
};

export function ResumeClaims(): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const index = useIndex(s);
  const [st, setSt] = useState<ResumeStatus | null>(null);
  useEffect(() => {
    const resume = s.resume;
    if (!resume) return;
    let live = true;
    const stop = resume.version.subscribe(() => {
      void resume.status().then((v) => live && setSt(v), () => undefined);
    });
    return () => {
      live = false;
      stop();
    };
  }, [s]);
  if (!st?.claims || st.claims.length === 0) return null;
  return (
    <details class="cx-resume-claims" open>
      <summary>{t("checks.resumeHeading", { n: st.claims.length })}</summary>
      <ul class="cx-resume-list">
        {st.claims.map((c) => (
          <li class="cx-resume-claim">
            <StatusPill state={VERDICT[c.verdict].tone}>{t(VERDICT[c.verdict].label)}</StatusPill> <span class="cx-resume-text">{c.text}</span>
            {c.entries.length > 0 ? (
              <span class="cx-note cx-resume-rests">
                {" "}
                {t("checks.claimRests")}:{" "}
                {c.entries.map((e) => (
                  <button type="button" class="cx-text-button" onClick={() => openItemReader(s, leaf, resolveOrdinal(s, e.id, index), index)}>
                    {e.title || e.id}
                  </button>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

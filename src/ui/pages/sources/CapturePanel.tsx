/**
 * Sources › Live capture in your browser (plugin/captureServer.ts, browser-addon/). Off until the person ticks the
 * sites they want and agrees to the consent text, which names exactly what is kept. Once on: the receiver's address
 * and state, a pause switch, the per-site approve list, the token to copy into the add-on, the add-on to save, the
 * counts of what was taken and what was refused (by reason), and Turn off. Hidden where the host has no receiver.
 */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { REFUSAL_REASONS, totalRefused, type CaptureService, type CaptureStatus } from "../../../shared/capture";
import type { CaptureSiteId } from "../../../shared/settings";
import { useServices } from "../../context";
import { t } from "../../copy";
import { confirm } from "../../modals/ConfirmModal";
import { Button, StatusPill, TextButton } from "../../primitives/buttons";
import { fmtInt, isoMs } from "../../valueLabels";
import { ChangeSlot, Load, copyToClipboard, useChange, useFmt, useLoad } from "../PageFrame";

export function CapturePanel(): JSX.Element | null {
  const s = useServices();
  return s.capture ? <CaptureBody cap={s.capture} /> : null;
}

/** The sentence for a receiver that is on but not listening. */
export function problemText(st: Pick<CaptureStatus, "problem" | "port">): string | null {
  switch (st.problem) {
    case "port-in-use":
      return t("liveCapture.problemPort", { port: st.port });
    case "failed":
      return t("liveCapture.problemFailed");
    case "other-computer":
      return t("liveCapture.problemOther");
    default:
      return null;
  }
}

function CaptureBody(p: { cap: CaptureService }): JSX.Element {
  const s = useServices();
  const fmt = useFmt();
  const change = useChange();
  const [nonce, setNonce] = useState(0);
  const refresh = () => setNonce((n) => n + 1);
  const status = useLoad(() => p.cap.status(), [nonce]);
  const [picked, setPicked] = useState<ReadonlySet<CaptureSiteId>>(new Set());
  const [port, setPort] = useState("");
  const fail = () => change.post(t("errors.action"));
  // The sample record is showing: nothing is turned on from here.
  const sample = s.sandbox?.value === true;

  // Counts move while pages are open: look again every few seconds.
  useEffect(() => {
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  const turnOn = (st: CaptureStatus) => {
    void confirm(s.app, { title: t("liveCapture.consentTitle"), body: t("liveCapture.consentBody", { address: st.address }), confirm: t("liveCapture.consentConfirm"), cancel: t("liveCapture.consentCancel") }).then((ok) => {
      if (ok) void p.cap.turnOn([...picked]).then(refresh, fail);
    });
  };
  const turnOff = () => {
    void confirm(s.app, { title: t("liveCapture.offTitle"), body: t("liveCapture.offBody"), confirm: t("liveCapture.offConfirm"), cancel: t("dialogs.cancel"), warning: true }).then((ok) => {
      if (ok) void p.cap.turnOff().then(() => (change.post(t("liveCapture.offDone")), refresh()), fail);
    });
  };
  const copyToken = () => {
    void p.cap
      .token()
      .then((tok) => copyToClipboard(tok))
      .then((ok) => change.post(t(ok ? "liveCapture.tokenCopied" : "liveCapture.tokenNoCopy")), fail);
  };
  const newToken = () => {
    void confirm(s.app, { title: t("liveCapture.newTokenTitle"), body: t("liveCapture.newTokenBody"), confirm: t("liveCapture.newTokenConfirm"), cancel: t("dialogs.cancel"), warning: true }).then((ok) => {
      if (ok) void p.cap.newToken().then(() => change.post(t("liveCapture.tokenRenewed")), fail);
    });
  };
  const saveAddon = () => {
    void p.cap.saveAddon().then((path) => {
      if (path !== null) change.post(t("liveCapture.addonSaved", { path }));
    }, fail);
  };
  const setNumber = (st: CaptureStatus) => {
    const n = Number(port || st.port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return fail();
    void p.cap.setPort(n).then(() => (change.post(t("liveCapture.portSaved", { port: n })), setPort(""), refresh()), fail);
  };

  return (
    <section class="cx-capture" aria-label={t("liveCapture.title")}>
      <Load value={status} failed={t("liveCapture.failed")} rows={3}>
        {(st) => {
          const problem = problemText(st);
          const refused = totalRefused(st.counts);
          return (
            <>
              <div class="cx-capture-head">
                <h3>{t("liveCapture.title")}</h3>
                <StatusPill state={!st.enabled ? "muted" : st.paused ? "warn" : st.running ? "ok" : "serious"}>
                  {t(!st.enabled ? "liveCapture.pillOff" : st.paused ? "liveCapture.pillPaused" : st.running ? "liveCapture.pillOn" : "liveCapture.notListening")}
                </StatusPill>
              </div>
              <p class="cx-note">{t("liveCapture.intro")}</p>

              <fieldset class="cx-choice-group">
                <legend>{t("liveCapture.sites")}</legend>
                {st.sites.map((site) => {
                  const on = st.enabled ? site.approved : picked.has(site.id);
                  return (
                    <label class="cx-choice">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => {
                          const v = (e.currentTarget as HTMLInputElement).checked;
                          if (st.enabled) void p.cap.setSite(site.id, v).then(refresh, fail);
                          else setPicked((cur) => new Set(v ? [...cur, site.id] : [...cur].filter((x) => x !== site.id)));
                        }}
                      />
                      <span>{t("liveCapture.siteLine", { site: site.label, hosts: site.hosts.join(", ") })}</span>
                    </label>
                  );
                })}
              </fieldset>

              {!st.enabled ? (
                <div class="cx-capture-actions">
                  <Button primary disabled={picked.size === 0 || sample} onClick={() => turnOn(st)}>
                    {t("liveCapture.turnOn")}
                  </Button>
                  {sample ? <span class="cx-note">{t("liveCapture.sampleNote")}</span> : picked.size === 0 ? <span class="cx-note">{t("liveCapture.pickOne")}</span> : null}
                </div>
              ) : (
                <>
                  <p class="cx-note cx-mono">{st.running ? t("liveCapture.listening", { address: st.address }) : t("liveCapture.notListening")}</p>
                  {problem !== null ? <p class="cx-note cx-capture-problem">{problem}</p> : null}
                  {st.paused ? <p class="cx-note">{t("liveCapture.pausedLine")}</p> : null}
                  <div class="cx-capture-actions">
                    <Button onClick={() => void p.cap.setPaused(!st.paused).then(refresh, fail)}>{t(st.paused ? "liveCapture.resume" : "liveCapture.pause")}</Button>
                    <Button onClick={turnOff}>{t("liveCapture.turnOff")}</Button>
                  </div>

                  <h4>{t("liveCapture.tokenTitle")}</h4>
                  <p class="cx-note">{t("liveCapture.tokenNote")}</p>
                  <div class="cx-capture-actions">
                    <Button onClick={copyToken}>{t("liveCapture.copyToken")}</Button>
                    <TextButton onClick={newToken}>{t("liveCapture.newToken")}</TextButton>
                  </div>
                  <div class="cx-capture-actions">
                    <label class="cx-capture-port">
                      <span>{t("liveCapture.portLabel")}</span>
                      <input class="cx-input cx-mono" type="number" min={1024} max={65535} value={port === "" ? String(st.port) : port} onInput={(e) => setPort((e.currentTarget as HTMLInputElement).value)} />
                    </label>
                    <Button onClick={() => setNumber(st)}>{t("liveCapture.portSet")}</Button>
                  </div>

                  <h4>{t("liveCapture.addonTitle")}</h4>
                  <p class="cx-note">{t("liveCapture.addonNote")}</p>
                  <div class="cx-capture-actions">
                    <Button onClick={saveAddon}>{t("liveCapture.saveAddon")}</Button>
                  </div>

                  <p class="cx-note cx-mono">{t("liveCapture.counts", { taken: fmtInt(st.counts.accepted), waiting: fmtInt(st.waiting), repeats: fmtInt(st.counts.duplicates) })}</p>
                  {st.counts.lastAt !== "" ? <p class="cx-note cx-mono">{t("liveCapture.lastTurn", { when: fmt.rel(isoMs(st.counts.lastAt)) })}</p> : null}
                  <h4>{t("liveCapture.refusedTitle")}</h4>
                  {refused === 0 ? (
                    <p class="cx-note">{t("liveCapture.refusedNone")}</p>
                  ) : (
                    <ul class="cx-capture-refused">
                      {REFUSAL_REASONS.filter((r) => st.counts.refused[r] > 0).map((r) => (
                        <li class="cx-mono">
                          {fmtInt(st.counts.refused[r])} · {t(`liveCapture.reasons.${r}` as const)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {refused > 0 || st.counts.accepted > 0 ? (
                    <TextButton onClick={() => void p.cap.resetCounts().then(refresh, fail)}>{t("liveCapture.resetCounts")}</TextButton>
                  ) : null}
                </>
              )}
            </>
          );
        }}
      </Load>
      <ChangeSlot state={change} />
    </section>
  );
}

/**
 * Empty stage before setup (CORTEX-UX §5.2, §5.28; ORIG-09): the haze at 1.5× brightness (renderer) and a centred
 * 360 px glass card: "Your record is empty", the body line, and a first-run checklist that ticks itself off from
 * real actions (Add a source; Open one conversation frond, "Double-click a branch off the spine"; Ask one
 * question, "Press Tab in the command line"; the checklist and its Ask item ship in P1). Buttons Add sources
 * (primary: the first-run step, §5.26) and Explore the sample record (P2). Once data arrives the checklist moves
 * into a small card in the banner slot until every item is ticked; its menu has "Hide checklist". Checklist
 * state is per device (ui/deviceState.ts). The tour is offered separately (ui/walkthrough). Owner: E11.
 */
import type { JSX } from "preact";
import { featureOn } from "../../shared/features";
import { useServices } from "../context";
import { t } from "../copy";
import { CHECKLIST_STEPS, checklistComplete, hideChecklist, type ChecklistStep } from "../deviceState";
import { Button, Icon, IconButton } from "../primitives/buttons";
import { showMenu } from "../primitives/menu";
import { openAddSources } from "../header/Header";
import { runCortexCommand } from "../header/MoreMenu";

export const CHECKLIST: readonly { step: ChecklistStep; key: "firstRun.addSource" | "firstRun.openFrond" | "firstRun.askQuestion"; hint?: "firstRun.openFrondHint" | "firstRun.askQuestionHint" }[] = [
  { step: "add-source", key: "firstRun.addSource" },
  { step: "open-frond", key: "firstRun.openFrond", hint: "firstRun.openFrondHint" },
  { step: "ask-question", key: "firstRun.askQuestion", hint: "firstRun.askQuestionHint" },
];

/** The checklist items this build offers ("Ask one question" once Ask has shipped). */
export function checklistSteps(): ChecklistStep[] {
  return CHECKLIST.filter((c) => c.step !== "ask-question" || featureOn("ask")).map((c) => c.step);
}

export function FirstRunCard(p: { compact?: boolean }): JSX.Element | null {
  const s = useServices();
  const device = s.device.value;
  const steps = checklistSteps();
  const showList = featureOn("hints");
  if (p.compact && (!showList || device.checklistHidden || checklistComplete(device, steps))) return null;
  const items = CHECKLIST.filter((c) => steps.includes(c.step));
  const list = showList ? (
    <ul class="cx-checklist" aria-label={t("firstRun.title")}>
      {items.map((c) => {
        const done = device.checklist[c.step];
        return (
          <li key={c.step} class={done ? "is-done" : ""}>
            <span class="cx-check" aria-hidden="true">
              {done ? <Icon name="check" /> : null}
            </span>
            <span class="cx-check-text">
              <span class="cx-sr-only">{done ? "✓ " : ""}</span>
              {t(c.key)}
            </span>
            {c.hint && !done ? <small class="cx-checklist-hint">{t(c.hint)}</small> : null}
          </li>
        );
      })}
    </ul>
  ) : null;
  if (p.compact) {
    return (
      <section class="cx-first-run cx-glass is-compact" aria-label={t("firstRun.title")} data-cx-overlay="banner">
        {list}
        <IconButton icon="more" label={t("firstRun.hideChecklist")} hasPopup="menu" class="cx-first-run-menu" onClick={(e) => showMenu([{ value: "hide", label: t("firstRun.hideChecklist") }], e.currentTarget as HTMLElement, () => s.device.update(hideChecklist))} />
      </section>
    );
  }
  return (
    <section class="cx-first-run cx-glass" aria-label={t("firstRun.title")} data-cx-overlay="first-run">
      <h2 class="cx-first-run-title">{t("firstRun.title")}</h2>
      <p class="cx-first-run-body">{t("firstRun.body")}</p>
      {s.settings.value.general.firstRunChoice === "no-model" ? <p class="cx-first-run-body cx-note">{t("firstRun.noModelNote")}</p> : null}
      {list}
      <div class="cx-first-run-actions">
        <Button primary icon="addSources" onClick={() => void openAddSources(s)}>
          {t("header.addSources")}
        </Button>
        {featureOn("sampleRecord") ? <Button onClick={() => runCortexCommand(s.app, "toggle-sample")}>{t("firstRun.explore")}</Button> : null}
      </div>
    </section>
  );
}

export { CHECKLIST_STEPS };

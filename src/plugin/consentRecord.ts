/**
 * The record's account of a consent change: each change goes into the record the normal way (a written entry, then the seal
 * run, plugin/handoverFlow.ts), so the day it happened stands and the Access log shows it. The text is ui/consentEntry.ts.
 */
import type { ConsentChange } from "../shared/consent";
import { consentEntry } from "../ui/consentEntry";
import { recordSealed, type RecordOutcome } from "./handoverFlow";
import type { CortexServices } from "./services";

export { consentEntry };

/** Write the entry and seal it. Never throws; the caller says so when it could not be recorded. */
export async function recordConsent(sv: Pick<CortexServices, "sandbox" | "newEntry" | "runner">, change: ConsentChange, label?: (id: string) => string): Promise<RecordOutcome> {
  return recordSealed(sv, consentEntry(change, undefined, label));
}

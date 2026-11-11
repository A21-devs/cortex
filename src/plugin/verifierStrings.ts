import { VERIFIER_KEYS, type VerifierKey, type VerifierStrings } from "../store/verifierKeys";
import { t, type CopyKey } from "../ui/copy";

/** The verifier page's text and the pack README texts, from ui/copy.ts (group `verifier`), handed to the runner with each request. */
export function verifierStrings(): VerifierStrings {
  const out = {} as Record<VerifierKey, string>;
  for (const k of VERIFIER_KEYS) out[k] = t(`verifier.${k}` as CopyKey);
  return out;
}

/**
 * Query tokens (CORTEX-UX §0 item 5, §5.9; H4): one removable 24 px pill per active filter, in the order added —
 * text, group (area, folder, project, kind, source, speaker), time (day, week, month, range), chart band, set (an
 * Ask result set or chart highlights). OR within a kind, AND across kinds (worker `query`). They ARE the status
 * display. The draft token that lights what you are typing is not shown as a pill. Owner: E12.
 */
import type { JSX } from "preact";
import type { QueryToken } from "../../shared/protocol/worker";
import { removeToken } from "../../state/actions";
import { useLeaf } from "../context";
import { t } from "../copy";

/** Id of the transient text token that lights matches while the query is being typed. */
export const DRAFT_TOKEN_ID = "draft:text";

export function visibleTokens(tokens: readonly QueryToken[]): QueryToken[] {
  return tokens.filter((tok) => tok.id !== DRAFT_TOKEN_ID);
}

export function Tokens(): JSX.Element | null {
  const leaf = useLeaf();
  const tokens = visibleTokens(leaf.store.slices.ui.value.tokens);
  if (tokens.length === 0) return null;
  return (
    <span class="cx-tokens" role="list" aria-label={t("command.tokens")}>
      {tokens.map((tok) => (
        <span class={`cx-token is-${tok.kind}`} role="listitem">
          <span class="cx-token-label" title={tok.label}>
            {tok.label}
          </span>
          <button type="button" class="cx-token-x" aria-label={t("command.removeToken", { label: tok.label })} onClick={() => removeToken(leaf.store, tok.id)}>
            ×
          </button>
        </span>
      ))}
    </span>
  );
}

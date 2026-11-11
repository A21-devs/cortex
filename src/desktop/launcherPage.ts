/**
 * The quick window's page: Cortex's mark, the area name, and one "Ask or search" field. Plain DOM, no framework.
 * Enter searches, Ctrl+Enter asks (the text is handed to Ask, never sent), Esc hides. The window is reused, so the
 * field is emptied each time it opens.
 */
import { CORTEX_GLYPH_PATHS } from "../ui/icons";
import type { LauncherInit, LauncherSubmit } from "./launcherCore";

interface Bridge {
  onInit(fn: (init: LauncherInit) => void): void;
  submit(m: LauncherSubmit): void;
  hide(): void;
}

const bridge = (window as unknown as { cortexLauncher?: Bridge }).cortexLauncher;
const SVG = "http://www.w3.org/2000/svg";

/** Draw the card into `root`; returns what the page needs to update. Exported so a test can drive it. */
export function mountLauncher(root: HTMLElement, send: { submit(m: LauncherSubmit): void; hide(): void }): { apply(init: LauncherInit): void } {
  root.replaceChildren();
  root.setAttribute("role", "dialog");
  const head = document.createElement("div");
  head.className = "cxl-head";
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "cxl-mark");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of [CORTEX_GLYPH_PATHS.outer, CORTEX_GLYPH_PATHS.inner]) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  const seed = document.createElementNS(SVG, "circle");
  seed.setAttribute("cx", String(CORTEX_GLYPH_PATHS.seed.cx));
  seed.setAttribute("cy", String(CORTEX_GLYPH_PATHS.seed.cy));
  seed.setAttribute("r", String(CORTEX_GLYPH_PATHS.seed.r));
  seed.setAttribute("class", "cxl-seed");
  svg.appendChild(seed);
  const word = document.createElement("span");
  word.className = "cxl-word";
  const space = document.createElement("span");
  space.className = "cxl-space";
  head.append(svg, word, space);
  const field = document.createElement("div");
  field.className = "cxl-field";
  const input = document.createElement("input");
  input.className = "cxl-input";
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.maxLength = 500;
  field.appendChild(input);
  const hint = document.createElement("div");
  hint.className = "cxl-hint";
  root.append(head, field, hint);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      send.hide();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const text = input.value.trim();
      if (text === "") return;
      send.submit({ mode: e.ctrlKey || e.metaKey ? "ask" : "find", text });
    }
  });
  return {
    apply(init) {
      word.textContent = init.wordmark;
      space.textContent = `· ${init.space}`;
      input.placeholder = init.placeholder;
      input.setAttribute("aria-label", init.placeholder);
      hint.textContent = init.hint;
      root.setAttribute("aria-label", init.ariaLabel);
      input.value = "";
      input.focus();
    },
  };
}

if (bridge) {
  const root = document.getElementById("cxl");
  if (root) {
    const card = mountLauncher(root, bridge);
    bridge.onInit((init) => card.apply(init));
  }
}

/**
 * Obsidian's icons for Cortex Desktop: the Lucide set (lucide-static, bundled) under the names Obsidian uses
 * ("chart-column", "rotate-3d", optional "lucide-" prefix, Lucide's own aliases), plus icons registered with
 * addIcon() (a 0 0 100 100 view box, as in Obsidian). setIcon() replaces the element's children with the SVG.
 */
import * as lucide from "lucide-static";

const custom = new Map<string, string>();
const parsed = new Map<string, SVGSVGElement | null>();
const LUCIDE = lucide as unknown as Record<string, string | undefined>;

function pascal(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("");
}

/** The SVG text of a Lucide icon, or undefined. */
export function lucideSvg(iconId: string): string | undefined {
  const id = iconId.replace(/^lucide-/, "");
  const svg = LUCIDE[pascal(id)];
  return typeof svg === "string" ? svg : undefined;
}

function parse(markup: string): SVGSVGElement | null {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  const el = t.content.firstElementChild;
  return el instanceof SVGSVGElement ? el : null;
}

function build(iconId: string): SVGSVGElement | null {
  const body = custom.get(iconId);
  if (body !== undefined) {
    return parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%" class="svg-icon ${iconId.replace(/[^a-z0-9_-]/gi, "")}">${body}</svg>`);
  }
  const svg = lucideSvg(iconId);
  if (!svg) return null;
  const el = parse(svg);
  if (!el) return null;
  el.setAttribute("class", `svg-icon lucide-${iconId.replace(/^lucide-/, "")}`);
  return el;
}

/** A fresh SVG element for an icon id, or null when the id is unknown. */
export function getIcon(iconId: string): SVGSVGElement | null {
  if (!parsed.has(iconId)) parsed.set(iconId, build(iconId));
  const tpl = parsed.get(iconId);
  return tpl ? (tpl.cloneNode(true) as SVGSVGElement) : null;
}

export function setIcon(parent: HTMLElement, iconId: string): void {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
  const svg = getIcon(iconId);
  if (svg) parent.appendChild(svg);
}

export function addIcon(iconId: string, svgContent: string): void {
  custom.set(iconId, svgContent);
  parsed.delete(iconId);
}

export function removeIcon(iconId: string): void {
  custom.delete(iconId);
  parsed.delete(iconId);
}

export function getIconIds(): string[] {
  return [...custom.keys(), ...Object.keys(LUCIDE).map((k) => `lucide-${k.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`)];
}

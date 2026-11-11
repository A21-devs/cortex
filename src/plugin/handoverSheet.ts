/**
 * The printable hand-over sheet for one key share, and the read-me inside a hand-over bundle. Plain HTML with no script and no
 * outside file (a content-security policy forbids both), so it prints the same everywhere and sends nothing. The share appears
 * as 32 numbered words and as a QR code; a sheet made after the words were no longer held says so instead of showing any.
 */
import { qrMatrix, qrSvg } from "../shared/qr";
import { shareToQrText, shareToWords } from "../shared/crypto/shamir";
import { SETTINGS_COPY, t } from "../ui/copy";

export interface SheetInput {
  /** The holder's name ("" when the share is not named yet). */
  holder: string;
  contact: string;
  instructions: string;
  /** Share number and totals. */
  x: number;
  n: number;
  k: number;
  checksum: string;
  /** The 40 share bytes, or null when they are no longer held (the sheet then carries no words). */
  share: Uint8Array | null;
  /** `yyyy-mm-dd`. */
  date: string;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The share's QR code as SVG, or null when it cannot be drawn. */
export function shareQrSvg(share: Uint8Array, title: string): string | null {
  const m = qrMatrix(shareToQrText(share));
  return m ? qrSvg(m, { title, px: 220 }) : null;
}

export function buildSheetHtml(i: SheetInput): string {
  const v = { name: i.holder, x: i.x, n: i.n, k: i.k, date: i.date };
  const words = i.share ? shareToWords(i.share) : null;
  const qr = i.share ? shareQrSvg(i.share, SETTINGS_COPY.lock.shares.qrLabel.replace("{x}", String(i.x))) : null;
  const rows: string[] = [];
  if (i.holder) rows.push(`<p><strong>${esc(t("handover.sheetHolder"))}:</strong> ${esc(i.holder)}</p>`);
  if (i.contact) rows.push(`<p><strong>${esc(t("handover.sheetReach"))}:</strong> ${esc(i.contact)}</p>`);
  const instr = i.instructions ? `<h2>${esc(t("handover.sheetInstr"))}</h2><p class="pre">${esc(i.instructions)}</p>` : "";
  const wordsBlock = words
    ? `<h2>${esc(t("handover.sheetWords"))}</h2><p class="note">${esc(t("handover.sheetWordsNote"))}</p><ol class="words">${words.map((w) => `<li>${esc(w)}</li>`).join("")}</ol>`
    : `<p class="note">${esc(t("handover.sheetNoWords"))}</p>`;
  const qrBlock = qr ? `<h2>${esc(t("handover.sheetQr"))}</h2><div class="qr">${qr}</div><p class="note">${esc(t("handover.sheetQrNote"))}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t("handover.sheetTitle"))}</title>
<style>
body{margin:0;background:#fff;color:#1c1c20;font:16px/1.5 system-ui,sans-serif}
main{max-width:44rem;margin:0 auto;padding:2rem 1.25rem 3rem}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:1.6rem 0 .3rem}
p{margin:.35rem 0}.note{color:#555}.pre{white-space:pre-wrap}
.code{font:600 1.1rem ui-monospace,Consolas,monospace;letter-spacing:.04em}
ol.words{list-style:none;counter-reset:w;display:grid;grid-template-columns:repeat(4,1fr);gap:.35rem .8rem;padding:0;margin:.6rem 0}
ol.words li{counter-increment:w;font:600 1.05rem ui-monospace,Consolas,monospace;border-bottom:1px solid #ccc;padding:.15rem 0}
ol.words li::before{content:counter(w) ". ";color:#777;font-weight:400}
.qr{margin:.6rem 0}.qr svg{width:220px;height:220px;border:1px solid #ccc}
.foot{margin-top:2rem;border-top:1px solid #ccc;padding-top:.8rem;color:#555;font-size:.92rem}
@media print{main{padding:0}.noprint{display:none}}
</style>
</head>
<body>
<main>
<h1>${esc(t("handover.sheetTitle"))}</h1>
${i.holder ? `<p>${esc(t("handover.sheetFor", v))}</p>` : ""}
<p>${esc(t("handover.sheetIntro", v))}</p>
<h2>${esc(t("handover.sheetShare", v))}</h2>
<p><strong>${esc(t("handover.sheetCode"))}:</strong> <span class="code">${esc(i.checksum)}</span></p>
<p class="note">${esc(t("handover.sheetCodeNote"))}</p>
${rows.join("\n")}
${instr}
${wordsBlock}
${qrBlock}
<h2>${esc(t("handover.sheetHow"))}</h2>
<p>${esc(t("handover.sheetKeep"))}</p>
<p>${esc(t("handover.sheetNoAuto", v))}</p>
<div class="foot"><p>${esc(t("handover.sheetDate", v))}</p><p class="noprint">${esc(t("handover.sheetPrint"))}</p></div>
</main>
</body>
</html>
`;
}

export interface ReadmeInput {
  name: string;
  date: string;
  entries: number;
  n: number;
  k: number;
  /** The file name of the share sheet inside the bundle, or null when none is inside. */
  shareFile: string | null;
  hasLetter: boolean;
}

export function buildReadme(i: ReadmeInput): string {
  const v = { name: i.name, date: i.date, entries: i.entries, n: i.n, k: i.k, have: i.shareFile ? 1 : 0, file: i.shareFile ?? "" };
  const lines = [t("handover.readmeTitle"), "", t("handover.readme1", v), "", t("handover.readme2", v), "", t("handover.readme3", v), "", t("handover.readme4", v), ""];
  lines.push(i.shareFile ? t("handover.readmeShare", v) : t("handover.readmeNoShare"));
  if (i.hasLetter) lines.push(t("handover.readmeLetter"));
  lines.push("", t("handover.readme5"), t("handover.readme6"), "");
  return lines.join("\r\n");
}

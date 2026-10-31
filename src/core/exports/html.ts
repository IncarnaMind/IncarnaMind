/**
 * A Mind as one HTML file (#151): the print page's document (./printHtml) with its notes at
 * the end, each linked from its marker and back. Nothing in it is fetched: the styles are
 * inline, fonts are the reader's own, maths is MathML (which browsers draw without KaTeX's
 * styles or fonts) and pictures are data URIs; the page's policy refuses everything else.
 */

import { cssString } from "../../shared/mindStyle";
import { lineHeightCss } from "../../shared/paragraphFormat";
import type { Language } from "../language";
import type { Block } from "../mindText";
import type { ExportLabels } from "./labels";
import { renderPrintHtml } from "./printHtml";

const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const HTML_STYLES = `
:root{--ink:#17191c;--ink-answer:#3b4048;--ink-meta:#656b74;--rule:#e3e5e9;--rule-strong:#d5d8dd;--frame:#f4f5f7;--warning:#9a4a06;--serif:Charter,"Iowan Old Style","Source Serif 4","Songti SC","Noto Serif CJK SC","Source Han Serif SC",SimSun,ui-serif,Georgia,serif;--sans:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;--mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace}
body{margin:0;background:#fff;color:var(--ink);font-family:var(--serif);font-size:1.0625rem;line-height:1.6;overflow-wrap:break-word}
main,.notes{max-width:42rem;margin:0 auto;padding:0 1.25rem}
main{padding-top:3rem}
.notes{padding-bottom:4rem}
.mind-title{margin:0 0 1.25rem;font-size:2rem;line-height:1.25;font-weight:600}
h2,h3,h4,h5,h6{margin:1.8rem 0 .5rem;line-height:1.3;font-weight:600}
h2{font-size:1.4rem}h3{font-size:1.2rem}h4,h5,h6{font-size:1.0625rem}
p{margin:0 0 .9rem}
.question{font-family:var(--sans);font-size:.95rem;color:var(--ink-meta)}
.question-label{font-weight:600}
sup.note-ref{margin-left:.05rem;font-family:var(--sans);font-size:.7em;line-height:0}
sup.note-ref a{text-decoration:none;color:#2457a7}
.unverified{color:var(--warning)}
ins.change{text-decoration:underline;text-underline-offset:.15em}
del.change{color:var(--ink-meta);text-decoration:line-through}
.chart-picture{margin-bottom:.3rem;text-align:center}
.caption{margin-bottom:.6rem;font-family:var(--sans);font-size:.9rem;line-height:1.4;color:var(--ink-answer)}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--rule-strong);text-underline-offset:.15em}
mark{background:#fcebc0;color:inherit}
code{font-family:var(--mono);font-size:.88em}
pre{margin:0 0 .9rem;padding:.6rem .8rem;border-radius:4px;background:var(--frame);font-size:.85rem;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
pre code{font-size:inherit}
blockquote{margin:0 0 .9rem;padding-left:1rem;border-left:3px solid var(--rule-strong);color:var(--ink-answer)}
ul,ol{margin:0 0 .9rem;padding-left:1.5rem}
li>p{margin-bottom:.3rem}
hr{margin:1.2rem 0;border:0;border-top:1px solid var(--rule-strong)}
table{width:100%;margin:0 0 1.1rem;border-collapse:collapse;font-size:.95rem;line-height:1.4}
th,td{padding:.3rem .5rem;border:1px solid var(--rule-strong);text-align:left;vertical-align:top}
th{background:var(--frame);font-family:var(--sans);font-weight:600}
th>:last-child,td>:last-child{margin-bottom:0}
.align-center{text-align:center}.align-right{text-align:right}
.math-display{margin:.5rem 0 1rem;text-align:center;overflow-x:auto}
.math-source{color:var(--ink-answer)}
img{max-width:100%;height:auto}
.image-missing{color:var(--ink-meta)}
.small-caps{font-variant:small-caps}
.page-break{break-after:page}
.entry{margin-bottom:.5rem}
.notes{border-top:1px solid var(--rule-strong);margin-top:2.5rem;padding-top:.5rem;font-size:.9rem;line-height:1.5;color:var(--ink-answer)}
.notes h2{margin-top:1rem;font-family:var(--sans);font-size:1rem}
.notes ol{padding-left:1.8rem}
.notes li{margin-bottom:.3rem}
.notes li:target{background:#fcebc0}
.backref{margin-left:.35rem;text-decoration:none;color:#2457a7}
@media (prefers-color-scheme:dark){:root{--ink:#e8eaed;--ink-answer:#c3c7ce;--ink-meta:#9aa0a8;--rule-strong:#3b4048;--frame:#23262b;--warning:#e0a15a}body{background:#17191c}mark,.notes li:target{background:#5a4a1a}sup.note-ref a,.backref{color:#8ab4f8}}
@media print{main{padding-top:0}sup.note-ref a,.backref{color:inherit}}
`.replace(/\n/g, "");

/** The Mind's own font ahead of the export's, which the reader's computer falls back to. */
export const bodyFamily = (family: string) => `${cssString(family)},var(--serif)`;

export const bodyFontStyle = (family: string | null) =>
  family === null ? "" : `body{font-family:${bodyFamily(family)}}`;

/** The Mind's line spacing, a multiple of a single line, over the export's. */
export const bodyLineStyle = (multiple: number | null) =>
  multiple === null
    ? ""
    : `body{line-height:${lineHeightCss({ rule: "auto", value: multiple }, String)}}`;

/** The print page lays tables out itself; a browser's tables, and the validator, want a body. */
export const withTableBodies = (body: string) =>
  body.replaceAll("<table>", "<table><tbody>").replaceAll("</table>", "</tbody></table>");

/**
 * A Mind's notes after its text. `compact` is the shared web page's list (#1022): each line
 * numbered as its Citation is, in the page's small sans, under a small label.
 */
export function notesSection(
  notes: readonly string[],
  labels: ExportLabels,
  { compact = false, title = labels.notes }: { compact?: boolean; title?: string } = {},
): string {
  if (notes.length === 0) return "";
  const list = notes
    .map((note, index) => {
      const number = index + 1;
      const shown = compact ? `<span class="note-number">${number}</span> · ` : "";
      return `<li id="note-${number}">${shown}${note}<a class="backref" href="#ref-${number}" aria-label="${escapeText(labels.backToText)}" title="${escapeText(labels.backToText)}">↩\ufe0e</a></li>`;
    })
    .join("");
  return `<section class="notes${compact ? " notes-compact" : ""}" aria-labelledby="notes-title"><h2 id="notes-title">${escapeText(title)}</h2><ol>${list}</ol></section>`;
}

export function htmlFile({
  language,
  name,
  policy,
  styles,
  body,
}: {
  language: Language;
  name: string;
  policy: string;
  styles: string;
  body: string;
}): string {
  return [
    "<!DOCTYPE html>",
    `<html lang="${language === "zh-CN" ? "zh-CN" : "en"}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    `<title>${escapeText(name)}</title>`,
    `<style>${styles}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** A Mind's HTML file: its text in `<main>`, its notes as a numbered list after it. */
export function renderHtml(
  blocks: readonly Block[],
  labels: ExportLabels,
  {
    language,
    name,
    font,
    lineSpacing,
  }: { language: Language; name: string; font: string | null; lineSpacing: number | null },
): string {
  const printed = renderPrintHtml(blocks, labels, { linkNotes: true });
  return htmlFile({
    language,
    name,
    policy: "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    styles: HTML_STYLES + bodyFontStyle(font) + bodyLineStyle(lineSpacing),
    body: `<main>${withTableBodies(printed.body)}</main>\n${notesSection(printed.notes, labels)}`,
  });
}

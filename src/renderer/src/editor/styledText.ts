/**
 * Text a citation style formatted (#289), for the clipboard: the References block's Copy puts
 * it there as HTML, so Word and Google Docs keep the style's italics, and as plain text. Field
 * text is only ever escaped, never read as markup (ADR-0016).
 */
import type { BibliographyEntry, StyledRun } from "../../../core/api";
import { withNeedsDetailsMark } from "../../../shared/references";

/** A web address a run may link to; anything else stays text. */
export const isWebLink = (href: string) => /^https?:\/\//i.test(href);

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Runs as HTML. */
export function runsHtml(runs: readonly StyledRun[]): string {
  return runs
    .map((run) => {
      let html = escapeHtml(run.text);
      if (run.script) html = `<${run.script}>${html}</${run.script}>`;
      if (run.underline) html = `<u>${html}</u>`;
      if (run.smallCaps) html = `<span style="font-variant: small-caps">${html}</span>`;
      if (run.bold) html = `<b>${html}</b>`;
      if (run.italic) html = `<i>${html}</i>`;
      if (run.link && isWebLink(run.link)) html = `<a href="${escapeHtml(run.link)}">${html}</a>`;
      return html;
    })
    .join("");
}

/** Runs as plain text. */
export const runsText = (runs: readonly StyledRun[]) => runs.map((run) => run.text).join("");

/**
 * A Bibliography as the clipboard takes it: a paragraph per entry, its number first, and
 * `needsDetails` after an entry too thin to cite. Unlike an export's, a pasted list says so.
 */
export function bibliographyClipboard(
  entries: readonly BibliographyEntry[],
  needsDetails: string,
): { text: string; html: string } {
  const runsOf = (entry: BibliographyEntry) =>
    entry.needsDetails ? withNeedsDetailsMark(entry.runs, needsDetails) : entry.runs;
  return {
    text: entries
      .map((entry) => `${entry.label ? `${runsText(entry.label)} ` : ""}${runsText(runsOf(entry))}`)
      .join("\n"),
    html: entries
      .map(
        (entry) =>
          `<p>${entry.label ? `${runsHtml(entry.label)} ` : ""}${runsHtml(runsOf(entry))}</p>`,
      )
      .join(""),
  };
}

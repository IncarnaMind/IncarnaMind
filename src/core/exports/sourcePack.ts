/**
 * The source pack (#134): the pages a Mind cites as one PDF, from the pages saved when its
 * Citations were made (../citedPages), so it holds after a file changes or goes. A cover list
 * names every Citation and the pack page it is on; then each cited Location has a page of its own,
 * its quotes highlighted and numbered as the Mind numbers its Citations. The PDF is printed from
 * the HTML made here, as a Mind's is (./printHtml, src/renderer/print).
 */
import type { CitationForm } from "../../shared/citationStyles";
import { type DrawnPage, type PageBox, quoteBoxes } from "../../shared/citedPage";
import { FootnoteNumbering } from "../../shared/footnoteNumbers";
import { translate } from "../../shared/i18n";
import { citationLocation } from "../../shared/locations";
import type { CitationAttributes } from "../api";
import { citedPageKey } from "../citedPages";
import type { Language } from "../language";
import type { Block, Footnote, Inline } from "../mindText";
import { isBlank } from "./citations";
import { escapeHtml } from "./printHtml";

/** A Citation in the Mind, with the number its marker shows there. */
export interface PackCitation {
  number: number;
  footnote: Footnote;
  attributes: Partial<CitationAttributes>;
}

/**
 * The Mind's Citations, in order, numbered as every surface numbers them (`FootnoteNumbering`):
 * in Numbered, one footnote for each source and place, a later Citation of it repeating its
 * number; among the User's footnotes in every style; side by side as one in a note style; among
 * themselves in a style that cites in the text. A calculated figure takes a number as a footnote
 * does, or a place among the Citations in a style that cites in the text. A Chart's sources have
 * no number in the Mind, so they aren't here.
 */
export function numberCitations(
  blocks: readonly Block[],
  form: CitationForm,
  attributesOf: ReadonlyMap<Footnote, Partial<CitationAttributes>>,
): PackCitation[] {
  const found: PackCitation[] = [];
  const numbering = new FootnoteNumbering();
  let cited = 0;
  const inline = (content: readonly Inline[], insideBlock: boolean) => {
    let together = false;
    for (const item of content) {
      if (item.kind === "citation") {
        const attributes = attributesOf.get(item.footnote) ?? {};
        // A Citation a change still waiting adds or removes is a note of its own (#107, #2292).
        const own = insideBlock || item.inserted !== undefined || item.deleted !== undefined;
        let number: number;
        if (own && form !== "in-text") {
          number = numbering.footnote();
        } else if (form === "numbered") {
          number = numbering.citation({
            documentId: attributes.documentId ?? null,
            contentHash: attributes.contentHash ?? null,
            location: citationLocation(attributes),
            unverified: item.footnote.unverified,
            link: item.footnote.link ?? null,
          }).number;
        } else if (form === "in-text") {
          cited += 1;
          number = cited;
        } else if (together) {
          number = found.at(-1)?.number ?? numbering.footnote();
        } else {
          number = numbering.footnote();
        }
        found.push({ number, footnote: item.footnote, attributes });
        together = true;
      } else if (item.kind === "footnote") {
        numbering.footnote();
        together = false;
      } else if (item.kind === "figure") {
        if (form === "in-text") cited += 1;
        else numbering.footnote();
        together = false;
      } else if (!isBlank(item)) {
        together = false;
      }
    }
  };
  const visit = (block: Block, inside: boolean) => {
    const pending = inside || block.inserted !== undefined || block.deleted !== undefined;
    switch (block.kind) {
      case "paragraph":
      case "heading":
      case "question":
        inline(block.content, pending);
        break;
      case "list":
        for (const item of block.items) for (const child of item) visit(child, pending);
        break;
      case "quote":
        for (const child of block.content) visit(child, pending);
        break;
      case "table":
        for (const row of block.rows)
          for (const cell of row) for (const child of cell.content) visit(child, pending);
        break;
    }
  };
  for (const block of blocks) visit(block, false);
  return found;
}

/** A Citation, and where its quote is on its page; null where it isn't marked there. */
export interface PackEntry {
  citation: PackCitation;
  boxes: PageBox[] | null;
}

/** One page of the pack: a cited Location, the Citations that share it, and its saved picture. */
export interface PackPage {
  entries: PackEntry[];
  /** Null when the page wasn't saved. */
  image: DrawnPage | null;
}

/**
 * A Citation is unverified when the Mind's check didn't find its quote and its saved page
 * doesn't show it either: a page saved before its Document went still does.
 */
export const isUnverified = ({ citation, boxes }: PackEntry) =>
  citation.footnote.unverified && boxes === null;

/**
 * The Locations the Citations cite, in the order they are first cited, each with its saved
 * picture and where the quotes are on it. Citations of one Location and version share a page.
 * One picture is read at a time.
 */
export async function packPages(
  citations: readonly PackCitation[],
  image: (attributes: Partial<CitationAttributes>) => Promise<DrawnPage | null>,
): Promise<PackPage[]> {
  const byLocation = new Map<string, PackCitation[]>();
  for (const citation of citations) {
    const key = citedPageKey(citation.attributes) ?? `source:${citation.footnote.source}`;
    const group = byLocation.get(key);
    if (group) group.push(citation);
    else byLocation.set(key, [citation]);
  }
  const pages: PackPage[] = [];
  for (const group of byLocation.values()) {
    const [first] = group;
    const picture = first ? await image(first.attributes) : null;
    pages.push({
      image: picture,
      entries: group.map((citation) => ({
        citation,
        boxes: picture
          ? quoteBoxes(picture, citation.attributes.quote, citation.attributes.location)
          : null,
      })),
    });
  }
  return pages;
}

const percent = (value: number, of: number) => `${Math.round((value / of) * 100_000) / 1000}%`;

/** A box as the share of the picture it covers, kept inside it. */
function placed(box: PageBox, page: DrawnPage): string {
  const x = Math.min(Math.max(box.x, 0), page.width);
  const y = Math.min(Math.max(box.y, 0), page.height);
  const width = Math.min(box.width, page.width - x);
  const height = Math.min(box.height, page.height - y);
  return `left:${percent(x, page.width)};top:${percent(y, page.height)};width:${percent(width, page.width)};height:${percent(height, page.height)}`;
}

function pictureHtml(page: PackPage, picture: DrawnPage, language: Language): string {
  const source = page.entries[0]?.citation.footnote.source ?? "";
  const alt = translate(language, "export.pack.picture", { source });
  const marks: string[] = [];
  const badges: string[] = [];
  const notes: string[] = [];
  const noted = new Set<string>();
  for (const { citation, boxes } of page.entries) {
    const [top] = boxes ?? [];
    if (!boxes || !top) {
      // One note says a quote isn't on the page: two Citations of a note with the same quote
      // say it once (`#2292`).
      const quote = citation.attributes.quote ?? "";
      const key = `${citation.number}\u0000${quote}`;
      if (noted.has(key)) continue;
      noted.add(key);
      const note = translate(language, "export.pack.notFound", {
        number: citation.number,
        quote,
      });
      notes.push(`<p class="pack-note pack-problem">${escapeHtml(note)}</p>`);
      continue;
    }
    for (const box of boxes) {
      marks.push(`<span class="pack-mark" style="${placed(box, picture)}"></span>`);
    }
    const at = percent(Math.max(top.y, 0), picture.height);
    badges.push(`<span class="pack-badge" style="top:${at}">${citation.number}</span>`);
  }
  const data = Buffer.from(picture.data).toString("base64");
  return (
    `<div class="pack-frame" style="--ratio:${picture.width / picture.height};--pixels:${picture.width}">` +
    `<img src="data:${picture.type};base64,${data}" alt="${escapeHtml(alt)}">` +
    marks.join("") +
    badges.join("") +
    "</div>" +
    notes.join("")
  );
}

type QuoteReader = (attributes: Partial<CitationAttributes>) => string | null;

/** A page that wasn't saved: its quotes, as words. */
function quotesHtml(page: PackPage, language: Language, readQuote: QuoteReader): string {
  // Two Citations of one note with the same quote say it once, under its one number (#2292).
  const shown = new Set<string>();
  const quotes = page.entries.flatMap(({ citation }) => {
    const quote = readQuote(citation.attributes);
    if (!quote) return [];
    const key = `${citation.number}\u0000${quote}`;
    if (shown.has(key)) return [];
    shown.add(key);
    return [
      `<p class="pack-quote"><span class="pack-badge">${citation.number}</span> “${escapeHtml(quote)}”</p>`,
    ];
  });
  const note = escapeHtml(translate(language, "export.pack.noPage"));
  return `<p class="pack-note">${note}</p>${quotes.join("")}`;
}

/**
 * The pack as HTML for the print page: the cover list, then a page for each Location, each
 * starting a sheet. Where the cover list says which page a Citation is on, the print page fills
 * the number in once the pages are laid out (`data-pack` is the Location's place in `pages`).
 */
export function renderSourcePack(
  title: string,
  pages: readonly PackPage[],
  language: Language,
  readQuote: QuoteReader,
): string {
  const t = (key: Parameters<typeof translate>[1]) => escapeHtml(translate(language, key));
  const unverified = ` <span class="unverified">${t("export.unverified")}</span>`;
  // A note stands for every Citation of its source and place: the list names it once.
  const byNumber = new Map<number, { entry: PackEntry; index: number }>();
  pages.forEach((page, index) => {
    for (const entry of page.entries) {
      if (!byNumber.has(entry.citation.number))
        byNumber.set(entry.citation.number, { entry, index });
    }
  });
  const rows = [...byNumber.values()]
    .sort((a, b) => a.entry.citation.number - b.entry.citation.number)
    .map(
      ({ entry, index }) =>
        `<tr><td class="pack-number">${entry.citation.number}</td>` +
        `<td>${escapeHtml(entry.citation.footnote.source)}${isUnverified(entry) ? unverified : ""}</td>` +
        `<td class="pack-ref" data-pack="${index}"></td></tr>`,
    )
    .join("");
  const cover =
    (title ? `<h1 class="mind-title">${escapeHtml(title)}</h1>` : "") +
    `<p class="pack-caption">${t("export.pack.caption")}</p>` +
    `<table class="pack-list"><tr><th>${t("export.pack.column.citation")}</th><th>${t("export.pack.column.source")}</th><th>${t("export.pack.column.page")}</th></tr>${rows}</table>`;
  const sheets = pages.map((page, index) => {
    const numbers = [...new Set(page.entries.map(({ citation }) => citation.number))].join(", ");
    const source = page.entries[0]?.citation.footnote.source ?? "";
    return (
      `<section class="pack-page" data-pack="${index}">` +
      `<h2 class="pack-title"><span class="pack-numbers">${numbers}</span> ${escapeHtml(source)}</h2>` +
      (page.image
        ? pictureHtml(page, page.image, language)
        : quotesHtml(page, language, readQuote)) +
      "</section>"
    );
  });
  return cover + sheets.join("");
}

/**
 * The hidden print window's page (#100). The main process hands it a Mind as HTML
 * (`PrintDocument`, from the core) and prints what it lays out. Chromium has no footnotes in
 * print, so the page makes its own pages: blocks flow into page-sized boxes, each footnote goes
 * to the foot of the page its marker lands on, and a block that won't fit is split between
 * lines, list items or table rows (the heading rows repeating), or moved on whole. A source pack's
 * cited pages (#134) each start a sheet. Nothing here reaches the network: the page's policy
 * allows only the app's own files and the Mind's pictures.
 */
import "../src/fonts.css";
import "./print.css";
import { PAPER, PRINT_ENTRY, type PrintDocument } from "../../shared/printDocument";

/** Room left at each page's foot, so rounding never pushes a page onto a second sheet. */
const SAFETY_PX = 2;

/** What a page's footer takes of the room above the margin's middle, where the page number sits. */
const FOOTER_PX = 12;

/** What a source pack's sheet keeps for its title and the notes under the picture, in CSS pixels. */
const PACK_TEXT_PX = 84;

/** Inline elements a line can't be broken inside: a footnote's number, maths, a picture. */
const ATOMIC = "sup.note-ref, math, img, br, code.math-source, span.image-missing";

interface Page {
  body: HTMLElement;
  notes: HTMLElement;
}

/** Where a line starts: in a text, or before an element. */
type LineStart = { node: Text; offset: number } | { node: Element; offset: null };

interface Line {
  start: LineStart;
  bottom: number;
}

/** The lines of a laid-out block, from where each starts and how far down it reaches. */
function linesOf(block: Element): Line[] {
  const lines: Line[] = [];
  let previous: DOMRect | null = null;
  let broken = false;
  const range = document.createRange();
  const visit = (start: LineStart, rect: DOMRect) => {
    const wrapped =
      previous !== null && rect.left < previous.left - 1 && rect.top > previous.top + 1;
    const last = lines.at(-1);
    if (!last || broken || wrapped) lines.push({ start, bottom: rect.bottom });
    else last.bottom = Math.max(last.bottom, rect.bottom);
    previous = rect;
    broken = false;
  };
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child instanceof Text) {
        const text = child.data;
        for (let offset = 0; offset < text.length; offset++) {
          range.setStart(child, offset);
          range.setEnd(child, offset + 1);
          const rect = range.getClientRects()[0];
          // Spaces folded away at the end of a line have no box.
          if (!rect || (rect.width === 0 && /\s/.test(text[offset] ?? ""))) continue;
          visit({ node: child, offset }, rect);
        }
      } else if (child instanceof Element) {
        if (!child.matches(ATOMIC)) {
          walk(child);
        } else if (child.localName === "br") {
          broken = true;
        } else {
          visit({ node: child, offset: null }, child.getBoundingClientRect());
        }
      }
    }
  };
  walk(block);
  return lines;
}

/** Splits a block where a line starts: the block keeps what comes before; returns the rest. */
function cutAt(block: HTMLElement, at: LineStart): HTMLElement {
  const range = document.createRange();
  if (at.offset === null) range.setStartBefore(at.node);
  else range.setStart(at.node, at.offset);
  range.setEnd(block, block.childNodes.length);
  const rest = block.cloneNode(false) as HTMLElement;
  rest.classList.add("continued");
  rest.append(range.extractContents());
  return rest;
}

const isHeading = (element: Element | null) =>
  element !== null && /^h[1-6]$/.test(element.localName);

/** A heading, or a chart's picture or caption: it goes on to the next page with what follows it. */
const keepsWithNext = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement && (isHeading(element) || element.classList.contains("keep-next"));

/** Blocks split between lines of text. */
const splitsByLine = (block: Element) =>
  block.matches("p:not(.image), pre, .entry") && !block.querySelector("img");

/** Blocks split between the blocks they hold. */
const splitsByChild = (block: Element) => block.matches("ul, ol, li, blockquote");

class Paginator {
  private readonly pages: HTMLElement[] = [];
  private page: Page;
  /** The page being filled was opened because the one before it was full, not by a break or the start. */
  private full = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly notes: readonly string[],
    /** The height a page's body and notes share. */
    private readonly room: number,
    private readonly footer?: string,
  ) {
    this.page = this.newPage();
  }

  private newPage(): Page {
    const element = document.createElement("section");
    element.className = "page";
    const body = document.createElement("div");
    body.className = "page-body";
    const notes = document.createElement("div");
    notes.className = "page-notes";
    element.append(body, notes);
    this.container.append(element);
    this.pages.push(element);
    return { body, notes };
  }

  /** How much of its room the page uses: its blocks, down to the last one's foot, and its notes. */
  private used(page: Page): number {
    const last = page.body.lastElementChild;
    const body = last
      ? last.getBoundingClientRect().bottom - page.body.getBoundingClientRect().top
      : 0;
    const notes = page.notes.childElementCount > 0 ? page.notes.getBoundingClientRect().height : 0;
    return body + notes;
  }

  private fits(page: Page): boolean {
    return this.used(page) <= this.room;
  }

  private numbersIn(element: Element): number[] {
    const numbers = [...element.querySelectorAll<HTMLElement>("sup.note-ref")].map((ref) =>
      Number(ref.dataset.note),
    );
    if (element.matches("sup.note-ref"))
      numbers.unshift(Number((element as HTMLElement).dataset.note));
    return numbers.filter((number) => Number.isInteger(number) && number > 0);
  }

  /** Puts the notes whose markers are in `element` at the page's foot, in number order. */
  private addNotes(page: Page, element: Element): void {
    for (const number of this.numbersIn(element)) {
      if (page.notes.querySelector(`[data-note="${number}"]`)) continue;
      const note = document.createElement("div");
      note.className = "note";
      note.dataset.note = String(number);
      const label = document.createElement("span");
      label.className = "note-number";
      label.textContent = String(number);
      const text = document.createElement("span");
      text.className = "note-text";
      text.innerHTML = this.notes[number - 1] ?? "";
      note.append(label, text);
      const after = [...page.notes.children].find(
        (each) => Number((each as HTMLElement).dataset.note) > number,
      );
      page.notes.insertBefore(note, after ?? null);
    }
  }

  private removeNotes(page: Page, element: Element): void {
    for (const number of this.numbersIn(element)) {
      page.notes.querySelector(`[data-note="${number}"]`)?.remove();
    }
  }

  /** Tries `block` in `holder` on the page, with its notes; takes it out again if it doesn't fit. */
  private tryPlace(page: Page, holder: HTMLElement, block: HTMLElement): boolean {
    holder.append(block);
    this.addNotes(page, block);
    if (this.fits(page)) return true;
    this.removeNotes(page, block);
    block.remove();
    return false;
  }

  run(blocks: HTMLElement[]): HTMLElement[] {
    const queue = [...blocks];
    for (let block = queue.shift(); block; block = queue.shift()) {
      const page = this.page;
      if (block.classList.contains("page-break")) {
        // What follows a break starts a page, as in Word, so two in a row leave a page empty.
        if (page.body.childElementCount > 0 || !this.full) this.page = this.newPage();
        this.full = false;
        continue;
      }
      if (block.classList.contains("pack-page") && page.body.childElementCount > 0) {
        this.page = this.newPage();
        queue.unshift(block);
        continue;
      }
      if (this.tryPlace(page, page.body, block)) continue;
      const rest = this.split(page, page.body, block);
      if (rest === block && page.body.childElementCount === 0) {
        // Taller than a page and nowhere to split it: it is made to fit, smaller.
        this.shrinkOnto(page, block);
        this.page = this.newPage();
        this.full = true;
        continue;
      }
      // A heading, and a chart's picture and caption, stay with what follows them.
      queue.unshift(rest);
      for (
        let last = page.body.lastElementChild;
        keepsWithNext(last) && page.body.childElementCount > 1;
        last = page.body.lastElementChild
      ) {
        this.removeNotes(page, last);
        last.remove();
        queue.unshift(last);
      }
      this.page = this.newPage();
      this.full = true;
    }
    if (this.pages.length > 1 && this.page.body.childElementCount === 0) {
      this.pages.pop()?.remove();
    }
    this.pages.forEach((page, index) => {
      const number = document.createElement("div");
      number.className = "page-number";
      number.textContent = String(index + 1);
      page.append(number);
      if (this.footer) {
        const footer = document.createElement("div");
        footer.className = "page-footer";
        footer.textContent = this.footer;
        page.append(footer);
      }
    });
    return this.pages;
  }

  /**
   * Puts as much of `block` in `holder` as fits on the page, split where it can be, and returns
   * the rest for the next page; `block` itself, unplaced, if no part of it fits.
   */
  private split(page: Page, holder: HTMLElement, block: HTMLElement): HTMLElement {
    if (splitsByLine(block)) return this.splitLines(page, holder, block);
    if (splitsByChild(block)) return this.splitChildren(page, holder, block);
    if (block.localName === "table")
      return this.splitTable(page, holder, block as HTMLTableElement);
    return block;
  }

  private splitLines(page: Page, holder: HTMLElement, block: HTMLElement): HTMLElement {
    holder.append(block);
    const lines = linesOf(block);
    // Two lines at least on each side of a page break, where the block has four.
    const least = lines.length >= 4 ? 2 : 1;
    const top = page.body.getBoundingClientRect().top;
    let keep = lines.length - least;
    while (keep > least && (lines[keep - 1]?.bottom ?? 0) - top > this.room) keep--;
    for (; keep >= least; keep--) {
      const line = lines[keep];
      if (!line) continue;
      const rest = cutAt(block, line.start);
      this.addNotes(page, block);
      if (this.fits(page)) return rest;
      this.removeNotes(page, block);
      block.append(...rest.childNodes);
    }
    block.remove();
    return block;
  }

  private splitChildren(page: Page, holder: HTMLElement, block: HTMLElement): HTMLElement {
    const first = block.cloneNode(false) as HTMLElement;
    holder.append(first);
    let placed = 0;
    let partial = false;
    let rest: HTMLElement | null = null;
    for (const child of [...block.children] as HTMLElement[]) {
      if (this.tryPlace(page, first, child)) {
        placed++;
        continue;
      }
      rest = this.split(page, first, child);
      partial = rest !== child;
      if (partial) placed++;
      break;
    }
    // What didn't fit stays in `block`, which goes on to the next page.
    if (rest) block.prepend(rest);
    if (placed === 0) {
      first.remove();
      return block;
    }
    if (block instanceof HTMLOListElement) {
      // A list item split in two takes its number on the first page.
      block.start = block.start + placed - (partial ? 1 : 0);
    }
    return block;
  }

  private splitTable(page: Page, holder: HTMLElement, table: HTMLTableElement): HTMLElement {
    const rows = [...table.rows];
    const heading = rows.findIndex((row) => [...row.cells].some((cell) => cell.localName !== "th"));
    const headingRows = heading <= 0 ? [] : rows.slice(0, heading);
    // Rows a cell spans down over go together.
    const groups: HTMLTableRowElement[][] = [];
    let reach = 0;
    rows.slice(headingRows.length).forEach((row, index) => {
      const at = index + headingRows.length;
      if (at >= reach) groups.push([]);
      groups.at(-1)?.push(row);
      for (const cell of row.cells) reach = Math.max(reach, at + cell.rowSpan);
    });
    // Copies are tried on the page, so the table stays whole until it is known where it splits.
    const first = table.cloneNode(false) as HTMLTableElement;
    const firstBody = document.createElement("tbody");
    first.append(firstBody);
    holder.append(first);
    firstBody.append(...headingRows.map((row) => row.cloneNode(true)));
    let placed = 0;
    for (const group of groups) {
      const copies = group.map((row) => row.cloneNode(true) as HTMLTableRowElement);
      firstBody.append(...copies);
      for (const row of copies) this.addNotes(page, row);
      if (this.fits(page)) {
        placed++;
        continue;
      }
      for (const row of copies) {
        this.removeNotes(page, row);
        row.remove();
      }
      break;
    }
    if (placed === 0) {
      first.remove();
      return table;
    }
    // The rows that didn't fit go on, under the heading rows again.
    const rest = table.cloneNode(false) as HTMLTableElement;
    const restBody = document.createElement("tbody");
    rest.append(restBody);
    restBody.append(...headingRows, ...groups.slice(placed).flat());
    return rest;
  }

  private shrinkOnto(page: Page, block: HTMLElement): void {
    page.body.append(block);
    this.addNotes(page, block);
    const over = this.used(page) - this.room;
    const height = block.getBoundingClientRect().height;
    if (over > 0 && height > over) block.style.zoom = String((height - over) / height);
  }
}

/** Every top-level block of the body; a Bibliography's entries flow one by one. */
function blocksOf(source: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  for (const child of [...source.children] as HTMLElement[]) {
    if (child.matches("section.bibliography")) {
      const hanging = child.classList.contains("hanging");
      for (const entry of [...child.children] as HTMLElement[]) {
        if (isHeading(entry)) entry.classList.add("bibliography-heading");
        else if (hanging) entry.classList.add("hanging");
        blocks.push(entry);
      }
    } else {
      blocks.push(...apartAtBreaks(child));
    }
  }
  return blocks;
}

/**
 * A block with a page break inside it (in a list item, a quote): the part
 * before each break, the break, and the rest, so the break starts a page as
 * one between Blocks does. A list item cut in two keeps one number, on its
 * part before the break unless that part is empty, and each list goes on
 * counting after the break from the items before it.
 */
function apartAtBreaks(block: HTMLElement): HTMLElement[] {
  const parts: HTMLElement[] = [];
  let rest = block;
  for (
    let at = rest.querySelector<HTMLElement>(".page-break");
    at;
    at = rest.querySelector<HTMLElement>(".page-break")
  ) {
    const holders: HTMLElement[] = [];
    for (let each = at.parentElement; each; each = each === rest ? null : each.parentElement) {
      holders.unshift(each);
    }
    const after = cutAt(rest, { node: at, offset: null });
    at.remove();
    // What follows the break is in a copy of each element it was in, each the first in the one before.
    const cut: [HTMLElement, Element | null][] = [];
    let copy: Element | null = after;
    for (const holder of holders) {
      cut.push([holder, copy]);
      copy = copy?.firstElementChild ?? null;
    }
    let numbered = false;
    for (const [holder, continued] of cut.reverse()) {
      if (holder instanceof HTMLLIElement && continued instanceof HTMLElement) {
        numbered = holder.childElementCount > 0 || (holder.textContent ?? "").trim() !== "";
        if (numbered) continued.style.listStyleType = "none";
        else holder.remove();
      } else if (holder instanceof HTMLOListElement && continued instanceof HTMLOListElement) {
        const before = holder.querySelectorAll(":scope > li").length;
        continued.start = holder.start + before - (numbered ? 1 : 0);
      }
    }
    parts.push(rest, at);
    rest = after;
  }
  return [...parts, rest];
}

/** Moves a cited page's number badges apart, downwards, where two quotes start on about the same line. */
function spreadBadges(frame: HTMLElement): void {
  const badges = [...frame.querySelectorAll<HTMLElement>(".pack-badge")].sort(
    (a, b) => a.offsetTop - b.offsetTop,
  );
  let bottom = Number.NEGATIVE_INFINITY;
  for (const badge of badges) {
    const top = Math.max(badge.offsetTop, bottom);
    badge.style.top = `${top}px`;
    bottom = top + badge.offsetHeight + 1;
  }
}

/** Fills in the cover list's page numbers: the sheet each cited page came to. */
function numberCoverList(pages: readonly HTMLElement[]): void {
  const sheets = new Map<string, number>();
  pages.forEach((page, index) => {
    for (const sheet of page.querySelectorAll<HTMLElement>("section.pack-page")) {
      sheets.set(sheet.dataset.pack ?? "", index + 1);
    }
  });
  for (const ref of document.querySelectorAll<HTMLElement>("td.pack-ref")) {
    ref.textContent = String(sheets.get(ref.dataset.pack ?? "") ?? "");
  }
}

/**
 * Settles once a picture has loaded, so it is measured at its size, or has failed to, and prints
 * as its alt text. Not `decode()`: that waits for a frame, and this page, never shown, draws none
 * (#1455).
 */
function loaded(image: HTMLImageElement): Promise<void> {
  if (image.complete) return Promise.resolve();
  return new Promise((resolve) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
}

/** Lays the document out in pages; resolves with how many, once it is ready to print. */
async function print(printed: PrintDocument): Promise<number> {
  const paper = PAPER[printed.paper];
  document.documentElement.lang = printed.language;
  document.title = printed.title;
  if (printed.fontFamily) document.body.style.fontFamily = printed.fontFamily;
  const page = document.createElement("style");
  const room = paper.height - SAFETY_PX - 2 * paper.margin - (printed.footer ? FOOTER_PX : 0);
  page.textContent = `@page { size: ${paper.css}; margin: 0 }
:root { --page-width: ${paper.width}px; --page-height: ${paper.height - SAFETY_PX}px; --page-margin: ${paper.margin}px; --pack-height: ${room - PACK_TEXT_PX}px; }`;
  document.head.append(page);

  // Laid out first, at a page's width, so every face it uses has loaded before anything is measured.
  const source = document.createElement("div");
  source.className = "source page-body";
  source.innerHTML = printed.body;
  const notes = document.createElement("div");
  notes.className = "page-notes";
  notes.innerHTML = printed.notes.map((note) => `<div class="note">${note}</div>`).join("");
  document.body.append(source, notes);
  // Faces load once layout asks for them: until then, `fonts.ready` has nothing to wait for.
  source.getBoundingClientRect();
  notes.getBoundingClientRect();
  await document.fonts.ready;
  await Promise.all([...document.images].map(loaded));
  for (const frame of source.querySelectorAll<HTMLElement>(".pack-frame")) spreadBadges(frame);
  notes.remove();

  const container = document.createElement("main");
  container.className = "pages";
  document.body.append(container);
  const pages = new Paginator(container, printed.notes, room, printed.footer).run(blocksOf(source));
  numberCoverList(pages);
  source.remove();
  return pages.length;
}

(window as unknown as Record<string, unknown>)[PRINT_ENTRY] = print;

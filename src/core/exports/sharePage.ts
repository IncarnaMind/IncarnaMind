/**
 * The page's policy refuses every request, so opening it loads nothing, and allows its one script
 * by its hash. Without the script, and in print, each marker is a link to its note, which repeats
 * the Citation's Document, Location and quote.
 */
import { createHash } from "node:crypto";
import { formatDate } from "../../shared/dates";
import { translate } from "../../shared/i18n";
import type { Translate } from "../../shared/locations";
import type { Language } from "../language";
import type { Block, Footnote } from "../mindText";
import type { CardContent, CardRun, CitationCard } from "./citationCards";
import {
  bodyFontStyle,
  bodyLineStyle,
  HTML_STYLES,
  htmlFile,
  notesSection,
  withTableBodies,
} from "./html";
import type { ExportLabels } from "./labels";
import { checkedHtml, escapeHtml, renderPrintHtml, sourceHtml, webLink } from "./printHtml";

const HOW_CHECKS_WORK: Readonly<Record<Language, string>> = {
  en: "https://github.com/IncarnaMind/IncarnaMind#what-you-can-do",
  "zh-CN": "https://github.com/IncarnaMind/IncarnaMind/blob/main/README.zh-CN.md#你能用它做什么",
};

const SHARE_STYLES = `
:root{--sheet:#fff;--chip:#eef0f3;--rule:#e3e5e9;--ink-secondary:#4a4f57;--accent:#2a5bd7;--success:#166534;--success-wash:#dcf3e4;--warning-wash:#fef3e2;--error:#b42318;--card-shadow:0 0 0 1px var(--rule),0 12px 32px rgba(23,25,28,.12)}
[hidden]{display:none!important}
.shared-from{margin:0 0 .6rem;font-family:var(--sans);font-size:.75rem;line-height:1.4;color:var(--ink-meta)}
.shared-about{margin:-.6rem 0 1.6rem;font-family:var(--sans);font-size:.8125rem;line-height:1.5;color:var(--ink-meta)}
a.cite{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;margin-left:2px;padding:0 4px;border-radius:4px;background:var(--chip);color:var(--ink-secondary);font:600 10.5px/1 var(--sans);text-decoration:none;vertical-align:2px;cursor:pointer}
a.cite[data-check=not-found],a.cite[data-check=unsupported]{background:var(--warning-wash);color:var(--warning)}
a.cite[data-check=contradicted]{border:1px solid var(--error);background:none;color:var(--error)}
a.cite[aria-expanded=true]{outline:2px solid var(--accent);outline-offset:1px}
a.cite:focus-visible,.card-close:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.card:focus{outline:none}
.date{white-space:nowrap}
.notes{margin-top:1.6rem;padding-top:.75rem;font-family:var(--sans);font-size:12px;line-height:18px;color:var(--ink-meta)}
.notes h2{margin:.75rem 0 .4rem;font-family:var(--sans);font-size:12px;line-height:18px;font-weight:600;color:var(--ink-meta)}
.notes ol{margin:0;padding:0;list-style:none}
.notes li{margin:0 0 6px}
.shared-foot{max-width:42rem;margin:0 auto;padding:0 1.25rem 3rem;font-family:var(--sans);font-size:.72rem;line-height:1.5;color:var(--ink-meta)}
.shared-foot p{margin:0 0 .3rem}
.scrim{position:fixed;inset:0;z-index:9;background:rgba(23,25,28,.25)}
.card{position:absolute;z-index:10;box-sizing:border-box;width:min(420px,calc(100vw - 32px));padding:14px 16px;border-radius:10px;background:var(--sheet);box-shadow:var(--card-shadow);font-family:var(--sans);font-size:14px;line-height:20px;color:var(--ink)}
.card-grab,.card-swipe{display:none}
.card-head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13.5px}
.card-heading{flex:1;min-width:0}
.mark{box-sizing:border-box;display:inline-flex;flex:none;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;font-size:11px;line-height:1}
.check-found .card-heading{color:var(--success)}.check-found .mark{border:1.6px solid var(--success);color:var(--success)}
.check-not-found .card-heading,.check-unsupported .card-heading{color:var(--warning)}.check-not-found .mark,.check-unsupported .mark{background:var(--warning-wash);color:var(--warning)}
.check-contradicted .card-heading{color:var(--error)}.check-contradicted .mark{border:1.6px solid var(--error);color:var(--error)}
.check-cant-check .card-heading,.check-checking .card-heading{color:var(--ink-secondary)}.check-cant-check .mark,.check-checking .mark{background:var(--chip);color:var(--ink-secondary)}
.card-close{flex:none;width:28px;height:28px;margin:-6px -8px -6px 0;padding:0;border:0;border-radius:6px;background:none;color:var(--ink-meta);font:18px/1 var(--sans);cursor:pointer}
.card-close:hover{background:var(--chip);color:var(--ink)}
.card-source,.card-verdict{margin:2px 0 0 26px;font-size:12.5px;line-height:18px;color:var(--ink-meta)}
.card-verdict{color:var(--ink-secondary)}
.card-body{margin-top:10px;padding:12px 14px;border:1px solid var(--rule);border-radius:6px;background:#fbfbfc;color:var(--ink-answer)}
.card-passage{margin:0;font-family:var(--serif);font-size:14px;line-height:22px;white-space:pre-line}
mark.quote{background:var(--success-wash);color:var(--ink)}
.card-picture{margin-top:10px;overflow:hidden;border:1px solid var(--rule);border-radius:6px;background:#fff}
.card-picture svg{display:block;width:100%;height:auto}
.pictures{position:absolute;width:0;height:0;overflow:hidden}
.card-cells{width:100%;margin:0;border-collapse:collapse;font-size:12.5px;line-height:18px;font-variant-numeric:tabular-nums}
.card-cells th,.card-cells td{padding:4px 6px;border:1px solid var(--rule);text-align:left;vertical-align:top}
.card-cells th{background:var(--frame);font-weight:600;color:var(--ink-secondary)}
.card-cells td.quote{background:var(--success-wash);color:var(--ink)}
.card-lines{margin:0;padding:0;list-style:none;font-family:var(--serif);font-size:14px;line-height:22px}
.card-lines li+li{margin-top:4px}
.card-time{margin-right:8px;font-family:var(--sans);font-size:12px;color:var(--ink-meta);font-variant-numeric:tabular-nums}
.card-speaker{margin-right:4px;font-family:var(--sans);font-size:12.5px;font-weight:600}
.card-address{margin:8px 0 0;font-size:12px;line-height:16px;overflow-wrap:anywhere}
.card-small,.card-swipe{margin:9px 0 0;font-size:11.5px;line-height:16px;color:var(--ink-meta)}
@media (max-width:639.98px){.card{position:fixed;inset:auto 0 0;width:auto;max-height:75vh;overflow-y:auto;padding:10px 18px calc(16px + env(safe-area-inset-bottom));border-radius:16px 16px 0 0;box-shadow:0 -10px 30px rgba(23,25,28,.16)}.card-top{touch-action:none}.card-grab{display:block;width:36px;height:4px;margin:0 auto 12px;border-radius:2px;background:var(--rule-strong)}.card-swipe{display:block}}
@media (prefers-color-scheme:dark){:root{--sheet:#23262b;--chip:#2e3238;--rule:#3b4048;--ink-secondary:#c3c7ce;--accent:#8ab4f8;--success:#7fd4a0;--success-wash:#1f3b2a;--warning-wash:#3d2c12;--error:#f08a80}.card-body{background:#1c1f23}}
@media print{.card,.scrim{display:none!important}a.cite{border:0;background:none;color:inherit;padding:0;font-size:.7em;vertical-align:super}}
`.replace(/\n/g, "");

/** Plain JavaScript with no framework: the file must work on its own in any browser. */
const SCRIPT = `(() => {
  const markers = Array.from(document.querySelectorAll("a.cite"));
  const scrim = document.querySelector(".scrim");
  const narrow = window.matchMedia("(max-width: 639.98px)");
  let open = null;
  const cardOf = (marker) => document.getElementById("card-" + marker.dataset.card);
  const focusable = (card) => Array.from(card.querySelectorAll("a[href], button"));
  function place() {
    if (!open) return;
    const { marker, card } = open;
    scrim.hidden = !narrow.matches;
    card.style.transform = "";
    if (narrow.matches) {
      card.style.left = "";
      card.style.top = "";
      return;
    }
    const box = marker.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const room = document.documentElement.clientWidth;
    const left = Math.max(16, Math.min(box.left - 24, room - width - 16));
    const above = box.top - 8 - height;
    const top = box.bottom + 8 + height > window.innerHeight - 8 && above >= 8 ? above : box.bottom + 8;
    card.style.left = left + window.scrollX + "px";
    card.style.top = top + window.scrollY + "px";
  }
  function hide(refocus) {
    if (!open) return;
    const { marker, card } = open;
    open = null;
    card.hidden = true;
    scrim.hidden = true;
    marker.setAttribute("aria-expanded", "false");
    if (refocus) marker.focus();
  }
  function show(marker) {
    const card = cardOf(marker);
    if (!card) return;
    hide(false);
    open = { marker, card };
    card.hidden = false;
    marker.setAttribute("aria-expanded", "true");
    place();
    card.focus({ preventScroll: true });
  }
  function step(by) {
    const next = open && markers[markers.indexOf(open.marker) + by];
    if (!next) return;
    next.scrollIntoView({ block: "center" });
    show(next);
  }
  markers.forEach((marker) => {
    marker.setAttribute("role", "button");
    marker.setAttribute("aria-haspopup", "dialog");
    marker.setAttribute("aria-expanded", "false");
    marker.setAttribute("aria-controls", "card-" + marker.dataset.card);
    marker.addEventListener("click", (event) => {
      event.preventDefault();
      if (open && open.marker === marker) hide(true);
      else show(marker);
    });
    marker.addEventListener("keydown", (event) => {
      if (event.key !== " ") return;
      event.preventDefault();
      marker.click();
    });
  });
  document.querySelectorAll(".card-close").forEach((button) =>
    button.addEventListener("click", () => hide(true)),
  );
  document.addEventListener("click", (event) => {
    if (!open || open.card.contains(event.target) || event.target.closest("a.cite")) return;
    hide(false);
  });
  document.addEventListener("keydown", (event) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      hide(true);
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      step(event.key === "ArrowRight" ? 1 : -1);
    } else if (event.key === "Tab" && open.card.contains(document.activeElement)) {
      const items = focusable(open.card);
      const at = items.indexOf(document.activeElement);
      const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length;
      event.preventDefault();
      if (items[next]) items[next].focus();
    }
  });
  window.addEventListener("resize", place);
  narrow.addEventListener("change", place);
  document.querySelectorAll(".card-top").forEach((top) => {
    let from = null;
    let moved = 0;
    top.addEventListener("pointerdown", (event) => {
      if (!narrow.matches || event.target.closest("button")) return;
      from = event.clientY;
      moved = 0;
      top.setPointerCapture(event.pointerId);
    });
    top.addEventListener("pointermove", (event) => {
      if (from === null || !open) return;
      moved = Math.max(0, event.clientY - from);
      open.card.style.transform = "translateY(" + moved + "px)";
    });
    const release = () => {
      if (from === null) return;
      from = null;
      if (moved > 64) hide(true);
      else if (open) open.card.style.transform = "";
    };
    top.addEventListener("pointerup", release);
    top.addEventListener("pointercancel", release);
  });
})();`;

const STYLES = HTML_STYLES + SHARE_STYLES;

const hashOf = (text: string) => createHash("sha256").update(text).digest("base64");

const policyFor = (styles: string) =>
  [
    "default-src 'none'",
    `style-src 'sha256-${hashOf(styles)}'`,
    "img-src data:",
    `script-src 'sha256-${hashOf(SCRIPT)}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

const MARKS: Readonly<Record<CitationCard["check"], string>> = {
  found: "✓",
  "not-found": "!",
  unsupported: "!",
  contradicted: "≠",
  "cant-check": "–",
  "not-checked": "–",
  checking: "–",
};

export interface SharePage {
  blocks: readonly Block[];
  labels: ExportLabels;
  language: Language;
  /** The file's name, without ".html": the page's title in the browser. */
  name: string;
  /** When it was made, ISO 8601: the day the head, the cards and the foot name. */
  at: string;
  cards: ReadonlyMap<Footnote, CitationCard>;
  /** WebP, each written once, whichever cards show it. */
  pictures: readonly SharePicture[];
  checkedLine: boolean;
  /** The Mind's font by name, or null for the default. */
  font: string | null;
  /** The Mind's line spacing, or null for the default. */
  lineSpacing: number | null;
}

export interface SharePicture {
  data: Uint8Array;
  width: number;
  height: number;
}

export function renderSharePage(page: SharePage): string {
  const { labels, language, cards } = page;
  const t: Translate = (key, params) => translate(language, key, params);
  const date = formatDate(page.at, language);
  const written: { number: number; card: CitationCard }[] = [];
  const printed = renderPrintHtml(page.blocks, labels, {
    linkNotes: true,
    isLink: webLink,
    citations: {
      note: (footnote) => {
        const card = cards.get(footnote);
        // The card's own words say how its check went, in place of "[unverified]".
        const source = sourceHtml({ ...footnote, unverified: false }, labels, webLink);
        const quote = card?.quote ? ` · “${escapeHtml(card.quote)}”` : "";
        const check = card && card.check !== "found" ? ` · ${escapeHtml(card.heading)}` : "";
        return source + quote + check + checkedHtml(footnote.checked);
      },
      marker: (footnote, number) => {
        const card = cards.get(footnote);
        if (!card) return `<a class="cite" id="ref-${number}" href="#note-${number}">${number}</a>`;
        written.push({ number, card });
        const label = t("share.card.label", { number, source: card.spoken });
        return `<a class="cite" id="ref-${number}" href="#note-${number}" data-card="${number}" data-check="${card.check}" aria-label="${escapeHtml(label)}">${number}</a>`;
      },
    },
  });
  const head = [
    `<p class="shared-from">${withDate(t("share.page.shared", { date }), date)}</p>`,
    `<p class="shared-about">${escapeHtml(t("share.page.about"))}</p>`,
  ].join("");
  const status = checkedStatus(
    written.map(({ card }) => card),
    date,
    t,
  );
  const foot = [
    `<p>${withDate(status ? `${t("share.page.made")} · ${status}` : t("share.page.made"), date)}</p>`,
    page.checkedLine
      ? `<p><a href="${escapeHtml(HOW_CHECKS_WORK[language])}" rel="noreferrer">${escapeHtml(t("share.page.checkedLine"))}</a></p>`
      : "",
  ].join("");
  const body = [
    `<main>${head}${withTableBodies(printed.body)}</main>`,
    notesSection(printed.notes, labels, { compact: true, title: t("share.page.notes") }),
    `<footer class="shared-foot">${foot}</footer>`,
    '<div class="scrim" hidden></div>',
    picturesHtml(page.pictures),
    ...written.map(({ number, card }) => cardHtml(number, card, date, t)),
    `<script>${SCRIPT}</script>`,
  ].join("\n");
  const styles = STYLES + bodyFontStyle(page.font) + bodyLineStyle(page.lineSpacing);
  return htmlFile({ language, name: page.name, policy: policyFor(styles), styles, body });
}

/** "Found" counts only quotes found: every other card, whatever its state, says why it isn't. */
function checkedStatus(cards: readonly CitationCard[], date: string, t: Translate): string | null {
  const total = cards.length;
  if (total === 0) return null;
  const found = cards.filter((card) => card.check === "found").length;
  if (found === total) return t("share.page.found.all", { date });
  if (found > 0) return t("share.page.found.some", { date, found, total });
  return total === 1
    ? t("share.page.found.none.one", { date })
    : t("share.page.found.none.other", { date, total });
}

/** Each picture once, out of sight, for the cards that show it to point at. */
function picturesHtml(pictures: readonly SharePicture[]): string {
  if (pictures.length === 0) return "";
  const images = pictures.map(
    ({ data, width, height }, index) =>
      `<image id="picture-${index}" width="${width}" height="${height}" href="data:image/webp;base64,${Buffer.from(data).toString("base64")}"></image>`,
  );
  return `<svg class="pictures" aria-hidden="true" focusable="false"><defs>${images.join("")}</defs></svg>`;
}

/** A date never breaks across lines, in Chinese least of all, where any character can end one. */
const withDate = (text: string, date: string) =>
  escapeHtml(text).replace(escapeHtml(date), `<span class="date">${escapeHtml(date)}</span>`);

function cardHtml(number: number, card: CitationCard, date: string, t: Translate): string {
  const label = t("share.card.label", { number, source: card.spoken });
  const checked = card.dated ? ` · ${withDate(t("share.card.checked", { date }), date)}` : "";
  const close = t("share.card.close");
  const { check } = card;
  return [
    `<section class="card check-${check}" id="card-${number}" role="dialog" aria-label="${escapeHtml(label)}" tabindex="-1" hidden>`,
    '<div class="card-top"><div class="card-grab"></div>',
    '<div class="card-head">',
    `<span class="mark" aria-hidden="true">${MARKS[check]}</span>`,
    `<span class="card-heading">${escapeHtml(card.heading)}</span>`,
    `<button type="button" class="card-close" aria-label="${escapeHtml(close)}" title="${escapeHtml(close)}">×</button>`,
    "</div>",
    `<p class="card-source">${escapeHtml(card.source)}${checked}</p>`,
    card.verdict ? `<p class="card-verdict">${escapeHtml(card.verdict)}</p>` : "",
    card.changedAfterCited
      ? `<p class="card-verdict">${escapeHtml(t("citation.changedAfterCited"))}</p>`
      : "",
    "</div>",
    contentHtml(card.content, card.spoken, t),
    `<p class="card-swipe">${escapeHtml(t("share.card.swipe"))}</p>`,
    "</section>",
  ].join("");
}

const runsHtml = (runs: readonly CardRun[]) =>
  runs
    .map((run) =>
      run.quote ? `<mark class="quote">${escapeHtml(run.text)}</mark>` : escapeHtml(run.text),
    )
    .join("");

const small = (text: string) => `<p class="card-small">${escapeHtml(text)}</p>`;

function contentHtml(content: CardContent, spoken: string, t: Translate): string {
  const part = small(t("share.card.part"));
  switch (content.kind) {
    case "passage": {
      const { address } = content;
      const shown = address
        ? `<p class="card-address">${webLink(address) ? `<a href="${escapeHtml(address)}" rel="noreferrer">${escapeHtml(address)}</a>` : escapeHtml(address)}</p>`
        : "";
      return `<div class="card-body"><p class="card-passage">${runsHtml(content.runs)}</p></div>${shown}${part}`;
    }
    case "cells": {
      const head = content.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`);
      const rows = content.rows.map(
        (row) =>
          `<tr><th scope="row">${escapeHtml(row.label)}</th>${row.cells
            .map((cell) =>
              cell.quote
                ? `<td class="quote">${escapeHtml(cell.text)}</td>`
                : `<td>${escapeHtml(cell.text)}</td>`,
            )
            .join("")}</tr>`,
      );
      return `<div class="card-body"><table class="card-cells"><thead><tr><td></td>${head.join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>${part}`;
    }
    case "lines": {
      const lines = content.lines.map(
        (line) =>
          `<li><span class="card-time">${escapeHtml(line.time)}</span>${line.speaker ? `<span class="card-speaker">${escapeHtml(line.speaker)}</span>` : ""}${runsHtml(line.runs)}</li>`,
      );
      return `<div class="card-body"><ul class="card-lines">${lines.join("")}</ul></div>${part}`;
    }
    case "quote":
      if (!content.text) return "";
      return `<div class="card-body"><p class="card-passage">“${escapeHtml(content.text)}”</p></div>${content.from === "scan" ? small(t("citation.scan")) : content.from === "picture" ? small(t("citation.picture")) : ""}`;
    case "picture": {
      const alt = t("share.card.pictureAlt", { source: spoken });
      const note = t(content.slide ? "share.card.slidePicture" : "share.card.pagePicture");
      return `<div class="card-picture"><svg viewBox="0 0 ${content.width} ${content.height}" role="img" aria-label="${escapeHtml(alt)}"><use href="#picture-${content.picture}"></use></svg></div>${small(note)}${content.scan ? small(t("citation.scan")) : ""}`;
    }
    case "missing":
      return `${content.quote ? `<div class="card-body"><p class="card-passage">“${escapeHtml(content.quote)}”</p></div>` : ""}${small(t("share.card.missing"))}`;
  }
}

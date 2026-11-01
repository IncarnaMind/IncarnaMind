/**
 * A Citation of a scanned page (#397), on its card: it says the text was read
 * from a scan, and marks the words of the quote the reading wasn't sure of,
 * so the User looks at the page before trusting them.
 */
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import type { CitationAttributes, ScannedQuote, ScannedText } from "../../../core/api";
import type { DrawnPage } from "../../../shared/citedPage";
import { quoteInUnits } from "../../../shared/locations";
import { readableQuoteText } from "../../../shared/readableQuote";
import { normaliseText } from "../../../shared/text";
import type { Anchor } from "../../../shared/units";
import { core } from "../core";
import { useT } from "../i18n";

/** What the core says of the Citation's quote: null until it answers, or when it isn't a scan's. */
export function useScannedQuote(attributes: CitationAttributes): ScannedQuote | null {
  const { documentId, contentHash, pageFrom, pageTo, quote } = attributes;
  const [scanned, setScanned] = useState<ScannedQuote | null>(null);
  useEffect(() => {
    if (!documentId || !quote) return;
    let current = true;
    core
      .readScannedQuote({
        documentId,
        contentHash: contentHash ?? null,
        pageFrom: pageFrom ?? null,
        pageTo: pageTo ?? null,
        quote,
      })
      .then(
        (answer) => {
          if (current) setScanned(answer);
        },
        // A card that can't say it was a scan is the card as it always was.
        (error: unknown) => console.error(error),
      );
    return () => {
      current = false;
    };
  }, [documentId, contentHash, pageFrom, pageTo, quote]);
  return scanned;
}

/**
 * A Citation's quote as a person reads it (#905): the words a PDF split at a line end whole again,
 * and a quote that stops at one run to its end. At first as the quote alone allows; once the core
 * has read the Document's own text, as that does.
 */
export function useReadableQuote(
  attributes: Pick<
    CitationAttributes,
    "documentId" | "contentHash" | "pageFrom" | "pageTo" | "quote"
  > | null,
): string {
  const { documentId, contentHash, pageFrom, pageTo, quote } = attributes ?? {};
  const alone = readableQuoteText(quote ?? "");
  const [read, setRead] = useState<{ quote: string; text: string } | null>(null);
  useEffect(() => {
    if (!documentId || !quote) return;
    let current = true;
    core
      .readableQuote({
        documentId,
        contentHash: contentHash ?? null,
        pageFrom: pageFrom ?? null,
        pageTo: pageTo ?? null,
        quote,
      })
      .then(
        (text) => {
          if (current && text) setRead({ quote, text });
        },
        // A card that can't read the Document's text shows the quote as it can read it alone.
        (error: unknown) => console.error(error),
      );
    return () => {
      current = false;
    };
  }, [documentId, contentHash, pageFrom, pageTo, quote]);
  return read !== null && read.quote === quote ? read.text : alone;
}

/** "Text read from a scan", with how many of the quote's words may be misread. */
export function ScanLine({ scanned }: { scanned: ScannedQuote }) {
  const t = useT();
  const count = scanned.unsure.length;
  const words =
    scanned.from === "picture"
      ? ([
          "citation.picture",
          "citation.picture.unsure.one",
          "citation.picture.unsure.other",
        ] as const)
      : (["citation.scan", "citation.scan.unsure.one", "citation.scan.unsure.other"] as const);
  return (
    <p data-testid="citation-scan" data-from={scanned.from} className="citation-card-source">
      {count === 0 ? t(words[0]) : t(count === 1 ? words[1] : words[2], { count })}
    </p>
  );
}

/**
 * The quote with each word the reading wasn't sure of marked, where the
 * quote has it (compared as the Citation check compares text).
 */
export function QuoteWithUnsureWords({
  quote,
  unsure,
}: {
  quote: string;
  unsure: readonly string[];
}) {
  const t = useT();
  if (unsure.length === 0) return <>{quote}</>;
  const wanted = new Set(unsure.map((word) => normaliseText(word)).filter(Boolean));
  const parts: ReactNode[] = [];
  // Words and the spaces between them, each Chinese character a word of its own.
  for (const [index, piece] of (
    quote.match(/\s+|[\p{Script=Han}]|[^\s\p{Script=Han}]+/gu) ?? []
  ).entries()) {
    const key = normaliseText(piece);
    parts.push(
      wanted.has(key) ? (
        <span
          key={index}
          data-testid="citation-unsure-word"
          className="citation-card-unsure"
          title={t("citation.scan.unsureWord")}
        >
          {piece}
        </span>
      ) : (
        <Fragment key={index}>{piece}</Fragment>
      ),
    );
  }
  return <>{parts}</>;
}

/** A box on a page, as fractions of its width and height. */
interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The box around the part of a scanned line `from` to `to` of it covers, from the line's quad. */
function lineBox(anchor: Anchor, from: number, to: number): PageBox | null {
  const quad = anchor.quad;
  const length = anchor.end - anchor.start;
  if (!quad || quad.length < 8 || length <= 0) return null;
  const [topLeftX, topLeftY, topRightX, topRightY, , , bottomLeftX, bottomLeftY] = quad;
  if (
    topLeftX === undefined ||
    topLeftY === undefined ||
    topRightX === undefined ||
    topRightY === undefined ||
    bottomLeftX === undefined ||
    bottomLeftY === undefined
  )
    return null;
  const clamp = (fraction: number) => Math.max(0, Math.min(1, fraction));
  const [start, end] = [clamp((from - anchor.start) / length), clamp((to - anchor.start) / length)];
  if (end <= start) return null;
  // The line's top and bottom edges run from its left corner to its right one.
  const corners: [number, number][] = [];
  for (const fraction of [start, end]) {
    corners.push([
      topLeftX + (topRightX - topLeftX) * fraction,
      topLeftY + (topRightY - topLeftY) * fraction,
    ]);
    corners.push([
      bottomLeftX + (topRightX - topLeftX) * fraction,
      bottomLeftY + (topRightY - topLeftY) * fraction,
    ]);
  }
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/** How a scanned page's picture is shown on a Citation's card: cropped around its quote. */
interface ScanPicture {
  image: string;
  width: number;
  height: number;
  region: PageBox;
  quote: PageBox[];
  unsure: PageBox[];
}

const dataUrlOf = (page: DrawnPage): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < page.data.length; at += chunk) {
    binary += String.fromCharCode(...page.data.subarray(at, at + chunk));
  }
  return `data:${page.type};base64,${btoa(binary)}`;
};

/**
 * The page a scanned Citation quotes, with its quote washed and its unsure words outlined (#535):
 * null until the page's saved picture is there, for a Citation of one page whose text is still
 * the version quoted.
 */
function useScanPicture(attributes: CitationAttributes, scanned: ScannedText | null) {
  const { documentId, contentHash, pageFrom, pageTo, location, quote } = attributes;
  const [drawn, setDrawn] = useState<DrawnPage | null>(null);
  const one = pageFrom !== null && pageTo !== null && pageFrom === pageTo;
  useEffect(() => {
    if (!documentId || !one || !quote || !scanned) return;
    if (scanned.contentHash !== (contentHash ?? scanned.contentHash)) return;
    let current = true;
    let timer: number | undefined;
    let tries = 0;
    const stop = () => {
      window.clearTimeout(timer);
      current = false;
    };
    // The page is drawn in the background once its Citation is made: ask again for a while.
    const ask = () => {
      core
        .readCitedPage({
          documentId,
          contentHash: contentHash ?? scanned.contentHash,
          pageFrom,
          pageTo,
          location,
        })
        .then(
          (page) => {
            if (!current) return;
            if (page) setDrawn(page);
            else if (tries++ < 20) timer = window.setTimeout(ask, 600);
          },
          (error: unknown) => console.error(error),
        );
    };
    ask();
    return stop;
  }, [documentId, contentHash, pageFrom, pageTo, location, quote, one, scanned]);
  return useMemo((): ScanPicture | null => {
    if (!drawn || !scanned || pageFrom === null) return null;
    const page = scanned.pages.find((each) => each.page === pageFrom);
    if (!page || !quote) return null;
    const ranges = quoteInUnits([page], quote);
    if (!ranges) return null;
    const quoteBoxes: PageBox[] = [];
    const unsureBoxes: PageBox[] = [];
    for (const anchor of page.anchors ?? []) {
      for (const range of ranges) {
        const from = Math.max(range.start, anchor.start);
        const to = Math.min(range.end, anchor.end);
        if (from >= to) continue;
        const box = lineBox(anchor, from, to);
        if (box) quoteBoxes.push(box);
      }
      for (const [from, to] of page.label?.scan?.unsure ?? []) {
        if (!ranges.some((range) => range.start < to && range.end > from)) continue;
        const box = lineBox(anchor, Math.max(from, anchor.start), Math.min(to, anchor.end));
        if (box) unsureBoxes.push(box);
      }
    }
    if (quoteBoxes.length === 0) return null;
    const boxes = [...quoteBoxes, ...unsureBoxes];
    const pad = 0.06;
    const left = Math.max(0, Math.min(...boxes.map((box) => box.left)) - pad);
    const top = Math.max(0, Math.min(...boxes.map((box) => box.top)) - pad);
    const right = Math.min(1, Math.max(...boxes.map((box) => box.left + box.width)) + pad);
    const bottom = Math.min(1, Math.max(...boxes.map((box) => box.top + box.height)) + pad);
    if (right <= left || bottom <= top) return null;
    return {
      image: dataUrlOf(drawn),
      width: drawn.width,
      height: drawn.height,
      region: { left, top, width: right - left, height: bottom - top },
      quote: quoteBoxes,
      unsure: unsureBoxes,
    };
  }, [drawn, scanned, pageFrom, quote]);
}

/** The scanned page a Citation quotes, its quote washed and each unsure word outlined (#535). */
export function ScanPagePicture({
  attributes,
  scanned,
}: {
  attributes: CitationAttributes;
  scanned: ScannedText | null;
}) {
  const t = useT();
  const picture = useScanPicture(attributes, scanned);
  if (!picture) return null;
  const { region, width, height } = picture;
  const at = (box: PageBox) => ({
    x: box.left,
    y: box.top,
    width: box.width,
    height: box.height,
  });
  return (
    <div
      data-testid="citation-scan-picture"
      className="citation-scan-picture"
      style={{ aspectRatio: `${region.width * width} / ${region.height * height}` }}
    >
      <img
        data-testid="citation-scan-page"
        src={picture.image}
        alt={t("citation.scan.picture", { document: attributes.documentName ?? "" })}
        style={{
          width: `${100 / region.width}%`,
          // A fraction of the page is that fraction of the picture's own size.
          transform: `translate(${-region.left * 100}%, ${-region.top * 100}%)`,
        }}
        draggable={false}
      />
      <svg
        aria-hidden="true"
        className="citation-scan-marks"
        viewBox={`${region.left} ${region.top} ${region.width} ${region.height}`}
        preserveAspectRatio="none"
      >
        {picture.quote.map((box) => (
          <rect
            key={`quote-${box.left}:${box.top}:${box.width}`}
            {...at(box)}
            className="citation-scan-quote"
          />
        ))}
        {picture.unsure.map((box) => (
          <rect
            key={`unsure-${box.left}:${box.top}:${box.width}`}
            {...at(box)}
            data-testid="citation-scan-unsure"
            className="citation-scan-unsure"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  );
}

/** The scanned pages of a Document's current version, read once its card asks for them. */
export function useScannedText(documentId: string | null): ScannedText | null {
  const [scanned, setScanned] = useState<ScannedText | null>(null);
  useEffect(() => {
    if (!documentId) return;
    let current = true;
    core.readScannedText(documentId).then(
      (text) => {
        if (current) setScanned(text);
      },
      // A card that can't read the pages shows the quote alone.
      (error: unknown) => console.error(error),
    );
    return () => {
      current = false;
    };
  }, [documentId]);
  return scanned;
}

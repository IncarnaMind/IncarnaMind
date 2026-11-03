import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Document, DocumentVersionText } from "../../../core/api";
import { type DrawnPage, quoteBoxes } from "../../../shared/citedPage";
import { formatDate } from "../../../shared/dates";
import { formatLocation, joinUnits, quoteInUnits, unitLocation } from "../../../shared/locations";
import { lostLigatures, type TextRange } from "../../../shared/quoteMatch";
import { citedVersionHandles } from "../commands/handles";
import { MetaLine } from "../components/MetaLine";
import { LineAction } from "../components/ProblemLine";
import { core } from "../core";
import { useLanguage, useT } from "../i18n";
import { openCurrentVersion } from "../openCited";
import { useAppStore, type ViewerTarget } from "../store";
import { DocumentView } from "./DocumentView";
import { HighlightedText } from "./highlightedText";
import { CitationMark, marginRoom, markTopFor, quoteMarkOf, quoteTone } from "./quoteMark";
import { ViewerFrameContext, ViewerHeader } from "./ViewerHeader";
import { ViewerMessage } from "./ViewerMessage";

type Loaded =
  | { kind: "loading" }
  /** `page`: the picture saved of the cited place (#133), with its text drawn on it, when there is one. */
  | { kind: "ready"; version: DocumentVersionText; page: DrawnPage | null }
  /** That version's text isn't kept: the Document is shown as it is now, as before #2159. */
  | { kind: "none" }
  | { kind: "failed"; message: string };

/** A picture as a data URL the image shows. */
function dataUrlOf(page: DrawnPage): string {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < page.data.length; at += chunk) {
    binary += String.fromCharCode(...page.data.subarray(at, at + chunk));
  }
  return `data:${page.type};base64,${btoa(binary)}`;
}

/**
 * The version a Citation was made from (#2159): after its Document changed,
 * opening the Citation shows the cited place as it was, marked "As cited,
 * {date}", the quote washed where it stood, and one action to the current
 * version at the same place. The place is the page saved when the Citation was
 * made (#133), which keeps how it looked; where there is no such picture, its
 * kept text is set plainly, and the bar says that only the text is kept.
 */
export function CitedVersionView({
  document,
  target,
}: {
  document: Document;
  target: ViewerTarget;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const cited = target.citation ?? null;
  const version = cited?.contentHash ?? null;
  // The Citation's own Units: where it points, never where its quote moved in the new version.
  const pageFrom = cited?.pageFrom ?? target.pageFrom ?? null;
  const pageTo = cited?.pageTo ?? target.pageTo ?? pageFrom;
  const location = cited?.location ?? null;
  const { tabId } = useContext(ViewerFrameContext);
  const openCurrent = useOpenCurrent(document, target);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again at Try again, or when the Document changes again.
  useEffect(() => {
    if (!version) {
      setLoaded({ kind: "none" });
      return;
    }
    let current = true;
    setLoaded({ kind: "loading" });
    Promise.all([
      core.readVersionText({ documentId: document.id, contentHash: version, pageFrom, pageTo }),
      // A Citation made before Units has no page of its own: its text, and nothing else, is kept.
      pageFrom === null
        ? Promise.resolve(null)
        : core
            .readCitedPage({
              documentId: document.id,
              contentHash: version,
              pageFrom,
              pageTo,
              location,
            })
            .catch((error: unknown) => {
              console.error(
                "The page saved of the version this Citation quotes couldn't be read.",
                error,
              );
              return null;
            }),
    ]).then(
      ([text, page]) => {
        if (current) setLoaded(text ? { kind: "ready", version: text, page } : { kind: "none" });
      },
      (error: unknown) => {
        if (!current) return;
        console.error("The text of the version this Citation quotes couldn't be read.", error);
        setLoaded({ kind: "failed", message: error instanceof Error ? error.message : "" });
      },
    );
    return () => {
      current = false;
    };
  }, [document.id, version, pageFrom, pageTo, location, attempt]);

  useEffect(() => {
    if (loaded.kind === "none") return;
    const action = { openCurrent };
    citedVersionHandles.delete(tabId);
    citedVersionHandles.set(tabId, action);
    return () => {
      if (citedVersionHandles.get(tabId) === action) citedVersionHandles.delete(tabId);
    };
  }, [loaded.kind, tabId, openCurrent]);

  if (loaded.kind === "none") return <DocumentView document={document} target={target} />;
  if (loaded.kind === "failed") {
    return (
      <>
        <ViewerHeader openable={false} />
        <ViewerMessage
          tone="error"
          testId="viewer-cited-failed"
          action={{
            label: t("viewer.cited.tryAgain"),
            testId: "viewer-cited-try-again",
            onClick: () => setAttempt((count) => count + 1),
          }}
          also={{
            label: t("viewer.cited.openCurrent"),
            testId: "viewer-open-current",
            onClick: openCurrent,
          }}
        >
          {t("viewer.failed", { message: loaded.message })}
        </ViewerMessage>
      </>
    );
  }
  return (
    <>
      <ViewerHeader openable={false} showingCited />
      {loaded.kind === "loading" ? (
        <ViewerMessage>{t("viewer.loading")}</ViewerMessage>
      ) : (
        <CitedVersionContent
          document={document}
          target={target}
          version={loaded.version}
          page={loaded.page}
          openCurrent={openCurrent}
        />
      )}
    </>
  );
}

/** The Document's current version at the Citation's place, from the bar or the line that says the text failed. */
function useOpenCurrent(document: Document, target: ViewerTarget): () => void {
  const cited = target.citation;
  return useMemo(
    () => () => {
      if (!cited) return;
      openCurrentVersion(
        {
          documentId: document.id,
          pageFrom: cited.pageFrom ?? null,
          pageTo: cited.pageTo ?? null,
          quote: target.quote ?? null,
          contentHash: cited.contentHash ?? null,
          ...(cited.location && { location: cited.location }),
        },
        {
          check: cited.check,
          withQuote: true,
          ...(cited.number !== undefined && { number: cited.number }),
          label: cited.label ?? null,
        },
      ).catch(useAppStore.getState().reportError);
    },
    [cited, document.id, target.quote],
  );
}

/** The bar over the cited version: its date, that only its text is kept when no picture is, and the way on. */
function AsCitedBar({
  versionAt,
  textOnly,
  openCurrent,
}: {
  versionAt: string;
  textOnly: boolean;
  openCurrent: () => void;
}) {
  const t = useT();
  const language = useLanguage();
  return (
    <div
      data-testid="viewer-as-cited"
      className="shrink-0 border-b border-rule px-4 py-1.5 text-[13px] leading-5 text-ink-meta"
    >
      <MetaLine
        as="div"
        parts={[
          t("viewer.cited.asCited", { date: formatDate(versionAt, language) }),
          <LineAction
            key="current"
            action={{
              label: t("viewer.cited.openCurrent"),
              testId: "viewer-open-current",
              onClick: openCurrent,
            }}
          />,
        ]}
      />
      {textOnly && (
        <p data-testid="viewer-cited-text-only" className="text-ink-meta">
          {t("viewer.cited.textOnly")}
        </p>
      )}
    </div>
  );
}

/**
 * The cited place: the page saved of it, with the quote washed where it stood, or
 * when none is saved, the kept text of its Units under its place.
 */
function CitedVersionContent({
  document,
  target,
  version,
  page,
  openCurrent,
}: {
  document: Document;
  target: ViewerTarget;
  version: DocumentVersionText;
  page: DrawnPage | null;
  openCurrent: () => void;
}) {
  const t = useT();
  const units = version.pages;
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const [markTop, setMarkTop] = useState<number | null>(null);
  const [markRoom, setMarkRoom] = useState(0);
  const mark = quoteMarkOf(target.citation);

  const quote = target.quote ?? "";
  const shown = useMemo(() => {
    const { starts } = joinUnits(units);
    // Matched as the Citation's check matches it: its own numbers, and a lost f-ligature forgiven.
    const ranges = quote
      ? (quoteInUnits(units, quote, {
          lostLigatures: lostLigatures(units.map((unit) => unit.text).join("\n")),
        }) ?? [])
      : [];
    return units.map((unit, index) => {
      const start = starts[index] as number;
      const end = start + unit.text.length;
      const inside: TextRange[] = ranges
        .filter((range) => range.end > start && range.start < end)
        .map((range) => ({
          start: Math.max(range.start, start) - start,
          end: Math.min(range.end, end) - start,
        }));
      const place = unitLocation(unit);
      return {
        unit,
        label: place ? formatLocation(place, t) : null,
        ranges: inside,
      };
    });
  }, [units, quote, t]);
  // One Unit: the Citation's own place names it more narrowly ("Revenue, rows 12–14", "§ History, ¶ 3").
  const place =
    units.length === 1 && target.citation?.location
      ? formatLocation(target.citation.location, t)
      : null;
  // A picture is of the whole place it was saved for, which the Citation's Location names.
  const picturePlace =
    (target.citation?.location && formatLocation(target.citation.location, t)) ||
    (units.length === 1 && shown[0]?.label ? shown[0].label : null);

  const highlighted = page !== null || shown.some((part) => part.ranges.length > 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-placed for each read of the version
  useLayoutEffect(() => {
    const element = column.current;
    if (!element || !mark || !highlighted) {
      setMarkTop(null);
      return;
    }
    const placeMark = () => {
      const first = element.querySelector("[data-quote-highlight]");
      setMarkTop(first ? markTopFor(first, element) : null);
      setMarkRoom(marginRoom(element));
    };
    placeMark();
    const observer = new ResizeObserver(placeMark);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mark, highlighted, version, page]);

  // Opening goes to the quote where it stood, else to the top of the cited place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each open request goes there again
  useLayoutEffect(() => {
    const container = scroller.current;
    if (!container) return;
    const quoted = container.querySelector<HTMLElement>("[data-quote-highlight]");
    if (!quoted) {
      container.scrollTop = 0;
      return;
    }
    container.scrollTop = Math.max(
      0,
      quoted.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop -
        container.clientHeight / 3,
    );
  }, [target.request, version, page]);

  return (
    <>
      <AsCitedBar
        versionAt={version.versionAt}
        textOnly={page === null}
        openCurrent={openCurrent}
      />
      <div
        ref={scroller}
        data-testid="viewer-cited"
        data-quote-tone={quoteTone(target.citation)}
        className="viewer-backdrop viewer-text-backdrop min-h-0 min-w-0 flex-1 overflow-auto select-text"
      >
        <article className="viewer-page viewer-text-page">
          <div ref={column} className="relative space-y-6">
            {page ? (
              <section>
                {picturePlace && (
                  <p
                    data-testid="viewer-cited-place"
                    className="mb-2 font-sans text-label font-semibold text-ink-meta"
                  >
                    {picturePlace}
                  </p>
                )}
                <CitedPagePicture page={page} target={target} name={document.name} />
                <p data-testid="viewer-cited-says" className="sr-only">
                  {units.map((unit) => unit.text).join("\n")}
                </p>
              </section>
            ) : (
              shown.map(({ unit, label, ranges }, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a version's Units have no identity but their place.
                <section key={index} data-unit={unit.page}>
                  {(place ?? label) && (
                    <p
                      data-testid="viewer-cited-place"
                      className="mb-2 font-sans text-label font-semibold text-ink-meta"
                    >
                      {place ?? label}
                    </p>
                  )}
                  <pre className="document-plain">
                    <HighlightedText text={unit.text} ranges={ranges} />
                  </pre>
                </section>
              ))
            )}
            {mark && markTop !== null && (
              <CitationMark
                mark={mark}
                room={markRoom}
                style={{ top: markTop, left: "calc(100% + 12px)" }}
              />
            )}
          </div>
        </article>
      </div>
    </>
  );
}

/**
 * The page saved when the Citation was made (#133), as it looked in the version
 * it quotes, with its quote washed where it was drawn. Its words are beside the
 * picture for a reader who can't see it (see `viewer-cited-says`).
 */
function CitedPagePicture({
  page,
  target,
  name,
}: {
  page: DrawnPage;
  target: ViewerTarget;
  name: string;
}) {
  const t = useT();
  const boxes = useMemo(
    () => quoteBoxes(page, target.quote, target.citation?.location ?? null) ?? [],
    [page, target.quote, target.citation?.location],
  );
  const source = useMemo(() => dataUrlOf(page), [page]);
  return (
    <div
      data-testid="viewer-cited-picture"
      className="relative w-full"
      style={{ maxWidth: `${page.width}px` }}
    >
      <img
        data-testid="viewer-cited-page"
        src={source}
        alt={t("viewer.cited.picture", { name })}
        className="block h-auto w-full"
        draggable={false}
      />
      {boxes.map((box, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: one box for each line of the quote, in order.
          key={index}
          data-quote-highlight=""
          aria-hidden
          className="quote-highlight quote-highlight--picture"
          style={{
            left: `${(box.x / page.width) * 100}%`,
            top: `${(box.y / page.height) * 100}%`,
            width: `${(box.width / page.width) * 100}%`,
            height: `${(box.height / page.height) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

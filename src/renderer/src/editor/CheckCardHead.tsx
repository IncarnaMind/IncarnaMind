import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import type * as Y from "yjs";
import { hasSearchScope, mindSearchScope } from "../../../shared/searchScope";
import { useLanguage, useT } from "../i18n";
import { useMindScope } from "../keptScope";
import { useFolderHoldsDocuments, useScopeDocumentCount, useScopeName } from "../scopeDocuments";
import { useAppStore } from "../store";
import { Counted } from "./Counted";
import { type CardStage, cardHeadWords } from "./checkCardStage";
import type { CheckRow } from "./healthCounts";
import { ClaimMarkIcon } from "./icons";

/**
 * The Checks card's first lines (#3840): where the Note's check stands, said once — Not checked
 * yet with what the check would read and against what; Checking with how far, and a bar that moves
 * only with that count; Check done or All supported with when. Nothing below repeats it. The line
 * that counts the sentences stands for their row, so it is that row's Next too (#2313).
 */
export function CheckCardHead({
  stage,
  doc,
  mindId,
  onNext,
}: {
  stage: CardStage | null;
  doc: Y.Doc;
  mindId: string;
  /** Goes to the next sentence of the row the line stands for. */
  onNext: (row: CheckRow) => void;
}) {
  const t = useT();
  const language = useLanguage();
  const top = useRef<HTMLDivElement>(null);
  const kind = stage?.kind ?? null;
  const against = useCheckedAgainst(
    doc,
    mindId,
    (stage?.kind === "not-checked" && !stage.inRow) || kind === "clean",
  );
  // A run that ends with the card open says its end at the top, which the held body may have
  // scrolled away from while results landed.
  useLayoutEffect(() => {
    if (kind === "done" || kind === "clean")
      top.current?.closest(".check-card-body")?.scrollTo({ top: 0 });
  }, [kind]);
  if (stage === null) return null;
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const { words, aside } = cardHeadWords(stage, t, language);
  const line = lineOf(stage, against, t, format);
  return (
    <div ref={top} className="check-card-top" data-testid="check-card-top">
      <div className="check-card-head" data-testid="check-card-head" data-stage={stage.kind}>
        <span className="check-card-head-mark" aria-hidden="true">
          {stage.kind === "not-checked" && <ClaimMarkIcon state="not-checked" />}
          {stage.kind === "checking" && <span className="check-card-head-dot" />}
          {stage.kind === "clean" && <ClaimMarkIcon state="supported" />}
        </span>
        <span className="check-card-head-words">{words}</span>
        {aside !== null && (
          <span className="check-card-head-aside" data-testid="check-card-head-aside">
            {aside}
          </span>
        )}
      </div>
      {stage.kind === "checking" && stage.total > 0 && (
        <div className="check-card-bar" aria-hidden="true">
          <span style={{ width: `${(Math.min(stage.done, stage.total) / stage.total) * 100}%` }} />
        </div>
      )}
      {line && (
        <div
          className="check-card-line"
          data-testid="check-card-line"
          aria-busy={line.row === "toCheck" && against.documents === null ? true : undefined}
        >
          <button
            type="button"
            data-testid={`health-${line.row}`}
            data-count={line.count}
            className="check-row check-row--line"
            aria-label={t("health.next", { part: line.words })}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onNext(line.row)}
          >
            <span className="check-row-text">{line.shown}</span>
            <span className="check-row-next" aria-hidden="true">
              {t("badge.next")}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The line under the head: the sentences not checked yet before the Note's first whole check, and
 * what they would be checked against; once all are supported, how many and against what.
 */
function lineOf(
  stage: CardStage,
  against: CheckedAgainst,
  t: ReturnType<typeof useT>,
  format: (value: number) => string,
): { row: CheckRow; count: number; words: string; shown: ReactNode } | null {
  if (stage.kind === "not-checked" && !stage.inRow) {
    const sentences = t(
      stage.sentences === 1 ? "checks.head.sentences.one" : "checks.head.sentences",
      { count: format(stage.sentences) },
    );
    const scope = againstWords(against, t, format);
    return {
      row: "toCheck",
      count: stage.sentences,
      words: `${sentences} · ${scope}`,
      shown: (
        <>
          <Counted text={sentences} count={format(stage.sentences)} />
          <span className="mind-health-sep" aria-hidden="true">
            {" · "}
          </span>
          {scope}
        </>
      ),
    };
  }
  if (stage.kind !== "clean") return null;
  const checked = checkedWords(stage.sentences, against, t, format);
  return {
    row: "supported",
    count: stage.sentences,
    words: checked,
    shown: <Counted text={checked} count={format(stage.sentences)} />,
  };
}

/**
 * What the Note's check reads against: its Search scope by name, or every Document, and how many
 * Documents that is.
 */
interface CheckedAgainst {
  scope: string | null;
  documents: number | null;
}

/**
 * The Search scope the Note's check reads, as the composer's chips name it; counted only while
 * `shown`.
 */
function useCheckedAgainst(doc: Y.Doc, mindId: string, shown: boolean): CheckedAgainst {
  const t = useT();
  const chosen = useMindScope(doc);
  const folderId = useAppStore(
    (state) => state.minds.find((each) => each.id === mindId)?.folderId ?? null,
  );
  const folderHolds = useFolderHoldsDocuments(folderId);
  const scope = useMemo(
    () => mindSearchScope(chosen, folderId, folderHolds),
    [chosen, folderId, folderHolds],
  );
  const named = useScopeName(hasSearchScope(scope) ? scope : null);
  const documents = useScopeDocumentCount(shown && hasSearchScope(scope) ? scope : null, {
    everyDocument: shown,
  });
  return {
    scope: named
      ? named.more > 0
        ? t("steps.scope.more", { scope: named.name, count: named.more, total: named.more + 1 })
        : named.name
      : null,
    documents,
  };
}

function againstWords(
  { scope, documents }: CheckedAgainst,
  t: ReturnType<typeof useT>,
  format: (value: number) => string,
): string {
  const count = documents === null ? "" : format(documents);
  if (scope === null) {
    if (documents === null) return t("checks.head.against.all.uncounted");
    if (documents === 0) return t("checks.head.against.all.none");
    return t(documents === 1 ? "checks.head.against.all.one" : "checks.head.against.all", {
      count,
    });
  }
  if (documents === null) return t("checks.head.against.uncounted", { scope });
  if (documents === 0) return t("checks.head.against.none", { scope });
  return t(documents === 1 ? "checks.head.against.one" : "checks.head.against", { scope, count });
}

function checkedWords(
  sentences: number,
  { scope }: CheckedAgainst,
  t: ReturnType<typeof useT>,
  format: (value: number) => string,
): string {
  const count = format(sentences);
  if (scope === null)
    return t(sentences === 1 ? "checks.head.checked.all.one" : "checks.head.checked.all", {
      count,
    });
  return t(sentences === 1 ? "checks.head.checked.one" : "checks.head.checked", { scope, count });
}

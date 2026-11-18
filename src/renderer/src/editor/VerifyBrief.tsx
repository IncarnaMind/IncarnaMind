import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { isVerifiedBlock, type Verification } from "../../../shared/verification";
import {
  type BriefSentence,
  briefOf,
  observeBrief,
  type VerificationBrief,
} from "../../../shared/verificationBrief";
import { useLanguage, useT } from "../i18n";
import { type ShownClaim, shownClaims } from "./claimChecks";
import { ClaimMarkIcon, type ClaimMarkState } from "./icons";

/** The brief a Mind made by "Verify a document…" keeps, as it changes; null while it has none. */
export function useVerificationBrief(doc: Y.Doc): VerificationBrief | null {
  const [brief, setBrief] = useState(() => briefOf(doc));
  useEffect(() => {
    setBrief(briefOf(doc));
    return observeBrief(doc, () => setBrief(briefOf(doc)));
  }, [doc]);
  return brief;
}

/** A sentence of the document in the Note now: where it stands and the mark its check shows. */
interface BriefPlace {
  text: string;
  at: number;
  mark: ClaimMarkState;
}

const MARKS: Partial<Record<ShownClaim["shown"]["state"], ClaimMarkState>> = {
  checking: "checking",
  supported: "supported",
  unsupported: "unsupported",
  contradicted: "contradicted",
  "own-view": "own-view",
  "needs-recheck": "needs-recheck",
};

const markOf = (claim: ShownClaim): ClaimMarkState =>
  claim.check.state === "not-checked" ? "not-checked" : (MARKS[claim.shown.state] ?? "not-checked");

/**
 * Where a sentence of the document stands in the Note: its Block, then its words the `occurrence`th
 * time. A claim has no mark before its check, so it is found in the text, not among the marks.
 */
function sentenceAt(editor: Editor, sentence: BriefSentence): number | null {
  let found: number | null = null;
  let skip = sentence.occurrence ?? 0;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (!node.isTextblock || node.attrs.id !== sentence.blockId) return true;
    let from = 0;
    for (;;) {
      const at = node.textContent.indexOf(sentence.text, from);
      if (at < 0) return false;
      if (skip === 0) {
        found = pos + 1 + at;
        return false;
      }
      skip--;
      from = at + 1;
    }
  });
  return found;
}

/**
 * What the brief's lines stand on now, from the checks as they land: where each conclusion is, each
 * figure's own mark, the claims whose check ran and found no source, and how many are not checked
 * yet. A claim not checked yet is never one with no source.
 */
function briefMarks(
  editor: Editor,
  doc: Y.Doc,
  verification: Verification,
  brief: VerificationBrief,
) {
  const claims = shownClaims(editor.state);
  const place = (sentence: BriefSentence): BriefPlace | null => {
    const at = sentenceAt(editor, sentence);
    if (at === null) return null;
    const claim = claims.find((each) => each.sentence.from <= at && at < each.sentence.to);
    return { text: sentence.text, at, mark: claim ? markOf(claim) : "not-checked" };
  };
  const verified = claims.filter((claim) => {
    const id: unknown = editor.state.doc.resolve(claim.from).parent.attrs.id;
    return typeof id === "string" && isVerifiedBlock(doc, verification, id);
  });
  const figures = brief.figures.flatMap((each) => {
    const found = place(each);
    return found ? [found] : [];
  });
  // A claim among the figures is shown there, with its mark, and not again as one with no source.
  const figureAts = new Set(figures.map((each) => each.at));
  return {
    conclusions: brief.conclusions.map((each) => ({
      line: each.line,
      at: place(each.at)?.at ?? null,
    })),
    figures,
    noSource: verified.flatMap((claim) =>
      claim.check.state !== "not-checked" &&
      claim.shown.state === "unsupported" &&
      !figureAts.has(claim.sentence.from)
        ? [{ text: claim.sentence.text, at: claim.sentence.from, mark: "unsupported" as const }]
        : [],
    ),
    notChecked: verified.filter(
      (claim) => claim.check.state === "not-checked" || claim.shown.state === "checking",
    ).length,
  };
}

/** How many claims with no source the brief lists before it says how many more there are. */
const MOST_LISTED = 4;

const sameMarks = (a: ReturnType<typeof briefMarks>, b: ReturnType<typeof briefMarks> | null) =>
  b !== null && JSON.stringify(a) === JSON.stringify(b);

/**
 * The brief of a document someone else wrote, at the top of its verifying card (#3277): what it
 * concludes, as plain lines that go to their place in the file; the figures that rests on, each with
 * its claim's own mark as the checks land; and the claims whose check found no source in the
 * Documents, listed and not judged, with a note while the run is still filling it in.
 */
export function VerifyBrief({
  editor,
  doc,
  verification,
  brief,
  running,
  goTo,
}: {
  editor: Editor;
  doc: Y.Doc;
  verification: Verification;
  brief: VerificationBrief;
  running: boolean;
  goTo(at: number): void;
}) {
  const t = useT();
  const language = useLanguage();
  const marks = useEditorState({
    editor,
    selector: ({ editor: current }) => briefMarks(current, doc, verification, brief),
    equalityFn: sameMarks,
  });
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  // The card opens on its top, where the conclusions are, and is put back there as the run ends.
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!running) root.current?.closest(".check-card-body")?.scrollTo({ top: 0 });
  }, [running]);
  return (
    <div className="verify-brief" data-testid="verify-brief" ref={root}>
      {marks.conclusions.length > 0 && (
        <section aria-labelledby="verify-brief-concludes">
          <p id="verify-brief-concludes" className="check-card-title">
            {t("verify.brief.concludes")}
          </p>
          <ul className="verify-brief-list">
            {marks.conclusions.map((each) => (
              <li key={each.line}>
                <button
                  type="button"
                  data-testid="verify-brief-conclusion"
                  className="check-row verify-brief-row verify-brief-conclusion"
                  disabled={each.at === null}
                  onClick={() => each.at !== null && goTo(each.at)}
                >
                  <span className="verify-brief-text">{each.line}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {marks.figures.length > 0 && (
        <section aria-labelledby="verify-brief-figures">
          <p id="verify-brief-figures" className="check-card-title">
            {t("verify.brief.figures")}
          </p>
          <ul className="verify-brief-list">
            {marks.figures.map((each) => (
              <li key={each.at}>
                <button
                  type="button"
                  data-testid="verify-brief-figure"
                  data-mark={each.mark}
                  className="check-row verify-brief-row"
                  onClick={() => goTo(each.at)}
                >
                  <ClaimMarkIcon state={each.mark} className="mind-health-icon" />
                  <span className="verify-brief-text">{each.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="verify-brief-no-source">
        <p id="verify-brief-no-source" className="check-card-title">
          {t("verify.brief.noSource")}
        </p>
        {marks.noSource.length > 0 ? (
          <ul className="verify-brief-list">
            {marks.noSource.slice(0, MOST_LISTED).map((each) => (
              <li key={each.at}>
                <button
                  type="button"
                  data-testid="verify-brief-no-source"
                  className="check-row verify-brief-row"
                  onClick={() => goTo(each.at)}
                >
                  <ClaimMarkIcon state="unsupported" className="mind-health-icon" />
                  <span className="verify-brief-text">{each.text}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          !running &&
          marks.notChecked === 0 && <p className="verify-brief-note">{t("verify.brief.none")}</p>
        )}
        {marks.noSource.length > MOST_LISTED && (
          <p data-testid="verify-brief-more" className="verify-brief-note tabular-nums">
            {t("verify.brief.more", { count: format(marks.noSource.length - MOST_LISTED) })}
          </p>
        )}
        {running ? (
          <p role="status" data-testid="verify-brief-filling" className="verify-brief-note">
            {t("verify.brief.filling")}
          </p>
        ) : (
          marks.notChecked > 0 && (
            <p data-testid="verify-brief-not-checked" className="verify-brief-note tabular-nums">
              {t(marks.notChecked === 1 ? "health.toCheck.one" : "health.toCheck", {
                count: format(marks.notChecked),
              })}
            </p>
          )
        )}
      </section>
    </div>
  );
}

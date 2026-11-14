import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import type { ReactNode } from "react";
import { useContext } from "react";
import type {
  CitationAttributes,
  ClaimCalculation,
  ClaimCheckPart,
  ClaimCheckScope,
  ClaimCorrection,
  ClaimPartSpan,
  WholeRead,
} from "../../../core/api";
import type { Language } from "../../../core/language";
import {
  citationState,
  citedSpeakers,
  type QuotedWordsOnPage,
  shownDocumentName,
} from "../../../shared/citations";
import { checkedScope, partFoundNothing } from "../../../shared/claimChecks";
import { coverageCount } from "../../../shared/claimParts";
import { cardRows, hasKnownDomain } from "../../../shared/claimRows";
import type { MessageKey, MessageParams } from "../../../shared/i18n";
import { citationLocation, formatLocation, openKind } from "../../../shared/locations";
import { checkedByMe } from "../../../shared/signOffs";
import { MetaLine } from "../components/MetaLine";
import { dotAfter } from "../components/metaDot";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import type { PartCorrection } from "../correctionFixes";
import { reasonText } from "../cost";
import { useLanguage, useT } from "../i18n";
import { openCited, quoteSaysSo } from "../openCited";
import { useScopeName } from "../scopeDocuments";
import { useAppStore } from "../store";
import { type CitationDecision, partDecisions } from "./alreadyCited";
import { CorrectionConflict, correctionLabel } from "./CorrectionOffer";
import type { CardAction } from "./cardActions";
import { useReadableQuote } from "./citationScan";
import type { ShownClaim } from "./claimChecks";
import { placeWords } from "./claimSentenceMarks";
import { ClaimMarkIcon } from "./icons";
import { LibrarySource } from "./LibrarySource";
import { SignOffsContext, useCitedOrigin } from "./mindContext";
import { PropertySource, showFileProperties } from "./PropertySource";
import { MoreQuotes, type MoreShown, QuoteLink } from "./QuoteLink";
import { SignOffLine } from "./SignOff";
import {
  citationSignOff,
  currentSigner,
  noteDocOf,
  partCitationOwner,
  toggleCitationSignOff,
  useDocumentVersions,
  usePersonId,
} from "./signOffActions";
import { CitationChip, OpenCitation } from "./UnsupportedCited";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Whether a row of the sentence's card can add a Citation of what it found. */
export const citesMore = (
  state: EditorState,
  claim: ShownClaim,
  parts: readonly ClaimCheckPart[],
  onPage?: QuotedWordsOnPage,
) =>
  cardRows(parts).some(({ part }) =>
    partDecisions(state, claim, part, onPage).some(({ decision }) => decision.kind === "add"),
  );

/** What a marked sentence's card does with the Citations of what its parts found (#2002). */
export interface PartCitations {
  claim: ShownClaim;
  /** The core's verdicts on the sentence's quoted words at the places its parts found. */
  onPage?: QuotedWordsOnPage;
  onAdd(parts: readonly ClaimCheckPart[]): void;
  onWiden(decision: Extract<CitationDecision, { kind: "widen" }>): void;
  onReplace(decision: Extract<CitationDecision, { kind: "replace" }>): void;
}

/**
 * One row of a sentence's card (#2869): a part, or a member of a quantified part's domain. A row
 * that needs the User is open; a supported one, or one left out as an opinion, folds into the
 * card's foot line until Show.
 */
export interface CardPart {
  key: string;
  part: ClaimCheckPart;
  /** A quantified part's member: its name, which isn't words of the sentence. */
  label: string | null;
  /** The part's own words, as its check read them. */
  words: string;
  /** Where the row's part stands in the card's sentence; null where it can't be placed. */
  place: { start: number; end: number } | null;
  fold: "supported" | "opinion" | null;
  /** Supported, not yet cited (#3019). */
  waiting: boolean;
  /** What the row can do with the Citation of each Passage it found. */
  decisions: readonly { evidence: CitationAttributes; decision: CitationDecision }[];
}

export function cardParts({
  state,
  text,
  sentence,
  parts,
  stale,
  checking,
  citations,
  waiting,
  opens,
}: {
  state: EditorState;
  /** The sentence as its check read it, which the parts' spans are in. */
  text: string;
  /** The sentence as the card shows it. */
  sentence: string;
  parts: readonly ClaimCheckPart[];
  stale: boolean;
  checking: boolean;
  citations?: PartCitations;
  waiting?: ReadonlySet<ClaimCheckPart>;
  /** A part left out that the card's verdict is about, which stays open. */
  opens?: (part: ClaimCheckPart) => boolean;
}): CardPart[] {
  const placed = new Map<ClaimCheckPart, { start: number; end: number } | null>();
  return cardRows(parts).map(({ part, label }, index) => {
    const original = parts.find((each) => each.span === part.span) ?? part;
    if (!placed.has(original))
      placed.set(original, placeWords(sentence, text.slice(part.span.start, part.span.end)));
    const isWaiting = waiting?.has(part) ?? false;
    // A member of a quantified part still to be cited stays open with it: its Citation is to add.
    const toCite = isWaiting || (waiting?.has(original) ?? false);
    const leftOut = part.verdict === null && !part.itself && !(opens?.(original) ?? false);
    return {
      key: `${part.span.start}:${part.span.end}:${label ?? ""}:${index}`,
      part,
      label,
      words: text.slice(part.span.start, part.span.end),
      place: placed.get(original) ?? null,
      fold: part.verdict === "supported" && !toCite ? "supported" : leftOut ? "opinion" : null,
      waiting: isWaiting,
      decisions:
        citations && !stale && !checking
          ? partDecisions(state, citations.claim, part, citations.onPage)
          : [],
    };
  });
}

/** The colours a row takes: its verdict's, and the quiet ones while its check is to be read again. */
export function partTone(row: CardPart, stale: boolean): string {
  if (stale || row.part.verdict === "checking") return "checking";
  if (row.waiting) return "cant-check";
  switch (row.part.verdict) {
    case "supported":
      return "found";
    case "contradicted":
      return "contradicted";
    case "unsupported":
      return "unsupported";
    default:
      return "cant-check";
  }
}

/** A row's verdict in words, for a screen reader, which hears every row in the sentence's order. */
export function partVerdictText(t: Translate, row: CardPart, stale: boolean): string {
  const { part } = row;
  if (stale) return t("claim.why.needs-recheck");
  if (part.verdict === null) return t(part.itself ? "claim.itself" : "claim.opinion");
  if (row.waiting) return t("claim.state.notYetCited");
  switch (part.verdict) {
    case "checking":
      return t("claim.part.checking");
    case "supported":
      return t("claim.state.supported");
    case "contradicted":
      return t("claim.why.contradicted");
    case "not-checked":
      return t("claim.state.not-checked");
    default:
      return partFoundNothing(part)
        ? t("claim.why.notFound")
        : part.unsupported?.kind === "units"
          ? t("claim.why.unitsMayDiffer")
          : t("claim.why.unsupported");
  }
}

/** Why a row needs the User, in one sentence; null for a row whose verdict says it all. */
export function partReason(
  t: Translate,
  language: Language,
  row: CardPart,
  { stale, lookedIn, read }: { stale: boolean; lookedIn: string; read?: WholeRead },
): string | null {
  const { part } = row;
  if (row.waiting && !stale) {
    const replacing = row.decisions.find(({ decision }) => decision.kind === "replace")?.decision;
    if (replacing?.kind === "replace")
      return t(
        replacing.citation.attributes.check === "not-found"
          ? "claim.replaceCitation.quoteNotFound"
          : "claim.replaceCitation.doesntSupport",
      );
    return row.decisions.some(({ decision }) => decision.kind === "widen")
      ? t("claim.widenCitation.note")
      : t("claim.notYetCited");
  }
  if (part.verdict === null) return t(part.itself ? "claim.itself" : "claim.opinion");
  if (part.verdict === "checking") return t("claim.part.checking");
  if (part.verdict === "not-checked")
    return part.reason ? reasonText(t, language, part.reason, part.detail) : null;
  if (part.verdict === "contradicted") return part.says;
  if (part.verdict !== "unsupported") return null;
  if (part.unsupported?.kind === "forecast-certainty") return t("claim.forecast");
  if (part.unsupported?.kind === "unbacked-cause") return t("claim.unbackedCause");
  if (part.unsupported?.reason) return part.unsupported.reason;
  // Its quote is a Passage the check found that doesn't back it, as a one-part card's is (#770).
  if (part.evidence.length > 0) return t("claim.unsupported.differs");
  if (read)
    return t(
      read.pages === read.of
        ? "claim.readAll.notFound"
        : read.of === 1
          ? "claim.readSome.notFound.one"
          : "claim.readSome.notFound",
      { scope: lookedIn, pages: read.pages, of: read.of },
    );
  return t("claim.unsupported.notFound", { scope: lookedIn });
}

/** The scope a parts card's check looked in, by its name. */
export function useLookedIn(scope?: ClaimCheckScope): string {
  const t = useT();
  const looked = useScopeName(scope ? checkedScope(scope) : null);
  return looked?.name ?? t("composer.scope.all");
}

/**
 * One quote and its Location line: the Document, the place, the Citation's number where the
 * sentence cites it, a count of more that opens the rest, and what can be done with its Citation
 * (#2869). The quote opens the Document at it; its own menu (right-click, or the menu key on the
 * focused quote) opens it and signs it alone.
 */
export function PartQuote({
  editor,
  citation,
  decision,
  more,
  onOpen,
  citations,
  part,
  signedAll = false,
}: {
  editor: Editor;
  citation: CitationAttributes;
  decision?: CitationDecision;
  /** The count of the part's other quotes, which opens them. */
  more?: ReactNode;
  onOpen(): void;
  citations?: PartCitations;
  part: ClaimCheckPart;
  /** The card's one "Checked by me" says the User's own mark on every quote. */
  signedAll?: boolean;
}) {
  const origin = useCitedOrigin();
  const t = useT();
  const documents = useAppStore((store) =>
    store.status.kind === "ready" ? store.documents : null,
  );
  const kept = useAppStore((store) => store.keptCitationTexts);
  const state = citationState(citation, documents, kept);
  const quote = useReadableQuote(citation);
  const location = citationLocation(citation);
  const property = location?.kind === "properties" ? location : null;
  const library = location?.kind === "library" ? location : null;
  const where = location
    ? formatLocation(location, t, {
        speakers: citedSpeakers(citation, documents),
        quote: citation.quote,
      })
    : null;
  const source = [shownDocumentName(citation, documents), where].filter(Boolean).join(" · ");
  const { records } = useContext(SignOffsContext);
  const personId = usePersonId();
  const versions = useDocumentVersions();
  const id = typeof citation.id === "string" ? citation.id : null;
  const target = id ? { kind: "citation" as const, id } : null;
  const menu = useObjectMenu(target);
  const canSignOff =
    id !== null &&
    editor.isEditable &&
    noteDocOf(editor) !== null &&
    partCitationOwner(editor.state.doc, id) !== null;
  const signOff = id
    ? citationSignOff(records, editor.state.doc, id, citation, versions, personId)
    : null;
  const toggle = () => {
    const signer = currentSigner();
    if (id && signer) toggleCitationSignOff(editor, id, signer);
  };
  const open = () => {
    if (!citation.documentId || library) return;
    if (property) return showFileProperties(citation.documentId, onOpen);
    void openCited(
      { ...citation, documentId: state.documentId ?? citation.documentId },
      { origin, check: state.check, withQuote: quoteSaysSo(state.check), label: where },
    );
    onOpen();
  };
  const what = decision ?? { kind: "none" as const };
  const citing =
    what.kind === "already" ? (
      <OpenCitation
        citation={what.citation}
        label={t("claim.alreadyCited.open", { number: what.citation.number })}
        onOpen={onOpen}
      >
        <CitationChip citation={what.citation} testId="claim-part-already-chip" />
      </OpenCitation>
    ) : null;
  const link =
    citations && what.kind === "add" ? (
      <QuoteLink testId="claim-part-add-citation" onClick={() => citations.onAdd([part])}>
        {t("claim.addAsCitation")}
      </QuoteLink>
    ) : citations && what.kind === "widen" ? (
      <QuoteLink testId="claim-part-widen-citation" onClick={() => citations.onWiden(what)}>
        {t("claim.widenCitation")}
      </QuoteLink>
    ) : citations && what.kind === "replace" ? (
      <QuoteLink testId="claim-part-replace-citation" onClick={() => citations.onReplace(what)}>
        {t("claim.replaceCitation")}
      </QuoteLink>
    ) : null;
  // The User's own mark on every quote is the card's one toggle; one on some of them, someone
  // else's, or one that changed since, is said where it is.
  const ownNow = signedAll && checkedByMe(signOff);
  return (
    <div
      data-testid="claim-part-receipt"
      data-citation-id={id ?? undefined}
      className="claim-quote"
      {...menu.rowProps}
    >
      {library || property ? (
        <>
          {library ? (
            <LibrarySource
              location={library}
              className="claim-part-citation claim-part-source claim-property"
              testId="claim-part-library"
            />
          ) : (
            property && (
              <PropertySource
                citation={citation}
                location={property}
                className="claim-part-citation claim-part-source claim-property"
                testId="claim-part-property"
                onOpen={onOpen}
              />
            )
          )}
          {/* The place says itself above; its Citation, its count and its link still have a line. */}
          {(citing || more || link) && (
            <MetaLine className="claim-quote-where" parts={[citing, more, link]} />
          )}
        </>
      ) : (
        <>
          {citation.quote &&
            (citation.documentId ? (
              <button
                type="button"
                className="claim-part-citation"
                data-testid="claim-part-citation"
                title={t(`citation.open.${openKind(location)}`)}
                onClick={open}
              >
                <span className="claim-part-quote">
                  <span className="citation-card-wash">{quote}</span>
                </span>
              </button>
            ) : (
              <p className="claim-part-citation">
                <span className="claim-part-quote">
                  <span className="citation-card-wash">{quote}</span>
                </span>
              </p>
            ))}
          <MetaLine
            className="claim-quote-where"
            parts={[
              <span key="source" className="claim-where-source">
                <span className="claim-part-source" title={source}>
                  {source}
                </span>
                {citing}
              </span>,
              more,
              link,
            ]}
          />
        </>
      )}
      {!ownNow && <SignOffLine now={signOff} />}
      {target && (
        <ObjectMenu
          target={target}
          label={t("claim.more")}
          className="claim-quote-menu"
          testId="claim-quote"
          tabIndex={-1}
          align="end"
          without={["citation.update", "citation.keepOld", "citation.remove"]}
          here={{
            ...(citation.documentId && !library && { "citation.open": open }),
            ...(canSignOff &&
              (checkedByMe(signOff)
                ? { "citation.signOffRemove": toggle }
                : { "citation.signOff": toggle })),
          }}
        />
      )}
    </div>
  );
}

/**
 * A row of the card: why it needs the User, in one sentence, and one quote with its Location, the
 * rest behind a count (#2869). Its words aren't written again: the sentence marks them, and only a
 * row whose words can't be marked there, or a member of a quantified part, starts with them.
 */
export function PartBlock({
  editor,
  row,
  stale,
  checking,
  lookedIn,
  read,
  allQuotes,
  more,
  correction,
  checkId,
  fix,
  drawsFix,
  signedAll = false,
  onOpen,
  working,
  citations,
}: {
  editor: Editor;
  row: CardPart;
  stale: boolean;
  checking: boolean;
  lookedIn: string;
  read?: WholeRead;
  /** Every quote shows, not only the first. */
  allQuotes: boolean;
  /** The count on the first quote's Location line that opens the others, and folds them again. */
  more: MoreShown | null;
  correction?: ClaimCorrection;
  /** The check the row is part of, whose row menu (right-click, or the menu key) holds its fix. */
  checkId: string;
  /** The row's own fix (`partFix`). */
  fix: CardAction | null;
  /** The fix is drawn under the row's quote: a row left out, or a card with fixes for more than one row (#2869). */
  drawsFix: boolean;
  /** The card's one "Checked by me" stands for every quote: a quote doesn't repeat it. */
  signedAll?: boolean;
  onOpen(): void;
  working?(calculation: ClaimCalculation): ReactNode;
  citations?: PartCitations;
}) {
  const t = useT();
  const language = useLanguage();
  const documents = useAppStore((store) =>
    store.status.kind === "ready" ? store.documents : null,
  );
  const { part } = row;
  const target = { kind: "check", id: `${checkId}:${part.span.start}:${part.span.end}` } as const;
  const menu = useObjectMenu(target);
  const menuFix =
    fix?.testId === "claim-part-check-anyway"
      ? { "check.anyway": fix.onClick }
      : fix?.testId === "claim-use-wording"
        ? { "check.useDocumentWording": fix.onClick }
        : null;
  const reason = partReason(t, language, row, { stale, lookedIn, read });
  const named = row.label ?? (row.place === null ? row.words : null);
  const held =
    part.citedCaseFound &&
    (part.verdict === "supported" ||
      part.verdict === "contradicted" ||
      part.verdict === "unsupported")
      ? part.evidence.find((citation) => citationLocation(citation) !== null)
      : undefined;
  const heldAt = held ? citationLocation(held) : null;
  const quotes = allQuotes ? part.evidence : part.evidence.slice(0, 1);
  const decisionOf = (citation: CitationAttributes) =>
    row.decisions.find((each) => each.evidence === citation)?.decision;
  // One Add, Widen or Replace a row, on its first quote that offers it, as the row had one button.
  const firstCiting = part.evidence.find((citation) => {
    const kind = decisionOf(citation)?.kind;
    return kind === "add" || kind === "widen" || kind === "replace";
  });
  return (
    <li
      className={`claim-part citation-card--${partTone(row, stale)}`}
      data-testid="claim-part"
      data-kind={part.kind}
      data-verdict={stale ? "needs-recheck" : (part.verdict ?? "opinion")}
      data-fold={row.fold ?? undefined}
      {...menu.rowProps}
    >
      {(named !== null || reason) && (
        <p className="claim-part-reason" data-testid="claim-part-reason" aria-hidden="true">
          {named !== null && (
            <span className="claim-part-words">{t("claim.sentence", { sentence: named })}</span>
          )}
          {named !== null && reason && language !== "zh-CN" ? " " : ""}
          {reason}
        </p>
      )}
      {part.citedCaseUnchecked && part.verdict === "unsupported" && (
        <p className="citation-card-note" data-testid="claim-part-court-decision">
          {t("claim.courtDecision.body")}
        </p>
      )}
      {part.citedCaseUnchecked &&
        (part.verdict === "supported" || part.verdict === "contradicted") && (
          <p className="citation-card-note" data-testid="claim-part-cited-case-unchecked">
            {t("claim.citedCaseUnchecked")}
          </p>
        )}
      {held && heldAt && (
        <p className="citation-card-note" data-testid="claim-part-court-decision-held">
          {t("claim.courtDecision.held", {
            document: shownDocumentName(held, documents) ?? "",
            location: formatLocation(heldAt, t),
          })}
        </p>
      )}
      {correction && !stale && !checking && <CorrectionConflict correction={correction} />}
      {part.verdict === "supported" && part.currencyClause && (
        <p data-testid="claim-part-currency-clause" className="citation-card-note">
          {part.currencyClause}
        </p>
      )}
      {quotes.map((citation, index) => {
        const decision = decisionOf(citation);
        return (
          <PartQuote
            key={
              citation.id ??
              JSON.stringify([
                citation.documentId,
                citation.contentHash,
                citation.pageFrom,
                citation.pageTo,
                citation.location,
                citation.quote,
              ])
            }
            editor={editor}
            citation={citation}
            part={part}
            decision={
              decision?.kind === "already" || citation === firstCiting ? decision : undefined
            }
            citations={citations}
            signedAll={signedAll}
            onOpen={onOpen}
            more={index === 0 && more && more.count > 0 ? <MoreQuotes more={more} /> : null}
          />
        );
      })}
      {part.calculation && working?.(part.calculation)}
      {fix && drawsFix && (
        <div className="citation-card-actions claim-part-actions">
          <button
            type="button"
            data-testid={fix.testId}
            className={`citation-card-action ${fix.primary ? "citation-card-action--primary" : ""}`}
            disabled={fix.disabled}
            onClick={fix.onClick}
          >
            {fix.label}
          </button>
        </div>
      )}
      {menuFix && !fix?.disabled && (
        <ObjectMenu
          target={target}
          label={t("claim.more")}
          here={menuFix}
          className="claim-quote-menu"
          testId="claim-part"
          tabIndex={-1}
          align="end"
        />
      )}
    </li>
  );
}

/**
 * A row's own fix (#2869): Check anyway for a part left out, and, while the check holds, Change
 * to the Document's figure for a contradicted part or the Document's wording for a forecast.
 */
export function partFix(
  t: Translate,
  row: CardPart,
  {
    stale,
    checking,
    correction,
    onCorrect,
    onUseWording,
    onCheck,
  }: {
    stale: boolean;
    checking: boolean;
    correction?: ClaimCorrection;
    onCorrect(span: ClaimPartSpan): void;
    onUseWording(part: ClaimCheckPart): void;
    onCheck(span: ClaimPartSpan): void;
  },
): CardAction | null {
  const { part } = row;
  if (part.verdict === null)
    return stale
      ? null
      : {
          key: `anyway:${row.key}`,
          testId: "claim-part-check-anyway",
          label: t("claim.checkAnyway"),
          disabled: checking,
          onClick: () => onCheck(part.span),
        };
  if (stale || checking) return null;
  if (correction)
    return {
      key: `correct:${row.key}`,
      testId: "claim-part-correct",
      label: correctionLabel(correction, t),
      primary: true,
      onClick: () => onCorrect(part.span),
    };
  if (
    part.unsupported?.kind === "forecast-certainty" &&
    (part.unsupported.quoted?.quote ?? part.evidence[0]?.quote)
  )
    return {
      key: `wording:${row.key}`,
      testId: "claim-use-wording",
      label: t("claim.useDocumentWording"),
      onClick: () => onUseWording(part),
    };
  return null;
}

/** What a quantified part covers, above its rows, and the quotes that say what its domain is. */
export function PartsCoverage({
  editor,
  parts,
  signedAll = false,
  onOpen,
}: {
  editor: Editor;
  parts: readonly ClaimCheckPart[];
  signedAll?: boolean;
  onOpen(): void;
}) {
  const t = useT();
  const language = useLanguage();
  return (
    <>
      {parts.flatMap((part) => {
        if (!part.coverage || !hasKnownDomain(part.coverage)) return [];
        const count = coverageCount(part.coverage);
        const format = (value: number) => new Intl.NumberFormat(language).format(value);
        return [
          <div key={part.span.start}>
            {/* A single part's rows already say what it covers. */}
            {parts.length >= 2 && (
              <p data-testid="claim-parts-coverage" className="claim-card-says">
                {t("claim.parts.coverage", {
                  covered: format(count.covered),
                  total: format(count.total),
                  unit: part.coverage.unit,
                })}
              </p>
            )}
            {part.coverage.domainEvidence.map((citation) => (
              <PartQuote
                editor={editor}
                key={
                  citation.id ??
                  JSON.stringify([citation.documentId, citation.contentHash, citation.quote])
                }
                citation={citation}
                part={part}
                signedAll={signedAll}
                onOpen={onOpen}
              />
            ))}
          </div>,
        ];
      })}
    </>
  );
}

/** Each correction from the Documents, by the row whose words it changes. */
export const correctionOf = (
  corrections: readonly PartCorrection[] | undefined,
  row: CardPart,
): ClaimCorrection | undefined =>
  row.label
    ? undefined
    : corrections?.find(
        ({ span }) => span?.start === row.part.span.start && span.end === row.part.span.end,
      )?.correction;

/**
 * The foot line of a card whose rows fold (#2869): what is folded, the supported first, then the
 * opinions left out, and Show, which opens every folded row in place, or Hide.
 */
export function FoldLine({
  rows,
  shown,
  onToggle,
}: {
  rows: readonly CardPart[];
  shown: boolean;
  onToggle(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const supported = rows.filter((row) => row.fold === "supported").length;
  const opinions = rows.filter((row) => row.fold === "opinion").length;
  if (supported + opinions === 0) return null;
  const what = [
    supported > 0 &&
      (supported === 1
        ? t("claim.parts.folded.one")
        : t("claim.parts.folded", { count: format(supported) })),
    opinions > 0 &&
      (opinions === 1 ? t("opinions.one") : t("opinions.count", { count: format(opinions) })),
  ]
    .filter((part): part is string => typeof part === "string")
    .reduce((line, part) => (line ? `${line}${dotAfter(line)}${part}` : part), "");
  // The toggle keeps its place in the line as its words change, so it keeps the focus (#2869).
  return (
    <p data-testid="claim-parts-folded" className="claim-fold-line">
      {!shown && supported > 0 && (
        <ClaimMarkIcon state="supported" className="claim-fold-icon" aria-hidden="true" />
      )}
      {!shown && <span className="claim-fold-what">{what}</span>}
      {!shown && <span aria-hidden="true">{dotAfter(what)}</span>}
      <QuoteLink testId="claim-parts-show" expanded={shown} onClick={onToggle}>
        {shown ? t("claim.parts.hide") : t("opinions.show")}
      </QuoteLink>
    </p>
  );
}

import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import type { ReactNode } from "react";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import type {
  CitationAttributes,
  ClaimCalculation,
  ClaimCheckPart,
  ClaimCheckScope,
  ClaimPartSpan,
} from "../../../core/api";
import { citationState, shownDocumentName } from "../../../shared/citations";
import { checkedScope } from "../../../shared/claimChecks";
import { attributionCorrection, coverageCount } from "../../../shared/claimParts";
import { cardRows, hasKnownDomain } from "../../../shared/claimRows";
import { formatClaimFacetPeriod } from "../../../shared/dates";
import { citationLocation, formatLocation } from "../../../shared/locations";
import { checkedByMe } from "../../../shared/signOffs";
import { sourceChoiceAt } from "../checks";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { rowActionButtonClass } from "../components/sidebarRows";
import { useLanguage, useT } from "../i18n";
import { openCited, quoteSaysSo } from "../openCited";
import { useScopeName } from "../scopeDocuments";
import { useAppStore } from "../store";
import { type CitationDecision, partDecisions } from "./alreadyCited";
import { focusFirstAction } from "./cardFocus";
import { useReadableQuote } from "./citationScan";
import type { ShownClaim } from "./claimChecks";
import { ClaimMarkIcon } from "./icons";
import { MindIdContext, SignOffsContext } from "./mindContext";
import { SignOffLine, SignOffToggle } from "./SignOff";
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

function PartCitation({
  editor,
  citation,
  onOpen,
}: {
  editor: Editor;
  citation: CitationAttributes;
  onOpen(): void;
}) {
  const t = useT();
  const documents = useAppStore((store) =>
    store.status.kind === "ready" ? store.documents : null,
  );
  const kept = useAppStore((store) => store.keptCitationTexts);
  const state = citationState(citation, documents, kept);
  const quote = useReadableQuote(citation);
  const location = citationLocation(citation);
  const where = location ? formatLocation(location, t) : null;
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
    if (!citation.documentId) return;
    void openCited(
      { ...citation, documentId: state.documentId ?? citation.documentId },
      { check: state.check, withQuote: quoteSaysSo(state.check), label: where },
    );
    onOpen();
  };
  const contents = (
    <>
      <span className="claim-part-source" title={source}>
        {source}
      </span>
      {citation.quote && <span className="claim-part-quote citation-card-wash">{quote}</span>}
    </>
  );
  return (
    <div data-testid="claim-part-receipt" data-citation-id={id ?? undefined} {...menu.rowProps}>
      {citation.documentId ? (
        <button
          type="button"
          className="claim-part-citation"
          data-testid="claim-part-citation"
          onClick={open}
        >
          {contents}
        </button>
      ) : (
        <div className="claim-part-citation">{contents}</div>
      )}
      <SignOffLine now={signOff} />
      {canSignOff && (
        <SignOffToggle now={signOff} onToggle={toggle} className="citation-card-action" />
      )}
      {target && (
        <ObjectMenu
          target={target}
          label={t("claim.more")}
          className={rowActionButtonClass}
          align="end"
          without={["citation.update", "citation.keepOld", "citation.remove"]}
          here={{
            ...(citation.documentId && { "citation.open": open }),
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

/** Whether a row of the sentence's card can add a Citation of what it found. */
export const citesMore = (
  state: EditorState,
  claim: ShownClaim,
  parts: readonly ClaimCheckPart[],
) =>
  cardRows(parts).some(({ part }) =>
    partDecisions(state, claim, part).some(({ decision }) => decision.kind === "add"),
  );

/** What a marked sentence's card does with the Citations of what its parts found (#2002). */
export interface PartCitations {
  claim: ShownClaim;
  onAdd(parts: readonly ClaimCheckPart[]): void;
  onWiden(decision: Extract<CitationDecision, { kind: "widen" }>): void;
  onReplace(decision: Extract<CitationDecision, { kind: "replace" }>): void;
}

/**
 * A supported row's Citations, by the sentence card's rules: the one it already
 * has, or Widen or Replace the one there. Add as Citation sits on its result line.
 */
function PartCiting({
  citing,
  citations,
  onOpen,
}: {
  citing: readonly CitationDecision[];
  citations: PartCitations;
  onOpen(): void;
}) {
  const t = useT();
  const already = [
    ...new Map(
      citing.flatMap((decision) =>
        decision.kind === "already" ? [[decision.citation.number, decision.citation] as const] : [],
      ),
    ).values(),
  ];
  const widen = citing.filter((decision) => decision.kind === "widen");
  const replace = citing.filter((decision) => decision.kind === "replace");
  return (
    <>
      {already.map((citation) => (
        <OpenCitation
          key={citation.number}
          citation={citation}
          label={t("claim.alreadyCited.open", { number: citation.number })}
          onOpen={onOpen}
        >
          <span data-testid="claim-part-already-cited">{t("claim.alreadyCited")}</span>
          <CitationChip citation={citation} testId="claim-part-already-chip" />
        </OpenCitation>
      ))}
      {widen.length > 0 && (
        <button
          type="button"
          data-testid="claim-part-widen-citation"
          className="citation-card-action"
          onClick={() => {
            for (const decision of widen) citations.onWiden(decision);
          }}
        >
          {t("claim.widenCitation")}
        </button>
      )}
      {replace.length > 0 && (
        <button
          type="button"
          data-testid="claim-part-replace-citation"
          className="citation-card-action"
          onClick={() => {
            for (const decision of replace) citations.onReplace(decision);
          }}
        >
          {t("claim.replaceCitation")}
        </button>
      )}
    </>
  );
}

function PartRow({
  editor,
  id,
  text,
  words,
  part,
  onCheck,
  onUseWording,
  onChooseSource,
  onChangeSource,
  onChangePeriod,
  onOpen,
  working,
  lookedIn,
  checking,
  stale,
  citing,
  citations,
}: {
  editor: Editor;
  id: string;
  text: string;
  words?: string;
  part: ClaimCheckPart;
  onCheck(span: ClaimPartSpan): void;
  onUseWording?(part: ClaimCheckPart): void;
  onChooseSource?(part: ClaimCheckPart, anchor: HTMLElement): void;
  onChangeSource?(part: ClaimCheckPart): void;
  onChangePeriod?(part: ClaimCheckPart): void;
  onOpen(): void;
  lookedIn: string;
  checking: boolean;
  stale: boolean;
  working?(calculation: ClaimCalculation): ReactNode;
  citing: readonly CitationDecision[];
  citations?: PartCitations;
}) {
  const t = useT();
  const language = useLanguage();
  const mindId = useContext(MindIdContext);
  const documents = useAppStore((store) =>
    store.status.kind === "ready" ? store.documents : null,
  );
  const omitted = !stale && part.kind === "opinion" && part.verdict === null;
  const held =
    part.citedCaseFound &&
    (part.verdict === "supported" ||
      part.verdict === "contradicted" ||
      part.verdict === "unsupported")
      ? part.evidence.find((citation) => citationLocation(citation) !== null)
      : undefined;
  const heldAt = held ? citationLocation(held) : null;
  const state = stale ? "needs-recheck" : part.verdict;
  const literal = text.slice(part.span.start, part.span.end);
  const label =
    part.facet?.kind === "time"
      ? t("claim.time.when", { time: literal })
      : part.facet
        ? literal
        : (words ?? literal);
  const period =
    part.facet?.kind === "time" && part.facet.period
      ? formatClaimFacetPeriod(part.facet.period, language)
      : "";
  const receipt = part.evidence[part.decidingEvidence ?? 0];
  const document = receipt ? shownDocumentName(receipt, documents) : null;
  const asOf =
    !stale && !checking && part.verdict === "supported" && period && document
      ? t("claim.time.supported", { period, document })
      : null;
  const chooseSource =
    !checking &&
    mindId !== null &&
    sourceChoiceAt(editor, mindId, `${id}:${part.span.start}:${part.span.end}`) !== null &&
    onChooseSource;
  const changePeriod =
    !stale && !checking && part.verdict === "unsupported" && period && onChangePeriod;
  const correction =
    !stale && !checking && onChangeSource
      ? attributionCorrection({ text }, part, documents ?? [])
      : null;
  const sourceWording = correction?.kind === "source" ? correction.document : null;
  const target = { kind: "check", id: `${id}:${part.span.start}:${part.span.end}` } as const;
  const menu = useObjectMenu(target);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const reason =
    part.verdict === "not-checked" && part.reason
      ? t(`claim.reason.${part.reason}`, { detail: part.detail ?? "" })
      : part.verdict !== "unsupported"
        ? null
        : part.unsupported?.kind === "forecast-certainty"
          ? t("claim.forecast")
          : part.unsupported?.kind === "unbacked-cause"
            ? t("claim.unbackedCause")
            : (part.unsupported?.reason ??
              (part.verdict === "unsupported"
                ? t("claim.unsupported.notFound", { scope: lookedIn })
                : null));
  const wording =
    !stale &&
    !checking &&
    part.unsupported?.kind === "forecast-certainty" &&
    Boolean(part.unsupported.quoted?.quote ?? part.evidence[0]?.quote) &&
    onUseWording;
  return (
    <li
      className={`claim-part citation-card--${stale ? "checking" : part.verdict === "supported" ? "found" : part.verdict === "contradicted" ? "contradicted" : part.verdict === "unsupported" ? "unsupported" : "cant-check"}`}
      data-testid="claim-part"
      data-kind={part.kind}
      data-facet={part.facet?.kind}
      tabIndex={-1}
      data-verdict={state ?? "opinion"}
      {...menu.rowProps}
    >
      <p className="claim-part-words">{label}</p>
      <p className="claim-part-result">
        {state !== null && <ClaimMarkIcon state={state} className="citation-badge-icon" />}
        <span>
          {state === null
            ? t("claim.opinion")
            : state === "checking"
              ? t("claim.part.checking")
              : t(`claim.state.${state}`)}
        </span>
        {citations && citing.some((decision) => decision.kind === "add") && (
          <button
            type="button"
            data-testid="claim-part-add-citation"
            className="citation-card-action claim-part-add"
            onClick={() => citations.onAdd([part])}
          >
            {t("claim.addAsCitation")}
          </button>
        )}
      </p>
      {(reason || asOf) && (
        <p className="citation-card-note" data-testid="claim-part-reason">
          {reason ?? asOf}
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
      {part.says && part.verdict === "contradicted" && (
        <p className="claim-card-says">{part.says}</p>
      )}
      {part.evidence.map((citation) => (
        <PartCitation
          editor={editor}
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
          citation={citation}
          onOpen={onOpen}
        />
      ))}
      {part.calculation && working?.(part.calculation)}
      {citations && <PartCiting citing={citing} citations={citations} onOpen={onOpen} />}
      {chooseSource && (
        <button
          ref={chooseButton}
          type="button"
          data-testid="claim-part-choose-source"
          className="citation-card-action"
          onClick={(event) => chooseSource(part, event.currentTarget)}
        >
          {t("claim.source.choose")}
        </button>
      )}
      {changePeriod && (
        <button
          type="button"
          data-testid="claim-part-change-period"
          className="citation-card-action"
          onClick={() => changePeriod(part)}
        >
          {t("claim.time.changeTo", { period })}
        </button>
      )}
      {sourceWording && (
        <button
          type="button"
          data-testid="claim-part-change-source"
          className="citation-card-action"
          onClick={() => onChangeSource?.(part)}
        >
          {t("claim.source.changeTo", { document: sourceWording })}
        </button>
      )}
      {wording && (
        <button
          type="button"
          data-testid="claim-use-wording"
          className="citation-card-action"
          onClick={() => onUseWording?.(part)}
        >
          {t("claim.useDocumentWording")}
        </button>
      )}
      {omitted && (
        <button
          type="button"
          data-testid="claim-part-check-anyway"
          disabled={checking}
          className="citation-card-action"
          onClick={() => onCheck(part.span)}
        >
          {t("claim.checkAnyway")}
        </button>
      )}
      {((omitted && !checking) || wording || sourceWording || changePeriod || chooseSource) && (
        <ObjectMenu
          target={target}
          label={t("claim.more")}
          here={{
            ...(omitted && !checking && { "check.anyway": () => onCheck(part.span) }),
            ...(wording && { "check.useDocumentWording": () => onUseWording?.(part) }),
            ...(sourceWording && { "check.correctSource": () => onChangeSource?.(part) }),
            ...(changePeriod && { "check.correctPeriod": () => onChangePeriod?.(part) }),
            ...(chooseSource && {
              "check.chooseSource": () => {
                const anchor = chooseButton.current;
                if (anchor) chooseSource(part, anchor);
              },
            }),
          }}
          className={`${rowActionButtonClass} claim-part-menu`}
          align="end"
        />
      )}
    </li>
  );
}

export function ClaimPartRows({
  editor,
  id,
  text,
  parts,
  onCheck,
  onUseWording,
  onChooseSource,
  onChangeSource,
  onChangePeriod,
  onOpen,
  working,
  scope,
  checking = false,
  stale = false,
  citations,
}: {
  editor: Editor;
  id: string;
  text: string;
  parts: readonly ClaimCheckPart[];
  onCheck(span: ClaimPartSpan): void;
  onUseWording?(part: ClaimCheckPart): void;
  onChooseSource?(part: ClaimCheckPart, anchor: HTMLElement): void;
  onChangeSource?(part: ClaimCheckPart): void;
  onChangePeriod?(part: ClaimCheckPart): void;
  onOpen(): void;
  scope?: ClaimCheckScope;
  checking?: boolean;
  stale?: boolean;
  working?(calculation: ClaimCalculation): ReactNode;
  /** A marked sentence's rows add, widen or replace the Citations of what they found. */
  citations?: PartCitations;
}) {
  const t = useT();
  const language = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const revealFocus = useRef(false);
  useLayoutEffect(() => {
    if (!expanded || !revealFocus.current) return;
    revealFocus.current = false;
    const row = list.current?.children.item(4);
    if (row instanceof HTMLElement) focusFirstAction(row, row);
  }, [expanded]);
  const looked = useScopeName(scope ? checkedScope(scope) : null);
  const lookedIn = looked?.name ?? t("composer.scope.all");
  const rows = cardRows(parts);
  const visible = expanded ? rows : rows.slice(0, 4);
  const citing = rows.map(({ part }) =>
    citations && !stale && !checking
      ? partDecisions(editor.state, citations.claim, part).map(({ decision }) => decision)
      : [],
  );
  const addable = rows.flatMap(({ part }, index) =>
    citing[index]?.some((decision) => decision.kind === "add") ? [part] : [],
  );
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
              <PartCitation
                editor={editor}
                key={
                  citation.id ??
                  JSON.stringify([citation.documentId, citation.contentHash, citation.quote])
                }
                citation={citation}
                onOpen={onOpen}
              />
            ))}
          </div>,
        ];
      })}
      {citations && addable.length >= 2 && (
        <button
          type="button"
          data-testid="claim-parts-add-all"
          className="citation-card-action citation-card-action--primary"
          onClick={() => citations.onAdd(addable)}
        >
          {t("claim.addAllAsCitations")}
        </button>
      )}
      <ol ref={list} className="claim-parts" data-testid="claim-parts">
        {visible.map(({ part, label }, index) => (
          <PartRow
            editor={editor}
            key={`${part.span.start}:${part.span.end}:${label ?? ""}`}
            id={id}
            text={text}
            words={label ?? undefined}
            part={part}
            onCheck={onCheck}
            onUseWording={onUseWording}
            onChooseSource={onChooseSource}
            onChangeSource={onChangeSource}
            onChangePeriod={onChangePeriod}
            onOpen={onOpen}
            working={working}
            lookedIn={lookedIn}
            checking={checking}
            stale={stale}
            citing={citing[index] ?? []}
            citations={citations}
          />
        ))}
      </ol>
      {!expanded && rows.length > 4 && (
        <button
          type="button"
          className="citation-card-action"
          data-testid="claim-parts-more"
          onClick={(event) => {
            revealFocus.current = document.activeElement === event.currentTarget;
            setExpanded(true);
          }}
        >
          {t("claim.parts.more", {
            count: new Intl.NumberFormat(language).format(rows.length - 4),
          })}
        </button>
      )}
    </>
  );
}

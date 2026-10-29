import type { Editor } from "@tiptap/core";
import type { ReactNode } from "react";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import type {
  CitationAttributes,
  ClaimCalculation,
  ClaimCheckPart,
  ClaimCheckScope,
  ClaimPartCoverage,
  ClaimPartSpan,
} from "../../../core/api";
import { citationState, shownDocumentName } from "../../../shared/citations";
import { checkedScope } from "../../../shared/claimChecks";
import { coverageCount } from "../../../shared/claimParts";
import { citationLocation, formatLocation } from "../../../shared/locations";
import { checkedByMe } from "../../../shared/signOffs";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { rowActionButtonClass } from "../components/sidebarRows";
import { useLanguage, useT } from "../i18n";
import { openCitedFollowing, quoteSaysSo } from "../openCited";
import { useScopeName } from "../scopeDocuments";
import { useAppStore } from "../store";
import { focusFirstAction } from "./cardFocus";
import { useReadableQuote } from "./citationScan";
import { ClaimMarkIcon } from "./icons";
import { SignOffsContext } from "./mindContext";
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

function hasKnownDomain(coverage: ClaimPartCoverage): boolean {
  return (
    coverage.complete &&
    coverage.domainEvidence.some(
      (citation) =>
        citation.check === "found" && Boolean(citation.documentId && citation.quote?.trim()),
    )
  );
}

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
    void openCitedFollowing(
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

function PartRow({
  editor,
  id,
  text,
  words,
  part,
  onCheck,
  onUseWording,
  onOpen,
  working,
  lookedIn,
  checking,
  stale,
}: {
  editor: Editor;
  id: string;
  text: string;
  words?: string;
  part: ClaimCheckPart;
  onCheck(span: ClaimPartSpan): void;
  onUseWording?(part: ClaimCheckPart): void;
  onOpen(): void;
  lookedIn: string;
  checking: boolean;
  stale: boolean;
  working?(calculation: ClaimCalculation): ReactNode;
}) {
  const t = useT();
  const omitted = !stale && part.kind === "opinion" && part.verdict === null;
  const state = stale ? "needs-recheck" : part.verdict;
  const target = { kind: "check", id: `${id}:${part.span.start}:${part.span.end}` } as const;
  const menu = useObjectMenu(target);
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
      tabIndex={-1}
      data-verdict={state ?? "opinion"}
      {...menu.rowProps}
    >
      <p className="claim-part-words">{words ?? text.slice(part.span.start, part.span.end)}</p>
      <p className="claim-part-result">
        {state !== null && <ClaimMarkIcon state={state} className="citation-badge-icon" />}
        <span>
          {state === null
            ? t("claim.opinion")
            : state === "checking"
              ? t("claim.part.checking")
              : t(`claim.state.${state}`)}
        </span>
      </p>
      {reason && (
        <p className="citation-card-note" data-testid="claim-part-reason">
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
      {((omitted && !checking) || wording) && (
        <ObjectMenu
          target={target}
          label={t("claim.more")}
          here={{
            ...(omitted && !checking && { "check.anyway": () => onCheck(part.span) }),
            ...(wording && { "check.useDocumentWording": () => onUseWording?.(part) }),
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
  onOpen,
  working,
  scope,
  checking = false,
  stale = false,
}: {
  editor: Editor;
  id: string;
  text: string;
  parts: readonly ClaimCheckPart[];
  onCheck(span: ClaimPartSpan): void;
  onUseWording?(part: ClaimCheckPart): void;
  onOpen(): void;
  scope?: ClaimCheckScope;
  checking?: boolean;
  stale?: boolean;
  working?(calculation: ClaimCalculation): ReactNode;
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
  const rows = parts.flatMap<{ part: ClaimCheckPart; label: string | null }>((part) => {
    if (!part.coverage) return [{ part, label: null }];
    const members = part.coverage.members.map((member) => ({
      part: { ...part, verdict: member.verdict, evidence: member.evidence, coverage: undefined },
      label: member.label,
    }));
    return hasKnownDomain(part.coverage)
      ? members
      : [{ part: { ...part, coverage: undefined }, label: null }, ...members];
  });
  const visible = expanded ? rows : rows.slice(0, 4);
  return (
    <>
      {parts.flatMap((part) => {
        if (!part.coverage || !hasKnownDomain(part.coverage)) return [];
        const count = coverageCount(part.coverage);
        const format = (value: number) => new Intl.NumberFormat(language).format(value);
        return [
          <div key={part.span.start}>
            <p data-testid="claim-parts-coverage" className="claim-card-says">
              {t("claim.parts.coverage", {
                covered: format(count.covered),
                total: format(count.total),
                unit: part.coverage.unit,
              })}
            </p>
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
      <ol ref={list} className="claim-parts" data-testid="claim-parts">
        {visible.map(({ part, label }) => (
          <PartRow
            editor={editor}
            key={`${part.span.start}:${part.span.end}:${label ?? ""}`}
            id={id}
            text={text}
            words={label ?? undefined}
            part={part}
            onCheck={onCheck}
            onUseWording={onUseWording}
            onOpen={onOpen}
            working={working}
            lookedIn={lookedIn}
            checking={checking}
            stale={stale}
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

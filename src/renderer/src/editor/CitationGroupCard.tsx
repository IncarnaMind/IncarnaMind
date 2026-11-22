import type { ReactNode, RefObject } from "react";
import type { CitationCheck, StyledRun } from "../../../core/api";
import { ObjectMenu } from "../components/ObjectMenu";
import { useGap, useT } from "../i18n";
import type { CitationLook } from "./citationLooks";
import { CheckStateIcon, ClaimMarkIcon } from "./icons";
import { StyledRuns } from "./StyledRuns";
import { runsText } from "./styledText";

/**
 * The card of a chip that stands for several Citations of one source and place side by side:
 * the state line of the worst of them, the Document and place, then each quote in reading order,
 * in its own check's colours. A quote that needs a look says so above it, with its first way on.
 * Pressing a quote opens the page at its words; Open marks them all. Each quote's ⋯ is its own
 * Citation's menu, as the right-click on a chip of its own would be.
 */
export function CitationGroupCard({
  card,
  check,
  recheck,
  badge,
  source,
  looks,
  openLabel,
  onOpenAll,
  onOpenOne,
  note,
  hint,
}: {
  card: RefObject<HTMLDivElement | null>;
  check: CitationCheck;
  recheck: boolean;
  badge: string;
  source: string | null;
  looks: readonly CitationLook[];
  openLabel: string;
  onOpenAll(): void;
  onOpenOne(look: CitationLook): void;
  /** In a note style, the note the Citations are written in, as an export will write it. */
  note: readonly StyledRun[] | null;
  hint: ReactNode;
}) {
  const t = useT();
  const gap = useGap();
  const allFound = looks.every((look) => look.check === "found" && !look.recheck);
  return (
    <div
      ref={card}
      data-testid="citation-group-card"
      className={`citation-card citation-card--${check} citation-group-card`}
      contentEditable={false}
    >
      <div data-testid="citation-card-head" className="citation-card-head">
        <p
          data-testid="citation-badge"
          data-check={check}
          data-recheck={recheck || undefined}
          className="citation-badge"
        >
          {recheck ? (
            <ClaimMarkIcon state="needs-recheck" className="citation-badge-icon" />
          ) : (
            <CheckStateIcon check={check} className="citation-badge-icon" />
          )}
          <span>{badge}</span>
        </p>
        {source && (
          <p data-testid="citation-source" title={source} className="citation-card-source">
            {source}
          </p>
        )}
      </div>
      <ul className="citation-group-quotes">
        {looks.map((look) => (
          <GroupQuote key={look.key} look={look} onOpen={() => onOpenOne(look)} />
        ))}
      </ul>
      {note && (
        <p data-testid="citation-styled-note" className="citation-card-styled">
          <span className="citation-card-styled-label">{t("citation.note")}</span>
          {gap(t("citation.note"), runsText(note))}
          <StyledRuns runs={note} />
        </p>
      )}
      {allFound && <p className="citation-card-note">{t("citation.meaning")}</p>}
      <div className="citation-card-actions">
        <button
          type="button"
          data-testid="citation-open"
          className="citation-card-action citation-card-action--primary"
          onClick={onOpenAll}
        >
          {openLabel}
        </button>
      </div>
      {hint}
    </div>
  );
}

function GroupQuote({ look, onOpen }: { look: CitationLook; onOpen(): void }) {
  const t = useT();
  const quiet = look.check === "found" && !look.recheck;
  return (
    <li
      data-testid="citation-group-quote"
      data-check={look.check}
      data-recheck={look.recheck || undefined}
      className={`citation-group-quote citation-card--${look.check}`}
    >
      {!quiet && (
        <p className="citation-group-quote-state">
          {look.recheck ? (
            <ClaimMarkIcon state="needs-recheck" className="citation-group-quote-icon" />
          ) : (
            <CheckStateIcon check={look.check} className="citation-group-quote-icon" />
          )}
          <span>{look.badge}</span>
          {look.fix && (
            <button type="button" className="citation-group-quote-fix" onClick={look.fix.run}>
              {look.fix.label}
            </button>
          )}
        </p>
      )}
      <div className="citation-group-quote-row">
        <button
          type="button"
          className="citation-group-quote-open"
          title={t("citation.group.openQuote")}
          onClick={onOpen}
        >
          {look.changed ? (
            <span className="citation-card-changed-words">
              {look.changed.map((part, index) =>
                part.kind === "removed" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity but their place.
                  <del key={index}>{part.text}</del>
                ) : part.kind === "added" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity but their place.
                  <ins key={index}>{part.text}</ins>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity but their place.
                  <span key={index}>{part.text}</span>
                ),
              )}
            </span>
          ) : (
            <span className="citation-card-wash">{look.quote}</span>
          )}
        </button>
        <ObjectMenu
          target={{ kind: "citation", id: `group-quote:${look.key}` }}
          label={t("citation.group.quoteMore")}
          here={look.here()}
          className="citation-group-quote-menu citation-card-action"
        />
      </div>
    </li>
  );
}

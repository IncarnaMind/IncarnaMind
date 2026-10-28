import type { ReactNode } from "react";
import type { CitationAttributes } from "../../../core/api";
import { changedSourceLines, citationState } from "../../../shared/citations";
import { useCitationRecheck } from "../citationVersion";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import type { NumberedCitation } from "./citationNumbers";
import { CitationChip } from "./UnsupportedCited";

/**
 * What a card says of a Citation whose Document changed after it was cited (#99): when it changed
 * and where the quote stands in the new version. Nothing while the Document is as it was cited.
 */
export function ChangedSourceNotice({
  attributes,
  chip,
}: {
  attributes: CitationAttributes;
  /** The Citation's number, shown before the notice. */
  chip?: ReactNode;
}) {
  const t = useT();
  const language = useLanguage();
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const kept = useAppStore((state) => state.keptCitationTexts);
  const state = citationState(attributes, documents, kept);
  const live = documents?.find((each) => each.id === state.documentId);
  const recheck = useCitationRecheck(
    state.changedAfterCited ? attributes : null,
    state.changedAfterCited,
    live?.contentHash,
  );
  const { note, on } = changedSourceLines(
    state.changedAfterCited,
    attributes,
    recheck,
    live,
    language,
    t,
  );
  if (!note) return null;
  return (
    <div data-testid="citation-changed-notice" className="citation-card-note">
      {chip}
      <p>{note.notice}</p>
      {note.quote && <p>{note.quote}</p>}
      {on && <p>{on}</p>}
    </div>
  );
}

/** A sentence's Citations whose Documents changed after they were cited, each with its number. */
export function ChangedCitations({ cited }: { cited: readonly NumberedCitation[] }) {
  return (
    <>
      {cited.map((citation) => (
        <ChangedCitation key={citation.key} citation={citation} />
      ))}
    </>
  );
}

function ChangedCitation({ citation }: { citation: NumberedCitation }) {
  return (
    <ChangedSourceNotice
      attributes={citation.attributes}
      chip={<CitationChip citation={citation} testId="claim-changed-chip" />}
    />
  );
}

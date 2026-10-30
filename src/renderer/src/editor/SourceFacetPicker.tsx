import type { ClaimCheckAttributes, ClaimCheckPart } from "../../../core/api";
import { formatClaimFacetPeriod } from "../../../shared/dates";
import { displayName } from "../../../shared/documentNames";
import { readStatedPeriods } from "../../../shared/statedPeriods";
import { SearchPicker } from "../components/SearchPicker";
import { useLanguage, useT } from "../i18n";
import { sourceFacetChoices } from "../sourceFacets";
import { useAppStore } from "../store";
import "./SourceFacetPicker.css";

export function SourceFacetPicker({
  anchor,
  mindId,
  check,
  part,
  onChoose,
  onCheckAgain,
  onClose,
}: {
  anchor: HTMLElement;
  mindId: string;
  check: ClaimCheckAttributes;
  part: ClaimCheckPart;
  onChoose(documentId: string): void;
  onCheckAgain(): void;
  onClose(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const state = useAppStore();
  const folderId = state.minds.find((mind) => mind.id === mindId)?.folderId ?? null;
  const read = sourceFacetChoices(
    check,
    part,
    {
      documents: state.documents,
      folders: state.folders,
      tags: state.tags,
      groups: state.library?.groups,
      assignments: state.library?.assignments,
    },
    folderId,
  );
  const options = (read?.choices ?? []).map((choice) => {
    const periods = readStatedPeriods(choice.citation?.quote ?? "");
    const period =
      periods.length > 0
        ? new Intl.ListFormat(language, { style: "short", type: "conjunction" }).format(
            periods.map((period) => formatClaimFacetPeriod(period, language)),
          )
        : t("claim.source.noPeriod");
    return {
      id: choice.document.id,
      label: displayName(choice.document),
      detail: [
        choice.folder ?? t("library.unsorted"),
        choice.needsRecheck ? t("claim.state.needs-recheck") : period,
      ].join(" · "),
      keywords: [choice.folder ?? "", period],
      data: { "data-document-id": choice.document.id },
    };
  });
  const selected = part.facet?.kind === "source" ? part.facet.selectedDocumentId : undefined;
  return (
    <SearchPicker
      anchor={anchor}
      title={t("claim.source.picker", { name: read?.name ?? "" })}
      searchLabel={t("claim.source.search")}
      noMatch={() => t("claim.source.noMatch")}
      options={options}
      current={selected}
      currentLabel={t("claim.source.choose")}
      onChoose={onChoose}
      onClose={onClose}
      footer={
        options.length === 0 ? (
          <button type="button" className="citation-card-action" onClick={onCheckAgain}>
            {t("claim.checkAgain")}
          </button>
        ) : undefined
      }
      testId="claim-source"
      widthClass="claim-source-picker w-[min(360px,calc(100vw-16px))]"
    />
  );
}

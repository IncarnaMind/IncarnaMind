import type { SearchScope } from "../../../core/api";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import {
  type DocumentOrFolderChoice,
  documentOrFolderChoices,
  documentOrFolderScope,
} from "./documentOrFolder";
import { DocumentLineIcon, FolderLineIcon } from "./lineIcons";
import { type PickerOption, type PickerSection, SearchPicker } from "./SearchPicker";

export type { DocumentOrFolderChoice } from "./documentOrFolder";
export { documentOrFolderChoices, documentOrFolderScope } from "./documentOrFolder";

export interface DocumentOrFolderPickerLabels {
  title: string;
  search: string;
  noMatch: string;
}

/** One Document or Folder, found by its English or Chinese name, to use as a Search scope. */
export function DocumentOrFolderPicker({
  anchor,
  labels,
  onChoose,
  onClose,
  testId = "document-or-folder",
}: {
  /** What it opens beside; it takes the focus back once closed. Null: closed. */
  anchor: HTMLElement | null;
  labels: DocumentOrFolderPickerLabels;
  onChoose(scope: SearchScope): void;
  onClose(): void;
  testId?: string;
}) {
  const t = useT();
  const folders = useAppStore((state) => state.folders);
  const groups = useAppStore((state) => state.library?.groups);
  const tags = useAppStore((state) => state.tags);
  const documents = useAppStore((state) => state.documents);
  const assignments = useAppStore((state) => state.library?.assignments);
  const library = { folders, groups, tags, documents, assignments };
  const byId = new Map(documents.map((document) => [document.id, document]));

  const matching = (query: string): PickerSection<DocumentOrFolderChoice>[] => {
    const optionOf = (choice: DocumentOrFolderChoice): PickerOption<DocumentOrFolderChoice> => {
      const disabledReason =
        choice.kind === "folder" && choice.count === 0
          ? t("scope.picker.empty.hint")
          : choice.kind === "document" && byId.get(choice.id)?.status === "no-text"
            ? t("documents.statusShort.noText")
            : undefined;
      const place = [...(choice.sourceLocation ? [t("library.sources")] : []), ...choice.path].join(
        " / ",
      );
      const detail = [place, choice.count?.toString()].filter(Boolean).join(" · ");
      return {
        id: choice,
        label: choice.name,
        detail: detail || undefined,
        disabledReason,
        data: { "data-scope-kind": choice.kind, "data-scope-id": choice.id },
        icon:
          choice.kind === "folder" ? (
            <FolderLineIcon className="size-4 shrink-0 text-ink-meta" />
          ) : (
            <DocumentLineIcon
              kind={choice.documentKind ?? "text"}
              className="size-4 shrink-0 text-ink-meta"
            />
          ),
      };
    };
    const choices = documentOrFolderChoices(library, query);
    return [
      {
        title: t("scope.picker.folders"),
        options: choices.filter((choice) => choice.kind === "folder").map(optionOf),
      },
      {
        title: t("scope.picker.documents"),
        options: choices.filter((choice) => choice.kind === "document").map(optionOf),
      },
    ];
  };

  return (
    <SearchPicker<DocumentOrFolderChoice>
      anchor={anchor}
      title={labels.title}
      searchLabel={labels.search}
      noMatch={() => labels.noMatch}
      options={matching}
      current={undefined}
      currentLabel=""
      onChoose={(choice) => onChoose(documentOrFolderScope(choice))}
      onClose={onClose}
      testId={testId}
    />
  );
}

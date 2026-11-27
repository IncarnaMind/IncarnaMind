import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { DocumentLineIcon } from "../components/icons";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { openChipDocument } from "./documentChipKeys";

/**
 * A Document chip in the text: the Document's name as it is now, which opens
 * it in the viewer. A Document that has been deleted shows the name it had,
 * struck through, and says so; the chip stays, so the sentence still reads.
 */
export function DocumentChipView({ node }: ReactNodeViewProps) {
  const t = useT();
  const documentId = String(node.attrs.documentId);
  const document = useAppStore((state) => state.documents.find((each) => each.id === documentId));
  const name = document?.name ?? String(node.attrs.name);

  return (
    <NodeViewWrapper className="document-chip-wrap">
      <button
        type="button"
        data-testid="document-chip"
        data-document-id={documentId}
        data-missing={document ? undefined : "true"}
        tabIndex={-1}
        title={document ? t("editor.chip.open", { name }) : t("editor.chip.deleted", { name })}
        aria-disabled={document ? undefined : true}
        className="document-chip"
        onClick={() => openChipDocument(documentId)}
      >
        <DocumentLineIcon kind={document?.kind ?? "text"} className="size-3.5 flex-none" />
        <span className="document-chip-name">{name}</span>
      </button>
    </NodeViewWrapper>
  );
}

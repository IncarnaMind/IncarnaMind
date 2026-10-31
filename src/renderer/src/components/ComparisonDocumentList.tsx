import type { Document } from "../../../core/api";
import { useT } from "../i18n";

/**
 * The Documents a comparison table can be made of, each with its tick. The
 * ones a table already has stay ticked and can't be unticked (#1837), so
 * adding Documents never asks their cells again.
 */
export function ComparisonDocumentList({
  documents,
  checked,
  locked,
  testId = "compare-sheet-document",
  onToggle,
}: {
  documents: readonly Document[];
  checked: ReadonlySet<string>;
  locked?: ReadonlySet<string>;
  testId?: string;
  onToggle(documentId: string): void;
}) {
  const t = useT();
  return (
    <ul className="compare-sheet-list">
      {documents.map((document) => {
        const held = locked?.has(document.id) ?? false;
        return (
          <li key={document.id}>
            <label className="compare-sheet-document" title={document.name}>
              <input
                type="checkbox"
                data-testid={testId}
                checked={checked.has(document.id)}
                disabled={held}
                aria-description={held ? t("comparison.add.locked") : undefined}
                onChange={() => onToggle(document.id)}
              />
              <span className="truncate">{document.name}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

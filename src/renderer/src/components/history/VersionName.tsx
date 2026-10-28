import type { RefObject } from "react";
import type { Checkpoint } from "../../../../core/api";
import { useT } from "../../i18n";
import { InlineName } from "../InlineName";
import { renameVersion } from "./versionNames";

/**
 * The chosen version's name, typed where it is shown (#1933): its name, or "Name this version",
 * which a click, a double-click or F2 turns into a field. Undo takes the name back.
 */
export function VersionName({
  mindId,
  checkpoint,
  naming,
  button,
  onNaming,
  onNamed,
}: {
  mindId: string;
  checkpoint: Checkpoint;
  naming: boolean;
  button: RefObject<HTMLButtonElement | null>;
  onNaming(naming: boolean): void;
  /** The version with its new name, shown at once while History reads its versions again. */
  onNamed(checkpoint: Checkpoint): void;
}) {
  const t = useT();
  const rename = (name: string | null) => renameVersion(mindId, checkpoint, name, onNamed);
  if (naming)
    return (
      <InlineName
        value={checkpoint.name ?? ""}
        label={t("history.name.label")}
        placeholder={t("history.name.add")}
        maxLength={120}
        testId="history-name-field"
        className="history-name-input"
        clearable
        onCommit={async (name) => {
          onNaming(false);
          await rename(name === "" ? null : name);
        }}
        onCancel={() => onNaming(false)}
      />
    );
  return (
    <button
      ref={button}
      type="button"
      data-testid="history-name"
      data-named={checkpoint.name !== null || undefined}
      title={checkpoint.name ?? t("history.name.add")}
      className="history-name"
      onClick={() => onNaming(true)}
      onKeyDown={(event) => {
        if (event.key !== "F2") return;
        event.preventDefault();
        onNaming(true);
      }}
    >
      <span className="min-w-0 truncate">{checkpoint.name ?? t("history.name.add")}</span>
    </button>
  );
}

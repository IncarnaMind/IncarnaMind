import type { Checkpoint } from "../../../../core/api";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useUndo } from "../../undo";
import { InlineName } from "../InlineName";

/** Where History shows the line of a name it gave, so ⌘Z there takes it back (`UndoLineAt`). */
export const HISTORY_UNDO_PLACE = "history";

/**
 * The chosen version's name, typed where it is shown (#1933): its name, or "Name this version",
 * which a click, a double-click or F2 turns into a field. Undo takes the name back.
 */
export function VersionName({
  mindId,
  checkpoint,
  naming,
  onNaming,
  onNamed,
}: {
  mindId: string;
  checkpoint: Checkpoint;
  naming: boolean;
  onNaming(naming: boolean): void;
  /** The version with its new name, shown at once while History reads its versions again. */
  onNamed(checkpoint: Checkpoint): void;
}) {
  const t = useT();
  const rename = async (name: string | null) => {
    const before = checkpoint.name;
    onNamed(await core.renameCheckpoint(mindId, checkpoint.id, name));
    useUndo.getState().push({
      said: (say) => (name ? say("history.named", { name }) : say("history.unnamed")),
      shownAt: HISTORY_UNDO_PLACE,
      undo: async () => {
        await core.renameCheckpoint(mindId, checkpoint.id, before);
      },
      redo: async () => {
        await core.renameCheckpoint(mindId, checkpoint.id, name);
      },
    });
  };
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

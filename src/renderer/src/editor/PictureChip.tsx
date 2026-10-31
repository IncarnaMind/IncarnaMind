import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { useEffect } from "react";
import type * as Y from "yjs";
import { PICTURE_NODE } from "../../../core/api";
import { useAnswers } from "../answers";
import { ImageLineIcon } from "../components/lineIcons";
import { useT } from "../i18n";
import { useModelInUse } from "../modelInUse";
import { useServiceName } from "../modelNames";

/** Whether the Editor's selection is a picture: the picture is what the Question would ask about. */
function usePictureSelected(editor: Editor | null): boolean {
  return (
    useEditorState({
      editor,
      selector: ({ editor: current }) => {
        if (!current || current.isDestroyed) return false;
        const { selection } = current.state;
        return selection instanceof NodeSelection && selection.node.type.name === PICTURE_NODE;
      },
    }) ?? false
  );
}

/**
 * What asking with a picture selected does with it (#1937): the line above the
 * composer that names where the picture goes, before the User sends it, or
 * says the model can't read pictures, so no picture goes and the Question is
 * answered from the Note's words alone. It shows only while a picture is
 * selected in the Note.
 */
export function PictureChip({ editor, doc }: { editor: Editor | null; doc: Y.Doc | null }) {
  const t = useT();
  const selected = usePictureSelected(editor);
  const model = useModelInUse(doc);
  const service = useServiceName(model?.providerId ?? null);
  const groups = useAnswers((state) => state.models);
  // The models say what they read; the chip asks for them the first time a picture is selected.
  useEffect(() => {
    if (selected) useAnswers.getState().loadModels();
  }, [selected]);
  if (!selected || !model) return null;
  const group = groups?.find((each) => each.provider.id === model.providerId);
  const reads = group?.about[model.modelId]?.readsImages;
  const onThisComputer = group?.provider.service === null;
  return (
    <span
      data-testid="composer-picture"
      title={t("composer.picture.chip")}
      className="question-skill composer-quote"
    >
      <ImageLineIcon className="question-skill-icon" />
      <span className="truncate">
        {reads === false
          ? t("composer.picture.unreadableModel")
          : onThisComputer
            ? t("composer.picture.onThisComputer")
            : t("composer.picture.sends", { provider: service })}
      </span>
    </span>
  );
}

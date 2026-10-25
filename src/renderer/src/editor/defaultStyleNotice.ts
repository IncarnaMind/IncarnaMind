import { useEffect } from "react";
import type * as Y from "yjs";
import { MIND_SETTINGS_FIELD } from "../../../core/api";
import type { CitationStyleId } from "../../../shared/citationStyles";
import {
  defaultStyleNoticeShown,
  markDefaultStyleNoticeShown,
} from "../../../shared/mindCitationStyle";
import { styleLabel, useCitationStylePicker } from "../citationStylePicker";
import { core } from "../core";
import { useAppStore } from "../store";
import { type Undoable, useUndo } from "../undo";

function defaulted(
  mindId: string,
  style: CitationStyleId,
  folderDefault: CitationStyleId | null,
): Undoable {
  return {
    said: (t) => t("citationStyle.defaulted", { style: styleLabel(style, t) }),
    undo: async () => {
      await core.setMindCitationStyle(mindId, "numbered", { folderDefault });
    },
    redo: async () => {
      await core.setMindCitationStyle(mindId, null, { folderDefault });
    },
    also: {
      label: (t) => t("citationStyle.change"),
      testId: "undo-change-style",
      run: () =>
        useCitationStylePicker
          .getState()
          .show(
            mindId,
            document.querySelector<HTMLElement>(
              `article[data-mind-id="${CSS.escape(mindId)}"] [data-testid="references-style"]`,
            ),
          ),
    },
  };
}

/**
 * Says once, on the undo line, that a Mind took the Chinese default style because it cites a
 * paper: "此 Mind 引用了论文，引用格式已设为 GB/T 7714—2015（顺序编码制）· 更改 · 撤销". Change
 * opens the style picker; Undo makes Numbered the Mind's own choice, so the default never
 * applies to it again. That it was shown is kept in the Mind's settings, so no window shows it
 * twice, and the page itself shows nothing (DESIGN.md: the page shows only its text).
 */
export function useDefaultStyleNotice({
  mindId,
  doc,
  style,
  chosen,
  readOnly,
}: {
  mindId: string;
  doc: Y.Doc;
  style: CitationStyleId;
  chosen: CitationStyleId | null;
  readOnly: boolean;
}): void {
  useEffect(() => {
    if (readOnly || chosen !== null || style === "numbered") return;
    const settings = doc.getMap<unknown>(MIND_SETTINGS_FIELD);
    if (defaultStyleNoticeShown(settings)) return;
    doc.transact(() => markDefaultStyleNoticeShown(settings));
    core.getMindCitationStyle(mindId).then(({ folderDefault }) => {
      useUndo.getState().push(defaulted(mindId, style, folderDefault));
    }, useAppStore.getState().reportError);
  }, [mindId, doc, style, chosen, readOnly]);
}

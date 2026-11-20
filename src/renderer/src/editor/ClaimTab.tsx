import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useT } from "../i18n";
import { tabName } from "../noteTabs";
import { noteTabsOf, tabIndexAt } from "./noteTabs";

/** Which tab a check card's sentence is in, in a Note with more than one (#3414). */
export function ClaimTab({ editor, at }: { editor: Editor; at: number }) {
  const t = useT();
  const name = useEditorState({
    editor,
    selector: ({ editor: now }) => {
      const { tabs } = noteTabsOf(now.state);
      if (tabs.length < 2) return null;
      const index = tabIndexAt(tabs, at);
      const tab = tabs[index];
      return tab ? tabName(tab, index, t) : null;
    },
  });
  if (!name) return null;
  return (
    <p data-testid="claim-tab" className="citation-card-note">
      {t("noteTabs.inTab", { title: name })}
    </p>
  );
}

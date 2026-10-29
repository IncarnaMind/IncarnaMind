import { useEffect } from "react";
import { useT } from "../i18n";
import { folderName, folderWithNothingToRead } from "../linkedFolders";
import { ownsDocuments } from "../ownDocuments";
import { useRequests } from "../requests";
import { allExamples, useAppStore } from "../store";

/**
 * Where the folder just linked went, in the first open's Add your Documents step
 * (#763). The quiet first open keeps the sidebar's Folders away until the User's
 * first Document of their own, and a folder with nothing to read brings none, so
 * its row cannot show where the link is. The step says it was linked, that there is
 * nothing to read in it yet, and where it will appear.
 */
export function FirstOpenLinkedFolder() {
  const t = useT();
  const folder = useAppStore((state) =>
    folderWithNothingToRead(
      state.linkedFolders,
      new Set(
        allExamples(state).flatMap((each) => (each.linkedFolderId ? [each.linkedFolderId] : [])),
      ),
      ownsDocuments(state),
    ),
  );
  const asked = useRequests((state) => folder !== null && state.showLinked === folder.id);
  // The step shows where the folder is, so the row's own reveal must not come for it later,
  // when the first Document arrives and the sidebar's Folders appear.
  useEffect(() => {
    if (asked) useRequests.getState().clear("showLinked");
  }, [asked]);
  if (!folder) return null;
  return (
    <p
      role="status"
      data-testid="first-open-linked-folder"
      className="text-[13px] leading-5 text-ink-secondary"
    >
      {t("firstOpen.step.files.linked", {
        name: folderName(folder.path),
        section: t("library.sources"),
      })}
    </p>
  );
}

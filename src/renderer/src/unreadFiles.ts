import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { SearchScope, UnreadFile } from "../../core/api";
import { checkUnreadOf, observeCheckUnread } from "../../shared/unreadFiles";
import { core } from "./core";
import { shownClaims } from "./editor/claimChecks";
import { useAppStore } from "./store";

/**
 * The files in a Search scope that couldn't be read (#740): asked of the core,
 * and again when a Document's state or a Linked folder's list of files in a
 * format not read changes. Empty until it answers, and when everything was read.
 */
export function useUnreadFiles(scope: SearchScope | null): UnreadFile[] {
  const [files, setFiles] = useState<UnreadFile[]>([]);
  // A string that changes when what could be unread does, so a Document that is ready doesn't ask again.
  const state = useAppStore((store) =>
    [
      ...store.documents
        .filter(
          (each) =>
            each.status === "failed" || each.status === "no-text" || each.unreadParts !== null,
        )
        .map(
          (each) =>
            `${each.id}:${each.status}:${each.failure?.reason ?? ""}:${each.fileStatus}:${
              each.unreadParts ? JSON.stringify(each.unreadParts) : ""
            }`,
        ),
      ...store.linkedFolders.map((each) => `${each.id}:${each.unsupportedFiles}`),
      store.documents.length,
    ].join("|"),
  );
  const wanted = JSON.stringify(scope);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` is when to ask again.
  useEffect(() => {
    let current = true;
    core
      .listUnreadFiles(JSON.parse(wanted) as SearchScope | null)
      .then((found) => {
        if (current) setFiles(found);
      })
      .catch(() => {
        // Nothing to say when it can't be asked: no line is better than a wrong one.
        if (current) setFiles([]);
      });
    return () => {
      current = false;
    };
  }, [wanted, state]);
  return files;
}

/** What was unread when the checks the Mind's marks name started, not what is unread now. */
export function useCheckUnread(editor: Editor, doc: Y.Doc): UnreadFile[] {
  const requests = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      [...new Set(shownClaims(current.state).map((claim) => claim.check.request))]
        .filter((request) => request !== "")
        .sort()
        .join(" "),
  });
  const [files, setFiles] = useState<UnreadFile[]>([]);
  useEffect(() => {
    const read = () => setFiles(checkUnreadOf(doc, requests.split(" ")));
    read();
    return observeCheckUnread(doc, read);
  }, [doc, requests]);
  return files;
}

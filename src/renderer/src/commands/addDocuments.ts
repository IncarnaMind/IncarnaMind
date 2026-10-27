import { MENU_COMMANDS } from "../../../shared/commands";
import { addFilesLabel } from "../addFilesAction";
import { useAppStore } from "../store";
import { type Command, fromMenu } from "./registry";

const store = () => useAppStore.getState();

export const addDocumentCommands: readonly Command[] = [
  {
    ...fromMenu("documents.add"),
    shortcut: { keys: MENU_COMMANDS["documents.add"].keys, notInText: true },
    keywords: ["documents.add.keywords"],
    group: "main",
    reversible: true,
    run: () => store().pickDocuments(),
  },
  // The one way in on day one (#1942): files and a folder are the same question.
  {
    id: "documents.addFilesOrFolder",
    // What this computer's dialog does: files and a folder on macOS, files elsewhere (#1942).
    label: (_ctx, t) => t(addFilesLabel()),
    keywords: ["documents.add.keywords"],
    group: "main",
    reversible: true,
    run: () => store().pickDocumentsOrFolder(),
  },
  {
    ...fromMenu("linkedFolder.add"),
    keywords: ["documents.add.linkFolder.keywords"],
    group: "main",
    reversible: true,
    run: () => store().addLinkedFolder(),
  },
];

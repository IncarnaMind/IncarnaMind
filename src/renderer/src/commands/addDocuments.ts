import { MENU_COMMANDS } from "../../../shared/commands";
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
    label: "documents.add.filesOrFolder",
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

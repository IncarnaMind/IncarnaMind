/**
 * A Document added into a Folder: the core tells the window its Folder before the Document
 * itself, so the window never shows it under Not in a Folder on the way (#1741). With Tagging on
 * in the Folder and with it stopped there, and a Document added outside any Folder as the
 * contrast. Through the core's public interface.
 */
import { expect, test } from "vitest";
import { createTempDataFolder, startCore } from "../helpers/core";
import { writeSourceFile } from "../helpers/documents";

for (const stopped of [false, true]) {
  test(`a Document added into a Folder${stopped ? " where Tagging is stopped" : ""} has its Folder told before the Document`, async () => {
    const core = startCore(await createTempDataFolder());
    try {
      const sources = await createTempDataFolder();
      const folder = await core.createLibraryGroup({ name: "Harbour project", description: "" });
      if (stopped) await core.setTaggingWithAi(folder.id, false);
      const heard: string[] = [];
      core.on("library.assignments", (list) => {
        for (const each of list)
          heard.push(`Folder ${each.groupId === folder.id ? "Harbour" : each.groupId}`);
      });
      core.on("document.status", (document) =>
        heard.push(`Document ${document.id}: ${document.status}`),
      );
      core.on("documents.tagged", () => heard.push("Document tagged"));

      const filed = await writeSourceFile(sources, "Supply contract.md", "Supply contract.\n");
      const first = await core.addDocuments([filed], { groupId: folder.id });
      const filedId = first.documents[0]?.id;
      if (!filedId) throw new Error("The first Document wasn't added.");
      expect(heard[0]).toBe("Folder Harbour");
      expect(heard).toContain(`Document ${filedId}: queued`);

      // The first Document's own processing can still report after this: only the second one's
      // events say what this add did (#2714).
      heard.length = 0;
      const loose = await writeSourceFile(sources, "Draft brief.md", "Draft brief.\n");
      const second = await core.addDocuments([loose]);
      const looseId = second.documents[0]?.id;
      if (!looseId) throw new Error("The second Document wasn't added.");
      expect(heard.filter((each) => each.startsWith(`Document ${looseId}:`))[0]).toBe(
        `Document ${looseId}: queued`,
      );
    } finally {
      await core.close();
    }
  });
}

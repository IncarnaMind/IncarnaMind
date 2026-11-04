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
      core.on("document.status", (document) => heard.push(`Document ${document.status}`));
      core.on("documents.tagged", () => heard.push("Document tagged"));

      const filed = await writeSourceFile(sources, "Supply contract.md", "Supply contract.\n");
      await core.addDocuments([filed], { groupId: folder.id });
      expect(heard[0]).toBe("Folder Harbour");
      expect(heard).toContain("Document queued");

      heard.length = 0;
      const loose = await writeSourceFile(sources, "Draft brief.md", "Draft brief.\n");
      await core.addDocuments([loose]);
      expect(heard[0]).toBe("Document queued");
    } finally {
      await core.close();
    }
  });
}

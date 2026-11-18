import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { setUpWithDocuments } from "../helpers/citations";
import { scriptedModel } from "../helpers/models";

/*
 * A Citation chosen in a Document's viewer is refused where the Note may not cite that Document:
 * from outside the Folder wall it is behind, or while it is in Recently deleted.
 */

const LINE = "Rent is 1250 dollars monthly.";

/** A Note, beside a Document that holds `LINE`. */
async function noteBeside() {
  const model = scriptedModel(() => ({ text: "" }), { generate: () => ({ text: "" }) });
  const { core, mind, documents } = await setUpWithDocuments(model, [
    { name: "Rent.md", contents: `# Rent\n\n${LINE}` },
  ]);
  const [rent] = documents;
  if (!rent) throw new Error("The Document wasn't added.");
  return { core, mindId: mind.id, documentId: rent.id };
}

/** Files the Document in a Folder that keeps its work inside it, which the Note is outside. */
async function wallOff(core: Core, documentId: string): Promise<string> {
  const folder = await core.createLibraryGroup({ name: "Client A", description: "" });
  await core.assignDocumentGroup(documentId, folder.id);
  await core.updateLibraryGroup(folder.id, { name: "Client A", description: "", keepInside: true });
  return folder.id;
}

describe("A Citation chosen in a Document's viewer", () => {
  test("is refused for a Note outside the Folder wall the Document is behind", async () => {
    const { core, mindId, documentId } = await noteBeside();
    const parts = [{ unit: null, text: LINE }];
    expect(await core.citeSelection({ documentId, parts, mindId })).toMatchObject({
      quote: LINE,
    });
    const folderId = await wallOff(core, documentId);
    await expect(core.citeSelection({ documentId, parts, mindId })).rejects.toThrow(
      "This Folder keeps its work inside it.",
    );
    // Inside the wall, the same words are cited.
    const inside = await core.createMind({ title: "Client A note", folderId });
    expect(await core.citeSelection({ documentId, parts, mindId: inside.id })).toMatchObject({
      quote: LINE,
    });
  });

  test("is refused while its Document is in Recently deleted, behind a wall or not", async () => {
    const { core, mindId, documentId } = await noteBeside();
    const parts = [{ unit: null, text: LINE }];
    await core.deleteDocument(documentId);
    await expect(core.citeSelection({ documentId, parts, mindId })).rejects.toThrow(
      "That Document no longer exists.",
    );
    await core.restore([{ kind: "document", id: documentId }]);
    expect(await core.citeSelection({ documentId, parts, mindId })).toMatchObject({ quote: LINE });
    await wallOff(core, documentId);
    await core.deleteDocument(documentId);
    await expect(core.citeSelection({ documentId, parts, mindId })).rejects.toThrow(
      "That Document no longer exists.",
    );
  });
});

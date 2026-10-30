import { expect, test } from "vitest";
import type { ScopeLibrary } from "../../src/renderer/src/scope";
import { sourceFacetChoices } from "../../src/renderer/src/sourceFacets";
import { pendingPart } from "../../src/shared/claimParts";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModel } from "../helpers/models";

test.each([
  { name: "Residents", text: "According to Residents, Nora lives in Oslo." },
  { name: "居民记录", text: "据居民记录，诺拉住在奥斯陆。" },
])(
  "source choices validate the live Library without interpreting reason prose: $name",
  async ({ name, text }) => {
    const { core } = await setUpWithDocuments(
      scriptedModel(() => ({ text: "unused" })),
      [],
    );
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    const folders = await Promise.all([createTempDataFolder(), createTempDataFolder()]);
    const paths = await Promise.all(
      folders.map((folder, index) =>
        writeSourceFile(
          folder,
          `${name}.md`,
          "# " +
            name +
            "\n\n" +
            (index === 0 ? "March 2024" : "June 2025") +
            ": Nora lives in Oslo.\n",
        ),
      ),
    );
    const documents = await addAndProcess(core, paths);
    const [first, second] = documents;
    if (!first || !second) throw new Error("The two same-name Sources were not imported.");
    expect(first.name).toBe(name);
    expect(second.name).toBe(name);
    const start = text.indexOf(name);
    const citationId = crypto.randomUUID();
    const part = {
      ...pendingPart({
        kind: "fact",
        span: { start: 0, end: start + name.length },
        facet: {
          kind: "source",
          named: { start, end: start + name.length },
          candidates: [{ documentId: first.id, citationId }, { documentId: second.id }],
        },
      }),
      evidence: [
        {
          id: citationId,
          documentId: first.id,
          documentName: first.name,
          contentHash: first.contentHash,
          passageId: null,
          pageFrom: null,
          pageTo: null,
          location: null,
          quote: "As at March 2024, Nora lives in Oslo.",
          check: "found" as const,
          checkReason: null,
        },
      ],
    };
    const library: ScopeLibrary = { documents, folders: [], tags: [], groups: [], assignments: [] };
    const check = { text, scope: { folderId: null, widened: false }, excluded: [] };
    const choices = sourceFacetChoices(check, part, library, null);
    expect(choices?.name).toBe(name);
    expect(choices?.choices.map((each) => each.document.id)).toEqual([first.id, second.id]);
    expect(choices?.choices[0]?.citation?.id).toBe(citationId);
    expect(choices?.choices[1]).toMatchObject({ citation: null, needsRecheck: false });

    const narrowed = sourceFacetChoices(
      {
        ...check,
        scope: {
          ...check.scope,
          chosen: {
            folderIds: [],
            tagIds: [],
            documentIds: [first.id],
          },
        },
      },
      part,
      library,
      null,
    );
    expect(narrowed?.choices.map((each) => each.document.id)).toEqual([first.id]);
    const newer = sourceFacetChoices(
      check,
      part,
      {
        ...library,
        documents: documents.map((each) =>
          each.id === first.id ? { ...each, contentHash: "new-version" } : each,
        ),
      },
      null,
    );
    expect(newer?.choices[0]).toMatchObject({ citation: null, needsRecheck: true });
    const renamed = await core.renameDocument(first.id, `${name} revised`);
    const afterRename = { ...library, documents: [renamed, second] };
    expect(
      sourceFacetChoices(check, part, afterRename, null)?.choices.map((each) => each.document.id),
    ).toEqual([second.id]);
    await core.deleteDocument(second.id);
    expect(
      sourceFacetChoices(check, part, { ...library, documents: await core.listDocuments() }, null)
        ?.choices,
    ).toEqual([]);
    expect(
      sourceFacetChoices(check, { ...part, facet: { kind: "source" } }, library, null),
    ).toBeNull();
  },
);

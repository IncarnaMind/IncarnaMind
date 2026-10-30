import { expect, test } from "vitest";
import type { ClaimCheckBasis, ClaimCheckPart, Document } from "../../src/core/api";
import { pendingPart } from "../../src/shared/claimParts";
import {
  type SourceFacetLibrary,
  sourceChoiceProblem,
  sourceFacetChoices,
} from "../../src/shared/sourceFacets";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModel } from "../helpers/models";

const CASES = [
  {
    language: "en",
    name: "Report",
    prefix: "According to Report",
    text: "According to Report, Nora lives in Oslo.",
    revised: "Other register",
    folder: "Client records",
  },
  {
    language: "zh-CN",
    name: "报告",
    prefix: "据报告",
    text: "据报告，诺拉住在奥斯陆。",
    revised: "其他登记册",
    folder: "客户档案",
  },
] as const;

type SourceCheck = Pick<ClaimCheckBasis, "text" | "scope" | "excluded" | "parts">;

test.each(CASES)(
  "$language selected Source standing follows live identity and eligibility",
  async (row) => {
    const { core } = await setUpWithDocuments(
      scriptedModel(() => ({ text: "unused" })),
      [],
    );
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    const paths = [];
    for (const contents of ["Nora lives in Oslo.", "Nora lives in Oslo. The branch is open."]) {
      const folder = await createTempDataFolder();
      paths.push(await writeSourceFile(folder, `${row.name}.md`, contents));
    }
    const documents = await addAndProcess(core, paths);
    const [first, second] = documents;
    if (!first || !second) throw new Error("Both actual same-name Documents are required.");
    const group = await core.createLibraryGroup({ name: row.folder, description: "" });
    await core.assignDocumentGroup(first.id, group.id);
    const snapshot = await core.getLibrary();
    const library: SourceFacetLibrary = {
      documents,
      folders: [],
      tags: [],
      groups: snapshot.groups,
      assignments: snapshot.assignments,
    };
    const start = row.text.indexOf(row.name);
    const part = pendingPart({
      kind: "fact",
      span: { start: 0, end: row.prefix.length },
      facet: {
        kind: "source",
        selectedDocumentId: first.id,
        named: { start, end: start + row.name.length },
        candidates: [{ documentId: first.id }, { documentId: second.id }],
      },
    });
    const check: SourceCheck = {
      text: row.text,
      scope: { folderId: null, widened: false },
      excluded: [],
      parts: [part],
    };
    const withFirst = (changes: Partial<Document>): SourceFacetLibrary => ({
      ...library,
      documents: documents.map((document) =>
        document.id === first.id ? { ...document, ...changes } : document,
      ),
    });
    const wall: SourceFacetLibrary = {
      ...library,
      groups: snapshot.groups.map((each) =>
        each.id === group.id ? { ...each, keepInside: true } : each,
      ),
    };
    const narrowed: SourceCheck = {
      ...check,
      scope: {
        ...check.scope,
        chosen: { folderIds: [], tagIds: [], documentIds: [second.id] },
      },
    };
    const missing = { ...library, documents: [second] };
    const renamed = withFirst({ name: row.revised, title: row.name });
    expect(sourceChoiceProblem(check, library, null)).toBeNull();
    expect(
      sourceFacetChoices(check, part, library, null)?.choices.map((each) => each.document.id),
    ).toEqual([first.id, second.id]);
    expect(sourceChoiceProblem(check, withFirst({ contentHash: "next-version" }), null)).toBeNull();
    expect(
      sourceChoiceProblem(
        check,
        withFirst({
          name: row.language === "en" ? "ＲＥＰＯＲＴ" : "报　告",
        }),
        null,
      ),
    ).toBeNull();
    expect(sourceChoiceProblem(check, renamed, null)).toEqual({
      kind: "renamed",
      name: row.name,
      currentName: row.revised,
    });
    expect(
      sourceFacetChoices(check, part, renamed, null)?.choices.map((each) => each.document.id),
    ).toEqual([second.id]);
    expect(sourceChoiceProblem(check, missing, null)).toEqual({ kind: "deleted", name: row.name });
    expect(sourceChoiceProblem(check, wall, null)).toEqual({
      kind: "walled",
      name: row.name,
      folder: row.folder,
    });
    expect(sourceChoiceProblem(check, wall, group.id)).toBeNull();
    expect(
      sourceFacetChoices(check, part, wall, null)?.choices.map((each) => each.document.id),
    ).toEqual([second.id]);
    expect(
      sourceFacetChoices(check, part, wall, group.id)?.choices.map((each) => each.document.id),
    ).toEqual([first.id]);
    expect(
      sourceFacetChoices(
        {
          ...check,
          scope: {
            ...check.scope,
            chosen: { folderIds: [group.id], tagIds: [], documentIds: [] },
          },
        },
        part,
        wall,
        null,
      )?.choices,
    ).toEqual([]);
    expect(sourceChoiceProblem(narrowed, library, null)).toEqual({
      kind: "out-of-scope",
      name: row.name,
    });
    expect(sourceChoiceProblem(narrowed, wall, null)).toEqual({
      kind: "walled",
      name: row.name,
      folder: row.folder,
    });
    expect(sourceChoiceProblem(check, withFirst({ notCited: true }), null)).toEqual({
      kind: "out-of-scope",
      name: row.name,
    });
    expect(
      sourceChoiceProblem(
        {
          ...check,
          excluded: [{ documentId: first.id, documentName: row.name, reason: "own-workings" }],
        },
        library,
        null,
      ),
    ).toEqual({ kind: "out-of-scope", name: row.name });
    expect(sourceChoiceProblem(check, { ...library, documents: [first] }, null)).toBeNull();
    expect(
      sourceChoiceProblem(
        check,
        {
          ...library,
          documents: [first, { ...second, name: row.revised }],
        },
        null,
      ),
    ).toBeNull();
    expect(sourceChoiceProblem({ ...check, parts: undefined }, null, null)).toBeNull();
    expect(
      sourceChoiceProblem(
        {
          ...check,
          parts: [pendingPart({ kind: "fact", span: { start: 0, end: row.text.length } })],
        },
        null,
        null,
      ),
    ).toBeNull();
    expect(sourceChoiceProblem(check, null, null)).toEqual({ kind: "unavailable" });
    expect(sourceChoiceProblem(check, { ...library, groups: undefined }, null)).toEqual({
      kind: "unavailable",
    });
    expect(sourceChoiceProblem(check, { ...library, assignments: undefined }, null)).toEqual({
      kind: "unavailable",
    });
    for (const named of [
      undefined,
      { start: -1, end: start + 1 },
      { start, end: row.text.length + 1 },
      { start: start + 0.5, end: start + row.name.length },
    ]) {
      const invalid: ClaimCheckPart = {
        ...part,
        facet: { kind: "source", selectedDocumentId: first.id, ...(named && { named }) },
      };
      expect(sourceChoiceProblem({ ...check, parts: [invalid] }, library, null)).toEqual({
        kind: "unavailable",
      });
    }
    const twice = `${row.text} ${row.text}`;
    const secondAt = row.text.length + 1;
    const other = pendingPart({
      kind: "fact",
      span: { start: secondAt, end: secondAt + row.prefix.length },
      facet: {
        kind: "source",
        selectedDocumentId: second.id,
        named: { start: secondAt + start, end: secondAt + start + row.name.length },
      },
    });
    const both: SourceCheck = { ...check, text: twice, parts: [part, other] };
    expect(
      sourceChoiceProblem(
        both,
        { ...renamed, documents: renamed.documents.filter((each) => each.id !== second.id) },
        null,
      ),
    ).toEqual({ kind: "deleted", name: row.name });
    expect(
      sourceChoiceProblem(
        both,
        {
          ...wall,
          documents: wall.documents.map((each) =>
            each.id === second.id ? { ...each, name: row.revised } : each,
          ),
        },
        null,
      ),
    ).toEqual({ kind: "walled", name: row.name, folder: row.folder });
    expect(
      sourceChoiceProblem(
        { ...both, scope: narrowed.scope },
        {
          ...library,
          documents: [first, { ...second, name: row.revised }],
        },
        null,
      ),
    ).toEqual({ kind: "out-of-scope", name: row.name });
    expect(sourceChoiceProblem(both, { ...wall, documents: [first] }, null)).toEqual({
      kind: "deleted",
      name: row.name,
    });
  },
);

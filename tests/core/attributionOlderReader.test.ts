import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { markedSentences, markSentence } from "../../src/core/answers/checks/sentences";
import {
  type Citation,
  type ClaimCheckAttributes,
  type ClaimCheckResult,
  type ClaimFacet,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
} from "../../src/core/api";
import { checkWithParts, partWithResult } from "../../src/shared/claimParts";
import { namePartCitations } from "../../src/shared/signOffs";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

const CASES = [
  {
    language: "en",
    sourceName: "Residents.md",
    quote: "Nora lives in Oslo. The statement covers the year 2026.",
    sentences: [
      ["According to Residents", ", Nora lives in Oslo."],
      ["Nora said", " she lives in Oslo."],
      ["Currently", ", Nora lives in Oslo."],
    ],
  },
  {
    language: "zh-CN",
    sourceName: "居民记录.md",
    quote: "诺拉住在奥斯陆。这项记录的期间为2026年。",
    sentences: [
      ["据居民记录", "，诺拉住在奥斯陆。"],
      ["诺拉说", "她住在奥斯陆。"],
      ["目前", "，诺拉住在奥斯陆。"],
    ],
  },
] as const;

function storedRows(dataDir: string, mindId: string) {
  return queryDatabase<{
    id: string;
    mind_id: string;
    data: Uint8Array;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
  }>(
    dataDir,
    "SELECT id, mind_id, data, created_at, updated_at, deleted_at FROM mind_updates WHERE mind_id = ? ORDER BY rowid",
    [mindId],
  ).map((row) => ({ ...row, data: Array.from(row.data) }));
}

function readState(state: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

function checkFor(text: string, prefix: string, facet: ClaimFacet, source: Citation) {
  const result: ClaimCheckResult = {
    verdict: "supported",
    evidence: source,
    says: source.quote,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    versions: [{ documentId: source.documentId, contentHash: source.contentHash }],
    excluded: [],
  };
  const basis: ClaimCheckAttributes = {
    id: randomUUID(),
    request: randomUUID(),
    action: "check-against-documents",
    state: "supported",
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-30T12:00:00.000Z",
  };
  return checkWithParts(
    basis,
    namePartCitations([
      partWithResult({ kind: "fact", span: { start: 0, end: prefix.length }, facet }, result),
      partWithResult({ kind: "fact", span: { start: prefix.length, end: text.length } }, result),
    ]),
  );
}

afterEach(() => {
  vi.doUnmock("../../src/core/api");
  vi.resetModules();
});

describe("an older reader preserves attribution facets", () => {
  test.each(CASES)("$language refuses the edit and preserves current Note bytes", async (row) => {
    const dataDir = await createTempDataFolder();
    const current = startCore(dataDir);
    const path = await writeSourceFile(await createTempDataFolder(), row.sourceName, row.quote);
    const [document] = await addAndProcess(current, [path]);
    if (!document?.contentHash) throw new Error("The attribution Source was not processed.");
    const source: Citation = {
      passageId: randomUUID(),
      documentId: document.id,
      documentName: document.name,
      contentHash: document.contentHash,
      pageFrom: 1,
      pageTo: 1,
      location: { kind: "section", heading: null },
      quote: row.quote,
      check: "found",
      checkReason: null,
    };
    const facets: ClaimFacet[] = [
      { kind: "source", selectedDocumentId: document.id },
      { kind: "speaker" },
      {
        kind: "time",
        period: { start: "2026-01-01", end: "2026-12-31", precision: "year" },
      },
    ];
    const written = new Y.Doc();
    const expected = row.sentences.map(([prefix, rest], index) => {
      const facet = facets[index];
      if (!facet) throw new Error("The fixture has no facet for its sentence.");
      const text = prefix + rest;
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.setAttribute("id", randomUUID());
      paragraph.push([new Y.XmlText(text)]);
      written.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
      const check = checkFor(text, prefix, facet, source);
      markSentence(paragraph, 0, text.length, check);
      return check;
    });
    const mind = await current.createMind({ title: row.sourceName });
    await current.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(written));
    const openedCurrent = await current.openMind(mind.id);
    expect(openedCurrent.access).toBe("edit");
    const currentDoc = readState(openedCurrent.state);
    expect(currentDoc.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)).toBe(
      CONTENT_SCHEMA_VERSION,
    );
    expect(
      markedSentences(currentDoc.getXmlFragment(MIND_CONTENT_FIELD)).map(({ check }) => check),
    ).toEqual(expected);
    const receiptIds = expected.flatMap(
      (check) => check.parts?.flatMap((part) => part.evidence.map((citation) => citation.id)) ?? [],
    );
    expect(receiptIds).toHaveLength(6);
    expect(new Set(receiptIds).size).toBe(6);
    expect(receiptIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    await current.closeMind(mind.id);
    await current.close();
    const before = storedRows(dataDir, mind.id);
    expect(before).not.toHaveLength(0);

    vi.resetModules();
    vi.doMock("../../src/core/api", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/core/api")>();
      return { ...actual, CONTENT_SCHEMA_VERSION: actual.CONTENT_SCHEMA_VERSION - 1 };
    });
    const olderApi = await import("../../src/core");
    const { startCore: startOlder } = await import("../helpers/core");
    expect(olderApi.CONTENT_SCHEMA_VERSION).toBe(CONTENT_SCHEMA_VERSION - 1);
    const older = startOlder(dataDir);
    const opened = await older.openMind(mind.id);
    expect(opened.access).toBe("read-only");
    expect(opened.state).toEqual(openedCurrent.state);
    const theirs = readState(opened.state);
    const changes: Uint8Array[] = [];
    theirs.on("update", (update: Uint8Array) => changes.push(update));
    theirs.transact(() => {
      for (const { element, from, to, check } of markedSentences(
        theirs.getXmlFragment(MIND_CONTENT_FIELD),
      )) {
        const parts = check.parts?.map(({ facet: _facet, ...part }) => part);
        markSentence(element, from, to, { ...check, parts });
      }
    });
    expect(changes).toHaveLength(1);
    expect(
      markedSentences(theirs.getXmlFragment(MIND_CONTENT_FIELD)).every(({ check }) =>
        check.parts?.every((part) => part.facet === undefined),
      ),
    ).toBe(true);
    const [update] = changes;
    if (!update) throw new Error("The older mark rewrite produced no Yjs update.");
    await expect(older.applyMindUpdate(mind.id, update)).rejects.toThrow(
      olderApi.MindReadOnlyError,
    );
    await older.closeMind(mind.id);
    await older.close();
    expect(storedRows(dataDir, mind.id)).toEqual(before);
    const olderAgain = startOlder(dataDir);
    expect(await olderAgain.openMind(mind.id)).toMatchObject({
      access: "read-only",
      state: opened.state,
    });
    await olderAgain.closeMind(mind.id);
    await olderAgain.close();
    expect(storedRows(dataDir, mind.id)).toEqual(before);

    vi.doUnmock("../../src/core/api");
    vi.resetModules();
    const currentApi = await import("../../src/core");
    const { startCore: startCurrent } = await import("../helpers/core");
    expect(currentApi.CONTENT_SCHEMA_VERSION).toBe(CONTENT_SCHEMA_VERSION);
    const reopened = startCurrent(dataDir);
    const currentState = await reopened.openMind(mind.id);
    expect(currentState.access).toBe("edit");
    const restored = readState(currentState.state);
    expect(
      markedSentences(restored.getXmlFragment(MIND_CONTENT_FIELD)).map(({ check }) => check),
    ).toEqual(expected);
  });
});

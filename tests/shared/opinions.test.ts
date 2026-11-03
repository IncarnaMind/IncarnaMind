import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { OpinionSentence } from "../../src/core/api";
import { pendingPart } from "../../src/shared/claimParts";
import {
  omittedOpinions,
  readOpinionSentences,
  resolveOpinions,
  writeOpinionSentences,
} from "../../src/shared/opinions";

const entry = (
  text = "We should wait.",
  occurrence = 0,
  id = `opinion-${occurrence}`,
): OpinionSentence => ({
  id,
  blockId: "block",
  text,
  occurrence,
  parts: [pendingPart({ kind: "opinion", span: { start: 0, end: text.length } })],
});

describe("unmarked opinion inventory", () => {
  test("equal normalized inventory emits no extra Yjs update", () => {
    const doc = new Y.Doc();
    let updates = 0;
    doc.on("update", () => updates++);
    try {
      writeOpinionSentences(doc, []);
      expect(updates).toBe(0);
      writeOpinionSentences(doc, [entry()]);
      expect(updates).toBe(1);
      writeOpinionSentences(doc, [{ ...entry(), position: 99 }]);
      expect(updates).toBe(1);
      expect(readOpinionSentences(doc)).toEqual([entry()]);
    } finally {
      doc.destroy();
    }
  });
  test.each(["We should wait.", "我们应该等待。"])(
    "Yjs save/reload keeps %s without a mark",
    (text) => {
      const doc = new Y.Doc();
      const reopened = new Y.Doc();
      try {
        writeOpinionSentences(doc, [entry(text)]);
        Y.applyUpdate(reopened, Y.encodeStateAsUpdate(doc));
        expect(readOpinionSentences(reopened)).toEqual([entry(text)]);
        expect(reopened.getXmlFragment("blocks").length).toBe(0);
      } finally {
        doc.destroy();
        reopened.destroy();
      }
    },
  );

  test("duplicate words are identified by occurrence, not a hash", () => {
    const stored = [entry(), entry("We should wait.", 1)];
    const current = stored.map(({ blockId, text, occurrence }, index) => ({
      blockId,
      text,
      occurrence,
      position: 10 + index * 20,
    }));
    expect(resolveOpinions(current, stored).map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "opinion-0", position: 10 },
      { id: "opinion-1", position: 30 },
    ]);
  });

  test("unrelated prefix edits use current positions while preserving entry id", () => {
    const stored = entry();
    expect(resolveOpinions([{ ...stored, position: 99 }], [stored])[0]).toMatchObject({
      id: stored.id,
      position: 99,
    });
  });

  test("changed text, deleted occurrence and another Block cannot select stale words", () => {
    const stored = entry();
    expect(resolveOpinions([{ ...stored, text: "We should act." }], [stored])).toEqual([]);
    expect(resolveOpinions([{ ...stored, occurrence: 1 }], [stored])).toEqual([]);
    expect(resolveOpinions([{ ...stored, blockId: "another" }], [stored])).toEqual([]);
    expect(resolveOpinions([], [stored])).toEqual([]);
  });

  test("explicit Yjs Undo restores the same stable entry", () => {
    const doc = new Y.Doc();
    const owner = {};
    const undo = new Y.UndoManager(doc.getMap("settings"), { trackedOrigins: new Set([owner]) });
    try {
      doc.transact(() => writeOpinionSentences(doc, [entry()]), owner);
      undo.stopCapturing();
      doc.transact(() => writeOpinionSentences(doc, []), owner);
      undo.undo();
      expect(readOpinionSentences(doc)).toEqual([entry()]);
    } finally {
      undo.destroy();
      doc.destroy();
    }
  });

  test("unmarked storage rejects factual, checked and duplicate entries", () => {
    const doc = new Y.Doc();
    try {
      expect(() =>
        writeOpinionSentences(doc, [
          { ...entry(), parts: [pendingPart({ kind: "fact", span: { start: 0, end: 4 } })] },
        ]),
      ).toThrow();
      expect(() => writeOpinionSentences(doc, [entry(), entry()])).toThrow();
    } finally {
      doc.destroy();
    }
  });
});

describe("one combined omitted-opinion reader", () => {
  test("mixed mark opinions and unmarked sentences count once in Note order", () => {
    const text = "Revenue rose. We should wait.";
    const mark = {
      id: "mark",
      blockId: "mixed",
      text,
      occurrence: 0,
      parts: [
        pendingPart({ kind: "fact", span: { start: 0, end: 13 } }),
        pendingPart({ kind: "opinion", span: { start: 14, end: text.length } }),
      ],
    };
    const pure = entry();
    const current = [
      { blockId: mark.blockId, text, occurrence: 0, position: 1 },
      { blockId: pure.blockId, text: pure.text, occurrence: 0, position: 100 },
    ];
    const omitted = omittedOpinions(current, [mark], [pure]);
    expect(omitted.map(({ id, span, position }) => ({ id, span, position }))).toEqual([
      { id: "mark", span: { start: 14, end: text.length }, position: 1 },
      { id: pure.id, span: pure.parts[0]?.span, position: 100 },
    ]);
  });

  test("a mark supersedes a stale side entry and checked opinions leave the omission count", () => {
    const pure = entry();
    const mark = {
      ...pure,
      id: "new-mark",
      parts: pure.parts.map((part) => ({ ...part, verdict: "unsupported" as const })),
    };
    expect(omittedOpinions([pure], [mark], [pure])).toEqual([]);
    expect(omittedOpinions([pure], [{ ...mark, parts: pure.parts }], [pure])).toHaveLength(1);
  });
});

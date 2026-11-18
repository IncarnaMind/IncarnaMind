/**
 * A text the figure reader gives up on is never read as one that holds no figures (#2510), and a
 * Note's other paragraphs are still read. No text makes the reader give up since it reads in one
 * pass, so this test makes it give up on any text that holds the word GARBLED, as it did on a
 * garbled table.
 */
import { expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { figuresInMind } from "../../src/core/answers/checks/figureOccurrences";

vi.mock(import("../../src/shared/figures"), async (importOriginal) => {
  const reader = await importOriginal();
  return {
    ...reader,
    readFigures: (text, context) => {
      if (text.includes("GARBLED"))
        throw new reader.FiguresNotRead(text, new RangeError("Maximum call stack size exceeded"));
      return reader.readFigures(text, context);
    },
  };
});

test("a Note's other paragraphs are still read when the reader gives up on one", () => {
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const blocks = doc.getXmlFragment("blocks");
  const paragraph = (id: string, text: string) =>
    createElement({ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] });
  blocks.insert(0, [
    paragraph("garbled", "The scan reads GARBLED 1,2.3,4.5,1,2.3,4.5,."),
    paragraph("revenue", "Revenue in 2024 was £20."),
  ]);
  expect(
    figuresInMind(blocks).map((figure) => [figure.reading.chars, figure.reading.value]),
  ).toEqual([["£20", 20]]);
});

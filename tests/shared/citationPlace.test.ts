import { describe, expect, test } from "vitest";
import { CITATION_NODE } from "../../src/core/api";
import type { NodeJSON } from "../../src/shared/blockJson";
import { citationBackstep, citationsBeforeTheStop } from "../../src/shared/citationPlace";
import { INLINE_NODE } from "../../src/shared/sentences";

const cite = (id: string): NodeJSON => ({ type: CITATION_NODE, attrs: { id } });
const text = (words: string, marks?: NodeJSON["marks"]): NodeJSON => ({
  type: "text",
  text: words,
  ...(marks && { marks }),
});

/** A Block's content as one line: each Citation as [id]. */
const read = (content: readonly NodeJSON[]) =>
  content
    .map((node) => (node.type === "text" ? node.text : `[${String(node.attrs?.id)}]`))
    .join("");

const place = (...content: NodeJSON[]) => read(citationsBeforeTheStop(content).content);

describe("how far back from the end of a sentence a Citation goes", () => {
  // protects=a new Citation of a sentence goes before its closing punctuation, after the Citations there, and before a Citation already after the stop rather than after it, in English and Chinese; fails_when=it goes after the stop, or after the Citation that stands after it.
  test.each([
    ["Revenue rose.", 1],
    ["Revenue rose. ", 2],
    [`Revenue rose ${INLINE_NODE}${INLINE_NODE}.`, 1],
    [`Revenue rose.${INLINE_NODE}${INLINE_NODE}`, 3],
    [`Revenue rose. ${INLINE_NODE}${INLINE_NODE}`, 4],
    [`He said “Revenue rose.”${INLINE_NODE}`, 3],
    ["Revenue rose", 0],
    ["收入增长了。", 1],
    [`收入增长了${INLINE_NODE}。`, 1],
    [`收入增长了。${INLINE_NODE}${INLINE_NODE}`, 3],
    [`收入增长了！ ${INLINE_NODE}`, 3],
  ] as const)("%j goes back %i", (words, back) => {
    expect(citationBackstep(words)).toBe(back);
  });

  // protects=an inline node that ends a sentence with no stop, or follows a colon, is the sentence's own word and a Citation goes after it; fails_when=a Citation goes before a figure or a footnote that ends a sentence.
  test.each([
    [`Revenue was ${INLINE_NODE}`, 0],
    [`Note: ${INLINE_NODE}`, 0],
    [`Revenue rose; ${INLINE_NODE}`, 0],
  ] as const)("%j goes back %i", (words, back) => {
    expect(citationBackstep(words)).toBe(back);
  });
});

describe("Citations after a sentence's stop", () => {
  // protects=a Citation an AI wrote after the stop stands before it, after those there, in English and Chinese, whatever spaces were around it; fails_when=it stays after the stop, or leaves a gap after it.
  test.each([
    [
      "with a space",
      [text("Revenue rose in May. "), cite("a"), text(" Costs fell.")],
      "Revenue rose in May[a]. Costs fell.",
    ],
    [
      "with none",
      [text("Revenue rose in May."), cite("a"), text(" Costs fell.")],
      "Revenue rose in May[a]. Costs fell.",
    ],
    [
      "after one before it",
      [text("Revenue rose in May "), cite("a"), text(". "), cite("b")],
      "Revenue rose in May [a][b].",
    ],
    [
      "two together",
      [text("Revenue rose in May. "), cite("a"), cite("b")],
      "Revenue rose in May[a][b].",
    ],
    [
      "two apart",
      [text("Revenue rose in May. "), cite("a"), text(" "), cite("b"), text(" Costs fell.")],
      "Revenue rose in May[a][b]. Costs fell.",
    ],
    [
      "in Chinese",
      [text("五月收入增长了。"), cite("a"), text("六月成本下降了。"), cite("b")],
      "五月收入增长了[a]。六月成本下降了[b]。",
    ],
    [
      "in Chinese, with spaces",
      [text("五月收入增长了。 "), cite("a"), cite("b")],
      "五月收入增长了[a][b]。",
    ],
    ["a question", [text("Did revenue rise? "), cite("a")], "Did revenue rise[a]?"],
    [
      "inside a quotation's end",
      [text("He said “revenue rose.” "), cite("a")],
      "He said “revenue rose[a].”",
    ],
  ] as const)("%s", (_name, content, written) => {
    expect(place(...content)).toBe(written);
  });

  // protects=a Citation inside the next sentence, the one that starts a paragraph, one across a line break, one after a colon, and one nothing says is new stay where they are; fails_when=a Citation that belongs to the next sentence, or one the User put there, is pulled back or moved.
  test.each([
    ["inside the next sentence", [text("Revenue rose. Then "), cite("a"), text(" costs fell.")]],
    ["at the start", [cite("a"), text(" Revenue rose.")]],
    ["across a line break", [text("Revenue rose."), { type: "hardBreak" }, cite("a")]],
    ["after a colon", [text("Note: "), cite("a")]],
    ["before the stop", [text("Revenue rose "), cite("a"), text(".")]],
    ["with no stop", [text("Revenue rose "), cite("a")]],
  ] as const)("%s", (_name, content) => {
    expect(citationsBeforeTheStop(content).content).toEqual(content);
  });

  // protects=only the Citations moves() names move, so one the Note already had after its stop stays; fails_when=a Citation that was in the Note is moved by a later write.
  test("a Citation `moves` doesn't name stays after the stop", () => {
    const content = [text("Revenue rose. "), cite("old"), text(" "), cite("new")];
    const { content: placed } = citationsBeforeTheStop(content, {
      moves: (node) => node.attrs?.id === "new",
    });
    expect(read(placed)).toBe("Revenue rose[new]. [old]");
  });

  // protects=a Citation that repeats one its sentence holds is dropped, and not one only the next sentence holds; fails_when=a Passage is cited twice in one sentence, or a repeat across sentences is dropped.
  test("a repeat is dropped", () => {
    const repeats = (a: NodeJSON, b: NodeJSON) => a.attrs?.id === b.attrs?.id;
    const same = citationsBeforeTheStop(
      [text("Revenue rose in May "), cite("a"), cite("b"), text(". "), cite("a"), cite("b")],
      { repeats },
    );
    expect(read(same.content)).toBe("Revenue rose in May [a][b].");
    expect(same.dropped.map((node) => node.attrs?.id)).toEqual(["a", "b"]);

    const next = citationsBeforeTheStop(
      [text("Revenue rose "), cite("a"), text(". Costs fell. "), cite("a")],
      { repeats },
    );
    expect(read(next.content)).toBe("Revenue rose [a]. Costs fell[a].");
    expect(next.dropped).toEqual([]);
  });

  // protects=the words around a moved Citation keep their marks, and a sentence of code is no sentence; fails_when=a mark is lost, or a stop inside code moves a Citation.
  test("marks are kept, code ends nothing", () => {
    const generated = [{ type: "generated" }];
    const { content } = citationsBeforeTheStop([
      text("Revenue rose", generated),
      text(". ", generated),
      cite("a"),
    ]);
    expect(content).toEqual([text("Revenue rose", generated), cite("a"), text(".", generated)]);

    const code = [text("x = 1.", [{ type: "code" }]), text(" "), cite("a")];
    expect(citationsBeforeTheStop(code).content).toEqual(code);
  });
});

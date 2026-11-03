import { expect, test } from "vitest";
import {
  inlineRange,
  inlineSpan,
  projectInlineText,
  sliceInlineText,
} from "../../src/shared/inlineText";
import { INLINE_NODE } from "../../src/shared/sentences";

test.each(["Revenue ", "收入"])(
  "maps the exact displayed quantity and skips only Citation metadata: %s",
  (text) => {
    const at = text.length;
    const projection = projectInlineText([
      { kind: "text", text, from: 100, to: 100 + at },
      { kind: "citation", from: 100 + at, to: 101 + at },
      { kind: "atom", shown: "25.0%", from: 101 + at, to: 102 + at },
      { kind: "break", from: 102 + at, to: 103 + at },
      { kind: "atom", from: 103 + at, to: 112 + at },
    ]);
    expect(projection.text).toBe(`${text}25.0%\n${INLINE_NODE}`);
    expect(projection.rawText).toBe(`${text}${INLINE_NODE}${INLINE_NODE}\n${INLINE_NODE}`);
    expect(inlineSpan(projection, at + 1, at + 2)).toEqual({ start: at, end: at + 5 });
    expect(inlineRange(projection, at, at + 5)).toEqual({ from: 101 + at, to: 102 + at });
    expect(inlineRange(projection, at + 6, at + 7)).toEqual({ from: 103 + at, to: 112 + at });
    expect(inlineSpan(projection, at, at + 1)).toBeNull();
  },
);

test("rejects boundaries inside a displayed atom or a surrogate, including after JSON serialization", () => {
  const projection = JSON.parse(
    JSON.stringify(
      projectInlineText([
        { kind: "text", text: "😀 ", from: 0, to: 3 },
        { kind: "atom", shown: "20.0", from: 3, to: 4 },
      ]),
    ),
  );
  expect(inlineRange(projection, 0, 2)).toEqual({ from: 0, to: 2 });
  expect(inlineRange(projection, 0, 1)).toBeNull();
  expect(inlineRange(projection, 1, 2)).toBeNull();
  expect(inlineRange(projection, 3, 7)).toEqual({ from: 3, to: 4 });
  expect(inlineRange(projection, 3, 5)).toBeNull();
  expect(inlineRange(projection, 4, 7)).toBeNull();
  expect(sliceInlineText(projection, 3, 5)).toBeNull();
  expect(inlineSpan(projection, 1, 2)).toBeNull();
});

test("repeated equal atoms retain separate raw positions through a sentence slice", () => {
  const full = projectInlineText([
    { kind: "text", text: "Before. ", from: 0, to: 8 },
    { kind: "atom", shown: "20", from: 8, to: 9 },
    { kind: "text", text: " + ", from: 9, to: 12 },
    { kind: "atom", shown: "20", from: 12, to: 13 },
    { kind: "text", text: ".", from: 13, to: 14 },
  ]);
  const sentence = sliceInlineText(full, 8, 16);
  expect(sentence?.text).toBe("20 + 20.");
  if (!sentence) throw new Error("Missing sentence projection");
  expect(inlineSpan(sentence, 8, 9)).toEqual({ start: 0, end: 2 });
  expect(inlineSpan(sentence, 12, 13)).toEqual({ start: 5, end: 7 });
  expect(inlineRange(sentence, 5, 7)).toEqual({ from: 12, to: 13 });
  expect(inlineSpan(sentence, 0, 1)).toBeNull();
});

test("a scalar split across marked text pieces still has no interior boundary", () => {
  const projection = projectInlineText([
    { kind: "text", text: "\ud83d", from: 0, to: 1 },
    { kind: "text", text: "\ude00", from: 1, to: 2 },
  ]);
  expect(projection.text).toBe("😀");
  expect(inlineRange(projection, 0, 2)).toEqual({ from: 0, to: 2 });
  expect(inlineRange(projection, 0, 1)).toBeNull();
});

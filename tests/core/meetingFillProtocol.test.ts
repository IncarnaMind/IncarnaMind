import { describe, expect, test } from "vitest";
import { partsOf } from "../../src/core/meetings/fillPrompt";
import type { NodeJSON } from "../../src/shared/blockJson";

const heading = (text: string, level = 3): NodeJSON => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});

const paragraph = (text: string): NodeJSON => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

describe("Meeting fill reply boundaries (#2306)", () => {
  test("CLAIMS · H1 starts its own part rather than extending Summary", () => {
    const overview = paragraph("The call reviewed the rollout.");
    const firstClaim = paragraph("The rollout starts in the second quarter.");
    const secondClaim = paragraph("The budget is approved for this year.");
    const answer = paragraph("Dana sends the contract on Friday.");

    expect(
      partsOf([
        heading("SUMMARY"),
        overview,
        heading("CLAIMS · H1"),
        firstClaim,
        secondClaim,
        heading("L2"),
        answer,
      ]),
    ).toEqual(
      new Map([
        ["SUMMARY", [overview]],
        ["CLAIMS H1", [firstClaim, secondClaim]],
        ["L2", [answer]],
      ]),
    );
  });

  test.each([
    { text: "Rollout background", level: 3 },
    { text: "发布背景", level: 3 },
    { text: "Action items", level: 3 },
    { text: "待办事项", level: 3 },
    { text: "Summary of decisions", level: 3 },
    { text: "摘要", level: 3 },
    { text: "A genuine nested subheading", level: 4 },
    { text: "CLAIMS H1 H2", level: 3 },
    { text: "ACTIONS H1 extra words", level: 3 },
    { text: "L1A", level: 3 },
    { text: "", level: 3 },
  ])("an unrecognized heading ends the previous part: $text", ({ text, level }) => {
    for (const previous of ["SUMMARY", "L1"]) {
      for (const count of [1, 2]) {
        const before = paragraph("Content before the boundary.");
        const after = paragraph("Content after the next machine marker.");
        const discarded = [
          paragraph("This must not extend the previous part."),
          paragraph("另一段也不属于上一部分。"),
        ].slice(0, count);

        expect(
          partsOf([
            heading(previous),
            before,
            heading(text, level),
            ...discarded,
            heading("L2"),
            after,
          ]),
        ).toEqual(
          new Map([
            [previous, [before]],
            ["L2", [after]],
          ]),
        );
      }
    }
  });

  test.each([
    ["ACTIONS H1", "ACTIONS H1"],
    ["ACTIONS (H1)", "ACTIONS H1"],
    ["H1 ACTIONS", "ACTIONS H1"],
    ["CLAIMS · H1", "CLAIMS H1"],
    ["H1 · CLAIMS", "CLAIMS H1"],
    ["SUMMARY [H4]", "SUMMARY H4"],
    ["H2: DECISIONS", "DECISIONS H2"],
    ["QUESTIONS：H8", "QUESTIONS H8"],
    ["ACTIONS — H1", "ACTIONS H1"],
    ["ACTIONS – H1", "ACTIONS H1"],
    ["ACTIONS-H1", "ACTIONS H1"],
    ["CLAIMS | H1", "CLAIMS H1"],
    ["CLAIMS/H1", "CLAIMS H1"],
    ["CLAIMS {H1}", "CLAIMS H1"],
    ["  **claims**  ·  `h1`:  ", "CLAIMS H1"],
    ["### ACTIONS\t(H1) ###", "ACTIONS H1"],
    ["L1: label", "L1"],
    ["l1：标题", "L1"],
  ])("normalizes machine syntax without merging adjacent groups: %s", (text, marker) => {
    for (const previous of ["SUMMARY", "L2"]) {
      for (const count of [1, 2]) {
        const before = paragraph("The previous group's content.");
        const content = [
          paragraph("The first distinct fact."),
          paragraph("第二条不同的事实。"),
        ].slice(0, count);
        const after = paragraph("The following group's content.");

        expect([
          ...partsOf([heading(previous), before, heading(text), ...content, heading("L4"), after]),
        ]).toEqual([
          [previous, [before]],
          [marker, content],
          ["L4", [after]],
        ]);
      }
    }
  });

  test.each([
    ["L99", "L99"],
    ["l99: unused line", "L99"],
    ["H99", "H99"],
    ["H99: unused heading", "H99"],
    ["H99 UNKNOWN", "H99"],
    ["H99 待办事项", "H99"],
  ])("keeps an unknown machine target separate for the caller to discard: %s", (text, marker) => {
    for (const previous of ["SUMMARY", "L1"]) {
      for (const count of [1, 2]) {
        const before = paragraph("Content before the unknown target.");
        const unknown = [
          paragraph("The first fact for the unknown target."),
          paragraph("未知标记下的另一条事实。"),
        ].slice(0, count);
        const after = paragraph("Content after the next machine marker.");

        expect([
          ...partsOf([heading(previous), before, heading(text), ...unknown, heading("L2"), after]),
        ]).toEqual([
          [previous, [before]],
          [marker, unknown],
          ["L2", [after]],
        ]);
      }
    }
  });

  test("keeps all five canonical sections separate and leaves out a preamble and empty parts", () => {
    const overview = paragraph("The call's purpose.");
    const decision = paragraph("The final choice.");
    const action = paragraph("A named commitment.");
    const question = paragraph("An unanswered question.");
    const claim = paragraph("A fact to check.");

    expect([
      ...partsOf([
        paragraph("A preamble that does not belong in the notes."),
        heading("L1"),
        heading("SUMMARY"),
        overview,
        heading("DECISIONS"),
        decision,
        heading("ACTIONS"),
        action,
        heading("QUESTIONS"),
        question,
        heading("CLAIMS"),
        claim,
        heading("H99"),
      ]),
    ]).toEqual([
      ["SUMMARY", [overview]],
      ["DECISIONS", [decision]],
      ["ACTIONS", [action]],
      ["QUESTIONS", [question]],
      ["CLAIMS", [claim]],
    ]);
    expect(partsOf([])).toEqual(new Map());
    expect(partsOf([heading("Unknown"), paragraph("No valid part.")])).toEqual(new Map());
  });

  test("repeated normalized markers append their content without borrowing intervening groups", () => {
    const first = paragraph("The first commitment.");
    const overview = paragraph("The overview.");
    const second = paragraph("另一项承诺。");

    expect([
      ...partsOf([
        heading("ACTIONS (H1)"),
        first,
        heading("Unrecognized"),
        paragraph("Do not append this to Actions."),
        heading("SUMMARY"),
        overview,
        heading("H1 ACTIONS"),
        second,
      ]),
    ]).toEqual([
      ["ACTIONS H1", [first, second]],
      ["SUMMARY", [overview]],
    ]);
  });

  test("machine-looking paragraph and code text are content, not boundary headings", () => {
    const ordinary = paragraph("CLAIMS · H1");
    const code: NodeJSON = {
      type: "codeBlock",
      content: [{ type: "text", text: "### ACTIONS (H1)" }],
    };

    expect(partsOf([heading("L1"), ordinary, code])).toEqual(new Map([["L1", [ordinary, code]]]));
  });
});

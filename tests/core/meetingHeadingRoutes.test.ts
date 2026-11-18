import { describe, expect, test } from "vitest";
import type { FillLine } from "../../src/core/meetings/fillPrompt";
import { headingRoutes, saysQuiet, unansweredLines } from "../../src/core/meetings/headingRoutes";

const oneHeading: readonly FillLine[] = [
  { marker: "H1", text: "通话后的工作", heading: true },
  { marker: "L1", text: "contract", heading: false },
];

const twoHeadings: readonly FillLine[] = [
  ...oneHeading,
  { marker: "H2", text: "Release planning", heading: true },
  { marker: "L2", text: "launch", heading: false },
];

const ordinaryLines: readonly FillLine[] = [
  { marker: "L1", text: "Action items", heading: false },
  { marker: "L2", text: "待办事项", heading: false },
];

const reply = (preamble: string, markers: readonly string[]) =>
  [preamble, ...markers.flatMap((marker) => [`### ${marker}`, "A cited section's content."])].join(
    "\n",
  );

describe("Meeting heading routes (#2306)", () => {
  test("metadata routes bare section markers and NONE leaves a grouping heading alone", () => {
    expect(
      headingRoutes(
        reply("HEADINGS: H1=ACTIONS H2=NONE", ["L1", "ACTIONS", "SUMMARY"]),
        ["L1", "ACTIONS", "SUMMARY"],
        twoHeadings,
      ),
    ).toEqual(new Map([["actions", "H1"]]));
  });

  test.each([
    "HEADINGS: H1=ACTIONS H2=NONE.",
    "HEADINGS：H1=ACTIONS H2=NONE。",
    "hEaDiNgS: h1=actions h2=none",
    "HEADINGS: H1=ACTIONS,H2=NONE",
    "HEADINGS: H1=ACTIONS, H2=NONE",
    "HEADINGS: H1=ACTIONS，H2=NONE",
    "HEADINGS: H1=ACTIONS | H2=NONE",
    "HEADINGS: `H1=ACTIONS` `H2=NONE`",
    "HEADINGS: `H1=ACTIONS H2=NONE`",
    "`HEADINGS: H1=ACTIONS H2=NONE`",
    "**HEADINGS:** H1=ACTIONS H2=NONE",
    "**HEADINGS**: H1=ACTIONS H2=NONE",
    "**HEADINGS: H1=ACTIONS H2=NONE**",
    "- HEADINGS: H1=ACTIONS H2=NONE",
    "HEADINGS: H1＝ACTIONS H2＝NONE",
    "HEADINGS: H1 = ACTIONS H2 = NONE",
    "HEADINGS: H1=ACTIONS\u3000H2=NONE",
    "HEADINGS: H1\u00a0=\u00a0ACTIONS H2=NONE",
    "- **hEaDiNgS：** `h1 ＝ actions` | `h2 = none`.",
  ])("preserves the exact assignments with harmless formatting: %s", (preamble) => {
    expect(headingRoutes(reply(preamble, ["ACTIONS"]), ["ACTIONS"], twoHeadings)).toEqual(
      new Map([["actions", "H1"]]),
    );
  });

  test("explicit section targets work without metadata when every heading is assigned", () => {
    expect(
      headingRoutes(
        reply("", ["ACTIONS H1", "DECISIONS H2"]),
        ["ACTIONS H1", "DECISIONS H2"],
        twoHeadings,
      ),
    ).toEqual(
      new Map([
        ["actions", "H1"],
        ["decisions", "H2"],
      ]),
    );
  });

  test("matching metadata and explicit section targets agree rather than conflict", () => {
    expect(
      headingRoutes(
        reply("HEADINGS: H1=ACTIONS H2=NONE", ["ACTIONS H1"]),
        ["ACTIONS H1"],
        twoHeadings,
      ),
    ).toEqual(new Map([["actions", "H1"]]));
  });

  test("metadata and explicit markers can together account for all actual headings", () => {
    expect(
      headingRoutes(reply("HEADINGS: H2=NONE", ["ACTIONS H1"]), ["ACTIONS H1"], twoHeadings),
    ).toEqual(new Map([["actions", "H1"]]));
  });

  test("formatted metadata and explicit targets can together account for all headings", () => {
    expect(
      headingRoutes(
        reply("- **Headings：** `H2 = NONE`.", ["ACTIONS H1"]),
        ["ACTIONS H1"],
        twoHeadings,
      ),
    ).toEqual(new Map([["actions", "H1"]]));
  });

  test("every heading may be a grouping heading while sections use their default places", () => {
    expect(
      headingRoutes(
        reply("HEADINGS: H1=NONE H2=NONE", ["ACTIONS", "SUMMARY"]),
        ["ACTIONS", "SUMMARY"],
        twoHeadings,
      ),
    ).toEqual(new Map());
  });

  test("addresses come from actual heading markers, not their numbering or vocabulary", () => {
    const lines: readonly FillLine[] = [
      { marker: "H3", text: "Summary", heading: true },
      { marker: "H9", text: "决定", heading: true },
    ];

    expect(
      headingRoutes(reply("HEADINGS: h9=none h3=actions", ["ACTIONS"]), ["ACTIONS"], lines),
    ).toEqual(new Map([["actions", "H3"]]));
  });

  test.each(["Call with Acme", "通话记录", "Action items", "待办事项"])(
    "never guesses a section or NONE from an unassigned heading: %s",
    (text) => {
      expect(
        headingRoutes(
          reply("", ["ACTIONS", "SUMMARY"]),
          ["ACTIONS", "SUMMARY"],
          [{ marker: "H1", text, heading: true }],
        ),
      ).toBeNull();
    },
  );

  test.each([
    {
      name: "bare sections with no assignments",
      preamble: "",
      markers: ["ACTIONS"],
      lines: oneHeading,
    },
    {
      name: "metadata omits an actual grouping heading",
      preamble: "HEADINGS: H1=ACTIONS",
      markers: ["ACTIONS"],
      lines: twoHeadings,
    },
    {
      name: "explicit targets omit an actual grouping heading",
      preamble: "",
      markers: ["ACTIONS H1"],
      lines: twoHeadings,
    },
    {
      name: "NONE does not account for a different unassigned heading",
      preamble: "HEADINGS: H2=NONE",
      markers: ["SUMMARY"],
      lines: twoHeadings,
    },
    {
      name: "duplicate identical assignments",
      preamble: "HEADINGS: H1=ACTIONS H1=ACTIONS",
      markers: ["ACTIONS"],
      lines: oneHeading,
    },
    {
      name: "duplicate conflicting assignments",
      preamble: "HEADINGS: H1=ACTIONS H1=DECISIONS",
      markers: ["ACTIONS"],
      lines: oneHeading,
    },
    {
      name: "duplicate NONE assignments",
      preamble: "HEADINGS: H1=NONE h1=none",
      markers: ["ACTIONS"],
      lines: oneHeading,
    },
    {
      name: "metadata assigns one section to multiple headings",
      preamble: "HEADINGS: H1=ACTIONS H2=ACTIONS",
      markers: ["ACTIONS"],
      lines: twoHeadings,
    },
    {
      name: "explicit targets assign one section to multiple headings",
      preamble: "",
      markers: ["ACTIONS H1", "ACTIONS H2"],
      lines: twoHeadings,
    },
    {
      name: "explicit targets assign one heading to multiple sections",
      preamble: "",
      markers: ["ACTIONS H1", "DECISIONS H1"],
      lines: oneHeading,
    },
    {
      name: "metadata contradicts an explicit section",
      preamble: "HEADINGS: H1=ACTIONS",
      markers: ["DECISIONS H1"],
      lines: oneHeading,
    },
    {
      name: "NONE contradicts an explicit section",
      preamble: "HEADINGS: H1=NONE",
      markers: ["ACTIONS H1"],
      lines: oneHeading,
    },
    {
      name: "metadata contradicts an explicit heading target",
      preamble: "HEADINGS: H1=ACTIONS H2=NONE",
      markers: ["ACTIONS H2"],
      lines: twoHeadings,
    },
    {
      name: "metadata refers to an unknown heading",
      preamble: "HEADINGS: H1=NONE H99=ACTIONS",
      markers: ["ACTIONS"],
      lines: oneHeading,
    },
    {
      name: "an explicit target is unknown when structural headings exist",
      preamble: "HEADINGS: H1=NONE",
      markers: ["ACTIONS H99"],
      lines: oneHeading,
    },
    {
      name: "an ordinary line is not a structural heading target",
      preamble: "HEADINGS: H1=NONE L1=ACTIONS",
      markers: ["ACTIONS"],
      lines: oneHeading,
    },
    {
      name: "duplicate identical HEADINGS lines",
      preamble: "HEADINGS: H1=ACTIONS\nHEADINGS: H1=ACTIONS",
      markers: ["ACTIONS"],
      lines: oneHeading,
    },
    {
      name: "duplicate conflicting HEADINGS lines",
      preamble: "HEADINGS: H1=ACTIONS\nHEADINGS: H1=NONE",
      markers: ["ACTIONS"],
      lines: oneHeading,
    },
  ])("rejects $name", ({ preamble, markers, lines }) => {
    expect(headingRoutes(reply(preamble, markers), markers, lines)).toBeNull();
  });

  test.each([
    "H1=ACTION",
    "H1=待办事项",
    "H1=UNKNOWN",
    "H1=",
    "H1=ACTIONS,DECISIONS",
    "H1=ACTIONS,NONE",
    "H1 ACTIONS",
    "H1=ACTIONS extra",
    "H1=ACTIONS=NONE",
  ])("rejects an invalid routing value or entry: %s", (entry) => {
    expect(
      headingRoutes(reply(`HEADINGS: ${entry}`, ["ACTIONS"]), ["ACTIONS"], oneHeading),
    ).toBeNull();
  });

  test.each([
    "H1=待办事项 H2=NONE",
    "H1=ACTIONS, H1=ACTIONS, H2=NONE",
    "H1=ACTIONS | H1=DECISIONS | H2=NONE",
    "H1=ACTIONS,H2=ACTIONS",
    "H1=ACTIONS,H99=NONE,H2=NONE",
    "H1=ACTIONS, H2=NONE extra",
    "H1=NONE | H2=NONE",
    "`H1=ACT`IONS H2=NONE",
    "H1=AC TIONS H2=NONE",
    "H1=ACTIONS,,H2=NONE",
    "H1=ACTIONS | | H2=NONE",
    "H1=ACTIONS H2=NONE..",
    "`H1=ACTIONS H2=NONE",
    "H1=ACTIONS` H2=NONE`",
  ])("formatting does not hide invalid or conflicting assignments: %s", (entries) => {
    expect(
      headingRoutes(
        reply(`- **Headings：** ${entries}`, ["ACTIONS H1"]),
        ["ACTIONS H1"],
        twoHeadings,
      ),
    ).toBeNull();
  });

  test.each([
    "headings: H1=ACTIONS H2=NONE",
    "**HEADINGS:** H1=NONE H2=DECISIONS",
    "- HEADINGS：H1=ACTIONS,H2=NONE",
    "`HEADINGS: H1=ACTIONS H2=NONE`",
  ])("rejects a second control line regardless of formatting: %s", (second) => {
    expect(
      headingRoutes(
        reply(`HEADINGS: H1=ACTIONS H2=NONE\n${second}`, ["ACTIONS"]),
        ["ACTIONS"],
        twoHeadings,
      ),
    ).toBeNull();
  });

  test.each([
    { firstHeading: "### ACTIONS", markers: ["ACTIONS", "SUMMARY"] },
    { firstHeading: "### L1", markers: ["L1", "SUMMARY"] },
    { firstHeading: "### Other content", markers: ["SUMMARY"] },
    { firstHeading: "   ### ACTIONS", markers: ["ACTIONS", "SUMMARY"] },
  ])(
    "does not use metadata after the first content heading: $firstHeading",
    ({ firstHeading, markers }) => {
      const markdown = `${firstHeading}\nContent.\nHEADINGS: H1=ACTIONS\n### SUMMARY\nOverview.`;

      expect(headingRoutes(markdown, markers, oneHeading)).toBeNull();
    },
  );

  test("ignores body metadata that contradicts the valid preamble", () => {
    expect(
      headingRoutes(
        "HEADINGS: H1=ACTIONS\n### ACTIONS\nContent.\nHEADINGS: H1=DECISIONS",
        ["ACTIONS"],
        oneHeading,
      ),
    ).toEqual(new Map([["actions", "H1"]]));
  });

  test("ignores body metadata that contradicts a valid explicit target", () => {
    expect(
      headingRoutes("### ACTIONS H1\nContent.\nHEADINGS: H1=DECISIONS", ["ACTIONS H1"], oneHeading),
    ).toEqual(new Map([["actions", "H1"]]));
  });

  test.each(["```", "~~~"])("accepts a control line enclosed in a %s fence", (fence) => {
    expect(
      headingRoutes(
        reply(`${fence}\nHEADINGS: H1=ACTIONS H2=NONE\n${fence}`, ["ACTIONS"]),
        ["ACTIONS"],
        twoHeadings,
      ),
    ).toEqual(new Map([["actions", "H1"]]));
  });

  test.each(["```", "~~~"])(
    "a %s fence never reopens metadata after a content heading",
    (fence) => {
      expect(
        headingRoutes(
          `${fence}\n### ACTIONS\nContent.\nHEADINGS: H1=ACTIONS\n${fence}`,
          ["ACTIONS"],
          oneHeading,
        ),
      ).toBeNull();
    },
  );

  test.each([{ lines: [] }, { lines: ordinaryLines }])(
    "without structural headings, legacy explicit H targets keep the default section placement",
    ({ lines }) => {
      expect(
        headingRoutes(reply("", ["ACTIONS H99", "SUMMARY"]), ["ACTIONS H99", "SUMMARY"], lines),
      ).toEqual(new Map());
    },
  );

  test.each([{ lines: ordinaryLines }, { lines: twoHeadings }])(
    "ordinary-line-only replies do not require structural heading assignments",
    ({ lines }) => {
      expect(headingRoutes(reply("", ["L1", "L2"]), ["L1", "L2"], lines)).toEqual(new Map());
    },
  );

  test("an empty reply without generated sections has no heading routes", () => {
    expect(headingRoutes("", [], twoHeadings)).toEqual(new Map());
  });
});

// protects=the typed lines a reply says its transcript doesn't answer are read from its one control line, in the forms a model writes it, and a reply that doesn't say, says it twice, or names anything but an ordinary line says nothing of any line, so "Not mentioned in the call." is never written on a guess; fails_when=a heading, an unknown line or a second control line still yields a list, or a plain list isn't read
describe("The lines a reply says the call doesn't answer", () => {
  const frames = "### FACT P1_F1\nA cited fact.\n### END P1_F1";

  test.each([
    ["UNANSWERED: L2", ["L2"]],
    ["UNANSWERED: L1 L2", ["L1", "L2"]],
    ["UNANSWERED：L1、L2。", ["L1", "L2"]],
    ["unanswered: l2, l1.", ["L2", "L1"]],
    ["**UNANSWERED:** `L2`", ["L2"]],
    ["- UNANSWERED: NONE", []],
    ["HEADINGS: H1=ACTIONS H2=NONE\nUNANSWERED: L1", ["L1"]],
  ] as const)("%j is read", (line, listed) => {
    expect(unansweredLines(`${line}\n\n${frames}`, twoHeadings)).toEqual(new Set(listed));
  });

  test.each([
    ["no control line", ""],
    ["an empty one", "UNANSWERED:"],
    ["two of them", "UNANSWERED: L1\nUNANSWERED: L2"],
    ["a heading", "UNANSWERED: H1"],
    ["a line the User never typed", "UNANSWERED: L1 L9"],
    ["NONE beside a line", "UNANSWERED: NONE L1"],
    ["words", "UNANSWERED: the second line"],
  ] as const)("%s says nothing of any line", (_, line) => {
    expect(unansweredLines(`${line}\n\n${frames}`, twoHeadings)).toBeNull();
  });

  test("a control line after the first frame is not read", () => {
    expect(unansweredLines(`${frames}\n\nUNANSWERED: L1`, twoHeadings)).toBeNull();
  });
});

// protects=a reply says its part of the call held little to note with one control line before its first frame, in the forms a model writes it; a reply that doesn't say so, says it twice, says anything else or says it after a frame is not read as saying it (#3287); fails_when=a reply that never said so is trusted as short, or the line in a form a model writes isn't read; no_claim=when a real model writes the line, which the pull request's real-model runs show.
describe("A reply that says its part of the call held little to note", () => {
  const frames = "### FACT P1_F1\nA cited fact.\n### END P1_F1";

  test.each([
    "QUIET: YES",
    "quiet: yes.",
    "**QUIET:** YES",
    "QUIET：YES",
    "HEADINGS: H1=NONE\nQUIET: YES",
  ])("%j is read", (line) => {
    expect(saysQuiet(`${line}\n\n${frames}`)).toBe(true);
  });

  test.each([
    ["no control line", ""],
    ["NO", "QUIET: NO"],
    ["an empty one", "QUIET:"],
    ["two of them", "QUIET: YES\nQUIET: YES"],
    ["more than the one word", "QUIET: YES and NO"],
    ["words", "QUIET: the call was quiet"],
  ] as const)("%s doesn't say so", (_, line) => {
    expect(saysQuiet(`${line}\n\n${frames}`)).toBe(false);
  });

  test("the line after the first frame is not read", () => {
    expect(saysQuiet(`${frames}\n\nQUIET: YES`)).toBe(false);
  });
});

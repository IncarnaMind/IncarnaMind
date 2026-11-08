import { describe, expect, test } from "vitest";
import { CITATION_NODE, GENERATED_MARK } from "../../src/core/api";
import { type FactPlacementInput, placeFacts } from "../../src/core/meetings/factPlacement";
import type { MeetingFact } from "../../src/core/meetings/factProtocol";
import { asGenerated } from "../../src/shared/aiText";
import { citationNode, type NodeJSON } from "../../src/shared/blockJson";

const checkedCitation = (quote: string, speaker = "Them", from = 127): NodeJSON =>
  citationNode({
    passageId: "transcript-passage",
    documentId: "transcript-document",
    documentName: "Team call",
    contentHash: "transcript-version",
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "time", from, to: from + 8, speaker },
    quote,
    check: "found",
    checkReason: null,
  });

function fact(text: string, changes: Partial<MeetingFact> = {}): MeetingFact {
  const citations = changes.citations ?? [checkedCitation(text)];
  const body = asGenerated([
    { type: "paragraph", content: [{ type: "text", text }, ...citations] },
  ])[0];
  if (!body) throw new Error("A fact needs its generated paragraph");
  return {
    id: "F1",
    topic: "Contract",
    heading: "Contract terms",
    lines: ["L1"],
    sections: ["actions"],
    claim: false,
    supersedes: [],
    body,
    citations,
    ...changes,
  };
}

const reference = (topic: string, direction: "above" | "below") => `${topic}: see ${direction}.`;

const input = (
  facts: readonly MeetingFact[],
  changes: Partial<FactPlacementInput> = {},
): FactPlacementInput => ({
  facts,
  overview: null,
  lines: [{ marker: "L1", heading: false, ancestors: [] }],
  headings: new Map(),
  topicHeadings: [],
  claims: new Set<string>(),
  reference,
  ...changes,
});

const textOf = (node: NodeJSON): string =>
  node.type === "text" ? (node.text ?? "") : (node.content ?? []).map(textOf).join("");

const citationsOf = (node: NodeJSON): NodeJSON[] =>
  node.type === CITATION_NODE ? [node] : (node.content ?? []).flatMap(citationsOf);

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  if (value instanceof Map || value instanceof Set) {
    for (const item of value.values()) freeze(item);
  } else {
    for (const item of Object.values(value)) freeze(item);
  }
  Object.freeze(value);
}

describe("Meeting fact placement (#2306)", () => {
  test.each([
    { text: "Dana sends the contract by Friday.", topic: "Contract", section: "actions" },
    { text: "林周五前发送合同。", topic: "合同", section: "actions" },
    { text: "The final rate is 18%.", topic: "Rate", section: "decisions" },
    { text: "谁签署合同还没定。", topic: "签署人", section: "questions" },
  ] as const)(
    "writes a $section fact whole in its section and points the User's line to it with the same Citations: $topic",
    ({ text, topic, section }) => {
      const accepted = fact(text, { topic, sections: [section] });
      const placed = placeFacts(input([accepted]));

      expect(placed.sections).toEqual(new Map([[section, [accepted.body]]]));
      expect(placed.sections.get(section)?.[0]).toBe(accepted.body);
      expect(placed.lines.get("L1")).toHaveLength(1);
      const pointer = placed.lines.get("L1")?.[0];
      expect(pointer && textOf(pointer).trim()).toBe(`${topic}: see below.`);
      expect(pointer && citationsOf(pointer)).toEqual(accepted.citations);
      expect(pointer?.content?.[0]?.marks).toEqual([{ type: GENERATED_MARK }]);
      expect(placed.unplaced).toBe(0);
    },
  );

  test.each([
    { text: "Sam will book the room by Monday.", topic: "Room booking" },
    { text: "小陈周一前预订会议室。", topic: "预订会议室" },
  ])(
    "keeps an unrelated commitment, owner and deadline together in Actions: $topic",
    ({ text, topic }) => {
      const accepted = fact(text, { lines: [], topic });
      const placed = placeFacts(input([accepted]));

      expect(placed.lines.size).toBe(0);
      expect(placed.sections.get("actions")).toEqual([accepted.body]);
      expect(placed.sections.get("actions")?.[0]).toBe(accepted.body);
      expect(placed.unplaced).toBe(0);
    },
  );

  test.each([
    { sections: ["summary", "questions", "decisions", "actions"], home: "actions" },
    { sections: ["summary", "questions", "decisions"], home: "decisions" },
    { sections: ["summary", "questions"], home: "questions" },
  ] as const)("uses one complete canonical category for $sections", ({ sections, home }) => {
    const accepted = fact("The agreed detail stays intact.", {
      lines: [],
      sections: [...sections],
    });
    const placed = placeFacts(input([accepted]));

    expect(placed.sections.get(home)).toEqual([accepted.body]);
    expect(
      [...placed.sections.values()].flat().filter((node) => node === accepted.body),
    ).toHaveLength(1);
    expect(placed.sections.has("summary")).toBe(false);
    expect(placed.topics).toEqual([]);
    for (const section of sections) {
      if (section === home || section === "summary") continue;
      const node = placed.sections.get(section)?.[0];
      expect(node && textOf(node).trim()).toBe(
        section === "questions" ? "Contract: see above." : "Contract: see below.",
      );
      expect(node && citationsOf(node)).toEqual(accepted.citations);
    }
    expect(placed.unplaced).toBe(0);
  });

  test("preserves an unknown-line fact under its topic once without multiplying its warning", () => {
    const first = checkedCitation("The rate stays unchanged.");
    const second = checkedCitation("The rate is confirmed.", "Me", 208);
    const accepted = fact("The rate stays unchanged.", {
      lines: ["L404", "L405"],
      sections: [],
      citations: [first, second],
    });
    const placed = placeFacts(input([accepted]));

    expect(placed.lines.size).toBe(0);
    expect(placed.sections.size).toBe(0);
    expect(placed.topics).toEqual([
      { title: "Contract terms", heading: null, nodes: [accepted.body] },
    ]);
    expect(placed.unplaced).toBe(1);
  });

  test("ignores an invalid ranked line while its valid successor still gets the fact or its pointer", () => {
    const background = fact("The fee stays at 18%.", {
      lines: ["L404", "L1"],
      sections: ["summary"],
    });
    const kept = placeFacts(input([background]));

    expect(kept.lines).toEqual(new Map([["L1", [background.body]]]));
    expect(kept.sections.size).toBe(0);
    expect(kept.unplaced).toBe(1);

    const action = fact("Dana sends the contract by Friday.", { lines: ["L404", "L1"] });
    const pointed = placeFacts(input([action]));

    expect(pointed.sections).toEqual(new Map([["actions", [action.body]]]));
    expect(pointed.lines.get("L1")).toHaveLength(1);
    const pointer = pointed.lines.get("L1")?.[0];
    expect(pointer && textOf(pointer).trim()).toBe("Contract: see below.");
    expect(pointed.unplaced).toBe(1);
  });

  test("uses a requested category, not a heading line, as the full fallback home", () => {
    const accepted = fact("Lin sends the file tomorrow.", { lines: ["H73", "L404"] });
    const placed = placeFacts(
      input([accepted], {
        lines: [{ marker: "H73", heading: true, ancestors: [] }],
      }),
    );

    expect(placed.lines.size).toBe(0);
    expect(placed.sections.get("actions")).toEqual([accepted.body]);
    expect(placed.unplaced).toBe(1);
  });

  test("a fact with no line and no section is written under its topic, and nowhere else", () => {
    const accepted = fact("This detail must not disappear.", { lines: [], sections: [] });
    const placed = placeFacts(input([accepted]));

    expect(placed.sections.size).toBe(0);
    expect(placed.lines.size).toBe(0);
    expect(placed.topics).toEqual([
      { title: "Contract terms", heading: null, nodes: [accepted.body] },
    ]);
    expect(placed.topics[0]?.nodes[0]).toBe(accepted.body);
    expect(placed.unplaced).toBe(0);
  });

  test.each([
    {
      language: "en",
      headings: ["Education and career", "The startup", "education  and Career", "The AI course"],
      titles: ["Education and career", "The startup", "The AI course"],
    },
    {
      language: "zh-CN",
      headings: ["教育与职业经历", "创业与被收购", "教育与职业经历", "ＡＩ课程与社群"],
      titles: ["教育与职业经历", "创业与被收购", "ＡＩ课程与社群"],
    },
  ])(
    "groups topic facts under one heading each, in the order the call took them up ($language)",
    ({ headings, titles }) => {
      const facts = headings.map((heading, index) =>
        fact(`Point ${index + 1}.`, { id: `F${index + 1}`, heading, lines: [], sections: [] }),
      );
      const placed = placeFacts(input(facts));

      expect(placed.topics.map((topic) => topic.title)).toEqual(titles);
      expect(placed.topics.map((topic) => topic.nodes.map(textOf))).toEqual([
        ["Point 1.", "Point 3."],
        ["Point 2."],
        ["Point 4."],
      ]);
      expect(placed.topics.every((topic) => topic.heading === null)).toBe(true);
      expect(placed.sections.size).toBe(0);
      expect(placed.lines.size).toBe(0);
    },
  );

  test.each([
    { typed: "Pricing", heading: "pricing" },
    { typed: "价格", heading: "价格" },
    { typed: "ＡＩ Course", heading: "AI course" },
  ])("a topic named like the User's heading $typed goes under it", ({ typed, heading }) => {
    const accepted = fact("The fee stays at 18%.", { heading, lines: ["L1", "L2"], sections: [] });
    const other = fact("The venue is Leeds.", {
      id: "F2",
      heading: "Venue",
      lines: [],
      sections: [],
    });
    const placed = placeFacts(
      input([accepted, other], {
        lines: [
          { marker: "L1", heading: false, ancestors: [] },
          { marker: "H2", heading: true, ancestors: [] },
          { marker: "L2", heading: false, ancestors: ["H2"] },
        ],
        topicHeadings: [{ marker: "H2", text: typed }],
      }),
    );

    expect(placed.lines.get("L1")).toEqual([accepted.body]);
    expect(placed.topics).toEqual([{ title: "Venue", heading: null, nodes: [other.body] }]);
    const unlined = fact("The fee is billed monthly.", {
      id: "F3",
      heading,
      lines: [],
      sections: [],
    });
    const hosted = placeFacts(
      input([unlined, other], {
        lines: [
          { marker: "L1", heading: false, ancestors: [] },
          { marker: "H2", heading: true, ancestors: [] },
          { marker: "L2", heading: false, ancestors: ["H2"] },
        ],
        topicHeadings: [{ marker: "H2", text: typed }],
      }),
    );
    expect(hosted.topics).toEqual([
      { title: heading, heading: "H2", nodes: [unlined.body] },
      { title: "Venue", heading: null, nodes: [other.body] },
    ]);
  });

  test("a topic's fact asked on two typed lines points from the second to the first, and nowhere else", () => {
    const accepted = fact("The fee stays at 18%.", { lines: ["L2", "L1"], sections: [] });
    const placed = placeFacts(
      input([accepted], {
        lines: [
          { marker: "L1", heading: false, ancestors: [] },
          { marker: "L2", heading: false, ancestors: [] },
        ],
      }),
    );

    expect(placed.lines.get("L2")).toEqual([accepted.body]);
    expect(placed.lines.get("L1")?.map((node) => textOf(node).trim())).toEqual([
      "Contract: see below.",
    ]);
    expect(placed.sections.size).toBe(0);
    expect(placed.topics).toEqual([]);
  });

  test.each([
    { text: "The UK fee is 2.5%.", heading: "Fees" },
    { text: "英国费用是 2.5%。", heading: "费用" },
  ])(
    "a topic's claim the Documents don't back moves whole to the claims list, not a pointer: $heading",
    ({ text, heading }) => {
      const claimed = fact(text, { heading, lines: [], sections: [], claim: true });
      const kept = fact("The fee is billed monthly.", {
        id: "F2",
        heading,
        lines: [],
        sections: [],
        claim: true,
      });
      const placed = placeFacts(input([claimed, kept], { claims: new Set([claimed.id]) }));

      expect(placed.sections).toEqual(new Map([["claims", [claimed.body]]]));
      expect(placed.topics).toEqual([{ title: heading, heading: null, nodes: [kept.body] }]);
      expect(placed.lines.size).toBe(0);
    },
  );

  test("respects model ranking while references follow the actual earlier and later User lines", () => {
    const accepted = fact("The final rate is 18%.", {
      lines: ["L99", "L8", "L30", "L8"],
      sections: ["summary"],
    });
    const placed = placeFacts(
      input([accepted], {
        lines: [
          { marker: "L8", heading: false, ancestors: [] },
          { marker: "L99", heading: false, ancestors: [] },
          { marker: "L30", heading: false, ancestors: [] },
        ],
      }),
    );

    expect(placed.lines.get("L99")).toEqual([accepted.body]);
    const earlier = placed.lines.get("L8")?.[0];
    const later = placed.lines.get("L30")?.[0];
    expect(placed.lines.get("L8")).toHaveLength(1);
    expect(earlier && textOf(earlier).trim()).toBe("Contract: see below.");
    expect(later && textOf(later).trim()).toBe("Contract: see above.");
    expect(earlier && citationsOf(earlier)).toEqual(accepted.citations);
    expect(later && citationsOf(later)).toEqual(accepted.citations);
    expect(placed.sections.size).toBe(0);
  });

  test("a decision answering a line inside its routed heading is written whole there, and the User's other lines point up or down to it", () => {
    const accepted = fact("The final rate is 18%.", {
      lines: ["L99", "L8", "L30"],
      sections: ["decisions"],
    });
    const placed = placeFacts(
      input([accepted], {
        lines: [
          { marker: "L8", heading: false, ancestors: [] },
          { marker: "H7", heading: true, ancestors: [] },
          { marker: "L99", heading: false, ancestors: ["H7"] },
          { marker: "H12", heading: true, ancestors: [] },
          { marker: "L30", heading: false, ancestors: ["H12"] },
        ],
        headings: new Map([["decisions", "H7"]]),
      }),
    );

    expect(placed.sections.size).toBe(0);
    expect(placed.lines.get("L99")).toEqual([accepted.body]);
    const pointers = new Map(
      [...placed.lines]
        .filter(([marker]) => marker !== "L99")
        .map(([marker, nodes]) => [marker, nodes.map((node) => textOf(node).trim())]),
    );
    expect(pointers).toEqual(
      new Map([
        ["L8", ["Contract: see below."]],
        ["L30", ["Contract: see above."]],
      ]),
    );
    for (const nodes of placed.lines.values()) {
      expect(nodes.flatMap(citationsOf)).toEqual(accepted.citations);
    }
  });

  test("an arbitrary routed category spans every descendant heading, so a line deep inside it is filled out in place", () => {
    const accepted = fact("林周五前发送合同。");
    const placed = placeFacts(
      input([accepted], {
        lines: [
          { marker: "H73", heading: true, ancestors: [] },
          { marker: "H8", heading: true, ancestors: ["H73"] },
          { marker: "H204", heading: true, ancestors: ["H73", "H8"] },
          { marker: "L1", heading: false, ancestors: ["H73", "H8", "H204"] },
        ],
        headings: new Map([["actions", "H73"]]),
      }),
    );

    expect(placed.lines.get("L1")).toEqual([accepted.body]);
    expect(placed.sections.size).toBe(0);
  });

  test("a full fact in an ordinary line needs no Summary reference even under a different heading", () => {
    const accepted = fact("This is the final background detail.", { sections: ["summary"] });
    const placed = placeFacts(
      input([accepted], {
        lines: [
          { marker: "H11", heading: true, ancestors: [] },
          { marker: "L1", heading: false, ancestors: ["H11"] },
        ],
      }),
    );

    expect(placed.lines.get("L1")).toEqual([accepted.body]);
    expect(placed.sections.size).toBe(0);
  });

  test("a line after a routed category that ends earlier points above to the whole fact", () => {
    const accepted = fact("Dana sends the contract by Friday.");
    const placed = placeFacts(
      input([accepted], {
        lines: [
          { marker: "H7", heading: true, ancestors: [] },
          { marker: "L8", heading: false, ancestors: ["H7"] },
          { marker: "H12", heading: true, ancestors: [] },
          { marker: "L1", heading: false, ancestors: ["H12"] },
        ],
        headings: new Map([["actions", "H7"]]),
      }),
    );

    expect(placed.sections).toEqual(new Map([["actions", [accepted.body]]]));
    expect(placed.lines.get("L1")).toHaveLength(1);
    const pointer = placed.lines.get("L1")?.[0];
    expect(pointer && textOf(pointer).trim()).toBe("Contract: see above.");
    expect(pointer && citationsOf(pointer)).toEqual(accepted.citations);
  });

  test("an unrelated nested heading does not cover a routed category: the claim goes whole to its list and the line points there", () => {
    const accepted = fact("The fee is 18%.", { sections: ["summary"] });
    const placed = placeFacts(
      input([accepted], {
        lines: [
          { marker: "H7", heading: true, ancestors: [] },
          { marker: "H8", heading: true, ancestors: ["H7"] },
          { marker: "L1", heading: false, ancestors: ["H7", "H8"] },
          { marker: "H12", heading: true, ancestors: [] },
        ],
        headings: new Map([["claims", "H12"]]),
        claims: new Set([accepted.id]),
      }),
    );

    expect(placed.sections.get("claims")).toEqual([accepted.body]);
    const pointer = placed.lines.get("L1")?.[0];
    expect(pointer && textOf(pointer).trim()).toBe("Contract: see below.");
    expect(pointer && citationsOf(pointer)).toEqual(accepted.citations);
  });

  test("category-to-category references follow routed positions instead of category order", () => {
    const accepted = fact("Dana sends the contract by Friday.", {
      lines: [],
      sections: ["decisions", "questions", "actions"],
    });
    const placed = placeFacts(
      input([accepted], {
        lines: [
          { marker: "H7", heading: true, ancestors: [] },
          { marker: "L8", heading: false, ancestors: ["H7"] },
          { marker: "H12", heading: true, ancestors: [] },
          { marker: "L1", heading: false, ancestors: ["H12"] },
        ],
        headings: new Map([
          ["questions", "H7"],
          ["actions", "H12"],
        ]),
      }),
    );

    expect(placed.sections.get("actions")).toEqual([accepted.body]);
    const question = placed.sections.get("questions")?.[0];
    const decision = placed.sections.get("decisions")?.[0];
    expect(question && textOf(question).trim()).toBe("Contract: see below.");
    expect(decision && textOf(decision).trim()).toBe("Contract: see above.");
  });

  test("a category's full paragraph also covers a routed ancestor category", () => {
    const accepted = fact("Dana sends the contract by Friday.", {
      lines: [],
      sections: ["actions", "decisions"],
    });
    const placed = placeFacts(
      input([accepted], {
        lines: [
          { marker: "H7", heading: true, ancestors: [] },
          { marker: "H12", heading: true, ancestors: ["H7"] },
          { marker: "L1", heading: false, ancestors: ["H7", "H12"] },
        ],
        headings: new Map([
          ["decisions", "H7"],
          ["actions", "H12"],
        ]),
      }),
    );

    expect(placed.sections).toEqual(new Map([["actions", [accepted.body]]]));
  });

  test("repeated input IDs create only one full fact and one pointer per line, and an action is never in the Claims list", () => {
    const citations = [
      checkedCitation("I will send the contract by Friday.", "Dana", 311),
      checkedCitation("Friday is confirmed.", "Me", 328),
    ];
    const accepted = fact("Dana sends the contract by Friday.", {
      lines: ["L1", "L2"],
      sections: ["actions", "actions"],
      citations,
    });
    const placed = placeFacts(
      input([accepted, accepted, structuredClone(accepted)], {
        lines: [
          { marker: "L1", heading: false, ancestors: [] },
          { marker: "L2", heading: false, ancestors: [] },
        ],
        claims: new Set([accepted.id, "F404"]),
      }),
    );

    expect(placed.sections.get("actions")).toEqual([accepted.body]);
    for (const marker of ["L1", "L2"]) {
      expect(placed.lines.get(marker)).toHaveLength(1);
      const pointer = placed.lines.get(marker)?.[0];
      expect(pointer && textOf(pointer).trim()).toBe("Contract: see below.");
    }
    expect(placed.sections.has("claims")).toBe(false);
    const pointer = placed.lines.get("L1")?.[0];
    expect(pointer && citationsOf(pointer)[0]).toBe(citations[0]);
    expect(pointer && citationsOf(pointer)[1]).toBe(citations[1]);
    expect(placed.unplaced).toBe(0);
  });

  test("a repeated invalid-home ID counts as one unplaced fact, not one per input or Citation", () => {
    const accepted = fact("保留这条事实。", { lines: ["L404"], sections: [] });
    const placed = placeFacts(
      input([accepted, structuredClone(accepted), accepted], {
        claims: new Set([accepted.id]),
      }),
    );

    expect(placed.sections).toEqual(new Map([["claims", [accepted.body]]]));
    expect(placed.topics).toEqual([]);
    expect(placed.unplaced).toBe(1);
  });

  test("the Claims checklist comes from checked IDs rather than the model's claim flag", () => {
    const accepted = fact("The fee is 18%.", { claim: true });
    const placed = placeFacts(input([accepted]));

    expect(placed.sections.has("claims")).toBe(false);
  });

  // protects=the claims list holds whole statements only: a claim answering a typed line is written there whole and the line points to it, and an action stays whole in its section with no stub in the list (#2306); fails_when=the list holds a pointer, or a claim is written twice; no_claim=which facts a model marks as claims.
  test.each([
    { home: "Actions", lines: [], sections: ["actions"] },
    { home: "User's line", lines: ["L1"], sections: ["summary"] },
  ] as const)(
    "an earlier Claims heading holds the whole claim, never a pointer, for a fact homed in $home",
    ({ home, lines, sections }) => {
      const accepted = fact("The fee is 18%.", { lines: [...lines], sections: [...sections] });
      const placed = placeFacts(
        input([accepted], {
          lines: [
            { marker: "H7", heading: true, ancestors: [] },
            { marker: "L8", heading: false, ancestors: ["H7"] },
            { marker: "H12", heading: true, ancestors: [] },
            { marker: "L1", heading: false, ancestors: ["H12"] },
          ],
          headings: new Map([
            ["claims", "H7"],
            ["actions", "H12"],
          ]),
          claims: new Set([accepted.id]),
        }),
      );

      if (home === "Actions") {
        expect(placed.sections.has("claims")).toBe(false);
        expect(placed.sections.get("actions")).toEqual([accepted.body]);
        return;
      }
      expect(placed.sections.get("claims")).toEqual([accepted.body]);
      const pointer = placed.lines.get("L1")?.[0];
      expect(pointer && textOf(pointer).trim()).toBe("Contract: see above.");
      expect(pointer && citationsOf(pointer)).toEqual(accepted.citations);
    },
  );

  test.each([
    { home: "Actions", lines: [], sections: ["actions"] },
    { home: "User's line", lines: ["L1"], sections: ["summary"] },
  ] as const)(
    "no Claims stub is added around the whole fact in a descendant $home",
    ({ home, lines, sections }) => {
      const accepted = fact("费用为 18%。", { lines: [...lines], sections: [...sections] });
      const placed = placeFacts(
        input([accepted], {
          lines: [
            { marker: "H7", heading: true, ancestors: [] },
            { marker: "H12", heading: true, ancestors: ["H7"] },
            { marker: "L1", heading: false, ancestors: ["H7", "H12"] },
          ],
          headings: new Map([
            ["claims", "H7"],
            ["actions", "H12"],
          ]),
          claims: new Set([accepted.id]),
        }),
      );

      expect(placed.sections.has("claims")).toBe(false);
      expect(home === "Actions" ? placed.sections.get("actions") : placed.lines.get("L1")).toEqual([
        accepted.body,
      ]);
    },
  );

  test.each([
    ["Dana sends the file Friday.", "Sam does not send the file Friday."],
    ["林周五发送文件。", "陈周五不发送文件。"],
    ["Dana sends Reports/Q3.csv on Friday.", "Sam sends reports/q3.csv on Friday."],
  ])(
    "shared cues and dates never merge independent accepted facts: %s",
    (firstText, secondText) => {
      const citations = [checkedCitation(`${firstText} ${secondText}`, "Dana", 614)];
      const first = fact(firstText, { id: "F1", lines: [], citations });
      const second = fact(secondText, { id: "F2", lines: [], citations });
      const placed = placeFacts(input([first, second]));

      expect(placed.sections.get("actions")).toEqual([first.body, second.body]);
      expect(placed.sections.get("actions")?.map(textOf)).toEqual([firstText, secondText]);
    },
  );

  test.each([
    {
      topic: "# **[Contract](javascript:alert(1))** [^99] <img>",
      text: "Dana sends it Friday.",
      chinese: false,
    },
    {
      topic: "# **[合同](javascript:alert(1))** [^99] <图片>",
      text: "林周五发送。",
      chinese: true,
    },
  ])(
    "topics are plain generated text, never parsed as Markdown or Citations: $topic",
    ({ topic, text, chinese }) => {
      const accepted = fact(text, { topic });
      const placed = placeFacts(
        input([accepted], {
          reference: chinese
            ? (name, direction) => `${name}：详见${direction === "above" ? "上" : "下"}文。`
            : reference,
        }),
      );

      const pointer = placed.lines.get("L1")?.[0];
      const expected = chinese ? `${topic}：详见下文。 ` : `${topic}: see below. `;
      expect(pointer?.type).toBe("paragraph");
      expect(pointer?.content).toEqual([
        { type: "text", text: expected, marks: [{ type: GENERATED_MARK }] },
        ...accepted.citations,
      ]);
    },
  );

  test.each([
    "The call reviewed the contract and resolved the release plan.",
    "本次通话讨论合同并确定发布计划。",
  ])(
    "Summary holds the generated overview alone, and a fact once marked summary goes under its topic: %s",
    (overviewText) => {
      const overview = fact(overviewText);
      const residual = fact("The fee stays at 18%.", {
        id: "F2",
        heading: "Fees",
        lines: [],
        sections: ["summary"],
      });
      const related = fact("Dana sends the contract Friday.");
      const placed = placeFacts(
        input([related, residual], {
          overview: { body: overview.body, citations: overview.citations },
        }),
      );

      expect(placed.sections.get("summary")).toEqual([overview.body]);
      expect(placed.sections.get("summary")?.[0]).toBe(overview.body);
      expect(placed.sections.get("summary")?.map(textOf)).toEqual([overviewText]);
      expect(placed.topics).toEqual([{ title: "Fees", heading: null, nodes: [residual.body] }]);
    },
  );

  test("an overview survives without facts, and empty input creates no generic Summary", () => {
    const overview = fact("The call reviewed the release plan.");
    expect(
      placeFacts(
        input([], {
          overview: { body: overview.body, citations: overview.citations },
        }),
      ).sections,
    ).toEqual(new Map([["summary", [overview.body]]]));
    expect(placeFacts(input([]))).toEqual({
      lines: new Map(),
      sections: new Map(),
      topics: [],
      unplaced: 0,
    });
  });

  test("placement does not mutate accepted bodies, Citation attrs, routes, IDs or User line order", () => {
    const accepted = fact("林周五前发送合同。", {
      lines: ["L2", "L1"],
      sections: ["summary", "actions", "decisions"],
    });
    const request = input([accepted, accepted], {
      lines: [
        { marker: "H7", heading: true, ancestors: [] },
        { marker: "L1", heading: false, ancestors: ["H7"] },
        { marker: "H12", heading: true, ancestors: [] },
        { marker: "L2", heading: false, ancestors: ["H12"] },
      ],
      headings: new Map([["actions", "H7"]]),
      claims: new Set([accepted.id]),
    });
    const before = structuredClone({ ...request, reference: null });
    freeze(request);
    const placed = placeFacts(request);

    expect({ ...request, reference: null }).toEqual(before);
    expect(placeFacts(request)).toEqual(placed);
    expect(placed.sections.get("actions")?.[0]).toBe(accepted.body);
  });
});

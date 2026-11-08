import { describe, expect, test } from "vitest";
import type { CellAnswer } from "../../src/core/answers";
import { markdownToBlocks } from "../../src/core/answers/markdown";
import { quotedWordsIn } from "../../src/core/answers/quotedWords";
import { GENERATED_MARK, type MarkedCitation } from "../../src/core/api";
import { parseFactReply } from "../../src/core/meetings/factProtocol";
import { textOf } from "../../src/core/meetings/fillPrompt";
import { asGenerated } from "../../src/shared/aiText";
import { citationNode, type NodeJSON, withCitations } from "../../src/shared/blockJson";

const receipt: MarkedCitation = {
  marker: 1,
  passageId: "transcript-passage",
  documentId: "transcript-document",
  documentName: "Review call",
  contentHash: "transcript-version",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "time", from: 12_000, to: 18_000, speaker: "Them" },
  quote: "I will send the review with Alex by Friday.",
  check: "found",
  checkReason: null,
};

function checkedNode(marked: MarkedCitation): NodeJSON {
  const { marker: _marker, ...citation } = marked;
  return citationNode(citation);
}

function answer(
  markdown: string,
  citations: MarkedCitation[] = [receipt],
): Pick<CellAnswer, "markdown" | "blocks" | "citations"> {
  return {
    markdown,
    citations,
    blocks: asGenerated(
      withCitations(markdownToBlocks(markdown), (marker) => {
        const found = citations.find((each) => each.marker === marker);
        return found ? checkedNode(found) : null;
      }),
    ),
  };
}

function fact(id: string, body = "Them and Alex will send the review by Friday. [^1]", extra = {}) {
  return [
    `### FACT ${id}`,
    "```json",
    JSON.stringify({
      topic: "review delivery",
      citations: [1],
      lines: ["L1"],
      sections: ["actions"],
      claim: true,
      supersedes: [],
      ...extra,
    }),
    "```",
    body,
    `### END ${id}`,
  ].join("\n");
}

const overview = [
  "### OVERVIEW",
  "```json",
  '{"citations":[1]}',
  "```",
  "The call covered the review handover. [^1]",
  "### END OVERVIEW",
].join("\n");

describe("Meeting fact protocol (#2306)", () => {
  test.each([
    {
      topic: "review delivery",
      body: "Them and Alex will send the review by Friday. [^1]",
      text: "Them and Alex will send the review by Friday. ",
    },
    {
      topic: "评审交接",
      body: "对方和小林会在周五前发送评审。[^1]",
      text: "对方和小林会在周五前发送评审。",
    },
  ])("keeps one complete cited paragraph in $topic", ({ topic, body, text }) => {
    const parsed = parseFactReply(
      answer(`HEADINGS: H1=ACTIONS\n${fact("P1_F1", body, { topic })}\n${overview}`),
    );

    expect(parsed.omitted).toBe(0);
    expect(parsed.omittedIds).toEqual([]);
    expect(parsed.invalidFrames).toBe(0);
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.facts[0]).toMatchObject({
      id: "P1_F1",
      topic,
      lines: ["L1"],
      sections: ["actions"],
      claim: true,
      supersedes: [],
      body: { type: "paragraph" },
      citations: [checkedNode(receipt)],
    });
    const kept = parsed.facts[0];
    if (!kept) throw new Error("Missing fact");
    expect(textOf(kept.body)).toBe(text);
    expect(kept.body.content?.find((node) => node.type === "text")?.marks).toContainEqual({
      type: GENERATED_MARK,
    });
    expect(parsed.overview?.body.type).toBe("paragraph");
    expect(textOf(parsed.overview?.body ?? { type: "paragraph" })).toBe(
      "The call covered the review handover. ",
    );
  });

  test("normalizes one harmless bullet without losing owners, case, formatting or receipts", () => {
    const parsed = parseFactReply(
      answer(
        `${fact("F1", "- **Them and Alex** will send Config/A by Friday. [^1]", {
          sections: [],
          supersedes: ["P0_prior", "F1"],
        })}\n${overview}`,
      ),
    );
    expect(parsed.omitted).toBe(0);
    expect(parsed.facts[0]).toMatchObject({
      body: { type: "paragraph" },
      sections: [],
      supersedes: ["P0_prior", "F1"],
    });
    expect(textOf(parsed.facts[0]?.body ?? { type: "paragraph" })).toBe(
      "Them and Alex will send Config/A by Friday. ",
    );
    expect(parsed.facts[0]?.body.content?.[0]?.marks?.some((mark) => mark.type === "bold")).toBe(
      true,
    );
  });

  test("accepts category-only facts and optional supersedes", () => {
    const markdown = fact("F1", undefined, { lines: [] }).replace(',"supersedes":[]', "");
    expect(parseFactReply(answer(`${markdown}\n${overview}`)).facts[0]).toMatchObject({
      lines: [],
      sections: ["actions"],
      supersedes: [],
    });
  });

  test.each([
    { name: "no marker", body: "The review will be sent.", extra: {} },
    { name: "wrong inventory", body: "The review will be sent. [^1]", extra: { citations: [2] } },
    {
      name: "unrecorded marker",
      body: "The review will be sent. [^99]",
      extra: { citations: [99] },
    },
    {
      name: "removed dead marker remains in inventory",
      body: "The review will be sent. [^1]",
      extra: { citations: [1, 99] },
    },
    {
      name: "one of several markers missing",
      body: "The review will be sent. [^1]",
      extra: { citations: [1, 2] },
    },
    { name: "body has an extra marker", body: "The review. [^1] [^2]", extra: { citations: [1] } },
    { name: "marker only inside code", body: "The review `[^1]`.", extra: {} },
  ])("omits $name once while retaining a good identity", ({ body, extra }) => {
    const parsed = parseFactReply(
      answer(`${fact("Bad", body, extra)}\n${fact("Good")}\n${overview}`, [
        receipt,
        { ...receipt, marker: 2 },
      ]),
    );
    expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
    expect(parsed.omitted).toBe(1);
    expect(parsed.invalidFrames).toBe(0);
  });

  test.each(["not-found", "cant-check", "checking", "not-checked"] as const)(
    "does not promote a %s receipt using metadata or a different good marker",
    (check) => {
      const parsed = parseFactReply(
        answer(
          `${fact("Bad", "The review and handover. [^1] [^2]", { citations: [1, 2] })}\n${fact("Good")}\n${overview}`,
          [receipt, { ...receipt, marker: 2, check }],
        ),
      );
      expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
      expect(parsed.omitted).toBe(1);
      expect(parsed.omittedReasons).toEqual({ Bad: "citationNotFound" });
    },
  );

  test.each([
    { documentId: "another-session-document" },
    { passageId: "another-passage" },
    { contentHash: "another-version" },
    { quote: "A different quote." },
    { location: { kind: "time", from: 19_000, to: 24_000, speaker: "Them" } },
    { location: { kind: "time", from: 12_000, to: 18_000, speaker: "Me" } },
    { check: "not-found" },
  ] satisfies Partial<MarkedCitation>[])("rejects body/session receipt mismatch %j", (change) => {
    const input = answer(`${fact("F1")}\n${overview}`);
    input.citations = [{ ...receipt, ...change }];
    const parsed = parseFactReply(input);
    expect(parsed.facts).toEqual([]);
    expect(parsed.overview).toBeNull();
    expect(parsed.omitted).toBe(2);
  });

  test("a found node without a session record is not a receipt", () => {
    const input = answer(`${fact("F1")}\n${overview}`);
    input.citations = [];
    const parsed = parseFactReply(input);
    expect(parsed.facts).toEqual([]);
    expect(parsed.overview).toBeNull();
    expect(parsed.omitted).toBe(2);
  });

  test("a forged found node cannot replace the actual Citation", () => {
    const input = answer(`${fact("F1")}\n${overview}`);
    const body = input.blocks.find((node) => node.type === "paragraph");
    const cited = body?.content?.find((node) => node.type === "citation");
    if (!cited?.attrs) throw new Error("Missing fixture Citation");
    cited.attrs = { check: "found", quote: receipt.quote };
    const parsed = parseFactReply(input);
    expect(parsed.facts).toEqual([]);
    expect(parsed.omitted).toBe(1);
    expect(parsed.overview).not.toBeNull();
  });

  test("repeated identical declarations keep one identity without an omission", () => {
    const same = fact("F1");
    const parsed = parseFactReply(answer(`${same}\n${same}\n${same}\n${overview}`));
    expect(parsed.facts.map((each) => each.id)).toEqual(["F1"]);
    expect(parsed.omitted).toBe(0);
    expect(parsed.omittedIds).toEqual([]);
  });

  test.each([
    { topic: "another label" },
    { lines: ["L2"] },
    { sections: ["decisions"] },
    { claim: false },
    { supersedes: ["Prior"] },
    { citations: [2] },
  ])("conflicting same-ID metadata drops that identity once: %j", (extra) => {
    const parsed = parseFactReply(
      answer(
        `${fact("F1")}\n${fact("Good")}\n${fact("F1", undefined, extra)}\n${fact("F1")}\n${overview}`,
        [receipt, { ...receipt, marker: 2 }],
      ),
    );
    expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
    expect(parsed.omitted).toBe(1);
  });

  test("conflicting full wording never picks a winner, even after another identical declaration", () => {
    const parsed = parseFactReply(
      answer(
        `${fact("F1")}\n${fact("F1", "Alex will keep the review private. [^1]")}\n${fact("F1")}\n${fact("Good")}\n${overview}`,
      ),
    );
    expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
    expect(parsed.omitted).toBe(1);
  });

  test("shared cues and different IDs are not semantic identity, including case-sensitive paths", () => {
    const parsed = parseFactReply(
      answer(
        [
          fact("Upper", "Them will send Config/A by Friday. [^1]"),
          fact("Lower", "Them will send config/a by Friday. [^1]"),
          fact("Distinct", "Alex will review the handover by Friday. [^1]"),
          fact("SameWords", "Them will send Config/A by Friday. [^1]"),
          overview,
        ].join("\n"),
      ),
    );
    expect(parsed.facts.map((each) => each.id)).toEqual([
      "Upper",
      "Lower",
      "Distinct",
      "SameWords",
    ]);
    expect(parsed.omitted).toBe(0);
  });

  test.each([
    { name: "mismatched END", broken: fact("Bad").replace("### END Bad", "### END Other") },
    { name: "missing END", broken: fact("Bad").replace("### END Bad", "") },
    {
      name: "unrecognized heading",
      broken: fact("Bad").replace("### END Bad", "### Other\nLeaked."),
    },
    { name: "two paragraphs", broken: fact("Bad", "First claim. [^1]\n\nSecond claim. [^1]") },
    { name: "two list items", broken: fact("Bad", "- First claim. [^1]\n- Second claim. [^1]") },
    { name: "nested list", broken: fact("Bad", "- First claim. [^1]\n  - Nested claim. [^1]") },
    { name: "quoted block", broken: fact("Bad", "> A claim. [^1]") },
    { name: "code block", broken: fact("Bad", "```text\nA claim. [^1]\n```") },
    { name: "inline code", broken: fact("Bad", "Send `Config/A`. [^1]") },
    { name: "unexpected inline content", broken: fact("Bad", "Send $x^2$. [^1]") },
    { name: "nested controls", broken: fact("Bad", "### TEXT Bad\nA claim. [^1]") },
    {
      name: "unfenced metadata",
      broken: fact("Bad").replace("```json\n", "").replace("```\n", ""),
    },
    { name: "wrong metadata language", broken: fact("Bad").replace("```json", "```text") },
    { name: "malformed JSON", broken: fact("Bad").replace('"topic":', '"topic" ') },
  ])("leaves out $name without swallowing the next closed fact", ({ broken }) => {
    const parsed = parseFactReply(answer(`${broken}\n${fact("Good")}\n${overview}`));
    expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
    expect(parsed.omitted).toBe(1);
  });

  test("an unclosed fence cannot be salvaged by finding FACT or END text inside its code", () => {
    const broken = [
      "### FACT Broken",
      "```json",
      '{"topic":"unfinished"}',
      "### END Broken",
      "### FACT Hidden",
      '{"topic":"not a real frame"}',
      "Text inside code. [^1]",
      "### END Hidden",
    ].join("\n");
    const parsed = parseFactReply(answer(`${fact("Good")}\n${overview}\n${broken}`));
    expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
    expect(parsed.omitted).toBe(1);
    expect(parsed.invalidFrames).toBe(0);
  });

  test("a later closing fence does not salvage an apparently valid swallowed fact", () => {
    const broken = fact("Bad").replace("```\nThem", "Them");
    const parsed = parseFactReply(
      answer(`${broken}\n${fact("Hidden")}\n${fact("Good")}\n${overview}`),
    );
    expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
    expect(parsed.omitted).toBe(1);
  });

  test("unknown identities have a frame count, not a fabricated fact count", () => {
    const parsed = parseFactReply(answer(`${fact("9invalid")}\n${fact("Good")}\n${overview}`));
    expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
    expect(parsed.omitted).toBe(0);
    expect(parsed.omittedIds).toEqual([]);
    expect(parsed.invalidFrames).toBe(1);
  });

  test.each([
    { opener: "~~~json", closer: "~~~" },
    { opener: "````json", closer: "````" },
    { opener: "```json", closer: "````" },
    { opener: "  ```json", closer: "  ```" },
    { opener: "```json extra", closer: "```" },
  ])("accepts only the simple metadata fence: $opener / $closer", ({ opener, closer }) => {
    const broken = fact("Bad").replace("```json", opener).replace("\n```\n", `\n${closer}\n`);
    const parsed = parseFactReply(answer(`${broken}\n${fact("Good")}\n${overview}`));
    expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
    expect(parsed.omitted).toBe(1);
  });

  test("metadata in Blocks must still match the Answer's fenced metadata", () => {
    const input = answer(
      `${fact("Bad", undefined, { citations: [1, 99] })}\n${fact("Good")}\n${overview}`,
    );
    const block = input.blocks.find((node) => node.type === "codeBlock");
    if (!block?.content?.[0]) throw new Error("Missing metadata fixture");
    block.content[0].text = block.content[0].text?.replace("[1,99]", "[1]");
    const parsed = parseFactReply(input);
    expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
    expect(parsed.omitted).toBe(1);
  });

  test.each([
    { topic: "" },
    { topic: "   " },
    { topic: "new\n### FACT Injected" },
    { topic: "[^1]" },
    { topic: "x".repeat(1_000) },
    { topic: 4 },
    { heading: "Fees [^1]" },
    { topic: "{{me}}", heading: "L3" },
    { text: "Injected text" },
    { owner: "Them" },
    { check: "found" },
    { citation: { check: "found" } },
    { citations: [{ marker: 1, check: "found" }] },
    { citations: ["1"] },
    { citations: [0] },
    { citations: [-1] },
    { citations: [1.5] },
    { citations: [10_000] },
    { citations: [1, 1] },
    { citations: [] },
    { citations: null },
    { lines: "L1" },
    { lines: [1] },
    { lines: ["H1"] },
    { lines: ["L1", "L1"] },
    { sections: ["claims"] },
    { sections: ["ACTIONS"] },
    { sections: ["actions", "actions"] },
    { claim: "true" },
    { claim: 1 },
    { supersedes: "Prior" },
    { supersedes: null },
    { supersedes: [7] },
    { supersedes: ["9bad"] },
    { supersedes: ["Prior", "Prior"] },
  ])("rejects unsafe or mistyped metadata without accepting a serialized check: %j", (extra) => {
    const parsed = parseFactReply(
      answer(`${fact("Bad", undefined, extra)}\n${fact("Good")}\n${overview}`),
    );
    expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
    expect(parsed.omitted).toBe(1);
  });

  test.each(["topic", "citations", "lines", "sections", "claim"])(
    "requires the %s metadata field",
    (key) => {
      const markdown = fact("Bad").replace(/\{[^\n]+\}/, (json) => {
        const fields: Record<string, unknown> = JSON.parse(json);
        delete fields[key];
        return JSON.stringify(fields);
      });
      expect(parseFactReply(answer(`${markdown}\n${overview}`)).omitted).toBe(1);
    },
  );

  // protects=a fact's heading never shows a line's address, a token for the User or anything that isn't a title: it falls back to the fact's topic, without its token, and a Citation marker anywhere in the metadata still leaves the fact out (#2306); fails_when=a heading shows "L3", "H2", "{{me}}" or a marker, or a fact is lost for a heading the topic can stand in for; no_claim=which headings a model writes.
  test.each([
    { heading: "The startup and its acquisition", expected: "The startup and its acquisition" },
    { heading: "  创业与被收购 ", expected: "创业与被收购" },
    { heading: undefined, expected: "review delivery" },
    { heading: "", expected: "review delivery" },
    { heading: "new\n### FACT Injected", expected: "review delivery" },
    { heading: "x".repeat(1_000), expected: "review delivery" },
    { heading: null, expected: "review delivery" },
    { heading: ["Pricing"], expected: "review delivery" },
    { heading: "L3", expected: "review delivery" },
    { heading: "Pricing for H2", expected: "review delivery" },
    { heading: "{{me}}'s plans", expected: "review delivery" },
    { heading: "｛｛ME｝｝的计划", expected: "review delivery" },
    { heading: "{{me}}", topic: "{{me}}'s glossary", expected: "glossary" },
    { heading: "L1", topic: "｛｛me｝｝的术语表", expected: "术语表" },
  ])(
    "a fact names the topic it goes under, its own topic when it names none or no title: $expected",
    ({ heading, topic, expected }) => {
      const parsed = parseFactReply(
        answer(
          `${fact("F1", undefined, { lines: [], sections: [], ...(topic && { topic }), ...(heading !== undefined && { heading }) })}\n${overview}`,
        ),
      );
      expect(parsed.omitted).toBe(0);
      expect(parsed.facts[0]).toMatchObject({ heading: expected, lines: [], sections: [] });
    },
  );

  test("keeps the topic as a literal label, never parsed Markdown or Note content", () => {
    const topic = "**Config/A** <review> [label](https://example.test)";
    const parsed = parseFactReply(answer(`${fact("F1", undefined, { topic })}\n${overview}`));
    expect(parsed.facts[0]?.topic).toBe(topic);
    expect(JSON.stringify(parsed.facts[0]?.body)).not.toContain("example.test");
  });

  test("metadata quotations are not prose quotations, and controls/metadata never enter the body", () => {
    const markdown = `${fact("F1", undefined, { topic: 'the "long quoted metadata phrase"' })}\n${overview}`;
    expect(quotedWordsIn(markdown)).toEqual([]);
    const parsed = parseFactReply(answer(markdown));
    expect(parsed.facts).toHaveLength(1);
    expect(JSON.stringify([parsed.facts[0]?.body, parsed.overview?.body])).not.toMatch(
      /FACT|END|OVERVIEW|supersedes|citations|long quoted metadata phrase/,
    );
  });

  test.each([
    "",
    overview.replace("### END OVERVIEW", ""),
    overview.replace("[^1]", ""),
    overview.replace('"citations":[1]', '"citations":[99]'),
    overview.replace('"citations":[1]', '"citations":[1],"check":"found"'),
    overview.replace("The call covered", "First paragraph. [^1]\n\nThe call covered"),
    overview.replace("### END OVERVIEW", "### END F1"),
  ])("a missing or invalid required overview is omitted once", (invalid) => {
    const parsed = parseFactReply(answer(`${fact("Good")}\n${invalid}`));
    expect(parsed.facts.map((each) => each.id)).toEqual(["Good"]);
    expect(parsed.overview).toBeNull();
    expect(parsed.omitted).toBe(1);
    expect(parsed.omittedIds).toEqual([]);
  });

  test("identical overviews keep one, but conflicting overviews are left out once", () => {
    expect(parseFactReply(answer(`${fact("Good")}\n${overview}\n${overview}`)).omitted).toBe(0);
    const conflicting = overview.replace("The call covered", "The meeting settled");
    const parsed = parseFactReply(
      answer(`${fact("Good")}\n${overview}\n${conflicting}\n${overview}`),
    );
    expect(parsed.overview).toBeNull();
    expect(parsed.omitted).toBe(1);
  });

  test("an invalid repeated identity stays omitted once instead of reviving later", () => {
    const parsed = parseFactReply(
      answer(`${fact("F1")}\n${fact("F1", "No marker.")}\n${fact("F1")}\n${overview}`),
    );
    expect(parsed.facts).toEqual([]);
    expect(parsed.omitted).toBe(1);
  });

  test.each(["No Citation marker.", "没有引用标记。"])(
    "omitted identity receipts report a repeated invalid ID once: %s",
    (body) => {
      const invalid = fact("A", body);
      const parsed = parseFactReply(
        answer(`${invalid}\n${fact("Good")}\n${invalid}\n${invalid}\n${overview}`),
      );

      expect(parsed.omittedIds).toEqual(["A"]);
      expect(parsed.omittedReasons).toEqual({ A: "markers" });
      expect(parsed.omitted).toBe(1);
      expect(parsed.invalidFrames).toBe(0);
      expect(parsed.facts).toEqual(parseFactReply(answer(`${fact("Good")}\n${overview}`)).facts);
    },
  );

  test.each([
    { invalid: "No Citation marker.", conflicting: "Alex will keep the review private. [^1]" },
    { invalid: "没有引用标记。", conflicting: "小林不会发送评审。[^1]" },
  ])(
    "omitted identity receipts retain first-encounter order across later conflicts: $invalid",
    ({ invalid, conflicting }) => {
      const parsed = parseFactReply(
        answer(
          [
            fact("B"),
            fact("Good"),
            fact("A", invalid),
            fact("C", undefined, { claim: "true" }),
            fact("B", conflicting),
            fact("A", invalid),
            fact("B"),
            fact("C"),
            overview,
          ].join("\n"),
        ),
      );

      expect(parsed.omittedIds).toEqual(["B", "A", "C"]);
      expect(parsed.omittedReasons).toEqual({ B: "repeated", A: "markers", C: "repeated" });
      expect(parsed.omitted).toBe(3);
      expect(parsed.invalidFrames).toBe(0);
      expect(parsed.facts).toEqual(parseFactReply(answer(`${fact("Good")}\n${overview}`)).facts);
    },
  );

  test.each(["markdown", "blocks"] as const)(
    "size-capped %s returns no known omitted identity receipts",
    (limit) => {
      const input = answer(`${fact("Ignored")}\n${overview}`);
      if (limit === "markdown") input.markdown = " ".repeat(2_000_001);
      else input.blocks = Array.from({ length: 20_001 }, () => ({ type: "paragraph" }));

      expect(parseFactReply(input)).toEqual({
        facts: [],
        overview: null,
        omitted: 1,
        omittedIds: [],
        omittedReasons: {},
        invalidFrames: 1,
      });
    },
  );
});

import { expect, test } from "vitest";
import { markdownToBlocks } from "../../src/core/answers/markdown";
import type { Citation } from "../../src/core/api";
import { parseFactReply } from "../../src/core/meetings/factProtocol";
import { notesContext } from "../../src/core/meetings/fillPrompt";
import { fillReply } from "../../src/main/fakeChat/meetingFill";
import { INTERVIEW } from "../../src/main/fakeChat/meetingInterview";
import type { Prompt } from "../../src/main/fakeChat/prompt";
import { asGenerated } from "../../src/shared/aiText";
import { citationNode, withCitations } from "../../src/shared/blockJson";

const citation: Citation = {
  passageId: "passage",
  documentId: "transcript",
  documentName: "Call",
  contentHash: "version",
  pageFrom: 1,
  pageTo: 1,
  location: { kind: "time", from: 0, to: 5_000, speaker: "Them" },
  quote: "We agreed the enterprise price is 45 dollars a seat",
  check: "found",
  checkReason: null,
};

function prompt(text: string, cited = false): Prompt {
  return [
    { role: "user", content: [{ type: "text", text }] },
    ...(cited
      ? [
          {
            role: "tool" as const,
            content: [
              {
                type: "tool-result" as const,
                toolCallId: "cite-1",
                toolName: "cite",
                output: { type: "text" as const, value: "Recorded [^1]." },
              },
            ],
          },
        ]
      : []),
  ];
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the smoke model emits checked framed facts, not independently repeated section drafts (${language})`, () => {
    const chinese = language === "zh-CN";
    const said = chinese ? "我们同意企业版每个席位 45 美元" : citation.quote;
    const context = notesContext(
      [
        { marker: "L1", text: chinese ? "价格" : "price", heading: false },
        { marker: "L2", text: chinese ? "合同" : "contract", heading: false },
        { marker: "H1", text: chinese ? "待办事项" : "Action items", heading: true },
        { marker: "H2", text: chinese ? "通话" : "Call", heading: true },
      ],
      "Fill the Note.",
    );
    const text = `${context.messages[0]?.content}\n<live-transcript>\n<passage id="P1" document="Call" location="0:00–0:05">\n[0:00 Them] ${said}\n</passage>\n</live-transcript>`;
    const reply = fillReply(prompt(text, true), ["cite"]);
    if (!reply || !("text" in reply)) throw new Error("Expected the final framed reply");
    const receipt = { ...citation, quote: said };
    const parsed = parseFactReply({
      markdown: reply.text,
      blocks: asGenerated(withCitations(markdownToBlocks(reply.text), () => citationNode(receipt))),
      citations: [{ marker: 1, ...receipt }],
    });
    expect(parsed.omitted).toBe(0);
    expect(parsed.invalidFrames).toBe(0);
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.facts[0]).toMatchObject({
      lines: ["L1", "L2"],
      sections: ["decisions", "actions"],
    });
    expect(parsed.overview).not.toBeNull();
    expect(reply.text.split(said)).toHaveLength(2);
    expect(reply.text).toContain("HEADINGS: H1=ACTIONS H2=NONE");
    expect(reply.text).not.toMatch(/^### (?:L\d+|ACTIONS|DECISIONS|SUMMARY)/m);
  });
}

test("the smoke model gives its framed prose an ordinary cite Tool record with the cue's selector", () => {
  const context = notesContext([], "Fill the Note.");
  const text = `${context.messages[0]?.content}\n<live-transcript>\n<passage id="P1" document="Call" location="0:00–0:05">\n[0:00 Them] ${citation.quote}\n</passage>\n</live-transcript>`;
  expect(fillReply(prompt(text), ["cite"])).toMatchObject({
    tool: "cite",
    input: { citations: [{ marker: 1, passage: "P1", quote: citation.quote, location: "0:00" }] },
  });
});

test("the memo reply keeps its existing title and tidied-prose protocol", () => {
  const text =
    'voice memo the User just\n<live-transcript>\n<passage id="P1" document="Memo" location="0:00–0:05">\n[0:00 Me] Today we review progress\n</passage>\n</live-transcript>';
  expect(fillReply(prompt(text, true), ["cite"])).toEqual({
    text: "# Today we review progress\n\nToday we review progress [^1].",
  });
});

function fixtureContext(control: string, chinese = false): string {
  const context = notesContext(
    [
      { marker: "L1", text: control, heading: false },
      { marker: "L2", text: chinese ? "价格" : "price", heading: false },
      { marker: "H1", text: chinese ? "待办事项" : "Action items", heading: true },
    ],
    "Fill the Note.",
  );
  const said = chinese ? "我们确认了上线日期" : citation.quote;
  return `${context.messages[0]?.content}\n<live-transcript>\n<passage id="P1" document="Call" location="0:00–0:05">\n[0:00 Them] ${said}\n</passage>\n</live-transcript>`;
}

test.each(
  (["partial", "empty"] as const).flatMap((outcome) =>
    (["en", "zh-CN"] as const).map((language) => ({ outcome, language })),
  ),
)(
  "the explicit $outcome fixture keeps the ordinary cite loop and strict receipts ($language)",
  ({ outcome, language }) => {
    const control = `Meeting fill fixture: ${outcome}`;
    const chinese = language === "zh-CN";
    const text = fixtureContext(control, chinese);
    const first = fillReply(prompt(text), ["cite"]);
    expect(first).toMatchObject({ tool: "cite", input: { citations: [{ marker: 1 }] } });
    if (!first || !("input" in first)) throw new Error("Expected the ordinary cite Tool call");
    expect(JSON.stringify(first.input)).not.toContain("99");
    const last = fillReply(prompt(text, true), ["cite"]);
    if (!last || !("text" in last)) throw new Error("Expected final frames, not another Tool call");
    expect(last.text.match(/^### FACT P1_F\d+$/gm)).toEqual(
      outcome === "partial" ? ["### FACT P1_F1", "### FACT P1_F2"] : ["### FACT P1_F2"],
    );
    expect(last.text.match(/^### END P1_F\d+$/gm)).toEqual(
      outcome === "partial" ? ["### END P1_F1", "### END P1_F2"] : ["### END P1_F2"],
    );
    expect(last.text.match(/^### OVERVIEW$/gm)).toHaveLength(1);
    expect(last.text.match(/^### END OVERVIEW$/gm)).toHaveLength(1);
    expect(last.text).toContain('"citations":[99]');
    expect(last.text).toContain("[^99]");
    expect(last.text).not.toContain(control);
    const receipt = { ...citation, quote: chinese ? "我们确认了上线日期" : citation.quote };
    const parsed = parseFactReply({
      markdown: last.text,
      blocks: asGenerated(
        withCitations(markdownToBlocks(last.text), (marker) =>
          marker === 1 ? citationNode(receipt) : null,
        ),
      ),
      citations: [{ marker: 1, ...receipt }],
    });
    expect(parsed.invalidFrames).toBe(0);
    expect(parsed.omittedIds).toEqual(["P1_F2"]);
    expect(parsed.omitted).toBe(outcome === "partial" ? 1 : 2);
    if (outcome === "partial") {
      expect(parsed.facts).toHaveLength(1);
      expect(parsed.facts[0]).toMatchObject({
        id: "P1_F1",
        lines: ["L2"],
        citations: [citationNode(receipt)],
      });
      expect(parsed.overview?.citations).toEqual([citationNode(receipt)]);
    } else {
      expect(parsed.facts).toEqual([]);
      expect(parsed.overview).toBeNull();
      expect(last.text).not.toContain("[^1]");
    }
  },
);

test.each([
  "Meeting fill fixture: partial extra",
  "Meeting fill fixture: empty extra",
  "meeting fill fixture: partial",
])("a near-match note does not route a fixture: %s", (control) => {
  const reply = fillReply(prompt(fixtureContext(control), true), ["cite"]);
  if (!reply || !("text" in reply)) throw new Error("Expected the normal final reply");
  expect(reply.text).not.toContain("P1_F2");
  expect(reply.text).not.toContain("99");
});

test("a literal outside an addressed note does not route a fixture", () => {
  const text = `${fixtureContext("ordinary note")}\nMeeting fill fixture: partial`;
  const reply = fillReply(prompt(text, true), ["cite"]);
  if (!reply || !("text" in reply)) throw new Error("Expected the normal final reply");
  expect(reply.text).not.toContain("P1_F2");
  expect(reply.text).not.toContain("99");
  const later = fillReply(
    [
      ...prompt(fixtureContext("Meeting fill fixture: empty")),
      ...prompt(fixtureContext("ordinary note"), true),
    ],
    ["cite"],
  );
  if (!later || !("text" in later)) throw new Error("Expected the latest Note's normal reply");
  expect(later.text).not.toContain("P1_F2");
  expect(later.text).not.toContain("99");
});

for (const language of ["en", "zh-CN"] as const) {
  test(`the smoke model's interview cites each answer and files it under its topic (${language})`, () => {
    const call = INTERVIEW[language];
    const lines = call.answers.map(
      (answer, index) => `[0:${String(index * 4).padStart(2, "0")} Them] ${answer.said}`,
    );
    const context = notesContext([], "Fill the Note.");
    const text = `${context.messages[0]?.content}\n<live-transcript>\n<passage id="P1" document="Call" location="0:00–0:40">\n${lines.join("\n")}\n</passage>\n</live-transcript>`;
    const cite = fillReply(prompt(text), ["cite"]);
    if (!cite || !("tool" in cite)) throw new Error("Expected the interview's cite call");
    const records = (cite.input as { citations: { marker: number; quote: string }[] }).citations;
    expect(records.map((record) => record.quote)).toEqual(
      call.answers.map((answer) => answer.said),
    );
    const reply = fillReply(prompt(text, true), ["cite"]);
    if (!reply || !("text" in reply)) throw new Error("Expected the interview's framed reply");
    const receipts = records.map((record) => ({
      ...citation,
      marker: record.marker,
      quote: record.quote,
    }));
    const parsed = parseFactReply({
      markdown: reply.text,
      blocks: asGenerated(
        withCitations(markdownToBlocks(reply.text), (marker) => {
          const found = receipts.find((each) => each.marker === marker);
          if (!found) return null;
          const { marker: _marker, ...attributes } = found;
          return citationNode(attributes);
        }),
      ),
      citations: receipts,
    });
    expect(parsed.omitted).toBe(0);
    expect(parsed.facts.map((fact) => fact.heading)).toEqual(
      call.answers.map((answer) => answer.heading),
    );
    expect(new Set(parsed.facts.map((fact) => fact.heading)).size).toBe(4);
    expect(parsed.overview).not.toBeNull();
  });
}

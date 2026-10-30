import { expect, test } from "vitest";
import { readVerdict } from "../../src/core/answers/checks/prompt";
import { editPrompt, readEditReply } from "../../src/core/edits/prompt";
import { ATTRIBUTION_SMOKE, attributionEdit } from "../../src/main/fakeChat/attribution";
import { checkReply } from "../../src/main/fakeChat/checks";
import { fakeEdit } from "../../src/main/fakeChat/edit";
import type { Prompt } from "../../src/main/fakeChat/prompt";

function checkPrompt(
  claim: string,
  passages: { id: string; name: string; quote: string }[],
  cited = false,
): Prompt {
  return [
    {
      role: "system",
      content: "You check one sentence the User wrote against the User's Documents",
    },
    { role: "user", content: [{ type: "text", text: `<sentence>\n${claim}\n</sentence>` }] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "search",
          toolName: "search_documents",
          output: {
            type: "text",
            value: passages
              .map(
                ({ id, name, quote }) =>
                  `<passage id="${id}" document="${name}">\n${quote}\n</passage>`,
              )
              .join("\n"),
          },
        },
      ],
    },
    ...(cited
      ? [
          {
            role: "tool" as const,
            content: [
              {
                type: "tool-result" as const,
                toolCallId: "cite",
                toolName: "cite",
                output: { type: "text" as const, value: "Recorded [^1]." },
              },
            ],
          },
        ]
      : []),
  ];
}

test.each(Object.entries(ATTRIBUTION_SMOKE))(
  "%s Source fixture preserves both physical and ordinary receipt markers",
  (_language, row) => {
    const passage = row.wrong
      .replace(row.wrongWords, `${row.wrongWords} [2]`)
      .replace(/([.。])$/, "[1]$1");
    const result = attributionEdit(
      passage,
      `Change only the attribution to ${JSON.stringify(row.actualName)}, keeping every factual claim unchanged.`,
    );
    expect(result?.replace(/\s*\[\d+\]/g, "")).toBe(row.corrected);
    expect(result?.match(/\[\d+\]/g)).toEqual(["[2]", "[1]"]);
  },
);

test.each(Object.entries(ATTRIBUTION_SMOKE))(
  "%s wrong and corrected Source checks never cite a Residents decoy",
  (_language, row) => {
    const passages = [
      { id: "residents-first", name: row.residents, quote: row.firstQuote },
      { id: "residents-second", name: row.residents, quote: row.secondQuote },
      { id: "housing", name: row.actualName, quote: row.wrongFact },
    ];
    for (const claim of [row.wrong, row.corrected]) {
      for (const order of [passages, [...passages].reverse()]) {
        expect(checkReply(checkPrompt(claim, order), ["search_documents", "cite"])).toEqual({
          tool: "cite",
          input: { citations: [{ marker: 1, passage: "housing", quote: row.wrongFact }] },
        });
      }
      const reply = checkReply(checkPrompt(claim, passages, true), ["search_documents", "cite"]);
      if (!("text" in reply)) throw new Error("A recorded Source fixture should give its verdict.");
      expect(reply.text).toContain(`${row.wrongFact} [^1]`);
      expect(reply.text).not.toContain(row.firstQuote);
      expect(readVerdict(reply.text)?.verdict).toBe("supported");
    }
  },
);

test.each(Object.entries(ATTRIBUTION_SMOKE))(
  "%s same-title Source keeps both Residents receipts and excludes Housing",
  (_language, row) => {
    const reply = checkReply(
      checkPrompt(row.source, [
        { id: "housing", name: row.actualName, quote: row.wrongFact },
        { id: "residents-first", name: row.residents, quote: row.firstQuote },
        { id: "residents-second", name: row.residents, quote: row.secondQuote },
      ]),
      ["search_documents", "cite"],
    );
    expect(reply).toEqual({
      tool: "cite",
      input: {
        citations: [
          { marker: 1, passage: "residents-first", quote: row.firstQuote },
          { marker: 2, passage: "residents-second", quote: row.secondQuote },
        ],
      },
    });
  },
);

test.each(Object.entries(ATTRIBUTION_SMOKE))(
  "%s ordinary fixture replies explicitly decline an absence claim",
  (_language, row) => {
    for (const [claim, quote] of [
      [row.source, row.firstQuote],
      [row.wrong, row.wrongFact],
      [row.corrected, row.wrongFact],
      [row.speaker, row.spoken],
      [row.stale, row.staleQuote],
      [row.noPeriod, row.noPeriodQuote],
      [row.recent, row.recentQuote],
      [row.anchored, row.staleQuote],
    ]) {
      if (!claim || !quote) throw new Error("The fixture protocol case is incomplete.");
      for (const passages of [[{ id: "own", name: "Fixture Source", quote }], []]) {
        const reply = checkReply(checkPrompt(claim, passages, true), ["search_documents", "cite"]);
        if (!("text" in reply)) throw new Error("The fixture should give a terminal verdict.");
        expect(reply.text).toContain("\nAbsence: no\n");
      }
    }
  },
);

test.each(Object.entries(ATTRIBUTION_SMOKE))(
  "%s complete fakeEdit request recognizes Source and time correction with both markers",
  (_language, row) => {
    for (const sample of [
      {
        claim: row.wrong,
        words: row.wrongWords,
        quote: row.wrongFact,
        expected: row.corrected,
        instruction: `Change only the attribution to ${JSON.stringify(row.actualName)}, keeping every factual claim unchanged.`,
      },
      {
        claim: row.stale,
        words: row.when,
        quote: row.staleQuote,
        expected: row.anchored,
        instruction:
          "Anchor the sentence to March 2023 and adjust the tense, keeping every factual claim unchanged.",
      },
    ]) {
      const passage = sample.claim
        .replace(sample.words, `${sample.words} [2]`)
        .replace(/([.。])$/, "[1]$1");
      const reply = fakeEdit([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: editPrompt({
                action: "follow-citation",
                instruction: sample.instruction,
                passage,
                context: sample.claim,
                quotes: [sample.quote, sample.quote],
              }),
            },
          ],
        },
      ]);
      if (!reply) throw new Error("The complete correction request was not recognized.");
      const text = readEditReply(reply.text, passage);
      expect(text.replace(/\s*\[\d+\]/g, "")).toBe(sample.expected);
      expect(text.match(/\[\d+\]/g)).toEqual(["[2]", "[1]"]);
    }
  },
);

test.each(Object.entries(ATTRIBUTION_SMOKE))(
  "%s time fixture recognizes its frozen sentence across both receipt markers",
  (_language, row) => {
    const passage = row.stale.replace(row.when, `${row.when} [2]`).replace(/([.。])$/, "[1]$1");
    const instruction =
      "Anchor the sentence to March 2023 and adjust the tense, keeping every factual claim unchanged.";
    const result = attributionEdit(passage, instruction);
    expect(result?.replace(/\s*\[\d+\]/g, "")).toBe(row.anchored);
    expect(result?.match(/\[\d+\]/g)).toEqual(["[2]", "[1]"]);
    expect(attributionEdit(row.stale, instruction)).toBe(row.anchored);
    expect(attributionEdit(passage, instruction.replace("March 2023", "March 2024"))).toBeNull();
    expect(
      attributionEdit(row.stale.replace(row.when, `${row.when} [not-a-reference]`), instruction),
    ).toBeNull();
    expect(attributionEdit(row.stale.replace("5%", "6%"), instruction)).toBeNull();
  },
);

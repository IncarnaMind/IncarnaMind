import { describe, expect, test } from "vitest";
import { hostedAnswerText } from "../../src/core/agents/hosted";
import {
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  type ConversationAnswer,
  type MarkedCitation,
} from "../../src/core/api";
import { answerBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { TOTAL } from "../helpers/calculatedCharts";

/** The one token minted for this Run, and the marker its Citation has. */
const TOKEN = "[cite:k3x9a2b7]";
const markerOf = (token: string) => (token === "k3x9a2b7" ? 1 : null);

const CITATION: MarkedCitation = {
  marker: 1,
  passageId: "passage-1",
  documentId: "report",
  documentName: "Annual report 2025",
  contentHash: "hash",
  pageFrom: 4,
  pageTo: 4,
  location: null,
  quote: "Costs fell by a tenth.",
  check: "found",
  checkReason: null,
};

/** An ended Answer with Citation 1 and figure 1 on record, as the agent's own markers would try to borrow. */
const answer = (text: string, status: ConversationAnswer["status"] = "done") => ({
  text,
  citations: [CITATION],
  figures: [{ ...TOTAL, marker: 1 }],
  status,
});

function nodesOf(blocks: readonly NodeJSON[], type: string): NodeJSON[] {
  return blocks.flatMap((node) => [
    ...(node.type === type ? [node] : []),
    ...nodesOf(node.content ?? [], type),
  ]);
}

const shownText = (blocks: readonly NodeJSON[]): string =>
  blocks
    .map((node) => (node.type === "text" ? (node.text ?? "") : shownText(node.content ?? [])))
    .join("")
    .replaceAll("⁠", "");

const LANGUAGES = [
  { language: "English", claim: "Revenue grew 12%", cited: "and costs fell" },
  { language: "Chinese", claim: "收入增长了12%", cited: "成本下降了" },
];

/** Every way the agent can write one of our markers, each beside the one token minted for it. */
const SHAPES = [
  { shape: "plain", write: (c: string, t: string) => `${c} [^1]. ${t} ${TOKEN}.`, shows: "[^1]" },
  {
    shape: "in a block quote",
    write: (c: string, t: string) => `> ${c} [^1].\n\n${t} ${TOKEN}.`,
    shows: "[^1]",
  },
  {
    shape: "in bold",
    write: (c: string, t: string) => `**${c} [^1]** ${t} ${TOKEN}.`,
    shows: "[^1]",
  },
  {
    shape: "inside a link",
    write: (c: string, t: string) => `[${c} [^1]](https://example.com) ${t} ${TOKEN}.`,
    shows: "[^1]",
  },
  {
    shape: "escaped by the agent",
    write: (c: string, t: string) => `${c} [\\^1] \\[^1\\] ${t} ${TOKEN}.`,
    shows: "[^1]",
  },
  {
    shape: "as a footnote",
    write: (c: string, t: string) => `${t} ${TOKEN}.\n\n[^1]: ${c}`,
    shows: "[^1]",
  },
  { shape: "a figure", write: (c: string, t: string) => `${c} [=1] ${t} ${TOKEN}.`, shows: "[=1]" },
  {
    shape: "a figure escaped by the agent",
    write: (c: string, t: string) => `${c} [\\=1] ${t} ${TOKEN}.`,
    shows: "[=1]",
  },
  {
    shape: "a figure in bold",
    write: (c: string, t: string) => `**${c} [=1]** ${t} ${TOKEN}.`,
    shows: "[=1]",
  },
];

const CASES = LANGUAGES.flatMap((language) =>
  SHAPES.map((shape) => ({
    ...language,
    ...shape,
    raw: shape.write(language.claim, language.cited),
  })),
);

describe("a hosted agent can't produce IncarnaMind's markers (#353 spike)", () => {
  test("without the fix, the agent's own marker borrows Citation 1 through the real path", () => {
    const blocks = answerBlocks(answer(`Revenue grew 12% [^1]. Costs fell [^1].`));

    expect(nodesOf(blocks, CITATION_NODE)).toHaveLength(2);
  });

  test.each(CASES)(
    "$language, $shape: only the minted token becomes a Citation, and the agent's marker stays text",
    ({ raw, shows }) => {
      const blocks = answerBlocks(answer(hostedAnswerText(raw, markerOf)));

      expect(nodesOf(blocks, CITATION_NODE)).toHaveLength(1);
      expect(nodesOf(blocks, CITATION_NODE)[0]?.attrs?.quote).toBe("Costs fell by a tenth.");
      expect(nodesOf(blocks, CALCULATED_FIGURE_NODE)).toHaveLength(0);
      expect(shownText(blocks)).toContain(shows);
    },
  );

  test.each(CASES.filter(({ shape }) => shape === "plain" || shape === "a figure"))(
    "$language, $shape, split across chunks: no prefix shows more than the tokens it holds",
    ({ raw }) => {
      for (let end = 1; end <= raw.length; end++) {
        const prefix = raw.slice(0, end);
        const status = end < raw.length ? "streaming" : "done";
        const blocks = answerBlocks(answer(hostedAnswerText(prefix, markerOf), status));
        const tokens = prefix.includes(TOKEN) ? 1 : 0;

        expect(nodesOf(blocks, CITATION_NODE).length).toBeLessThanOrEqual(tokens);
        expect(nodesOf(blocks, CALCULATED_FIGURE_NODE)).toHaveLength(0);
      }
      expect(
        nodesOf(answerBlocks(answer(hostedAnswerText(raw, markerOf))), CITATION_NODE),
      ).toHaveLength(1);
    },
  );

  test("a token that wasn't minted for this Run stays text, and plain brackets stay as written", () => {
    const blocks = answerBlocks(
      answer(hostedAnswerText("See [Report, p. 4] and [cite:zzzz2222].", markerOf)),
    );

    expect(nodesOf(blocks, CITATION_NODE)).toHaveLength(0);
    expect(shownText(blocks)).toBe("See [Report, p. 4] and [cite:zzzz2222].");
  });
});

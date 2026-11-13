/**
 * What the everyday report says of the research Answers' checks (#3019): each Answer's second
 * looks against their cap, its check's requests, cost and time; the ✓ the judge finds their own
 * Citations don't state; the ✓ resting on a record the reply wrote; and the sentences that say
 * what wasn't found, with those that carry a marker.
 */
import { describe, expect, test } from "vitest";
import { checkCostLines, fromReplyLines, unstatedLines } from "../../eval/everyday/checkReport";
import { statedIn } from "../../eval/everyday/judge";
import { notFoundLines, notFoundSentences } from "../../eval/everyday/notFound";
import {
  type CheckedPart,
  type SentenceSupport,
  withStatedJudged,
} from "../../eval/everyday/support";
import { scriptedModel } from "../helpers/models";

const usage = (inputTokens: number) => ({
  inputTokens,
  outputTokens: 100,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
});

const part = (text: string): CheckedPart => ({
  text,
  kind: "fact",
  verdict: "supported",
  reason: null,
  detail: null,
  unsupported: null,
  evidence: [],
  figures: [],
});

const sentence = (
  text: string,
  {
    parts = [],
    requests = 1,
    anew = 0,
    ...rest
  }: Partial<SentenceSupport> & {
    requests?: number;
    anew?: number;
  } = {},
): SentenceSupport => ({
  sentence: text,
  verdict: "supported",
  reason: null,
  detail: null,
  unsupported: null,
  cites: [
    { documentName: "Weighted Keys Shorter Paths", quote: "a shorter route between positions" },
  ],
  parts,
  asked: { requests: Array.from({ length: requests }, () => usage(1_000)), anew },
  ...rest,
});

const at = { id: "research-attention-long", model: "anthropic/claude-haiku-5-5", language: "en" };

describe("What each research Answer's checks cost", () => {
  // protects=each Answer's row gives its second looks against a cap of one for each judged part (a whole sentence is one), its check's requests, their cost and the checks' time, and flags a count over the cap; a model the catalog has no price for reads "no price", never $0; fails_when=the cap counts sentences instead of parts, an over-cap count passes unflagged, or a missing price reads as free; no_claim=what a real model's checks cost.
  test("gives the second looks against their cap, the requests, the cost and the time", () => {
    const answers = [
      {
        ...at,
        checkSeconds: 12.34,
        support: [
          sentence("Shorter routes speed training.", { requests: 3 }),
          sentence("It is faster and cheaper.", {
            parts: [part("It is faster"), part("cheaper")],
            requests: 5,
            anew: 3,
          }),
        ],
      },
      { ...at, language: "zh-CN", checkSeconds: 2, support: [sentence("训练更快。", { anew: 1 })] },
    ];
    const lines = checkCostLines(answers, (each) => each.inputTokens / 1_000_000).join("\n");
    expect(lines).toContain(
      "| research-attention-long | anthropic/claude-haiku-5-5 | en | 2 | 3 (3) | 8 | $0.0080 | 12.3 s |",
    );
    expect(lines).toContain(
      "| research-attention-long | anthropic/claude-haiku-5-5 | zh-CN | 1 | 1 (1) | 1 | $0.0010 | 2.0 s |",
    );
    expect(lines).toContain("In all, over 2 Answers: 4 second looks (cap 4), 9 requests, $0.0090");

    const over = checkCostLines(
      [{ ...at, support: [sentence("训练更快。", { anew: 2 })] }],
      () => null,
    );
    expect(over.join("\n")).toContain("| 2 (1) **over the cap** | 1 | no price |");
  });
});

describe("The ✓ listed to read by hand", () => {
  const listed = (text: string, rest: Partial<SentenceSupport & { language: string }>) => ({
    ...at,
    ...sentence(text),
    ...rest,
  });

  // protects=the ✓ the judge read are counted by model and language, and each it finds unstated is listed with what its Citations quote and the words they don't state; a ✓ judged stated and a sentence never judged aren't listed; fails_when=a stated ✓ is listed, an unstated one is missed, or a sentence the judge wasn't asked about is counted; no_claim=how the judge reads.
  test("lists each ✓ the judge finds unstated, in English and Chinese", () => {
    const lines = unstatedLines([
      listed("It tests only short inputs.", { unstated: "“only”" }),
      listed("报告自己也承认成本很高。", { language: "zh-CN", unstated: "“承认”" }),
      listed("Shorter routes speed training.", { unstated: null }),
      listed("Never judged.", {}),
    ]).join("\n");
    expect(lines).toContain("| anthropic/claude-haiku-5-5 | en | 2 | 1 |");
    expect(lines).toContain("| anthropic/claude-haiku-5-5 | zh-CN | 1 | 1 |");
    expect(lines).toContain(
      "- research-attention-long (anthropic/claude-haiku-5-5): It tests only short inputs.",
    );
    expect(lines).toContain("  - unstated: “承认”");
    expect(lines).not.toContain("Shorter routes speed training.");
    expect(lines).not.toContain("Never judged.");
  });

  // protects=a ✓ resting on a record its check's reply wrote is listed apart with that record's quote, and the count is given even when there is none; fails_when=a ✓ without one is listed, or the count is left out of a run that has none; no_claim=whether that ✓ is right, which is read by hand.
  test("lists apart the ✓ resting on a record the reply wrote", () => {
    const lines = fromReplyLines([
      listed("文档中的 Mamba 论文是另一个模型。", {
        language: "zh-CN",
        fromReply: ["Mamba: linear-time sequence modeling"],
      }),
      listed("Shorter routes speed training.", {}),
    ]).join("\n");
    expect(lines).toContain("which the check took: 1, to read by hand:");
    expect(lines).toContain("  - the record's quote “Mamba: linear-time sequence modeling”");
    expect(lines).not.toContain("Shorter routes");
    expect(fromReplyLines([listed("Shorter routes speed training.", {})])).toEqual([
      "The ✓ that rest on a record the check's reply wrote into its text, which the check took: 0.",
      "",
    ]);
  });
});

describe("The judge's reading of each ✓ against its Citations", () => {
  // protects=only an Answer's ✓ are sent to the judge, in one request, each with its own Citations' quotes and their Documents, and each ✓ keeps the judge's reading, in English and Chinese; a sentence that isn't ✓ is never sent and keeps none; fails_when=a sentence without a ✓ is judged, a ✓ is sent without its quotes, or a reading lands on the wrong sentence; no_claim=how well a real judge reads.
  test("is asked about the ✓ alone, each with its quotes", async () => {
    const prompts: string[] = [];
    const judge = scriptedModel(() => ({ text: "" }), {
      generate: ({ prompt }) => {
        prompts.push(prompt);
        return { text: "1: unstated: “only”\n2: stated" };
      },
    });
    const support = await withStatedJudged(judge, [
      sentence("It tests only short inputs."),
      sentence("It isn't checked.", { verdict: "not-checked" }),
      sentence("训练更快。", {
        cites: [{ documentName: "Weighted Keys Shorter Paths", quote: "训练速度更快" }],
      }),
    ]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      '<quote of="1" document="Weighted Keys Shorter Paths">a shorter route between positions</quote>',
    );
    expect(prompts[0]).toContain('<sentence number="2">\n训练更快。\n</sentence>');
    expect(prompts[0]).not.toContain("It isn't checked.");
    expect(support.map((each) => each.unstated)).toEqual(["“only”", undefined, null]);
  });

  // protects=each numbered line of the judge's reply gives its sentence stated or the words it names, its last line for a number winning, with list marks and bold around the number read; a sentence with no line is counted unstated, saying the reply didn't read for it; fails_when=an unstated line reads as stated, a correction is ignored, or a missing line drops out of the count; no_claim=how well the judge reads.
  test("reads each sentence's last line, and a sentence with none as unread", () => {
    const reply = [
      "1: stated",
      "- 2: unstated: “only on short inputs”",
      "**3**: unstated: “承认”",
      "1: unstated",
    ].join("\n");
    expect(statedIn(reply, 4)).toEqual([
      "(no words named)",
      "“only on short inputs”",
      "“承认”",
      expect.stringContaining("the judge's reply doesn't read for it"),
    ]);
    expect(statedIn("1. stated\n2) Stated", 2)).toEqual([null, null]);
  });
});

describe("The sentences that say what wasn't found", () => {
  // protects=a sentence saying what the search didn't find, or what the other Documents don't say, is found in English and Chinese, marked when a Citation marker joins it to a quote, whether the marker sits before or after its stop; a plain cited fact and a footnote line are not found; fails_when=a joined sentence reads unmarked, an unmarked one reads marked, a Chinese one is missed, or a cited fact is counted; no_claim=every wording a model uses, which the report's list is read for by hand.
  test("finds them in English and Chinese, and tells the marked ones", () => {
    const reply = [
      "The paper reports the energy used[^1], but the Passages I found don't give the amount.",
      "",
      "I didn't find the offset figures in the Passages I read.",
      "",
      "The only Document that covers it is “Demonstrations Not Weights”[^2].",
      "",
      "None of the other Documents mention it.",
      "",
      "论文给出了训练所用的能源[^1]，但我读到的段落里没有具体数量。",
      "",
      "其他文档里没有找到。",
      "",
      "- Recurrent layers need O(n) sequential steps.[^3]",
      "",
      "[^1]: Weighted Keys Shorter Paths, p. 4",
    ].join("\n");
    expect(notFoundSentences(reply)).toEqual([
      {
        sentence:
          "The paper reports the energy used, but the Passages I found don't give the amount.",
        marked: true,
        otherDocuments: false,
      },
      {
        sentence: "I didn't find the offset figures in the Passages I read.",
        marked: false,
        otherDocuments: false,
      },
      {
        sentence: "The only Document that covers it is “Demonstrations Not Weights”.",
        marked: true,
        otherDocuments: true,
      },
      { sentence: "None of the other Documents mention it.", marked: false, otherDocuments: true },
      {
        sentence: "论文给出了训练所用的能源，但我读到的段落里没有具体数量。",
        marked: true,
        otherDocuments: false,
      },
      { sentence: "其他文档里没有找到。", marked: false, otherDocuments: true },
    ]);
  });

  // protects=the count by model and language gives the Answers, those that say what wasn't found, the marked ones apart from those about the other Documents, and lists each sentence; fails_when=a marked sentence about the other Documents is counted as a joined gap, or an Answer with none is counted as saying one; no_claim=none beyond protects.
  test("counts them by model and language", () => {
    const lines = notFoundLines([
      {
        ...at,
        notFound: [
          { sentence: "I didn't find the amount.", marked: true, otherDocuments: false },
          { sentence: "Only this one covers it.", marked: true, otherDocuments: true },
        ],
      },
      { ...at, notFound: [] },
      {
        ...at,
        language: "zh-CN",
        notFound: [{ sentence: "其他文档里没有找到。", marked: false, otherDocuments: true }],
      },
    ]).join("\n");
    expect(lines).toContain("| anthropic/claude-haiku-5-5 | en | 2 | 1 | 2 | 1 | 1 | 1 |");
    expect(lines).toContain("| anthropic/claude-haiku-5-5 | zh-CN | 1 | 1 | 1 | 0 | 1 | 0 |");
    expect(lines).toContain(
      "- research-attention-long (anthropic/claude-haiku-5-5) **marked**, about the other Documents: Only this one covers it.",
    );
  });
});

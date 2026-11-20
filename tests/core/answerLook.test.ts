/**
 * Before an Answer's sentence settles as Unsupported, its check looks in the Answer's scope for
 * the part its Citations don't cover (#3020, #2809), on a scripted model: what the User sees in
 * the Answer, and in a Note made from it.
 */
import { describe, expect, test } from "vitest";
import { CITATION_NODE, CLAIM_CHECK_MARK, type Core, type MarkedCitation } from "../../src/core";
import { pageBlocks, withAnswerChecks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { answeringModel, batchReply } from "../helpers/answerJudging";
import { isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import {
  answerEnded,
  answerJudged,
  type SourceFile,
  setUpWithDocuments,
} from "../helpers/citations";
import type { GenerateCall, ModelCall } from "../helpers/models";
import { para, pptxOf, sp, txBody } from "../helpers/pptx";

const slide = (...lines: string[]) => ({
  shapes: sp({
    id: 2,
    name: "Body",
    txBox: true,
    body: txBody(lines.map((line) => para(line)).join("")),
  }),
});

const AGE = "Our two kilns are fourteen years old.";
const SUPPLIER = "Supplier: Hartwell Kilns";
const OTHER_SUPPLIER = "Supplier: Northfield Clay";
const AGE_ZH = "我们的两台窑炉已经用了十四年。";
const SUPPLIER_ZH = "供应商：哈特韦尔窑炉公司";
const OTHER_SUPPLIER_ZH = "供应商：北田陶土公司";
const COST = "Cost: £185,000 for two K9 kilns, installed";
const OLD = "Our two kilns are 14 years old.";
const DUE = "Our two kilns are due for replacement.";

const kilns: SourceFile = {
  name: "Kilns.pptx",
  contents: pptxOf({ slides: [slide(AGE, AGE_ZH)] }),
};
const supply = (...lines: string[]): SourceFile => ({
  name: "Supply.md",
  contents: `${lines.join("\n\n")}\n`,
});
const plan = (second: string): SourceFile => ({
  name: "Kiln upgrade plan.pptx",
  contents: pptxOf({ slides: [slide("Why upgrade now", second), slide("The plan", COST)] }),
});

interface Asked {
  core: Core;
  answer: Awaited<ReturnType<typeof answerJudged>>;
  /** The sentences a check Run looked for in the scope, in the order they began. */
  looked: string[];
  batches: GenerateCall[];
  judging: { failing: boolean };
}

/**
 * `answer` asked in the assistant, citing `quotes` as markers 1, 2…: every sentence's batch reads
 * Unsupported with `says`, and the look in the scope reads each as `looks` say.
 */
async function asked(
  answer: string,
  quotes: readonly string[],
  looks: Record<string, Plan>,
  files: readonly SourceFile[],
  {
    query = "kilns supplier 窑炉 供应商",
    says = "The Passage doesn't say it.",
    scope,
  }: {
    query?: string;
    says?: string;
    scope?: (core: Core) => Promise<string[]>;
  } = {},
): Promise<Asked> {
  const calls: ModelCall[] = [];
  const batches: GenerateCall[] = [];
  const judging = { failing: false };
  const unsupported = Object.fromEntries(
    Object.keys(looks).map((sentence) => [sentence, { verdict: "unsupported" as const, says }]),
  );
  const { core } = await setUpWithDocuments(
    answeringModel(query, answer, quotes, looks, {
      calls,
      judge: (call) => {
        batches.push(call);
        if (judging.failing) throw new Error("The model is unavailable.");
        return batchReply(call, unsupported);
      },
    }),
    files,
  );
  const documentIds = await scope?.(core);
  const started = await core.askInConversation({
    text: "Who supplies the kilns?",
    ...(documentIds && { scope: { folderIds: [], tagIds: [], documentIds } }),
  });
  if (!started.asked) throw new Error("Not asked.");
  await answerEnded(core, started.answerId);
  const judged = await answerJudged(core, started.conversation.id, started.answerId);
  const looked = [...new Set(calls.filter(isCheckRun).map(sentenceOf))];
  return { core, answer: judged, looked, batches, judging };
}

const shown = (citations: readonly MarkedCitation[]) =>
  citations.map(({ marker, quote, check, verdict, foundByCheck, passedAt, documentName }) => ({
    marker,
    documentName,
    quote,
    check,
    ...(verdict && { verdict }),
    ...(foundByCheck && { foundByCheck }),
    ...(passedAt && { passedAt }),
  }));

const citationNodes = (blocks: readonly NodeJSON[]): NodeJSON[] =>
  blocks.flatMap((block) => [
    ...(block.type === CITATION_NODE ? [block] : []),
    ...citationNodes(block.content ?? []),
  ]);

describe("An Answer's sentence its Citations don't cover finds its Passage in the Answer's scope (#3020)", {
  timeout: 60_000,
}, () => {
  const CASES = [
    {
      name: "English, the part in another Document",
      text: "The kilns are supplied by Hartwell Kilns[^1].",
      sentence: "The kilns are supplied by Hartwell Kilns.",
      cites: AGE,
      found: SUPPLIER,
      foundIn: "Supply",
      cited: "Kilns",
      files: [kilns, supply(SUPPLIER, SUPPLIER_ZH)],
      without: [kilns, supply(OTHER_SUPPLIER, OTHER_SUPPLIER_ZH)],
      near: OTHER_SUPPLIER,
    },
    {
      name: "Chinese, the part in another Document",
      text: "窑炉由哈特韦尔窑炉公司供应[^1]。",
      sentence: "窑炉由哈特韦尔窑炉公司供应。",
      cites: AGE_ZH,
      found: SUPPLIER_ZH,
      foundIn: "Supply",
      cited: "Kilns",
      files: [kilns, supply(SUPPLIER, SUPPLIER_ZH)],
      without: [kilns, supply(OTHER_SUPPLIER, OTHER_SUPPLIER_ZH)],
      near: OTHER_SUPPLIER_ZH,
    },
    {
      name: "the part in another Passage of the cited Document",
      text: "The two kilns are 14 years old[^1].",
      sentence: "The two kilns are 14 years old.",
      cites: COST,
      found: OLD,
      foundIn: "Kiln upgrade plan",
      cited: "Kiln upgrade plan",
      files: [plan(OLD)],
      without: [plan(DUE)],
      near: DUE,
    },
  ];

  // protects=an Answer's sentence its batch reads Unsupported, whose missing part a Passage in the Answer's scope states, reads Supported once the check that looked there says so: that Passage is a Citation of the sentence in the Answer's own numbers, marked as found by the check, and the ✓ stands at the old Citation and the new one together, in English and Chinese, in another Document and in another Passage of the cited one; fails_when=the sentence stays Unsupported, the ✓ stands at the old Citation alone, the found Passage is not cited or carries no mark saying a check found it; no_claim=what a real model's check reads, which the pull request's real-model run gives.
  test.each(CASES)("$name: the sentence passes with the found Passage cited", async (each) => {
    const { answer, looked } = await asked(
      each.text,
      [each.cites],
      { [each.sentence]: { verdict: "supported", quote: each.found, says: each.found } },
      each.files,
    );

    expect(looked).toEqual([each.sentence]);
    expect(answer.text).toBe(each.text.replace("[^1]", "[^1][^2]"));
    expect(shown(answer.citations)).toEqual([
      {
        marker: 1,
        documentName: each.cited,
        quote: each.cites,
        check: "found",
        passedAt: [0],
      },
      {
        marker: 2,
        documentName: each.foundIn,
        quote: each.found,
        check: "found",
        foundByCheck: true,
        passedAt: [1],
      },
    ]);
  });

  // protects=the same sentences, where the scope holds a Passage on the same subject that doesn't state the part (another supplier, no age), stay Unsupported with the line their batch gave, and nothing is added to the Answer, though the check that looked cited that Passage; fails_when=a Passage the check cited while reading Unsupported becomes a Citation, the sentence gets a ✓, or its line is replaced; no_claim=that a real model reads these Unsupported.
  test.each(CASES)("$name: with no Passage stating the part it stays Unsupported", async (each) => {
    const says = "The Passage doesn't name the supplier.";
    const { answer, looked } = await asked(
      each.text,
      [each.cites],
      { [each.sentence]: { verdict: "unsupported", quote: each.near } },
      each.without,
      { says },
    );

    expect(looked).toEqual([each.sentence]);
    expect(answer.text).toBe(each.text);
    expect(shown(answer.citations)).toEqual([
      {
        marker: 1,
        documentName: each.cited,
        quote: each.cites,
        check: "unsupported",
        verdict: says,
      },
    ]);
  });

  // protects=the verdict over what the look finds is the check's own: where a Passage in scope states the part and the check that read it still says Unsupported, the sentence stays Unsupported with its line and gets no Citation; fails_when=code turns the verdict to Supported because a Passage was found; no_claim=whether the check should have read it Supported.
  test("a Passage that states the part changes nothing when the check still reads Unsupported", async () => {
    const [english] = CASES;
    if (!english) throw new Error("No case.");
    const { answer } = await asked(
      english.text,
      [english.cites],
      { [english.sentence]: { verdict: "unsupported", quote: english.found } },
      english.files,
    );

    expect(answer.text).toBe(english.text);
    expect(shown(answer.citations)).toEqual([
      expect.objectContaining({
        marker: 1,
        check: "unsupported",
        verdict: "The Passage doesn't say it.",
      }),
    ]);
  });

  // protects=the look reads only where the Answer was allowed to: with the Question limited to the cited Document, a Document outside that scope that states the part is never shown to the check and never becomes a Citation, and the sentence stays Unsupported; fails_when=a Passage of a Document outside the Answer's scope is cited or shown to the check; no_claim=walled Folders, which the scope's own tests cover.
  test("a Document outside the Answer's scope never becomes a Citation", async () => {
    const [english] = CASES;
    if (!english) throw new Error("No case.");
    const seen: string[] = [];
    const { answer, looked } = await asked(
      english.text,
      [english.cites],
      {
        [english.sentence]: {
          reply: (call) => {
            seen.push(call.results.map((result) => result.text).join("\n"));
            return { text: "Verdict: unsupported\nAbsence: no" };
          },
        },
      },
      english.files,
      {
        scope: async (core) =>
          (await core.listDocuments())
            .filter((each) => each.name === "Kilns")
            .map((each) => each.id),
      },
    );

    expect(looked).toEqual([english.sentence]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join("\n")).not.toContain(SUPPLIER);
    expect(answer.text).toBe(english.text);
    expect(shown(answer.citations)).toEqual([
      expect.objectContaining({ marker: 1, check: "unsupported" }),
    ]);
  });

  // protects=at most three of an Answer's sentences take the look, the first three in the Answer's order, and a fourth reads as its batch read it though the scope states its part; fails_when=a fourth sentence is looked for, or the three are not the Answer's first; no_claim=that three is the right cap for every Answer, which the real-model run reports.
  test("only the Answer's first three Unsupported sentences are looked for", async () => {
    const sentences = [
      "The kilns are supplied by Hartwell Kilns.",
      "Hartwell Kilns supplies both kilns.",
      "The supplier of the kilns is Hartwell Kilns.",
      "Both kilns come from Hartwell Kilns.",
    ];
    const supported: Plan = { verdict: "supported", quote: SUPPLIER, says: SUPPLIER };
    const { answer, looked } = await asked(
      sentences.map((sentence, index) => sentence.replace(/\.$/, `[^${index + 1}].`)).join(" "),
      [AGE, AGE, AGE, AGE],
      Object.fromEntries(sentences.map((sentence) => [sentence, supported])),
      [kilns, supply(SUPPLIER)],
    );

    expect([...looked].sort()).toEqual(sentences.slice(0, 3).sort());
    expect(answer.citations.filter((each) => each.foundByCheck).map((each) => each.quote)).toEqual([
      SUPPLIER,
    ]);
    const last = answer.citations.find(
      (each) => each.quote === AGE && each.check === "unsupported",
    );
    expect(last).toMatchObject({ check: "unsupported", verdict: "The Passage doesn't say it." });
    expect(answer.text).toMatch(/Both kilns come from Hartwell Kilns\[\^\d\]\.$/);
  });

  // protects=when the look fails (its model errors), the sentence reads as its batch read it, Unsupported with its line, and nothing is added; fails_when=a failed look leaves the Citation checking or Not checked, or takes the batch's line away; no_claim=which provider errors a real look meets.
  test("a look that fails leaves the sentence as its Citations read it", async () => {
    const [english] = CASES;
    if (!english) throw new Error("No case.");
    const { answer } = await asked(
      english.text,
      [english.cites],
      {
        [english.sentence]: {
          reply: () => {
            throw new Error("The model is unavailable.");
          },
        },
      },
      english.files,
    );

    expect(answer.text).toBe(english.text);
    expect(shown(answer.citations)).toEqual([
      expect.objectContaining({
        marker: 1,
        check: "unsupported",
        verdict: "The Passage doesn't say it.",
      }),
    ]);
  });

  // protects=Check again takes the same step: a sentence Not checked because its judgement failed, judged again, is looked for in the scope and shows what a first check shows, the found Passage cited and marked; fails_when=Check again settles the sentence Unsupported without the look; no_claim=an Answer whose Citations are already judged, which Check again isn't offered for.
  test("Check again looks in the scope as a first check does", async () => {
    const [english] = CASES;
    if (!english) throw new Error("No case.");
    const calls: ModelCall[] = [];
    const judging = { failing: true };
    const { core } = await setUpWithDocuments(
      answeringModel(
        "kilns supplier",
        english.text,
        [english.cites],
        { [english.sentence]: { verdict: "supported", quote: english.found, says: english.found } },
        {
          calls,
          judge: (call) => {
            if (judging.failing) throw new Error("The model is unavailable.");
            return batchReply(call, {});
          },
        },
      ),
      english.files,
    );
    const started = await core.askInConversation({ text: "Who supplies the kilns?" });
    if (!started.asked) throw new Error("Not asked.");
    await answerEnded(core, started.answerId);
    const ids = { conversationId: started.conversation.id, answerId: started.answerId };
    const first = await answerJudged(core, ids.conversationId, ids.answerId);
    judging.failing = false;
    await core.checkAnswerAgain(ids);
    const again = await answerJudged(core, ids.conversationId, ids.answerId);

    expect(first.citations.map((each) => each.check)).toEqual(["not-checked"]);
    expect(again.text).toBe(english.text.replace("[^1]", "[^1][^2]"));
    expect(shown(again.citations)).toEqual([
      expect.objectContaining({ marker: 1, check: "found", passedAt: [0] }),
      expect.objectContaining({
        marker: 2,
        quote: english.found,
        foundByCheck: true,
        passedAt: [1],
      }),
    ]);
  });

  // protects=a Note made from the Answer carries the found Passage as a Citation that says a check found it, beside the one the Answer's writer gave; fails_when=the Note drops the found Citation or its mark; no_claim=how the Note's card words it, which the card's own tests cover.
  test("a Note made from the Answer carries the found Citation and its mark", async () => {
    const [english] = CASES;
    if (!english) throw new Error("No case.");
    const { answer } = await asked(
      english.text,
      [english.cites],
      { [english.sentence]: { verdict: "supported", quote: english.found, says: english.found } },
      english.files,
    );

    const cited = citationNodes(pageBlocks(answer)).map((node) => ({
      quote: node.attrs?.quote,
      foundByCheck: node.attrs?.foundByCheck ?? null,
    }));

    expect(cited).toEqual([
      { quote: english.cites, foundByCheck: null },
      { quote: english.found, foundByCheck: true },
    ]);
  });
});

/** The checks a Note made from `answer` carries, one for each sentence. */
function carriedChecks(answer: Asked["answer"], question = "Who supplies the kilns?") {
  const marks = new Map<string, Record<string, unknown>>();
  const collect = (nodes: readonly NodeJSON[]) => {
    for (const node of nodes) {
      for (const mark of node.marks ?? []) {
        if (mark.type === CLAIM_CHECK_MARK && mark.attrs)
          marks.set(String(mark.attrs.id), mark.attrs);
      }
      collect(node.content ?? []);
    }
  };
  collect(withAnswerChecks(pageBlocks(answer), answer, null));
  return [...marks.values()];
}

describe("A sentence still Unsupported after the look says what the Documents don't state (#2809)", {
  timeout: 60_000,
}, () => {
  const LIST = {
    text: "The kilns are fourteen years old, are supplied by Hartwell Kilns and were built in Leeds[^1].",
    sentence:
      "The kilns are fourteen years old, are supplied by Hartwell Kilns and were built in Leeds.",
    cites: AGE,
  };
  const SAYS = "The quote gives the kilns' age only.";

  // protects=a sentence the look never read (its look failed) carries a check that says its judgement read only its Citations, with the batch's line as the reason and no part named, and no Citation as what the Documents say instead; fails_when=the carried check claims the scope was searched, names parts no check found, or keeps the Citation as evidence; no_claim=the card's wording, which the smoke spec shows.
  test("a sentence only its batch read carries a check of its Citations alone", async () => {
    const { answer } = await asked(
      LIST.text,
      [LIST.cites],
      {
        [LIST.sentence]: {
          reply: () => {
            throw new Error("The model is unavailable.");
          },
        },
      },
      [kilns, supply(SUPPLIER)],
      { says: SAYS },
    );

    expect(answer.citations[0]).toMatchObject({ check: "unsupported", verdict: SAYS });
    expect(answer.citations[0]).not.toHaveProperty("searchedScope");
    expect(answer.citations[0]).not.toHaveProperty("unstated");
    const [carried] = carriedChecks(answer);
    expect(carried).toMatchObject({
      state: "unsupported",
      evidence: null,
      unsupported: { reason: SAYS, covered: null, uncovered: null, found: true },
      citedOnly: true,
    });
    expect(carried?.unsupported).not.toHaveProperty("missing");
  });

  // protects=a sentence the look passed carries a Supported check that rests on a Citation and doesn't say only Citations were read, since the scope was searched; fails_when=a looked sentence's carried check says it read only its Citations, or a passed sentence loses its evidence; no_claim=a sentence its batch passed with no look, whose check read only its Citations (the test below).
  test("a sentence the look passed carries a check that searched the scope", async () => {
    const sentence = "The kilns are supplied by Hartwell Kilns.";
    const { answer } = await asked(
      "The kilns are supplied by Hartwell Kilns[^1].",
      [AGE],
      { [sentence]: { verdict: "supported", quote: SUPPLIER, says: SUPPLIER } },
      [kilns, supply(SUPPLIER)],
    );

    const [carried] = carriedChecks(answer);
    expect(carried).toMatchObject({ state: "supported", evidence: { quote: AGE } });
    expect(carried).not.toHaveProperty("citedOnly");
  });
});

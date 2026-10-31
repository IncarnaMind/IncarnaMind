import { utimes } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  type CitationAttributes,
  type ClaimCheckResult,
  CONTENT_SCHEMA_VERSION,
  MIND_CONTENT_FIELD,
} from "../../src/core";
import { readVerdict } from "../../src/core/answers/checks/prompt";
import { markedSentences } from "../../src/core/answers/checks/sentences";
import { readClaimCheck, restsOn } from "../../src/shared/claimChecks";
import {
  checkGenerate,
  checkingModel,
  checkReply,
  type Plan,
  requestedFigures,
} from "../helpers/checks";
import { type SourceFile, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { writeMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";

const CLAIM = "The rate is 36.8%.";
const QUOTE = "The rate is 38.6%.";
const REPORT = { name: "Report.md", contents: QUOTE };
const correctionLines = (from = "36.8%", to = "38.6%") =>
  `The report gives another rate.\nChange 1: ${from}\nTo 1: ${to}`;
const correctionIn = (result: ClaimCheckResult) =>
  result.verdict === "not-checked" ? undefined : result.correction;
const contradicted = (says = correctionLines()): Plan => ({
  verdict: "contradicted",
  quote: QUOTE,
  says,
});

async function checkWith(
  plan: Plan,
  claim = CLAIM,
  files: readonly SourceFile[] = [REPORT],
): Promise<ClaimCheckResult> {
  const { core } = await setUpWithDocuments(checkingModel({ [claim]: plan }), files);
  return core.checkClaim({ claim });
}

async function markWith(plan: Plan, claim = CLAIM, files: readonly SourceFile[] = [REPORT]) {
  const { core, client, mind } = await setUpWithDocuments(checkingModel({ [claim]: plan }), files);
  const block = {
    type: "paragraph",
    attrs: { id: "correction-block" },
    content: [{ type: "text", text: claim }],
  };
  writeMind(client, [block]);
  await client.settled();
  await core.checkSentences({
    requestId: "correction-request",
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "correction-block", offset: 0 },
    to: { blockId: "correction-block", offset: claim.length },
  });
  const { state } = await core.openMind(mind.id);
  const reopened = new Y.Doc();
  Y.applyUpdate(reopened, state);
  const [marked] = markedSentences(reopened.getXmlFragment(MIND_CONTENT_FIELD));
  if (!marked) throw new Error("The checked sentence has no mark.");
  return marked.check;
}

describe("A correction in a check reply", () => {
  test("parses the exact old substring and each Document wording with its Citation marker", () => {
    const read = readVerdict(
      [
        "Verdict: contradicted",
        "Scope: none, same",
        "Topic: found",
        "Roles: none, same",
        "The Documents give other rates.",
        "Change 1: 36.8%",
        "To 1: 38.6% [^1]",
        "Change 2: 36.8%",
        "To 2: 39.4% [^2]",
      ].join("\n"),
    );

    expect(read?.says).toBe("The Documents give other rates.");
    expect(read?.correction).toEqual({
      from: "36.8%",
      choices: [
        { wording: "38.6%", marker: 1 },
        { wording: "39.4%", marker: 2 },
      ],
    });
  });

  test("takes each choice's marker from the quote its To line ends with", () => {
    const read = readVerdict(
      [
        "Verdict: contradicted",
        "The Documents give other rates. [^3][^4]",
        "Change 1: 36.8%",
        "To 1: 38.6% [^4]",
        "Change 2: 36.8%",
        "To 2: 39.4% [^3]",
      ].join("\n"),
    );

    expect(read?.correction?.choices).toEqual([
      { wording: "38.6%", marker: 4 },
      { wording: "39.4%", marker: 3 },
    ]);
  });

  test.each([
    {
      language: "English",
      says: "The minutes say the committee rejected the growth strategy.",
      fields: 'Change 1: "adopted the growth strategy" To 1: "rejected the growth strategy" [^2]',
      from: "adopted the growth strategy",
      wording: "rejected the growth strategy",
    },
    {
      language: "Chinese",
      says: "纪要说委员会否决了增长战略。",
      fields: "Change 1: 「采纳了增长战略」 To 1: 「否决了增长战略」 [^2]",
      from: "采纳了增长战略",
      wording: "否决了增长战略",
    },
  ])("reads $language fields written after the sentence, in quotation marks", (each) => {
    const read = readVerdict(`Verdict: contradicted\nTopic: found\n${each.says} ${each.fields}`);

    expect(read?.says).toBe(each.says);
    expect(read?.correction).toEqual({
      from: each.from,
      choices: [{ wording: each.wording, marker: 2 }],
    });
  });

  test("reads old words that hold “to 1:” as words, not a field", () => {
    const read = readVerdict(
      "Verdict: contradicted\nThe report gives 3 to 1.\nChange 1: rose to 1: 2\nTo 1: rose to 3: 1",
    );

    expect(read?.correction).toEqual({
      from: "rose to 1: 2",
      choices: [{ wording: "rose to 3: 1", marker: 1 }],
    });
  });

  test.each([
    ["a To line is missing", "Change 1: 36.8%"],
    [
      "the second old substring differs",
      "Change 1: 36.8%\nTo 1: 38.6%\nChange 2: 37.2%\nTo 2: 39.4%",
    ],
    ["a third choice is given", "Change 1: 36.8%\nTo 1: 38.6%\nChange 3: 36.8%\nTo 3: 39.4%"],
    ["wording is empty", "Change 1: 36.8%\nTo 1: [^1]"],
  ])("is left unread when %s", (_case, lines) => {
    expect(
      readVerdict(`Verdict: contradicted\nThe report differs.\n${lines}`)?.correction,
    ).toBeUndefined();
  });

  test.each(["supported", "unsupported"] as const)("is ignored for %s", (verdict) => {
    expect(
      readVerdict(`Verdict: ${verdict}\nThe report differs.\n${correctionLines()}`)?.correction,
    ).toBeUndefined();
  });
});

describe("A correction from the public core", () => {
  test("keeps a short, finally confirmed contradiction's exact replacement", async () => {
    const result = await checkWith(contradicted());

    expect(result).toMatchObject({
      verdict: "contradicted",
      evidence: { quote: QUOTE, check: "found" },
      correction: {
        from: "36.8%",
        choices: [{ wording: "38.6%", evidence: { quote: QUOTE, check: "found" } }],
      },
    });
  });

  test("persists on the claim mark when the Mind is reopened", async () => {
    const marked = await markWith(contradicted());

    expect(marked.correction).toMatchObject({
      from: "36.8%",
      choices: [{ wording: "38.6%", evidence: { quote: QUOTE, check: "found" } }],
    });
    expect(marked.figures?.[0]?.correction).toEqual(marked.correction);
  });

  test("has none when a figure's deciding value differs from the correction", async () => {
    const quote = "Revenue was £21, previously £22.";
    const marked = await markWith(
      {
        ...contradicted("The report gives another value.\nChange 1: £20\nTo 1: £22"),
        quote,
        number: "£21",
      },
      "Revenue was £20.",
      [{ name: "Revenue.md", contents: quote }],
    );

    expect(marked.state).toBe("contradicted");
    expect(marked.correction).toBeUndefined();
  });

  test("has none when a replacement merely contains the deciding digits", async () => {
    const quote = "Revenue was 36.8%, previously 136.8%.";
    const marked = await markWith(
      {
        ...contradicted("The report gives another rate.\nChange 1: 20%\nTo 1: 136.8%"),
        quote,
        number: "36.8%",
      },
      "Revenue was 20%.",
      [{ name: "Revenue.md", contents: quote }],
    );

    expect(marked.state).toBe("contradicted");
    expect(marked.correction).toBeUndefined();
  });

  test("has none rather than attaching a later figure's correction to the first", async () => {
    const claim = "Revenue was £20 and profit was £30.";
    const quote = "Revenue was £21 and profit was £31.";
    const marked = await markWith(
      {
        verdict: "contradicted",
        quote,
        reply: (call) => {
          const searches = call.results.filter((result) => result.tool === "search_documents");
          if (searches.length === 0) {
            return { calls: [{ tool: "search_documents", input: { query: claim } }] };
          }
          if (!call.results.some((result) => result.tool === "cite")) {
            const passage = shownPassages(searches.at(-1)?.text ?? "").find((each) =>
              each.text.includes(quote),
            );
            if (!passage) throw new Error("The fixture has no result Passage.");
            return {
              calls: [
                {
                  tool: "cite",
                  input: { citations: [{ marker: 1, passage: passage.id, quote }] },
                },
              ],
            };
          }
          const items = requestedFigures(call).map(({ id, shown, reading }) => ({
            id,
            verdict: "contradicted",
            scope: "same",
            topic: "found",
            roles: "same",
            says: null,
            reading,
            relation: "equals",
            source: { citation: 1, number: shown === "£20" ? "£21" : "£31" },
            calculation: null,
          }));
          return {
            text: `Verdict: contradicted\nChange 1: £30\nTo 1: £31 [^1]\nFigures: ${JSON.stringify({ items, remainder: null })}`,
          };
        },
      },
      claim,
      [{ name: "Results.md", contents: quote }],
    );

    expect(marked.state).toBe("contradicted");
    expect(marked.correction).toBeUndefined();
  });

  test.each([
    ["is absent from the claim", CLAIM, correctionLines("37.2%")],
    [
      "occurs more than once",
      "The first rate is 36.8%; the second rate is 36.8%.",
      correctionLines(),
    ],
    ["equals the old substring", CLAIM, correctionLines("36.8%", "36.8%")],
  ])("has none when the old substring %s", async (_case, claim, says) => {
    const result = await checkWith(contradicted(says), claim);

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toBeUndefined();
  });

  test("has none when a replacement changes the claim's named period", async () => {
    const claim = "Gross margin fell to 36.8% in Q2, mostly in online.";
    const quote = "Gross margin fell to 38.6% in Q3, mostly in online.";
    const result = await checkWith(
      {
        ...contradicted(
          `The report gives another quarter.\nChange 1: 36.8% in Q2\nTo 1: 38.6% in Q3`,
        ),
        quote,
      },
      claim,
      [{ name: "Q3 results.md", contents: quote }],
    );
    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toBeUndefined();
  });

  test("has none when a replacement changes a period outside the old substring", async () => {
    const claim = "Gross margin fell to 36.8% in Q2, mostly in online.";
    const quote = "Gross margin fell to 38.6% in Q3, mostly in online.";
    const result = await checkWith(
      {
        ...contradicted(`The report gives another quarter.\n${correctionLines()}`),
        quote,
      },
      claim,
      [{ name: "Q3 results.md", contents: quote }],
    );

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toBeUndefined();
  });

  test("has none when a replacement duplicates the surrounding English period", async () => {
    const claim = "Gross margin fell to 36.8% in Q2.";
    const quote = "Gross margin fell to 38.6% in Q2.";
    const result = await checkWith(
      {
        ...contradicted("The report gives another rate.\nChange 1: 36.8%\nTo 1: 38.6% in Q2"),
        quote,
      },
      claim,
      [{ name: "Q2 results.md", contents: quote }],
    );

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toBeUndefined();
  });

  test("has none when a replacement duplicates the surrounding Chinese period", async () => {
    const claim = "第二季度毛利率降至36.8%。";
    const quote = "毛利率降至38.6%（第二季度）。";
    const result = await checkWith(
      {
        ...contradicted("报告给出另一个季度。\nChange 1: 36.8%\nTo 1: 38.6%（第二季度）"),
        quote,
      },
      claim,
      [{ name: "第二季度业绩.md", contents: quote }],
    );

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toBeUndefined();
  });

  test("has none when a Chinese replacement's Citation changes the surrounding period", async () => {
    const claim = "第二季度毛利率降至36.8%。";
    const quote = "第三季度毛利率降至38.6%。";
    const result = await checkWith(
      {
        ...contradicted(`报告给出另一个季度。\n${correctionLines()}`),
        quote,
      },
      claim,
      [{ name: "第三季度业绩.md", contents: quote }],
    );

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toBeUndefined();
  });

  test("has none when the replacement is absent from its Citation", async () => {
    const result = await checkWith(
      contradicted("The report gives another rate.\nChange 1: 36.8%\nTo 1: 39.4%"),
    );

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toBeUndefined();
  });

  test("has none when a Chinese replacement changes the named period", async () => {
    const claim = "第二季度毛利率降至36.8%。";
    const quote = "第三季度毛利率降至38.6%。";
    const result = await checkWith(
      {
        ...contradicted(`报告给出另一个季度。\nChange 1: 第二季度\nTo 1: 第三季度`),
        quote,
      },
      claim,
      [{ name: "第三季度业绩.md", contents: quote }],
    );

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toBeUndefined();
  });

  test("allows a long replacement that adds detail without changing a named period", async () => {
    const claim = "The committee adopted the old strategy.";
    const quote =
      "The committee adopted the 2026 liquidity and capital preservation strategy after a full risk review.";
    const result = await checkWith(
      {
        ...contradicted(
          `The report gives the new strategy.\nChange 1: old strategy\nTo 1: ${quote}`,
        ),
        quote,
      },
      claim,
      [{ name: "Committee.md", contents: quote }],
    );

    expect(result).toMatchObject({
      verdict: "contradicted",
      correction: { from: "old strategy", choices: [{ wording: quote }] },
    });
  });

  test.each([
    {
      language: "English",
      claim: "The committee adopted the growth strategy.",
      quote: "The committee rejected the growth strategy.",
      part: "adopted the growth strategy",
      wording: "rejected the growth strategy",
    },
    {
      language: "Chinese",
      claim: "委员会采纳了增长战略。",
      quote: "委员会否决了增长战略。",
      part: "采纳了增长战略",
      wording: "否决了增长战略",
    },
  ])(
    "changes only the contradicted part of a $language sentence, never all of it",
    async (each) => {
      const check = (from: string, to: string) =>
        checkWith(
          {
            ...contradicted(`The minutes differ.\nChange 1: ${from}\nTo 1: ${to}`),
            quote: each.quote,
          },
          each.claim,
          [{ name: "Minutes.md", contents: each.quote }],
        );

      const part = await check(each.part, each.wording);
      const whole = await check(each.claim, each.quote);

      expect(part).toMatchObject({
        verdict: "contradicted",
        correction: { from: each.part, choices: [{ wording: each.wording }] },
      });
      expect(whole.verdict).toBe("contradicted");
      expect(correctionIn(whole)).toBeUndefined();
    },
  );

  test("keeps a replacement in the same named period", async () => {
    const claim = "Gross margin fell to 36.8% in Q2, mostly in online.";
    const quote = "Gross margin fell to 38.6% in Q2, mostly in online.";
    const result = await checkWith(
      {
        ...contradicted(`The report gives another rate.\nChange 1: 36.8% in Q2\nTo 1: 38.6% in Q2`),
        quote,
      },
      claim,
      [{ name: "Q2 results.md", contents: quote }],
    );

    expect(result).toMatchObject({
      verdict: "contradicted",
      correction: { from: "36.8% in Q2", choices: [{ wording: "38.6% in Q2" }] },
    });
  });

  test("keeps a numeric replacement whose Citation names the same surrounding period", async () => {
    const claim = "Gross margin fell to 36.8% in Q2, mostly in online.";
    const quote = "Gross margin fell to 38.6% in Q2, mostly in online.";
    const result = await checkWith(
      {
        ...contradicted(`The report gives another rate.\n${correctionLines()}`),
        quote,
      },
      claim,
      [{ name: "Q2 results.md", contents: quote }],
    );

    expect(result).toMatchObject({
      verdict: "contradicted",
      correction: { from: "36.8%", choices: [{ wording: "38.6%" }] },
    });
  });

  test("has none when a second choice has no found Citation", async () => {
    const result = await checkWith(
      contradicted(
        "The reports differ.\nChange 1: 36.8%\nTo 1: 38.6% [^1]\nChange 2: 36.8%\nTo 2: 39.4% [^2]",
      ),
    );

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toBeUndefined();
  });

  test.each(["supported", "unsupported"] as const)("has none for %s", async (verdict) => {
    const result = await checkWith({ verdict, quote: QUOTE, says: correctionLines() });

    expect(result.verdict).toBe(verdict);
    expect(correctionIn(result)).toBeUndefined();
  });

  test.each(["same", "neither"] as const)(
    "has none when the contradiction is not finally confirmed (%s)",
    async (judgement) => {
      const claim = "Harbours publish the times of high water every year in January.";
      const quote = "Harbours publish the times of high water every year.";
      const result = await checkWith(
        {
          verdict: "contradicted",
          quote,
          says: "The report gives the yearly times, not the month.\nCovered: the yearly times\nNot covered: January\nChange 1: every year in January\nTo 1: every year",
          judgement: judgement === "same" ? "same" : "conflict",
          strict: {
            text: "Sentence: in January\nQuote: not stated\nJudgement: neither",
          },
        },
        claim,
        [{ name: "Tides.md", contents: quote }],
      );

      expect(result.verdict).toBe("unsupported");
      expect(correctionIn(result)).toBeUndefined();
    },
  );
});

/** A Run that names `parts` in its first turn, then checks each part as `plans` say. */
function partsModel(plans: Record<string, Plan>, parts: readonly string[]) {
  return scriptedModel(
    (call) => {
      const reply = checkReply(call, plans);
      const first = !call.results.some((result) => result.tool === "search_documents");
      if (!first || !call.system.includes("Parts:")) return reply;
      return {
        ...reply,
        text: `Parts: ${JSON.stringify(parts.map((text) => ({ kind: "fact", text })))}`,
      };
    },
    { generate: checkGenerate(plans) },
  );
}

describe("A correction in a sentence of several parts", () => {
  const SENTENCE = "The rate is 36.8%, and the board approved the plan.";
  const RATE = "The rate is 36.8%";
  const BOARD = "the board approved the plan";
  const MINUTES = "The board approved the plan.";

  async function checkParts(board: Plan): Promise<ClaimCheckResult> {
    const { core } = await setUpWithDocuments(
      partsModel({ [RATE]: contradicted(), [BOARD]: board }, [RATE, BOARD]),
      [
        REPORT,
        { name: "Minutes.md", contents: MINUTES },
        { name: "Vote.md", contents: "The board rejected the plan." },
      ],
    );
    return core.checkClaim({ claim: SENTENCE });
  }

  test("is each contradicted part's own, the first the sentence's", async () => {
    const result = await checkParts({
      ...contradicted("The minutes say the board rejected it.\nChange 1: approved\nTo 1: rejected"),
      quote: "The board rejected the plan.",
    });

    expect(result).toMatchObject({
      verdict: "contradicted",
      correction: { from: "36.8%", choices: [{ wording: "38.6%" }] },
      parts: [
        { verdict: "contradicted", correction: { from: "36.8%" } },
        {
          verdict: "contradicted",
          correction: { from: "approved", choices: [{ wording: "rejected" }] },
        },
      ],
    });
  });

  test("stays on its part beside a supported or unsupported one", async () => {
    const supported = await checkParts({ verdict: "supported", quote: MINUTES });
    const unsupported = await checkParts({ verdict: "unsupported" });

    for (const [result, other] of [
      [supported, "supported"],
      [unsupported, "unsupported"],
    ] as const) {
      expect(result).toMatchObject({
        verdict: "contradicted",
        correction: { from: "36.8%" },
        parts: [{ verdict: "contradicted", correction: { from: "36.8%" } }, { verdict: other }],
      });
      expect(result.parts?.[1]?.correction).toBeUndefined();
    }
  });
});

interface ConflictCase {
  claim: string;
  reply: string;
  citations: readonly { marker: 1 | 2; quote: string }[];
  files: readonly SourceFile[];
  dates: readonly string[];
}

function conflictModel(input: ConflictCase) {
  return scriptedModel(
    (call) => {
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: input.claim } }] };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const passages = shownPassages(searches.at(-1)?.text ?? "");
        const citations = input.citations.map((citation) => {
          const passage = passages.find((each) => each.text.includes(citation.quote));
          if (!passage) throw new Error(`No Passage holds ${citation.quote}`);
          return { ...citation, passage: passage.id };
        });
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return { text: input.reply };
    },
    { generate: checkGenerate({}) },
  );
}

async function checkConflict(input: ConflictCase): Promise<{
  result: ClaimCheckResult;
  documentIds: string[];
}> {
  const model = conflictModel(input);
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const paths = await Promise.all(
    input.files.map((file) => writeSourceFile(sources, file.name, file.contents)),
  );
  await Promise.all(
    paths.map((path, index) => {
      const date = new Date(input.dates[index] ?? "2026-01-01T00:00:00.000Z");
      return utimes(path, date, date);
    }),
  );
  const documents = await addAndProcess(core, paths);
  const result = await core.checkClaim({ claim: input.claim });
  return { result, documentIds: documents.map((document) => document.id) };
}

const conflictReply = (first: string, second: string, from = "36.8%") =>
  [
    "Verdict: contradicted",
    "Scope: none, same",
    "Topic: found",
    "Roles: none, same",
    "The Documents give other rates.",
    `Change 1: ${from}`,
    `To 1: ${first} [^1]`,
    `Change 2: ${from}`,
    `To 2: ${second} [^2]`,
  ].join("\n");

describe("Conflicting Documents' correction choices", () => {
  test("the newest Document supplies the existing evidence and the first choice", async () => {
    const old = "The rate is 38.6%.";
    const newer = "The rate is 39.4%.";
    const { result, documentIds } = await checkConflict({
      claim: CLAIM,
      reply: conflictReply("38.6%", "39.4%"),
      citations: [
        { marker: 1, quote: old },
        { marker: 2, quote: newer },
      ],
      files: [
        { name: "Old.md", contents: old },
        { name: "New.md", contents: newer },
      ],
      dates: ["2025-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    });
    const [oldId, newId] = documentIds;

    expect(result).toMatchObject({
      verdict: "contradicted",
      evidence: { documentId: newId, quote: newer },
      correction: {
        from: "36.8%",
        choices: [
          { wording: "39.4%", evidence: { documentId: newId, quote: newer } },
          { wording: "38.6%", evidence: { documentId: oldId, quote: old } },
        ],
      },
    });
  });

  test("Chinese choices keep their original marker order when Document dates tie", async () => {
    const first = "增长率为38.6%。";
    const second = "增长率为39.4%。";
    const { result, documentIds } = await checkConflict({
      claim: "增长率为36.8%。",
      reply: conflictReply("38.6%", "39.4%"),
      citations: [
        { marker: 1, quote: first },
        { marker: 2, quote: second },
      ],
      files: [
        { name: "报告一.md", contents: first },
        { name: "报告二.md", contents: second },
      ],
      dates: ["2026-02-03T00:00:00.000Z", "2026-02-03T00:00:00.000Z"],
    });
    const [firstId, secondId] = documentIds;

    expect(result).toMatchObject({
      verdict: "contradicted",
      evidence: { documentId: firstId },
      correction: {
        from: "36.8%",
        choices: [
          { wording: "38.6%", evidence: { documentId: firstId } },
          { wording: "39.4%", evidence: { documentId: secondId } },
        ],
      },
    });
  });
});

const evidence = (documentId: string): CitationAttributes => ({
  passageId: `passage-${documentId}`,
  documentId,
  documentName: documentId,
  contentHash: `hash-${documentId}`,
  pageFrom: null,
  pageTo: null,
  location: null,
  quote: `Quote ${documentId}`,
  check: "found",
  checkReason: null,
});

describe("A correction persisted on a claim mark", () => {
  test("reads with every choice's evidence in what the result rests on", () => {
    const first = evidence("first");
    const second = evidence("second");
    const check = readClaimCheck({
      id: "check-1",
      state: "contradicted",
      evidence: first,
      correction: {
        from: "36.8%",
        choices: [
          { wording: "38.6%", evidence: first },
          { wording: "39.4%", evidence: second },
        ],
      },
    });

    expect(check?.correction).toEqual({
      from: "36.8%",
      choices: [
        { wording: "38.6%", evidence: first },
        { wording: "39.4%", evidence: second },
      ],
    });
    expect(check && restsOn(check)).toEqual(expect.arrayContaining([first, second]));
    expect(CONTENT_SCHEMA_VERSION).toBe(42);
  });

  test("an older mark without one, and a malformed one, read safely", () => {
    const legacy = readClaimCheck({ id: "legacy", state: "contradicted" });
    expect(legacy?.state).toBe("contradicted");
    expect(legacy?.correction).toBeUndefined();
    expect(
      readClaimCheck({
        id: "invalid",
        state: "contradicted",
        correction: {
          from: "36.8%",
          choices: [{ wording: "36.8%", evidence: evidence("same") }],
        },
      })?.correction,
    ).toBeUndefined();
    expect(
      readClaimCheck({
        id: "invalid-evidence",
        state: "contradicted",
        correction: {
          from: "36.8%",
          choices: [
            {
              wording: "38.6%",
              evidence: { ...evidence("not-found"), check: "not-found" },
            },
          ],
        },
      })?.correction,
    ).toBeUndefined();
  });
});

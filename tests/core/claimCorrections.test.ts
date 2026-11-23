import { APICallError } from "ai";
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
import { checkGenerate, checkingModel, type Plan } from "../helpers/checks";
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
const contradicted = (from = "36.8%", to = "38.6%"): Plan => ({
  verdict: "contradicted",
  quote: QUOTE,
  says: "The report gives another rate.",
  change: { from, to },
});

async function checkWith(plan: Plan, claim = CLAIM): Promise<ClaimCheckResult> {
  const { core } = await setUpWithDocuments(checkingModel({ [claim]: plan }), [REPORT]);
  return core.checkClaim({ claim });
}

async function markWith(plan: Plan) {
  const { core, client, mind } = await setUpWithDocuments(checkingModel({ [CLAIM]: plan }), [
    REPORT,
  ]);
  const block = {
    type: "paragraph",
    attrs: { id: "correction-block" },
    content: [{ type: "text", text: CLAIM }],
  };
  writeMind(client, [block]);
  await client.settled();
  await core.checkSentences({
    requestId: "correction-request",
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "correction-block", offset: 0 },
    to: { blockId: "correction-block", offset: CLAIM.length },
  });
  const { state } = await core.openMind(mind.id);
  const reopened = new Y.Doc();
  Y.applyUpdate(reopened, state);
  const [marked] = markedSentences(reopened.getXmlFragment(MIND_CONTENT_FIELD));
  if (!marked) throw new Error("The checked sentence has no mark.");
  return marked.check;
}

describe("A correction in a check reply", () => {
  test("reads old words that hold “to 1:” as words, not a field", () => {
    const read = readVerdict(
      "Verdict: contradicted\nThe report gives 3 to 1.\nChange 1: rose to 1: 2\nTo 1: rose to 3: 1",
    );

    expect(read?.correction).toEqual({
      from: "rose to 1: 2",
      wording: "rose to 3: 1",
      marker: null,
    });
  });

  test.each([
    ["a To line is missing", "Change 1: 36.8%"],
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
  test("keeps a contradiction's exact replacement", async () => {
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
  });

  test.each([
    ["is absent from the claim", contradicted("37.2%")],
    ["equals the old substring", contradicted("36.8%", "36.8%")],
  ])("has none when the old substring %s", async (_case, plan) => {
    const result = await checkWith(plan);

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toBeUndefined();
  });

  // A supported sentence is one its quote states: one with another figure is never Supported (#3022).
  test.each([
    ["supported", QUOTE],
    ["unsupported", CLAIM],
  ] as const)("has none for %s", async (verdict, claim) => {
    const result = await checkWith({ ...contradicted(), verdict }, claim);

    expect(result.verdict).toBe(verdict);
    expect(correctionIn(result)).toBeUndefined();
  });
});

interface ReplyCase {
  claim: string;
  reply: string;
  citations: readonly { marker: 1; quote: string }[];
  files: readonly SourceFile[];
}

/** A Run that searches with the sentence, cites `citations` and gives `reply`. */
function replyModel(input: ReplyCase) {
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

async function checkWithReply(input: ReplyCase): Promise<ClaimCheckResult> {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(replyModel(input)).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await addAndProcess(
    core,
    await Promise.all(
      input.files.map((file) => writeSourceFile(sources, file.name, file.contents)),
    ),
  );
  return core.checkClaim({ claim: input.claim });
}

test.each([
  {
    claim: "The cash adjustment was 4,620.00.",
    from: "4,620.00",
    to: "4,260.00",
    quote: "The cash adjustment was 4,260.00.",
  },
  {
    claim: "Payment is due within 30 days.",
    from: "30 days",
    to: "45 days",
    quote: "Payment is due within 45 days.",
  },
  {
    claim: "The flat sold for £385,000.",
    from: "£385,000",
    to: "£390,000",
    quote: "The flat sold for £390,000.",
  },
  { claim: "The rate is 5%.", from: "5%", to: "7%", quote: "The rate is 7%." },
  { claim: "付款期限为三十日。", from: "三十日", to: "四十五日", quote: "付款期限为四十五日。" },
  {
    claim: "The base rent is $15,000 per month.",
    from: "$15,000",
    to: "$14,250",
    quote: "The base rent is $14,250 per month.",
  },
  {
    claim: "The Supplier delivers 1,500 units each quarter.",
    from: "1,500 units",
    to: "1,200 units",
    quote: "The Supplier delivers 1,200 units each quarter.",
  },
  { claim: "The rate is 36.8%.", from: "36.8%", to: "38.6%", quote: "The rate is 38.6%." },
  {
    claim: "停车费为人民币1,000元。",
    from: "人民币1,000元",
    to: "人民币800元",
    quote: "停车费为人民币800元。",
  },
  { claim: "The term is 3 years.", from: "3 years", to: "5 years", quote: "The term is 5 years." },
  { claim: "租金为12.5万元。", from: "12.5万元", to: "13万元", quote: "租金为13万元。" },
  {
    claim: "Revenue was $1.5m in 2025.",
    from: "$1.5m",
    to: "$1.2m",
    quote: "Revenue was $1.2m in 2025.",
  },
])("an ordinary correction of $from to $to is still offered (#1481)", async (each) => {
  const result = await checkWithReply({
    claim: each.claim,
    reply: [
      "Verdict: contradicted",
      "Explanation: The Document gives another value. [^1]",
      "Evidence: [1]",
      `Change 1: ${each.from}`,
      `To 1: ${each.to} [^1]`,
    ].join("\n"),
    citations: [{ marker: 1, quote: each.quote }],
    files: [{ name: "Terms.md", contents: `${each.quote}\n${each.claim}` }],
  });

  expect(result.verdict).toBe("contradicted");
  expect(correctionIn(result)?.choices[0]?.wording).toBe(each.to);
});

describe("Malformed table-row and whole-sentence corrections (#3339)", () => {
  test("drops a raw pipe-delimited table row offered against a prose sentence", async () => {
    const claim = "The review rates the central estuary's risk as High.";
    const quote = "Central | 4 | 3.2 | Medium";
    const result = await checkWithReply({
      claim,
      reply: [
        "Verdict: contradicted",
        "Explanation: The review rates the central estuary's risk as Medium, not High. [^1]",
        "Evidence: [1]",
        "Change 1: High",
        `To 1: ${quote} [^1]`,
      ].join("\n"),
      citations: [{ marker: 1, quote }],
      files: [
        {
          name: "Review.md",
          contents: `| Site | Sites | Depth | Risk |\n| --- | --- | --- | --- |\n| ${quote} |`,
        },
      ],
    });

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toBeUndefined();
  });

  test("keeps a cell-value fix for a table-row contradiction", async () => {
    const claim = "The review rates the central estuary's risk as High.";
    const quote = "Central | 4 | 3.2 | Medium";
    const result = await checkWithReply({
      claim,
      reply: [
        "Verdict: contradicted",
        "Explanation: The review rates the central estuary's risk as Medium, not High. [^1]",
        "Evidence: [1]",
        "Change 1: High",
        "To 1: Medium [^1]",
      ].join("\n"),
      citations: [{ marker: 1, quote }],
      files: [
        {
          name: "Review.md",
          contents: `| Site | Sites | Depth | Risk |\n| --- | --- | --- | --- |\n| ${quote} |`,
        },
      ],
    });

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toMatchObject({
      from: "High",
      choices: [{ wording: "Medium" }],
    });
  });

  test.each(["海港云按年付费所有套餐另享 20% 优惠。", "海港云按年付费所有套餐另享 20% 优惠"])(
    "drops a whole-sentence replacement that would drop the subject (%s)",
    async (from) => {
      const claim = "海港云按年付费所有套餐另享 20% 优惠。";
      const quote = "按年付费所有套餐另享 15% 优惠";
      const result = await checkWithReply({
        claim,
        reply: [
          "Verdict: contradicted",
          "Explanation: 价格表写明按年付费另享 15% 优惠，而非 20%。 [^1]",
          "Evidence: [1]",
          `Change 1: ${from}`,
          `To 1: ${quote} [^1]`,
        ].join("\n"),
        citations: [{ marker: 1, quote }],
        files: [{ name: "价格表.md", contents: `海港云价格说明：${quote}。` }],
      });

      expect(result.verdict).toBe("contradicted");
      expect(correctionIn(result)).toBeUndefined();
    },
  );

  test("keeps a value-only replacement for a Chinese sentence and allows replacing a bare cell value", async () => {
    const claim = "海港云按年付费所有套餐另享 20% 优惠。";
    const quote = "按年付费所有套餐另享 15% 优惠";
    const zh = await checkWithReply({
      claim,
      reply: [
        "Verdict: contradicted",
        "Explanation: 价格表写明按年付费另享 15% 优惠，而非 20%。 [^1]",
        "Evidence: [1]",
        "Change 1: 20%",
        "To 1: 15% [^1]",
      ].join("\n"),
      citations: [{ marker: 1, quote }],
      files: [{ name: "价格表.md", contents: `海港云价格说明：${quote}。` }],
    });

    expect(zh.verdict).toBe("contradicted");
    expect(correctionIn(zh)).toMatchObject({ from: "20%", choices: [{ wording: "15%" }] });

    const bare = await checkWithReply({
      claim: "High",
      reply: [
        "Verdict: contradicted",
        "Explanation: The table gives Medium, not High. [^1]",
        "Evidence: [1]",
        "Change 1: High",
        "To 1: Medium [^1]",
      ].join("\n"),
      citations: [{ marker: 1, quote: "Central | 4 | 3.2 | Medium" }],
      files: [
        { name: "Review.md", contents: "Central | 4 | 3.2 | Medium\nHigh risk was lowered." },
      ],
    });

    expect(bare.verdict).toBe("contradicted");
    expect(correctionIn(bare)).toMatchObject({ from: "High", choices: [{ wording: "Medium" }] });
  });
});

describe("A provider's 400 refusal during a check (#3339)", () => {
  const badRequest = (message: string, responseBody?: string) =>
    new APICallError({
      message,
      url: "https://api.deepseek.com/chat/completions",
      requestBodyValues: {},
      statusCode: 400,
      ...(responseBody !== undefined && { responseBody }),
      isRetryable: false,
    });

  test("tries once more on a passing 400 and lands the contradiction", async () => {
    const claim = "海港云商业版每席位每月 250 元。";
    const quote = "商业版每席位每月 190 元";
    let refusedOnce = false;
    const model = scriptedModel(
      (call) => {
        if (!refusedOnce) {
          refusedOnce = true;
          throw badRequest("Bad Request");
        }
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0) {
          return { calls: [{ tool: "search_documents", input: { query: claim } }] };
        }
        if (!call.results.some((result) => result.tool === "cite")) {
          const passage = shownPassages(searches.at(-1)?.text ?? "").find((each) =>
            each.text.includes(quote),
          );
          if (!passage) throw new Error("No Passage holds the price quote.");
          return {
            calls: [
              { tool: "cite", input: { citations: [{ marker: 1, passage: passage.id, quote }] } },
            ],
          };
        }
        return {
          text: [
            "Verdict: contradicted",
            "Explanation: 价格表写明商业版每席位每月 190 元，不是 250 元。 [^1]",
            "Evidence: [1]",
            "Change 1: 250 元",
            "To 1: 190 元 [^1]",
          ].join("\n"),
        };
      },
      { generate: checkGenerate({}) },
    );
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await addAndProcess(core, [await writeSourceFile(sources, "价格表.md", `海港云${quote}。`)]);

    const result = await core.checkClaim({ claim });

    expect(result.verdict).toBe("contradicted");
    expect(correctionIn(result)).toMatchObject({
      from: "250 元",
      choices: [{ wording: "190 元" }],
    });
  });

  test("marks Not checked with the provider's detail or clean fallback when a 400 persists", async () => {
    const runRefused = async (error: APICallError) => {
      let calls = 0;
      const model = scriptedModel(
        () => {
          calls++;
          throw error;
        },
        { generate: checkGenerate({}) },
      );
      const dataDir = await createTempDataFolder();
      const sources = await createTempDataFolder();
      const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      await addAndProcess(core, [
        await writeSourceFile(sources, "价格表.md", "海港云商业版每席位每月 190 元。"),
      ]);
      const result = await core.checkClaim({ claim: "海港云商业版每席位每月 250 元。" });
      return { result, calls };
    };

    const withBody = await runRefused(
      badRequest("Bad Request", JSON.stringify({ error: { message: "Content Exists Risk" } })),
    );
    expect(withBody.calls).toBe(2);
    expect(withBody.result).toMatchObject({
      verdict: "not-checked",
      reason: "failed",
      detail: "Content Exists Risk",
    });

    const bare = await runRefused(badRequest("Bad Request"));
    expect(bare.calls).toBe(2);
    expect(bare.result).toMatchObject({
      verdict: "not-checked",
      reason: "failed",
      detail: null,
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
    expect(CONTENT_SCHEMA_VERSION).toBe(63);
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

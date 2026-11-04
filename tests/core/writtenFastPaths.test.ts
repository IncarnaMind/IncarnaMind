import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CheckPathsOverride, ClaimCheckAttributes, Core } from "../../src/core";
import {
  copiedSentence,
  holdsFigure,
  locationText,
  QUICK_CHECK_INSTRUCTIONS,
} from "../../src/core/answers/checks/fastPaths";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { askAssistant } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { recordRows } from "../helpers/csv";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

/**
 * A sentence the assistant writes with one Citation is Supported without the check's Run when it
 * is, word for word, the Document's own sentence its Citation quotes, or when the quick-tasks
 * model of the same provider answers a plain yes; anything else, and any sentence another
 * Document or period could contradict, is checked as before (#1667). The models are scripted.
 */

const LOOKS_AFTER = "The Hirer looks after the equipment during the hire.";
const DELIVERY = "Northgate delivers the equipment free of charge within the city boundary.";
const REFUND =
  "Northgate refunds the deposit only if the equipment comes back clean and undamaged.";
const CHARGE = "The hire charge is 120 pounds per week.";
const TERMS = `# Terms of hire\n\n${LOOKS_AFTER} ${DELIVERY} ${REFUND} ${CHARGE}\n`;
const ZH_DELIVERY = "北岭在市区范围内免费送货。";
const ZH_LEND = "承租人不得将设备转借他人。";
const ZH_TERMS = `# 租赁条款\n\n承租人在租期内负责设备的日常保养。${ZH_DELIVERY}${ZH_LEND}\n`;
const AMENDMENT =
  "# Amendment\n\nNorthgate delivers the equipment free of charge anywhere in the county.\n";
const CANTEEN = "# Canteen\n\nThe canteen opens at noon on weekdays.\n";

interface Writing {
  content: string;
  /** What the Citation quotes, and the search that finds it. */
  quote: string;
  /** What the Citations after the first quote, as markers 2, 3, …. */
  more?: readonly string[];
  query?: string;
  documents?: readonly { name: string; contents: string }[];
  /** The Answers model: a cloud model of Anthropic, or one in Ollama on this computer. */
  cloud?: string;
  /** What the quick model replies to its first look; it is never asked when absent. */
  quick?: string;
  checkPaths?: CheckPathsOverride;
  /** Before the write: the core, the saved provider's id. */
  before?: (core: Core, providerId: string) => Promise<void>;
}

const supported = (quote: string): Plan => ({ verdict: "supported", quote, says: quote });

async function write(writing: Writing) {
  const calls: ModelCall[] = [];
  const quickCalls: string[] = [];
  const plans: Record<string, Plan> = new Proxy(
    {},
    { get: () => supported(writing.quote), has: () => true },
  );
  const generate = checkGenerate(plans);
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      if (isCheckRun(call)) return checkReply(call, plans);
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search)
        return {
          calls: [{ tool: "search_documents", input: { query: writing.query ?? writing.quote } }],
        };
      if (!call.results.some((result) => result.tool === "cite")) {
        const quotes = [writing.quote, ...(writing.more ?? [])];
        const citations = quotes.map((quote, index) => ({
          marker: index + 1,
          passage: shownPassages(search.text).find((each) => each.text.includes(quote))?.id,
          quote,
        }));
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      if (!call.results.some((result) => result.tool === "create_mind"))
        return {
          calls: [
            { tool: "create_mind", input: { title: "Hire notes", content: writing.content } },
          ],
        };
      return { text: "Wrote it from your Documents." };
    },
    {
      generate: (call) => {
        if (call.system === QUICK_CHECK_INSTRUCTIONS) {
          quickCalls.push(call.prompt);
          return { text: writing.quick ?? "no" };
        }
        return generate(call);
      },
    },
  );
  const models = scriptedModels(model);
  const core = startCore(await createTempDataFolder(), {
    createChatModel: models.createChatModel,
    ...(writing.checkPaths && { checkPaths: writing.checkPaths }),
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = writing.cloud
    ? await core.saveChatProvider({
        kind: "anthropic",
        modelId: writing.cloud,
        apiKey: "sk-ant-test",
      })
    : await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  if (saved.service) {
    for (const flow of ["chat", "checks"] as const)
      await core.allowDataFlow(flow, saved.service.id);
  }
  await writing.before?.(core, saved.id);
  const sources = await createTempDataFolder();
  const documents = await addAndProcess(
    core,
    await Promise.all(
      (writing.documents ?? [{ name: "Terms.md", contents: TERMS }]).map((each) =>
        writeSourceFile(sources, each.name, each.contents),
      ),
    ),
  );
  const folder = await core.createLibraryGroup({ name: "Hire", description: "" });
  await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
  const answer = await askAssistant(core, {
    text: "Summarise these Documents into a new note",
    scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
  });
  const change = answer.toolCalls.find((each) => each.mindChange)?.mindChange;
  const client = await connectToMind(core, change?.mindId ?? "");
  await client.settled();
  const marks: ClaimCheckAttributes[] = claimSpans(readMind(client)).map((span) => span.check);
  // A Run starts with a call that has read no Tool result yet.
  const checkRuns = calls.filter((call) => isCheckRun(call) && call.results.length === 0).length;
  const sentenceChecks = (await core.listAiUse()).filter(
    (each) => each.kind === "sentence-checked",
  );
  return { core, mindId: change?.mindId ?? "", marks, checkRuns, quickCalls, sentenceChecks };
}

describe("the copy test, with no model", () => {
  // protects=a sentence its one Citation's Document states word for word, as a whole sentence, lands Supported with no check Run and no use of AI recorded, its mark saying no model checked it, in English and Chinese (#1667); fails_when=the copy test is removed or a model is named; no_claim=none beyond protects.
  test.each([
    { language: "en", content: `## Notes\n\n${DELIVERY}[^1]`, quote: DELIVERY, terms: TERMS },
    {
      language: "zh-CN",
      content: `## 笔记\n\n${ZH_DELIVERY}[^1]`,
      quote: ZH_DELIVERY,
      terms: ZH_TERMS,
    },
  ])("its Citation's own sentence is Supported with no model ($language)", async (each) => {
    const { marks, checkRuns, sentenceChecks } = await write({
      content: each.content,
      quote: each.quote,
      documents: [
        { name: "Terms.md", contents: each.terms },
        { name: "Canteen.md", contents: CANTEEN },
      ],
    });

    expect(checkRuns).toBe(0);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      state: "supported",
      wordForWord: true,
      providerId: null,
      modelId: null,
    });
    expect(marks[0]?.evidence?.quote).toBe(each.quote);
    expect(sentenceChecks).toHaveLength(0);
  });

  // protects=two sentences that follow the Document sentence by sentence are both its copies (#1667); fails_when=a later sentence in a paragraph is never a copy; no_claim=none beyond protects.
  test("sentences in the Document's own order are its copies", async () => {
    const { marks, checkRuns } = await write({
      content: `## Notes\n\n${DELIVERY}[^1] ${REFUND}[^2]`,
      quote: DELIVERY,
      more: [REFUND],
      query: "Northgate",
    });

    expect(checkRuns).toBe(0);
    expect(marks.map((mark) => mark.wordForWord ?? false)).toEqual([true, true]);
  });

  // protects=the guards that send a written sentence to the check's Run: a part of a longer sentence, another Document with its words, a figure, a sentence after one the Document doesn't have before it, and the quick-tasks model set to the Answers model (#1667); fails_when=any guard is removed and the sentence lands Supported with no model; no_claim=none beyond protects.
  test.each([
    {
      name: "a part of a longer sentence",
      content: "## Notes\n\nNorthgate refunds the deposit.[^1]",
      quote: "Northgate refunds the deposit",
    },
    {
      name: "another Document with its words",
      content: `## Notes\n\n${DELIVERY}[^1]`,
      quote: DELIVERY,
      documents: [
        { name: "Terms.md", contents: TERMS },
        { name: "Amendment.md", contents: AMENDMENT },
      ],
    },
    { name: "a figure", content: `## Notes\n\n${CHARGE}[^1]`, quote: CHARGE },
    {
      name: "a sentence before it the Document doesn't have there",
      content: `## Notes\n\nLate returns cost more. ${DELIVERY}[^1]`,
      quote: DELIVERY,
    },
    {
      name: "the quick-tasks model set to the Answers model",
      content: `## Notes\n\n${DELIVERY}[^1]`,
      quote: DELIVERY,
      before: (core: Core, providerId: string) =>
        core
          .updateSettings({ user: { quickTasksModel: { providerId, modelId: "local-model" } } })
          .then(() => undefined),
    },
    {
      name: "the copy test turned off",
      content: `## Notes\n\n${DELIVERY}[^1]`,
      quote: DELIVERY,
      checkPaths: { copies: () => false },
    },
  ])("$name goes to the check", async (each) => {
    const { marks, checkRuns } = await write(each);

    expect(checkRuns).toBe(1);
    expect(marks[0]).toMatchObject({ state: "supported", modelId: "local-model" });
    expect(marks[0]?.wordForWord).toBeUndefined();
  });
});

describe("what says the copy test checked a sentence", () => {
  /** The AI use statement's text and the check record's rows, in the interface language. */
  async function told(core: Core, mindId: string) {
    const made = await core.createAiUseStatement(mindId);
    const client = await connectToMind(core, made.id);
    await client.settled();
    const out = await createTempDataFolder();
    await core.setOutputLocation(out);
    const saved = await core.saveCheckRecord(mindId);
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const csv = readFileSync(join(out, saved.file.name.replace(/\.pdf$/, ".csv")), "utf8");
    return { statement: readMind(client).textContent, csv, rows: recordRows(csv) };
  }

  // protects=the AI use statement's Model cell and the check record's Model column and Models line say no AI model checked a copy, in English and Chinese, and the statement counts no use of AI for it (#1667); fails_when=either names a model, says "Not recorded", or counts the copy as a check by a model; no_claim=none beyond protects.
  test.each([
    {
      language: "en" as const,
      content: `## Notes\n\n${DELIVERY}[^1]`,
      quote: DELIVERY,
      terms: TERMS,
      said: "No AI model: matched its quote word for word",
      model: "Model",
      models: "No AI model: matched its quote word for word, 1 sentence check",
    },
    {
      language: "zh-CN" as const,
      content: `## 笔记\n\n${ZH_DELIVERY}[^1]`,
      quote: ZH_DELIVERY,
      terms: ZH_TERMS,
      said: "未使用 AI 模型：与引文逐字一致",
      model: "模型",
      models: "未使用 AI 模型：与引文逐字一致，1 次句子核对",
    },
  ])("the statement and the record say no AI model ($language)", async (each) => {
    const { core, mindId } = await write({
      ...each,
      documents: [{ name: "Terms.md", contents: each.terms }],
      before: (core) =>
        core.updateSettings({ user: { language: each.language } }).then(() => undefined),
    });
    const { statement, csv, rows } = await told(core, mindId);

    expect(statement).toContain(each.said);
    expect(statement).not.toContain("local-model");
    expect(rows.map((row) => row[each.model])).toEqual([each.said]);
    expect(csv).toContain(each.models);
  });
});

describe("the quick model's first look", () => {
  const PARAPHRASE = "Within the city boundary, Northgate brings the equipment over for free.";
  const LISTED: CheckPathsOverride = { quickFirstLook: () => true };

  // protects=under a listed Answers model, the same provider's quick-tasks model looks first, and a plain yes lands Supported with no check Run, its mark and the record of AI use naming the quick model (#1667); fails_when=the quick model isn't asked, or its yes still runs the check, or the Answers model is named; no_claim=none beyond protects.
  test("a plain yes is Supported, named for the quick model", async () => {
    const { marks, checkRuns, quickCalls, sentenceChecks } = await write({
      content: `## Notes\n\n${PARAPHRASE}[^1]`,
      quote: DELIVERY,
      cloud: "claude-sonnet-5-5",
      quick: "Yes.",
      checkPaths: LISTED,
    });

    expect(quickCalls).toHaveLength(1);
    expect(quickCalls[0]).toContain(`<sentence>${PARAPHRASE}</sentence>`);
    expect(quickCalls[0]).toContain(`<quote>${DELIVERY}</quote>`);
    expect(checkRuns).toBe(0);
    expect(marks[0]).toMatchObject({ state: "supported", modelId: "claude-haiku-5-5" });
    expect(marks[0]?.wordForWord).toBeUndefined();
    expect(sentenceChecks.map((each) => each.modelId)).toEqual(["claude-haiku-5-5"]);
  });

  // protects=anything but a plain yes goes to the check's Run on the User's model, whose mark names it (#1667); fails_when=a hedged yes or a no is taken as Supported; no_claim=none beyond protects.
  test.each(["no", "Yes, within the city boundary.", ""])(
    "%j goes to the check on the Answers model",
    async (quick) => {
      const { marks, checkRuns, quickCalls } = await write({
        content: `## Notes\n\n${PARAPHRASE}[^1]`,
        quote: DELIVERY,
        cloud: "claude-sonnet-5-5",
        quick,
        checkPaths: LISTED,
      });

      expect(quickCalls).toHaveLength(1);
      expect(checkRuns).toBe(1);
      expect(marks[0]).toMatchObject({ state: "supported", modelId: "claude-sonnet-5-5" });
    },
  );

  // protects=the quick model looks first only where the Answers model is listed beside the catalog, and never when it is the Answers model itself (#1667); fails_when=an unlisted Answers model, or Claude Haiku 5.5 answering, still asks a quick model; no_claim=none beyond protects.
  test.each([
    { name: "an Answers model not listed", cloud: "claude-sonnet-5-5", checkPaths: undefined },
    { name: "the Answers model is the quick one", cloud: "claude-haiku-5-5", checkPaths: LISTED },
  ])("$name: no first look", async ({ cloud, checkPaths }) => {
    const { quickCalls, checkRuns } = await write({
      content: `## Notes\n\n${PARAPHRASE}[^1]`,
      quote: DELIVERY,
      cloud,
      quick: "yes",
      ...(checkPaths && { checkPaths }),
    });

    expect(quickCalls).toHaveLength(0);
    expect(checkRuns).toBe(1);
  });
});

describe("the copy test's text", () => {
  const location = (text: string, startsDocument = true) => ({
    text,
    from: 0,
    to: text.length,
    startsDocument,
  });
  const TEXT = `Terms of hire\n${LOOKS_AFTER} ${DELIVERY}\nThis does not apply to tracked excavators. ${REFUND}`;

  // protects=only spaces, quotation marks, dashes and character forms may differ, and the sentence must be whole, hold the quote and follow the Document's sentences before it (#1667); fails_when=a part of a sentence, another word, or a sentence after another the Document doesn't have counts as a copy; no_claim=none beyond protects.
  test.each([
    { sentences: [DELIVERY], quote: DELIVERY, copied: DELIVERY },
    {
      sentences: ["Northgate  delivers the equipment free of charge within the city boundary ."],
      quote: "delivers the equipment",
      copied: DELIVERY,
    },
    {
      sentences: ["Northgate refunds the deposit."],
      quote: "Northgate refunds the deposit",
      copied: null,
    },
    { sentences: [DELIVERY], quote: "the deposit", copied: null },
    {
      sentences: ["This does not apply to tracked excavators."],
      quote: "tracked excavators",
      copied: "This does not apply to tracked excavators.",
    },
    {
      sentences: ["Late returns cost more.", "This does not apply to tracked excavators."],
      quote: "tracked excavators",
      copied: null,
    },
    {
      sentences: [DELIVERY, "This does not apply to tracked excavators."],
      quote: "tracked excavators",
      copied: "This does not apply to tracked excavators.",
    },
    {
      sentences: ["Northgate delivers the equipment free of charge within the county boundary."],
      quote: "delivers the equipment",
      copied: null,
    },
  ])("$sentences → $copied", ({ sentences, quote, copied }) => {
    expect(copiedSentence(sentences, quote, location(TEXT))).toBe(copied);
  });

  // protects=quotation marks and full-width forms are read alike (#1667); fails_when=a curly apostrophe or half-width parentheses stop a copy; no_claim=none beyond protects.
  test.each([
    ["The Hirer’s site is open.", "The Hirer's site is open."],
    ["押金以人民币(现金或转账)支付。", "押金以人民币（现金或转账）支付。"],
  ])("%s copies %s", (written, stated) => {
    expect(copiedSentence([written], stated.slice(0, 4), location(stated))).toBe(stated);
  });

  // protects=the first sentence of a text that doesn't start the Document may be the end of a longer one, so it is never a copy (#1667); fails_when=a sentence cut at a Unit's edge counts as whole; no_claim=none beyond protects.
  test("a text's first sentence counts only where the Document starts", () => {
    const cut = "by giving one week's written notice.";
    expect(copiedSentence([cut], cut, location(`${cut} The rest follows.`, false))).toBeNull();
    expect(copiedSentence([cut], cut, location(`${cut} The rest follows.`, true))).toBe(cut);
  });

  // protects=the Location's Units are read with one on each side, and a sheet's rows are never sentences (#1667); fails_when=a sentence across a page break is cut, or a row is read as one; no_claim=none beyond protects.
  test("a Location is read with its neighbouring Units", () => {
    const units = [
      { page: 1, text: "First page ends with the start of" },
      { page: 2, text: "a sentence that ends here." },
      { page: 3, text: "Third page." },
    ];
    const read = locationText({ pageFrom: 2, pageTo: 2 }, (from, to) =>
      units.filter((unit) => unit.page >= from && unit.page <= to),
    );
    expect(read).toEqual({
      text: "First page ends with the start of a sentence that ends here. Third page.",
      from: 34,
      to: 60,
      startsDocument: true,
    });
    expect(read && copiedSentence(["a sentence that ends here."], "ends here", read)).toBeNull();
    expect(
      locationText({ pageFrom: 1, pageTo: 1 }, () => [{ page: 1, text: "a | b", kind: "rows" }]),
    ).toBeNull();
  });

  // protects=a sentence with any number, in digits, Chinese numerals or English words, or a month, never takes a fast path (#1667); fails_when=a number or month written out passes as no figure; no_claim=none beyond protects.
  test.each([
    ["Up to five unused days may be carried over.", true],
    ["员工每年有十五天带薪年休假。", true],
    ["The fee is twice the deposit.", true],
    ["The policy starts in March.", true],
    ["The rent is 950 a month.", true],
    ["The Hirer may lend the equipment.", false],
    ["承租人不得将设备转借他人。", false],
  ])("%s holds a figure: %s", (text, held) => {
    expect(holdsFigure(text)).toBe(held);
  });
});

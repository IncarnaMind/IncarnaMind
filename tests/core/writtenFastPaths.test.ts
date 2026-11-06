import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CheckPathsOverride, ClaimCheckAttributes, Core } from "../../src/core";
import type { NodeJSON } from "../../src/core/answers/blocks";
import {
  createFastPaths,
  type FastPathDependencies,
  type FirstLook,
  holdsFigure,
  QUICK_CHECK_INSTRUCTIONS,
} from "../../src/core/answers/checks/fastPaths";
import type { CitationSource } from "../../src/core/documents";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkedWith } from "../../src/shared/claimChecks";
import { askAssistant } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { recordRows } from "../helpers/csv";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

/**
 * Before a sentence the assistant writes with one Citation goes to its check's Run, the quick-tasks
 * model of the same provider looks first, under an Answers model listed beside the catalog: only
 * its plain yes makes the sentence Supported, named for it; anything else, and any sentence
 * another Document or period could contradict, is checked as before (#1667). The models are
 * scripted.
 */

const DELIVERY = "Quillowgarth delivers the equipment free of charge within the city boundary.";
const REFUND =
  "Quillowgarth refunds the deposit only if the equipment comes back clean and undamaged.";
const CHARGE = "The hire charge is 120 pounds per week.";
const TERMS = `# Terms of hire\n\nThe Hirer looks after the equipment. ${DELIVERY} ${REFUND} ${CHARGE}\n`;
const PARAPHRASE = "Within the city boundary, Quillowgarth brings the equipment over for free.";
const ZH_DELIVERY = "北岭在市区范围内免费送货。";
const ZH_TERMS = `# 租赁条款\n\n承租人负责设备的保养。${ZH_DELIVERY}\n`;
const ZH_PARAPHRASE = "在市区范围内，北岭送货不收费。";
const AMENDMENT =
  "# Amendment\n\nWithin the city boundary, Quillowgarth now brings the equipment over for a fee.\n";
const CANTEEN = "# Canteen\n\nThe canteen opens at noon in the city.\n";
const LISTED: CheckPathsOverride = { quickFirstLook: () => true };

interface Writing {
  content: string;
  /** What the Citation quotes, and the search that finds it. */
  quote: string;
  documents?: readonly { name: string; contents: string }[];
  /** The Answers model, of Anthropic. */
  answers?: string;
  /** What the quick model replies to its first look; absent: it never replies. */
  quick?: string;
  checkPaths?: CheckPathsOverride;
  /** The check's first request is refused for too many requests, once. */
  rateLimitedOnce?: boolean;
  /** Every request of the check fails. */
  checkFails?: boolean;
  /** Written into a Note holding these Blocks, after them, rather than into a new one. */
  into?: readonly NodeJSON[];
  /** How long a sentence's check may take; its first look has a tenth of it. */
  timeLimitMs?: number;
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
  let limited = false;
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      if (isCheckRun(call) && writing.rateLimitedOnce && !limited) {
        limited = true;
        return { error: { status: 429, message: "Too many requests." } };
      }
      if (isCheckRun(call) && writing.checkFails)
        return { error: { status: 400, message: "The request was refused." } };
      if (isCheckRun(call)) return checkReply(call, plans);
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search)
        return { calls: [{ tool: "search_documents", input: { query: writing.quote } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(search.text).find((each) =>
          each.text.includes(writing.quote),
        );
        const citations = [{ marker: 1, passage: passage?.id, quote: writing.quote }];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      const tool = writing.into ? "add_to_mind" : "create_mind";
      if (!call.results.some((result) => result.tool === tool))
        return {
          calls: [
            {
              tool,
              input: writing.into
                ? { content: writing.content }
                : { title: "Hire notes", content: writing.content },
            },
          ],
        };
      return { text: "Wrote it from your Documents." };
    },
    {
      generate: (call) => {
        if (call.system !== QUICK_CHECK_INSTRUCTIONS) return generate(call);
        quickCalls.push(call.prompt);
        // A reply that never comes.
        if (writing.quick === undefined) return { text: "", until: new Promise(() => undefined) };
        return { text: writing.quick };
      },
    },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    ...(writing.checkPaths && { checkPaths: writing.checkPaths }),
    ...(writing.timeLimitMs && { contradictionWatch: { claimTimeLimitMs: writing.timeLimitMs } }),
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    modelId: writing.answers ?? "claude-sonnet-5-5",
    apiKey: "sk-ant-test",
  });
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
  const into = writing.into
    ? await core.createMind({ title: "Hire notes", folderId: folder.id })
    : null;
  if (into && writing.into) {
    const page = await connectToMind(core, into.id);
    writeMind(page, [...writing.into]);
    await page.settled();
  }
  const answer = await askAssistant(core, {
    text: into
      ? "Add a short note on delivery to this Mind"
      : "Summarise these Documents into a new note",
    ...(into && { mindId: into.id }),
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

describe("the quick model's first look", () => {
  // protects=under a listed Answers model, the same provider's quick-tasks model looks first, shown the sentence, the heading above it, the quote and its Passage, and a plain yes lands Supported with no check Run, its mark and the record of AI use naming the quick model, in English and Chinese (#1667); fails_when=the quick model isn't asked, its yes still runs the check, or the Answers model is named; no_claim=none beyond protects.
  test.each([
    { language: "en", heading: "Notes", sentence: PARAPHRASE, quote: DELIVERY, terms: TERMS },
    {
      language: "zh-CN",
      heading: "笔记",
      sentence: ZH_PARAPHRASE,
      quote: ZH_DELIVERY,
      terms: ZH_TERMS,
    },
  ])("a plain yes is Supported, named for the quick model ($language)", async (each) => {
    const { marks, checkRuns, quickCalls, sentenceChecks } = await write({
      content: `## ${each.heading}\n\n${each.sentence}[^1]`,
      quote: each.quote,
      documents: [{ name: "Terms.md", contents: each.terms }],
      quick: "Yes.",
      checkPaths: LISTED,
    });

    expect(quickCalls).toHaveLength(1);
    expect(quickCalls[0]).toContain(`<heading>${each.heading}</heading>`);
    expect(quickCalls[0]).toContain(`<sentence>${each.sentence}</sentence>`);
    expect(quickCalls[0]).toContain(`<quote>${each.quote}</quote>`);
    expect(checkRuns).toBe(0);
    expect(marks[0]).toMatchObject({ state: "supported", modelId: "claude-haiku-5-5" });
    expect(marks[0]?.evidence?.quote).toBe(each.quote);
    expect(sentenceChecks.map((use) => use.modelId)).toEqual(["claude-haiku-5-5"]);
  });

  // protects=anything but a plain yes goes to the check's Run on the User's model, whose mark names it, and a quick model that read the sentence is still recorded as a use of AI (#1667); fails_when=a hedged yes or a no is taken as Supported, or the quick model's look goes unrecorded; no_claim=none beyond protects.
  test.each(["no", "Yes, within the city boundary.", ""])(
    "%j goes to the check on the Answers model",
    async (quick) => {
      const { marks, checkRuns, quickCalls, sentenceChecks } = await write({
        content: `## Notes\n\n${PARAPHRASE}[^1]`,
        quote: DELIVERY,
        quick,
        checkPaths: LISTED,
      });

      expect(quickCalls).toHaveLength(1);
      expect(checkRuns).toBe(1);
      expect(marks[0]).toMatchObject({ state: "supported", modelId: "claude-sonnet-5-5" });
      // The card names only the model that decided, never the quick model that passed it on.
      expect(marks[0] && checkedWith(marks[0])?.models).toEqual([
        { providerId: expect.any(String), modelId: "claude-sonnet-5-5" },
      ]);
      expect(sentenceChecks.map((use) => use.modelId).sort()).toEqual([
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
      ]);
    },
  );

  // protects=a quick model that said no is recorded as a use of AI only once its sentence is checked, so the AI use statement never names a model for a sentence the Note shows not checked (#1667); fails_when=its look is recorded when the check then fails; no_claim=none beyond protects.
  test("a no is not recorded when the sentence's check then fails", async () => {
    const { marks, quickCalls, sentenceChecks } = await write({
      content: `## Notes\n\n${PARAPHRASE}[^1]`,
      quote: DELIVERY,
      quick: "no",
      checkPaths: LISTED,
      checkFails: true,
    });

    expect(quickCalls).toHaveLength(1);
    expect(marks[0]).toMatchObject({ state: "not-checked" });
    expect(sentenceChecks).toEqual([]);
  });

  // protects=a quick model that never replies is given up on after a tenth of the sentence's time, and the sentence then gets its check with all of its time (#1667); fails_when=the first look has no limit of its own, or a hang leaves the sentence not checked; no_claim=none beyond protects.
  test("a first look that never replies goes to the check", async () => {
    const { marks, checkRuns, quickCalls, sentenceChecks } = await write({
      content: `## Notes\n\n${PARAPHRASE}[^1]`,
      quote: DELIVERY,
      checkPaths: LISTED,
      timeLimitMs: 5_000,
    });

    expect(quickCalls).toHaveLength(1);
    expect(checkRuns).toBe(1);
    expect(marks[0]).toMatchObject({ state: "supported", modelId: "claude-sonnet-5-5" });
    expect(sentenceChecks.map((use) => use.modelId)).toEqual(["claude-sonnet-5-5"]);
  });

  // protects=a sentence asked about again after a rate limit keeps its first look's answer, so a quick model's later yes can't stand, and its look is counted once (#1667); fails_when=the retry asks the quick model again; no_claim=none beyond protects.
  test("a retry after a rate limit doesn't ask the quick model again", async () => {
    const { marks, quickCalls, sentenceChecks } = await write({
      content: `## Notes\n\n${PARAPHRASE}[^1]`,
      quote: DELIVERY,
      quick: "no",
      checkPaths: LISTED,
      rateLimitedOnce: true,
    });

    expect(quickCalls).toHaveLength(1);
    expect(marks[0]).toMatchObject({ state: "supported", modelId: "claude-sonnet-5-5" });
    expect(sentenceChecks.map((use) => use.modelId).sort()).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
    ]);
  });

  // protects=no first look where the Answers model isn't listed, is the quick model itself, or the User set the quick-tasks model to it, or set one on another provider, a service with its own consent, allowed or not (#1667); fails_when=any of them asks a quick model; no_claim=none beyond protects.
  test.each<{ name: string } & Partial<Writing>>([
    { name: "an Answers model not listed" },
    { name: "the Answers model is the quick one", answers: "claude-haiku-5-5", checkPaths: LISTED },
    {
      name: "the Answers model is the quick one, dated",
      answers: "claude-haiku-5-5-20261015",
      checkPaths: LISTED,
    },
    {
      name: "no quick model to prepare",
      checkPaths: {
        quickFirstLook: () => {
          throw new Error("The list can't be read.");
        },
      },
    },
    {
      name: "the quick-tasks model set to the Answers model",
      checkPaths: LISTED,
      before: (core, providerId) =>
        core
          .updateSettings({
            user: { quickTasksModel: { providerId, modelId: "claude-sonnet-5-5" } },
          })
          .then(() => undefined),
    },
    {
      name: "a quick model of another provider",
      checkPaths: LISTED,
      before: async (core, providerId) => {
        const other = await core.saveChatProvider({
          kind: "openai",
          modelId: "gpt-6-luna",
          apiKey: "sk-proj-a-made-up-key",
        });
        if (other.service) {
          for (const flow of ["chat", "checks"] as const)
            await core.allowDataFlow(flow, other.service.id);
        }
        await core.updateSettings({
          user: {
            chatModel: { providerId, modelId: "claude-sonnet-5-5" },
            quickTasksModel: { providerId: other.id, modelId: "gpt-6-luna" },
          },
        });
      },
    },
  ])("$name: no first look", async ({ name: _, ...each }) => {
    const { quickCalls, checkRuns } = await write({
      content: `## Notes\n\n${PARAPHRASE}[^1]`,
      quote: DELIVERY,
      quick: "yes",
      ...each,
    });

    expect(quickCalls).toHaveLength(0);
    expect(checkRuns).toBe(1);
  });

  // protects=the first look only at a sentence that opens its paragraph, after a heading or at the start of the Note the write makes, never after another sentence or paragraph, which it may lean on (#1667); fails_when=a sentence after another, or a paragraph after another, is looked at first, or a Note's first paragraph isn't; no_claim=none beyond protects.
  test.each([
    { name: "a Note's first paragraph", content: `${PARAPHRASE}[^1]`, asked: 1 },
    {
      name: "a sentence after another",
      content: `## Notes\n\nThe Hirer looks after the equipment. ${PARAPHRASE}[^1]`,
      asked: 0,
    },
    {
      name: "a paragraph after another",
      content: `## Notes\n\nThe Hirer looks after the equipment.\n\n${PARAPHRASE}[^1]`,
      asked: 0,
    },
    {
      name: "a paragraph after a rule under a heading",
      content: `## Notes\n\n---\n\n${PARAPHRASE}[^1]`,
      asked: 0,
    },
    {
      name: "a paragraph after a code block under a heading",
      content: `## Notes\n\n\`\`\`\nreturn --all\n\`\`\`\n\n${PARAPHRASE}[^1]`,
      asked: 0,
    },
    {
      name: "a paragraph after a table of headers only under a heading",
      content: `## Notes\n\n| Delivery | Collection |\n| --- | --- |\n\n${PARAPHRASE}[^1]`,
      asked: 0,
    },
    {
      name: "a paragraph written after a Note's own paragraph",
      content: `${PARAPHRASE}[^1]`,
      into: [{ type: "paragraph", content: [{ type: "text", text: "The Hirer looks after it." }] }],
      asked: 0,
    },
    {
      name: "a paragraph written after a Note's own heading",
      content: `${PARAPHRASE}[^1]`,
      into: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Delivery" }] },
      ],
      asked: 1,
    },
  ])("$name: asked $asked times", async ({ content, into, asked }) => {
    const { quickCalls } = await write({
      content,
      quote: DELIVERY,
      quick: "no",
      checkPaths: LISTED,
      ...(into && { into }),
    });

    expect(quickCalls).toHaveLength(asked);
  });

  // protects=the guards a write's Library decides: a figure the check reads, and another Document with half the sentence's words, and only those, not a Document sharing a word or an identical copy of the file (#1667); fails_when=a guard is removed and the quick model is asked, or a harmless Document stops it; no_claim=none beyond protects.
  test.each([
    { name: "a figure", sentence: "The weekly charge is 120 pounds.", quote: CHARGE, asked: 0 },
    {
      name: "another Document with half its words",
      sentence: PARAPHRASE,
      quote: DELIVERY,
      other: AMENDMENT,
      asked: 0,
    },
    {
      name: "a Document that shares a word",
      sentence: PARAPHRASE,
      quote: DELIVERY,
      other: CANTEEN,
      asked: 1,
    },
    {
      name: "the same file at another path",
      sentence: PARAPHRASE,
      quote: DELIVERY,
      other: TERMS,
      asked: 1,
    },
  ])("$name: asked $asked times", async ({ sentence, quote, other, asked }) => {
    const { quickCalls } = await write({
      content: `## Notes\n\n${sentence}[^1]`,
      quote,
      quick: "no",
      checkPaths: LISTED,
      documents: [
        { name: "Terms.md", contents: TERMS },
        ...(other ? [{ name: "Other.md", contents: other }] : []),
      ],
    });

    expect(quickCalls).toHaveLength(asked);
  });
});

describe("what says the quick model checked a sentence", () => {
  // protects=the AI use statement and the check record name the quick model for a sentence its yes decided, in English and Chinese (#1667); fails_when=either names the Answers model, or none; no_claim=none beyond protects.
  test.each([
    { language: "en" as const, column: "Model", heading: "Notes" },
    { language: "zh-CN" as const, column: "模型", heading: "笔记" },
  ])("the statement and the record name the quick model ($language)", async (each) => {
    const { core, mindId } = await write({
      content: `## ${each.heading}\n\n${PARAPHRASE}[^1]`,
      quote: DELIVERY,
      quick: "yes",
      checkPaths: LISTED,
      before: (core) =>
        core.updateSettings({ user: { language: each.language } }).then(() => undefined),
    });
    const made = await core.createAiUseStatement(mindId);
    const statement = await connectToMind(core, made.id);
    await statement.settled();
    const out = await createTempDataFolder();
    await core.setOutputLocation(out);
    const saved = await core.saveCheckRecord(mindId);
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const csv = readFileSync(join(out, saved.file.name.replace(/\.pdf$/, ".csv")), "utf8");

    expect(readMind(statement).textContent).toContain("Claude Haiku 5.5 (Anthropic)");
    expect(readMind(statement).textContent).not.toContain("Claude Sonnet 5.5");
    expect(recordRows(csv).map((row) => row[each.column])).toEqual(["Claude Haiku 5.5"]);
  });
});

describe("which sentences and Citations the quick model may look at", () => {
  const RECORD = "Id. states the terms.";
  const TEXT = `${DELIVERY} ${RECORD}`;
  const SOURCE: CitationSource = {
    passageId: "passage",
    text: TEXT,
    pageFrom: 1,
    pageTo: 1,
    documentId: "terms",
    documentName: "Terms",
    documentKind: "markdown",
    contentHash: "v2",
    documentDeleted: false,
    notCited: false,
    yourNoteAt: null,
  };
  const CITATION = {
    passageId: "passage",
    documentId: "terms",
    contentHash: "v2",
    pageFrom: 1,
    pageTo: 1,
    location: null,
    quote: DELIVERY,
    check: "found" as const,
  };
  const deps = (changed: Partial<FastPathDependencies> = {}): FastPathDependencies => ({
    citationSource: () => SOURCE,
    pageTexts: () => [{ page: 1, text: TEXT }],
    othersHoldTerms: () => false,
    walled: () => false,
    versionNow: () => "v2",
    ...changed,
  });
  const look = (changed: Partial<FirstLook> = {}): FirstLook => ({
    claim: PARAPHRASE,
    figures: 0,
    inCell: false,
    place: { opens: true, after: { kind: "heading", text: "Notes" } },
    paragraph: PARAPHRASE,
    citations: [CITATION],
    scope: { documentIds: null, excluded: new Map() },
    ask: async () => "yes",
    signal: new AbortController().signal,
    ...changed,
  });

  // protects=every guard on the sentence and its Citation: one Citation, not in a cell, no figure, time or record cite, a Document still there, cited, not a Note's snapshot, a quote not found elsewhere, read for sure, of the version cited and current, outside any wall, in the check's scope, its quote on its page, and no other Document with its words (#1667); fails_when=any guard is removed and the quick model is asked; no_claim=none beyond protects.
  test.each<[string, Partial<FastPathDependencies>, Partial<FirstLook>]>([
    [
      "after a sentence",
      {},
      { place: { opens: false, after: { kind: "heading", text: "Notes" } } },
    ],
    ["after a paragraph", {}, { place: { opens: true, after: { kind: "paragraph" } } }],
    ["after what it can't see", {}, { place: { opens: true, after: { kind: "unknown" } } }],
    ["two Citations", {}, { citations: [CITATION, CITATION] }],
    ["in a table's cell", {}, { inCell: true }],
    ["a figure the check reads", {}, { figures: 1 }],
    ["a number in words", {}, { claim: "Up to five machines are delivered free." }],
    ["a time", {}, { claim: "Quillowgarth delivers free on the last day." }],
    ["a record cite", {}, { claim: RECORD }],
    ["a deleted Document", { citationSource: () => ({ ...SOURCE, documentDeleted: true }) }, {}],
    ["own workings", { citationSource: () => ({ ...SOURCE, notCited: true }) }, {}],
    ["a Note's snapshot", { citationSource: () => ({ ...SOURCE, yourNoteAt: "2026-10-01" }) }, {}],
    ["a quote not found", {}, { citations: [{ ...CITATION, check: "not-found" as const }] }],
    ["a quote read unsure", {}, { citations: [{ ...CITATION, unsure: ["deliver"] }] }],
    ["another version cited", {}, { citations: [{ ...CITATION, contentHash: "v1" }] }],
    ["a newer version now", { versionNow: () => "v3" }, {}],
    ["behind a wall", { walled: () => true }, {}],
    [
      "left out of the check",
      {},
      { scope: { documentIds: null, excluded: new Map([["terms", "own-workings" as const]]) } },
    ],
    ["outside the check's scope", {}, { scope: { documentIds: ["other"], excluded: new Map() } }],
    ["a quote not on its page", {}, { citations: [{ ...CITATION, quote: "free anywhere" }] }],
    [
      "a Location with no Units",
      {},
      { citations: [{ ...CITATION, pageFrom: null, pageTo: null }] },
    ],
    ["another Document with its words", { othersHoldTerms: () => true }, {}],
  ])("%s: no first look", async (_, changed, looked) => {
    const asked: string[] = [];
    const ask = async ({ sentence }: { sentence: string }) => {
      asked.push(sentence);
      return "yes" as const;
    };
    expect((await createFastPaths(deps())(look({ ask }))).result?.verdict).toBe("supported");
    expect(await createFastPaths(deps(changed))(look({ ask, ...looked }))).toEqual({
      result: null,
      asked: false,
    });
    expect(asked).toHaveLength(1);
  });

  // protects=only a plain yes is Supported, and a failure is no use of AI (#1667); fails_when=a no or a failure lands Supported, or a failure counts as read; no_claim=none beyond protects.
  test.each([
    ["no" as const, { result: null, asked: true }],
    ["failed" as const, { result: null, asked: false }],
  ])("%s is no Supported", async (reply, outcome) => {
    expect(await createFastPaths(deps())(look({ ask: async () => reply }))).toEqual(outcome);
  });

  // protects=a sentence with any number or time, in digits, Chinese or English words, or a month, never gets a first look (#1667); fails_when=a number, order or time written out passes as none; no_claim=none beyond protects.
  test.each([
    ["Up to five unused days may be carried over.", true],
    ["员工每年有十五天带薪年休假。", true],
    ["The fee is twice the deposit.", true],
    ["The policy starts in March.", true],
    ["Revenue rose in the third quarter.", true],
    ["Last year the company was profitable.", true],
    ["Payment is due on Monday.", true],
    ["去年公司盈利。", true],
    ["本季度收入上升。", true],
    ["北岭每星期送货。", true],
    ["Quillowgarth delivers once a fortnight.", true],
    ["Rooms are cleaned by noon.", true],
    ["北岭数分钟内送达。", true],
    ["The rent is 950 a month.", true],
    ["The Hirer may lend the equipment.", false],
    ["承租人不得将设备转借他人。", false],
  ])("%s holds a figure or a time: %s", (text, held) => {
    expect(holdsFigure(text)).toBe(held);
  });
});
